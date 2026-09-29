/* ===========================================================================
   AURION — series transforms and indicator mathematics
   ===========================================================================
   Everything in this file is pure: bars in, numbers out. No canvas, no DOM.
   That is deliberate - it is the half of the charting stack that can be
   tested without a browser, and apps/web/js/chart-math.test.cjs does exactly
   that against hand-computed values.

   A "row" is the engine's normalised bar: { t, o, h, l, c, v }.

   Two rules hold throughout:

     1. Nothing here invents data. A transform that cannot be computed from
        OHLCV is not in this file, and is not offered in the interface.
     2. Every series returns one value per input row, with null for the
        warm-up period, so a plot never has to guess where a line starts.
   =========================================================================== */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ util */

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  /** Simple moving average over a field, null until the window is full. */
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    let sum = 0, have = 0;
    for (let i = 0; i < values.length; i++) {
      const v = num(values[i]);
      if (v === null) { sum = 0; have = 0; continue; }
      sum += v; have++;
      if (have > period) { sum -= num(values[i - period]) || 0; have = period; }
      if (have === period) out[i] = sum / period;
    }
    return out;
  }

  /** Exponential moving average, seeded with the first SMA so it is stable. */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    const k = 2 / (period + 1);
    let prev = null, sum = 0, have = 0;
    for (let i = 0; i < values.length; i++) {
      const v = num(values[i]);
      if (v === null) continue;
      if (prev === null) {
        sum += v; have++;
        if (have === period) { prev = sum / period; out[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** Weighted moving average - recent bars weigh proportionally more. */
  function wma(values, period) {
    const out = new Array(values.length).fill(null);
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < values.length; i++) {
      let acc = 0, ok = true;
      for (let j = 0; j < period; j++) {
        const v = num(values[i - period + 1 + j]);
        if (v === null) { ok = false; break; }
        acc += v * (j + 1);
      }
      if (ok) out[i] = acc / denom;
    }
    return out;
  }

  /** Wilder's smoothing - the average ATR and RSI are actually defined with. */
  function rma(values, period) {
    const out = new Array(values.length).fill(null);
    let prev = null, sum = 0, have = 0;
    for (let i = 0; i < values.length; i++) {
      const v = num(values[i]);
      if (v === null) continue;
      if (prev === null) {
        sum += v; have++;
        if (have === period) { prev = sum / period; out[i] = prev; }
        continue;
      }
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
    return out;
  }

  /** Population standard deviation over a rolling window. */
  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let j = 0; j < period; j++) {
        const v = num(values[i - j]);
        if (v === null) { ok = false; break; }
        sum += v;
      }
      if (!ok) continue;
      const mean = sum / period;
      let acc = 0;
      for (let j = 0; j < period; j++) acc += Math.pow(num(values[i - j]) - mean, 2);
      out[i] = Math.sqrt(acc / period);
    }
    return out;
  }

  function closes(rows) { return rows.map((r) => r.c); }
  function highs(rows) { return rows.map((r) => r.h); }
  function lows(rows) { return rows.map((r) => r.l); }
  function hlc3(rows) { return rows.map((r) => (r.h + r.l + r.c) / 3); }

  /** True range per bar - the first bar has no previous close to reach for. */
  function trueRange(rows) {
    return rows.map((r, i) => {
      if (i === 0) return r.h - r.l;
      const pc = rows[i - 1].c;
      return Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc));
    });
  }

  function atr(rows, period) { return rma(trueRange(rows), period); }

  /** Relative strength index, Wilder. Flat input gives 100 by definition. */
  function rsi(rows, period) {
    const gains = [], losses = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === 0) { gains.push(null); losses.push(null); continue; }
      const d = rows[i].c - rows[i - 1].c;
      gains.push(Math.max(0, d));
      losses.push(Math.max(0, -d));
    }
    const ag = rma(gains, period);
    const al = rma(losses, period);
    return ag.map((g, i) => {
      if (g === null || al[i] === null) return null;
      if (al[i] === 0) return 100;
      const rs = g / al[i];
      return 100 - 100 / (1 + rs);
    });
  }

  function macd(rows, fast, slow, signal) {
    const c = closes(rows);
    const f = ema(c, fast), s = ema(c, slow);
    const line = f.map((v, i) => (v === null || s[i] === null ? null : v - s[i]));
    const sig = ema(line, signal);
    const hist = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]));
    return { line, signal: sig, hist };
  }

  function bollinger(rows, period, mult) {
    const c = closes(rows);
    const mid = sma(c, period);
    const sd = stdev(c, period);
    return {
      mid,
      upper: mid.map((m, i) => (m === null || sd[i] === null ? null : m + sd[i] * mult)),
      lower: mid.map((m, i) => (m === null || sd[i] === null ? null : m - sd[i] * mult)),
    };
  }

  function donchian(rows, period) {
    const up = new Array(rows.length).fill(null);
    const dn = new Array(rows.length).fill(null);
    const mid = new Array(rows.length).fill(null);
    for (let i = period - 1; i < rows.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < period; j++) {
        hi = Math.max(hi, rows[i - j].h);
        lo = Math.min(lo, rows[i - j].l);
      }
      up[i] = hi; dn[i] = lo; mid[i] = (hi + lo) / 2;
    }
    return { upper: up, lower: dn, mid };
  }

  /**
   * Stochastic oscillator. %K over `period`, smoothed by `smoothK`, and %D as
   * the moving average of that.
   */
  function stochastic(rows, period, smoothK, smoothD) {
    const raw = new Array(rows.length).fill(null);
    for (let i = period - 1; i < rows.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = 0; j < period; j++) {
        hi = Math.max(hi, rows[i - j].h);
        lo = Math.min(lo, rows[i - j].l);
      }
      raw[i] = hi === lo ? 50 : ((rows[i].c - lo) / (hi - lo)) * 100;
    }
    const k = smoothK > 1 ? sma(raw, smoothK) : raw;
    return { k, d: sma(k, smoothD) };
  }

  /**
   * Volume-weighted average price over the visible window.
   *
   * A true VWAP resets at the session open; the desk charts a rolling window
   * of bars whose session boundaries it cannot always know, so this is
   * anchored at the first bar handed to it and labelled "anchored VWAP" in
   * the interface rather than pretending to be the session figure.
   */
  function vwap(rows) {
    let pv = 0, vol = 0;
    return rows.map((r) => {
      const v = r.v > 0 ? r.v : 1;
      pv += ((r.h + r.l + r.c) / 3) * v;
      vol += v;
      return vol ? pv / vol : null;
    });
  }

  /* -------------------------------------------------------------- series -- */

  /**
   * Heikin Ashi. The close is the bar's average, the open is the midpoint of
   * the previous synthetic bar, and the extremes take the real ones into
   * account - which is what smooths the series.
   */
  function heikin(rows) {
    const out = [];
    let po = null, pc = null;
    for (const r of rows) {
      const c = (r.o + r.h + r.l + r.c) / 4;
      const o = po === null ? (r.o + r.c) / 2 : (po + pc) / 2;
      out.push({
        t: r.t, o, c, v: r.v,
        h: Math.max(r.h, o, c),
        l: Math.min(r.l, o, c),
      });
      po = o; pc = c;
    }
    return out;
  }

  /**
   * Renko. Bricks of a fixed price size, drawn only when price has actually
   * travelled that far, so time is no longer the x axis.
   *
   * The brick size defaults to the ATR of the series rather than a round
   * number: a fixed 10-pip brick is meaningless on an index and invisible on
   * a currency pair.
   */
  function renko(rows, size) {
    if (!rows.length) return [];
    let brick = Number(size) || 0;
    if (!brick) {
      const a = atr(rows, Math.min(14, Math.max(2, rows.length - 1)));
      const last = a.filter((v) => v !== null).pop();
      brick = last || (rows[0].c * 0.002) || 1;
    }
    if (!(brick > 0)) return [];
    const out = [];
    let base = Math.floor(rows[0].c / brick) * brick;
    for (const r of rows) {
      let guard = 0;
      while (r.c >= base + brick * 2 && guard++ < 500) {
        out.push({ t: r.t, o: base + brick, c: base + brick * 2, h: base + brick * 2, l: base + brick, v: r.v });
        base += brick;
      }
      while (r.c <= base - brick && guard++ < 500) {
        out.push({ t: r.t, o: base, c: base - brick, h: base, l: base - brick, v: r.v });
        base -= brick;
      }
    }
    return out;
  }

  /**
   * Line Break. A new block is drawn when the close passes the extreme of the
   * last `count` blocks - the classic three-line break by default.
   */
  function lineBreak(rows, count) {
    const n = Math.max(1, Number(count) || 3);
    const out = [];
    for (const r of rows) {
      if (!out.length) {
        out.push({ t: r.t, o: r.o, c: r.c, h: Math.max(r.o, r.c), l: Math.min(r.o, r.c), v: r.v });
        continue;
      }
      const look = out.slice(-n);
      const hi = Math.max(...look.map((b) => Math.max(b.o, b.c)));
      const lo = Math.min(...look.map((b) => Math.min(b.o, b.c)));
      const last = out[out.length - 1];
      if (r.c > hi) out.push({ t: r.t, o: Math.max(last.o, last.c), c: r.c, h: r.c, l: Math.max(last.o, last.c), v: r.v });
      else if (r.c < lo) out.push({ t: r.t, o: Math.min(last.o, last.c), c: r.c, h: Math.min(last.o, last.c), l: r.c, v: r.v });
    }
    return out;
  }

  /** Least-squares fit over the closes: slope and intercept in bar space. */
  function regression(rows) {
    const n = rows.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sx += i; sy += rows[i].c; sxy += i * rows[i].c; sxx += i * i;
    }
    const denom = n * sxx - sx * sx;
    if (!denom) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.pow(rows[i].c - (intercept + slope * i), 2);
    return { slope, intercept, sigma: Math.sqrt(dev / n) };
  }

  /* ---------------------------------------------------------- the catalogue */

  /**
   * Every indicator the desk can actually compute, with where it is drawn and
   * what it is made of. The interface is generated from this table, so an
   * indicator cannot appear in the picker without a function behind it.
   *
   *   pane "main"  drawn over the candles
   *   pane "sub"   drawn in its own strip under the chart
   */
  const INDICATORS = [
    {
      id: "sma", group: "ma", pane: "main", short: "SMA",
      params: { period: 20 },
      plots: [{ key: "line", kind: "line", color: "gold" }],
      calc: (rows, p) => ({ line: sma(closes(rows), p.period) }),
    },
    {
      id: "ema", group: "ma", pane: "main", short: "EMA",
      params: { period: 50 },
      plots: [{ key: "line", kind: "line", color: "violet" }],
      calc: (rows, p) => ({ line: ema(closes(rows), p.period) }),
    },
    {
      id: "wma", group: "ma", pane: "main", short: "WMA",
      params: { period: 20 },
      plots: [{ key: "line", kind: "line", color: "accent" }],
      calc: (rows, p) => ({ line: wma(closes(rows), p.period) }),
    },
    {
      id: "bb", group: "volatility", pane: "main", short: "BB",
      params: { period: 20, mult: 2 },
      plots: [
        { key: "upper", kind: "line", color: "violet" },
        { key: "mid", kind: "line", color: "muted", dash: true },
        { key: "lower", kind: "line", color: "violet" },
      ],
      band: ["upper", "lower"],
      calc: (rows, p) => bollinger(rows, p.period, p.mult),
    },
    {
      id: "donchian", group: "volatility", pane: "main", short: "DC",
      params: { period: 20 },
      plots: [
        { key: "upper", kind: "line", color: "up" },
        { key: "mid", kind: "line", color: "muted", dash: true },
        { key: "lower", kind: "line", color: "down" },
      ],
      band: ["upper", "lower"],
      calc: (rows, p) => donchian(rows, p.period),
    },
    {
      id: "vwap", group: "volume", pane: "main", short: "VWAP",
      params: {},
      plots: [{ key: "line", kind: "line", color: "gold" }],
      calc: (rows) => ({ line: vwap(rows) }),
    },
    {
      id: "volume", group: "volume", pane: "sub", short: "Vol", height: 0.16,
      params: { ma: 20 },
      plots: [
        { key: "bars", kind: "histogram", color: "direction" },
        { key: "ma", kind: "line", color: "gold" },
      ],
      zero: true,
      calc: (rows, p) => ({
        bars: rows.map((r) => r.v || 0),
        ma: sma(rows.map((r) => r.v || 0), p.ma),
      }),
    },
    {
      id: "rsi", group: "momentum", pane: "sub", short: "RSI", height: 0.2,
      params: { period: 14 },
      range: [0, 100], guides: [30, 50, 70],
      plots: [{ key: "line", kind: "line", color: "violet" }],
      calc: (rows, p) => ({ line: rsi(rows, p.period) }),
    },
    {
      id: "macd", group: "momentum", pane: "sub", short: "MACD", height: 0.2,
      params: { fast: 12, slow: 26, signal: 9 },
      guides: [0],
      plots: [
        { key: "hist", kind: "histogram", color: "signed" },
        { key: "line", kind: "line", color: "accent" },
        { key: "signal", kind: "line", color: "gold" },
      ],
      calc: (rows, p) => macd(rows, p.fast, p.slow, p.signal),
    },
    {
      id: "stoch", group: "momentum", pane: "sub", short: "Stoch", height: 0.2,
      params: { period: 14, smoothK: 3, smoothD: 3 },
      range: [0, 100], guides: [20, 80],
      plots: [
        { key: "k", kind: "line", color: "accent" },
        { key: "d", kind: "line", color: "gold" },
      ],
      calc: (rows, p) => stochastic(rows, p.period, p.smoothK, p.smoothD),
    },
    {
      id: "atr", group: "volatility", pane: "sub", short: "ATR", height: 0.16,
      params: { period: 14 },
      plots: [{ key: "line", kind: "line", color: "gold" }],
      calc: (rows, p) => ({ line: atr(rows, p.period) }),
    },
  ];

  const BY_ID = {};
  INDICATORS.forEach((i) => { BY_ID[i.id] = i; });

  /** The chart types the engine can genuinely draw from OHLCV. */
  const SERIES_TYPES = [
    { id: "candles", geometry: "candle" },
    { id: "hollow", geometry: "candle" },
    { id: "bar", geometry: "bar" },
    { id: "line", geometry: "line" },
    { id: "area", geometry: "area" },
    { id: "baseline", geometry: "area" },
    { id: "heikin", geometry: "candle", transform: heikin },
    { id: "renko", geometry: "candle", transform: renko, timeless: true },
    { id: "linebreak", geometry: "candle", transform: lineBreak, timeless: true },
  ];

  const API = {
    sma, ema, wma, rma, stdev, atr, rsi, macd, bollinger, donchian,
    stochastic, vwap, trueRange, heikin, renko, lineBreak, regression,
    closes, highs, lows, hlc3,
    INDICATORS, INDICATOR_BY_ID: BY_ID, SERIES_TYPES,
  };

  global.AurionSeries = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : this);
