# Web Dashboard for Homey

A Homey app that shows the dashboards you build in the Homey mobile app in any browser on your home network, live. Editing stays in the mobile app.

The dashboard is static files in `assets/web/`, which Homey serves at `/app/dev.schweiger.dashboard/assets/web/index.html`.
`app.js` works out that address for the settings page, keeps the API key the dashboard uses, and hands it to browsers you approve.

## Using it

1. Install the app and open its settings in the Homey app.
2. Save an API key from my.homey.app → Settings → API Keys. The settings page lists the permissions it needs; the app checks the key against your Homey before saving it.
3. Open the address shown there on a tablet (or tap **Open dashboard**). The browser shows a six-digit code and the settings page lists it under *Browsers waiting to be paired*. Approve it if the codes match; the browser then gets the key and stores it. A browser that was paired before but lost its storage can pick under *This screen is* which screen it was; the request then reads *Kitchen tablet (#3F9A) wants to reconnect*, and approving it makes the browser that screen again.

**Use an API key** on the pairing screen skips pairing and takes a key typed into that browser.

Pick the dashboard by tapping its name at the top (as in the app), with a dashboard shortcut widget, or with `?dashboard=<name or id>` in the address. Each browser remembers its choice.

**Kiosk mode** (for a wall tablet): in the dashboard's **Settings**, choose a dashboard and turn on *Always show this dashboard*. That browser then shows only that dashboard: tapping its name no longer switches, and the Settings button is gone. It keeps the screen on, and after two minutes without a touch it closes open controls and returns to that dashboard. To change it, press and hold the dashboard name: the tablet shows a code, and approving it in the app's settings in the Homey app opens Settings on the tablet. That approval hands out nothing, and after two minutes without a touch the tablet locks again. `?kiosk&dashboard=<name>` does the same for one address without storing it.

**Fit to screen width**: by default the columns keep their width and scroll sideways. Turn on *Fit to screen width* in the dashboard's **Settings** and that browser shrinks the whole dashboard until every column fits instead (it never enlarges it). `?fit` does the same for one address without storing it.

**Screens**: every browser showing the dashboard is a screen with a name, so flow cards can aim at one ("Hallway tablet"). You name a browser when you approve it (the field starts as e.g. *Safari on iPad*). The app's settings in the Homey app list all screens to rename or forget them; that list is kept on the Homey, so it survives app restarts, Homey reboots and updates. In the dashboard's **Settings**, *This screen* renames the browser's own screen, or makes the browser another screen the app knows (*Become this screen*) or a new one; the screen it leaves stays listed, with its flow cards, until you forget it in the Homey app. A browser keeps a random id in its storage, so its screen survives reloads and **Disconnect**: Disconnect only removes the key from that browser, and pairing again brings it back as the same screen. **Forget** in the Homey app removes a screen for good and breaks the flow cards aimed at it; a browser still showing it disconnects (straight away if it is open, otherwise when it next loads) and has to be approved again, as a new screen. A browser whose data was cleared (or a kiosk browser that wipes it on restart) pairs again and picks the screen it was, so flow cards aimed at that screen keep working; it can't take a screen over without that approval. Names are unique (a browser name already in use gets *2*, *3*, …), and a short id such as *#3F9A* is shown next to each screen in the settings, the flow cards and the dashboard's **Settings**. Browsers paired before screens existed, or set up with a typed key, show up under their browser name. A private window can't keep an id, so it only follows cards aimed at all screens.

**Flow cards**: put one widget or dashboard in front of everyone, or of one screen, e.g. the front-door camera on the hallway tablet when the doorbell rings. Each card's first choice is the screen: *All screens* or a named one.

- *Highlight a widget* (action): pick the screen, a dashboard, then one of its widgets, *large* or *full screen*, and optionally the seconds after which it closes. That screen (or every open one) shows it over whatever it is showing; large zooms the widget up on a card, full screen fills the window (a camera or web frame edge to edge, other widgets zoomed to fit). A screen showing that dashboard lifts its own widget, so it keeps what it was doing (a page opened in a web frame, an app widget's state); other screens show a copy. A new highlight replaces what those screens showed.
- *Close the widget highlight on …* (action), *A widget highlight is open on …* (condition; *Any screen* or one), and *The widget highlight was closed* (trigger, with the widget, its dashboard, the screen it was aimed at and who closed it: `screen`, `flow` or `timer`; not when a new highlight replaces it).
- *Show a dashboard* (action): switches that screen (or every open one) to that dashboard; behind a highlight, it shows once the highlight closes. A kiosk tablet counts it as a touch and goes back to its own dashboard after two minutes alone.

Closing a highlight on one screen (✕, Esc or a tap beside it) closes it on every screen showing it. Kiosk tablets keep it open when left alone. It is kept in memory, so an app restart closes it. Only dashboards served by the app show highlights.

**Edit mode**: **Edit** (next to Settings; not in kiosk mode) puts the dashboard in edit mode, as in the Homey app. Each widget gets a menu (•••) to move it up, down or to the next column, edit it or remove it (a second tap confirms). Moves show straight away and are saved one after the other; a failed save puts back what Homey has. Only the widgets that changed are drawn again, and moved ones keep their state where the browser can move them as they are (`moveBefore`). *Edit Widget* opens its settings, laid out like the app's: Show Title and the title, and for app widgets their devices, the settings their app declares (text, textarea, number, dropdown, checkbox, autocomplete) and how the widget runs here (see Security). Built-in widgets that show a chosen set pick it the same way (`BUILT_IN` in `js/sheets/widget-settings.js`): Devices, Batteries, Light, Lights, Speaker, Thermostat and Energy pick devices; Flows, Moods, Variables and Dashboards their own. A note picks its colour, and a line chart its Insights log (by zone, device or Homey's own sources), its time span (stored as `scale` and `resolution`) and Force Dark Mode (`darkMode`). A Timeline picks its categories under *Show only…* (Homey's notification owners; those switched off are stored as `excluded`), and the board leaves them out. The Homey app defines the built-in widgets' settings itself, and these follow what it stores; the others (zone widgets, cameras, sensors, zone controls, web frames, a note's text, a light's custom name) are still changed there. Adding and replacing widgets is left to the Homey app. Editing needs a key with `homey.dashboard` (not `homey.dashboard.readonly`); without it, Edit says so.

On an iPad, *Share → Add to Home Screen* opens the dashboard without Safari's address bar. The home-screen app has its own storage, so it pairs once more.

## Developing

Plain ES modules, no build step, no dependencies. Serve the dashboard folder over HTTP (browsers don't load modules from `file://`):

```sh
npm run serve          # python3 -m http.server 8766 --directory assets/web
```

Served from anywhere but the Homey, the page asks for the Homey address too (`https://<ip-with-dashes>.homey.homeylocal.com`), or reads it from a `config.json` next to `index.html`: `{ "homeyUrl": "…", "token": "…" }`. Served by the app, it uses its own origin and ignores `config.json`.

```sh
homey app validate --level publish
homey app install      # or `homey app run` while developing
homey app publish
```

## Pairing

Routes in `api.js` (`/api/app/dev.schweiger.dashboard/…`):

| Route | Who | |
| --- | --- | --- |
| `POST /pairing` | public | a browser asks for a code (`purpose`: `pair`, or `unlock` for a kiosk tablet's settings) with `{ name, screenId }`; returns `{ id, code, expiresAt, screens }`, `screens` being the known screens as `{ name, shortId, seen, self }` (none for `unlock`) |
| `PUT /pairing/:id` | public | with its secret `id`, a waiting browser says which screen it is: `{ screen }`, a place in `screens` or `null` for a new one |
| `GET /pairing/:id` | public | the browser polls with its secret `id`: `waiting`, `declined`, `expired`, or once `{ status: 'approved', token, screenId }` (no token for `unlock`; `screenId` is the screen it is from now on) |
| `GET /pairings`, `POST /pairings/:id/approve`, `POST /pairings/:id/decline` | settings page | waiting browsers; changes are also sent as the realtime event `pairings` |
| `GET /api-key`, `PUT /api-key` | settings page | key status; `PUT` validates and stores the key (an empty key removes it) |
| `POST /screen-hello` | public | a dashboard says which screen it is: `{ token, id, name }`; acts only if Homey accepts the token, adds an unknown screen under `name`, returns `{ name, screens }` (every screen, to switch between), or `{ forgotten: true }` for a screen forgotten in the settings (the dashboard then disconnects; open ones hear the realtime event `screen-forgotten` straight away) |
| `POST /screen-switch` | public | a dashboard becomes another screen: `{ token, to, name, browser }`, `to` a screen id or `null` for a new one (called `name`, or `browser` made unique); acts only if Homey accepts the token, returns `{ id, name }` |
| `POST /screen-rename` | public | a dashboard renames its own screen: `{ token, id, name }`; acts only if Homey accepts the token, names must be unique, returns `{ name }` |
| `GET /screens`, `PUT /screens/:id`, `DELETE /screens/:id` | settings page | list, rename (`{ name }`) and forget screens; changes are also sent as the realtime event `screens`. Approving a pairing takes `{ name }` too, for a new screen; names must be unique |
| `GET /highlight?screen=<id>` | public | that screen's highlight `{ highlight: { id, target, dashboardId, widgetId, name, dashboardName, size } }` or `{ highlight: null }` (the all-screens one without a known id); changes are sent as the realtime event `highlight` with every screen's |
| `POST /highlight/close` | public | a dashboard closed a highlight: `{ token, id }`; acts only if Homey accepts the token, on every screen showing that `id` |
| `GET /widget-modes` | public | how app widgets run, by widget id: `storage` or `trusted` (missing: `sandboxed`); changes are sent as the realtime event `widget-modes` |
| `PUT /widget-modes/:id` | public | `{ token, mode }`; acts only if the token has `homey.dashboard`; drops widgets no longer on a dashboard |

Waiting browsers are kept in memory for 10 minutes, at most 10 at a time; an app restart drops them and the browsers ask for a new code. Without a saved key, `POST /pairing` refuses. Served by the app, a browser whose key Homey rejects (401) shows a code to pair again; it keeps the old key and tries it every minute, since Homey also refuses keys for a moment while it starts up. Each connected browser asks to keep its storage (`navigator.storage.persist()`), so the browser doesn't clear it when space runs low.

## Layout

```
app.js                  dashboard address, API key, pairing, widget highlight flow cards, widget modes
api.js                  app API routes for pairing, the key, the highlight and widget modes
.homeycompose/flow/     flow cards (app.json is generated from .homeycompose/)
settings/index.html     settings page: address, waiting browsers, screens, API key
assets/web/
  index.html            markup only
  css/                  tokens (light/dark), base layout, widgets, popups
  js/main.js            entry: connect, pick the dashboard, live updates, setup form
  js/pairing.js         asks the app for a code and waits for approval
  js/screen.js          this browser's lasting screen id and the name the app gives it
  js/kiosk.js           kiosk mode: fixed dashboard, screen on, idle reset, hold the name for Settings
  js/fit.js             fit to screen width: zooms the board out so all columns fit
  js/highlight.js       shows the widget a flow highlighted, large or full screen
  js/mood-orb.js        mood icons: a gradient of the colours a mood sets (the Homey web app's method)
  manifest.json, img/   Add to Home Screen
  js/render.js          renders a dashboard's columns of widgets; updates them in place after a change
  js/edit-mode.js       Edit: each widget's menu (move, edit, remove)
  js/dashboard-save.js  saves changes to a dashboard (queued, optionally shown before they're saved)
  js/widget-modes.js    how each app widget runs: sandboxed, with storage or trusted
  js/widget-storage.js  localStorage for sandboxed app widgets (loaded as srcdoc with a script in front)
  js/widgets/index.js   registry of widget types → title, data needed, mount function
  js/widgets/*.js       one module per widget type
  js/sheets/            device controls; lights / speakers / batteries / climate zone sheets; widget settings
  js/crossframe-host.js parent side of Homey's widget protocol (app widgets run in sandboxed iframes)
  js/realtime.js        socket.io live updates
  js/icons.js, js/icons/  icons (see below)
  js/…                  api client, config, data loading, devices, zones, colours, charts, DOM helpers
```

## Adding a widget type

1. Look at how the mobile app stores it: `GET /api/manager/dashboards/dashboard`.
2. Add `assets/web/js/widgets/<name>.js` exporting `mount<Name>({ widget, section, body, setTitle })`. Return a cleanup function if it subscribes to anything.
3. Register it in `assets/web/js/widgets/index.js` with the Homey collections it needs (see `DATA_SOURCES` in `data.js`). Mark it `fill: true` if it is a picture or page that should fill the screen when highlighted full screen.
4. Give it a readable name for the highlight card in `WIDGET_TYPES` in `app.js`.

## Icons and licensing

- **Device and zone icons** are loaded at runtime from the Homey's own web app (`/web/img/devices/`, `/web/img/zones/`), so the app doesn't ship them.
- **Control and sensor icons** (`assets/web/js/icons/`) are our own drawings standing in for the Homey apps' icons, which are Athom artwork not licensed for redistribution. Every stand-in is marked with a `LICENSING:` comment naming the original; search for it to see what should eventually be there. Missing icons can be requested at https://github.com/athombv/homey-vectors-public (GPL-3.0).
- Colour presets, the colour-temperature formula and the zone icon name mapping follow the Homey web app's behaviour; they're data, not artwork.

## Security

Served by the app, the dashboard shares Homey's origin with Homey's own web app and every app's widgets and settings pages. App widgets therefore run in iframes sandboxed without `allow-same-origin`, so they can't read the stored API key. Use a key with only the permissions listed in the settings page.

Every Homey address serves every app's files, so an app's own page opened on the dashboard's address would run with its storage. That's why popups a widget opens stay sandboxed (no `allow-popups-to-escape-sandbox`), and `Homey.popup()` only opens `http(s)` pages away from Homey's addresses: `homeylocal.com` isn't a public suffix, so browsers treat all its addresses as one site. For the same reason widgets can't get a real origin of their own: with `allow-same-origin`, a widget could load its app's page from the dashboard's address in a nested frame.

A sandboxed widget has no storage, which breaks widgets that cache or remember things in `localStorage`. In a widget's settings, *Runs* offers two other ways, chosen per widget and kept by the app for every browser:

- **Sandboxed with storage**: the page fetches the widget's HTML and loads it as `srcdoc`, still sandboxed, with a `<base>` for its folder and a script in front that gives it a `localStorage` this page keeps per app (256 KB each; an app's widgets share it, changes reach its other open frames) and a `sessionStorage` for the frame's lifetime. URLs built from `location.href` resolve against the widget's real address, so `Homey.getWidgetInstanceId()` works, but code that reads `location.search` or `location.pathname` itself sees `about:srcdoc`.
- **Trusted**: no sandbox, as in the Homey app. The widget can read the key every paired browser uses.

Pairing hands every approved browser the same key, so it lives in the app settings and in each browser's storage. Anyone on the network can ask for a code, but only a browser you approve gets the key, and only the browser holding the random poll id can collect it. A browser asking for a code is shown the screens' names, short ids and when they were last seen, so it can say which one it is; it never gets their ids, and saying it is a screen does nothing until you approve it. Switching or renaming screens from a dashboard needs no approval: only a browser holding the key can do it, and the key can do far more (a kiosk tablet reaches its Settings only through an approved unlock code). To sign out one browser, use **Settings → Disconnect** on the dashboard (its screen stays listed); to sign out all of them, delete the key in my.homey.app and save a new one. Never give the key `homey.app.control`: with it, a paired browser could change this app's settings and approve itself or others.

## Licence

GPL-3.0, see `LICENSE`.
