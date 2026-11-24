/**
 * A chart shows its own candles, or it shows that it is loading them.
 *
 *     node tests/chart-shows-its-own-series.test.cjs
 *
 * Two reports, one cause.
 *
 * 1. "The price is 3000 on a symbol. I attach the EA chart, and one
 *    small candle is at the right price while all the other candles
 *    go to a price a thousand higher, or more."
 *
 *    Every one of those others belonged to a different symbol. The
 *    desk keeps the bars it is drawing in S.candles and a separate
 *    note of which symbol the trader is looking at in S.symbol, and
 *    those two disagree for as long as it takes a new symbol's
 *    history to arrive. Attaching the expert is exactly that moment:
 *    adoptEaNow() moves the desk onto the expert's symbol, and the
 *    previous symbol's candles stayed in S.candles - on screen, and
 *    treated as the series to merge the new symbol's live bars into.
 *    So the first real bar of the new symbol was appended to the old
 *    symbol's history: one correct candle, among somebody else's
 *    prices, on one shared y-axis.
 *
 *    The live-bar test read `c.symbol === S.symbol`. S.symbol is
 *    where the desk is LOOKING. S.candlesKey is what S.candles
 *    actually contains. Only the second one can answer "do these bars
 *    belong together".
 *
 * 2. "Everywhere a chart is shown - the expert list, the markets page,
 *    the EA chart itself - it must show the download first, before it
 *    shows a healthy chart."
 *
 *    The same gap seen from the front. A chart of the wrong instrument
 *    is worse than no chart, so the bars go the moment the desk moves,
 *    and what fills the gap is the loading state.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let passed = 0;
let failed = 0;
const ok = (cond, name) => {
  if (cond) { passed += 1; console.log("ok   " + name); }
  else { failed += 1; console.log("  x  " + name); }
};
const section = (t) => console.log("\n— " + t);

const APP = read("apps", "web", "js", "app.js");
const { mergeBar, barTime } = require(path.join(ROOT, "apps/web/js/charts.js"));

/* ========================================================= behaviour == */
section("1. a live bar is only merged into its OWN series");

/* The real merge block, lifted out of app.js and run. Asserting on the
   source would only prove the source says something; this proves what
   the code does with a bar. */
function liveBarKit() {
  const start = APP.indexOf('    const sameTf = Boolean(S.timeframe)');
  const tail = "rememberSeries(S.symbol, S.timeframe, S.candles);";
  const end = APP.indexOf(tail, start);
  if (start < 0 || end < 0) throw new Error("the live-bar merge block moved");
  /* The slice stops inside the if-block, so it is closed here. The
     chart-painting lines are dropped; every merge decision is kept. */
  const body = (APP.slice(start, end + tail.length) + "\n}")
    .replace(/if \(S\.chart\) \{[\s\S]*?\n      \}\n/, "");
  const fn = new Function("S", "c", "mergeBar", "barTime", "seriesKey",
    "scheduleSignalFill", "rememberSeries", body);
  const seriesKey = (s, t) => (s && t ? s + "|" + t : "");
  return (S, c) => fn(S, c, mergeBar, barTime, seriesKey, () => {}, () => {});
}

const applyLiveBar = liveBarKit();

const eurBars = () => ([
  { time: "2026-01-01T10:00:00", open: 1.1000, high: 1.1010, low: 1.0990, close: 1.1005 },
  { time: "2026-01-01T10:15:00", open: 1.1005, high: 1.1015, low: 1.1000, close: 1.1010 },
]);

{
  /* The report, step by step. The desk is on EURUSD; the trader
     attaches the expert to a XAUUSD chart; adoptEaNow() moves
     S.symbol. If only S.symbol is consulted, the XAUUSD bar lands in
     the EURUSD series. */
  const S = {
    symbol: "EURUSD", timeframe: "M15",
    candles: eurBars(), candlesKey: "EURUSD|M15", series: {},
  };
  S.symbol = "XAUUSD";                    // what adoptEaNow used to do

  applyLiveBar(S, {
    symbol: "XAUUSD", timeframe: "M15", time: "2026-01-01T10:30:00",
    open: 3000, high: 3002, low: 2999, close: 3001,
  });

  ok(S.candles.length === 2,
    "a bar for another symbol is not appended to the series on screen");
  const closes = S.candles.map((b) => b.close);
  const spread = Math.max(...closes) / Math.min(...closes);
  ok(spread < 2,
    `the chart does not end up spanning two instruments' prices (${spread.toFixed(0)}x)`);
  ok(!S.candles.some((b) => b.close === 3001),
    "the lone candle at the other symbol's price is nowhere on the chart");
}

