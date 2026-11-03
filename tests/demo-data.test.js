/**
 * The published demo has to answer, not just load.
 *
 * GitHub Pages serves apps/web with no desk and no engine behind it, so
 * apps/web/js/demo.js is the whole backend.  Three of the four things a
 * visitor goes there to look at were stubbed out and nobody noticed,
 * because "the page rendered" and "the page has anything in it" are
 * different questions and only the first one was ever asked:
 *
 *   - /api/chart/signals returned [], so "charts carrying signals" drew a
 *     chart carrying nothing.
 *   - There was no /api/backtest route at all, so the Backtest tab's one
 *     button reported an error.
 *   - The captured /api/history is an empty ledger, because the desk it was
 *     recorded from had never traded, so the history table and every P&L
 *     chart above it were blank.
 *
 * This loads the real demo.js against a stub window and asks its router the
 * questions the desk asks it.  The assertions are about substance -- there
 * are trades, the marks land on bars that exist, the arithmetic adds up --
 * because an empty 200 is exactly the failure that shipped last time.
 *
 * It also pins the two consistency properties that are easy to break and
 * invisible until somebody screenshots the result:
 *
 *   - one price series per symbol, whatever bar count is asked for (the
 *     seed used to include the count, so /api/candles?count=800 and the 240
 *     bars the price chips read were different random walks, and the open
 *     position's stop and target sat off the top of its own chart);
 *   - costs are charged in proportion to notional, not per lot, or one
 *     US500 contract pays the fee of 100,000 euros.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

const results = [];
function check(name, ok, detail) {
  const pass = ok === true;
  results.push({ name, ok: pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/* ------------------------------------------------------------- harness -- */

/** Enough browser for demo.js to install itself and answer a fetch. */
function loadDemo() {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    JSON,
    URL,
    URLSearchParams,
    Symbol,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    isFinite,
    parseInt,
    parseFloat,
    Response: class { constructor(b, i) { this.body = b; this.init = i; } },
    location: {
      href: "https://axiasoft.github.io/AURION/apps/web/index.html?demo=1",
      search: "?demo=1",
      protocol: "https:",
      hostname: "axiasoft.github.io",
      pathname: "/AURION/apps/web/index.html",
    },
    sessionStorage: storage,
    localStorage: storage,
    document: {
      // demo.js pulls the fixtures with a parser-time document.write. There
      // is no parser here, so the write is a no-op and the demo falls back
      // to synthesised data -- which is exactly the half under test.
      write() {},
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      readyState: "loading",
      body: { appendChild() {}, insertBefore() {} },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
    },
    WebSocket: class {},
    fetch: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const src = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "demo.js"), "utf8");
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "demo.js" });
  return sandbox;
}

const win = loadDemo();
check("the demo installs itself on a static host", win.AURION_DEMO === true);
check("it replaces fetch", typeof win.fetch === "function");

