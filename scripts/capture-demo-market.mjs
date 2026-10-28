/**
 * Capture real market candles for the published demo.
 *
 * The demo is a static page on GitHub Pages: no Node desk, no Python
 * engine, nothing that can reach a price source at the moment a visitor
 * opens it. Until now it drew a seeded random walk, which looks like a
 * market but is not one -- and a chart is the one thing on that page a
 * visitor judges the product by.
 *
 * Fetching from the browser is not an option either. Yahoo's chart
 * endpoint sends no Access-Control-Allow-Origin, so a direct call from
 * github.io is refused, and routing through a public CORS proxy would
 * put a stranger's uptime in front of our demo.
 *
 * So the data is fetched here, server-side, where CORS does not apply,
 * and committed next to the demo as a plain JSON file. A scheduled
 * GitHub Action re-runs it, which keeps the demo close to the real
 * market without anyone having to remember to do it.
 *
 *     node scripts/capture-demo-market.mjs
 *     node scripts/capture-demo-market.mjs --out path/to/market.js
 *
 * Exit codes: 0 wrote a file, 1 could not. It never writes a partial or
 * invented file -- a demo that silently falls back to fake prices while
 * claiming to be real is the exact fault this script exists to remove.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* A .js file that assigns a global, not .json, for one specific reason:
   the demo also runs from file://, where fetching a local JSON is blocked
   by the same-origin rule but a <script> tag still loads. It also matches
   how fixtures.js is already pulled in. */
const DEFAULT_OUT = path.join(ROOT, "apps", "web", "demo", "market.js");

const HOST = "https://query1.finance.yahoo.com";
/* Yahoo rejects the default agent outright. Same string the engine uses. */
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AURION/1.0",
  Accept: "application/json",
};

/**
 * What the demo charts, and where Yahoo keeps it.
 *
 * The demo shows indices, metals and crypto alongside FX, so this is not
 * just the forex universe -- it is whatever the demo's watchlist and
 * sample positions name. `digits` mirrors how the desk formats each one.
 */
export const INSTRUMENTS = [
  { symbol: "EURUSD", ticker: "EURUSD=X", digits: 5 },
  { symbol: "GBPUSD", ticker: "GBPUSD=X", digits: 5 },
  { symbol: "USDJPY", ticker: "USDJPY=X", digits: 3 },
  { symbol: "USDCHF", ticker: "USDCHF=X", digits: 5 },
  { symbol: "AUDUSD", ticker: "AUDUSD=X", digits: 5 },
  { symbol: "USDCAD", ticker: "USDCAD=X", digits: 5 },
  { symbol: "NZDUSD", ticker: "NZDUSD=X", digits: 5 },
  { symbol: "XAUUSD", ticker: "GC=F", digits: 2 },
  { symbol: "XAGUSD", ticker: "SI=F", digits: 3 },
  { symbol: "US30", ticker: "^DJI", digits: 1 },
  { symbol: "US500", ticker: "^GSPC", digits: 2 },
  { symbol: "NAS100", ticker: "^NDX", digits: 1 },
  { symbol: "GER40", ticker: "^GDAXI", digits: 1 },
  { symbol: "UK100", ticker: "^FTSE", digits: 1 },
  { symbol: "BTCUSD", ticker: "BTC-USD", digits: 2 },
  { symbol: "ETHUSD", ticker: "ETH-USD", digits: 2 },
  { symbol: "WTI", ticker: "CL=F", digits: 2 },
  { symbol: "BRENT", ticker: "BZ=F", digits: 2 },
];

/* The timeframes the demo's chart offers. Yahoo has no four-hour bar, so
   H4 is folded from 60m rather than quietly served as H1. */
export const TIMEFRAMES = [
  { tf: "M5", interval: "5m", range: "5d" },
  { tf: "M15", interval: "15m", range: "1mo" },
  { tf: "M30", interval: "30m", range: "1mo" },
  { tf: "H1", interval: "60m", range: "3mo" },
  { tf: "H4", interval: "60m", range: "6mo", fold: 4 },
  { tf: "D1", interval: "1d", range: "2y" },
];

/** Bars kept per symbol and timeframe. The desk asks for at most 800. */
const DEPTH = 400;

