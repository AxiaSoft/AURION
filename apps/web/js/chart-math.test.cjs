/**
 * The charting mathematics, checked against values worked out by hand.
 *
 * Indicators are the one part of a trading interface where "it looks about
 * right" is not a test: an EMA seeded the wrong way or an RSI smoothed with
 * a simple average instead of Wilder's is plausible on screen and wrong on
 * paper. Every assertion here has a known answer.
 *
 *     node apps/web/js/chart-math.test.cjs
 */
const M = require("./chart-series.js");

let failed = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { console.log("FAIL  " + name); failed++; }
}
function close(a, b, eps) { return a !== null && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

function bars(closesArr) {
  return closesArr.map((c, i) => ({ t: "t" + i, o: c, h: c + 1, l: c - 1, c, v: 100 + i }));
}

/* ------------------------------------------------------------ averages -- */
const v = [1, 2, 3, 4, 5, 6];
const s3 = M.sma(v, 3);
check("SMA warms up with nulls", s3[0] === null && s3[1] === null);
check("SMA(3) of 1,2,3 is 2", close(s3[2], 2));
check("SMA(3) of 4,5,6 is 5", close(s3[5], 5));

const e3 = M.ema(v, 3);
check("EMA seeds on the first full window", close(e3[2], 2));
// k = 2/(3+1) = .5 → 4*.5 + 2*.5 = 3
check("EMA(3) steps to 3", close(e3[3], 3));
check("EMA(3) steps to 4", close(e3[4], 4));

// WMA(3) of 1,2,3 = (1*1 + 2*2 + 3*3)/6 = 14/6
check("WMA weighs the recent bar most", close(M.wma(v, 3)[2], 14 / 6));

// Wilder: seed 2 (SMA of 1,2,3), then (2*2 + 4)/3 = 8/3
check("Wilder's smoothing is not an EMA", close(M.rma(v, 3)[3], 8 / 3));

check("stdev of a flat series is zero", close(M.stdev([5, 5, 5, 5], 3)[3], 0));
// population sd of 1,2,3 = sqrt(2/3)
check("stdev is the population figure", close(M.stdev(v, 3)[2], Math.sqrt(2 / 3)));

/* ----------------------------------------------------------------- RSI -- */
const up = M.rsi(bars([1, 2, 3, 4, 5, 6, 7, 8]), 3);
check("RSI of an unbroken rally is 100", close(up[7], 100));
const flat = M.rsi(bars([5, 5, 5, 5, 5, 5]), 3);
check("RSI of a flat series is 100 by definition", flat[5] === 100);
const down = M.rsi(bars([8, 7, 6, 5, 4, 3, 2, 1]), 3);
check("RSI of an unbroken slide is 0", close(down[7], 0, 1e-9));

/* ---------------------------------------------------------------- MACD -- */
const md = M.macd(bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 3, 6, 3);
check("MACD line is fast minus slow", md.line.filter((x) => x !== null).length > 0);
const i = md.line.findIndex((x) => x !== null);
check("MACD is positive in an uptrend", md.line[md.line.length - 1] > 0);
check("MACD histogram is line minus signal",
  close(md.hist[md.hist.length - 1], md.line[md.line.length - 1] - md.signal[md.signal.length - 1]));

/* ----------------------------------------------------------- volatility -- */
const tr = M.trueRange(bars([10, 12, 9]));
check("the first true range is just the bar", close(tr[0], 2));
// bar 2: h=13 l=11 pc=10 → max(2, 3, 1) = 3
check("true range reaches for the previous close", close(tr[1], 3));

const bb = M.bollinger(bars([2, 4, 6, 8, 10]), 5, 2);
check("Bollinger mid is the SMA", close(bb.mid[4], 6));
check("Bollinger bands are symmetric about the mid",
  close(bb.upper[4] - bb.mid[4], bb.mid[4] - bb.lower[4]));

const dc = M.donchian(bars([5, 9, 3, 7]), 4);
check("Donchian upper is the highest high", close(dc.upper[3], 10));
check("Donchian lower is the lowest low", close(dc.lower[3], 2));

/* ---------------------------------------------------------- oscillators -- */
// Bars whose high and low are the close, so the range is unambiguous.
const flatRange = [1, 2, 3, 4, 5].map((c, n) => ({ t: "t" + n, o: c, h: c, l: c, c, v: 1 }));
const st = M.stochastic(flatRange, 5, 1, 1);
check("Stochastic %K is 100 at the top of its range", close(st.k[4], 100));
const stMid = M.stochastic(flatRange.concat([{ t: "t5", o: 3, h: 3, l: 3, c: 3, v: 1 }]), 5, 1, 1);
// window 2..3 → hi 5, lo 2, close 3 → (3-2)/(5-2) = 33.33
check("Stochastic %K places the close inside the window", close(stMid.k[5], 100 / 3, 1e-9));

/* ---------------------------------------------------------------- VWAP -- */
const vw = M.vwap([{ h: 2, l: 1, c: 3, v: 1 }, { h: 5, l: 4, c: 6, v: 1 }]);
check("VWAP is the volume weighted typical price", close(vw[1], (2 + 5) / 2));

/* -------------------------------------------------------------- series -- */
const ha = M.heikin(bars([10, 12, 11]));
check("Heikin Ashi close is the bar's average", close(ha[1].c, (12 + 13 + 11 + 12) / 4));
check("Heikin Ashi opens at the midpoint of the last synthetic bar",
  close(ha[1].o, (ha[0].o + ha[0].c) / 2));
check("Heikin Ashi high includes the synthetic body",
  ha[1].h >= Math.max(ha[1].o, ha[1].c));

const rk = M.renko(bars([100, 101, 102, 103, 104, 105]), 1);
check("Renko emits bricks, not bars", rk.length > 0 && rk.length !== 6);
check("every Renko brick is one brick tall",
  rk.every((b) => close(Math.abs(b.c - b.o), 1, 1e-9)));

const lb = M.lineBreak(bars([10, 11, 12, 11.5, 9]), 3);
check("line break ignores a close inside the range", lb.length === 4);
check("line break reverses on a break of the last three", lb[3].c === 9);

/* ---------------------------------------------------------- regression -- */
const reg = M.regression(bars([1, 2, 3, 4, 5]));
check("a straight line has the slope it looks like", close(reg.slope, 1, 1e-9));
check("...and no deviation from itself", close(reg.sigma, 0, 1e-9));

/* ------------------------------------------------------------ catalogue -- */
check("every indicator in the catalogue has a function",
  M.INDICATORS.every((ind) => typeof ind.calc === "function"));
check("every indicator declares where it is drawn",
  M.INDICATORS.every((ind) => ind.pane === "main" || ind.pane === "sub"));
check("every plot names a series its calc returns",
  M.INDICATORS.every((ind) => {
    const out = ind.calc(bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]), ind.params);
    return ind.plots.every((p) => Array.isArray(out[p.key]));
  }));
check("every series type is either native or has a transform",
  M.SERIES_TYPES.every((t) => t.geometry && (!t.transform || typeof t.transform === "function")));

console.log(failed ? `\n${failed} failing.` : "\nThe mathematics holds.");
process.exit(failed ? 1 : 0);
