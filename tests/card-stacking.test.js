/**
 * Side-by-side containers are the same height, and a new page starts at
 * the top of the page.
 *
 * Three reports, two causes.
 *
 * 1. "The container beside the account that shows the drawdown and the
 *    daily loss is not the same height."
 * 2. "The market-regime card is taller than the ones next to it."
 *
 *    Both are `.card + .card { margin-block-start: var(--stack-gap) }`.
 *    That rule is for containers stacked in normal flow and it is right
 *    there; it is wrong the moment the two cards are side by side in a
 *    grid. `.ccx-pair` and `.ai-read` are align-items:stretch, so the
 *    track is as tall as its tallest item and every item fills it - with
 *    its MARGIN box. A 14px top margin therefore makes the second card's
 *    border box 14px SHORTER than the first's, while the grid is being
 *    asked to make them equal. In the command centre the account card is
 *    the second one, so it is short; in Intelligence the regime card is
 *    the first one, so it is the tall one. Same rule, opposite-looking
 *    complaint.
 *
 *    The exemption for this already existed - and named `.grid`, `.cmd`
 *    and `.set-desk`, the containers that existed when it was written.
 *    Every gap-owning container built after it silently took the margin
 *    back. So the check here is not "is .ccx-pair in the list": it walks
 *    every view, finds every container that distributes its own children
 *    with a gap, and fails if any card-like child of one still resolves a
 *    shortening top margin. Add a container, forget the list, this fails.
 *
 * 3. "On a phone the EA chart opens with half the screen chart, half
 *    nothing, and the rest of the controls off the screen - until I open
 *    the side panel."
 *
 *    Not the canvas, which re-measures on every frame. show() reset the
 *    stage scroll only when the view NAME changed, and openChartDesk()
 *    calls show("charts") from the charts view: same name, so the scroll
 *    offset survived. On a phone the EA cards are one per row, so opening
 *    any chart but the first means having scrolled - and the workspace,
 *    about one viewport tall, mounted into a stage still scrolled down.
 *    You saw its bottom half. The top bar was above the top edge.
 *    Focusing anything in the side panel scrolled it back into view,
 *    which is why opening the panel "fixed" it.
 *
 * Run: node tests/card-stacking.test.js
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
  console.log("SKIP  card stacking (jsdom not installed)");
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

const results = [];
const check = (name, fn) => {
  let ok = false, note = "";
  try { const r = fn(); ok = r === true || r === undefined; if (typeof r === "string") { ok = false; note = r; } }
  catch (e) { ok = false; note = (e && e.message) + (process.env.TRACE ? "\n" + e.stack : ""); }
  results.push(ok);
  console.log((ok ? "PASS  " : "FAIL  ") + name + (note ? " -- " + note : ""));
};

/* ------------------------------------------------------------------ *
 * A document carrying the real stylesheets and the real desk code.
 * ------------------------------------------------------------------ */
const FILES = ["css/app.css", "css/skins.css", "css/chart.css", "css/themes.css"];
const dom = new JSDOM(
  `<!doctype html><html lang="en" dir="ltr" data-skin="aurora" data-theme="dark" data-glass="on" data-perf="rich"><head>` +
  FILES.map((f) => `<style data-src="${f}">${read(f)}</style>`).join("") +
  `</head><body><div id="app"><section id="desk"><header class="top" id="top">` +
  `<button class="menu-btn" id="menu-btn"></button><b id="view-title"></b></header>` +
  `<nav class="nav" id="nav"></nav><main class="stage" id="stage"></main></section></div>` +
  `<div class="toast-wrap" id="toasts"></div></body></html>`,
  { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() }
);
const win = dom.window;
const doc = win.document;
win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
win.URL.createObjectURL = () => "blob:stub";
win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };
win.confirm = () => true;
/* A no-op 2D context rather than null. The chart engine is bound for
   real here - that is the point of the test - and a null context makes
   it throw inside show(), which would hide the thing being measured. */
