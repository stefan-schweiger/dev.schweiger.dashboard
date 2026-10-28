'use strict';

const crypto = require('crypto');
const Homey = require('homey');

// What the dashboard needs, named as in my.homey.app's API key form (group → box); that form lacks the first and the
// energy one, so those are named by scope.
const NEEDED_SCOPES = [
  ['homey.dashboard.readonly', 'View dashboards (homey.dashboard.readonly; not offered in the my.homey.app form)'],
  ['homey.device.readonly', 'Devices → View devices'],
  ['homey.device.control', 'Devices → Control devices'],
  ['homey.flow.readonly', 'Flows → View Flows'],
  ['homey.flow.start', 'Flows → Start Flows'],
  ['homey.mood.readonly', 'Moods → View Moods'],
  ['homey.mood.set', 'Moods → Set Moods'],
  ['homey.logic.readonly', 'Variables → View Variables'],
  ['homey.zone.readonly', 'Zones → View Zones'],
  ['homey.notifications.readonly', 'Notifications → View Notifications'],
  ['homey.app.readonly', 'Apps → View Apps'],
  ['homey.user.readonly', 'Users → View Users'],
  ['homey.user.self', 'Users → Edit Self User'],
  ['homey.insights.readonly', 'Logs → View Logs'],
  ['homey.energy.readonly', 'View energy (homey.energy.readonly; not offered in the my.homey.app form)'],
  ['homey.presence.self', 'Presence → Edit Self Presence'],
  ['homey.system.readonly', 'System → View System'],
  ['homey.geolocation.readonly', 'Location → View Location'],
];

// Ticking a group's own box (or Homey) also allows deleting and changing things; every paired browser holds the key.
// Dashboards (homey.dashboard) isn't among them: it is what editing on the web dashboards needs.
const BROAD_SCOPES = {
  homey: 'Homey (everything)',
  'homey.app': 'Apps (installs and removes apps)',
  'homey.app.control': 'Apps → Control Apps (changes app settings, this one included)',
  'homey.user': 'Users (adds and removes users)',
  'homey.system': 'System (firmware, restarts)',
  'homey.updates': 'Updates',
  'homey.device': 'Devices (deletes and changes devices)',
  'homey.flow': 'Flows (edits and deletes Flows)',
  'homey.mood': 'Moods (edits and deletes moods)',
  'homey.logic': 'Variables (edits and deletes variables)',
  'homey.zone': 'Zones (edits and deletes zones)',
  'homey.energy': 'Energy (changes energy settings)',
  'homey.notifications': 'Notifications (deletes notifications)',
  'homey.insights': 'Logs (deletes logs)',
  'homey.presence': "Presence (sets other people's presence)",
  'homey.alarm': 'Alarms',
  'homey.geolocation': 'Location',
};

// A scope is granted by itself or by any parent (homey.device grants homey.device.readonly; homey grants all).
const grants = (scopes, scope) => scope.split('.').some((_, index, parts) => scopes.includes(parts.slice(0, index + 1).join('.')));

// How long a browser's code stays valid, and how many browsers may wait at once.
const PAIRING_TTL = 10 * 60 * 1000;
const MAX_WAITING = 10;

// What the highlight card calls a widget without a title (and without a device or zone to name it by).
const WIDGET_TYPES = {
  app_webview: 'App widget',
  dashboards_shortcuts: 'Dashboards',
  devices_favorites: 'Favorite devices',
  flows_favorites: 'Favorite flows',
  moods_favorites: 'Favorite moods',
  devices_custom: 'Devices',
  flows_custom: 'Flows',
  moods_custom: 'Moods',
  devices_zone: 'Zone devices',
  moods_zone: 'Zone moods',
  light_zones: 'Zone lights',
  insights_chart_line: 'Chart',
  light_device: 'Light',
  light_group: 'Lights',
  device_speaker_large: 'Speaker',
  device_speaker_small: 'Speaker',
  energy_usage: 'Energy',
  thermostat: 'Thermostat',
  notifications_timeline_large: 'Timeline',
  notifications_timeline_small: 'Timeline',
  device_camera_snapshot: 'Camera snapshot',
  device_camera_live: 'Live camera',
  web_frame: 'Web frame',
  energy_dynamic_prices: 'Electricity prices',
  logic_variables: 'Variables',
  note: 'Note',
  sensors_selection: 'Sensors',
  zone_controls: 'Zone controls',
  users_avatars: 'Users',
  batteries_devices: 'Batteries',
  batteries_device_low: 'Low batteries',
  weather_forecast: 'Weather forecast',
  weather: 'Weather',
};

