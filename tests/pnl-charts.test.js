/**
 * The history page's profit-and-loss charts.
 *
 * The ask was to draw the current account's profit and loss in the
 * history section, with several ways of looking at it -- and to offer
 * real variety rather than one more price chart.
 *
 * Two things are worth testing and one is not. The arithmetic is worth
 * testing: a cumulative curve, a drawdown and a profit factor are claims
 * about the account's money, and an off-by-one in the running total is a
 * lie told confidently. The drawing is worth testing in the narrow sense
 * that every mode must produce a chart rather than throw -- these run on
 * whatever the ledger happens to contain, including one trade, no losses,
 * or a symbol called "<script>". What is not worth testing is whether the
 * curve looks nice.
 *
 * The module is loaded the way the page loads it, as a plain script
 * assigning a global, so the test exercises the shipped file.
 *
 *     node tests/pnl-charts.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ------------------------------------------------------------ the module */

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("js/pnl-charts.js"), sandbox, { filename: "pnl-charts.js" });
const PNL = sandbox.PNL;

const appJs = read("js/app.js");
const appCss = read("css/app.css");
const indexHtml = read("index.html");

/** A close, as the engine records one. */
const close = (ts, net, extra = {}) => ({
  ts, kind: "close", ticket: extra.ticket || 1, symbol: extra.symbol || "EURUSD",
  side: extra.side || "buy", volume: 0.1, profit: extra.profit !== undefined ? extra.profit : net,
  swap: extra.swap || 0, commission: extra.commission || 0,
  net: extra.net !== undefined ? extra.net : net, strategy: extra.strategy || "trend",
});

const LEDGER = [
  close("2026-10-05 10:00:00", 120, { ticket: 1, symbol: "EURUSD", strategy: "trend" }),
  close("2026-10-05 14:00:00", -40, { ticket: 2, symbol: "XAUUSD", strategy: "trend" }),
  close("2026-10-06 09:00:00", -80, { ticket: 3, symbol: "EURUSD", strategy: "scalp" }),
  close("2026-10-07 11:00:00", 200, { ticket: 4, symbol: "US500", strategy: "scalp" }),
  close("2026-10-08 11:00:00", -30, { ticket: 5, symbol: "XAUUSD", strategy: "trend" }),
];

/* ===================================================================== data */

check("only closed trades reach the chart", () => {
  const withOpens = [
    { ts: "2026-10-05 09:00:00", kind: "entry", symbol: "EURUSD", profit: 0 },
    ...LEDGER,
    { ts: "2026-10-09 09:00:00", entry: "in", symbol: "EURUSD", profit: 0 },
  ];
  const s = PNL.series(withOpens);
  if (s.trades.length !== 5) throw new Error("expected 5 closes, got " + s.trades.length);
  return "5 of 7 rows";
});

check("the running total is the sum of the closes, in close order", () => {
  /* The ledger arrives newest first; the curve has to read left to right
     or every shape in it is backwards. */
  const s = PNL.series([...LEDGER].reverse());
  const cums = s.trades.map((t) => t.cum);
  const want = [120, 80, 0, 200, 170];
  if (JSON.stringify(cums) !== JSON.stringify(want)) {
    throw new Error("cumulative is " + JSON.stringify(cums) + ", expected " + JSON.stringify(want));
  }
  if (s.stats.net !== 170) throw new Error("net is " + s.stats.net);
  return "reversed input still reads oldest-first";
});

check("net is preferred over profit, because the account moves by net", () => {
  /* MT5's Profit is gross. A row whose swap and commission are real must
     not be charted at its gross figure. Older rows carry no net at all --
     it lives in the stored blob and only recent writes lift it out -- so
     the fallback is the arithmetic, not a zero. */
  const noNet = { ts: "2026-10-05 10:00:00", kind: "close", ticket: 9, symbol: "EURUSD",
                  volume: 0.1, profit: 100, swap: -3, commission: -7 };
  const s = PNL.series([noNet]);
  if (s.trades[0].net !== 90) throw new Error("expected 100-3-7=90, got " + s.trades[0].net);
  if (s.stats.fees !== -10) throw new Error("fees should be -10, got " + s.stats.fees);

  /* And where the engine did record a net, that figure wins outright --
     including a genuine zero, which is a result and not a missing value. */
  const withNet = PNL.series([{ ...noNet, net: 0 }]);
  if (withNet.trades[0].net !== 0) throw new Error("a recorded net of 0 was overridden with " + withNet.trades[0].net);
  return "100 gross - 10 costs = 90; a recorded 0 stands";
});