const noopCtx = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = typeof k === "string" && /^[A-Z_]/.test(k) ? 0 : () => noopCtx)),
  set: (t, k, v) => { t[k] = v; return true; },
});
noopCtx.measureText = () => ({ width: 10 });
noopCtx.createLinearGradient = () => ({ addColorStop() {} });
noopCtx.getImageData = () => ({ data: [0, 0, 0, 0] });
win.HTMLCanvasElement.prototype.getContext = () => noopCtx;

const bundle = [
  "js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js",
  "js/chart-series.js", "js/charts.js", "js/chart-tools.js", "js/pnl-charts.js", "js/app.js",
].map(read).join("\n;\n");
win.eval(bundle + "\n;window.__T = { S, views, I18N, show };");
const T = win.__T;

T.I18N.pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8"));
T.S.snap = {
  engine: "online",
  agents: [{ symbol: "EURUSD", timeframe: "M15", alive: true, online: true }],
  mt5: { connected: true, account: { login: 1, currency: "USD", leverage: 500, equity: 1, balance: 1, profit: 1, margin: 1, margin_free: 1 } },
  prop: { enabled: true, locked: false, daily_pl_pct: -1.4, drawdown_pct: 3.9, profile: { max_daily_loss_pct: 5, max_drawdown_pct: 10 } },
  strategy: { name: "smart_money" },
  positions: [], orders: [], ai: { regime: "trend", samples: 10 },
};

/* ------------------------------------------------------------------ *
 * Cascade resolver.
 *
 * Two traps here, both of which produced a confident wrong answer
 * before they were fixed, so both are spelled out:
 *
 *  - a selector list cannot be split on "," naively. `:is(.card, .grid)`
 *    is one compound, and shredding it at the comma leaves fragments
 *    that either throw or - worse - match something else and report a
 *    rule that does not exist. splitSel() tracks paren depth.
 *  - a combinator in the middle of a selector is not a gap to be filled
 *    with "*". Only a LEADING or TRAILING one is.
 * ------------------------------------------------------------------ */
const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}
function splitSel(sel) {
  const out = []; let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const flat = [];
let order = 0;
for (const sheet of doc.styleSheets) {
  const src = (sheet.ownerNode && sheet.ownerNode.getAttribute("data-src")) || "?";
  const walk = (list, mq) => {
    for (const r of list) {
      if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, (mq ? mq + " and " : "") + r.conditionText); continue; }
      if (!r.selectorText) continue;
      flat.push({ src, mq, sel: r.selectorText, style: r.style, order: order++ });
    }
  };
  try { walk(sheet.cssRules, ""); } catch { /* */ }
}
function winner(el, prop, W) {
  const cands = [];
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
      cands.push({ sp: spec(s), order: r.order, sel: s, v: v.trim(), src: r.src });
      break;
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (a.sp - b.sp) || (a.order - b.order));
  return cands[cands.length - 1];
}

/* Sanity: the resolver must be able to see the rule this suite is about.
   Both traps above made it silently invisible, and a resolver that
   cannot see the bug reports a clean desk. */
check("the resolver can see an adjacent-sibling rule at all", () => {
  const probe = doc.createElement("div");
  probe.innerHTML = `<div class="card"></div><div class="card" id="second"></div>`;
  doc.body.appendChild(probe);
  const hit = winner(probe.querySelector("#second"), "margin-block-start", 1440);
  probe.remove();
  if (!hit) return "no rule resolved for a second .card in a plain block parent";
  return /\.card \+ \.card/.test(hit.sel) || `resolved ${hit.sel}`;
});
check("the resolver keeps :is() lists whole", () => {
  const parts = splitSel(":is(.card, .grid) + :is(.card, .grid), .other");
  return parts.length === 2 || `split into ${parts.length}: ${parts.join(" | ")}`;
});

