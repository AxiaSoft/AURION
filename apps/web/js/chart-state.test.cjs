/**
 * Two things the chart was doing correctly and showing badly.
 *
 *   1. The rail's three switches - magnet, lock-all, hide-all - changed the
 *      chart and never changed themselves. The work happened; the button
 *      looked identical afterwards, so the only way to know the state was to
 *      try it and watch the candles.
 *   2. Anything that floats - the confirm dialog, the toasts, the menus -
 *      was parented to <body>. Inside an element-level fullscreen the
 *      browser paints only the fullscreen element's subtree, so "delete all
 *      drawings" opened a dialog that was not on the screen.
 *
 *     node apps/web/js/chart-state.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? " → " + cond : "")); failed++; }
}

/* ------------------------------------------------------- a small DOM -- */

function makeEl(id) {
  const classes = new Set();
  return {
    id, innerHTML: "", title: "", disabled: false, dataset: {}, attrs: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    has: (c) => classes.has(c),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    appendChild: noop, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, focus: noop, remove: noop,
    style: { setProperty: noop, removeProperty: noop },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

const nodes = new Map();
["tv-magnet", "tv-lockall", "tv-hideall", "tv-clear", "tv-status-tool", "tv-status-hint"]
  .forEach((id) => nodes.set(id, makeEl(id)));

const canvasCtx = new Proxy({}, {
  get: (t, k) => {
    if (k === "measureText") return () => ({ width: 10 });
    if (k === "createLinearGradient") return () => ({ addColorStop: noop });
    return noop;
  },
});
const canvas = {
  getContext: () => canvasCtx, width: 0, height: 0, style: {}, parentElement: null,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 500 }),
  addEventListener: noop, setPointerCapture: noop,
};

const win = {
  devicePixelRatio: 1,
  ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
  requestAnimationFrame: (fn) => fn(),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: {
    documentElement: { dataset: {}, dir: "ltr" },
    body: makeEl("body"),
    fullscreenElement: null,
    getElementById: (id) => nodes.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl("new"),
    addEventListener: noop,
  },
  addEventListener: noop,
  console,
};
win.window = win; win.globalThis = win;
vm.createContext(win);
for (const f of ["chart-series.js", "charts.js", "chart-tools.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8") +
    (f === "charts.js" ? "\n;globalThis.CandleChart = CandleChart;" : ""), win, { filename: f });
}

const UI = win.AurionChartUI;
const chart = new win.CandleChart(canvas, {});
chart.setBars(Array.from({ length: 40 }, (_, i) => {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 900000);
  return { time: at.toISOString().slice(0, 19), open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 5 };
}));
UI.state.chart = chart;

const magnet = nodes.get("tv-magnet");
const lock = nodes.get("tv-lockall");
const hide = nodes.get("tv-hideall");
const clear = nodes.get("tv-clear");

/* --------------------------------------------------------- empty chart -- */
UI.markRailState();
check("with nothing drawn, lock is disabled", lock.disabled === true);
check("with nothing drawn, hide is disabled", hide.disabled === true);
check("with nothing drawn, delete-all is disabled", clear.disabled === true);

/* ------------------------------------------------------------ drawings -- */
const pt = (i, p) => ({ t: chart.rows()[i].t, p, gi: i });
chart.addObject({ kind: "trend", a: pt(2, 1.0), b: pt(8, 1.1) });
chart.addObject({ kind: "rect", a: pt(10, 1.0), b: pt(16, 1.1) });
UI.markRailState();
check("two drawings enable the bulk buttons", lock.disabled === false && hide.disabled === false);
check("nothing is locked yet", lock.getAttribute("aria-pressed") === "false");
check("...and the icon is the open padlock", lock.innerHTML.indexOf("7.7") >= 0);

