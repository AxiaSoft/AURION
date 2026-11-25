/**
 * How many decimals a price is written with, per instrument.
 *
 *     node tests/price-precision.test.js
 *
 * Reported: "for symbols whose prices move in a narrow band use four
 * decimals - EURUSD for instance - and up to four for the other narrow
 * ones depending on their price; the rest, the ones with bigger prices,
 * get two."
 *
 * The desk had a flat two everywhere. That came from an earlier and
 * equally real complaint about the broker's five, and it was right for
 * gold at 2338 and an index at 39210. On EURUSD it was useless: a whole
 * session fits inside one hundredth, so the entry, the stop, the target
 * and every axis label all printed 1.08.
 *
 * The rule now, floor two and ceiling four:
 *
 *   - the broker's own digit count when the snapshot carries it,
 *     clamped into that range;
 *   - otherwise the size of the price - >= 100 two, >= 10 three, under
 *     ten four.
 *
 * Run, not grepped. The real functions are lifted out of app.js and
 * charts.js and executed, because the thing that can break here is an
 * arithmetic edge, and a source check would be satisfied by a function
 * that returns the wrong number.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("apps/web/js/app.js");
const CHARTS = read("apps/web/js/charts.js");
const TOOLS = read("apps/web/js/chart-tools.js");

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass++;
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    failures.push(name);
    console.log("  x  " + name + "  \u2014 " + e.message);
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const eq = (got, want, what) => must(got === want, `${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* ------------------------------------------------------- the rig ---- */

const grab = (src, from, to) => {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error("cannot slice at: " + from);
  return src.slice(i, j);
};

/* CandleChart's static ladder, taken whole out of the class body so
   the desk and the chart are measured against the same code that
   ships rather than a copy written here. */
const LADDER = grab(CHARTS, "  static PRICE_DP = 2;", "  static LEVEL_GRAB = 5;");

/** specs: what the snapshot says the broker's digits are. */
function rig(specs) {
  const ctx = {
    console,
    I18N: { locale: () => "en-GB", t: (k) => k },
    S: { snap: { strategy: { money: { specs: specs || {} } } } },
  };
  vm.createContext(ctx);
  /* The class body, verbatim, inside a real class - no rewriting, so
     what is measured here is the code that ships. */
  vm.runInContext("globalThis.CandleChart = class CandleChart {\n" + LADDER + "\n};", ctx);
  vm.runInContext(
    grab(APP, "function specFor(symbol) {", "/**\n * What a price distance is worth")
    + grab(APP, "const PRICE_DP = 2;", "function fmt(n, d = 2, min) {")
    + grab(APP, "function fmt(n, d = 2, min) {", "function markLangPills()"),
    ctx,
  );
  return ctx;
}

/**
 * The three precision methods, lifted off the class and hung on a
 * plain object with the two fields they read.
 *
 * Instantiating a real CandleChart needs a canvas and a layout pass;
 * what is under test here is three short methods, so they are run
 * directly against a stub book. Still the shipped source - the method
 * bodies are sliced out of charts.js, not retyped.
 */
function chartStub(bars, tick) {
  const body = grab(CHARTS, "  fmtPrice(p) {", "  /* ============================================================== layout == */");
  const ctx = { CandleChart: rig().CandleChart, Number, Math };
  vm.createContext(ctx);
  /* A class, because the method bodies are class syntax: no commas
     between them. Nothing in the slice is rewritten. */
  vm.runInContext("globalThis.mk = function(){ class Stub {\n"
    + "  constructor(){ this.bars = []; this.tick = null; this._priceDp = null; this.drew = 0; }\n"
    + "  draw(){ this.drew++; }\n"
    + body + "\n} return new Stub(); };", ctx);
  const o = ctx.mk();
  o.bars = bars || [];
  o.tick = tick || null;
  return o;
}

