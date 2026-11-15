// Screens: each browser keeps a random id of its own, so the app can name it ("Hallway tablet") and flow cards can aim
// at it. The id survives reloads and Settings → Disconnect. The name is given when the browser is approved; it is
// changed in the dashboard's Settings or in the app's settings in the Homey app, and Settings can also make this
// browser another screen. A browser that lost its storage says which screen it was while pairing again, and takes
// that screen's id back. Forgetting a screen in the Homey app disconnects the browser showing it. A browser without
// storage (private mode) has no id and only follows flow cards aimed at all screens. Only when served by the app.

import { APP_ID, servedByHomey } from './config.js';
import { subscribe } from './realtime.js';
import { STORAGE_KEY, state } from './state.js';

const SCREEN_KEY = `${STORAGE_KEY}:screen`;

let id; // Read once; null without storage.
let onForgotten = () => {}; // What to do when the app says this screen was forgotten (see watchScreen).

// crypto.randomUUID() needs https, and the dashboard may be opened over plain http.
function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function screenId() {
  if (id !== undefined) return id;
  try {
    id = localStorage.getItem(SCREEN_KEY);
    if (id == null) {
      const created = newId();
      localStorage.setItem(SCREEN_KEY, created);
      // An id that wasn't stored would be a new screen on every load.
      id = localStorage.getItem(SCREEN_KEY) === created ? created : null;
    }
  } catch {
    id = null;
  }
  return id;
}

// Forgotten in the Homey app: the id goes too, so pairing again makes a fresh one.
export function dropScreenId() {
  try {
    localStorage.removeItem(SCREEN_KEY);
  } catch {
    // Without storage there is nothing to drop.
  }
  id = undefined;
}

// Pairing again, this browser said it is a screen the app already knew (its storage was cleared, say): from now on it
// is that screen, so flow cards aimed at it reach it again.
export function adoptScreenId(newId) {
  if (typeof newId !== 'string' || !/^[\w-]{8,64}$/.test(newId)) return;
  try {
    localStorage.setItem(SCREEN_KEY, newId);
    id = newId;
  } catch {
    // Without storage it can't keep an id anyway.
  }
}

// A name you can recognise in the settings page, e.g. "Safari on iPad".
export function browserName() {
  const ua = navigator.userAgent;
  const browser = /Edg/.test(ua) ? 'Edge'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome|CriOS/.test(ua) ? 'Chrome'
        : /Safari/.test(ua) ? 'Safari'
          : 'Browser';
  // iPads ask for the desktop site, so they look like a Mac with a touch screen.
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux'
              : null;
  return device ? `${browser} on ${device}` : browser;
}

// Tells the app this screen is here (it adds one it doesn't know yet) and learns its name. On load and after
// reconnecting. A screen forgotten in the Homey app isn't added back: the app says so and this browser disconnects.
export async function registerScreen() {
  if (!servedByHomey || screenId() == null) return;
  try {
    const { name, screens, forgotten } = await state.client.api('POST', `/api/app/${APP_ID}/screen-hello`, {
      token: state.client.token, id: screenId(), name: browserName(),
    });
    if (forgotten) {
      onForgotten();
      return;
    }
    state.screenName = name;
    state.screens = Array.isArray(screens) ? screens : [];
  } catch (error) {
    console.info(`Screen: ${error.message}`);
  }
}

// Needs the client and the realtime connection. Keeps the name and the list current when they change in the Homey app,
// and calls onForgotten when this screen is forgotten there (now, or at its next hello).
export function watchScreen(options = {}) {
  if (!servedByHomey || screenId() == null) return;
  if (options.onForgotten) onForgotten = options.onForgotten;
  subscribe(`homey:app:${APP_ID}`, 'screen-forgotten', (data) => {
    if (data?.id === screenId()) onForgotten();
  });
  subscribe(`homey:app:${APP_ID}`, 'screens', (screens) => {
    state.screens = Array.isArray(screens) ? screens : [];
    state.screenName = state.screens.find((screen) => screen.id === screenId())?.name ?? null;
    document.dispatchEvent(new Event('screens-changed'));
  });
  registerScreen();
}

// From Settings: this browser becomes another known screen (to: its id) or a new one (to: null, called name or, without
// one, its browser name). It then loads again as that screen, so its highlight and flow cards follow.
export async function switchScreen(to, name) {
  const { id: newId } = await state.client.api('POST', `/api/app/${APP_ID}/screen-switch`, {
    token: state.client.token, to, name: name || null, browser: browserName(),
  });
  adoptScreenId(newId);
  location.reload();
}

// From Settings: renames this browser's screen. Names are unique, so this can fail.
export async function renameOwnScreen(name) {
  const result = await state.client.api('POST', `/api/app/${APP_ID}/screen-rename`, {
    token: state.client.token, id: screenId(), name,
  });
  state.screenName = result.name;
}
