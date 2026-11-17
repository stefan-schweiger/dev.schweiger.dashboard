// Live camera (device_camera_live). Homey Pro converts the camera's stream (RTSP, HLS, …) to WebRTC with go2rtc, or the
// camera's app hands the offer on to a camera that speaks WebRTC itself (Google Nest), so the browser plays it
// directly: it sends a WebRTC offer to the Homey and keeps the stream alive. The stream stops while the page is hidden
// and starts again when it is shown.
// The offer is the Homey app's: audio, video, then a data channel unless the camera's app said it can't take one. Nest
// refuses any other order ("Offer must contain each of audio, video and application m lines in that order"); go2rtc
// ignores the data channel.
// Every widget showing the same camera video shares one stream. A new stream only starts at the camera's next keyframe,
// which can take seconds (the camera ignores the browser's requests for one), so a second widget for a camera that is
// already live (a highlight's copy, when this screen's dashboard has the camera too) plays at once instead of standing
// still on the snapshot.

import { findDevice } from '../devices.js';
import { el, note } from '../dom.js';
import { COLLAPSE_ICON, EXPAND_ICON } from '../icons.js';
import { state } from '../state.js';

const KEEP_ALIVE = 30_000; // Homey drops a stream after two minutes without one.
const RETRY = 10_000;

// video id → shared stream, while any widget shows it.
const streams = new Map();

function iceGathered(pc, timeout) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeout);
  });
}

// Whether the offer gets a data channel: yes, unless the camera's app created the video with dataChannel: false.
async function wantsDataChannel(videoId) {
  const videos = await state.client.api('GET', '/api/manager/videos/video').catch(() => null);
  const video = Object.values(videos ?? {}).find((candidate) => candidate.id === videoId);
  return video?.options?.dataChannel !== false;
}

// The stream of one camera video: { stream, status } for its widgets, where status is '' once frames arrive, else
// what to show instead of "Live". subscribe(fn) calls fn with it on every change and returns an unsubscribe; the stream
// runs while anyone is subscribed.
function liveStream(videoId) {
  if (streams.has(videoId)) return streams.get(videoId);
  const listeners = new Set();
  const shared = { stream: null, status: 'Connecting…' };
  let pc = null;
  let keepAlive = null;
  let retry = null;
  const dataChannel = wantsDataChannel(videoId);
  const api = (path, payload) => state.client.api('POST', `/api/manager/videos/video/${videoId}${path}`, payload);
  const emit = () => listeners.forEach((listener) => listener(shared));
  const showStatus = (text) => {
    shared.status = text;
    emit();
  };

  function stop() {
    clearInterval(keepAlive);
    clearTimeout(retry);
    pc?.close();
    pc = null;
    shared.stream = null;
  }

  function retryLater(message) {
    stop();
    showStatus(message);
    if (listeners.size > 0 && document.visibilityState === 'visible') retry = setTimeout(start, RETRY);
  }

  async function start() {
    stop();
    showStatus('Connecting…');
    const connection = new RTCPeerConnection();
    pc = connection;
    connection.addTransceiver('audio', { direction: 'recvonly' });
    connection.addTransceiver('video', { direction: 'recvonly' });
    connection.addEventListener('track', (event) => {
      if (pc !== connection) return;
      const stream = shared.stream ?? event.streams[0] ?? new MediaStream();
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      shared.stream = stream;
      // A remote track stays muted until its first packets arrive, which is when there is something to show.
      if (event.track.kind === 'video') {
        const live = () => pc === connection && shared.status !== '' && showStatus('');
        event.track.addEventListener('unmute', live);
        if (!event.track.muted) live();
      }
      emit();
    });
    connection.addEventListener('connectionstatechange', () => {
      if (pc !== connection) return;
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') retryLater('Reconnecting…');
    });
    try {
      const withDataChannel = await dataChannel;
      if (pc !== connection) return;
      if (withDataChannel) connection.createDataChannel('data');
      await connection.setLocalDescription(await connection.createOffer());
      await iceGathered(connection, 3000);
      const { answerSdp, streamId } = await api('/offer', { offer: connection.localDescription.sdp });
      if (pc !== connection) return;
      await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (streamId) keepAlive = setInterval(() => api('/keep-alive', { streamId }).catch(() => {}), KEEP_ALIVE);
    } catch (error) {
      if (pc === connection) retryLater(`No live video: ${error.message}`);
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  };

  shared.subscribe = (listener) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      document.addEventListener('visibilitychange', onVisibility);
      start();
    } else {
      listener(shared);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      streams.delete(videoId);
    };
  };
  // After an error, a tap on the status tries again.
  shared.retry = () => {
    if (shared.status !== '') start();
  };
  // A widget saw a frame; covers browsers that don't report the track unmuting.
  shared.playing = () => {
    if (pc != null && shared.status === 'Connecting…') showStatus('');
  };
  streams.set(videoId, shared);
  return shared;
}