const SPECS = {
  EURUSD: { digits: 5 }, GBPUSD: { digits: 5 }, USDJPY: { digits: 3 },
  XAGUSD: { digits: 3 }, XAUUSD: { digits: 2 }, US30: { digits: 1 },
  BTCUSD: { digits: 2 },
};

/* ------------------------------------------- the ladder in charts.js --- */

check("the ladder: narrow instruments get more decimals than wide ones", () => {
  const { CandleChart } = rig();
  const table = [
    [1.0865, 4, "EURUSD"], [0.6598, 4, "AUDUSD"], [9.99, 4, "just under ten"],
    [27.42, 3, "silver"], [10, 3, "exactly ten"], [99.99, 3, "just under a hundred"],
    [151.42, 2, "USDJPY"], [100, 2, "exactly a hundred"],
    [2338.4, 2, "gold"], [39210, 2, "an index"], [64000, 2, "crypto"],
  ];
  table.forEach(([p, want, who]) => eq(CandleChart.dpForPrice(p), want, who + " at " + p));
  return table.length + " prices";
});

check("the ladder never answers with nonsense", () => {
  const { CandleChart } = rig();
  /* A chart drawn before any data has landed asks about zero, and a
     count of four on a price of nothing would then be inherited by
     every label once the real prices arrive. */
  [0, -0, null, undefined, NaN, Infinity, "", "abc"].forEach((v) => {
    eq(CandleChart.dpForPrice(v), 2, "dpForPrice(" + JSON.stringify(v) + ")");
  });
  /* The sign of a price is not its size. */
  eq(CandleChart.dpForPrice(-1.0865), 4, "a negative FX price");
  return "falls back to two";
});

check("the floor is two and the ceiling is four", () => {
  const { CandleChart } = rig();
  eq(CandleChart.PRICE_DP_MIN, 2, "floor");
  eq(CandleChart.PRICE_DP_MAX, 4, "ceiling");
  eq(CandleChart.clampDp(5), 4, "a five-digit FX quote");
  eq(CandleChart.clampDp(1), 2, "an index quoted to one");
  eq(CandleChart.clampDp(0), 2, "an instrument quoted whole");
  eq(CandleChart.clampDp(3), 3, "a three-digit quote is left alone");
  eq(CandleChart.clampDp(NaN), 2, "no answer at all");
  return "2 <= dp <= 4";
});

/* ------------------------------------------------- the desk's choice --- */

check("the broker's digit count decides, capped at four", () => {
  const { priceDp } = rig(SPECS);
  eq(priceDp("EURUSD", 1.0865), 4, "EURUSD - five capped to four, the reported case");
  eq(priceDp("USDJPY", 151.42), 3, "USDJPY - three kept, which the price alone would call two");
  eq(priceDp("XAGUSD", 27.42), 3, "silver");
  eq(priceDp("XAUUSD", 2338.4), 2, "gold");
  eq(priceDp("US30", 39210), 2, "an index quoted to one, lifted to two");
  return "5->4, 3->3, 2->2, 1->2";
});

check("a symbol the broker has not described falls back to its price", () => {
  const { priceDp } = rig(SPECS);
  eq(priceDp("NEWPAIR", 1.2345), 4, "an unknown narrow instrument");
  eq(priceDp("NEWINDEX", 18240), 2, "an unknown wide one");
  /* No symbol at all - a figure printed before anything is known
     about it, which is most of the desk's older call sites. */
  eq(priceDp("", 1.0865), 4, "no symbol, narrow price");
  eq(priceDp(undefined, undefined), 2, "nothing at all");
  return "the ladder takes over";
});