const matches = (query, ...texts) => texts.some((text) => text?.toLowerCase().includes(query.trim().toLowerCase()));

// How an app widget runs on the web dashboards, chosen in its settings there; the first is the default. Sandboxed
// widgets can't read the API key the page keeps; 'storage' also gives them localStorage, kept by the page, and a
// trusted one runs unsandboxed, as in the Homey app, where it could read the key.
const WIDGET_MODES = ['sandboxed', 'storage', 'trusted'];
const validWidgetId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);

// Screens: browsers showing the dashboard, each with a lasting random id it keeps in its storage and a name you give
// it, so flow cards can aim at one of them. At most this many are kept; lastSeen is saved at most this often.
const MAX_SCREENS = 50;
// Forgotten screen ids are remembered (the latest this many), so a browser still holding one disconnects instead of
// coming back on its own.
const MAX_FORGOTTEN = 200;
const SEEN_EVERY = 60 * 60 * 1000;
const ALL_SCREENS = 'all';
const validScreenId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);
const cleanName = (name) => (typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 60) : null);
// Tells apart screens with the same name, e.g. "#3F9A".
const shortId = (id) => `#${id.slice(0, 4).toUpperCase()}`;
const newScreenId = () => crypto.randomBytes(16).toString('hex');

function ago(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 2) return 'now';
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

