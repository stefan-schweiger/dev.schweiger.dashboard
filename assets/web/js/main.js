// Entry point: connects to Homey, picks the dashboard and keeps it live.

import { APP_ID, keepStorage, loadConfig, servedByHomey, writeStoredConfig } from './config.js';
import { isSaving, loadKeyScopes } from './dashboard-save.js';
import { initEditMode } from './edit-mode.js';
import { initFit, isFit, setFit } from './fit.js';
import { $, darkQuery, el } from './dom.js';
import { DASHBOARD_ICON } from './icons.js';
import { createClient } from './homey-api.js';
import { fetchHighlight, isHighlightOpen, showHighlight, watchHighlight } from './highlight.js';
import { initKiosk, isKiosk, kioskHome, resetIdle, screenState, setKiosk, settleKioskHome } from './kiosk.js';
import { createPairing } from './pairing.js';
import { createRealtime, loadScript } from './realtime.js';
import { redrawWidgets, renderDashboard, updateBoard } from './render.js';
import {
  adoptScreenId, browserName, dropScreenId, registerScreen, renameOwnScreen, screenId, switchScreen, watchScreen,
} from './screen.js';
import { STORAGE_KEY, params, state } from './state.js';
import { checkForUpdate, watchUpdates } from './updates.js';
import { loadWidgetModes, watchWidgetModes } from './widget-modes.js';

// The dashboard name is the switch: it lists the dashboards, the shown one highlighted. Not in kiosk mode.
function populateDashboardMenu() {
  const dashboards = Object.values(state.dashboards).sort((a, b) => a.name.localeCompare(b.name));
  $('dashboard-menu').replaceChildren(...dashboards.map((dashboard) => {
    const item = el('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = DASHBOARD_ICON;
    item.append(el('span', null, dashboard.name));
    if (dashboard.id === state.dashboardId) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => {
      toggleDashboardMenu(false);
      showDashboard(dashboard.id);
    });
    return item;
  }));
  $('dashboard-switch').toggleAttribute('data-single', dashboards.length < 2);
}

function toggleDashboardMenu(open = $('dashboard-menu').hidden) {
  const menu = $('dashboard-menu');
  const anchor = $('dashboard-switch').getBoundingClientRect();
  menu.style.top = `${anchor.bottom + 8}px`;
  menu.style.left = `${Math.max(16, anchor.left)}px`;
  menu.hidden = !open;
  $('dashboard-switch').setAttribute('aria-expanded', String(open));
  if (open) (menu.querySelector('[aria-current="true"]') ?? menu.firstElementChild)?.focus();
}

function chooseDashboard() {
  const requested = params.get('dashboard');
  const dashboards = Object.values(state.dashboards);
  const match = (value) => dashboards.find((dashboard) => dashboard.id === value || dashboard.name === value);
  let remembered = null;
  try {
    remembered = localStorage.getItem(`${STORAGE_KEY}:dashboard`);
  } catch {
    // Ignore unavailable storage.
  }
  // The one showing stays (a reload of the dashboards after a reconnect must not switch); a kiosk tablet starts on its
  // own dashboard and only returns to it when left alone.
  state.dashboardId = (match(requested) ?? match(state.dashboardId) ?? match(kioskHome()) ?? match(remembered) ?? dashboards[0])?.id ?? null;
}

async function refreshAll() {
  const [dashboards, me] = await Promise.all([
    state.client.api('GET', '/api/manager/dashboards/dashboard'),
    state.client.api('GET', '/api/manager/users/user/me').catch(() => null),
  ]);
  state.dashboards = dashboards ?? {};
  state.me = me;
  chooseDashboard();
  populateDashboardMenu();
  await renderDashboard();
  showHighlight();
}

function setStatus(stateName, text) {
  const status = $('status');
  status.dataset.state = stateName;
  status.textContent = text;
}

// Re-render when the shown dashboard changes, or one it has a shortcut to (its name may have changed).
const isShownOrLinked = (id) => id === state.dashboardId
  || (state.dashboards[state.dashboardId]?.columns ?? []).some((column) => column.widgets
    .some((widget) => widget.type === 'dashboards_shortcuts' && widget.data?.dashboardIds?.includes(id)));

