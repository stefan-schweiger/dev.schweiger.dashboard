// A widget's settings, opened from edit mode (edit-mode.js) and laid out like the Homey app's: the widget's preview,
// Show Title and its title, what it shows (an app widget's devices; a built-in widget's devices, lights, Flows, moods,
// variables or dashboards, see BUILT_IN), the app widget's own settings as its app declares them
// (https://apps.developer.homey.app/the-basics/widgets/settings) and how it runs here (widget-modes.js). Each setting
// opens a page of its own. The ✓ saves everything to the dashboard on the Homey; closing otherwise drops the changes.
// The Homey app defines the built-in widgets' settings itself; those not described here are only changed there.

import { NO_EDIT_PERMISSION, canEditDashboards, locateWidget, updateDashboard } from '../dashboard-save.js';
import { loadData } from '../data.js';
import { deviceIcon, isClass } from '../devices.js';
import { el, maskIcon, toast } from '../dom.js';
import {
  BELL_ICON, CHECK_ICON, CHEVRON_LEFT, CHEVRON_RIGHT, CLOSE_ICON, DASHBOARD_ICON, DRAG_ICON, PENCIL_ICON, PLAY_ICON,
  PLUS_CIRCLE_ICON, SEARCH_ICON, SHIELD_ICON,
} from '../icons.js';
import { moodOrb } from '../mood-orb.js';
import { NOTE_COLORS } from '../widgets/note.js';
import { sensorStyle } from '../widgets/sensors.js';
import { state } from '../state.js';
import { WIDGET_MODES, canChooseWidgetMode, saveWidgetMode, widgetMode } from '../widget-modes.js';
import { zoneIcon, zoneOrder } from '../zones.js';

const MODES = {
  sandboxed: {
    title: 'Sandboxed',
    hint: "Runs sealed off from this page, so it can't read the API key. It has no storage, which some widgets need "
      + 'to work.',
  },
  storage: {
    title: 'Sandboxed with storage',
    hint: 'Still sealed off, with storage this page keeps for the app. Its address reads about:srcdoc, which a few '
      + "widgets don't expect.",
  },
  trusted: {
    title: 'Trusted',
    hint: 'Runs as in the Homey app, not sealed off. It can read the API key every paired browser uses, so only choose '
      + 'this for an app you trust.',
  },
};

// The collections the pages need that the dashboard may not have loaded.
async function ensureData(keys) {
  const missing = keys.filter((key) => state.data[key] == null);
  if (missing.length === 0) return;
  const { data } = await loadData(missing);
  Object.assign(state.data, data);
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const nameOf = (item) => (item?.name ?? '').trim();
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));
const toIds = (value) => (value == null ? [] : Array.isArray(value) ? [...value] : [value]);

function svgIcon(svg, className) {
  const node = el('span', className);
  node.innerHTML = svg;
  return node;
}

// Items by zone, in Homey's zone order; those in no known zone last.
function zoneGroups(items, zoneOf) {
  const zones = Object.values(state.data.zones ?? {}).filter((zone) => zone.parent == null).flatMap((zone) => zoneOrder(zone.id));
  const known = new Set(zones.map((zone) => zone.id));
  return [
    ...zones.map((zone) => ({ zone, name: zone.name, items: items.filter((item) => zoneOf(item) === zone.id) })),
    { name: 'Other', items: items.filter((item) => !known.has(zoneOf(item))) },
  ].filter((group) => group.items.length > 0).map((group) => ({ ...group, items: group.items.sort(byName) }));
}

// Flows by folder ("Parent / Child"), those outside a folder first.
function folderGroups(items) {
  const folders = state.data.flowFolders ?? {};
  const path = (id) => {
    const names = [];
    for (let folder = folders[id], depth = 0; folder && depth < 20; folder = folders[folder.parent], depth += 1) names.unshift(folder.name);
    return names.join(' / ');
  };
  const groups = new Map();
  for (const item of items) {
    const name = path(item.folder);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([name, list]) => ({ name: name || 'Flows', items: list.sort(byName) }));
}

// What widgets pick from: all items (also to name ones picked earlier), those that may be picked, how the picker
// groups them, the icon a picked one gets and whether it is on (a blue circle, as in the app).
const KINDS = {
  devices: {
    needs: ['devices', 'zones'],
    items: () => Object.values(state.data.devices ?? {}),
    groups: (items) => zoneGroups(items, (device) => device.zone),
    icon: (device, className) => deviceIcon(device, className),
    on: (device) => device.capabilitiesObj?.onoff?.value === true,
    tiles: true,
  },
  flows: {
    needs: ['flows', 'advancedFlows', 'flowFolders'],
    items: () => [...Object.values(state.data.flows ?? {}), ...Object.values(state.data.advancedFlows ?? {})],
    // Only flows a widget can start.
    choosable: (flow) => flow.triggerable === true,
    groups: folderGroups,
    icon: () => svgIcon(PLAY_ICON, 'ws-item-play'),
  },
  moods: {
    needs: ['moods', 'zones', 'devices'],
    items: () => Object.values(state.data.moods ?? {}),
    groups: (items) => zoneGroups(items, (mood) => mood.zone),
    icon: (mood) => moodOrb(mood, 34),
  },
  variables: {
    needs: ['variables'],
    items: () => Object.values(state.data.variables ?? {}),
    groups: (items) => [{ items: items.sort(byName) }],
  },
  dashboards: {
    needs: [],
    items: () => Object.values(state.dashboards),
    groups: (items) => [{ items: items.sort(byName) }],
    icon: () => svgIcon(DASHBOARD_ICON, 'ws-item-glyph'),
  },
};