const stage = doc.getElementById("stage");
const render = (view) => { stage.innerHTML = T.views[view](); return stage; };
const VIEWS = Object.keys(T.views);

/* ------------------------------------------------------------------ *
 * 1 + 2. No card in a gap-owning container carries a shortening margin.
 * ------------------------------------------------------------------ */
const KIDS = ".card, .grid, .row, .table-wrap";
const zeroish = (v) => /^0(px|em|rem|%)?$/.test(v) || v === "auto";

function sweep(W) {
  const bad = [];
  for (const view of VIEWS) {
    let el;
    try { el = render(view); } catch { continue; }
    for (const parent of el.querySelectorAll("*")) {
      const disp = winner(parent, "display", W);
      if (!disp || !/grid|flex/.test(disp.v)) continue;
      const gap = winner(parent, "gap", W) || winner(parent, "row-gap", W);
      if (!gap || zeroish(gap.v)) continue;
      for (const kid of parent.children) {
        if (!kid.matches(KIDS)) continue;
        const m = winner(kid, "margin-block-start", W);
        if (!m || zeroish(m.v)) continue;
        bad.push(`${view}: .${String(parent.className).trim().split(/\s+/).join(".")} > `
          + `.${String(kid.className).trim().split(/\s+/).join(".")} = ${m.v} (${m.sel})`);
      }
    }
  }
  return bad;
}

for (const [label, W] of [["desktop", 1440], ["phone", 390]]) {
  check(`${label}: no card in a gap-owning container is shortened by a stacking margin`, () => {
    const bad = sweep(W);
    return bad.length === 0 || `${bad.length} offender(s):\n      ` + [...new Set(bad)].join("\n      ");
  });
}

/* The two the user actually reported, named, so a regression says which
   page broke rather than only that something did. */
check("command centre: the account card is not shorter than the risk card beside it", () => {
  render("command");
  const pair = stage.querySelector(".ccx-pair");
  if (!pair) return "no .ccx-pair";
  if (pair.children.length !== 2) return `expected risk + account, got ${pair.children.length}`;
  const ai = winner(pair, "align-items", 1440);
  if (!ai || ai.v !== "stretch") return `.ccx-pair align-items is ${ai && ai.v}`;
  const account = pair.querySelector(".ccx-ref");
  const m = winner(account, "margin-block-start", 1440);
  return (!m || zeroish(m.v)) || `.ccx-ref carries ${m.v} from ${m.sel}`;
});

check("intelligence: the regime card is the same height as the two beside it", () => {
  render("intelligence");
  const read_ = stage.querySelector(".ai-read");
  if (!read_) return "no .ai-read";
  const cards = [...read_.children];
  if (cards.length !== 3) return `expected 3 tiles, got ${cards.length}`;
  if (!/regime/i.test(cards[0].textContent)) return "the first tile is not the market regime";
  const offenders = cards
    .map((c, i) => [i, winner(c, "margin-block-start", 1440)])
    .filter(([, m]) => m && !zeroish(m.v));
  return offenders.length === 0
    || offenders.map(([i, m]) => `tile ${i} = ${m.v} (${m.sel})`).join("; ");
});

check("intelligence: the retrain button is pushed to the foot of its tile", () => {
  render("intelligence");
  const btn = stage.querySelector("#btn-train");
  if (!btn) return "no #btn-train";
  const m = winner(btn, "margin-block-start", 1440);
  return (m && m.v === "auto") || `resolved ${m && m.v} from ${m && m.sel}`;
});

/* The exemption is a list, and a list is the thing that rots. */
check("the stacking exemption names every gap-owning container it has to", () => {
  const css = read("css/app.css");
  const i = css.indexOf("margin-block-start:0;");
  if (i < 0) return "no exemption rule found";
  const rule = css.slice(css.lastIndexOf("}", i) + 1, i);
  const missing = [".grid", ".cmd", ".set-desk", ".ccx-pair", ".ai-read", ".exx-cols", ".pfx-cols", ".snd-wrap"]
    .filter((c) => !rule.includes(c));
  return missing.length === 0 || `missing ${missing.join(", ")}`;
});

