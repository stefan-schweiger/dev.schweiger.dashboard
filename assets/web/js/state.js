// Shared runtime state: config, Homey client and loaded data.

export const STORAGE_KEY = 'homey-web-dashboard';

export const params = new URLSearchParams(location.search);

export const state = {
  config: null,
  client: null,
  realtime: null,
  dashboards: {},
  dashboardId: null,
  system: {},
  me: null,
  data: {},
  dataErrors: {},
  locales: new Map(),
  screenName: null, // What the app calls this browser (screen.js).
  screens: [], // Every screen the app knows, to switch between in Settings (screen.js).
  highlighted: null, // The widget a flow highlighted (highlight.js), shown over the dashboard.
};
