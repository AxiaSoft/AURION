/**
 * The EA chart workspace cannot be pushed sideways.
 *
 * Reported three times: "I open an EA chart on a phone, half the screen
 * is chart and half is nothing, and the rest of the controls are off the
 * screen and unreachable - until I open the side panel, and then it is
 * fine and fills the screen."
 *
 * Measured in a real browser at 390x844, the moment the chart opens:
 *
 *     .tv      390x844   scrollWidth=690   scrollLeft=-151
 *     .tv-top  x=151     .tv-body x=151    .tv-stage x=151
 *     .tv-dock x=-149    300x772
 *
 * The box is the right size. It is SCROLLED. Three facts combine:
 *
 *  1. overflow:hidden still makes a box a scroll container. It hides the
 *     scrollbars; it does not stop the box from having a scroll offset.
 *  2. At this width the side panel is parked off-canvas with
 *     translateX(-100%) (translateX(100%) on an LTR desk), and a
 *     transformed box still counts towards scrollable overflow. So .tv
 *     carried 300px of hidden scrollable width - and ~360px of hidden
 *     scrollable height from the tool sheet parked below.
 *  3. showDock() called tab.scrollIntoView() on mount to line the active
 *     tab up inside its strip. scrollIntoView scrolls EVERY scrollable
 *     ancestor, not the one it was aimed at - and {block:"nearest",
 *     inline:"nearest"} does not change that. "nearest" only means "do
 *     not scroll a container that can already see it".
 *
 * So the browser shifted the entire workspace 151px to reveal a tab
 * belonging to a panel that was not open, and with no scrollbar there
 * was no way to drag it back. Opening the panel un-parked it, the
 * overflow went away, the offset snapped to 0, and the chart "fixed
 * itself" - which is exactly what was reported.
 *
 * Both halves are fixed and either alone is sufficient; both are kept
 * because they fail differently. Verified in Chromium: reverting both
 * reproduces the bug in all 8 of RTL/LTR x portrait/large/landscape/
 * tablet, and reverting either one alone does not.
 *
 * Run: node tests/chart-mobile-layout.test.js
 * With a real browser too:
 *   AURION_CHROME=/path/to/chrome node tests/chart-mobile-layout.test.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) {
  console.log("SKIP  chart mobile layout (jsdom not installed)");
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

const results = [];
const check = (name, fn) => {
  let ok = false, note = "";
  try {
    const r = fn();
    ok = r === true || r === undefined;
    if (typeof r === "string") { ok = false; note = r; }
  } catch (e) { ok = false; note = (e && e.message) || String(e); }
  results.push(ok);
  console.log((ok ? "PASS  " : "FAIL  ") + name + (note ? " -- " + note : ""));
};

const chartCss = read("css/chart.css");
const toolsJs = read("js/chart-tools.js");

/* ================================================================== *
 * 1. .tv must not be a scroll container.
 * ================================================================== */

/* Resolved against the real cascade rather than read off the page, so a
   later rule putting overflow:hidden back is caught too. */
