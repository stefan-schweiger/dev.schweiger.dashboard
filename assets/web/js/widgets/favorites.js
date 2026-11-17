// Devices, Flows and moods: the user's favorites, a chosen set (…_custom) or a zone's (devices_zone, moods_zone).

import { lightHex, lightMode } from '../color.js';
import { requireData } from '../data.js';
import { deviceIcon, deviceStatus, isClass, lockState, quickActionCapability, setCapability, watchDevice } from '../devices.js';
import { el, note, pulse, toast } from '../dom.js';
import { PLAY_ICON, POWER_ICON } from '../icons.js';
import { openDeviceSheet, sheetComponents } from '../sheets/device-sheet.js';
import { moodOrb } from '../mood-orb.js';
import { state } from '../state.js';

// The items with these ids, in this order, skipping ones that no longer exist.
function pick(ids, ...collections) {
  return (ids ?? [])
    .map((id) => collections.map((collection) => collection?.[id]).find(Boolean))
    .filter(Boolean);
}

const favorites = (key, ...collections) => pick(state.me?.properties?.[key], ...collections);

export function mountFavoriteDevices({ body, widget }) {
  if (!requireData(body, 'devices')) return;
  const devices = favorites('favoriteDevices', state.data.devices);
  if (devices.length === 0) return note(body, 'No favorite devices.');
  return renderDeviceGrid(body, devices, widget);
}

export function mountCustomDevices({ body, widget }) {
  if (!requireData(body, 'devices')) return;
  const devices = pick(widget.data?.deviceIds, state.data.devices);
  if (devices.length === 0) return note(body, 'These devices no longer exist.');
  return renderDeviceGrid(body, devices, widget);
}

