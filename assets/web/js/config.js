// Connection settings: config.json next to the page, overridden by what the setup form stored.

import { STORAGE_KEY } from './state.js';

// Served by the Homey app (/app/<app id>/assets/web/), Homey is this page's own origin.
export const servedByHomey = /^\/app\/[^/]+\/assets\//.test(location.pathname);
export const APP_ID = servedByHomey ? location.pathname.split('/')[2] : null;

function readStoredConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function writeStoredConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage can be unavailable (private mode); the session still works.
  }
}

// Asks the browser to keep this page's storage (the key and the screen id) rather than clear it when space runs low.
// Firefox asks the user; other browsers decide by themselves. Needs https.
export async function keepStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Not every browser has it.
  }
}

export async function loadConfig() {
  // A config.json inside the installed app would be readable by anyone on the network, so only standalone mode reads it.
  let fileConfig = {};
  if (!servedByHomey) {
    try {
      const response = await fetch('config.json', { cache: 'no-store' });
      if (response.ok) fileConfig = await response.json();
    } catch {
      // No config.json next to the page; fall back to the setup form.
    }
  }
  const config = { ...fileConfig, ...readStoredConfig() };
  if (servedByHomey) config.homeyUrl = location.origin;
  return config;
}