check("the drawdown is measured from the high-water mark", () => {
  const s = PNL.series(LEDGER);
  /* Peak 120 at trade 1, trough 0 at trade 3 -> worst is -120. */
  if (s.stats.maxDrawdown !== -120) throw new Error("max drawdown is " + s.stats.maxDrawdown);
  if (s.trades.some((t) => t.dd > 0)) throw new Error("a drawdown went positive");
  return "-120";
});

check("the headline figures are the ones a statement would show", () => {
  const st = PNL.series(LEDGER).stats;
  const want = { trades: 5, wins: 2, losses: 3, net: 170, best: 200, worst: -80 };
  for (const [k, v] of Object.entries(want)) {
    if (st[k] !== v) throw new Error(k + " is " + st[k] + ", expected " + v);
  }
  if (Math.abs(st.winRate - 40) > 1e-9) throw new Error("win rate is " + st.winRate);
  if (Math.abs(st.profitFactor - 320 / 150) > 1e-9) throw new Error("profit factor is " + st.profitFactor);
  return "pf 320/150";
});

check("a profit factor with no losing trade is left blank, not invented", () => {
  /* Dividing by zero gives Infinity, and printing "∞" or a made-up large
     number as a performance figure is exactly the sort of invented
     statistic this desk is not allowed to show. */
  const st = PNL.series([close("2026-10-05 10:00:00", 50)]).stats;
  if (st.profitFactor !== null) throw new Error("expected null, got " + st.profitFactor);
  const html = PNL.summary(st);
  if (!html.includes("—")) throw new Error("the blank is not rendered as a dash");
  if (/Infinity|NaN/.test(html)) throw new Error("summary printed " + html.match(/Infinity|NaN/)[0]);
  return "null -> —";
});

check("an empty ledger produces zeroes and no NaN", () => {
  const st = PNL.series([]).stats;
  for (const [k, v] of Object.entries(st)) {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(k + " is " + v);
  }
  const html = PNL.summary(st);
  if (/NaN|Infinity|undefined/.test(html)) throw new Error("summary: " + html.match(/NaN|Infinity|undefined/)[0]);
  return "all finite";
});

check("grouping sums per symbol and per strategy", () => {
  const s = PNL.series(LEDGER);
  const bySym = Object.fromEntries(PNL.groupBy(s.trades, "symbol").map((r) => [r.key, r.net]));
  if (bySym.EURUSD !== 40 || bySym.XAUUSD !== -70 || bySym.US500 !== 200) {
    throw new Error("by symbol: " + JSON.stringify(bySym));
  }
  const byStrat = Object.fromEntries(PNL.groupBy(s.trades, "strategy").map((r) => [r.key, r.net]));
  if (byStrat.trend !== 50 || byStrat.scalp !== 120) throw new Error("by strategy: " + JSON.stringify(byStrat));
  /* Best first, so the eight that fit are the eight worth seeing. */
  const order = PNL.groupBy(s.trades, "symbol").map((r) => r.key);
  if (order[0] !== "US500") throw new Error("not sorted by net: " + order.join(","));
  return "EURUSD 40, XAUUSD -70, US500 200";
});

/* ================================================================== drawing */

const MODE_IDS = PNL.modes().map((m) => m.id);

check("the desk offers several kinds of chart, not one", () => {
  if (MODE_IDS.length < 6) throw new Error("only " + MODE_IDS.length + " modes");
  for (const want of ["equity", "trades", "daily", "drawdown", "donut", "hist", "symbol", "strategy"]) {
    if (!MODE_IDS.includes(want)) throw new Error("missing mode: " + want);
  }
  return MODE_IDS.length + " modes: " + MODE_IDS.join(", ");
});

