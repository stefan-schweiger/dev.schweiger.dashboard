'use strict';

// App API at /api/app/dev.schweiger.dashboard/…
// Only the routes marked "public" in app.json are reachable without signing in: three let a new browser ask for a
// code, say which screen it is while it waits and pick up the API key once its code is approved (the last two only
// with the secret id it got with its code), five let a dashboard say which screen it is, switch to another screen or
// rename its own, and read and close its widget highlight (all but reading check the dashboard's key). Everything
// else needs a signed-in Homey session with app control, which the settings page in the Homey app has.
module.exports = {
  async requestPairing({ homey, body }) {
    return homey.app.requestPairing(body ?? {});
  },

  async getPairing({ homey, params }) {
    return homey.app.getPairing(params.id);
  },

  async claimScreen({ homey, params, body }) {
    return homey.app.claimScreen(params.id, body ?? {});
  },

  async listPairings({ homey }) {
    return homey.app.listPairings();
  },

  async approvePairing({ homey, params, body }) {
    return homey.app.approvePairing(params.id, body ?? {});
  },

  async declinePairing({ homey, params }) {
    return homey.app.declinePairing(params.id);
  },

  async getApiKeyStatus({ homey }) {
    return homey.app.getApiKeyStatus();
  },

  async setApiKey({ homey, body }) {
    return homey.app.setApiKey(body?.key);
  },

  async listScreens({ homey }) {
    return homey.app.listScreens();
  },

  async renameScreen({ homey, params, body }) {
    return homey.app.renameScreen(params.id, body ?? {});
  },

  async forgetScreen({ homey, params }) {
    return homey.app.forgetScreen(params.id);
  },

  async screenHello({ homey, body }) {
    return homey.app.screenHello(body ?? {});
  },

  async switchScreen({ homey, body }) {
    return homey.app.switchScreen(body ?? {});
  },

  async renameOwnScreen({ homey, body }) {
    return homey.app.renameOwnScreen(body ?? {});
  },

  async getHighlight({ homey, query }) {
    return homey.app.getHighlight(query?.screen);
  },

  async closeHighlight({ homey, body }) {
    return homey.app.closeHighlightFromScreen(body ?? {});
  },

  async getWidgetModes({ homey }) {
    return homey.app.widgetModes();
  },

  async setWidgetMode({ homey, params, body }) {
    return homey.app.setWidgetMode(params.id, body ?? {});
  },
};
