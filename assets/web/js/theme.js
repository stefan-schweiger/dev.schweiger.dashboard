// Appearance: follow the system's light or dark mode (auto), or always use one. Picked per browser in Settings, or
// for one address with ?theme=light or ?theme=dark. tokens.css reads data-theme on <html>; a script in index.html's
// head sets it from the same storage before the first paint, so a dark tablet doesn't flash light while loading.

import { STORAGE_KEY, params } from './state.js';

const THEME_KEY = `${STORAGE_KEY}:theme`;
const THEMES = ['auto', 'light', 'dark'];

let theme = 'auto';

function readStored() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

function store() {
  try {
    if (theme !== 'auto') localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this visit.
  }
}

function apply() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function getTheme() {
  return theme;
}

export function setTheme(value) {
  theme = THEMES.includes(value) ? value : 'auto';
  store();
  apply();
}

export function initTheme() {
  const asked = params.get('theme');
  theme = THEMES.includes(asked) ? asked : readStored();
  apply();
}
