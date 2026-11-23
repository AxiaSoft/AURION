/**
 * Two of this round's reports, on the desk's side of the wire.
 *
 *   2. "The live price of each symbol has to be correct and in the
 *      moment, the same as MetaTrader. It is shown much slower."
 *
 *   4. "The signals are not drawn on the newer candles. They have to
 *      reach the last candle whenever there really is a signal there
 *      - I have never once seen a mark on the most recent candles."
 *
 * Both were the same KIND of fault: the data had already arrived and
 * the desk was not putting it where the trader could see it.
 *
 * The price came in on the socket several times a second and was
 * drawn only by the refresh pass, which runs when an account or
 * positions message happens to land - about once a second, in steps,
 * behind the terminal. The marks came back from the engine numbered
 * from the start of the window the ENGINE analysed, and were drawn at
 * that number on an array the DESK owns, which is a different array
 * as soon as the trader drags older history in. Every mark landed a
 * few hundred candles to the left of where it belonged, which on a
 * chart means last month.
 *
 *     node tests/live-price-and-marks.test.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CHARTS = read("apps", "web", "js", "charts.js");
const EA = read("engine", "ea", "AurionBridge.mq5");

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

/** A named top-level function, with its braces balanced. */
function grab(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  const j = src.indexOf("{", i);
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === "{") d += 1;
    else if (src[k] === "}") { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}

/** A class method, by name, with its braces balanced. */
function method(src, name) {
  const i = src.indexOf("\n  " + name + "(");
  if (i < 0) throw new Error("missing method " + name);
  const j = src.indexOf("{", i);
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === "{") d += 1;
    else if (src[k] === "}") { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}

/* ======================================================= 2. the price ==== */

/* A row of the watchlist, small enough to read. */
function row() {
  const cell = () => {
    const el = { textContent: "", classes: new Set() };
    el.classList = {
      add: (...cs) => cs.forEach((c) => el.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => el.classes.delete(c)),
      contains: (c) => el.classes.has(c),
    };
    return el;
  };
  const cells = { ".wl-bid": cell(), ".wl-ask": cell(), ".wl-sp": cell() };
  return { querySelector: (sel) => cells[sel] || null, cells };
}

function priceKit(opts) {
  const S = opts.S;
  const theRow = opts.row;
  const stub = `
    const S = __S;
    const tickMemo = new Map();
    const price = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "—");
    const fmt = (n, dp) => Number(n).toFixed(dp);
    const I18N = { t: (k) => k, lang: "en" };
    const CSS = { escape: (s) => s };
    const document = { querySelector: () => __row, querySelectorAll: () => [] };
    const $ = (id) => __byId[id] || null;
    const liveSymbols = () => (__S.symbols || []).map((s) => ({ symbol: s }));
    const emptyMini = () => "";
    const watchlistHtml = () => "<div class='wl-list'></div>";
  `;
  return new Function("__S", "__row", "__byId",
    stub
    + grab(APP, "watchRowEl") + "\n" + grab(APP, "patchWatchRow") + "\n"
    + grab(APP, "tickLabel") + "\n" + grab(APP, "paintLivePrice")
    + "\nreturn { patchWatchRow, paintLivePrice, tickMemo };")(
    S, theRow, opts.byId || {});
}

{
  const S = { symbol: "EURUSD", symbols: ["EURUSD"],
    snap: { ticks: { EURUSD: { symbol: "EURUSD", bid: 1.2345, ask: 1.2347 } } } };
  const r = row();
  const lbl = { textContent: "" };
  const kit = priceKit({ S, row: r, byId: { "tick-lbl": lbl } });

  kit.paintLivePrice("EURUSD");
  ok(r.cells[".wl-bid"].textContent === "1.23", "a tick writes the bid into the row it already has");
  ok(r.cells[".wl-ask"].textContent === "1.23", "...and the ask");
  ok(/0\.0002/.test(r.cells[".wl-sp"].textContent),
    "the spread keeps the broker's precision - at two decimals it reads 0.00 on every pair");
  ok(/1\.23/.test(lbl.textContent), "the chart's own price label moves with it");

  /* The direction flash. It used to be computed only while the whole
     list was being rebuilt, so a patched row could never show it. */
  S.snap.ticks.EURUSD = { symbol: "EURUSD", bid: 1.2400, ask: 1.2402 };
  kit.paintLivePrice("EURUSD");
  ok(r.cells[".wl-bid"].classes.has("up"), "a rising price still flashes up");
  S.snap.ticks.EURUSD = { symbol: "EURUSD", bid: 1.2300, ask: 1.2302 };
  kit.paintLivePrice("EURUSD");
  ok(r.cells[".wl-bid"].classes.has("down") && !r.cells[".wl-bid"].classes.has("up"),
    "and a falling one flashes down, with the old direction cleared");
}