check("a broker suffix does not lose the instrument", () => {
  /* Books that quote "EURUSD.m" or "XAUUSD-ECN" are ordinary. Falling
     back to the price would give the same answer for EURUSD by luck
     and the wrong one for a three-digit pair. */
  const { priceDp } = rig({ ...SPECS, "USDJPY.m": { digits: 3 } });
  const r = rig({ "EURUSD.m": { digits: 5 }, "USDJPY.m": { digits: 3 } });
  eq(r.priceDp("EURUSD", 1.0865), 4, "EURUSD against a book calling it EURUSD.m");
  eq(r.priceDp("USDJPY", 151.42), 3, "USDJPY against USDJPY.m - the price alone would say two");
  eq(priceDp("EURUSD", 1.0865), 4, "the exact name still wins");
  return "root match honoured";
});

/* --------------------------------------------------- what it prints --- */

check("a price is printed at its own instrument's precision", () => {
  const { price } = rig(SPECS);
  eq(price(1.0865, "EURUSD"), "1.0865", "EURUSD - this is the whole request");
  eq(price(151.423, "USDJPY"), "151.423", "USDJPY");
  eq(price(2338.4, "XAUUSD"), "2,338.40", "gold");
  eq(price(39210, "US30"), "39,210.00", "an index");
  return "1.0865 / 151.423 / 2,338.40";
});

check("the decimals are pinned, not merely capped", () => {
  /* A column where one row reads 1.09 and the next 1.0865 cannot be
     scanned: the digits do not line up and the short one looks like a
     different instrument. maximumFractionDigits alone did exactly
     that, which is why price() pins the minimum too. */
  const { price, fmt } = rig(SPECS);
  eq(price(1.09, "EURUSD"), "1.0900", "a round FX price keeps its width");
  eq(price(2338, "XAUUSD"), "2,338.00", "a round gold price keeps its width");
  /* And only prices. A count of three trades is not "3.00". */
  eq(fmt(3), "3", "fmt() without a minimum is unchanged");
  eq(fmt(1.5, 2), "1.5", "fmt() still only caps");
  return "min = max for prices, cap only for everything else";
});

check("the fifth digit is gone for good", () => {
  /* The complaint that produced the flat two in the first place.
     Whatever the broker says, nothing on this desk prints five. */
  const { price, priceDp } = rig({ WEIRD: { digits: 8 } });
  eq(priceDp("WEIRD", 1.23456789), 4, "an eight-digit instrument");
  eq(price(1.08451, "WEIRD"), "1.0845", "1.08451 is not printed as five digits");
  return "capped at four";
});

check("a price field carries machine-readable digits, at the same count", () => {
  const { priceField, priceStep } = rig(SPECS);
  /* Not price(): <input type=number> rejects Persian digits and
     thousands separators, silently, leaving the field empty. */
  eq(priceField(1.0865, "EURUSD"), "1.0865", "EURUSD into an input");
  eq(priceField(2338.4, "XAUUSD"), "2338.40", "gold into an input - no grouping");
  eq(priceField(0, "EURUSD"), "", "an empty level stays empty");
  /* The step has to match what is displayed or the arrow keys move a
     digit the field then hides, and the value looks stuck. */
  eq(priceStep("EURUSD", 1.0865), "0.0001", "EURUSD step");
  eq(priceStep("USDJPY", 151.42), "0.001", "USDJPY step");
  eq(priceStep("XAUUSD", 2338.4), "0.01", "gold step");
  return "0.0001 / 0.001 / 0.01";
});

check("Persian digits still come out of price(), and still parse back", () => {
  const ctx = rig(SPECS);
  ctx.I18N.locale = () => "fa-IR";
  const out = ctx.price(1.0865, "EURUSD");
  must(/[\u06F0-\u06F9]/.test(out), "the Persian desk got Latin digits: " + out);
  const ascii = out.replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/\u066B/g, ".").replace(/[\u060C\u066C]/g, "");
  eq(ascii, "1.0865", "folded back to ASCII");
  /* priceField must NOT localise - the input would reject it. */
  eq(ctx.priceField(1.0865, "EURUSD"), "1.0865", "the input's value stayed Latin");
  return out;
});

/* ----------------------------------------------------- on the chart --- */

