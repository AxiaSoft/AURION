/**
 * The EA chart workspace: sessions, first-paint sizing, and language.
 *
 * Three defects, reported together, that turned out to be three different
 * kinds of mistake.
 *
 *   1. SESSIONS marked where a centre opens but never where it closes. The
 *      tint band says a session is running; it cannot be read off to a bar.
 *      A close is not "the last tinted candle" either - the last candle
 *      inside the session is the one before the one it closed on. So the
 *      close needs its own detector, mirroring the open's, including the
 *      midnight wrap that Sydney lives on and the weekend gap that would
 *      otherwise stamp four marks on a Monday.
 *
 *   2. SIZING: the resize observer was throttled leading-edge with no
 *      trailing call, so a burst of notifications ending inside the 60ms
 *      quiet window left the canvas holding its mid-flight geometry and
 *      nothing scheduled to correct it. A canvas only re-measures when it
 *      paints. Phones mount in exactly such a burst, which is why the
 *      chart came up half-size and why tapping the dock cured it -
 *      toggleDock calls redrawSoon, and mount was the one layout change
 *      that had no redrawSoon behind it.
 *
 *   3. LANGUAGE: tt() read `global.I18N`. i18n.js declares `const I18N` at
 *      the top level of a classic script, which is a global LEXICAL
 *      binding and never a property of window - so the lookup was
 *      undefined on every desk, tt() returned its English fallback every
 *      time, and ninety-odd chart.* keys already present in the packs had
 *      never been reached. This is the check that would have caught it:
 *      assert on the rendered markup in a non-English pack, not on the
 *      presence of the keys.
 *
 *     node tests/chart-desk.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const JS = (f) => fs.readFileSync(path.join(WEB, "js", f), "utf8");

const results = [];
function say(ok, msg) {
  results.push(!!ok);
  console.log((ok ? "ok   " : "FAIL ") + msg);
}

const chartsJs = JS("charts.js");
const toolsJs = JS("chart-tools.js");

/* ============================================================ sessions == */

console.log("=== market sessions ===");

/* The session helpers are plain functions with no DOM behind them, so they
   can be lifted out and exercised directly - which is the only way to state
   "London is marked on the 16:00 candle" as a fact rather than a hope. */
const sessionSrc = chartsJs.slice(
  chartsJs.indexOf("const MARKET_SESSIONS"),
  chartsJs.indexOf("function sessionLabel"),
);
const box = {};
new Function("out", sessionSrc + `
  out.MARKET_SESSIONS = MARKET_SESSIONS;
  out.sessionCovers = sessionCovers;
  out.sessionsAt = sessionsAt;
  out.sessionOpensBetween = sessionOpensBetween;
  out.sessionClosesBetween = sessionClosesBetween;
`)(box);

say(typeof box.sessionClosesBetween === "function",
  "a close has its own detector, not an inference from the band");

const ids = box.MARKET_SESSIONS.map((s) => s.id).sort().join(",");
say(ids === "london,newyork,sydney,tokyo",
  `the centres that matter are all present: ${ids}`);

/** Walk one UTC day at M15 and record what is marked on each candle. */
function walk(stepMinutes) {
  const marks = {};
  const base = Date.UTC(2026, 9, 28, 0, 0);
  let prev = new Date(base);
  for (let t = stepMinutes; t <= 24 * 60; t += stepMinutes) {
    const at = new Date(base + t * 60000);
    const o = box.sessionOpensBetween(prev, at).map((s) => s.id);
    const c = box.sessionClosesBetween(prev, at).map((s) => s.id);
    const hhmm = at.toISOString().slice(11, 16);
    if (o.length) o.forEach((id) => { marks[id + ":open"] = hhmm; });
    if (c.length) c.forEach((id) => { marks[id + ":close"] = hhmm; });
    prev = at;
  }
  return marks;
}

const m15 = walk(15);
const expected = {
  "london:open": "07:00", "london:close": "16:00",
  "newyork:open": "12:00", "newyork:close": "21:00",
  "tokyo:open": "00:00", "tokyo:close": "09:00",
  "sydney:open": "21:00", "sydney:close": "06:00",
};
for (const [k, want] of Object.entries(expected)) {
  say(m15[k] === want, `${k.replace(":", " ")} lands on the ${want} candle (got ${m15[k] || "nothing"})`);
}

/* Sydney 21->6 is the wrap. Its close at 06:00 is the one a naive
   "open <= hour < close" test silently drops. */
say(m15["sydney:close"] === "06:00" && m15["sydney:open"] === "21:00",
  "the midnight wrap is marked at both ends");

/* A coarse timeframe must not lose a transition that happened between two
   candles - on H4 a close can fall in the middle of a bar. */
const h4 = walk(240);
say(h4["london:close"] === "16:00" && h4["tokyo:close"] === "12:00",
  "on H4 a close between two candles is still found");