export function mountCameraLive({ body, widget }) {
  const device = findDevice(body, widget.data?.deviceId);
  if (device == null) return;
  const video = device.videos?.find((candidate) => candidate.id === widget.data?.deviceVideoId) ?? device.videos?.[0];
  const videoId = video?.videoObj?.id;
  if (videoId == null) return note(body, `${device.name} has no live video.`);

  const frame = el('div', 'snapshot camera-live');
  if (widget.data?.cameraAspect && widget.data.cameraAspect !== 'auto') {
    frame.style.aspectRatio = widget.data.cameraAspect.replace(':', ' / ');
  }
  const player = el('video');
  if (widget.data?.cameraAspect && widget.data.cameraAspect !== 'auto') {
    player.style.aspectRatio = widget.data.cameraAspect.replace(':', ' / ');
  }
  player.muted = true;
  player.playsInline = true;
  player.autoplay = true;
  // A fresh snapshot to show until the stream plays. Not when the stream is already live for another widget: its next
  // frame is a moment away, and the large snapshot would load and draw first on a slow device.
  const snapshot = device.images?.find((image) => image.type === 'camera')?.imageObj?.url;
  if (snapshot && streams.get(videoId)?.status !== '') player.poster = `${state.client.base}${snapshot}?v=${Date.now()}`;
  // Like the app: the name and the stream's title over the picture, a red "Live" once it plays, a full-screen button.
  const overlay = el('div', 'camera-overlay');
  overlay.append(el('div', 'camera-name', `${widget.title ?? device.name} - ${video.title ?? 'Live'}`));
  const status = el('button', 'camera-status');
  status.type = 'button';
  overlay.append(status);
  const fullscreen = el('button', 'camera-fullscreen');
  fullscreen.type = 'button';
  // The same button leaves full screen again: a kiosk has no Esc key.
  const isFullscreen = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === frame;
  const onFullscreenChange = () => {
    fullscreen.innerHTML = isFullscreen() ? COLLAPSE_ICON : EXPAND_ICON;
    fullscreen.setAttribute('aria-label', isFullscreen() ? 'Exit full screen' : 'Full screen');
  };
  onFullscreenChange();
  fullscreen.addEventListener('click', () => {
    if (isFullscreen()) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else document.webkitExitFullscreen?.();
    } else if (frame.requestFullscreen) frame.requestFullscreen().catch(() => {});
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
    else player.webkitEnterFullscreen?.();
  });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  frame.append(player, overlay, fullscreen);
  body.append(frame);

  const showStatus = (text) => {
    status.textContent = text || 'Live';
    status.classList.toggle('is-live', !text);
  };
  let shared = null;
  let unsubscribe = null;
  const update = ({ stream, status: text }) => {
    if (player.srcObject !== stream) {
      player.srcObject = stream;
      if (stream) player.play().catch(() => {});
    }
    showStatus(text);
  };
  player.addEventListener('loadeddata', () => shared?.playing());
  const play = () => {
    if (unsubscribe) return shared.retry();
    shared = liveStream(videoId);
    unsubscribe = shared.subscribe(update);
  };

  status.addEventListener('click', play);
  if (widget.data?.autoplay === false) {
    showStatus('Play live video');
  } else {
    play();
  }
  return () => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    unsubscribe?.();
    player.srcObject = null;
  };
}
