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
  /* A floor, not a pin. This check is about the expert ANNOUNCING a
     version at all, so that a copy nobody recompiled is visible to
     the desk - it is not about which version. Pinning the exact
     number means every EA change fails an unrelated test about the
     live price; the version is pinned deliberately, in one place, in
     calendar-backtest-and-kill.test.js. */
  const eaVer = parseFloat((/#define AURION_EA_VERSION "([0-9.]+)"/.exec(EA) || [])[1]);
  ok(eaVer >= 1.25, "the expert says which version this is: v" + eaVer);
}

/* ======================================================= 4. the marks ==== */

{
  /* A chart, with just enough of one to place a mark on. */
  const { barTime: bt } = require(path.join(ROOT, "apps", "web", "js", "charts.js"));
  const Chart = new Function("__bars", "barTime",
    "const bars = __bars;\n"
    + "const self = { bars, _timeIdx: null, _timeIdxLen: -1 };\n"
    + "self.barIndexOfTime = " + method(CHARTS, "barIndexOfTime").replace(/^\s*barIndexOfTime/, "function barIndexOfTime")
    + ";\nreturn self;");

  /* Times, not labels: barIndexOfTime normalises what it is given,
     and a chart's bars are bars. */
  const stamp = (i) => "2026-11-" + String(1 + Math.floor(i / 24)).padStart(2, "0")
    + "T" + String(i % 24).padStart(2, "0") + ":00:00";
  const bars = Array.from({ length: 500 }, (_, i) => ({ time: stamp(i), close: 1 }));
  const chart = Chart(bars, bt);
  ok(chart.barIndexOfTime.call(chart, stamp(499)) === 499, "the newest bar is found by its own time");
  ok(chart.barIndexOfTime.call(chart, stamp(0)) === 0, "and so is the oldest");
  ok(chart.barIndexOfTime.call(chart, "2020-01-01T00:00:00") === -1,
    "a bar this chart does not hold is refused, not guessed");
  ok(chart.barIndexOfTime.call(chart, stamp(499).replace("T", " ") + "+00:00") === 499,
    "...and another spelling of a bar it DOES hold still finds it");

  /* The cache must not outlive the array it indexes - that would be
     the same class of bug one level down. */
  chart.bars = bars.concat([{ time: stamp(500), close: 1 }]);
  ok(chart.barIndexOfTime.call(chart, stamp(500)) === 500,
    "deeper history re-indexes rather than answering from memory");
}

{
  const paint = method(CHARTS, "paintSignals");
  const timeAt = paint.indexOf("timeMap.has(when)");
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

/* ============================ the follow-up: "the candles print broken" === */

/* Reported after the round above shipped:
 *
 *   "The chart in the app is printing its candles broken - lots of
 *    long shadows one after another, and every time the price
 *    changes it draws a new candle. One tick, one new broken candle."
 *
 * They were new candles. Every bar comparison on this side is a
 * string comparison, and the same bar arrived under three spellings:
 * the expert's "2026-11-23T10:00:00", the MetaTrader5 package's
 * "2026-11-23T10:00:00+00:00", and the archive's
 * "2026-11-23 10:00:00". So the forming bar came back as a brand new
 * candle whenever it came back by a different route, and since
 * " " < "T" < "+" the duplicates did not even sort beside their
 * twins - which is why the chart looked shuffled rather than just
 * doubled.
 */
{
  const { barTime, CandleChart } = require(path.join(ROOT, "apps", "web", "js", "charts.js"));

  const spellings = ["2026-11-23T10:00:00", "2026-11-23T10:00:00+00:00",
    "2026-11-23 10:00:00", "2026-11-23T10:00:00Z", "2026-11-23T10:00:00.750+00:00"];
  const one = new Set(spellings.map(barTime));
  ok(one.size === 1 && one.has("2026-11-23T10:00:00"),
    "one bar has one name, whichever route it arrived by: " + [...one].join(" | "));
  ok(barTime("not a time") === "not a time",
    "a string this cannot read comes out unchanged, not half-rewritten");

  /* setBars: the same bar twice is one candle, not two. */
  const chart = Object.create(CandleChart.prototype);
  chart.bars = [];
  chart.span = 120; chart.offset = 0; chart.scale = { auto: true, mn: null, mx: null };
  chart.draw = () => {};
  chart.clampOffset = () => {};
  chart.saveView = () => {};
  chart.rows = () => chart.bars;
  chart.setBars([
    { time: "2026-11-23T09:00:00", open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: "2026-11-23T10:00:00", open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: "2026-11-23T10:00:00+00:00", open: 1, high: 9, low: 0.1, close: 1.9 },
  ]);
  ok(chart.bars.length === 2, "two spellings of one bar are one candle, not two: " + chart.bars.length);

  /* setLastBar: the forming bar updates in place, however it is spelled. */
  chart.setLastBar({ time: "2026-11-23T10:00:00+00:00", open: 1, high: 3, low: 0.4, close: 2.0 });
  ok(chart.bars.length === 2, "the forming bar was appended instead of updated");
  ok(Number(chart.bars[1].close) === 2.0, "...and its new price never landed");

  /* A bar that arrives late must not leave the series out of order -
     an out-of-order series is drawn as exactly the long wicks that
     were reported. */
  chart.setLastBar({ time: "2026-11-23T08:00:00", open: 1, high: 2, low: 0.5, close: 1.1 });
  const times = chart.bars.map((b) => barTime(b.time));
  ok(times.length === 3 && times.join(",") === times.slice().sort().join(","),
    "a late bar left the series out of order: " + times.join(" "));
}

{
  /* And the desk's own socket handler, which keeps S.candles. */
  const handler = APP.slice(APP.indexOf('if (msg.type === "candle")'),
    APP.indexOf('if (msg.type === "hist_progress")'));
  ok(/barTime\(c\.time\)/.test(handler) && /barTime\(b\.time\)/.test(handler),
    "the forming bar is still matched on the raw string, so one tick makes one new candle");
  ok(/barTime\(a\.time\)\.localeCompare\(barTime\(b\.time\)\)/.test(handler),
    "the series is sorted on the raw string, which puts the spellings in separate blocks");
  const merge = grab(APP, "mergeOlder");
  ok(/barTime\(/.test(merge), "an older slab can still re-add bars the chart already holds");
}

/* --- a price belongs to its symbol, not to the chart ----------------
 *
 * Reported, after the desk's own rounding had already been fixed:
 *
 *   "I opened a trade - target 1.3101, stop 1.3094, entry 1.3100 -
 *    and it keeps changing these numbers to 1.3100."
 *
 * Nothing was changing them. The expert serialises its position and
 * order lists with `_Digits`, which is the precision of the CHART IT
 * IS ATTACHED TO - and those two lists are the whole terminal's, not
 * that chart's. An expert sitting on gold reports two decimals for
 * every row, so a GBPUSD position's entry, stop and target all came
 * back as 1.31, on every refresh.
 *
 * Not cosmetic either: the desk's stop rules act on the numbers this
 * feed reports.
 *
 * SendDeals already read each row's own symbol. These checks pin the
 * other two onto the same rule.
 */
{
  ok(/int DigitsOf\(const string symbol\)/.test(EA),
    "there is no per-symbol precision helper to share");
  const helper = EA.slice(EA.indexOf("int DigitsOf(const string symbol)"));
  ok(/SymbolInfoInteger\(symbol, SYMBOL_DIGITS\)/.test(helper.slice(0, 220)),
    "the helper does not ask the symbol itself");
  ok(/digits = _Digits;/.test(helper.slice(0, 260)),
    "a symbol the terminal cannot describe has no fallback");

  /* The DEFINITION, not the forward declaration at the top of the
     file: `EA.indexOf("void SendOrders()")` finds the prototype, and a
     slice taken from there measures a region with no code in it and
     passes however broken the real body is. */
  const bodyOf = (name) => {
    const at = EA.indexOf(name + "\n  {");
    if (at < 0) return "";
    const end = EA.indexOf("\n  }\n", at);
    return EA.slice(at, end > at ? end : at + 3000);
  };
  for (const [name, fields] of [
    ["void SendPositions()", ["price_open", "price_current", "sl", "tp"]],
    ["void SendOrders()", ["price", "sl", "tp"]],
  ]) {
    const body = bodyOf(name);
    ok(Boolean(body), `${name} is gone`);
    ok(/DigitsOf\(/.test(body), `${name} does not take the row's own precision`);
    ok(!/_Digits\)/.test(body),
      `${name} still writes a price at the chart's precision, not the instrument's`);
    for (const f of fields) {
      const line = body.split("\n").find((l) => l.includes(`\\"${f}\\":`));
      ok(Boolean(line), `${name} no longer reports ${f}`);
      ok(line && !/_Digits/.test(line), `${name}'s ${f} is still rounded to the chart`);
    }
  }

  /* The tick and candle feeds are this chart's symbol and only ever
     that, so _Digits is the right answer there - checked so the fix
     above is not "mis-corrected" later into something that costs a
     lookup on every tick. */
  const tickFeed = EA.slice(EA.indexOf('\\"bid\\":'), EA.indexOf('\\"bid\\":') + 400);
  ok(/_Digits/.test(tickFeed), "the tick feed lost the precision it was right to use");

  /* And nothing on a trade path may read the chart any more. */
  const pend = EA.slice(EA.indexOf("void TradePending("));
  const pendBody = pend.slice(0, pend.indexOf("\n  }\n"));
  ok(/NormalizeDouble\(sl, rdig\)/.test(pendBody) && /NormalizeDouble\(tp, rdig\)/.test(pendBody),
    "a resting order's levels are still normalised against the chart");
}

console.log(fails ? "\nlive-price-and-marks: " + fails + " check(s) failed" : "\nall good");
process.exit(fails ? 1 : 0);