// From Homey, or saved here (edit mode), which Homey then announces too. Only what changed is drawn again.
function onDashboardChange(dashboard) {
  if (dashboard?.id == null) return;
  state.dashboards[dashboard.id] = dashboard;
  chooseDashboard();
  populateDashboardMenu();
  if (dashboard.id === state.dashboardId) updateBoard();
  else if (isShownOrLinked(dashboard.id)) renderDashboard();
  showHighlight();
}
document.addEventListener('dashboard-saved', (event) => onDashboardChange(event.detail));

function watchHomey() {
  state.realtime.on('homey:manager:dashboards', 'dashboard.create', onDashboardChange);
  state.realtime.on('homey:manager:dashboards', 'dashboard.update', (dashboard) => {
    if (!isSaving(dashboard?.id)) onDashboardChange(dashboard);
  });
  state.realtime.on('homey:manager:dashboards', 'dashboard.delete', ({ id }) => {
    delete state.dashboards[id];
    const wasShownOrLinked = isShownOrLinked(id);
    chooseDashboard();
    populateDashboardMenu();
    if (wasShownOrLinked) renderDashboard();
    showHighlight();
  });
  // The "Show a dashboard" flow card, for every screen or this one. A kiosk tablet counts it as a touch, so it stays
  // two minutes before going home.
  if (servedByHomey) {
    state.realtime.on(`homey:app:${APP_ID}`, 'show-dashboard', (data) => {
      if (data?.screenId !== 'all' && data?.screenId !== screenId()) return;
      resetIdle();
      showDashboard(data?.dashboardId);
    });
  }
  // A widget on this dashboard that is to run another way (sandboxed, with storage or trusted) is loaded again.
  watchWidgetModes(redrawWidgets);
  // Favorites live on the user, so re-render when they change in the mobile app.
  state.realtime.on('homey:manager:users', 'user.update', async (user) => {
    if (user?.id !== state.me?.id) return;
    state.me = await state.client.api('GET', '/api/manager/users/user/me').catch(() => state.me);
    renderDashboard();
  });
}

const pairing = createPairing({
  onApproved(token, purpose, approvedScreenId) {
    if (purpose === 'unlock') {
      resetIdle();
      openSetup();
      return;
    }
    if (approvedScreenId) adoptScreenId(approvedScreenId);
    writeStoredConfig({ token });
    location.reload();
  },
});

// The setup dialog shows one of: 'pairing' (served by the Homey app, a browser without a key shows a code that you
// approve in the app's settings), 'unlock' (a kiosk tablet asking the same way to open its settings) or 'key'.
let setupMode = 'key';
function showSetupMode(mode) {
  setupMode = mode;
  const asking = mode === 'pairing' || mode === 'unlock';
  $('setup-pairing').hidden = !asking;
  $('setup-key').hidden = asking;
  $('pairing-intro').hidden = mode !== 'pairing';
  $('unlock-intro').hidden = mode !== 'unlock';
  // Unlocking must not offer a way around the approval.
  $('pairing-use-key').hidden = mode !== 'pairing';
  $('pairing-cancel').hidden = mode !== 'unlock';
  if (asking) pairing.start({ purpose: mode === 'unlock' ? 'unlock' : 'pair' });
  else pairing.stop();
}

// A kiosk tablet opens its settings only after someone approves a code in the Homey app. Served from elsewhere
// (developing) there is no app to ask, so holding the name opens them directly.
function openUnlock() {
  if (!servedByHomey) return openSetup();
  $('setup-title').textContent = 'Unlock';
  $('setup-error').hidden = true;
  showSetupMode('unlock');
  if (!$('setup').open) $('setup').showModal();
}

// A kiosk tablet left alone: close sheets and settings (not a pairing in progress, it is needed to get going) and go
// back to its dashboard. Not while a flow highlights a widget, which it put there for this tablet to show: the tablet
// goes back at the next idle check after that closes.
function kioskIdle() {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.id !== 'setup' || setupMode !== 'pairing') dialog.close();
  }
  const home = kioskHome();
  if (home && home !== state.dashboardId && state.dashboards[home] && !isHighlightOpen()) showDashboard(home);
}