/* ------------------------------------------------------------------ *
 * 3. The chart workspace mounts at the top of the stage.
 * ------------------------------------------------------------------ */
check("show() keys the scroll reset on what is mounted, not on the view name", () => {
  const js = read("js/app.js");
  const i = js.indexOf("const mountKey = view +");
  if (i < 0) return "no mountKey in show()";
  const slice = js.slice(i, js.indexOf("}", js.indexOf("stage.scrollTop = 0", i)));
  if (!/S\.chartFocus/.test(slice)) return "mountKey ignores the chart focus";
  if (!/changing \|\| remounting/.test(slice)) return "the scroll reset is not guarded on the remount";
  return true;
});

check("mountedKey is recorded on mount and cleared with mountedView", () => {
  const js = read("js/app.js");
  if (!/S\.mountedKey = mountKey;/.test(js)) return "mountedKey is never stored";
  const clears = js.match(/S\.mountedView = null;\s*S\.mountedKey = null;/g) || [];
  const lone = js.match(/S\.mountedView = null;(?!\s*S\.mountedKey)/g) || [];
  return lone.length === 0 || `${lone.length} place(s) clear mountedView without mountedKey`;
});

/* The behaviour itself, through the real show(). getBoundingClientRect
   is all zeros under jsdom so there is no layout to assert - but the
   scroll offset is a plain property, and that is the whole defect. */
function scrollHarness() {
  let top = 0;
  Object.defineProperty(stage, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v) => { top = Number(v) || 0; },
  });
  return { get: () => top, set: (v) => { top = v; } };
}

check("opening an EA chart from a scrolled card list lands at the top", () => {
  const sc = scrollHarness();
  T.S.chartFocus = null;
  T.show("charts", { animate: false });
  sc.set(640);                                   // the trader scrolled to find their chart
  T.S.chartFocus = { symbol: "EURUSD", timeframe: "M15" };
  T.show("charts", { animate: false });          // what openChartDesk() does
  return sc.get() === 0 || `stage stayed at ${sc.get()}px`;
});

check("coming back out of the chart lands at the top of the list", () => {
  const sc = scrollHarness();
  T.S.chartFocus = { symbol: "EURUSD", timeframe: "M15" };
  T.show("charts", { animate: false });
  sc.set(220);
  T.S.chartFocus = null;
  T.show("charts", { animate: false });
  return sc.get() === 0 || `stage stayed at ${sc.get()}px`;
});

check("switching symbol inside the workspace still lands at the top", () => {
  const sc = scrollHarness();
  T.S.chartFocus = { symbol: "EURUSD", timeframe: "M15" };
  T.show("charts", { animate: false });
  sc.set(90);
  T.S.chartFocus = { symbol: "XAUUSD", timeframe: "H1" };
  T.show("charts", { animate: false });
  return sc.get() === 0 || `stage stayed at ${sc.get()}px`;
});

check("a plain re-render of the same page does NOT throw the reader to the top", () => {
  const sc = scrollHarness();
  T.S.chartFocus = null;
  T.show("settings", { animate: false });
  sc.set(300);
  T.show("settings", { animate: false });        // saving a setting, a tick arriving
  return sc.get() === 300 || `stage jumped to ${sc.get()}px on a re-render`;
});

check("a re-render of the open chart desk does NOT reset the scroll", () => {
  const sc = scrollHarness();
  T.S.chartFocus = { symbol: "EURUSD", timeframe: "M15" };
  T.show("charts", { animate: false });
  sc.set(45);
  T.show("charts", { animate: false });
  return sc.get() === 45 || `stage jumped to ${sc.get()}px on a re-render`;
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) console.log(`${failed} check(s) failed`);
process.exit(failed ? 1 : 0);