check("a chart told the count by the desk uses it over its own guess", () => {
  /* USDJPY at 151 reads as "over a hundred, so two" to the ladder,
     and the broker quotes it to three. The desk knows; the chart has
     to take its word. */
  const c = chartStub([{ c: 151.423 }]);
  eq(c.priceDp(), 2, "the ladder's own guess for 151");
  c.setPriceDp(3);
  eq(c.priceDp(), 3, "the desk's answer was ignored");
  eq(c.fmtPrice(151.423), "151.423", "and the label does not use it");
  must(c.drew > 0, "changing the precision did not redraw");
  return "151.423";
});

check("a chart told nothing goes back to reading its own prices", () => {
  /* Switching gold -> EURUSD on a book with no specs for either: the
     chart must not keep gold's two decimals. */
  const c = chartStub([{ c: 2338.4 }]);
  c.setPriceDp(2);
  eq(c.fmtPrice(2338.4), "2338.40", "gold");
  c.bars = [{ c: 1.0865 }];
  c.setPriceDp(null);
  eq(c.fmtPrice(1.0865), "1.0865", "gold's two decimals were carried across to EURUSD");
  return "2338.40 -> 1.0865";
});

check("the chart clamps whatever it is handed", () => {
  const c = chartStub([{ c: 1.0865 }]);
  c.setPriceDp(5);
  eq(c.fmtPrice(1.084513), "1.0845", "a five-digit broker count reached the axis");
  c.setPriceDp(0);
  eq(c.fmtPrice(2338.4), "2338.40", "a whole-number count reached the axis");
  return "clamped to 2..4";
});

check("a chart with no prices yet does not guess high", () => {
  /* Drawn before the first candles land. Four decimals here would be
     inherited by nothing - priceDp is recomputed - but a chart that
     answers NaN or undefined throws inside toFixed. */
  const c = chartStub([]);
  eq(c.priceDp(), 2, "an empty chart");
  eq(c.fmtPrice(1.0865), "1.09", "an empty chart still formats");
  eq(c.fmtPrice("nonsense"), "\u2014", "a non-number is a dash, not a crash");
  return "falls back to two";
});

check("a live tick outranks the last candle", () => {
  /* The newest close can be minutes old on a quiet pair; the tick is
     now. They agree about magnitude almost always, and when they do
     not it is the tick that matches what the axis is drawing. */
  const c = chartStub([{ c: 2338.4 }], { bid: 1.0865 });
  eq(c.priceDp(), 4, "the stale candle won");
  return "tick first";
});


check("the chart takes the count from the desk when it is told", () => {
  const fn = CHARTS.slice(CHARTS.indexOf("  setPriceDp(dp) {"));
  must(/CandleChart\.clampDp\(dp\)/.test(fn), "the chart does not clamp what it is given");
  must(/=== null \|\| dp === undefined/.test(fn), "null cannot put it back on reading the price");
  must(/this\.draw\(\)/.test(fn), "a change of precision does not redraw");
  /* Every price on the chart goes through fmtPrice, so one count
     covers the axis, the crosshair, the OHLC strip and every tag. */
  must(/return n\.toFixed\(this\.priceDp\(\)\)/.test(CHARTS), "fmtPrice no longer asks the instance");
  must(!/toFixed\(CandleChart\.PRICE_DP\)/.test(CHARTS), "something still prints the flat default");
  return "setPriceDp + fmtPrice";
});

check("the count is per chart, not per label", () => {
  /* 99.995 above 100.00 on the same axis reads as extra precision
     rather than a different rule. priceDp() must look at the chart's
     own last price, never at the number being formatted. */
  const fn = CHARTS.slice(CHARTS.indexOf("  priceDp() {"), CHARTS.indexOf("  setPriceDp(dp) {"));
  must(/this\.tick|this\.bars/.test(fn), "it does not consult the chart's own prices");
  must(!/\(p\)/.test(fn), "it is being handed the number to format");
  return "taken from the last close";
});