check("every mode draws a chart from a normal ledger", () => {
  const data = PNL.series(LEDGER);
  for (const id of MODE_IDS) {
    const svg = PNL.render(id, data, 640, 240);
    if (!/^<svg[\s>]/.test(svg)) throw new Error(id + " did not return an svg");
    if (!svg.includes("</svg>")) throw new Error(id + " produced unclosed markup");
    if (/NaN|Infinity|undefined/.test(svg)) {
      throw new Error(id + " emitted " + svg.match(/NaN|Infinity|undefined/)[0]);
    }
  }
  return MODE_IDS.length + " modes";
});

check("every mode survives the awkward ledgers", () => {
  /* One trade (no span to divide by), all winners (no negative side to
     scale against), all losers, and identical results (a zero range). */
  const awkward = {
    "one trade": [close("2026-10-05 10:00:00", 25)],
    "all winners": [close("2026-10-05 10:00:00", 10), close("2026-10-06 10:00:00", 20)],
    "all losers": [close("2026-10-05 10:00:00", -10), close("2026-10-06 10:00:00", -20)],
    "flat": [close("2026-10-05 10:00:00", 0), close("2026-10-06 10:00:00", 0)],
    "empty": [],
  };
  for (const [label, rows] of Object.entries(awkward)) {
    const data = PNL.series(rows);
    for (const id of MODE_IDS) {
      let svg;
      try { svg = PNL.render(id, data, 640, 240); } catch (e) {
        throw new Error(id + " threw on '" + label + "': " + e.message);
      }
      if (!svg.includes("</svg>")) throw new Error(id + " broke on '" + label + "'");
      if (/NaN|Infinity/.test(svg)) throw new Error(id + " on '" + label + "' emitted " + svg.match(/NaN|Infinity/)[0]);
    }
  }
  return Object.keys(awkward).length + " shapes x " + MODE_IDS.length + " modes";
});