/* ---------------------------------------------------------------- lock -- */
chart.eachObject((d) => { d.locked = true; });
UI.markRailState();
check("locking every drawing lights the button", lock.has("on") === true);
check("...and says so to a reader", lock.getAttribute("aria-pressed") === "true");
check("...and the icon becomes the closed padlock", lock.innerHTML.indexOf("7.7") === -1);
check("...and the tooltip now offers to unlock",
  lock.title.toLowerCase().indexOf("unlock") >= 0);

chart.eachObject((d) => { d.locked = false; });
UI.markRailState();
check("unlocking puts it back", lock.has("on") === false && lock.getAttribute("aria-pressed") === "false");

/* ---------------------------------------------------------------- hide -- */
chart.eachObject((d) => { d.visible = false; });
UI.markRailState();
check("hiding lights the eye", hide.has("on") === true);
check("...and it becomes the struck-through eye", hide.innerHTML.indexOf("M4 4l16 16") >= 0);
chart.eachObject((d) => { d.visible = true; });
UI.markRailState();
check("showing puts it back", hide.has("on") === false);

/* -------------------------------------------------------------- magnet -- */
chart.setMagnet("off");
UI.markRailState();
check("magnet off is not lit", magnet.has("on") === false && magnet.dataset.level === "off");
chart.setMagnet("weak");
UI.markRailState();
check("a weak magnet is lit", magnet.has("on") === true);
check("...and its strength is on the button", magnet.dataset.level === "weak");
chart.setMagnet("strong");
UI.markRailState();
check("a strong magnet is marked differently", magnet.dataset.level === "strong");
check("...and the tooltip names the strength",
  magnet.title.toLowerCase().indexOf("strong") >= 0);
check("the pressed state follows", magnet.getAttribute("aria-pressed") === "true");

/* --------------------------------------------- every change repaints it -- */
chart.setMagnet("off");
chart.eachObject((d) => { d.locked = true; });   // goes through changed() → refresh()
UI.refresh();
check("a change to the objects repaints the rail without being asked",
  lock.has("on") === true && magnet.has("on") === false);

/* ------------------------------------------------------ the fullscreen -- */
/* app.js decides where a floating layer lives; the chart's menus use the
   same rule inline. Both are checked here against a fake fullscreen. */
const appEnv = {
  document: {
    documentElement: Object.assign(makeEl("html"), { dataset: {}, dir: "ltr" }),
    body: makeEl("body"),
    fullscreenElement: null,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => makeEl("x"), addEventListener: noop,
  },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  navigator: { language: "en" }, location: { href: "", protocol: "http:", host: "x" },
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  addEventListener: noop, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: noop, fetch: () => Promise.resolve({ ok: true, json: () => ({}) }),
  WebSocket: function () { this.close = noop; this.send = noop; this.addEventListener = noop; },
  MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
  Notification: function () {}, console,
};
appEnv.window = appEnv; appEnv.globalThis = appEnv; appEnv.self = appEnv;
vm.createContext(appEnv);
for (const f of ["skins.js", "themes.js", "i18n.js", "api.js", "calendar.js",
  "chart-series.js", "charts.js", "chart-tools.js"]) {
  vm.runInContext(fs.readFileSync(path.join(here, f), "utf8"), appEnv, { filename: f });
}
vm.runInContext(fs.readFileSync(path.join(here, "app.js"), "utf8") +
  "\n;globalThis.__overlayHost = overlayHost;", appEnv, { filename: "app.js" });

const body = appEnv.document.body;
check("with no fullscreen, a floating layer lives on the body",
  appEnv.__overlayHost() === body);

const stage = makeEl("full-stage");
appEnv.document.fullscreenElement = stage;
check("inside an element fullscreen, it moves into that element",
  appEnv.__overlayHost() === stage);

appEnv.document.fullscreenElement = appEnv.document.documentElement;
check("when the whole page is fullscreen, the body is right again",
  appEnv.__overlayHost() === body);

console.log(failed ? `\n${failed} failing.` : "\nThe state is on the screen.");
process.exit(failed ? 1 : 0);