export function renderDeviceGrid(body, devices, widget) {
  const grid = el('div', 'device-grid');
  grid.dataset.tileSize = widget.data?.tileSize ?? 'medium';
  body.append(grid);
  const cleanups = [];

  for (const device of devices) {
    // Lights show yellow (or their colour) when on, with a dot before their status; other devices blue, without.
    const tile = el('div', isClass(device, 'light') ? 'device-tile is-light' : 'device-tile');
    const icon = deviceIcon(device, 'device-icon');
    const name = el('span', 'device-name', device.name);
    name.title = device.name;
    const status = el('span', 'device-status');
    tile.append(icon, name, status);

    let power = null;
    if (quickActionCapability(device)) {
      power = el('button', 'power');
      power.type = 'button';
      power.innerHTML = POWER_ICON;
      tile.append(power);
      power.addEventListener('click', () => {
        const quick = quickActionCapability(device);
        if (quick == null || device.available === false) return;
        pulse(power);
        setCapability(device, device.ui.quickAction, !quick.value, update);
      });
    } else {
      tile.classList.add('is-filled');
    }

    // Tapping the tile (not its power button) opens the device controls, like in the app.
    if (sheetComponents(device).length > 0) {
      tile.classList.add('is-openable');
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', `${device.name} controls`);
      tile.addEventListener('click', (event) => {
        if (!event.target.closest('.power')) openDeviceSheet(device);
      });
      tile.addEventListener('keydown', (event) => {
        if (event.target !== tile || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openDeviceSheet(device);
      });
    }

    function update() {
      const quick = quickActionCapability(device);
      tile.classList.toggle('is-on', quick?.value === true);
      // A light tints its dot and power button with its colour, or with its white's colour; others keep the yellow.
      const tint = lightHex(device, lightMode(device));
      if (tint) tile.style.setProperty('--tile-active', tint);
      else tile.style.removeProperty('--tile-active');
      tile.classList.toggle('is-unavailable', device.available === false);
      // A lock's state gets a padlock, closed or open, before it.
      const lock = device.available === false ? null : lockState(device);
      tile.classList.toggle('is-locked', lock === 'locked');
      tile.classList.toggle('is-unlocked', lock === 'unlocked');
      status.textContent = deviceStatus(device);
      if (power) {
        power.disabled = device.available === false;
        power.setAttribute('aria-label', `${quick?.value ? 'Turn off' : 'Turn on'} ${device.name}`);
      }
    }
    update();

    cleanups.push(watchDevice(device, update));
    grid.append(tile);
  }

  return () => cleanups.forEach((cleanup) => cleanup());
}

function actionButton(parent, { className, name, enabled, run, leading, text }) {
  const button = el('button', `action ${className}`);
  button.type = 'button';
  button.disabled = !enabled;
  button.append(leading, text ?? el('span', 'action-name', name));
  button.title = name;
  button.addEventListener('click', async () => {
    pulse(button);
    button.classList.add('is-busy');
    try {
      await run();
      button.classList.add('is-done');
      setTimeout(() => button.classList.remove('is-done'), 1200);
    } catch (error) {
      toast(`${name}: ${error.message}`);
    } finally {
      button.classList.remove('is-busy');
    }
  });
  parent.append(button);
}

export function mountFavoriteFlows({ body }) {
  if (!requireData(body, 'flows', 'advancedFlows')) return;
  const items = favorites('favoriteFlows', state.data.flows, state.data.advancedFlows);
  if (items.length === 0) return note(body, 'No favorite flows.');
  renderFlowPills(body, items);
}

export function mountCustomFlows({ body, widget }) {
  if (!requireData(body, 'flows', 'advancedFlows')) return;
  const items = pick(widget.data?.flowIds, state.data.flows, state.data.advancedFlows);
  if (items.length === 0) return note(body, 'These flows no longer exist.');
  renderFlowPills(body, items);
}

function renderFlowPills(body, items) {
  const { advancedFlows } = state.data;
  const grid = el('div', 'pair-grid');
  body.append(grid);
  for (const flow of items) {
    const kind = advancedFlows[flow.id] ? 'advancedflow' : 'flow';
    const play = el('span', 'play');
    play.innerHTML = PLAY_ICON;
    actionButton(grid, {
      className: 'flow-pill',
      name: flow.name,
      leading: play,
      enabled: flow.enabled !== false && flow.triggerable !== false && flow.broken !== true,
      run: () => state.client.api('POST', `/api/manager/flow/${kind}/${flow.id}/trigger`, {}),
    });
  }
}

export function mountFavoriteMoods({ body }) {
  if (!requireData(body, 'moods')) return;
  const moods = favorites('favoriteMoods', state.data.moods);
  if (moods.length === 0) return note(body, 'No favorite moods.');
  renderMoodCards(body, moods, moodZoneName);
}

export function mountCustomMoods({ body, widget }) {
  if (!requireData(body, 'moods')) return;
  const moods = pick(widget.data?.moodIds, state.data.moods);
  if (moods.length === 0) return note(body, 'These moods no longer exist.');
  renderMoodCards(body, moods, moodZoneName);
}

const moodZoneName = (mood) => state.data.zones?.[mood.zone]?.name;

// A zone's own moods say how many devices they set instead of the zone, as in the app ("8 lights").
export function moodDeviceCount(mood) {
  const devices = Object.keys(mood.devices ?? {}).map((id) => state.data.devices?.[id]).filter(Boolean);
  const lights = devices.every((device) => device.class === 'light' || device.virtualClass === 'light');
  return `${devices.length} ${lights ? (devices.length === 1 ? 'light' : 'lights') : (devices.length === 1 ? 'device' : 'devices')}`;
}

export function renderMoodCards(body, moods, subtitle) {
  const grid = el('div', 'pair-grid');
  body.append(grid);
  for (const mood of moods) {
    const text = el('span', 'mood-text');
    text.append(el('span', 'action-name', mood.name));
    const sub = subtitle(mood);
    if (sub) text.append(el('span', 'mood-zone', sub));
    actionButton(grid, {
      className: 'mood-card',
      name: mood.name,
      leading: moodOrb(mood),
      text,
      enabled: true,
      run: () => state.client.api('POST', `/api/manager/moods/mood/${mood.id}/set`, {}),
    });
  }
}