const weekend = [
  box.sessionOpensBetween(new Date(Date.UTC(2026, 9, 23, 21)), new Date(Date.UTC(2026, 9, 25, 21))).length,
  box.sessionClosesBetween(new Date(Date.UTC(2026, 9, 23, 21)), new Date(Date.UTC(2026, 9, 25, 21))).length,
];
say(weekend[0] === 0 && weekend[1] === 0,
  "a weekend gap is left unmarked rather than stamped with every session");

/* The session painter used to be checked here line by line - the dash
   pattern of a mark, the y of a chip, the expression that stacked the
   labels. All of it described a drawing that no longer exists: the
   sessions were tinted bands across the full height of the plot plus a
   dashed vertical and a labelled chip at every open and every close,
   and on a normal day that is eight verticals and eight chips laid over
   the price. They are now one span per centre in a reserved strip.

   Pinning the new drawing the same way would only re-make the same
   mistake, and a regex cannot show that anything reached the canvas.
   What the strip has to GUARANTEE is measured for real against a
   recording context in tests/chart-sessions.test.js: a row per centre,
   rows clear of each other, a span that starts where its centre opens
   and ends where it closes, every row named, and - the reason the strip
   is reserved out of the height rather than overlaid - not one mark
   inside the price plot.

   What is worth pinning in the source is the contract between this
   painter and the layout, because the two are written apart and a
   silent disagreement between them is exactly how the feature broke the
   first time. */
const paintFrom = chartsJs.indexOf("  paintSessions(L) {");
const paintTo = chartsJs.indexOf("paint == */", paintFrom);
const paint = chartsJs.slice(paintFrom, paintTo);
say(paintFrom > 0 && paintTo > paintFrom, "the session painter was located in the source");

say(/rows\[i\]\.t \|\| rows\[i\]\.time/.test(paint),
  "bars are read by the key norm() actually writes, `t` first");

say(/if \(!this\.sessions \|\| !L\.sessH\) return;/.test(paint) &&
    /const top = L\.sessT;/.test(paint),
  "the strip draws into the band the layout reserved for it, not over the plot");

say(/sessionStripH\(h, padT, padB\)/.test(chartsJs) &&
    /const usable = h - padT - padB - sessH;/.test(chartsJs),
  "...and that band is taken out of the usable height, so the price never shares it");

say(/this\.paintSessions\(L\);/.test(chartsJs.slice(chartsJs.indexOf("ctx.restore();", chartsJs.indexOf("this.paintLastPrice(L);")))),
  "the strip is painted outside the plot clip, which is the only place it can appear");

/* ============================================================== sizing == */

console.log("\n=== first-paint sizing ===");