check("a ledger with one outcome still draws a full ring", () => {
  /* An arc from a point back to itself is a no-op in SVG: 100% wins would
     render as an empty circle. */
  const data = PNL.series([close("2026-10-05 10:00:00", 10), close("2026-10-06 10:00:00", 20)]);
  const svg = PNL.render("donut", data, 640, 240);
  const arcs = svg.match(/class="pc-arc[^"]*"/g) || [];
  if (arcs.length !== 1) throw new Error("expected one arc, got " + arcs.length);
  const d = /<path class="pc-arc[^"]*" d="([^"]+)"/.exec(svg);
  if (!d || (d[1].match(/A /g) || []).length < 2) {
    throw new Error("the single slice is not drawn as two half-arcs: " + (d && d[1]));
  }
  if (!svg.includes("100.0%")) throw new Error("the ring does not read 100%");
  return "two half-arcs";
});

check("the chart is drawn at the size it is given, not stretched by a viewBox", () => {
  /* A viewBox scales its text with it, which is how one chart ends up
     with 6px labels on a phone and 20px on a desktop. */
  const data = PNL.series(LEDGER);
  const small = PNL.render("equity", data, 320, 190);
  const large = PNL.render("equity", data, 980, 260);
  if (!small.includes('viewBox="0 0 320 190"')) throw new Error("small chart: " + small.slice(0, 110));
  if (!large.includes('viewBox="0 0 980 260"')) throw new Error("large chart: " + large.slice(0, 110));
  if (!/width="320"/.test(small) || !/width="980"/.test(large)) throw new Error("width is not the measured width");
  return "320x190 and 980x260";
});

check("a symbol name from the broker cannot inject markup", () => {
  const data = PNL.series([close("2026-10-05 10:00:00", 10, { symbol: '<script>x</script>' })]);
  for (const id of ["symbol", "trades", "strategy"]) {
    const svg = PNL.render(id, data, 640, 240);
    if (svg.includes("<script>")) throw new Error(id + " did not escape the symbol");
  }
  return "escaped";
});

check("profit and loss are drawn in the theme's own colours", () => {
  /* --ok and --bad alias the candle colours, so the curve follows a
     user's own candle choice instead of needing a second setting. */
  for (const sel of [".pc-line.is-up", ".pc-bar.is-up", ".pc-bar.is-down", ".pc-area.is-up"]) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{]*\\{[^}]*var\\(--(ok|bad)\\)");
    if (!re.test(appCss)) throw new Error(sel + " does not use var(--ok)/var(--bad)");
  }
  if (/\.pc-(line|bar|area)[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/.test(appCss)) {
    throw new Error("a chart colour is hard-coded, so it will not follow the theme");
  }
  return "--ok / --bad";
});

/* ============================================================== the wiring */

check("the history page shows the chart above the ledger", () => {
  const view = appJs.slice(appJs.indexOf("  history() {"), appJs.indexOf("  upgrade() {"));
  if (!view) throw new Error("could not find the history view");
  if (!view.includes('id="h-pnl"')) throw new Error("no chart host");
  if (!view.includes('id="h-pnl-mode"')) throw new Error("no mode switch");
  if (!view.includes('id="h-pnl-stats"')) throw new Error("no summary figures");
  if (view.indexOf('id="h-pnl"') > view.indexOf('id="h-body"')) {
    throw new Error("the chart is below the 400-row table, where nobody will see it");
  }
  return "chart, then ledger";
});

check("the mode switch is a real tablist with every mode on it", () => {
  const view = appJs.slice(appJs.indexOf("  history() {"), appJs.indexOf("  upgrade() {"));
  if (!view.includes('role="tablist"')) throw new Error("not a tablist");
  if (!view.includes('role="tab"')) throw new Error("the buttons are not tabs");
  if (!view.includes("aria-selected")) throw new Error("no selected state is exposed");
  if (!/pnlModes\(\)\.map/.test(view)) throw new Error("the buttons are not built from the mode list");
  return "aria-selected per tab";
});

check("the charts are fed the ledger, not the table's view model", () => {
  /* historyRowView blanks profit on entry rows and rounds for display.
     Summing that would quietly produce different totals from the engine. */
  const fn = appJs.slice(appJs.indexOf("async function loadHistory()"), appJs.indexOf("async function hardRefresh()"));
  if (!/PNL\.series\(raw\)/.test(fn)) throw new Error("series() is not called with the raw rows");
  const seriesAt = fn.indexOf("PNL.series(raw)");
  const mapAt = fn.indexOf("map(historyRowView)");
  if (seriesAt > mapAt) throw new Error("the chart is built from the formatted rows");
  return "raw rows";
});

check("the chosen mode survives a reload", () => {
  if (!/localStorage\.setItem\("aurion\.history\.pnl\.mode"/.test(appJs)) throw new Error("the mode is never saved");
  if (!/localStorage\.getItem\("aurion\.history\.pnl\.mode"/.test(appJs)) throw new Error("the mode is never read back");
  /* A key left over from an older build must not select a mode that no
     longer exists, or the page renders nothing. */
  const fn = appJs.slice(appJs.indexOf("function pnlMode()"), appJs.indexOf("function paintPnl()"));
  if (!/ids\.has\(saved\)/.test(fn)) throw new Error("a stale saved mode is not validated");
  return "validated against the mode list";
});

check("the mode switch is bound once, however often the page is loaded", () => {
  const fn = appJs.slice(appJs.indexOf("function bindPnl()"), appJs.indexOf("async function loadHistory()"));
  if (!/dataset\.bound === "1"/.test(fn)) throw new Error("no guard, so clicks would stack up");
  return "dataset.bound";
});

check("the chart is redrawn when the card changes width", () => {
  const fn = appJs.slice(appJs.indexOf("function bindPnl()"), appJs.indexOf("async function loadHistory()"));
  if (!/ResizeObserver/.test(fn)) throw new Error("nothing watches the width");
  if (!/clearTimeout/.test(fn)) throw new Error("the redraw is not debounced");
  return "debounced ResizeObserver";
});

check("a missing analytics module costs the chart, not the desk", () => {
  /* app.js is evaluated by harnesses that load fewer scripts than the
     page does; a bare reference at load time would be a ReferenceError
     that takes every view down with it. */
  if (/^const PNL_MODES = new Set\(PNL\./m.test(appJs)) throw new Error("PNL is dereferenced at load time");
  for (const guard of ['typeof PNL !== "undefined"', 'typeof PNL === "undefined"']) {
    if (!appJs.includes(guard)) throw new Error("missing guard: " + guard);
  }
  return "guarded";
});

check("the page loads the module before app.js", () => {
  const modAt = indexHtml.indexOf("js/pnl-charts.js");
  const appAt = indexHtml.indexOf("js/app.js");
  if (modAt < 0) throw new Error("index.html never loads js/pnl-charts.js");
  if (modAt > appAt) throw new Error("pnl-charts.js loads after app.js");
  return "before app.js";
});

check("the chart area has mobile rules, not just a desktop grid", () => {
  const narrow = appCss.slice(appCss.indexOf("@media (max-width:900px)", appCss.indexOf(".pc-stats{")));
  if (!narrow.includes(".pc-stats")) throw new Error("the summary grid never reflows");
  if (!narrow.includes(".pc-seg button")) throw new Error("the mode buttons never reflow");
  if (!/\.pc-seg\{[^}]*flex-wrap:wrap/.test(appCss)) throw new Error("eight buttons cannot wrap on a phone");
  return "4 columns -> 2, buttons wrap";
});

check("every string on the new card is translated in all three languages", () => {
  const packs = ["en", "fa", "ar"].map((l) => JSON.parse(fs.readFileSync(path.join(ROOT, "lang", l + ".json"), "utf8")));
  const keys = [...new Set([
    ...PNL.modes().map((m) => m.key),
    "pnl.title", "pnl.hint", "pnl.modes", "pnl.empty", "pnl.best", "pnl.worst",
    "pnl.maxdd", "pnl.fees", "pnl.wins", "pnl.losses", "pnl.flat",
    "pnl.oldest", "pnl.newest", "history.no_strategy",
  ])];
  for (const pack of packs) {
    for (const key of keys) {
      const v = key.split(".").reduce((o, k) => (o || {})[k], pack);
      if (!v) throw new Error("missing " + key + " in " + (pack.meta && pack.meta.code || "a pack"));
    }
  }
  return keys.length + " keys x 3 languages";
});

/* =======================================================================
   Persian and Arabic
   ======================================================================= */

/* Reported: in fa and ar the numbers and text inside the history
   charts landed on top of the chart. Two separate faults, both
   measured in a real browser at 390 and 1440. */

check("the chart's labels are translated, not silently English", () => {
  /* The fault: pnl-charts.js asked for `global.I18N`, and i18n.js
     declares `const I18N = {...}` at the top level of a classic
     script. That is a global LEXICAL binding and never a property of
     window, so the lookup missed on every desk and every label fell
     through to its English fallback - in all three languages, since
     2021-era "Win rate" is the fallback for fa and ar alike. The keys
     were present in every pack the whole time. Measured in the
     browser: I18N.lang "fa", I18N.t("history.winrate") "نرخ برد",
     window.I18N === I18N false, chart printing "Win rate".

     Reproduced here rather than asserted on the source, because the
     thing that bites is a binding, not a string. A `const` at the top
     of a script run in a vm context creates exactly the same lexical
     global: visible to code in the context, absent from the sandbox
     object. If the lookup regresses to a property read, this goes
     back to English and the check fails. */
  const box = { console };
  box.window = box;
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext('const I18N = { lang: "fa", t: (k) => ({ "history.winrate": "WINRATE-FA" }[k] || k) };',
    box, { filename: "i18n.js" });
  if (box.I18N !== undefined) throw new Error("the fixture did not reproduce a lexical-only binding");
  vm.runInContext(read("js/pnl-charts.js"), box, { filename: "pnl-charts.js" });
  const svg = box.PNL.render("donut", box.PNL.series(LEDGER), 340, 200);
  if (/Win rate/.test(svg)) throw new Error("the chart fell back to English with a dictionary in scope");
  if (!/WINRATE-FA/.test(svg)) throw new Error("the translation never reached the chart: " + svg.slice(0, 200));
  return "lexical I18N is found";
});

check("a host that exports the dictionary on the global still works", () => {
  /* The property lookup is kept as a second try rather than replaced,
     so nothing that did work stops working. */
  /* `window` is a DISTINCT object here, not the context itself. In a
     vm context a property of the sandbox is also reachable as a bare
     identifier, so a fixture that sets box.I18N exercises the lexical
     branch and passes no matter which lookup the file does - the
     first version of this check was exactly that, and it sat green
     while the fallback was deleted. Hanging the dictionary off a
     separate window object is the only way to make the bare name
     genuinely undefined while the property is there. */
  const box = { console };
  box.window = { I18N: { lang: "ar", t: (k) => ({ "history.winrate": "WINRATE-AR" }[k] || k) } };
  vm.createContext(box);
  vm.runInContext("typeof I18N", box);
  vm.runInContext(read("js/pnl-charts.js"), box, { filename: "pnl-charts.js" });
  if (vm.runInContext("typeof I18N", box) !== "undefined") {
    throw new Error("the fixture leaked a lexical binding, so this proves nothing");
  }
  const PNL2 = box.window.PNL;
  const svg = PNL2.render("donut", PNL2.series(LEDGER), 340, 200);
  if (!/WINRATE-AR/.test(svg)) throw new Error("a global dictionary is no longer read");
  return "global I18N still works";
});

check("the chart is pinned left-to-right, whatever the page is", () => {
  /* SVG resolves text-anchor start/end against the inline base
     direction, not against the coordinate system. pnl-charts.js
     places every label at an absolute x with an anchor saying which
     side of that x it hangs on - a 46px value gutter on the left,
     time running from low x to high x - so dir=rtl swapped the
     meaning of both anchors and hung every label off the wrong side.

     Measured at 390 before the fix: axis values meant for 13..40
     rendered at 40..66, on top of the grid and the equity line; the
     first date label at -12..46, clipped off the chart; the last at
     328..386, outside a 340px chart that is overflow:visible. After:
     13..40, 46..105 and 271..328 - identical to English. */
  const flat = appCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const svg = /[}]\s*\.pc-svg\s*\{([^}]*)\}/.exec(flat);
  if (!svg) throw new Error("no .pc-svg rule");
  if (!/direction:\s*ltr/.test(svg[1])) {
    throw new Error("the chart follows the page's direction, so its anchors flip: " + svg[1]);
  }
  /* And each label still gets its own base direction, so a Persian
     phrase inside an ltr diagram reads right to left. */
  const text = /[}]\s*\.pc-svg text\s*\{([^}]*)\}/.exec(flat);
  if (!text || !/unicode-bidi:\s*plaintext/.test(text[1])) {
    throw new Error("labels are not bidi-isolated, so an RTL phrase reorders");
  }
  return "direction:ltr with per-label bidi";
});

