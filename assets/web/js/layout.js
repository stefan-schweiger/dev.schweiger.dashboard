// Layout preferences stay in this browser, like Fit to screen width.

import { STORAGE_KEY } from './state.js';

const WIDTH_KEY = `${STORAGE_KEY}:column-width`;
const ALIGNMENT_KEY = `${STORAGE_KEY}:column-alignment`;
const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1000;
const DEFAULT_WIDGET_HEIGHT = 100;
const MIN_WIDGET_HEIGHT = 100;
const MAX_WIDGET_HEIGHT = 150;

let columnWidth = DEFAULT_WIDTH;
let alignment = 'center';
const widgetHeights = new Map();

function readWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readAlignment() {
  try {
    return localStorage.getItem(ALIGNMENT_KEY) === 'left' ? 'left' : 'center';
  } catch {
    return 'center';
  }
}

function widgetHeightKey(widgetId) {
  return `${STORAGE_KEY}:widget-height:${widgetId}`;
}

export function getWidgetHeight(widgetId) {
  if (widgetHeights.has(widgetId)) return widgetHeights.get(widgetId);
  try {
    const value = Number(localStorage.getItem(widgetHeightKey(widgetId)));
    return Number.isFinite(value) && value >= MIN_WIDGET_HEIGHT && value <= MAX_WIDGET_HEIGHT
      ? value : DEFAULT_WIDGET_HEIGHT;
  } catch {
    return DEFAULT_WIDGET_HEIGHT;
  }
}

function apply() {
  document.documentElement.style.setProperty('--dashboard-column-width', `${columnWidth}px`);
  document.documentElement.classList.toggle('align-left', alignment === 'left');
}

export function initLayout() {
  columnWidth = readWidth();
  alignment = readAlignment();
  apply();
}

export function getLayout() {
  return { columnWidth, alignment };
}

export function setColumnWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return;
  columnWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  apply();
  try {
    localStorage.setItem(WIDTH_KEY, String(columnWidth));
  } catch {
    // The preference remains active until this page closes if storage is unavailable.
  }
}

export function setColumnAlignment(value) {
  alignment = value === 'left' ? 'left' : 'center';
  apply();
  try {
    localStorage.setItem(ALIGNMENT_KEY, alignment);
  } catch {
    // The preference remains active until this page closes if storage is unavailable.
  }
}

export function setWidgetHeight(widgetId, value) {
  const height = Number(value);
  if (!Number.isFinite(height)) return;
  const clamped = Math.min(MAX_WIDGET_HEIGHT, Math.max(MIN_WIDGET_HEIGHT, height));
  widgetHeights.set(widgetId, clamped);
  try {
    const key = widgetHeightKey(widgetId);
    if (clamped === DEFAULT_WIDGET_HEIGHT) localStorage.removeItem(key);
    else localStorage.setItem(key, String(clamped));
  } catch {
    // The preference remains active until this page closes if storage is unavailable.
  }
}
