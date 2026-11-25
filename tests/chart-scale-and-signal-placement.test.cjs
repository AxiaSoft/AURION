/* The chart as the trader sees it: a readable price scale, and marks
 * on the candle they belong to.
 *
 * Two complaints, both about what is drawn rather than about what was
 * fetched:
 *
 *   "the last candle is always lower and the rest sit at the very top,
 *    and the chart is ruined"
 *   "the signals are shown from the middle of the candles, and today's
 *    candles show none at all"
 *
 * The first is the price scale having no opinion about a bar that
 * cannot be true. The second is an exact time match refusing every
 * mark that was timed by the clock instead of by a bar boundary.
 *
 * Run against the real functions lifted out of the real files, not
 * against copies of them - a copy of a fix is not a fix.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CHARTS = fs.readFileSync(path.join(ROOT, "apps/web/js/charts.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");

let ok_ = 0, bad = 0;
function ok(cond, what) {
  if (cond) { ok_ += 1; console.log("ok   " + what); }
  else { bad += 1; console.log("  x  " + what); }
}
function section(t) { console.log("\n— " + t); }

/** A named function, lifted whole out of a source file. */
function liftFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  let i = src.indexOf("{", at), depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") { depth -= 1; if (!depth) return src.slice(at, j + 1); }
  }
  throw new Error("unterminated " + name);
}

/** A method body, lifted off the CandleChart class as a free function. */
function liftMethod(src, name) {
  const at = src.indexOf("\n  " + name + "(");
  if (at < 0) throw new Error("no method " + name);
  let i = src.indexOf("{", at), depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") { depth -= 1; if (!depth) return src.slice(at, j + 1).trim(); }
  }
  throw new Error("unterminated " + name);
}

/* ======================================================= 1. the scale == */
section("1. one impossible bar does not decide the whole scale");

/* The range arithmetic, lifted out of the layout function by taking
   the block between its own two markers. Running it is the point:
   grepping for "Number.isFinite" would pass against a deleted
   guard. */
const rangeSrc = (() => {
  const from = CHARTS.indexOf("/* ---- price range ---");
  const to = CHARTS.indexOf("for (const lv of this.levels || [])", from);
  if (from < 0 || to < 0) throw new Error("the price range block has moved");
  return CHARTS.slice(from, to);
})();

function rangeOf(rows) {
  const box = { rows, Math, Number, mn: undefined, mx: undefined };
  vm.createContext(box);
  /* The block declares mn and mx itself, so it is run as-is and the
     values are read out afterwards. */
  vm.runInContext(rangeSrc + "\nthis.mn = mn; this.mx = mx;", box);
  return { mn: box.mn, mx: box.mx };
}

const gold = [];
for (let i = 0; i < 200; i += 1) {
  const p = 3000 + (i % 7);
  gold.push({ l: p - 2, h: p + 2, c: p });
}

{
  const clean = rangeOf(gold);
  ok(clean.mn >= 2990 && clean.mx <= 3010,
    "an ordinary chart is scaled to its own prices");

  /* The reported picture: one bar from a 1.07 instrument among
     candles at 3000. */
  const withIntruder = rangeOf(gold.concat([{ l: 1.069, h: 1.071, c: 1.07 }]));
  ok(withIntruder.mn >= 2990,
    "a bar at another instrument's price does not drag the floor to 1");
  const span = withIntruder.mx - withIntruder.mn;
  ok(span < 100,
    "...so the real candles keep the full height of the chart instead of a sliver");
  ok(Math.abs(span - (clean.mx - clean.mn)) < 1e-9,
    "...and the scale is exactly what it would have been without the intruder");
}

{
  /* The other half: a bar that cannot be priced at all. */
  const withNaN = rangeOf(gold.concat([{ l: NaN, h: NaN, c: NaN }]));
  ok(Number.isFinite(withNaN.mn) && Number.isFinite(withNaN.mx),
    "an unpriceable bar does not turn the whole range into NaN");

  const allBad = rangeOf([{ l: NaN, h: NaN, c: NaN }]);
  ok(Number.isFinite(allBad.mn) && Number.isFinite(allBad.mx),
    "...and a view where nothing can be priced still yields a usable range");
}

{
  /* The guard must not start editing real markets. A market that
     doubles, or halves, is a market - not a fault. */
  const volatile = [];
  for (let i = 0; i < 200; i += 1) {
    const p = 1000 + i * 15;          // 1000 -> 3985 across the window
    volatile.push({ l: p - 5, h: p + 5, c: p });
  }
  const r = rangeOf(volatile);
  ok(r.mn <= 1000 && r.mx >= 3985,
    "a market that quadrupled is still shown whole, not clipped");
}

/* ===================================================== 2. norm() zeros == */
section("2. a price of zero is a number, not a missing field");

const normFn = (() => {
  const box = { Number };
  vm.createContext(box);
  vm.runInContext("this.norm = function " + liftMethod(CHARTS, "norm").replace(/^norm/, "") + ";", box);
  return box.norm;
})();

{
  const n = normFn({ time: "t", open: 3000, high: 3002, low: 2998, close: 3001 });
  ok(n.l === 2998 && n.h === 3002, "an ordinary bar comes through unchanged");

  const z = normFn({ time: "t", open: 0, high: 0, low: 0, close: 0 });
  ok(z.l === 0 && z.o === 0,
    "a bar priced at zero reads as zero, not as NaN - `+b.low || +b.l` lost it");

  const short = normFn({ time: "t", o: 1.1, h: 1.2, l: 1.0, c: 1.15 });
  ok(short.l === 1.0 && short.c === 1.15, "the short spelling is still understood");

  const missing = normFn({ time: "t", open: 1, high: 2, close: 1.5 });
  ok(Number.isNaN(missing.l), "a genuinely absent low is NaN, for the range to skip");
}

