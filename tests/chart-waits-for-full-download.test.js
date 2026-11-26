/**
 * No chart opens until its download has finished. Anywhere.
 *
 * Asked for in these words: "until the chart download operation is
 * finalised the chart must not open by any means - not in the EA
 * chart or its list, not in the markets section, and not in the
 * backtest."
 *
 * The numbers behind it. Six months is the history ceiling, and at
 * M5 that is 51 840 candles; they arrive from MetaTrader in chunks
 * over tens of seconds. The desk used to let the trader in at the
 * first month - 8 640 of those 51 840, sixteen per cent - and leave
 * the other 43 200 landing underneath. Those bars are PREPENDED, so
 * every chunk slides the window the trader scrolled to, and every
 * indicator recomputes over a span that keeps changing. The chart
 * read as finished and was not.
 *
 *     node tests/chart-waits-for-full-download.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const CHARTCSS = fs.readFileSync(path.join(ROOT, "apps", "web", "css", "chart.css"), "utf8");

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name); }
}
function section(t) { console.log("\n\u2014 " + t + "\n"); }

/** One top-level function, by name, lifted out of app.js. */
function grab(src, name) {
  const at = src.search(new RegExp("^(?:async )?function " + name + "\\s*\\(", "m"));
  if (at < 0) throw new Error("app.js has no function " + name);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end < 0 ? src.length : end + 3);
}

/* The rule itself, lifted and run. Grepping for it would only prove
   the words are there; this proves what it answers. */
const freshMs = /const HIST_FRESH_MS = (\d+);/.exec(APP);
if (!freshMs) throw new Error("app.js no longer states HIST_FRESH_MS");
const FRESH = Number(freshMs[1]);

function kit(S) {
  return new Function("__S",
    "const S = __S;\n"
    + "const cachedCandlesFor = () => null;\n"
    + "const HIST_FRESH_MS = " + FRESH + ";\n"
    + grab(APP, "historyProgressOf") + "\n"
    + grab(APP, "historyDepthOf") + "\n"
    + grab(APP, "historyRunning") + "\n"
    + grab(APP, "seriesReady") + "\n"
    + grab(APP, "enoughBarsFor") + "\n"
    + "return { historyRunning, seriesReady, enoughBarsFor };")(S);
}

const bars = (n) => Array.from({ length: n }, (_, i) => ({ time: "t" + i, close: 1 }));

/* ================================================== 1. the rule */

section("1. a download that is still running is not a chart");

{
  const S = { histProgress: {}, histDepth: {} };
  const k = kit(S);

  // The reproduction, in its own numbers: six months of M5.
  S.histProgress["XAUUSD.M5"] = { have: 8640, want: 51840, done: false, at: Date.now() };
  ok(k.historyRunning("XAUUSD", "M5"), "a download at 8 640 of 51 840 is running");
  ok(!k.seriesReady("XAUUSD", "M5", bars(8640)),
    "a month of a six-month download does not open the chart");

  // One chunk short is still short. The old rule let this through at
  // sixteen per cent; this one does not let it through at 99.9.
  S.histProgress["XAUUSD.M5"] = { have: 51700, want: 51840, done: false, at: Date.now() };
  ok(!k.seriesReady("XAUUSD", "M5", bars(51700)),
    "...and neither does 51 700 of 51 840, which is nearly all of it");

  S.histProgress["XAUUSD.M5"] = { have: 51840, want: 51840, done: true, at: Date.now() };
  ok(!k.historyRunning("XAUUSD", "M5"), "the expert's own done flag ends it");
  ok(k.seriesReady("XAUUSD", "M5", bars(51840)), "and the chart opens");
}

section("2. but it can never wait for ever");

{
  const S = { histProgress: {}, histDepth: {} };
  const k = kit(S);

  /* The failure this gate could cause is worse than the one it
     fixes, so each way out is checked on its own. */
  ok(!k.historyRunning("EURUSD", "M15"),
    "a series nothing ever reported on is not treated as downloading");
  ok(k.seriesReady("EURUSD", "M15", bars(10)), "...so it opens with what there is");

  S.histProgress["EURUSD.M15"] = { have: 100, want: 9999, done: false, at: Date.now() - FRESH - 1 };
  ok(!k.historyRunning("EURUSD", "M15"),
    "a report older than the freshness window means nothing is arriving");
  ok(k.seriesReady("EURUSD", "M15", bars(100)), "...so a stalled download does not lock the chart");

  // Still inside the window, so this one IS running - the boundary
  // matters, and an off-by-one here opens every partial chart.
  S.histProgress["EURUSD.M15"] = { have: 100, want: 9999, done: false, at: Date.now() - (FRESH - 2000) };
  ok(k.historyRunning("EURUSD", "M15"), "a report from inside the window still counts");

  /* Everything the terminal says it holds has been sent. The expert
     may never set done on a market whose history simply stops. */
  S.histProgress["GBPUSD.H1"] = { have: 400, want: 4320, done: false, at: Date.now() };
  S.histDepth = { "GBPUSD.H1": { available: 400 } };
  ok(!k.historyRunning("GBPUSD", "H1"),
    "holding everything the terminal has is finished, whatever was asked for");
}