check("the desk tells the chart, from the broker's own digits", () => {
  const fn = APP.slice(APP.indexOf("function syncChartPrecision(chart, symbol) {"),
                       APP.indexOf("function applyChartLevels(force) {"));
  must(/specFor\(symbol\)/.test(fn), "it does not look the symbol up");
  must(/chart\.setPriceDp\(/.test(fn), "it never reaches the chart");
  must(/: null/.test(fn),
    "an unknown symbol leaves the chart on the previous instrument's count");
  /* Called from the levels pass, which runs on every snapshot - the
     specs arrive seconds after the chart is first drawn. */
  const levels = APP.slice(APP.indexOf("function applyChartLevels(force) {"));
  must(/syncChartPrecision\(S\.chart, symbol\)/.test(levels.slice(0, levels.indexOf("\n}"))),
    "the levels pass does not sync the precision");
  return "specs -> setPriceDp";
});

check("the drawing panel reads the live chart, not the class default", () => {
  /* Run, not read. A guard that only greps for chart.priceDp() is
     satisfied by that call sitting inside an if (false). */
  const body = grab(TOOLS, "  function priceDp() {", "  /** Which properties a kind");
  const ctx = {
    Number,
    global: { CandleChart: { PRICE_DP: 2 } },
    ui: { chart: { priceDp: () => 4 } },
  };
  vm.createContext(ctx);
  vm.runInContext(body.replace(/^  /gm, "") + "\nglobalThis.dp = priceDp;", ctx);
  eq(ctx.dp(), 4,
    "the panel would print a two-decimal coordinate beside a four-decimal axis");
  /* And it still answers on a page where no chart is mounted. */
  ctx.ui.chart = null;
  eq(ctx.dp(), 2, "a panel with no chart throws or returns nothing");
  return "chart first, constant last";
});

check("the ticket's step comes from the instrument, not a constant", () => {
  /* The template reads ${pStep}; what matters is where pStep comes
     from. Pointing it back at the desk-wide PRICE_STEP would leave
     every EURUSD field stepping by 0.01 with the template unchanged. */
  const fn = APP.slice(APP.indexOf("function chartTicketHtml() {"),
                       APP.indexOf('id="ct-price"'));
  must(/const pStep = priceStep\(sym[,)]/.test(fn),
    "the ticket's step is not derived from its symbol: " + (/const pStep = .*/.exec(fn) || [""])[0]);
  return "priceStep(sym, …)";
});

/* ------------------------------------------------ nothing left behind --- */

check("no price on the desk is written with the old flat count", () => {
  /* price() takes a symbol now and every caller that can name one
     must pass it, or that call site is still printing 1.08. */
  const calls = APP.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => /[^.\w]price\(/.test(l))
    .filter(([, l]) => !/function price\(|Not price\(\)|\* /.test(l))
    .filter(([, l]) => /[^.\w]price\([^,)]*\)/.test(l));
  must(calls.length === 0,
    "these still print at the desk default: " + calls.map(([n]) => n).join(", "));
  return "every call site names its instrument";
});

check("the ladder is written once", () => {
  /* The desk keeps a copy only as a fallback for a page with no chart
     engine loaded, and it has to be reachable from app.js alone - but
     the live answer must come from charts.js, or the two can drift
     and the ticket and the axis disagree about a price. */
  const fn = APP.slice(APP.indexOf("function dpForPrice(p) {"), APP.indexOf("const clampDp ="));
  must(/CandleChart\.dpForPrice\(p\)/.test(fn), "app.js no longer defers to the chart engine");
  must(/typeof CandleChart !== "undefined"/.test(fn), "it would throw on a page without charts.js");
  return "charts.js owns it";
});

/* --------------------------------------------------------------------- */

if (failures.length) {
  console.log("\nprice-precision: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nprice-precision: " + pass + " checks passed");