function openSetup(errorText) {
  const config = state.config ?? {};
  showSetupMode(servedByHomey && !config.token ? 'pairing' : 'key');
  // Once dashboards are showing, this is the browser's settings rather than a connection form.
  const connected = state.dashboardId != null && Boolean(config.token);
  $('setup-title').textContent = connected ? 'Settings' : 'Connect to Homey';
  $('setup-layout').hidden = !connected;
  // Paired by the app, the key is the app's business: no key field, and Disconnect to start over.
  const paired = connected && servedByHomey;
  $('setup-token-group').hidden = paired;
  $('setup-token').required = !paired;
  $('setup-connect').hidden = paired;
  $('setup-forget-note').hidden = !connected;
  $('setup-screen').hidden = !paired || screenId() == null;
  $('setup-no-screen').hidden = !paired || screenId() != null;
  if (paired && screenId() != null) showScreenPicker();
  $('setup-kiosk').hidden = !connected;
  $('setup-done').hidden = !connected;
  $('fit-toggle').checked = isFit();
  $('kiosk-toggle').checked = isKiosk();
  $('kiosk-screen').hidden = !isKiosk();
  $('kiosk-screen').textContent = {
    on: 'The screen is being kept on.',
    off: "The browser isn't keeping the screen on right now (it may need a tap first, or power saving refuses it).",
    insecure: "Opened over plain HTTP, the browser can't keep the screen on; use the https address.",
    unsupported: "This browser can't keep the screen on.",
  }[screenState()];
  const dashboards = Object.values(state.dashboards).sort((a, b) => a.name.localeCompare(b.name));
  $('kiosk-dashboard').replaceChildren(...dashboards.map((dashboard) => {
    const option = el('option', null, dashboard.name);
    option.value = dashboard.id;
    return option;
  }));
  $('kiosk-dashboard').value = kioskHome() ?? state.dashboardId ?? '';
  $('setup-url').value = config.homeyUrl ?? '';
  // Served by the Homey app, the address is known; only the API key is asked for.
  $('setup-url-group').hidden = servedByHomey;
  $('setup-url').required = !servedByHomey;
  $('setup-token').value = config.token ?? '';
  $('setup-error').hidden = !errorText;
  $('setup-error').textContent = errorText ?? '';
  if (location.protocol === 'https:' && config.homeyUrl?.startsWith('http:')) {
    $('setup-error').hidden = false;
    $('setup-error').textContent = 'This page is served over HTTPS, so the Homey address must use HTTPS too.';
  }
  if (!$('setup').open) $('setup').showModal();
}

// "This screen" in Settings: this browser's own screen to rename it, another screen the app knows to become that one,
// or a new screen. keep: hold on to what is picked and typed (the list changed while Settings was open).
const NEW_SCREEN = '';
function showScreenPicker({ keep = false } = {}) {
  const ownKnown = state.screens.some((screen) => screen.id === screenId());
  const picked = keep ? $('screen-pick').value : (ownKnown ? screenId() : NEW_SCREEN);
  const typed = keep ? $('screen-rename-name').value : (ownKnown ? state.screenName ?? '' : '');
  const options = state.screens.map((screen) => {
    const where = screen.id === screenId() ? 'this browser' : `seen ${seenAgo(screen.lastSeen)}`;
    const option = el('option', null, `${screen.name} · ${screen.shortId} · ${where}`);
    option.value = screen.id;
    return option;
  });
  const fresh = el('option', null, 'A new screen');
  fresh.value = NEW_SCREEN;
  $('screen-pick').replaceChildren(...options, fresh);
  $('screen-pick').value = picked;
  // A screen forgotten in the meantime falls back to a new one.
  if ($('screen-pick').value !== picked) $('screen-pick').value = NEW_SCREEN;
  $('screen-rename-name').value = typed;
  updateScreenPicker();
}

// The name field and the button follow what is picked.
function updateScreenPicker() {
  const picked = $('screen-pick').value;
  const own = picked === screenId();
  const other = own ? null : state.screens.find((screen) => screen.id === picked);
  const nameInput = $('screen-rename-name');
  nameInput.hidden = other != null;
  nameInput.placeholder = own ? '' : browserName();
  const apply = $('screen-apply');
  apply.textContent = own ? 'Rename' : other ? 'Become this screen' : 'Add as new screen';
  apply.classList.toggle('primary', !own);
  apply.disabled = own && nameInput.value.trim() === (state.screenName ?? '');
  // The screen this browser leaves keeps its flow cards; another browser may still show it.
  const leaves = state.screenName && !own
    ? ` ${state.screenName} stays in the Homey app; forget it there if no browser shows it any more.` : '';
  $('screen-note').textContent = own
    ? 'Flow cards can highlight a widget or show a dashboard on this screen by its name.'
    : other ? `Flow cards aimed at ${other.name} show here from now on.${leaves}`
      : `This browser becomes a screen of its own for flow cards to aim at.${leaves}`;
}