const isLight = (device) => isClass(device, 'light');
const isSpeaker = (device) => isClass(device, 'speaker') || device.capabilities?.includes('speaker_playing');
const has = (...capabilities) => (device) => capabilities.some((capability) => device.capabilities?.includes(capability));

// The built-in widgets whose settings are a pick, in the form the Homey app stores them: key (in widget.data), one
// id (scalar) or a list, reorder (the widget shows them in that order), named (the app names the widget after the
// pick until it is renamed), more (the app has other settings, changed there).
const BUILT_IN = {
  devices_custom: { kind: 'devices', key: 'deviceIds', one: 'Device', many: 'Devices', reorder: true },
  batteries_devices: { kind: 'devices', key: 'deviceIds', one: 'Device', many: 'Devices', filter: has('measure_battery', 'alarm_battery') },
  light_device: { kind: 'devices', key: 'lightId', scalar: true, one: 'Light', filter: isLight, named: true },
  light_group: { kind: 'devices', key: 'lightIds', one: 'Light', many: 'Lights', filter: isLight, more: true },
  device_speaker_large: { kind: 'devices', key: 'speakerId', scalar: true, one: 'Speaker', filter: isSpeaker, named: true },
  device_speaker_small: { kind: 'devices', key: 'speakerId', scalar: true, one: 'Speaker', filter: isSpeaker, named: true },
  thermostat: { kind: 'devices', key: 'deviceId', scalar: true, one: 'Thermostat', filter: has('target_temperature'), named: true },
  energy_usage: { kind: 'devices', key: 'deviceId', scalar: true, one: 'Device', filter: has('measure_power'), named: true },
  flows_custom: { kind: 'flows', key: 'flowIds', one: 'Flow', many: 'Flows', reorder: true },
  moods_custom: { kind: 'moods', key: 'moodIds', one: 'Mood', many: 'Moods', reorder: true },
  logic_variables: { kind: 'variables', key: 'variableIds', one: 'Variable', many: 'Variables', reorder: true },
  dashboards_shortcuts: { kind: 'dashboards', key: 'dashboardIds', one: 'Dashboard', many: 'Dashboards', reorder: true },
};

// The line chart's time spans by tab, as the Homey app offers them; the tab is stored as scale, the span as resolution.
const CHART_SPANS = [
  { scale: 'hour', tab: 'H', spans: [['lastHour', 'Last Hour'], ['last6Hours', '6 Hours'], ['last24Hours', '24 Hours']] },
  { scale: 'day', tab: 'D', spans: [['today', 'Today'], ['yesterday', 'Yesterday'], ['last7Days', '7 Days'], ['last14Days', '14 Days'], ['last31Days', '31 Days']] },
  { scale: 'week', tab: 'W', spans: [['thisWeek', 'This Week'], ['lastWeek', 'Last Week']] },
  { scale: 'month', tab: 'M', spans: [['thisMonth', 'This Month'], ['lastMonth', 'Last Month']] },
  { scale: 'year', tab: 'Y', spans: [['thisYear', 'This Year'], ['lastYear', 'Last Year'], ['last2Years', '2 Years']] },
];