/**
 * Turn one Yahoo chart response into candles.
 *
 * Yahoo pads its arrays with nulls for timestamps it has no data for --
 * market holidays, halts, the gaps either side of a weekend. Those rows
 * are dropped rather than carried forward, because a flat bar that never
 * traded is an invented price like any other.
 */
export function parseChart(payload, symbol, timeframe, digits) {
  const res = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!res) return [];
  const stamps = res.timestamp || [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    if (![o, h, l, c].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const ms = stamps[i] * 1000;
    out.push({
      symbol,
      timeframe,
      time: new Date(ms).toISOString().replace(".000Z", "Z"),
      ts: new Date(ms).toISOString().replace(".000Z", "Z"),
      time_msc: ms,
      open: round(o, digits),
      high: round(h, digits),
      low: round(l, digits),
      close: round(c, digits),
      volume: Number.isFinite(q.volume && q.volume[i]) ? q.volume[i] : 0,
      spread: 0,
      real_volume: 0,
    });
  }
  return out;
}

/**
 * Fold N bars into one, for the timeframe Yahoo does not serve.
 *
 * Open comes from the first bar and close from the last; high and low are
 * the extremes across the group. A trailing partial group is dropped, so
 * the demo never shows a four-hour candle built from one hour of trade.
 */
export function fold(bars, n) {
  if (n <= 1) return bars;
  const out = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const g = bars.slice(i, i + n);
    out.push({
      ...g[0],
      high: Math.max(...g.map((b) => b.high)),
      low: Math.min(...g.map((b) => b.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}

function round(n, d) { return Number(Number(n).toFixed(d)); }

async function getChart(fetchImpl, ticker, interval, range) {
  const url = `${HOST}/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const res = await fetchImpl(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Build the whole payload.
 *
 * Injectable fetch, so the tests can drive this with recorded responses
 * and assert the shape without touching the network.
 */
export async function capture({ fetchImpl = fetch, instruments = INSTRUMENTS, timeframes = TIMEFRAMES, log = () => {} } = {}) {
  const symbols = {};
  const failures = [];
  for (const inst of instruments) {
    const perTf = {};
    for (const spec of timeframes) {
      try {
        const payload = await getChart(fetchImpl, inst.ticker, spec.interval, spec.range);
        let bars = parseChart(payload, inst.symbol, spec.tf, inst.digits);
        if (spec.fold) bars = fold(bars, spec.fold).map((b) => ({ ...b, timeframe: spec.tf }));
        if (bars.length) perTf[spec.tf] = bars.slice(-DEPTH);
        else failures.push(`${inst.symbol} ${spec.tf}: empty`);
      } catch (err) {
        failures.push(`${inst.symbol} ${spec.tf}: ${err.message}`);
      }
    }
    if (Object.keys(perTf).length) {
      symbols[inst.symbol] = { digits: inst.digits, timeframes: perTf };
      log(`  ${inst.symbol}: ${Object.keys(perTf).join(", ")}`);
    }
  }
  return {
    captured_at: new Date().toISOString(),
    source: "Yahoo Finance",
    note: "Real market candles, captured server-side. Not live: the demo has no backend.",
    symbols,
    failures,
  };
}

/** Wrap the payload as the assignment the demo page loads. */
export function serialise(data) {
  return "/* Generated by scripts/capture-demo-market.mjs - do not edit by hand.\n" +
    `   Real market candles from ${data.source}, captured ${data.captured_at}. */\n` +
    "window.AURION_DEMO_MARKET = " + JSON.stringify(data) + ";\n";
}

/* ------------------------------------------------------------------ main */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : DEFAULT_OUT;

  console.log("capturing real demo market data from Yahoo Finance…");
  const data = await capture({ log: (m) => console.log(m) });
  const n = Object.keys(data.symbols).length;

  if (!n) {
    console.error("\nno symbol returned usable data - refusing to write.");
    for (const f of data.failures.slice(0, 10)) console.error("  " + f);
    process.exit(1);
  }
  /* Partial is fine and expected: a closed futures market serves no 5m
     bars. Empty is not, and is the case that must fail loudly. */
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, serialise(data));
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`\nwrote ${path.relative(ROOT, out)} - ${n} symbols, ${kb} KB`);
  if (data.failures.length) {
    console.log(`${data.failures.length} symbol/timeframe pairs had no data:`);
    for (const f of data.failures.slice(0, 10)) console.log("  " + f);
  }
}