check("a signed figure keeps its sign on the left", () => {
  /* +112.96 printed as "112.96+" and -66.53 as "66.53-" on a Persian
     desk: the sign is a neutral character, so the bidi algorithm gave
     it the paragraph's direction and parked it after the digits. All
     four signed tiles were wrong. A quantity reads left to right in
     every language this desk speaks, which is the rule the numeric
     input fields in this same sheet already follow.

     The seat has to be restored explicitly: direction:ltr alone drags
     the value to the left edge while its label stays on the right. */
  const flat = appCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const tile = /[}]\s*\.pc-stat b\s*\{([^}]*)\}/.exec(flat);
  if (!tile) throw new Error("no .pc-stat b rule");
  if (!/direction:\s*ltr/.test(tile[1])) throw new Error("the figure follows the page: " + tile[1]);
  if (!/unicode-bidi:\s*isolate/.test(tile[1])) throw new Error("the figure is not isolated from the label beside it");
  const rtlSeat = /html\[dir="rtl"\]\s*\.pc-stat b\s*\{([^}]*)\}/.exec(flat);
  if (!rtlSeat || !/text-align:\s*right/.test(rtlSeat[1])) {
    throw new Error("an RTL page seats the figure away from its own label");
  }
  if (flat.indexOf('html[dir="rtl"] .pc-stat b') < flat.indexOf(".pc-stat b{")) {
    throw new Error("the RTL seat is declared before the rule it has to beat");
  }
  return "ltr digits, seated under their label";
});

/* ------------------------------------------------------------------ result */

const failed = results.filter((x) => !x).length;
console.log("\npnl-charts: " + (failed ? failed + " FAILED of " : results.length + " of ") + results.length + " checks passed");
process.exit(failed ? 1 : 0);
