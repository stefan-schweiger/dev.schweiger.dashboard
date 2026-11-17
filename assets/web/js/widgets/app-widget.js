// App widgets: the app's own HTML in an iframe.

import { applyWidgetHeight, widgetHosts } from '../crossframe-host.js';
import { requireData } from '../data.js';
import { el, note } from '../dom.js';
import { state } from '../state.js';
import { widgetMode } from '../widget-modes.js';
import { loadWithStorage } from '../widget-storage.js';

// No allow-popups-to-escape-sandbox: a popup that escaped would run unsandboxed, and one opened on a Homey address
// could run an app's code on this page's origin, where the API key is.
const SANDBOX = 'allow-scripts allow-forms allow-popups';

export function mountAppWidget({ widget, section, body, setTitle }) {
  if (!requireData(body, 'appWidgets')) return;
  const definition = state.data.appWidgets[widget.data?.appWidgetId];
  if (definition == null) {
    note(body, 'The app for this widget is not running or no longer installed.');
    return;
  }
  setTitle(definition.name);
  section.classList.add('is-loading');
  if (definition.transparent === true) section.classList.add('is-transparent');

  const defaults = Object.fromEntries((definition.settings ?? []).map((setting) => [setting.id, setting.value ?? null]));
  const appId = definition.ownerUri.replace(/^homey:app:/, '');

  const frame = el('div', 'app-frame');
  const iframe = el('iframe', 'widget-frame');
  iframe.title = definition.name;
  // Served by the Homey app, this page shares Homey's origin with every app's widgets. Without
  // allow-same-origin the widget runs in its own opaque origin, so it can't read the API key this page stores,
  // unless it is trusted (widget-modes.js). Set before the frame loads, so the first load is already sandboxed.
  const mode = widgetMode(widget.id);
  if (mode !== 'trusted') iframe.setAttribute('sandbox', SANDBOX);
  const src = `${state.client.base}/app/${encodeURIComponent(appId)}/widgets/${encodeURIComponent(definition.ownerId)}/index.html?widgetInstanceId=${encodeURIComponent(widget.id)}`;
  frame.append(iframe);
  applyWidgetHeight(iframe, definition.height ?? 200, widget.id);
  body.append(frame);

  const host = {
    iframe,
    src,
    appId,
    widgetId: definition.ownerId,
    instanceId: widget.id,
    height: definition.height ?? 200,
    storage: mode === 'storage',
    settings: { ...defaults, ...(widget.data.settings ?? {}) },
    deviceIds: widget.data.deviceIds ?? [],
    transparent: definition.transparent === true,
    cleanups: [],
    onReady: () => {
      clearTimeout(revealTimer);
      section.classList.remove('is-loading');
    },
  };
  // Reveal anyway if a widget never calls Homey.ready().
  const revealTimer = setTimeout(host.onReady, 8000);

  // Register before the frame loads: the widget asks for its initial data immediately.
  const frameWindow = iframe.contentWindow;
  widgetHosts.set(frameWindow, host);
  if (host.storage) {
    loadWithStorage(iframe, src, appId).catch((error) => {
      console.info(`Widget storage: ${error.message}`);
      iframe.src = src;
    });
  } else {
    iframe.src = src;
  }

  return () => {
    clearTimeout(revealTimer);
    for (const cleanup of host.cleanups) cleanup();
    widgetHosts.delete(frameWindow);
  };
}
