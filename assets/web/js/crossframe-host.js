// The parent side of Homey's CrossFrame protocol, so app widgets run in iframes like in the mobile app.

import { isDarkMode } from './dom.js';
import { getWidgetHeight } from './layout.js';
import { subscribe } from './realtime.js';
import { state } from './state.js';

const CROSSFRAME_PREFIX = 'CF2_MESSAGE';

const NO_REPLY = Symbol('no-reply');

// Widget iframes keyed by their window, so CrossFrame messages can be routed to the right host.
export const widgetHosts = new Map();

const hexEncode = (text) => text.replace(/[\s\S]/g, (char) => char.charCodeAt(0).toString(16).padStart(4, '0'));

const hexDecode = (hex) => (hex.match(/.{1,4}/g) ?? []).map((unit) => String.fromCharCode(parseInt(unit, 16))).join('');

// Sandboxed widgets have an opaque origin that can't be named, so the reply targets the frame's window object itself.
function postToWidget(target, message) {
  // The frame is gone when the dashboard was re-rendered (switched, say) while the widget was still talking to us.
  if (target == null) return;
  target.postMessage(CROSSFRAME_PREFIX + hexEncode(JSON.stringify(message)), '*');
}

window.addEventListener('message', (event) => {
  if (typeof event.data !== 'string' || !event.data.startsWith(CROSSFRAME_PREFIX)) return;
  // Only windows of iframes this page created are answered; sandboxed frames report the origin "null".
  const host = widgetHosts.get(event.source);
  if (host == null) return;

  let message;
  try {
    message = JSON.parse(hexDecode(event.data.slice(CROSSFRAME_PREFIX.length)));
  } catch {
    return;
  }
  if (message.type !== 'tx') return;

  const reply = (error, result) => {
    if (message.callbackId == null || result === NO_REPLY) return;
    postToWidget(event.source, {
      type: 'cb',
      callbackId: message.callbackId,
      args: [error ? { type: 'Error', data: error.message ?? String(error) } : null, result ?? null],
    });
  };

  handleWidgetMessage(host, event.source, message).then(
    (result) => reply(null, result),
    (error) => reply(error),
  );
});

async function handleWidgetMessage(host, source, { event, data, callbackId }) {
  switch (event) {
    case 'getInitialData':
      return {
        settings: host.settings,
        deviceIds: host.deviceIds,
        transparent: host.transparent,
        locales: await getAppLocales(host.appId),
        language: state.system.language ?? 'en',
        devmode: false,
        fontScale: 1,
        isDarkMode: isDarkMode(),
      };
    case 'ready':
      if (data?.height != null) host.height = data.height;
      applyWidgetHeight(host.iframe, host.height, host.instanceId);
      host.onReady();
      return null;
    case 'setHeight':
      if (data?.height != null) host.height = data.height;
      applyWidgetHeight(host.iframe, host.height, host.instanceId);
      return null;
    case 'api': {
      const method = String(data?.method ?? 'GET').toUpperCase();
      const path = String(data?.path ?? '/');
      // A widget only reaches its own widget API. The URL is resolved first: dot segments ("..", "%2e%2e") in the
      // path would otherwise lead this page's API key to any other part of Homey's API.
      const base = new URL(`/api/app/${host.appId}/widget/${host.widgetId}/${host.instanceId}`, state.client.base);
      const url = new URL(base.pathname + (path.startsWith('/') ? path : `/${path}`), base);
      if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
        throw new Error('Widgets can only call their own API');
      }
      return state.client.api(method, url.pathname + url.search, data?.body);
    }
    case 'registerRealtimeListener':
      // Every realtime event is delivered as a callback on the id of the registration message.
      host.cleanups.push(
        subscribe(`homey:app:${host.appId}`, data, (payload) => {
          postToWidget(source, { type: 'cb', callbackId, args: [payload] });
        }),
      );
      return NO_REPLY;
    case 'popup': {
      const url = popupUrl(data?.url, host);
      if (url) window.open(url, '_blank', 'noopener');
      return null;
    }
    case 'shortPressHapticFeedback':
    case 'emit':
      return null;
    default:
      throw new Error(`Unsupported widget call: ${event}`);
  }
}

// Homey.popup(url) opens web pages, but none on a Homey address: this page opens it unsandboxed, and there an app's
// own page would run with this page's storage, where the API key is. homeylocal.com isn't a public suffix, so the
// browser treats all its addresses as one site.
function popupUrl(value, host) {
  let url;
  try {
    url = new URL(String(value), host.src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.origin === location.origin || url.origin === state.client.origin) return null;
  if (url.hostname === 'homeylocal.com' || url.hostname.endsWith('.homeylocal.com')) return null;
  return url.href;
}

// A height in pixels, or a percentage of the widget's width (as in the manifest's "height": "100%"). Scale the
// iframe contents while shrinking its layout viewport by the inverse amount, keeping the visible width in its column.
export function applyWidgetHeight(iframe, height, widgetId) {
  const scale = getWidgetHeight(widgetId) / 100;
  const frame = iframe.parentElement;
  iframe.style.width = `${100 / scale}%`;
  iframe.style.transform = scale === 1 ? '' : `scale(${scale})`;
  iframe.style.transformOrigin = 'top left';
  if (typeof height === 'string' && height.trim().endsWith('%')) {
    const percent = parseFloat(height);
    if (percent > 0) {
      iframe.style.height = 'auto';
      iframe.style.aspectRatio = `100 / ${percent * scale}`;
      if (frame) {
        frame.style.height = 'auto';
        frame.style.aspectRatio = `100 / ${percent * scale}`;
      }
    }
    return;
  }
  const pixels = Number(height);
  if (height != null && pixels > 0) {
    iframe.style.aspectRatio = '';
    iframe.style.height = `${pixels}px`;
    if (frame) {
      frame.style.aspectRatio = '';
      frame.style.height = `${pixels * scale}px`;
    }
  }
}

export function refreshWidgetHeight(widgetId) {
  for (const host of widgetHosts.values()) {
    if (host.instanceId === widgetId) applyWidgetHeight(host.iframe, host.height, host.instanceId);
  }
}

async function getAppLocales(appId) {
  if (!state.locales.has(appId)) {
    state.locales.set(
      appId,
      state.client.api('GET', `/api/manager/apps/app/${encodeURIComponent(appId)}/locale`).catch(() => ({})),
    );
  }
  return state.locales.get(appId);
}