section("3. and an empty box is never mistaken for a ready one");

{
  const S = { histProgress: {}, histDepth: {} };
  const k = kit(S);
  ok(!k.seriesReady("XAUUSD", "M5", []), "no bars is not ready");
  ok(!k.seriesReady("XAUUSD", "M5", null), "and neither is nothing at all");
  ok(k.enoughBarsFor("XAUUSD", "M5", bars(5)) === k.seriesReady("XAUUSD", "M5", bars(5)),
    "the old name answers the new question, so no call site is left on the old rule");
}

/* ================================================== 4. every chart */

section("4. all four places the instruction names");

/** The body of a function, comments stripped, so prose proves nothing. */
function body(name) {
  return grab(APP, name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

{
  const veils = body("paintChartVeils");

  // The chart desk.
  ok(/enoughBarsFor\(f\.symbol, f\.timeframe/.test(veils),
    "the EA chart desk is gated");

  // The markets page.
  ok(/seriesReady\(S\.symbol, S\.timeframe, held\)/.test(veils),
    "the markets chart is gated on the same rule, not on holding one bar");
  ok(!/if \(held && held\.length\) clearVeil\(mktBox\)/.test(veils),
    "...and no longer lifts at the first bar it is handed");

  // The expert list.
  ok(/seriesReady\(symbol, tf, held\)/.test(veils),
    "every card in the expert list is gated");
}

{
  const mini = body("paintMiniCharts");
  ok(/if \(!seriesReady\(symbol, tf, bars\)\)/.test(mini),
    "a card does not draw bars that arrived mid-download");
  const drawAt = mini.indexOf("paintMiniChart(cv, symbol, bars)");
  const gateAt = mini.indexOf("if (!seriesReady(symbol, tf, bars))");
  ok(gateAt > 0 && gateAt < drawAt, "...the gate is before the draw, not after it");
  ok(/paintChartVeils\(\);\s*return;/.test(mini),
    "and the card is left showing the download rather than going blank");
}

{
  const replay = body("paintReplay");
  ok(/historyRunning\(bt\.symbol/.test(replay), "the backtest replay chart is gated too");
  ok(/paintVeil\(btBox/.test(replay),
    "...with the same veil and the same numbers as everywhere else");
  const gate = replay.indexOf("historyRunning(bt.symbol");
  const draw = replay.indexOf("requestAnimationFrame(() => drawReplayChart");
  ok(gate > 0 && draw > 0 && gate < draw, "and it is checked before anything is drawn");
  ok(/clearVeil\(btBox\)/.test(replay), "and lifts when the download is done");
}

section("5. nothing partial is put into a chart object");

{
  /* The veil hides the canvas, so this is belt and braces - but a
     partial series fed to setBars is what makes the chart JUMP when
     the rest lands, veil or no veil. */
  const mount = APP.slice(APP.indexOf("const held = cachedCandlesFor(S.chartFocus.symbol"),
                          APP.indexOf("const held = cachedCandlesFor(S.chartFocus.symbol") + 900);
  ok(/if \(held && seriesReady\(S\.chartFocus\.symbol, S\.chartFocus\.timeframe, held\)\)/.test(mount),
    "the chart desk does not paint a cached series that is still growing");

  ok(/if \(S\.chart && seriesReady\(S\.chartFocus\.symbol, S\.chartFocus\.timeframe, S\.candles\)\)/.test(APP),
    "...nor the one the refresh just fetched");
  ok(/if \(eaLive\(\) && seriesReady\(S\.symbol, S\.timeframe, heldM\)\)/.test(APP),
    "the markets page does not either, when it mounts");
  ok(/if \(S\.chart && seriesReady\(symbol, timeframe, S\.candles\)\) S\.chart\.setBars\(S\.candles\);/.test(APP),
    "nor when pickMarket comes back");
}

section("6. the loading state really covers the backtest box");

{
  /* .bt-live-chart is not a .chart-box, so the rule that hides the
     canvas under a veil did not reach it - the veil would have been
     drawn over a visible replay. */
  const css = CHARTCSS.replace(/\/\*[\s\S]*?\*\//g, "");
  ok(/\.bt-live-chart\.is-waiting > canvas/.test(css),
    "the backtest canvas is hidden while its box is waiting");
  ok(/\.chart-box\.is-waiting > canvas/.test(css),
    "...and the original rule is still there for everything else");
  ok(/\.chart-veil \{[^}]*background: rgb\(/.test(css),
    "and the veil is still opaque, so nothing shows through it");
}

console.log("");
console.log(`chart-waits-for-full-download: ${failed ? failed + " of " + (passed + failed) + " checks FAILED" : passed + " checks passed"}`);
process.exit(failed ? 1 : 0);