{
  /* ...and the ordinary case still works, or the fix is just a way of
     never updating a chart. */
  const S = {
    symbol: "EURUSD", timeframe: "M15",
    candles: eurBars(), candlesKey: "EURUSD|M15", series: {},
  };
  applyLiveBar(S, {
    symbol: "EURUSD", timeframe: "M15", time: "2026-01-01T10:30:00",
    open: 1.1010, high: 1.1020, low: 1.1008, close: 1.1018,
  });
  ok(S.candles.length === 3, "a bar for THIS series is still appended");
  ok(S.candles[2].close === 1.1018, "...with its own numbers");

  applyLiveBar(S, {
    symbol: "EURUSD", timeframe: "M15", time: "2026-01-01T10:30:00",
    open: 1.1010, high: 1.1030, low: 1.1001, close: 1.1025,
  });
  ok(S.candles.length === 3, "a re-send of that bar updates it rather than adding one");
  ok(S.candles[2].high === 1.1030 && S.candles[2].low === 1.1001,
    "...and is merged, so the bar can still grow");
}

{
  /* The timeframe half of the same identity. One MetaTrader chart
     feeds the desk its own timeframe and the desk's. */
  const S = {
    symbol: "EURUSD", timeframe: "M15",
    candles: eurBars(), candlesKey: "EURUSD|M15", series: {},
  };
  applyLiveBar(S, {
    symbol: "EURUSD", timeframe: "H1", time: "2026-01-01T10:00:00",
    open: 1.09, high: 1.15, low: 1.08, close: 1.14,
  });
  ok(S.candles.length === 2 && S.candles[0].high === 1.1010,
    "an H1 bar cannot land in an M15 series and drag its range with it");
}

{
  /* Bars with no identity recorded must not be a wildcard. An empty
     candlesKey used to mean "anything matches" in the symbol test,
     via `!S.symbol`. */
  const S = {
    symbol: "XAUUSD", timeframe: "M15",
    candles: eurBars(), candlesKey: "", series: {},
  };
  applyLiveBar(S, {
    symbol: "XAUUSD", timeframe: "M15", time: "2026-01-01T10:30:00",
    open: 3000, high: 3002, low: 2999, close: 3001,
  });
  ok(S.candles.length === 2,
    "bars of unknown provenance are not a series anything may be merged into");
}

/* ===================================================== the other half == */
section("2. the desk never keeps another symbol's bars on screen");