{
  /* The whole point: the socket handler must not leave this to the
     next refresh pass. */
  const handler = APP.slice(APP.indexOf('if (msg.type === "tick")'),
    APP.indexOf('if (msg.type === "account")'));
  ok(/paintLivePrice\(/.test(handler),
    "a tick repaints the price on the spot, not at the next refresh");
  ok(!/scheduleSync\(\)/.test(handler),
    "a tick no longer waits on the 200ms coalesce before anything is shown");

  const markets = APP.slice(APP.indexOf('if (v === "markets")'), APP.indexOf('if (v === "intelligence")'));
  ok(/paintWatchlist\(\)/.test(markets) && !/box\.innerHTML = symbols\.length/.test(markets),
    "the refresh patches the list instead of rebuilding it under the trader's cursor");
  const wl = grab(APP, "paintWatchlist");
  ok(/_wlKey/.test(wl), "the list is only rebuilt when the symbols in it change");
}

{
  /* The expert's half. A quote used to travel only on the one-second
     heartbeat, bundled with the account, the forming candle and every
     open position. */
  ok(/input int\s+InpTickMs\s*=\s*(\d+);/.test(EA), "the expert has a tick rate of its own");
  const ms = Number(/input int\s+InpTickMs\s*=\s*(\d+);/.exec(EA)[1]);
  ok(ms > 0 && ms <= 250, "and it is fast enough to look live: " + ms + "ms");
  const onTick = EA.slice(EA.indexOf("void OnTick()"), EA.indexOf("void OnTick()") + 800);
  ok(/SendTick\(\)/.test(onTick) && /InpTickMs/.test(onTick),
    "OnTick sends the price rather than leaving it to the heartbeat");
  ok(/g_last_quote/.test(onTick), "and it is rate-limited, so a fast market cannot flood the engine");
  ok(/#define AURION_EA_VERSION "1\.23"/.test(EA), "the expert says which version this is");
}

/* ======================================================= 4. the marks ==== */

{
  /* A chart, with just enough of one to place a mark on. */
  const Chart = new Function("__bars",
    "const bars = __bars;\n"
    + "const self = { bars, _timeIdx: null, _timeIdxLen: -1 };\n"
    + "self.barIndexOfTime = " + method(CHARTS, "barIndexOfTime").replace(/^\s*barIndexOfTime/, "function barIndexOfTime")
    + ";\nreturn self;");

  const bars = Array.from({ length: 500 }, (_, i) => ({ time: "t" + i, close: 1 }));
  const chart = Chart(bars);
  ok(chart.barIndexOfTime.call(chart, "t499") === 499, "the newest bar is found by its own time");
  ok(chart.barIndexOfTime.call(chart, "t0") === 0, "and so is the oldest");
  ok(chart.barIndexOfTime.call(chart, "nope") === -1, "a bar this chart does not hold is refused, not guessed");

  /* The cache must not outlive the array it indexes - that would be
     the same class of bug one level down. */
  chart.bars = bars.concat([{ time: "t500", close: 1 }]);
  ok(chart.barIndexOfTime.call(chart, "t500") === 500, "deeper history re-indexes rather than answering from memory");
}

{
  const paint = method(CHARTS, "paintSignals");
  const timeAt = paint.indexOf("timeMap.has(sig.time)");
  const idxAt = paint.indexOf("Number(sig.index)");
  ok(timeAt > 0 && idxAt > 0 && timeAt < idxAt,
    "a mark is placed by the bar's TIME first; the engine's index is only a fallback");
  ok(/barIndexOfTime/.test(paint),
    "a mark on a bar that is scrolled out of view is placed against the whole series, not dropped");

  const cov = method(CHARTS, "paintSignalCoverage");
  ok(/barIndexOfTime/.test(cov),
    "the 'not analysed yet' boundary is placed by time too, or it shades the wrong candles");
  ok(/cov\.fromTime/.test(cov) && /cov\.nextFromTime/.test(cov),
    "...using the times the engine sends beside each index");
}

{
  /* And the desk must ask again when the series gets deeper, or a
     month of candles is read with the marks of the first few hundred
     bars drawn on it. */
  const handler = APP.slice(APP.indexOf('if (msg.type === "candles")'),
    APP.indexOf('if (msg.type === "account")'));
  ok(/scheduleSignalFill\(/.test(handler),
    "deeper history re-asks for the marks that belong to it");
  ok(/paintHistoryEdge\(\)/.test(handler),
    "and the download line stays up while the rest arrives");
}

console.log(fails ? "\nlive-price-and-marks: " + fails + " check(s) failed" : "\nall good");
process.exit(fails ? 1 : 0);