/* ================================================== 3. signal placement == */
section("3. a mark belongs to the candle it falls inside");

const covering = (() => {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    "function barTime(v){ return String((v && v.time) || v || \"\"); }\n"
    + "this.make = function (bars) {\n"
    + "  const self = { bars, barIndexOfTime(t) {\n"
    + "    const key = barTime(t);\n"
    + "    for (let i = 0; i < bars.length; i += 1) if (barTime(bars[i].time) === key) return i;\n"
    + "    return -1;\n"
    + "  } };\n"
    + "  self.barIndexCovering = " + liftMethod(CHARTS, "barIndexCovering").replace(/^barIndexCovering/, "function") + ";\n"
    + "  return self;\n"
    + "};", box);
  return box.make;
})();

{
  const bars = [
    { time: "2026-01-01T10:00:00" },
    { time: "2026-01-01T10:15:00" },
    { time: "2026-01-01T10:30:00" },
  ];
  const c = covering(bars);

  ok(c.barIndexCovering("2026-01-01T10:15:00") === 1,
    "a mark stamped on a bar boundary still lands on that bar");
  ok(c.barIndexCovering("2026-01-01T10:37:00") === 2,
    "a mark found at 10:37 belongs to the 10:30 candle, not to nothing at all");
  ok(c.barIndexCovering("2026-01-01T10:00:30") === 0,
    "...including half a minute into the first candle");
  ok(c.barIndexCovering("2026-01-01T09:59:00") === -1,
    "a moment before the chart starts belongs to no candle on it");
  ok(c.barIndexCovering("2026-01-01T10:44:00") === 2,
    "a moment inside the bar still forming belongs to that bar - today's marks");
  ok(c.barIndexCovering("") === -1, "an unstamped mark is refused rather than guessed at");
}

{
  /* Wiring: the two places that place marks must use it. */
  /* Sliced from each method's DEFINITION - "paintSignals(L)" also
     matches the call site a thousand lines earlier, which was how
     the first version of this check read an empty slice and passed
     for the wrong reason. */
  const defAt = (name) => CHARTS.indexOf("\n  " + name + "(L) {");
  const paint = CHARTS.slice(defAt("paintSignals"), defAt("paintLiveSignals"));
  ok(paint.length > 500 && /barIndexCovering\(sig\.time\)/.test(paint),
    "the signal painter asks which candle the mark falls in");
  const live = CHARTS.slice(defAt("paintLiveSignals"), defAt("paintLiveSignals") + 3000);
  ok(live.length > 500 && /barIndexCovering\(sig\.time\)/.test(live),
    "and so does the forming-mark painter, which is where today's marks go");
}

/* ============================================ 4. bars that disown a name == */
section("4. the desk checks that bars claim the series they are filed under");

const barsSaySeries = (() => {
  const box = { String, Array, console };
  vm.createContext(box);
  vm.runInContext(liftFn(APP, "barsSaySeries") + "\nthis.fn = barsSaySeries;", box);
  return box.fn;
})();

{
  const mine = [{ symbol: "XAUUSD", close: 3000 }, { symbol: "XAUUSD", close: 3001 }];
  ok(barsSaySeries(mine, "XAUUSD") === true, "this symbol's own bars are accepted");
  ok(barsSaySeries(mine, "xauusd") === true, "...whatever the case they are written in");

  const theirs = [{ symbol: "EURUSD", close: 1.07 }, { symbol: "EURUSD", close: 1.08 }];
  ok(barsSaySeries(theirs, "XAUUSD") === false,
    "bars that say they are another symbol's are refused - the wrong-price candles");

  const drifted = [{ symbol: "XAUUSD", close: 3000 }, { symbol: "EURUSD", close: 1.07 }];
  ok(barsSaySeries(drifted, "XAUUSD") === false, "a slab that drifts mid-stream is caught");

  const bare = [{ close: 3000 }, { close: 3001 }];
  ok(barsSaySeries(bare, "XAUUSD") === true,
    "bare OHLC still passes - the backtester and older engines send no symbol");
  ok(barsSaySeries([], "XAUUSD") === true, "an empty answer is not a wrong one");
}

{
  /* Wiring: every door bars come in through. */
  const hist = APP.slice(APP.indexOf("async function loadHistory("), APP.indexOf("async function loadOlderSlab("));
  ok(/barsSaySeries\(bars, f\.symbol\)/.test(hist) || /barsSaySeries\(/.test(hist),
    "the history fetch checks before it adopts");
  const older = APP.slice(APP.indexOf("async function loadOlderSlab("), APP.indexOf("async function loadOlderSlab(") + 3000);
  ok(/barsSaySeries\(older, f\.symbol\)/.test(older),
    "the older-slab merge checks before it prepends");
  const sock = APP.slice(APP.indexOf('if (msg.type === "candles")'), APP.indexOf('if (msg.type === "candles")') + 2500);
  ok(/barsSaySeries\(incoming/.test(sock), "and so does the socket broadcast");
}

console.log("\n" + ok_ + " ok, " + bad + " failed");
process.exit(bad ? 1 : 0);