const watch = toolsJs.slice(toolsJs.indexOf("function watchSize"), toolsJs.indexOf("function redrawSoon"));
say(/clearTimeout\(trailing\)/.test(watch) && /trailing = setTimeout\(/.test(watch),
  "the resize throttle has a trailing edge, so the last size in a burst is painted");
say(/if \(now - last < 60\) \{[\s\S]*?setTimeout/.test(watch),
  "a notification inside the quiet window schedules a paint instead of being dropped");

const bind = toolsJs.slice(toolsJs.indexOf("function bind(chart, ctx)"));
const watchCall = bind.indexOf("watchSize();");
say(watchCall > 0 && /redrawSoon\(\);/.test(bind.slice(watchCall, watchCall + 600)),
  "mounting the workspace runs the same repaint ladder every other layout change gets");

say(/ui\.dockOpen = narrow\(\) \? false :/.test(toolsJs),
  "on a narrow screen the chart opens as a chart - the overlay dock does not cover it");
say(!/read\(LS_DOCK, narrow\(\)/.test(toolsJs),
  "a dock opened at a desk no longer follows the trader onto a phone");

/* ============================================================ language == */

console.log("\n=== language ===");

say(!/global\.I18N\.t\(key\)/.test(toolsJs),
  "tt() no longer looks for the translator on window, where it has never been");
say(/typeof I18N !== "undefined"/.test(toolsJs),
  "tt() reads the global lexical binding that i18n.js actually creates");
say(/typeof I18N !== "undefined"/.test(chartsJs),
  "and so does the session label lookup in the engine");

/* Every row in every table the chart renders must have a key in every
   pack. The id is the key, which is what keeps "a new tool is one row in
   one table" true. */
const packs = {};
for (const lang of ["en", "fa", "ar"]) {
  packs[lang] = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
}
const tableSrc = toolsJs.slice(toolsJs.indexOf("const GROUPS"), toolsJs.indexOf("/* ====="
  + "========================================================== state == */"));
const tables = {};
new Function("out", tableSrc.replace(/\n\s*function esc[\s\S]*$/, "") + `
  out.GROUPS = GROUPS; out.CHART_TYPES = CHART_TYPES; out.TIMEFRAMES = TIMEFRAMES;
  out.INDICATOR_GROUPS = INDICATOR_GROUPS; out.INDICATOR_TEXT = INDICATOR_TEXT;
`)(tables);

const want = { grp: [], tool: [], type: [], tf: [], indgrp: [], ind: [], ind_d: [], session: [] };
tables.GROUPS.forEach((g) => { want.grp.push(g.id); g.tools.forEach((t) => want.tool.push(t.id)); });
tables.CHART_TYPES.forEach((t) => want.type.push(t.id));
tables.TIMEFRAMES.forEach((t) => want.tf.push(t.id));
tables.INDICATOR_GROUPS.forEach((g) => want.indgrp.push(g.id));
Object.keys(tables.INDICATOR_TEXT).forEach((k) => { want.ind.push(k); want.ind_d.push(k); });
box.MARKET_SESSIONS.forEach((s) => want.session.push(s.id));

for (const lang of ["en", "fa", "ar"]) {
  const chart = packs[lang].chart || {};
  const missing = [];
  for (const [kind, list] of Object.entries(want)) {
    for (const id of list) if (typeof (chart[kind] || {})[id] !== "string") missing.push(kind + "." + id);
  }
  say(missing.length === 0,
    `${lang}: every table row has a name (${missing.length ? "missing " + missing.slice(0, 5).join(", ") : "all " + Object.values(want).flat().length} )`);
}

/* The Persian and Arabic names must actually be in those scripts. A pack
   that passes the key check by copying the English through is the exact
   failure this whole ticket was about. */
for (const lang of ["fa", "ar"]) {
  const chart = packs[lang].chart;
  const latinOnly = [];
  for (const [kind, list] of Object.entries(want)) {
    for (const id of list) {
      const v = chart[kind][id];
      /* Rows that carry Latin letters are fine - "نمط XABCD" is a correct
         Arabic name. What is not fine is a row with NO Arabic-script
         content at all, because that is English copied through to make
         the key check pass. The one exception is a bare acronym that is
         written the same way in the target language; each one is listed
         here by name so adding to the list is a deliberate act. */
      const ACRONYM = { fa: ["ind.macd"], ar: [] };
      if (!/[\u0600-\u06FF]/.test(v) && !ACRONYM[lang].includes(kind + "." + id)) {
        latinOnly.push(`${kind}.${id}="${v}"`);
      }
    }
  }
  say(latinOnly.length === 0,
    `${lang}: no row was left as untranslated English (${latinOnly.slice(0, 4).join(", ") || "none"})`);
}

/* And the end of it: render the real workspace with a real pack and read
   the markup. This is the assertion that fails if tt() ever loses its way
   back to the translator again. */
if (!jsdom) {
  console.log("SKIP  rendered-markup checks (jsdom not installed)");
} else {
  const { JSDOM, VirtualConsole } = jsdom;
  const FILES = ["themes.js", "skins.js", "i18n.js", "api.js", "calendar.js",
    "chart-series.js", "charts.js", "chart-tools.js", "pnl-charts.js", "app.js"];
  const code = FILES.map((f) => JS(f)).join("\n;\n");
  const dom = new JSDOM("<!doctype html><html><body><div id=\"stage\"></div></body></html>", {
    url: "http://localhost/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  win.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  win.URL.createObjectURL = () => "blob:x";
  win.AudioContext = class {};
  win.confirm = () => true;
  win.HTMLCanvasElement.prototype.getContext = () => null;
  win.eval(code + ";window.__T={I18N,AurionChartUI};");
  const T = win.__T;
  const U = T.AurionChartUI;

  for (const lang of ["en", "fa"]) {
    T.I18N.pack = packs[lang];
    const html = U.html({ symbol: "EURUSD", timeframe: "M15" });
    const rail = [...html.matchAll(/class="tvr-name">([^<]+)</g)].map((m) => m[1]);
    const persian = rail.filter((n) => /[\u0600-\u06FF]/.test(n)).length;
    if (lang === "en") {
      say(rail.length > 0 && persian === 0, `en: the rail renders in English (${rail[0]})`);
    } else {
      say(rail.length > 0 && persian === rail.length,
        `fa: every rail group renders in Persian (${rail.slice(0, 3).join(", ")})`);
    }
    say(U.nameOf("tool", U.TOOL_BY_ID.pitchfork) !== (lang === "fa" ? "Andrew's pitchfork" : ""),
      `${lang}: a tool name follows the desk (${U.nameOf("tool", U.TOOL_BY_ID.pitchfork)})`);
    say(/[\u0600-\u06FF]/.test(U.indicatorText("rsi")[1]) === (lang === "fa"),
      `${lang}: indicator descriptions follow the desk too`);
  }

  /* The fallback has to survive a pack that does not know a key, because
     that is the situation on a desk whose language file predates a new
     tool. It must show the English term, never "chart.tool.whatever". */
  T.I18N.pack = { chart: {} };
  const fb = U.nameOf("tool", U.TOOL_BY_ID.pitchfork);
  say(fb === "Andrew's pitchfork", `an unknown key falls back to the English term, not the key (${fb})`);
}

const bad = results.filter((r) => !r).length;
console.log("\nchart-desk: " + (bad ? bad + " FAILED of " + results.length : results.length + " checks passed"));
process.exit(bad ? 1 : 0);