const BASE = "https://axiasoft.github.io/AURION/apps/web/";
async function get(p) {
  const r = await win.fetch(BASE + p.replace(/^\//, ""));
  return JSON.parse(r.body);
}
async function post(p, body) {
  const r = await win.fetch(BASE + p.replace(/^\//, ""), {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
  return JSON.parse(r.body);
}

/* ------------------------------------------------------------- the run -- */

(async () => {
  /* -------------------------------------------------------- signals -- */

  const sig = await get("api/chart/signals?symbol=EURUSD&timeframe=M15&count=800&strict=true");
  const marks = (sig && sig.signals) || [];
  check("signals: the route answers with marks, not an empty array",
    marks.length > 0, `${marks.length} marks`);

  const entries = marks.filter((m) => m.type === "buy" || m.type === "sell");
  check("signals: there are entry marks of both directions",
    entries.some((m) => m.type === "buy") && entries.some((m) => m.type === "sell"));

  const bars = (await get("api/candles?symbol=EURUSD&timeframe=M15&count=800")).data || [];
  check("signals: every mark indexes a bar that exists",
    marks.every((m) => m.index >= 0 && m.index < bars.length),
    `${bars.length} bars`);

  check("signals: a mark's price is the close of the bar it points at",
    entries.every((m) => Math.abs(m.price - bars[m.index].close) < 1e-9));

  check("signals: an entry carries the stop and target the desk draws",
    entries.every((m) => Number.isFinite(m.sl) && Number.isFinite(m.tp) && m.sl !== m.tp));

  check("signals: a long's stop is below its entry and its target above",
    entries.filter((m) => m.type === "buy").every((m) => m.sl < m.entry && m.tp > m.entry));

  check("signals: a short's stop is above its entry and its target below",
    entries.filter((m) => m.type === "sell").every((m) => m.sl > m.entry && m.tp < m.entry));

  /* ------------------------------------------------------- backtest -- */

  const accepted = await post("api/backtest", {
    symbol: "EURUSD", timeframe: "M15", strategy: { kind: "builtin", name: "ema_rsi" },
  });
  check("backtest: the demo accepts the run instead of refusing it",
    accepted.ok === true, JSON.stringify(accepted).slice(0, 80));

  // The engine answers the POST at once and delivers over the socket; the
  // demo does the same, and GET is how the desk re-reads it afterwards.
  await new Promise((r) => setTimeout(r, 400));
  const bt = (await get("api/backtest")).data || {};
  check("backtest: the result is retrievable after the run", bt.ok === true);
  check("backtest: it took trades", (bt.trades || []).length > 0, `${(bt.trades || []).length} trades`);

  const m = bt.metrics || {};
  check("backtest: the trade count matches the metric",
    m.trades === (bt.trades || []).length);

  const netSum = (bt.trades || []).reduce((a, t) => a + t.net, 0);
  check("backtest: net is the sum of the trades, not a separate number",
    Math.abs(netSum - m.net) < 0.5, `${netSum.toFixed(2)} vs ${m.net}`);

  const wins = (bt.trades || []).filter((t) => t.net > 0).length;
  check("backtest: the win rate is the win count over the trade count",
    Math.abs(m.win_rate - (wins / (bt.trades || []).length) * 100) < 0.11);

  check("backtest: the equity curve has one point per trade plus the open",
    (bt.equity_curve || []).length === (bt.trades || []).length + 1);

  /* A results card nobody would believe teaches a visitor nothing. The
     generated series is a random walk with a drift term, and at the old
     persistence the demo's own strategy scored 71% and a profit factor
     above 4 off it. These are wide bands around "an ordinary edge"; they
     are here to catch a return to fantasy, not to pin a number. */
  check("backtest: the win rate is plausible, not a fantasy",
    m.win_rate > 35 && m.win_rate < 70, `${m.win_rate}%`);
  check("backtest: the profit factor is plausible, not a fantasy",
    m.profit_factor > 0.8 && m.profit_factor < 2.5, String(m.profit_factor));

  check("backtest: costs are actually charged",
    (bt.trades || []).every((t) => t.commission < 0));

  check("backtest: it reports itself as demo data, not as MT5 bars",
    String((bt.data || {}).source).toLowerCase() === "demo");

  check("backtest: every trade carries both column vocabularies",
    (bt.trades || []).every((t) =>
      Number.isFinite(t.entry) && Number.isFinite(t.exit) && t.exit_reason &&
      Number.isFinite(t.price_open) && Number.isFinite(t.price_close)));

  /* -------------------------------------------------------- history -- */

  const hist = (await get("api/history?limit=400")).data || [];
  check("history: the ledger is not empty", hist.length > 0, `${hist.length} rows`);

  check("history: every row says it is a close",
    hist.every((r) => /close|out/.test(String(r.kind || r.entry || "").toLowerCase())),
    "PNL.series() keeps only rows that do");

  check("history: rows carry the close price under the name the view reads",
    hist.every((r) => Number.isFinite(r.price)),
    "historyRowView() reads row.price, not row.price_close");

  check("history: net reconciles with profit, swap and commission",
    hist.every((r) => Math.abs(r.net - (r.profit + r.swap + r.commission)) < 0.02));

  check("history: it is newest first, as the desk presents it",
    hist.every((r, i) => i === 0 || String(hist[i - 1].ts) >= String(r.ts)));

  check("history: more than one instrument traded",
    new Set(hist.map((r) => r.symbol)).size > 1,
    [...new Set(hist.map((r) => r.symbol))].join(" "));

  check("history: the limit is honoured",
    ((await get("api/history?limit=10")).data || []).length === 10);

  /* --------------------------------------------- one series, one price -- */

  const n800 = (await get("api/candles?symbol=EURUSD&timeframe=M15&count=800")).data;
  const n240 = (await get("api/candles?symbol=EURUSD&timeframe=M15&count=240")).data;
  check("prices: a shorter request is the tail of the longer one",
    n240.length === 240 && n800.length === 800 &&
    n240[239].close === n800[799].close && n240[0].close === n800[560].close,
    "two counts must not be two different random walks");

  const snap = (await get("api/snapshot")).data || {};
  const pos = (snap.positions || []).find((p) => p.symbol === "EURUSD");
  const last = n800[n800.length - 1].close;
  check("prices: an open position is quoted at the price the chart ends on",
    Boolean(pos) && Math.abs(pos.price_current - last) < 1e-6);

  /* The real property is not "the stop is inside the historical extremes"
     -- a stop just past the recent low is correct, and over 800 bars the
     walk wanders far enough that the test would be measuring the walk.
     What broke the screen was the stop and target expanding the range the
     chart DRAWS, which autoscaled to the lines and squashed the candles
     into the bottom third of the panel. CandleChart opens on ~120 bars, so
     that is the window to measure, and the budget is how much taller the
     panel gets for carrying the lines. */
  for (const p of (snap.positions || [])) {
    const win120 = ((await get(`api/candles?symbol=${p.symbol}&timeframe=M15&count=120`)).data) || [];
    const vlo = Math.min(...win120.map((b) => b.low));
    const vhi = Math.max(...win120.map((b) => b.high));
    const all = [vlo, vhi, p.sl, p.tp];
    const grow = (Math.max(...all) - Math.min(...all)) / (vhi - vlo);
    check(`prices: ${p.symbol}'s stop and target do not squash its chart`,
      grow < 1.6, `drawn range grows ${grow.toFixed(2)}x`);
  }

  /* Proportional costs. One US500 contract is about $5,200 of notional and
     one EURUSD lot is about $109,000; a flat per-lot fee charges them the
     same and quietly sinks the index's profit factor. */
  const us = await post("api/backtest", { symbol: "US500", timeframe: "M15" });
  check("costs: the index backtest also runs", us.ok === true);
  await new Promise((r) => setTimeout(r, 400));
  const ubt = (await get("api/backtest")).data || {};
  const avgFee = (ubt.trades || []).reduce((a, t) => a + -t.commission, 0) / ((ubt.trades || []).length || 1);
  check("costs: the index is not charged an FX-sized fee",
    avgFee > 0 && avgFee < 2, `$${avgFee.toFixed(2)} average commission`);
  check("costs: the index's profit factor is not destroyed by fees",
    (ubt.metrics || {}).profit_factor > 0.8, String((ubt.metrics || {}).profit_factor));

  /* ------------------------------------------------- writes still refused -- */

  const order = await post("api/order", { symbol: "EURUSD", volume: 1 });
  check("an order is still refused", order.ok === false, JSON.stringify(order).slice(0, 60));
  const key = await post("api/license/activate", { key: "X" });
  check("key activation is still refused", key.ok === false);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
})();
