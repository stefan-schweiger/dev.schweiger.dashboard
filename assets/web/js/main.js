// Entry point: connects to Homey, picks the dashboard and keeps it live.

import { APP_ID, loadConfig, servedByHomey, writeStoredConfig } from './config.js';
import { isSaving, loadKeyScopes } from './dashboard-save.js';
import { initEditMode } from './edit-mode.js';
import { fitBoard, initFit, isFit, setFit } from './fit.js';
import { getLayout, initLayout, setColumnAlignment, setColumnWidth } from './layout.js';
import { $, darkQuery, el } from './dom.js';
import { DASHBOARD_ICON } from './icons.js';
import { createClient } from './homey-api.js';
import { fetchHighlight, isHighlightOpen, showHighlight, watchHighlight } from './highlight.js';
import { initKiosk, isKiosk, kioskHome, resetIdle, screenState, setKiosk, settleKioskHome } from './kiosk.js';
import { createPairing } from './pairing.js';
import { createRealtime, loadScript } from './realtime.js';
import { redrawWidgets, renderDashboard, updateBoard } from './render.js';
import { registerScreen, screenId, watchScreen } from './screen.js';
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
  onApproved(token, purpose) {
    if (purpose === 'unlock') {
      resetIdle();
      openSetup();
      return;
    }
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
  $('setup-screen').hidden = !connected || !state.screenName;
  $('screen-name').textContent = state.screenName ?? '';
  $('setup-kiosk').hidden = !connected;
  $('setup-done').hidden = !connected;
  $('fit-toggle').checked = isFit();
  const layout = getLayout();
  $('column-width').value = String(layout.columnWidth);
  $('column-width-value').value = `${layout.columnWidth} px`;
  $('column-width-value').textContent = `${layout.columnWidth} px`;
  $('column-alignment').value = layout.alignment;
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

$('setup').addEventListener('close', () => pairing.stop());
$('setup-done').addEventListener('click', () => $('setup').close());
$('fit-toggle').addEventListener('change', (event) => setFit(event.target.checked));
$('column-width').addEventListener('input', (event) => {
  setColumnWidth(event.target.value);
  $('column-width-value').value = `${event.target.value} px`;
  $('column-width-value').textContent = `${event.target.value} px`;
  fitBoard();
});
$('column-alignment').addEventListener('change', (event) => setColumnAlignment(event.target.value));
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

function pairAgain() {
  writeStoredConfig({});
  state.config = { ...state.config, token: undefined };
  setStatus('offline', 'Not connected');
  openSetup('Homey no longer accepts the key this browser had. Pair it again.');
}

async function boot() {
  state.config = await loadConfig();
  if (!state.config.homeyUrl || !state.config.token) {
    setStatus('offline', 'Not connected');
    openSetup();
    return;
  }

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
    watchScreen();
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
initLayout();
initFit();
initEditMode();
boot();