// Homey's own Insights logs, under System in the chart's picker, named and drawn as in the app.
const SYSTEM_LOGS = {
  'homey:manager:apps': { name: 'Apps', color: '#7a3ff2', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5 16 10H8z"/><circle cx="7.5" cy="16" r="3.5"/><rect x="13" y="12.5" width="7" height="7" rx="1.5"/></svg>' },
  'homey:manager:system': { name: 'Homey', color: '#000000', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="8.5" width="18" height="7" rx="3.5"/></svg>' },
  'homey:manager:logic': { name: 'Logic', color: '#3fae49', svg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>' },
  'homey:manager:weather': { name: 'Weather', color: '#f08a24', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>' },
};

// The Timeline's categories (Homey's notification owners) get the app's colours; apps their own icon.
const NOTIFICATION_COLORS = {
  'homey:manager:users': '#f2873a',
  'homey:manager:safety': '#e2365b',
  'homey:manager:backup': '#3b9ee8',
  'homey:manager:zigbee': '#e03a3e',
  'homey:manager:security': '#4c5867',
  'homey:manager:presence': '#b8e23c',
  'homey:manager:energy': '#4fc76f',
  'homey:manager:updates': '#c02fd0',
  'homey:manager:apps': '#7a3ff2',
  'homey:manager:flow': '#5fc33a',
  'homey:manager:devices': '#6c47e0',
};

// Built-in widgets with nothing to set but the title.
const TITLE_ONLY = {
  devices_favorites: 'It shows the devices you marked as favorite in the Homey app.',
  flows_favorites: 'It shows the Flows you marked as favorite in the Homey app.',
  moods_favorites: 'It shows the moods you marked as favorite in the Homey app.',
  weather: null,
  weather_forecast: null,
  users_avatars: null,
  batteries_device_low: null,
  energy_dynamic_prices: null,
};

// An app widget's devices: its app's own, or any; narrowed by class and capabilities, where "a|b" is either and
// "a,b" both. Kept as a list even when it is one.
function appDevicePick(definition) {
  const { type, singular, filter = {} } = definition.devices;
  const classes = filter.class ? filter.class.split('|').map((name) => name.trim()) : null;
  const capabilities = filter.capabilities ? filter.capabilities.split('|').map((group) => group.split(',').map((name) => name.trim())) : null;
  return {
    kind: 'devices',
    key: 'deviceIds',
    single: singular === true,
    reorder: singular !== true,
    one: 'Device',
    many: 'Devices',
    filter: (device) => (type === 'global' || device.ownerUri === definition.ownerUri)
      && (classes == null || classes.includes(device.class) || classes.includes(device.virtualClass))
      && (capabilities == null || capabilities.some((group) => group.every((name) => device.capabilities?.includes(name)))),
  };
}

// name: what the widget is called on the board.
export async function openWidgetSettings(dashboardId, widget, name) {
  const isApp = widget.type === 'app_webview';
  let definition = null;
  if (isApp) {
    await ensureData(['appWidgets']).catch(() => {});
    definition = state.data.appWidgets?.[widget.data?.appWidgetId] ?? null;
  }
  const appId = definition?.ownerUri?.replace(/^homey:app:/, '');
  // What the widget picks, if anything.
  const builtIn = BUILT_IN[widget.type];
  const pick = definition?.devices ? appDevicePick(definition) : (builtIn ? { ...builtIn, single: builtIn.scalar === true } : null);
  if (pick) await ensureData(KINDS[pick.kind].needs).catch(() => {});
  if (widget.type === 'insights_chart_line') await ensureData(['insightsLogs', 'devices', 'zones']).catch(() => {});
  const isTimeline = widget.type === 'notifications_timeline_large' || widget.type === 'notifications_timeline_small';
  if (isTimeline) await ensureData(['notificationOwners']).catch(() => {});

  const saved = widget.data?.settings ?? {};
  const savedPicks = toIds(pick ? widget.data?.[pick.key] : null);
  const automaticTitle = definition?.name ?? (widget.titleModified ? null : widget.title) ?? name ?? '';
  const draft = {
    titleHidden: widget.titleHidden === true,
    title: widget.title ?? '',
    settings: { ...saved },
    picks: [...savedPicks],
    // Other values a built-in widget keeps in its data (a note's colour), by key.
    data: {},
    mode: widgetMode(widget.id),
  };
  // A setting's value: what was chosen, else the app's default.
  const valueOf = (setting) => (setting.id in draft.settings ? draft.settings[setting.id] : (setting.value ?? null));
  const allSettings = () => Object.fromEntries((definition?.settings ?? []).map((setting) => [setting.id, valueOf(setting)]));

  document.querySelector('dialog.widget-settings')?.close();
  const dialog = el('dialog', 'widget-settings');
  const header = el('div', 'ws-header');
  const nav = el('button', 'sheet-close');
  nav.type = 'button';
  const title = el('h2', 'ws-title');
  const action = el('button', 'ws-action');
  action.type = 'button';
  action.innerHTML = CHECK_ICON;
  header.append(nav, title, action);
  const content = el('div', 'ws-content');
  dialog.append(header, content);

  // Pages: { title, action?, actionLabel?, render(root, page) }. The first is the widget's own; the rest open from it.
  const pages = [];
  const show = () => {
    const page = pages.at(-1);
    content.replaceChildren();
    content.scrollTop = 0;
    nav.innerHTML = pages.length > 1 ? CHEVRON_LEFT : CLOSE_ICON;
    nav.setAttribute('aria-label', pages.length > 1 ? 'Back' : 'Close');
    title.textContent = page.title;
    action.hidden = page.action == null;
    action.setAttribute('aria-label', page.actionLabel ?? 'Save');
    page.render(content, page);
  };
  const open = (page) => {
    pages.push(page);
    show();
  };
  const back = () => {
    pages.pop();
    show();
  };
  nav.addEventListener('click', () => (pages.length > 1 ? back() : dialog.close()));
  action.addEventListener('click', () => pages.at(-1).action?.());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());

  // ----- Building blocks -----

  const section = (root, heading) => {
    if (heading) root.append(el('h3', 'ws-section', heading));
    const group = el('div', 'ws-group');
    root.append(group);
    return group;
  };
  const hint = (root, text) => {
    if (text) root.append(el('p', 'ws-hint', text));
  };
  const rowButton = (group, label, value, onClick) => {
    const row = el('button', 'ws-row');
    row.type = 'button';
    row.append(el('span', 'ws-label', label), el('span', 'ws-value', value ?? ''));
    row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
    row.addEventListener('click', onClick);
    group.append(row);
    return row;
  };
  const switchRow = (group, label, checked, onChange) => {
    const row = el('div', 'ws-row');
    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(checked));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(next));
      onChange(next);
    });
    row.append(el('span', 'ws-label', label), toggle);
    group.append(row);
    return row;
  };

  // ----- The widget's own page -----

  const shownValue = (setting) => {
    const value = valueOf(setting);
    switch (setting.type) {
      case 'checkbox': return value ? 'Yes' : 'No';
      case 'dropdown': return setting.values?.find((choice) => choice.id === value)?.title ?? '';
      case 'autocomplete': return value?.name ?? 'None';
      case 'number': return value == null || value === '' ? '' : `${value}${setting.units ? ` ${setting.units}` : ''}`;
      default: return value == null ? '' : String(value);
    }
  };

  const renderTitleRows = (group) => {
    switchRow(group, 'Show Title', !draft.titleHidden, (on) => {
      draft.titleHidden = !on;
      show();
    });
    if (draft.titleHidden) return;
    // The title is edited in place, like in the app.
    const row = el('div', 'ws-row');
    const edit = el('button', 'ws-title-edit');
    edit.type = 'button';
    edit.append(el('span', 'ws-value', draft.title || automaticTitle));
    edit.insertAdjacentHTML('beforeend', PENCIL_ICON);
    edit.setAttribute('aria-label', 'Rename');
    edit.addEventListener('click', () => {
      const input = el('input', 'ws-inline-input');
      input.value = draft.title || automaticTitle;
      input.setAttribute('aria-label', 'Title');
      // Enter redraws the page, which takes the input away and so blurs it: only the first of the two counts.
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        if (keep) draft.title = input.value.trim();
        show();
      };
      const commit = () => finish(true);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', commit);
      edit.replaceWith(input);
      input.focus();
      input.select();
    });
    row.append(el('span', 'ws-label', 'Title'), edit);
    group.append(row);
  };

  // What the widget shows: a row per pick (dragged into order where the widget keeps it), or for one pick a row that
  // opens the picker, as in the app.
  const iconFor = (kind, item) => {
    if (kind.icon == null) return null;
    const circle = el('span', 'ws-item-icon');
    if (item) circle.append(kind.icon(item, 'ws-item-glyph'));
    if (item && kind.on?.(item)) circle.classList.add('is-on');
    return circle;
  };
  const renderPicks = (group) => {
    const kind = KINDS[pick.kind];
    const known = new Map(kind.items().map((item) => [item.id, item]));
    const unknown = `Unknown ${pick.one.toLowerCase()}`;
    if (pick.single && draft.picks.length > 0) {
      const item = known.get(draft.picks[0]);
      const row = el('button', 'ws-row ws-item');
      row.type = 'button';
      const icon = iconFor(kind, item);
      if (icon) row.append(icon);
      row.append(el('span', 'ws-label', item ? nameOf(item) : unknown));
      row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
      row.addEventListener('click', () => open(pickerPage()));
      group.append(row);
      return;
    }
    for (const id of draft.picks) {
      const item = known.get(id);
      const row = el('div', 'ws-row ws-item');
      row.dataset.id = id;
      if (pick.reorder) {
        const handle = el('span', 'ws-drag');
        handle.innerHTML = DRAG_ICON;
        handle.setAttribute('aria-hidden', 'true');
        row.append(handle);
        dragToReorder(group, row, handle);
      }
      const icon = iconFor(kind, item);
      if (icon) row.append(icon);
      const remove = el('button', 'ws-remove');
      remove.type = 'button';
      remove.innerHTML = CLOSE_ICON;
      remove.setAttribute('aria-label', `Remove ${item ? nameOf(item) : unknown}`);
      remove.addEventListener('click', () => {
        draft.picks = draft.picks.filter((other) => other !== id);
        show();
      });
      row.append(el('span', 'ws-label', item ? nameOf(item) : unknown), remove);
      group.append(row);
    }
    const add = el('button', 'ws-row ws-add');
    add.type = 'button';
    add.innerHTML = PLUS_CIRCLE_ICON;
    add.append(el('span', null, `Select ${pick.single ? pick.one : pick.many}`));
    add.addEventListener('click', () => open(pickerPage()));
    group.append(add);
  };

  // Rows follow the pointer while the handle is held; the order is taken when it is let go. Followed on the document:
  // moving the row in the page ends a pointer capture on its handle.
  const dragToReorder = (group, row, handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      row.classList.add('is-dragging');
      const follow = (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const others = [...group.querySelectorAll('.ws-item')].filter((other) => other !== row);
        const before = others.find((other) => {
          const box = other.getBoundingClientRect();
          return moveEvent.clientY < box.top + box.height / 2;
        }) ?? group.querySelector('.ws-add');
        if (row.nextSibling !== before) group.insertBefore(row, before);
      };
      const release = (upEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        document.removeEventListener('pointermove', follow);
        document.removeEventListener('pointerup', release);
        document.removeEventListener('pointercancel', release);
        row.classList.remove('is-dragging');
        draft.picks = [...group.querySelectorAll('.ws-item')].map((other) => other.dataset.id);
      };
      document.addEventListener('pointermove', follow);
      document.addEventListener('pointerup', release);
      document.addEventListener('pointercancel', release);
    });
  };

  const renderMain = (root) => {
    if (!canEditDashboards()) root.append(el('p', 'ws-banner', NO_EDIT_PERMISSION));
    if (definition) {
      const preview = el('div', 'ws-preview');
      const image = el('img');
      image.alt = '';
      image.src = `${state.client.base}/app/${encodeURIComponent(appId)}/widgets/${encodeURIComponent(definition.ownerId)}/preview-dark.png`;
      image.addEventListener('error', () => preview.classList.add('is-empty'));
      preview.append(image);
      root.append(preview);
    }
    renderTitleRows(section(root, 'Settings'));
    if (widget.type === 'device_camera_live') {
      const group = section(root, 'Appearance');
      switchRow(group, 'Clean camera card', widget.data?.clean === true, (on) => {
        draft.data.clean = on;
      });
      hint(root, 'When video is live, hides the camera name and Live label while keeping the full-screen control.');
    }
    if (isApp && definition == null) {
      hint(root, "The app for this widget isn't running, so its own settings can't be changed now.");
    } else if (widget.type in TITLE_ONLY) {
      hint(root, TITLE_ONLY[widget.type]);
    } else if (widget.type === 'note') {
      hint(root, 'Its text is written in the Homey app.');
    } else if (widget.type === 'insights_chart_line' || isTimeline) {
      // All its settings are here.
    } else if (!isApp && (builtIn == null || builtIn.more)) {
      hint(root, "This widget's other settings can be changed in the Homey app.");
    }
    if (pick) renderPicks(section(root, pick.single ? pick.one : pick.many));
    if (widget.type === 'note') renderNoteColors(section(root, 'Color'));
    if (widget.type === 'insights_chart_line') renderChart(root);
    if (isTimeline) renderTimeline(section(root));
    if (definition?.settings?.length) {
      const group = section(root, 'Custom');
      for (const setting of definition.settings) {
        rowButton(group, setting.title, shownValue(setting), () => open(settingPage(setting)));
      }
    }
    if (definition && canChooseWidgetMode()) {
      const group = section(root, 'Web dashboard');
      rowButton(group, 'Runs', MODES[draft.mode].title, () => open(modePage()));
    }
  };

  // ----- A page per setting -----

  const set = (setting, value) => {
    draft.settings[setting.id] = value;
  };

  const settingPage = (setting) => {
    const units = setting.type === 'number' && setting.units && !setting.title.includes(`(${setting.units})`)
      ? ` (${setting.units})` : '';
    return {
      title: `${setting.title.trim()}${units}`,
      render: (root) => {
        if (SETTING_PAGES[setting.type]) SETTING_PAGES[setting.type](root, setting);
        else hint(root, `Settings of the type "${setting.type}" can only be changed in the Homey app.`);
      },
    };
  };

  const textInput = (root, setting, multiline) => {
    const group = section(root);
    const input = el(multiline ? 'textarea' : 'input', 'ws-input');
    input.value = valueOf(setting) ?? '';
    if (setting.placeholder) input.placeholder = setting.placeholder;
    input.setAttribute('aria-label', setting.title);
    const pattern = setting.pattern ? new RegExp(`^(?:${setting.pattern})$`) : null;
    input.addEventListener('input', () => {
      const valid = pattern == null || input.value === '' || pattern.test(input.value);
      input.toggleAttribute('aria-invalid', !valid);
      if (valid) set(setting, input.value === '' ? null : input.value);
    });
    group.append(input);
    hint(root, setting.hint);
    input.focus();
    input.select?.();
  };

  const SETTING_PAGES = {
    dropdown: (root, setting) => {
      const group = section(root);
      for (const choice of setting.values ?? []) {
        const row = el('button', 'ws-row ws-choice');
        row.type = 'button';
        row.append(el('span', 'ws-label', choice.title));
        if (choice.id === valueOf(setting)) row.insertAdjacentHTML('beforeend', CHECK_ICON);
        row.setAttribute('aria-pressed', String(choice.id === valueOf(setting)));
        row.addEventListener('click', () => {
          set(setting, choice.id);
          back();
        });
        group.append(row);
      }
      hint(root, setting.hint);
    },
    checkbox: (root, setting) => {
      switchRow(section(root), setting.title.trim(), valueOf(setting) === true, (on) => set(setting, on));
      hint(root, setting.hint);
    },
    text: (root, setting) => textInput(root, setting, false),
    textarea: (root, setting) => textInput(root, setting, true),
    number: (root, setting) => {
      const group = section(root);
      const input = el('input', 'ws-input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.step = setting.step ?? 'any';
      if (setting.min != null) input.min = setting.min;
      if (setting.max != null) input.max = setting.max;
      if (setting.placeholder) input.placeholder = setting.placeholder;
      input.value = valueOf(setting) ?? '';
      input.setAttribute('aria-label', setting.title);
      input.addEventListener('input', () => {
        const number = input.value === '' ? null : Number(input.value);
        const valid = number == null || (Number.isFinite(number) && (setting.min == null || number >= setting.min)
          && (setting.max == null || number <= setting.max));
        input.toggleAttribute('aria-invalid', !valid);
        if (valid) set(setting, number);
      });
      group.append(input);
      hint(root, setting.hint);
      input.focus();
      input.select();
    },
    autocomplete: (root, setting) => {
      const group = section(root);
      const search = el('label', 'ws-search');
      search.innerHTML = SEARCH_ICON;
      const input = el('input');
      input.type = 'search';
      input.placeholder = 'Search…';
      input.setAttribute('aria-label', `Search ${setting.title}`);
      search.append(input);
      const list = el('div', 'ws-results');
      group.append(search, list);
      hint(root, setting.hint);

      const choose = (item) => {
        set(setting, item);
        back();
      };
      const resultRow = (item) => {
        const row = el('button', 'ws-row ws-result');
        row.type = 'button';
        if (item.image) {
          const image = el('img', 'ws-result-image');
          image.alt = '';
          image.src = item.image;
          row.append(image);
        }
        row.append(el('span', 'ws-label', item.name ?? ''), el('span', 'ws-value', item.description ?? ''));
        row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
        row.addEventListener('click', () => choose(item));
        return row;
      };
      // The app's own suggestions (a "None" too, if it offers one), for what's typed and the other settings as they
      // are now.
      let latest = 0;
      const lookup = async () => {
        const request = ++latest;
        const query = new URLSearchParams({ settingId: setting.id, query: input.value, settings: JSON.stringify(allSettings()) });
        try {
          const items = await state.client.api('GET', `/api/manager/dashboards/appwidget/${encodeURIComponent(definition.id)}/autocomplete?${query}`);
          if (request !== latest) return;
          const rows = (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object').map(resultRow);
          list.replaceChildren(...(rows.length ? rows : [el('p', 'ws-hint', 'Nothing found.')]));
        } catch (error) {
          if (request !== latest) return;
          list.replaceChildren(el('p', 'ws-hint', `The app couldn't list choices: ${error.message}`));
        }
      };
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(lookup, 250);
      });
      lookup();
      input.focus();
    },
  };

  // A note's colour: a swatch per colour the app offers.
  const renderNoteColors = (group) => {
    const current = draft.data.color ?? widget.data?.color ?? 'yellow';
    const swatches = el('div', 'ws-swatches');
    for (const [color, hex] of Object.entries(NOTE_COLORS)) {
      const swatch = el('button', 'ws-swatch');
      swatch.type = 'button';
      swatch.setAttribute('aria-label', color[0].toUpperCase() + color.slice(1));
      swatch.setAttribute('aria-pressed', String(color === current));
      const paper = el('span', 'ws-swatch-paper');
      paper.style.background = hex;
      swatch.append(paper);
      swatch.addEventListener('click', () => {
        draft.data.color = color;
        show();
      });
      swatches.append(swatch);
    }
    group.append(swatches);
  };

  // ----- The line chart: dark mode, the Insights log and its time span -----

  // A value of the widget's data: as changed here, else as saved.
  const dataValue = (key) => (key in draft.data ? draft.data[key] : widget.data?.[key]);
  // Only numbers make a line, as in the app.
  const logs = () => Object.values(state.data.insightsLogs ?? {}).filter((log) => log.type === 'number');
  const deviceOf = (ownerUri) => (ownerUri.startsWith('homey:device:') ? state.data.devices?.[ownerUri.slice('homey:device:'.length)] : null);

  // A circle: a device's own icon (blue while on) or one of Homey's own sources, as in the app.
  const ownerIcon = (ownerUri) => {
    const circle = el('span', 'ws-item-icon');
    const system = SYSTEM_LOGS[ownerUri];
    const device = deviceOf(ownerUri);
    if (system) {
      circle.style.background = system.color;
      circle.append(svgIcon(system.svg, 'ws-item-glyph'));
    } else if (device) {
      circle.append(deviceIcon(device, 'ws-item-glyph'));
      if (KINDS.devices.on(device)) circle.classList.add('is-on');
    }
    return circle;
  };
  // A log: its capability's icon and colour, as on the Sensors widget.
  const logIcon = (log) => {
    const { icon, color } = sensorStyle(log.ownerId ?? '');
    const circle = el('span', 'ws-item-icon');
    circle.style.background = color;
    circle.append(maskIcon(icon, 'ws-item-glyph'));
    return circle;
  };
  const ownerName = (ownerUri) => SYSTEM_LOGS[ownerUri]?.name ?? deviceOf(ownerUri)?.name
    ?? logs().find((log) => log.ownerUri === ownerUri)?.ownerName ?? ownerUri;

  const segments = (options, current, onPick) => {
    const bar = el('div', 'ws-segments');
    for (const [value, label] of options) {
      const button = el('button', 'ws-segment', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(value === current));
      button.addEventListener('click', () => onPick(value));
      bar.append(button);
    }
    return bar;
  };

  const renderChart = (root) => {
    switchRow(section(root), 'Force Dark Mode', dataValue('darkMode') === true, (on) => {
      draft.data.darkMode = on;
    });
    const group = section(root, 'Insight');
    // Homey lists the logs under keys of its own, not their ids.
    const log = logs().find((candidate) => candidate.id === dataValue('logId'));
    const row = el('button', 'ws-row ws-log');
    row.type = 'button';
    if (log) {
      const text = el('span', 'ws-log-text');
      text.append(el('span', 'ws-log-owner', ownerName(log.ownerUri)), el('span', 'ws-log-title', log.title));
      row.append(ownerIcon(log.ownerUri), text);
    } else {
      row.append(el('span', 'ws-label', dataValue('logId') ? 'Unknown Insight' : 'Select an Insight'));
    }
    row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
    row.addEventListener('click', () => open(insightPage()));
    // The tab: as stored, else the one the span is on (charts saved before the app stored a tab).
    const resolution = dataValue('resolution') ?? 'last24Hours';
    const scale = dataValue('scale') ?? CHART_SPANS.find((tab) => tab.spans.some(([id]) => id === resolution))?.scale;
    const tab = CHART_SPANS.find((candidate) => candidate.scale === scale) ?? CHART_SPANS[0];
    // Another tab starts on its first span.
    const tabs = segments(CHART_SPANS.map((candidate) => [candidate.scale, candidate.tab]), tab.scale, (next) => {
      draft.data.scale = next;
      draft.data.resolution = CHART_SPANS.find((candidate) => candidate.scale === next).spans[0][0];
      show();
    });
    const spans = segments(tab.spans, resolution, (next) => {
      draft.data.scale = tab.scale;
      draft.data.resolution = next;
      show();
    });
    const choices = el('div', 'ws-chart-spans');
    choices.append(tabs, spans);
    group.append(row, choices);
  };

  // Choosing a log: by zone, by device or among Homey's own sources, then the log itself, which goes straight back
  // to the widget's page.
  const loggedDevices = () => [...new Set(logs().map((log) => deviceOf(log.ownerUri)).filter(Boolean))].sort(byName);
  const zonesWithLogs = (zones) => {
    const logged = loggedDevices();
    return zones.filter((zone) => {
      const below = new Set(zoneOrder(zone.id).map((candidate) => candidate.id));
      return logged.some((device) => below.has(device.zone));
    });
  };
  const navRow = (group, icon, name, page) => {
    const row = el('button', 'ws-row ws-item');
    row.type = 'button';
    row.append(icon, el('span', 'ws-label', name));
    row.insertAdjacentHTML('beforeend', CHEVRON_RIGHT);
    row.addEventListener('click', () => open(page()));
    group.append(row);
  };
  const zoneCircle = (zone) => {
    const circle = el('span', 'ws-item-icon');
    circle.append(zoneIcon(zone, true));
    return circle;
  };
  const zoneRows = (root, zones) => {
    if (zones.length === 0) return;
    const group = section(root, 'Zones');
    for (const zone of zones) navRow(group, zoneCircle(zone), zone.name, () => zonePage(zone));
  };
  const deviceRows = (root, devices) => {
    if (devices.length === 0) return;
    const group = section(root, 'Devices');
    for (const device of devices) {
      const ownerUri = `homey:device:${device.id}`;
      navRow(group, ownerIcon(ownerUri), device.name, () => logsPage(ownerUri));
    }
  };

  const insightPage = () => ({
    title: 'Select an Insight',
    render: (root) => {
      // The zones right under the home; their own zones open from there.
      const roots = new Set(Object.values(state.data.zones ?? {}).filter((zone) => zone.parent == null).map((zone) => zone.id));
      zoneRows(root, zonesWithLogs(Object.values(state.data.zones ?? {}).filter((zone) => roots.has(zone.parent))
        .sort((a, b) => (a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity) || a.name.localeCompare(b.name))));
      // Like a zone's page for the home itself: only devices in no room of their own.
      deviceRows(root, loggedDevices().filter((device) => roots.has(device.zone)));
      const owners = [...new Set(logs().map((log) => log.ownerUri))].filter((uri) => !uri.startsWith('homey:device:'))
        .sort((a, b) => ownerName(a).localeCompare(ownerName(b)));
      if (owners.length > 0) {
        const group = section(root, 'System');
        for (const uri of owners) navRow(group, ownerIcon(uri), ownerName(uri), () => logsPage(uri));
      }
      if (root.childElementCount === 0) hint(root, 'This Homey has no Insights logs.');
    },
  });

  const zonePage = (zone) => ({
    title: zone.name,
    render: (root) => {
      zoneRows(root, zonesWithLogs(Object.values(state.data.zones ?? {}).filter((candidate) => candidate.parent === zone.id)
        .sort((a, b) => (a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity) || a.name.localeCompare(b.name))));
      deviceRows(root, loggedDevices().filter((device) => device.zone === zone.id));
    },
  });

  const logsPage = (ownerUri) => ({
    title: ownerName(ownerUri),
    render: (root) => {
      const group = section(root);
      const own = logs().filter((log) => log.ownerUri === ownerUri).sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
      for (const log of own) {
        const row = el('button', 'ws-row ws-item');
        row.type = 'button';
        row.append(logIcon(log), el('span', 'ws-label', log.title ?? log.id));
        if (log.id === dataValue('logId')) row.insertAdjacentHTML('beforeend', CHECK_ICON);
        row.addEventListener('click', () => {
          draft.data.logId = log.id;
          pages.splice(1);
          show();
        });
        group.append(row);
      }
    },
  });

  // ----- The Timeline: the categories it shows -----

  // In the API's order, as the app lists them.
  const owners = () => Object.entries(state.data.notificationOwners ?? {})
    .map(([uri, owner]) => ({ uri, name: owner.uriObj?.name ?? owner.name ?? uri }));
  const excludedNow = () => dataValue('excluded') ?? [];

  const renderTimeline = (group) => {
    const all = owners();
    const off = new Set(excludedNow());
    const on = all.filter((owner) => !off.has(owner.uri)).length;
    const value = off.size === 0 || all.length === 0 ? 'All Categories' : `${on} ${on === 1 ? 'Category' : 'Categories'}`;
    rowButton(group, 'Show only…', value, () => open(categoriesPage()));
  };

  const ownerCircle = (uri) => {
    const circle = el('span', 'ws-item-icon');
    if (uri.startsWith('homey:app:')) {
      circle.classList.add('is-app');
      circle.append(maskIcon(`${state.client.base}/app/${encodeURIComponent(uri.slice('homey:app:'.length))}/assets/icon.svg`, 'ws-item-glyph'));
    } else {
      circle.style.background = NOTIFICATION_COLORS[uri] ?? '#3a3b45';
      circle.append(svgIcon(uri === 'homey:manager:security' ? SHIELD_ICON : BELL_ICON, 'ws-item-glyph'));
    }
    return circle;
  };

  const categoriesPage = () => ({
    title: 'Show only…',
    render: (root) => {
      const group = section(root);
      for (const owner of owners()) {
        const row = switchRow(group, owner.name, !excludedNow().includes(owner.uri), (on) => {
          // Kept in the API's order; all on is an empty list, as the app stores it.
          const off = new Set(excludedNow());
          if (on) off.delete(owner.uri);
          else off.add(owner.uri);
          draft.data.excluded = owners().map((candidate) => candidate.uri).filter((uri) => off.has(uri));
        });
        row.prepend(ownerCircle(owner.uri));
      }
      if (group.childElementCount === 0) hint(root, "The categories couldn't be loaded.");
    },
  });

  // ----- Picking -----

  // The pick's choices, grouped (zones, Flow folders) and searchable; devices as tiles, the rest as rows. The ✓ takes
  // the choice: kept picks stay in their order, new ones go at the end.
  const pickerPage = () => {
    const kind = KINDS[pick.kind];
    const chosen = new Set(draft.picks);
    let query = '';
    return {
      title: '',
      actionLabel: 'Done',
      action: () => {
        draft.picks = [...draft.picks.filter((id) => chosen.has(id)), ...[...chosen].filter((id) => !draft.picks.includes(id))];
        back();
      },
      render: (root) => {
        const heading = el('h2', 'ws-picker-title');
        const lead = el('p', 'ws-picker-lead', pick.single
          ? `The selected ${pick.one.toLowerCase()} appears in your widget.`
          : `Selected ${pick.many.toLowerCase()} appear in your widget.`);
        const search = el('label', 'ws-search');
        search.innerHTML = SEARCH_ICON;
        const input = el('input');
        input.type = 'search';
        input.placeholder = 'Search…';
        input.value = query;
        input.setAttribute('aria-label', `Search ${(pick.many ?? pick.one).toLowerCase()}`);
        search.append(input);
        const groups = el('div', 'ws-zones');
        root.append(heading, lead, search, groups);

        const items = kind.items().filter((item) => (kind.choosable?.(item) ?? true) && (pick.filter?.(item) ?? true));
        const choice = (item) => {
          const button = el('button', `${kind.tiles ? 'ws-tile' : 'ws-row ws-pick'}${pick.single ? ' is-single' : ''}`);
          button.type = 'button';
          button.setAttribute('aria-pressed', String(chosen.has(item.id)));
          const box = el('span', 'ws-check');
          box.innerHTML = CHECK_ICON;
          if (kind.tiles) {
            button.append(kind.icon(item, 'ws-tile-icon'), box, el('span', 'ws-tile-name', nameOf(item)));
          } else {
            const icon = iconFor(kind, item);
            if (icon) button.append(icon);
            button.append(el('span', 'ws-label', nameOf(item)), box);
          }
          button.addEventListener('click', () => {
            if (chosen.has(item.id)) chosen.delete(item.id);
            else {
              if (pick.single) chosen.clear();
              chosen.add(item.id);
            }
            draw();
          });
          return button;
        };
        const draw = () => {
          groups.replaceChildren();
          const needle = query.trim().toLowerCase();
          const shown = items.filter((item) => !needle || nameOf(item).toLowerCase().includes(needle));
          for (const group of kind.groups(shown)) {
            const head = el('div', 'ws-zone');
            if (group.zone) head.append(zoneIcon(group.zone, true));
            head.append(el('span', 'ws-zone-name', group.name ?? ''));
            if (!pick.single) {
              const all = el('button', 'ws-select-all', 'Select All');
              all.type = 'button';
              all.addEventListener('click', () => {
                const every = group.items.every((item) => chosen.has(item.id));
                for (const item of group.items) {
                  if (every) chosen.delete(item.id);
                  else chosen.add(item.id);
                }
                draw();
              });
              head.append(all);
            }
            if (group.name != null || !pick.single) groups.append(head);
            const list = el('div', kind.tiles ? 'ws-tiles' : 'ws-group');
            list.append(...group.items.map(choice));
            groups.append(list);
          }
          if (groups.childElementCount === 0) {
            groups.append(el('p', 'ws-hint', items.length ? 'Nothing matches.' : `There are no ${(pick.many ?? `${pick.one}s`).toLowerCase()} this widget can show.`));
          }
          heading.textContent = pick.single ? `Select ${pick.one}` : (chosen.size > 0 ? `${chosen.size} Selected` : `Select ${pick.many}`);
        };
        input.addEventListener('input', () => {
          query = input.value;
          draw();
        });
        draw();
      },
    };
  };

  // ----- How it runs here -----

  const modePage = () => ({
    title: 'Runs',
    render: (root) => {
      const group = section(root);
      for (const mode of WIDGET_MODES) {
        const row = el('button', 'ws-row ws-choice');
        row.type = 'button';
        row.append(el('span', 'ws-label', MODES[mode].title));
        if (mode === draft.mode) row.insertAdjacentHTML('beforeend', CHECK_ICON);
        row.setAttribute('aria-pressed', String(mode === draft.mode));
        row.addEventListener('click', () => {
          draft.mode = mode;
          show();
        });
        group.append(row);
      }
      for (const mode of WIDGET_MODES) {
        const text = el('p', mode === 'trusted' ? 'ws-hint is-warning' : 'ws-hint');
        text.append(el('strong', null, `${MODES[mode].title}: `), MODES[mode].hint);
        root.append(text);
      }
    },
  });

  // ----- Saving -----

  const save = async () => {
    const title = draft.title.trim();
    const titleChanged = draft.titleHidden !== (widget.titleHidden === true) || title !== (widget.title ?? '');
    const changed = Object.keys(draft.settings).filter((id) => !sameValue(draft.settings[id], saved[id]));
    const picksChanged = pick != null && !sameValue(draft.picks, savedPicks);
    const dataChanged = Object.keys(draft.data).filter((key) => !sameValue(draft.data[key], widget.data?.[key]));
    const modeChanged = draft.mode !== widgetMode(widget.id);
    action.disabled = true;
    try {
      if (titleChanged || changed.length > 0 || picksChanged || dataChanged.length > 0) {
        await updateDashboard(dashboardId, (columns) => {
          const target = locateWidget(columns, widget.id).widget;
          target.titleHidden = draft.titleHidden;
          if (title !== (widget.title ?? '')) {
            // Cleared, it goes back to the name it gets by itself.
            target.title = title || (definition?.name ?? null);
            target.titleModified = title !== '';
          }
          target.data ??= {};
          if (changed.length > 0) {
            target.data.settings = { ...(target.data.settings ?? {}), ...Object.fromEntries(changed.map((id) => [id, draft.settings[id]])) };
          }
          for (const key of dataChanged) target.data[key] = draft.data[key];
          if (picksChanged) {
            target.data[pick.key] = pick.scalar ? (draft.picks[0] ?? null) : draft.picks;
            // Named after what it shows, it takes the new pick's name, unless it was renamed.
            const item = KINDS[pick.kind].items().find((candidate) => candidate.id === draft.picks[0]);
            if (pick.named && item && !target.titleModified && target.title != null && title === (widget.title ?? '')) {
              target.title = nameOf(item);
            }
          }
        });
      }
      if (modeChanged) await saveWidgetMode(widget.id, draft.mode);
      dialog.close();
    } catch (error) {
      toast(error.message);
    } finally {
      action.disabled = false;
    }
  };

  document.body.append(dialog);
  open({ title: draft.title || automaticTitle, action: save, actionLabel: 'Save', render: renderMain });
  dialog.showModal();
}