// The dashboard is static files in assets/web/, which Homey serves at /app/<app id>/assets/web/.
// The app works out that address for the settings page, keeps the API key the dashboard uses, and hands
// it to browsers you approve (pairing), so the key only has to be entered once.
module.exports = class DashboardApp extends Homey.App {
  async onInit() {
    // Waiting browsers live in memory only; a restart simply asks them for a new code.
    this.pairings = new Map();

    // e.g. "192.168.3.210:80"; a Homey Self-Hosted Server has its own http port, by default 4859.
    const address = await this.homey.cloud.getLocalAddress();
    const [ip, httpPort = '80'] = address.split(':');
    const path = `/app/${this.manifest.id}/assets/web/index.html`;
    this.homey.settings.set('dashboardLocalUrl', `http://${address}${path}`);
    this.setSecureUrl(ip, Number(httpPort), path).catch(this.error);

    this.initHighlightCards();
    this.initShowDashboardCard();
  }

  // *.homey.homeylocal.com resolves to the Homey on the local network and has a valid HTTPS certificate. A Homey Pro
  // serves it on 443; a Homey Self-Hosted Server on a port of its own, by default the one after its http port (4860),
  // which no API names. The port that answers is used; until one does, and if none does, the default.
  async setSecureUrl(ip, httpPort, path) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      // Only an IPv4 address has a homeylocal.com name.
      this.homey.settings.set('dashboardUrl', this.homey.settings.get('dashboardLocalUrl'));
      return;
    }
    const host = `${ip.replace(/\./g, '-')}.homey.homeylocal.com`;
    const url = (port) => `https://${host}${port === 443 ? '' : `:${port}`}${path}`;
    const ports = httpPort === 80 ? [443] : [httpPort + 1, 443];
    this.homey.settings.set('dashboardUrl', url(ports[0]));
    if (ports.length > 1) {
      for (const port of ports) {
        const response = await fetch(url(port), { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (response?.ok) {
          this.homey.settings.set('dashboardUrl', url(port));
          break;
        }
      }
    }
    this.log(`Dashboard: ${this.homey.settings.get('dashboardUrl')}`);
  }

  // ----- Pairing (public routes: an unknown browser can only ask for a code and poll it) -----

  // purpose 'pair' hands an approved browser the API key. 'unlock' only lets a kiosk tablet, which already has the
  // key, open its settings: approving it hands out nothing.
  // A connecting browser also gets the known screens (names only), so whoever stands at it can say which one it is,
  // e.g. after its storage was cleared. It answers with a place in that list and never learns their ids.
  requestPairing({ name, purpose, screenId }) {
    const unlock = purpose === 'unlock';
    if (!unlock && !this.homey.settings.get('apiKey')) {
      throw new Error('No API key is set yet. Add one in the Web Dashboard settings in the Homey app.');
    }
    this.prunePairings();

    const ownId = validScreenId(screenId) ? screenId : null;
    const screens = unlock ? [] : this.listScreens();
    const pairing = {
      // The id is the browser's secret for polling; the short code is what the user compares.
      id: crypto.randomBytes(16).toString('hex'),
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      name: String(name || 'Browser').slice(0, 60),
      // The browser's lasting id (see Screens), so approving can name it.
      screenId: ownId,
      // The screens it was offered, and the one it says it is (at first its own, if the app knows it).
      choices: screens.map((screen) => screen.id),
      claim: screens.some((screen) => screen.id === ownId) ? ownId : null,
      purpose: unlock ? 'unlock' : 'pair',
      createdAt: Date.now(),
      status: 'waiting',
    };
    this.pairings.set(pairing.id, pairing);

    // Keep the list short so a flood of requests can't bury a real one for long.
    const waiting = [...this.pairings.values()].filter((entry) => entry.status === 'waiting');
    for (const stale of waiting.slice(0, Math.max(0, waiting.length - MAX_WAITING))) this.pairings.delete(stale.id);

    this.announcePairings();
    return {
      id: pairing.id,
      code: pairing.code,
      expiresAt: pairing.createdAt + PAIRING_TTL,
      screens: screens.map((screen) => ({
        name: screen.name, shortId: screen.shortId, seen: ago(screen.lastSeen), self: screen.id === pairing.claim,
      })),
    };
  }

  // Public route: a waiting browser says which screen it is, by its place in the list it was given, or null for a
  // new screen. Approving still decides; the settings page shows the choice.
  claimScreen(id, { screen } = {}) {
    this.prunePairings();
    const pairing = this.pairings.get(id);
    if (pairing?.status !== 'waiting' || pairing.purpose !== 'pair') throw new Error('This browser is no longer waiting.');
    if (screen != null && !(Number.isInteger(screen) && screen >= 0 && screen < pairing.choices.length)) {
      throw new Error('Unknown screen.');
    }
    pairing.claim = screen == null ? null : pairing.choices[screen];
    this.announcePairings();
    return { status: 'waiting' };
  }

  // The browser polls with its secret id. The key is handed over once, after approval, then the pairing is gone.
  // screenId: the screen it is from now on, when approving made it a different one than it had.
  getPairing(id) {
    this.prunePairings();
    const pairing = this.pairings.get(id);
    if (pairing == null) return { status: 'expired' };
    if (pairing.status === 'waiting') return { status: 'waiting' };

    this.pairings.delete(id);
    if (pairing.status === 'declined') return { status: 'declined' };
    if (pairing.purpose === 'unlock') return { status: 'approved' };
    const token = this.homey.settings.get('apiKey');
    if (!token) return { status: 'declined' };
    return { status: 'approved', token, screenId: pairing.assignedScreenId ?? null };
  }

  // ----- Pairing (settings page) -----

  // claim: the known screen the browser says it is (null for a new one, also when that screen was forgotten since).
  // suggestedName: a free name to start the field with for a new screen.
  listPairings() {
    this.prunePairings();
    const screens = this.screens();
    return [...this.pairings.values()]
      .filter((pairing) => pairing.status === 'waiting')
      .map(({ id, code, name, claim, purpose, createdAt }) => ({
        id,
        code,
        name,
        claim: screens[claim] != null ? { name: screens[claim].name, shortId: shortId(claim) } : null,
        suggestedName: purpose === 'pair' ? this.uniqueName(name) : null,
        purpose,
        createdAt,
      }));
  }

  // A browser that says it is a known screen becomes that screen again, under its name. Otherwise it is a new screen
  // called name: under its own id, or a fresh one when its id already belongs to a screen it says it isn't. A browser
  // without storage (no id) that claims nothing stays without a screen.
  approvePairing(id, { name } = {}) {
    const pairing = this.pairings.get(id);
    if (pairing?.status === 'waiting' && pairing.purpose === 'pair') {
      const screens = this.screens();
      if (screens[pairing.claim] != null) {
        this.saveScreen(pairing.claim, { lastSeen: Date.now() });
        pairing.assignedScreenId = pairing.claim;
      } else if (pairing.screenId != null) {
        // A forgotten id isn't handed out again.
        const reuse = screens[pairing.screenId] == null && !this.isForgotten(pairing.screenId);
        const screenId = reuse ? pairing.screenId : newScreenId();
        const typed = cleanName(name);
        this.saveScreen(screenId, { name: typed == null ? this.uniqueName(pairing.name, screenId) : this.freeName(typed, screenId) });
        pairing.assignedScreenId = screenId;
      }
    }
    return this.decide(id, 'approved');
  }

  declinePairing(id) {
    return this.decide(id, 'declined');
  }

  decide(id, status) {
    this.prunePairings();
    const pairing = this.pairings.get(id);
    if (pairing == null || pairing.status !== 'waiting') throw new Error('This browser is no longer waiting.');
    pairing.status = status;
    this.log(`Pairing ${pairing.code} (${pairing.name}, ${pairing.purpose}) ${status}`);
    this.announcePairings();
    return { status };
  }

  prunePairings() {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) {
      if (now - pairing.createdAt > PAIRING_TTL) this.pairings.delete(id);
    }
  }

  // Lets an open settings page update its list without polling.
  announcePairings() {
    this.homey.api.realtime('pairings', this.listPairings());
  }

  // ----- API key (settings page) -----

  // Also asks Homey what the saved key may do, so the settings page can name missing and too broad permissions.
  async getApiKeyStatus() {
    const status = this.homey.settings.get('apiKeyStatus') ?? { set: false };
    if (!status.set) return status;
    const scopes = await this.keyScopes(this.homey.settings.get('apiKey')).catch(() => null);
    if (scopes == null) return status;
    return {
      ...status,
      missing: NEEDED_SCOPES.filter(([scope]) => !grants(scopes, scope)).map(([, label]) => label),
      canEdit: grants(scopes, 'homey.dashboard'),
      // With "homey" everything else is implied, so that alone is named.
      broad: Object.entries(BROAD_SCOPES)
        .filter(([scope]) => scopes.includes(scope) && (scope === 'homey' || !scopes.includes('homey')))
        .map(([, label]) => label),
    };
  }

  // A request to this Homey's Web API with the given key (by default the saved one).
  async callHomey(path, token = this.homey.settings.get('apiKey')) {
    const localUrl = await this.homey.api.getLocalUrl();
    return fetch(`${localUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  async getFromHomey(path) {
    if (!this.homey.settings.get('apiKey')) throw new Error('No API key is set yet. Add one in the Web Dashboard settings in the Homey app.');
    const response = await this.callHomey(path);
    if (!response.ok) throw new Error(`Homey refused ${path}: ${response.status}`);
    return response.json();
  }

  async keyScopes(token) {
    const response = await this.callHomey('/api/manager/sessions/session/me', token);
    if (!response.ok) return null;
    const session = await response.json();
    return session.intersectedScopes ?? session.scopes ?? null;
  }

  // Checks the key against this Homey before storing it, so a typo doesn't surface later on every tablet.
  async setApiKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
      this.homey.settings.unset('apiKey');
      this.homey.settings.unset('apiKeyStatus');
      return { set: false };
    }
    const token = key.trim();
    const call = (path) => this.callHomey(path, token);

    const me = await call('/api/manager/users/user/me');
    if (me.status === 401) throw new Error('Homey doesn\'t accept this API key.');
    if (!me.ok) throw new Error(`The key can't read your user (homey.user.self): ${me.status}`);
    const dashboards = await call('/api/manager/dashboards/dashboard');
    if (!dashboards.ok) throw new Error(`The key can't read dashboards (homey.dashboard.readonly): ${dashboards.status}`);

    const user = await me.json();
    const status = { set: true, user: user.name, savedAt: new Date().toISOString() };
    this.homey.settings.set('apiKey', token);
    this.homey.settings.set('apiKeyStatus', status);
    this.log(`API key saved (user ${user.name})`);
    return this.getApiKeyStatus();
  }

  // Whether this Homey accepts a key a dashboard sent, and has the scope, if one is named. The public routes act only
  // for one it does.
  async checkKey(token, scope) {
    const scopes = typeof token === 'string' && token !== '' ? await this.keyScopes(token).catch(() => null) : null;
    if (scopes == null) throw new Error('Homey doesn\'t accept this key.');
    if (scope != null && !grants(scopes, scope)) throw new Error(`This key may not do that (it needs ${scope}).`);
  }

  // ----- How app widgets run on the web dashboards (a widget's settings there) -----

  widgetModes() {
    return this.homey.settings.get('widgetModes') ?? {};
  }

  // Public route: choosing it needs a key that may change dashboards, like the widget's other settings. Widgets no
  // longer on a dashboard are dropped.
  async setWidgetMode(id, { token, mode } = {}) {
    await this.checkKey(token, 'homey.dashboard');
    if (!validWidgetId(id)) throw new Error('Invalid widget id.');
    if (!WIDGET_MODES.includes(mode)) throw new Error('Invalid mode.');
    const modes = this.widgetModes();
    if (mode === WIDGET_MODES[0]) delete modes[id];
    else modes[id] = mode;
    const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard').catch(() => null);
    if (dashboards != null) {
      const onBoard = new Set(Object.values(dashboards).flatMap((dashboard) => (dashboard.columns ?? [])
        .flatMap((column) => column.widgets.map((widget) => widget.id))));
      for (const stale of Object.keys(modes)) if (!onBoard.has(stale)) delete modes[stale];
    }
    this.homey.settings.set('widgetModes', modes);
    this.homey.api.realtime('widget-modes', modes);
    return modes;
  }

  // ----- Screens (named browsers flow cards can aim at) -----

  screens() {
    return this.homey.settings.get('screens') ?? {};
  }

  // Adds or changes a screen. A new one beyond the limit pushes out the one seen longest ago.
  saveScreen(id, changes) {
    const screens = this.screens();
    if (screens[id] == null) {
      const oldest = Object.entries(screens).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
      for (const [stale] of oldest.slice(0, Math.max(0, oldest.length - MAX_SCREENS + 1))) delete screens[stale];
    }
    const now = Date.now();
    screens[id] = { name: 'Browser', createdAt: now, lastSeen: now, ...screens[id], ...changes };
    this.homey.settings.set('screens', screens);
    this.announceScreens();
    return screens[id];
  }

  // Whether another screen than exceptId already has this name (ignoring case).
  nameTaken(name, exceptId) {
    return Object.entries(this.screens()).some(([id, screen]) => id !== exceptId && screen.name.toLowerCase() === name.toLowerCase());
  }

  // A name the app picks itself: the browser's name, or "Chrome on Android 2", 3, … when another screen has it.
  uniqueName(name, exceptId) {
    const base = cleanName(name) ?? 'Browser';
    for (let number = 1; ; number += 1) {
      const suffix = number === 1 ? '' : ` ${number}`;
      const candidate = base.slice(0, 60 - suffix.length) + suffix;
      if (!this.nameTaken(candidate, exceptId)) return candidate;
    }
  }

  // A name typed in the settings page must not be another screen's, or flow cards couldn't tell them apart.
  freeName(name, exceptId) {
    const clean = cleanName(name);
    if (clean == null) throw new Error('Give the screen a name.');
    if (this.nameTaken(clean, exceptId)) throw new Error(`Another screen is already called "${clean}".`);
    return clean;
  }

  // Public route: a dashboard says hello on load and after reconnecting. One that isn't known yet (paired before
  // screens existed, or set up with a typed key) is added under its browser name.
  async screenHello({ token, id, name }) {
    await this.checkKey(token);
    if (!validScreenId(id)) throw new Error('Invalid screen id.');
    // Forgotten in the Homey app: the dashboard disconnects and has to be approved again.
    if (this.isForgotten(id)) return { forgotten: true };
    let screen = this.screens()[id];
    if (screen == null) screen = this.saveScreen(id, { name: this.uniqueName(name, id) });
    else if (Date.now() - screen.lastSeen > SEEN_EVERY) screen = this.saveScreen(id, { lastSeen: Date.now() });
    // A screen that comes along while every screen shows a highlight shows it too.
    const everywhere = this.highlights.get(ALL_SCREENS);
    if (everywhere != null && !this.highlights.has(id)) {
      this.highlights.set(id, everywhere);
      this.announceHighlights();
    }
    // Every screen, for the dashboard's Settings to switch between (it hears changes through the `screens` event).
    return { name: screen.name, screens: this.listScreens() };
  }

  // Public route: a connected dashboard becomes another screen (to: its id) or a new one (to: null), called name or,
  // without one, its browser name made unique. It holds the key already, which can do far more, so this needs no
  // approval. The screen it was stays: another browser may still be it. Returns the id to keep.
  async switchScreen({ token, to, name, browser }) {
    await this.checkKey(token);
    if (to != null) {
      if (this.screens()[to] == null) throw new Error('This screen is gone.');
      return { id: to, name: this.saveScreen(to, { lastSeen: Date.now() }).name };
    }
    const id = newScreenId();
    const typed = cleanName(name);
    return { id, name: this.saveScreen(id, { name: typed == null ? this.uniqueName(browser, id) : this.freeName(typed, id) }).name };
  }

  // Public route: a connected dashboard renames its own screen (names stay unique).
  async renameOwnScreen({ token, id, name }) {
    await this.checkKey(token);
    this.renameScreen(id, { name });
    return { name: this.screens()[id].name };
  }

  // Settings page.
  listScreens() {
    return Object.entries(this.screens())
      .map(([id, screen]) => ({ id, shortId: shortId(id), ...screen }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  renameScreen(id, { name } = {}) {
    if (this.screens()[id] == null) throw new Error('This screen is gone.');
    this.saveScreen(id, { name: this.freeName(name, id) });
    return this.listScreens();
  }

  // Forgetting a screen also disconnects the browsers showing it: an open one is told now, any other when it next says
  // hello. They pair again (with a new approval) under a fresh id. The key is shared, so this is the dashboard
  // stepping back, not a revoked key.
  forgetScreen(id) {
    const screens = this.screens();
    delete screens[id];
    this.homey.settings.set('screens', screens);
    const forgotten = [...this.forgottenScreens().filter((other) => other !== id), id].slice(-MAX_FORGOTTEN);
    this.homey.settings.set('forgottenScreens', forgotten);
    this.homey.api.realtime('screen-forgotten', { id });
    this.announceScreens();
    // A browser waiting to become this screen now asks to be a new one.
    this.announcePairings();
    if (this.highlights.delete(id)) this.announceHighlights();
    return this.listScreens();
  }

  forgottenScreens() {
    return this.homey.settings.get('forgottenScreens') ?? [];
  }

  isForgotten(id) {
    return id != null && this.forgottenScreens().includes(id);
  }

  announceScreens() {
    this.homey.api.realtime('screens', this.listScreens());
  }

  // The screen argument of the flow cards: every screen first, then the named ones.
  screenChoices(query, everyone) {
    return [
      { id: ALL_SCREENS, name: everyone },
      ...this.listScreens().map((screen) => ({ id: screen.id, name: screen.name, description: `${screen.shortId} · Seen ${ago(screen.lastSeen)}` })),
    ].filter((choice) => matches(query, choice.name));
  }

  // The screen a card was set up with, or an error if it was forgotten since.
  screenArg(screen) {
    if (screen?.id == null || screen.id === ALL_SCREENS) return ALL_SCREENS;
    if (this.screens()[screen.id] == null) throw new Error(`${screen.name} is no longer a known screen. Pick the screen again.`);
    return screen.id;
  }

  screenLabel(target) {
    return target === ALL_SCREENS ? 'All screens' : this.screens()[target]?.name ?? 'A screen';
  }

  // ----- Show a dashboard (flow card) -----

  // A one-off nudge, not kept: a browser that isn't connected right now just doesn't switch.
  initShowDashboardCard() {
    const card = this.homey.flow.getActionCard('show_dashboard');
    card.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    card.registerArgumentAutocompleteListener('dashboard', (query) => this.dashboardChoices(query));
    card.registerRunListener(async ({ screen, dashboard }) => {
      const screenId = this.screenArg(screen);
      const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard');
      if (dashboards[dashboard.id] == null) throw new Error(`${dashboard.name} no longer exists. Pick the dashboard again.`);
      this.log(`Show dashboard ${dashboards[dashboard.id].name} on ${this.screenLabel(screenId)}`);
      // The dashboards listen for this on homey:app:<app id>.
      this.homey.api.realtime('show-dashboard', { dashboardId: dashboard.id, screenId });
    });
  }

  // ----- Widget highlight (flow cards; the screens show it) -----

  // Each screen shows at most one highlight: screen id → { id, target, dashboardId, widgetId, name, dashboardName,
  // size }. One for all screens is the same object on every screen, and also kept under 'all' for browsers without a
  // lasting id. Closing a highlight closes it on every screen showing it. Kept in memory only; after a restart nothing
  // is highlighted, and the dashboards close it when they reconnect.
  initHighlightCards() {
    this.highlights = new Map();
    this.highlightTimers = new Map(); // highlight id → timer
    this.highlightClosed = this.homey.flow.getTriggerCard('highlight_closed');

    const highlightCard = this.homey.flow.getActionCard('highlight_widget');
    highlightCard.registerRunListener((args) => this.openHighlight(args));
    highlightCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    highlightCard.registerArgumentAutocompleteListener('dashboard', (query) => this.dashboardChoices(query));
    // Homey hands over the card's other arguments, so the list holds the widgets of the dashboard picked first.
    highlightCard.registerArgumentAutocompleteListener('widget', (query, args) => this.widgetChoices(query, args?.dashboard?.id));

    const closeCard = this.homey.flow.getActionCard('close_highlight');
    closeCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    closeCard.registerRunListener(({ screen }) => {
      const target = this.screenArg(screen);
      const ids = target === ALL_SCREENS ? [...this.highlights.values()].map((highlight) => highlight.id) : [this.highlights.get(target)?.id];
      for (const id of new Set(ids)) this.closeHighlight(id, 'flow');
    });

    const openCard = this.homey.flow.getConditionCard('highlight_open');
    openCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'Any screen'));
    openCard.registerRunListener(({ screen }) => {
      const target = this.screenArg(screen);
      return target === ALL_SCREENS ? this.highlights.size > 0 : this.highlights.has(target);
    });
  }

  async dashboardChoices(query) {
    const dashboards = Object.values(await this.getFromHomey('/api/manager/dashboards/dashboard'));
    return dashboards
      .filter((dashboard) => matches(query, dashboard.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((dashboard) => ({ id: dashboard.id, name: dashboard.name }));
  }

  // Named by its title, else the device or zone it shows, else its kind. Without a dashboard picked, all of them.
  async widgetChoices(query, dashboardId) {
    const [dashboards, devices, zones] = await Promise.all([
      this.getFromHomey('/api/manager/dashboards/dashboard'),
      this.getFromHomey('/api/manager/devices/device').catch(() => ({})),
      this.getFromHomey('/api/manager/zones/zone').catch(() => ({})),
    ]);
    const shown = dashboards[dashboardId] ? [dashboards[dashboardId]] : Object.values(dashboards);
    return shown
      .flatMap((dashboard) => (dashboard.columns ?? []).flatMap((column, index) => column.widgets.map((widget) => {
        const kind = WIDGET_TYPES[widget.type] ?? widget.type;
        const data = widget.data ?? {};
        const subject = devices[data.deviceId ?? data.cameraId ?? data.lightId ?? data.speakerId]?.name ?? zones[data.zoneId]?.name;
        const name = widget.title || subject || kind;
        const where = shown.length > 1 ? `${dashboard.name}, column ${index + 1}` : `Column ${index + 1}`;
        return {
          id: widget.id,
          dashboardId: dashboard.id,
          name,
          description: name === kind ? where : `${kind} · ${where}`,
        };
      })))
      .filter((choice) => matches(query, choice.name, choice.description));
  }

  async openHighlight({ screen, dashboard, widget, size, seconds }) {
    const target = this.screenArg(screen);
    if (dashboard?.id != null && dashboard.id !== widget.dashboardId) {
      throw new Error(`${widget.name} isn't on ${dashboard.name}. Pick the widget again.`);
    }
    const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard');
    const board = dashboards[widget.dashboardId];
    const found = (board?.columns ?? []).flatMap((column) => column.widgets).find((candidate) => candidate.id === widget.id);
    if (found == null) throw new Error(`${widget.name} is no longer on its dashboard. Pick the widget again.`);

    const highlight = {
      id: crypto.randomBytes(8).toString('hex'),
      target,
      dashboardId: board.id,
      widgetId: widget.id,
      // The card keeps the name the widget had when it was picked; a title given since is the better one.
      name: found.title || widget.name,
      dashboardName: board.name,
      size: size === 'fullscreen' ? 'fullscreen' : 'large',
    };
    // A new highlight replaces what those screens showed without counting as closing it.
    const replaced = new Set([...this.highlights.values()].map((shown) => shown.id));
    if (target === ALL_SCREENS) {
      this.highlights.clear();
      for (const id of [ALL_SCREENS, ...Object.keys(this.screens())]) this.highlights.set(id, highlight);
    } else {
      this.highlights.set(target, highlight);
    }
    // The timer of a highlight no screen shows any more has nothing left to close.
    const still = new Set([...this.highlights.values()].map((shown) => shown.id));
    for (const id of replaced) {
      if (!still.has(id)) this.dropHighlightTimer(id);
    }
    if (seconds > 0) this.highlightTimers.set(highlight.id, this.homey.setTimeout(() => this.closeHighlight(highlight.id, 'timer'), seconds * 1000));
    this.log(`Highlight ${widget.name} on ${board.name} (${highlight.size}) on ${this.screenLabel(target)}`);
    this.announceHighlights();
  }

  dropHighlightTimer(id) {
    this.homey.clearTimeout(this.highlightTimers.get(id));
    this.highlightTimers.delete(id);
  }

  // Closes a highlight on every screen showing it. closedBy: 'flow', 'timer' or 'screen'.
  closeHighlight(id, closedBy) {
    const closing = [...this.highlights].filter(([, highlight]) => highlight.id === id);
    if (closing.length === 0) return;
    const [, closed] = closing[0];
    for (const [screenId] of closing) this.highlights.delete(screenId);
    this.dropHighlightTimer(id);
    this.log(`Highlight of ${closed.name} closed (${closedBy})`);
    this.announceHighlights();
    this.highlightClosed.trigger({
      widget: closed.name, dashboard: closed.dashboardName, screen: this.screenLabel(closed.target), closed_by: closedBy,
    }).catch(this.error);
  }

  // Public route: a dashboard asks on load and after reconnecting. A browser without a known screen id gets the
  // highlight for all screens.
  getHighlight(screenId) {
    const known = validScreenId(screenId) && this.screens()[screenId] != null;
    return { highlight: this.highlights.get(known ? screenId : ALL_SCREENS) ?? null };
  }

  // Public route, because a dashboard's key can't reach the app's other routes. It acts only on the highlight that
  // screen showed, not on one that replaced it meanwhile.
  async closeHighlightFromScreen({ token, id }) {
    await this.checkKey(token);
    if (id != null) this.closeHighlight(id, 'screen');
    return {};
  }

  // The dashboards listen for this on homey:app:<app id> and each picks its own.
  announceHighlights() {
    this.homey.api.realtime('highlight', { highlights: Object.fromEntries(this.highlights) });
  }
};