function seenAgo(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 2) return 'now';
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

$('screen-pick').addEventListener('change', () => {
  $('screen-rename-name').value = $('screen-pick').value === screenId() ? state.screenName ?? '' : '';
  updateScreenPicker();
});
$('screen-rename-name').addEventListener('input', updateScreenPicker);
// Enter applies here rather than submitting the setup form.
$('screen-rename-name').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (!$('screen-apply').disabled) $('screen-apply').click();
});
$('screen-apply').addEventListener('click', async () => {
  const picked = $('screen-pick').value;
  const name = $('screen-rename-name').value.trim();
  $('screen-apply').disabled = true;
  $('setup-error').hidden = true;
  try {
    if (picked === screenId()) {
      await renameOwnScreen(name);
      showScreenPicker();
    } else {
      // Loads the page again as that screen.
      await switchScreen(picked === NEW_SCREEN ? null : picked, name);
    }
  } catch (error) {
    $('setup-error').textContent = error.message;
    $('setup-error').hidden = false;
    updateScreenPicker();
  }
});
document.addEventListener('screens-changed', () => {
  if ($('setup').open && !$('setup-screen').hidden) showScreenPicker({ keep: true });
});

$('setup').addEventListener('close', () => pairing.stop());
$('setup-done').addEventListener('click', () => $('setup').close());
$('fit-toggle').addEventListener('change', (event) => setFit(event.target.checked));
// Kiosk mode: this browser always shows the chosen dashboard. Turning it on shows the result straight away;
// holding the dashboard name brings Settings back.
$('kiosk-toggle').addEventListener('change', (event) => {
  const home = $('kiosk-dashboard').value;
  setKiosk(event.target.checked, home);
  if (!event.target.checked) return;
  showDashboard(home);
  $('setup').close();
});
$('kiosk-dashboard').addEventListener('change', (event) => {
  if (!isKiosk()) return;
  setKiosk(true, event.target.value);
  showDashboard(event.target.value);
});
$('pairing-retry').addEventListener('click', () => pairing.start());
$('pairing-cancel').addEventListener('click', () => $('setup').close());
$('pairing-use-key').addEventListener('click', () => {
  $('setup-error').hidden = true;
  showSetupMode('key');
});

$('setup-form').addEventListener('submit', () => {
  const token = $('setup-token').value.trim();
  writeStoredConfig(servedByHomey ? { token } : { homeyUrl: $('setup-url').value.trim(), token });
  location.reload();
});

$('setup-forget').addEventListener('click', () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(`${STORAGE_KEY}:dashboard`);
  } catch {
    // Ignore unavailable storage.
  }
  location.reload();
});

$('settings-button').addEventListener('click', () => openSetup());