const FILES = ["css/app.css", "css/skins.css", "css/chart.css", "css/themes.css"];
const dom = new JSDOM(
  `<!doctype html><html dir="rtl" data-skin="aurora" data-theme="dark" data-glass="on" data-perf="rich"><head>` +
  FILES.map((f) => `<style data-src="${f}">${read(f)}</style>`).join("") +
  `</head><body><div id="app"><section id="desk"><main class="stage" id="stage">` +
  `<div class="tv no-dock" id="tv"><div class="tv-top"></div>` +
  `<div class="tv-body"><aside class="tv-rail"></aside><div class="tv-stage"></div>` +
  `<aside class="tv-dock" id="tv-dock"></aside></div><div class="tv-status"></div></div>` +
  `</main></section></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: new VirtualConsole() }
);
const doc = dom.window.document;

function splitSel(sel) {
  const out = []; let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}
const flat = [];
let order = 0;
for (const sheet of doc.styleSheets) {
  const walk = (list, mq) => {
    for (const r of list) {
      if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, (mq ? mq + " and " : "") + r.conditionText); continue; }
      if (!r.selectorText) continue;
      flat.push({ mq, sel: r.selectorText, style: r.style, order: order++ });
    }
  };
  try { walk(sheet.cssRules, ""); } catch { /* */ }
}
/* Every declaration that reaches the element, weakest first - overflow
   is a shorthand written twice here on purpose (hidden then clip), so
   the LIST matters, not just the winner. */
function reaching(el, prop, W) {
  const out = [];
  for (const r of flat) {
    const v = r.style.getPropertyValue(prop);
    if (!v) continue;
    if (r.mq) {
      if (/prefers-reduced-motion|forced-colors|print/.test(r.mq)) continue;
      const mx = /max-width:\s*(\d+)px/.exec(r.mq), mn = /min-width:\s*(\d+)px/.exec(r.mq);
      if (mx && W > Number(mx[1])) continue;
      if (mn && W < Number(mn[1])) continue;
    }
    for (const raw of splitSel(r.sel)) {
      const s = raw.trim();
      if (/hover|active|focus/.test((s.match(STATE) || []).join(""))) continue;
      let b = s.replace(STATE, "").trim();
      b = b.replace(/^([>+~])/, "* $1").replace(/([>+~])$/, "$1 *") || "*";
      let m = false;
      try { m = el.matches(b); } catch { continue; }
      if (!m) continue;
      out.push({ sp: spec(s), order: r.order, sel: s, v: v.trim() });
      break;
    }
  }
  out.sort((a, b) => (a.sp - b.sp) || (a.order - b.order));
  return out;
}

const tv = doc.getElementById("tv");

for (const [label, W] of [["phone", 390], ["tablet", 768], ["desktop", 1440]]) {
  check(`${label}: .tv clips rather than scrolls`, () => {
    const all = reaching(tv, "overflow", W);
    if (!all.length) return "nothing sets overflow on .tv at all";
    const last = all[all.length - 1];
    if (last.v !== "clip") {
      return `the winning declaration is overflow:${last.v} from "${last.sel}". `
        + `overflow:hidden still makes .tv a scroll container, which is the bug.`;
    }
    return true;
  });
}

/* Source, not CSSOM. The fallback pair works at PARSE time: an engine
   that does not know `clip` throws that declaration away and keeps
   `hidden`, and an engine that does know it keeps `clip` - so by the
   time the rule is in a modern CSSOM only `clip` is left, and asking
   the resolver would always say the fallback is missing. */
check("overflow:hidden is kept underneath as the fallback", () => {
  const i = chartCss.indexOf("\n.tv {");
  if (i < 0) return "no .tv rule";
  const body = chartCss.slice(i, chartCss.indexOf("\n}", i));
  const h = body.indexOf("overflow: hidden;");
  const c = body.indexOf("overflow: clip;");
  if (h < 0) return "an engine without overflow:clip would get no clipping at all";
  if (c < 0) return "overflow:clip is missing";
  return h < c || "the fallback must come FIRST, or it would overwrite clip";
});

/* The panels whose parking creates the overflow in the first place. */
check("the panels really are parked outside .tv (so the clip matters)", () => {
  const parked = chartCss.match(/transform:\s*translate[XY]\(-?1\d\d(?:\.\d+)?%\)/g) || [];
  return parked.length >= 3
    || `expected the dock (both directions) and the tool sheet, found ${parked.length}: ${parked.join(", ")}`;
});

/* ================================================================== *
 * 2. showDock must not ask any ancestor to scroll.
 * ================================================================== */

check("showDock no longer calls scrollIntoView", () => {
  const i = toolsJs.indexOf("function showDock(");
  if (i < 0) return "showDock is gone";
  const body = toolsJs.slice(i, toolsJs.indexOf("\n  }", i));
  return !/scrollIntoView/.test(body)
    || "showDock still calls scrollIntoView, which scrolls every scrollable ancestor";
});

check("showDock focuses with preventScroll", () => {
  const i = toolsJs.indexOf("function showDock(");
  const body = toolsJs.slice(i, toolsJs.indexOf("\n  }", i));
  if (!/\.focus\(/.test(body)) return "showDock no longer focuses the tab at all";
  return /preventScroll:\s*true/.test(body)
    || "focus() without preventScroll also asks every ancestor to reveal the element";
});

check("revealInStrip touches the strip and nothing above it", () => {
  const i = toolsJs.indexOf("function revealInStrip(");
  if (i < 0) return "revealInStrip is missing";
  const body = toolsJs.slice(i, toolsJs.indexOf("\n  }", i));
  if (/scrollIntoView|scrollTo\(|window\.scroll|document\.scroll/.test(body)) {
    return "it reaches past the strip";
  }
  const writes = body.match(/(\w+)\.scrollLeft\s*=/g) || [];
  if (!writes.length) return "it never scrolls the strip, so the tab is never lined up";
  const notStrip = writes.filter((w) => !/^strip\./.test(w));
  return notStrip.length === 0 || `it writes scroll offsets outside the strip: ${notStrip.join(", ")}`;
});

/* ================================================================== *
 * 3. It has to actually RUN.
 *
 * chart-tools.js is two IIFEs that do not share a scope, and the first
 * draft of revealInStrip called narrow() - which lives in the first one.
 * Every source assertion above passed while the chart threw on its first
 * render. A source regex cannot see that; calling the function can.
 * ================================================================== */
function bootUI() {
  const d = new JSDOM(`<!doctype html><html dir="rtl"><body><div id="stage"></div></body></html>`, {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = d.window;
  w.matchMedia = (q) => ({ matches: /max-width:\s?(980|1000|760|560)px/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.eval([read("js/i18n.js"), read("js/chart-tools.js")].join("\n;\n") + "\n;window.__UI = AurionChartUI;");
  const UI = w.__UI;
  w.document.getElementById("stage").innerHTML = UI.html({ symbol: "EURUSD", timeframe: "M15", ticket: "" });

  const calls = { into: [], focus: [], scrolled: [] };
  w.Element.prototype.scrollIntoView = function () { calls.into.push(this.id || this.className); };
  const realFocus = w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus = function (o) { calls.focus.push(o || null); return realFocus.call(this, o); };
  /* jsdom reports 0 for every box, so scrollWidth <= clientWidth and
     revealInStrip returns early. Give the strip a real overflow so the
     scrolling branch is the one under test. */
  const strip = w.document.querySelector(".tvd-tabs");
  if (strip) {
    Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(strip, "clientWidth", { configurable: true, get: () => 200 });
    let sl = 0;
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true, get: () => sl, set: (v) => { sl = v; calls.scrolled.push(["strip", v]); },
    });
  }
  for (const el of w.document.querySelectorAll("#stage *")) {
    if (el === strip) continue;
    let v = 0;
    Object.defineProperty(el, "scrollLeft", {
      configurable: true, get: () => v,
      set: (x) => { v = x; calls.scrolled.push([el.id || el.className || el.tagName, x]); },
    });
  }
  return { w, UI, calls };
}

check("showDock runs without throwing (the two IIFEs do not share a scope)", () => {
  const { UI } = bootUI();
  UI.showDock("objects");
  UI.showDock("positions", true);
  return true;
});

check("showDock asks nothing to scroll except the tab strip", () => {
  const { UI, calls } = bootUI();
  UI.showDock("objects");
  UI.showDock("positions", true);
  if (calls.into.length) return `scrollIntoView called on ${calls.into.join(", ")}`;
  const outside = calls.scrolled.filter(([who]) => who !== "strip");
  return outside.length === 0 || `scrolled ${outside.map(([w2, v]) => `${w2}=${v}`).join(", ")}`;
});

check("showDock still selects the tab and reveals its pane", () => {
  const { w, UI } = bootUI();
  UI.showDock("objects");
  const tab = w.document.querySelector('[data-dock="objects"]');
  const pane = w.document.querySelector('[data-pane="objects"]');
  const other = w.document.querySelector('[data-pane="positions"]');
  if (!tab || !pane) return "the objects tab or pane is missing";
  if (tab.getAttribute("aria-selected") !== "true") return "aria-selected was not set";
  if (tab.tabIndex !== 0) return "the roving tabindex did not move";
  if (pane.hidden) return "the chosen pane is still hidden";
  return (other && other.hidden) || "the other pane was left visible";
});

check("focusing a tab passes preventScroll", () => {
  const { UI, calls } = bootUI();
  UI.showDock("positions", true);
  const withOpts = calls.focus.filter((o) => o && o.preventScroll === true);
  return withOpts.length > 0 || `focus() was called ${calls.focus.length} time(s), never with preventScroll`;
});

/* ================================================================== *
 * 4. Optional: the real thing, if a browser is on hand.
 * ================================================================== */
const chrome = process.env.AURION_CHROME;
if (!chrome || !fs.existsSync(chrome)) {
  console.log("SKIP  real-browser layout (set AURION_CHROME to a Chrome/Chromium binary)");
} else {
  console.log("note  AURION_CHROME is set; run tests/chart-mobile-layout.browser.mjs for the measured checks");
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) console.log(`${failed} check(s) failed`);
process.exit(failed ? 1 : 0);
