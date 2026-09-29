/**
 * The workspace interface, checked against the engine behind it.
 *
 * The rule this file enforces is the one the redesign was asked for above
 * all others: there are to be no controls that look functional and do
 * nothing. Every tool in the rail must map to a shape the engine can draw,
 * every chart type to a series it can build, every timeframe to an interval
 * the data source actually serves, and every icon to a path that exists.
 *
 *     node apps/web/js/chart-ui.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const here = __dirname;
const noop = () => {};

const win = {
  document: {
    documentElement: { dataset: {}, dir: "ltr" },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, appendChild: noop, remove: noop, querySelector: () => null }),
    addEventListener: noop,
    body: { appendChild: noop, classList: { toggle: noop } },
  },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  devicePixelRatio: 1,
  ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
  requestAnimationFrame: noop,
  addEventListener: noop,
  console,
};
win.window = win; win.globalThis = win;
vm.createContext(win);
for (const f of ["chart-series.js", "charts.js", "chart-tools.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(here, f), "utf8") +
    (f === "charts.js" ? "\n;globalThis.SHAPE_POINTS = SHAPE_POINTS;\n;globalThis.SHAPE_LABELS = SHAPE_LABELS;" : ""),
    win, { filename: f });
}

const UI = win.AurionChartUI;
const S = win.AurionSeries;
const POINTS = win.SHAPE_POINTS;

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? " → " + cond : "")); failed++; }
}

/* ------------------------------------------------------ nothing is fake -- */

const MODE_TOOLS = { cursor: 1, crosshair: 1, dotcursor: 1, eraser: 1 };
const tools = [];
UI.GROUPS.forEach((g) => g.tools.forEach((t) => tools.push(Object.assign({ group: g.id }, t))));

check("the rail offers " + tools.length + " tools", tools.length > 50);
check("every drawing tool is a shape the engine can paint",
  (() => {
    const bad = tools.filter((t) => !MODE_TOOLS[t.id] && POINTS[t.id] === undefined).map((t) => t.id);
    return bad.length ? bad.join(", ") : true;
  })());
check("every cursor-mode tool is handled by the engine",
  tools.filter((t) => t.mode).every((t) => /^crosshair:(cross|dot|none)$/.test(t.mode)));
check("every tool has an icon that exists",
  (() => {
    const bad = tools.filter((t) => !UI.ICONS[t.icon]).map((t) => t.id + ":" + t.icon);
    return bad.length ? bad.join(", ") : true;
  })());
check("every group has an icon that exists",
  UI.GROUPS.every((g) => Boolean(UI.ICONS[g.icon])));
check("no two tools share an id",
  new Set(tools.map((t) => t.id)).size === tools.length);
check("no two shortcuts collide",
  (() => {
    const keys = tools.filter((t) => t.key).map((t) => t.key);
    return new Set(keys).size === keys.length ? true : keys.join(",");
  })());
check("every chart type is one the engine builds",
  UI.CHART_TYPES.every((t) => S.SERIES_TYPES.some((s) => s.id === t.id)));
check("every series the engine builds is offered",
  S.SERIES_TYPES.every((s) => UI.CHART_TYPES.some((t) => t.id === s.id)));

/* The nine MetaTrader serves - see engine/aurion/mt5/types.py. Seconds and
   custom intervals are deliberately absent from both. */
const MT5 = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];
check("every timeframe offered exists in the data source",
  UI.TIMEFRAMES.every((t) => MT5.indexOf(t.id) >= 0));
check("every timeframe the data source has is offered",
  MT5.every((id) => UI.TIMEFRAMES.some((t) => t.id === id)));

check("every indicator has a name and a description",
  S.INDICATORS.every((d) => {
    const text = UI.INDICATOR_TEXT[d.id];
    return Array.isArray(text) && text[0] && text[1];
  }));
check("every indicator belongs to a group the picker shows",
  S.INDICATORS.every((d) => UI.INDICATOR_GROUPS.some((g) => g.id === d.group)));

/* ------------------------------------------------------------- the html -- */

const html = UI.html({ symbol: "EURUSD", timeframe: "M15", ticket: "<div id='ticket'></div>" });

function has(sub) { return html.indexOf(sub) >= 0; }

check("the workspace has a top bar, a rail, a stage and a dock",
  has('class="tv-top"') && has('id="tv-rail"') && has('class="tv-stage"') && has('id="tv-dock"'));
check("the canvas the desk expects is still called cv-desk", has('id="cv-desk"'));
check("the order ticket is carried into the dock", has("id='ticket'"));
check("every rail group is rendered",
  UI.GROUPS.every((g) => has('data-group="' + g.id + '"')));
check("the timeframe strip is rendered", has('data-tf="M15"'));
check("the four menus are present",
  ["tf", "type", "indicators", "settings"].every((m) => has('data-menu="' + m + '"')));
check("navigation controls are present",
  ["tv-zin", "tv-zout", "tv-auto", "tv-fit"].every((id) => has('id="' + id + '"')));
check("undo and redo are in the bar", has('id="tv-undo"') && has('id="tv-redo"'));
check("fullscreen is in the bar", has('id="tv-full"'));

/* ------------------------------------------------------- accessibility -- */

check("the rail is a labelled landmark", has('<nav class="tv-rail"') && has('aria-label='));
check("expandable groups say so", has('aria-haspopup="true"') && has('aria-expanded="false"'));
check("the dock tabs are tabs", has('role="tablist"') && has('role="tab"'));
check("every icon button carries a label",
  (() => {
    const buttons = html.match(/<button[^>]*>/g) || [];
    const bare = buttons.filter((b) => {
      if (b.indexOf("aria-label=") >= 0 || b.indexOf("title=") >= 0) return false;
      return true;
    });
    // Buttons with visible text need no label; those are the ones with a
    // following word character rather than an svg. Count only icon-only ones.
    const iconOnly = bare.filter((b) => /class="[^"]*(tv-icon|tvr-btn|tv-round)/.test(b));
    return iconOnly.length === 0 ? true : iconOnly.join(" | ");
  })());
check("decorative icons are hidden from the reader",
  (html.match(/<svg/g) || []).length === (html.match(/aria-hidden="true"/g) || []).length -
    (html.match(/<div id="bg-fx"/g) || []).length);

/* --------------------------------------------------------------- i18n --- */

const en = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "lang", "en.json"), "utf8"));
const used = (html.match(/tt\(/g) || []).length;
check("the chart chrome has a translation block", Boolean(en.chart) && Object.keys(en.chart).length > 40);
for (const lang of ["fa", "ar"]) {
  const pack = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "lang", lang + ".json"), "utf8"));
  const missing = Object.keys(en.chart).filter((k) => !(k in (pack.chart || {})));
  check(lang + " has every chart key", missing.length === 0 || missing.join(", "));
}

console.log(failed ? `\n${failed} failing.` : "\nThe interface matches the engine.");
process.exit(failed ? 1 : 0);