// From the dashboard menu under the title or a dashboard shortcut widget. Each browser remembers its choice; an address that names a
// dashboard is updated too, so a reload or a later dashboard edit doesn't jump back to it.
function showDashboard(id) {
  if (state.dashboards[id] == null) return;
  state.dashboardId = id;
  try {
    localStorage.setItem(`${STORAGE_KEY}:dashboard`, id);
  } catch {
    // Ignore unavailable storage.
  }
  if (params.has('dashboard')) {
    params.set('dashboard', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  populateDashboardMenu();
  renderDashboard();
  window.scrollTo({ top: 0 });
  $('board').scrollLeft = 0;
}

$('dashboard-switch').addEventListener('click', () => {
  if (isKiosk() || Object.keys(state.dashboards).length < 2) return;
  toggleDashboardMenu();
});
document.addEventListener('click', (event) => {
  if (!$('dashboard-menu').hidden && !event.target.closest('#dashboard-menu, #dashboard-switch')) toggleDashboardMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('dashboard-menu').hidden) toggleDashboardMenu(false);
});
document.addEventListener('show-dashboard', (event) => showDashboard(event.detail));

darkQuery.addEventListener('change', () => renderDashboard());

// A paired browser holds the app's key; once that key is deleted in my.homey.app, it pairs again.
function isRevokedKey(error) {
  return servedByHomey && error.status === 401;
}

// Losing access (the key refused, the screen forgotten) also takes the dashboard away: otherwise what it showed stays
// readable behind the pairing code. A reload is the sure way to drop all of it (widgets, camera streams, highlights,
// the live connection); the reason survives it in sessionStorage and boot() shows it.
const NOTICE_KEY = `${STORAGE_KEY}:notice`;
function leaveDashboard(notice) {
  try {
    sessionStorage.setItem(NOTICE_KEY, notice);
  } catch {
    // Without storage the pairing screen shows without the reason.
  }
  location.reload();
}

function takeNotice() {
  try {
    const notice = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return notice ?? undefined;
  } catch {
    return undefined;
  }
}

// Homey can also refuse a good key for a moment (while it starts up), so the stored key is kept: it is tried again every
// minute, and pairing again replaces it. Forget in Settings removes it. Refused while a dashboard is showing, the page
// first reloads to drop it; refused again on that load (nothing drawn yet), it asks for a code.
let keyRetry = null;
function pairAgain() {
  const notice = 'Homey no longer accepts the key this browser had. Pair it again.';
  if (state.dashboardId != null) return leaveDashboard(notice);
  state.config = { ...state.config, token: undefined };
  setStatus('offline', 'Not connected');
  openSetup(notice);
  clearInterval(keyRetry);
  keyRetry = setInterval(async () => {
    const accepted = await state.client.api('GET', '/api/manager/sessions/session/me').then(() => true, () => false);
    if (accepted) location.reload();
  }, 60 * 1000);
}

// Forgotten in the Homey app: this browser steps back like Disconnect (key, remembered dashboard and screen id gone)
// and, after a reload that drops what it showed, asks for a code to be approved again, as a fresh screen.
function disconnectForgotten() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(`${STORAGE_KEY}:dashboard`);
  } catch {
    // Ignore unavailable storage.
  }
  dropScreenId();
  leaveDashboard('This screen was removed in the Homey app. Pair this browser again to reconnect it.');
}

async function boot() {
  state.config = await loadConfig();
  const notice = takeNotice();
  if (!state.config.homeyUrl || !state.config.token) {
    setStatus('offline', 'Not connected');
    openSetup(notice);
    return;
  }
  keepStorage();

  try {
    state.client = createClient(state.config);
  } catch (error) {
    openSetup(`Invalid Homey address: ${error.message}`);
    return;
  }

  try {
    // Homey serves the socket.io client matching its own server version.
    await loadScript(`${state.client.base}/socket.io/socket.io.js`);
    const onReconnect = () => {
      // Homey may have restarted with an updated app while the connection was down.
      checkForUpdate('reconnected');
      registerScreen();
      fetchHighlight();
      loadWidgetModes().then(refreshAll).catch((error) => {
        if (isRevokedKey(error)) pairAgain();
        else console.error(error);
      });
    };
    // Once pairAgain() dropped the key, the old connection's handshake errors are only noise.
    const onStatus = (name, text) => {
      if (state.config.token) setStatus(name, text);
    };
    state.realtime = createRealtime(state.client, { onStatus, onReconnect });
    watchHomey();
    watchUpdates();
    watchScreen({ onForgotten: disconnectForgotten });
    watchHighlight();
  } catch (error) {
    setStatus('error', 'No live updates');
    console.error(error);
  }

  try {
    const [system] = await Promise.all([
      state.client.api('GET', '/api/manager/system/').catch(() => ({})),
      loadKeyScopes(),
      loadWidgetModes(),
    ]);
    state.system = system;
    await refreshAll();
    settleKioskHome();
    $('edit-button').hidden = false;
  } catch (error) {
    if (isRevokedKey(error)) return pairAgain();
    setStatus('error', 'Not connected');
    openSetup(`Could not reach Homey: ${error.message}`);
  }
}

initKiosk({ onHold: openUnlock, onIdle: kioskIdle });
initFit();
initEditMode();
boot();