ok(/function focusSeries\(/.test(APP),
  "moving the desk onto a series is one named operation");

const focus = APP.slice(APP.indexOf("function focusSeries("),
  APP.indexOf("function bindChartDesk"));
ok(/S\.candles = \[\];/.test(focus) && /S\.candlesKey = "";/.test(focus),
  "...and bars that belong to another series are dropped, not redrawn");
ok(/paintChartVeils\(\)/.test(focus),
  "...with the loading state put up in their place");

/* The reported trigger. adoptEaNow is what runs when the expert is
   attached to a symbol the desk was not already on. */
const adopt = APP.slice(APP.indexOf("function adoptEaNow()"),
  APP.indexOf("function primeEaChart()"));
ok(/focusSeries\(/.test(adopt),
  "attaching the expert moves the desk through focusSeries");
ok(!/S\.symbol = agents\[0\]\.symbol/.test(adopt),
  "...rather than moving the symbol and leaving the bars behind");

const pick = APP.slice(APP.indexOf("async function pickMarket("),
  APP.indexOf("const r = await API.post(\"/api/market\""));
ok(/focusSeries\(/.test(pick),
  "switching market does too");

/* focusSeries driven, because dropping bars is only half of it: a
   series the desk already holds must come straight back, or every
   symbol switch would flash a loading state over bars that were
   right there.

   The slice spans focusSeries AND the real cachedCandlesFor and
   seriesKey it depends on, so this runs the actual lookup against a
   real S.series cache rather than a stub standing in for it. */
{
  const body = APP.slice(APP.indexOf("function seriesKey("),
    APP.indexOf("function bindChartDesk("));
  const build = (S) => new Function("S", "paintChartVeils", "SERIES_CACHE_MAX",
    body + "\nreturn focusSeries;")(S, () => {}, 8);

  const gold = [{ time: "t1", open: 3000, high: 3001, low: 2999, close: 3000 }];

  // Warm: the bars come straight back, with no gap for a veil.
  const warmS = {
    symbol: "EURUSD", timeframe: "M15", candles: eurBars(), candlesKey: "EURUSD|M15",
    series: { "XAUUSD|M15": { bars: gold, at: Date.now() } },
  };
  build(warmS)("XAUUSD", "M15");
  ok(warmS.candlesKey === "XAUUSD|M15" && warmS.candles.length === 1
     && warmS.candles[0].close === 3000,
    "switching to a series the desk already holds shows it at once");

  // Cold: the other symbol's bars are dropped, not left on screen.
  const coldS = {
    symbol: "EURUSD", timeframe: "M15", candles: eurBars(), candlesKey: "EURUSD|M15",
    series: {},
  };
  build(coldS)("GBPUSD", "M15");
  ok(coldS.candles.length === 0 && coldS.candlesKey === "",
    "switching to one it does not hold clears the chart rather than lying about it");

  /* And the two together are the reported bug: after a cold switch
     there is nothing for a foreign bar to be merged into. */
  const after = coldS;
  applyLiveBar(after, {
    symbol: "GBPUSD", timeframe: "M15", time: "2026-01-01T10:30:00",
    open: 1.27, high: 1.272, low: 1.269, close: 1.271,
  });
  ok(after.candles.length === 0,
    "a bar arriving before the new series has loaded is not a series of one");
}

/* ========================================================= the veils == */
section("3. a loading state everywhere a chart is shown");

const veils = APP.slice(APP.indexOf("function paintChartVeils()"),
  APP.indexOf("function noteHistoryProgress"));
ok(/\$\("tv-chartbox"\)/.test(veils), "the chart desk has one");
ok(/canvas\[data-mini\]/.test(veils), "the expert list's cards have one");
ok(/\$\("cv"\)/.test(veils), "and the markets chart, which had none, now has one");

/* Driven, not read. The markets veil is new, so it is run against a
   DOM to prove it actually appears and actually says it is loading -
   the source naming $("cv") proves only that the source names it. */
{
  const grab = (src, name) => {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) throw new Error("app.js no longer defines " + name);
    let depth = 0;
    let i = src.indexOf("{", at);
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return src.slice(at, i + 1).replace(src.slice(from, from), "");
  };

  /* The same element stub the veil tests in
     waiting-and-scanning.test.cjs use - paintVeil reaches for
     classList, so a plainer fake throws rather than failing. */
  const mk = (tag) => {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      children: [], className: "", innerHTML: "", hidden: false,
      attrs: {}, parentElement: null, isConnected: true,
      classList: {
        add: (c) => { if (!el.className.split(" ").includes(c)) el.className = (el.className + " " + c).trim(); },
        remove: (c) => { el.className = el.className.split(" ").filter((x) => x && x !== c).join(" "); },
        contains: (c) => el.className.split(" ").includes(c),
      },
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
      appendChild: (kid) => { kid.parentElement = el; el.children.push(kid); return kid; },
      remove: () => {
        if (!el.parentElement) return;
        el.parentElement.children = el.parentElement.children.filter((k) => k !== el);
        el.parentElement = null;
      },
      querySelector: (sel) => {
        const cls = String(sel).replace(":scope > .", "").replace(".", "");
        return el.children.find((k) => k.classList.contains(cls)) || null;
      },
    };
    return el;
  };
  const box = mk();                       // the markets .chart-box
  const cv = mk();                        // #cv inside it
  cv.parentElement = box;

  const S = { symbol: "XAUUSD", timeframe: "M15", histProgress: {}, histDepth: {} };
  const enoughDays = /const VEIL_ENOUGH_DAYS = (\d+);/.exec(APP);
  if (!enoughDays) throw new Error("app.js no longer states VEIL_ENOUGH_DAYS");

  /* VEIL_ENOUGH_DAYS is read out of app.js rather than restated, or
     this harness would keep passing after the real number moved. */
  const kitWith = (cached) => new Function("__S", "__mk", "__byId", "__cached",
    'const S = __S;\n'
    + 'const I18N = { t: (k, v) => k + "|" + JSON.stringify(v || {}) };\n'
    + "const fmt = (n) => String(n);\n"
    + "const esc = (t) => String(t);\n"
    + "const document = { createElement: __mk, querySelectorAll: () => [] };\n"
    + "const $ = (id) => __byId[id] || null;\n"
    + "const cachedCandlesFor = __cached;\n"
    + "const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };\n"
    + "const VEIL_ENOUGH_DAYS = " + enoughDays[1] + ";\n"
    + grab(APP, "veilOf") + "\n" + grab(APP, "historyProgressOf") + "\n"
    + grab(APP, "historyDepthOf") + "\n" + grab(APP, "veilState") + "\n"
    + grab(APP, "paintVeil") + "\n" + grab(APP, "clearVeil") + "\n"
    + grab(APP, "haveBarsFor") + "\n" + grab(APP, "enoughBarsFor") + "\n"
    + grab(APP, "paintChartVeils")
    + "\nreturn { paintChartVeils };")(S, mk, { cv }, cached);

  kitWith(() => null).paintChartVeils();
  const veil = box.querySelector(":scope > .chart-veil");
  ok(Boolean(veil), "the markets chart with no candles is covered");
  ok(/veil_loading|veil_getting/.test(String(veil && veil.innerHTML)),
    "...and says it is downloading, rather than sitting empty");

  /* And it lifts once the bars are really there. A veil that never
     comes down is the same bug wearing a different hat. */
  kitWith(() => [{ time: "t", open: 1, high: 1, low: 1, close: 1 }]).paintChartVeils();
  ok(!box.querySelector(":scope > .chart-veil"),
    "...and comes down once the chart has its own candles");
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
