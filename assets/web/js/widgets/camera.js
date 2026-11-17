// Camera snapshot (any device image, like the Power by the Hour price chart).

import { findDevice } from '../devices.js';
import { el, note } from '../dom.js';
import { subscribe } from '../realtime.js';
import { state } from '../state.js';

export function mountCameraSnapshot({ body, widget }) {
  const device = findDevice(body, widget.data?.cameraId);
  if (device == null) return;
  const image = device.images?.find((candidate) => candidate.id === widget.data?.displayId) ?? device.images?.[0];
  if (image?.imageObj?.url == null) return note(body, `${device.name} has no image.`);

  const frame = el('div', 'snapshot');
  const img = el('img');
  img.alt = `${device.name} ${image.title ?? ''}`.trim();
  if (widget.data?.cameraAspect && widget.data.cameraAspect !== 'auto') {
    frame.style.aspectRatio = widget.data.cameraAspect.replace(':', ' / ');
    img.style.height = '100%';
    img.style.objectFit = 'cover';
  }
  frame.append(img);
  body.append(frame);

  // The image id stays the same when an app redraws it, so bust the cache.
  const load = () => {
    img.src = `${state.client.base}${image.imageObj.url}?v=${Date.now()}`;
  };
  load();
  const stop = subscribe('homey:manager:images', 'image.update', (updated) => {
    if (updated?.id === image.imageObj.id) load();
  });
  const timer = setInterval(load, 10 * 60_000);
  return () => {
    stop();
    clearInterval(timer);
  };
}
