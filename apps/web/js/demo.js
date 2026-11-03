/**
 * Demo mode -- the desk running with nobody behind it.
 *
 * GitHub Pages serves static files and nothing else.  There is no Node desk
 * to answer /api/* and no Python engine behind it, so the published desk used
 * to be a shell where every request 404'd: the gate hung, the chart stayed
 * empty, and a visitor had no way to see what the product looks like.
 *
 * This file stands in for both of them.  It intercepts the two seams the desk
 * talks to the outside through -- window.fetch for /api/*, and the WebSocket
 * on /ws -- and answers from canned data.  Nothing else in the desk is
 * touched, and nothing else in the desk knows.  That is the whole point of
 * putting the shim at the transport boundary rather than scattering
 * `if (demo)` through 6,500 lines of app.js.
 *
 * Two rules it holds to:
 *
 *   1. Reads are replayed from apps/web/demo/fixtures.json, which is captured
 *      from a real desk by scripts/capture-demo-fixtures.mjs.  Hand-written
 *      fixtures drift; captured ones are the real shapes.  Prices and the
 *      account are synthesised on top, clearly and deterministically, because
 *      a demo of a trading desk with a flat line and a zero balance teaches a
 *      visitor nothing.
 *
 *   2. Writes are refused.  Every POST gets {ok:false, error:"demo"} and the
 *      desk shows its normal error path.  A demo that pretends an order was
 *      placed is worse than no demo -- the one thing a visitor must leave with
 *      is a correct idea of what the real thing does.
 *
 * It is NOT loaded by the real desk.  Activation is explicit: ?demo=1, a
 * github.io host, or file://.  The real app is served from a Node desk on its
 * own host and never matches.
 */

(function () {
  "use strict";

  /* ========================================================= activation == */

  function wanted() {
    const q = new URLSearchParams(location.search);
    if (q.get("demo") === "0") return false;        // explicit escape hatch
    if (q.get("demo") === "1") return true;
    if (location.protocol === "file:") return true;
    if (/\.github\.io$/i.test(location.hostname)) return true;
    // Sticky for the tab: the desk is a single page but the guide pages link
    // back and forth, and losing demo mode on a link click looks like a crash.
    try { return sessionStorage.getItem("aurion.demo") === "1"; } catch { return false; }
  }

  if (!wanted()) return;
  try { sessionStorage.setItem("aurion.demo", "1"); } catch {}
  window.AURION_DEMO = true;

  /* The brand clip plays in the demo too.

     It used to be deleted here. The reasoning was that boot() awaits
     playWelcome() before it reads the licence, so the desk does not
     exist until the clip finishes, and a visitor who followed a "see
     the demo" link waits (measured) 10.9 seconds of video before the
     first pixel of the product.

     That was the wrong call to make silently: the clip is the opening
     of the product, the demo is what most people will ever see of it,
     and a demo that quietly drops a piece of the real experience is
     not showing the product. It is restored, and the cost is paid down
     where it actually comes from instead - playWelcome() already
     renders Skip on the first frame, and the licence call runs
     alongside the clip rather than after it, so skipping lands on a
     desk that is already loaded.

     Nothing here branches on the demo any more, which also keeps
     app.js honest: it must not know this file exists
     (tests/demo-not-shipped.test.js enforces that). */

  /* Signal marks default to off for a real trader, who opts in once and is
     remembered.  A visitor to the demo has no "once" -- they arrive, look at
     a chart, and leave, so the default decides what the product appears to
     do.  "Charts carrying signals" rendering as a chart carrying nothing was
     the single most misleading thing on the published site.
     
     Seeded rather than forced: if the visitor turns signals off, the key is
     already written and this leaves their choice alone.  app.js reads it
     when it builds S, and demo.js is parsed first, so the value is in place
     before anything looks. */
  try {
    if (localStorage.getItem("aurion.signalsEnabled") === null) {
      localStorage.setItem("aurion.signalsEnabled", "1");
    }
  } catch {}

  // Pull in the 59 KB of captured responses, here rather than from a tag in
  // index.html, so the real desk never downloads demo data it will not use.
  //
  // document.write is the deliberate choice: this script is parser-inserted,
  // so the write lands synchronously and the fixtures are defined before
  // app.js parses and calls boot().  Anything async -- fetch, a dynamic
  // <script>, an import() -- races the licence call that decides whether the
  // key gate appears.  Same-origin and parser-time, so none of the reasons
  // document.write is usually a mistake apply.
  document.write('<script src="demo/fixtures.js?v=desk182"><\/script>');

  /* ====================================================== sample market == */

  /**
   * A seeded generator, so the same symbol draws the same chart on every
   * visit and on every machine.  Screenshots in an issue then match what the
   * reader sees when they open the link, which Math.random() would not give.
   */
  function rng(seed) {
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // Starting price and tick size per instrument, so XAUUSD does not get drawn
  // with EURUSD's five decimals and a $1 range.
  // contract = account currency per 1.0 price unit per 1.0 lot, so a profit
  // figure is a number of dollars rather than a number of points.  For the
  // pairs that are not quoted in USD it already carries the conversion, which
  // is why USDJPY is 660 and not 100000 -- without that a demo trade on yen
  // reports a four-figure win and the whole ledger reads as invented.
  // lot = the size the demo's robot trades, chosen so every instrument
  // contributes comparable money to the account curve.
  const INSTRUMENTS = {
    EURUSD: { px: 1.0865, step: 0.00035, digits: 5, contract: 100000, lot: 0.10 },
    GBPUSD: { px: 1.2712, step: 0.00042, digits: 5, contract: 100000, lot: 0.10 },
    USDJPY: { px: 151.42, step: 0.052, digits: 3, contract: 660, lot: 0.10 },
    USDCHF: { px: 0.8834, step: 0.00031, digits: 5, contract: 113000, lot: 0.10 },
    AUDUSD: { px: 0.6598, step: 0.00030, digits: 5, contract: 100000, lot: 0.10 },
    USDCAD: { px: 1.3604, step: 0.00036, digits: 5, contract: 73500, lot: 0.10 },
    NZDUSD: { px: 0.6012, step: 0.00028, digits: 5, contract: 100000, lot: 0.10 },
    XAUUSD: { px: 2338.4, step: 1.65, digits: 2, contract: 100, lot: 0.05 },
    XAGUSD: { px: 27.42, step: 0.055, digits: 3, contract: 5000, lot: 0.05 },
    US30:   { px: 39210, step: 28, digits: 1, contract: 1, lot: 1.0 },
    US500:  { px: 5235.5, step: 4.1, digits: 2, contract: 1, lot: 1.0 },
    NAS100: { px: 18240, step: 22, digits: 1, contract: 1, lot: 1.0 },
    GER40:  { px: 18115, step: 19, digits: 1, contract: 1, lot: 1.0 },
    UK100:  { px: 8142, step: 9, digits: 1, contract: 1, lot: 1.0 },
    BTCUSD: { px: 64120, step: 185, digits: 2, contract: 1, lot: 0.05 },
    ETHUSD: { px: 3142, step: 14, digits: 2, contract: 1, lot: 0.5 },
    WTI:    { px: 79.35, step: 0.28, digits: 2, contract: 1000, lot: 0.10 },
    BRENT:  { px: 83.60, step: 0.29, digits: 2, contract: 1000, lot: 0.10 },
  };

  const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

  function instrument(symbol) {
    return INSTRUMENTS[symbol] || { px: 100, step: 0.4, digits: 2, contract: 1, lot: 1.0 };
  }

  const barCache = new Map();

  /**
   * A random walk with a slow drift term, which is what makes it read as a
   * market rather than as noise: pure Brownian motion has no trends to see,
   * and a trend is the thing every panel on this desk is about.
   */
  // One master series per symbol and timeframe, sliced to whatever length
  // the caller asked for.
  //
  // The seed used to include the bar count, which meant /api/candles?count=800
  // and the 240 bars lastPrice() reads were two unrelated random walks that
  // happened to start at the same place. They ended hundreds of pips apart,
  // so the price chips, the ticks, the open positions and the account all
  // described a market the chart was not showing -- visibly, as a position
  // whose stop and target sat off the top of its own chart and squashed the
  // candles into the bottom third of the panel.
  //
  // Slicing one series instead also makes the signal indices line up for
  // free: a mark at index i of an 800-bar request is the same bar as index
  // i of the 800 the chart drew, because they are the same 800 bars.
  const MASTER_BARS = 3000;

  function candles(symbol, timeframe, count) {
    count = Math.max(1, Math.min(count || 800, MASTER_BARS));
    const key = `${symbol}|${timeframe}`;
    const master = barCache.has(key) ? barCache.get(key) : buildBars(symbol, timeframe, MASTER_BARS);
    if (!barCache.has(key)) barCache.set(key, master);
    return count >= master.length ? master : master.slice(master.length - count);
  }

  function buildBars(symbol, timeframe, count) {
    const key = `${symbol}|${timeframe}|${count}`;
    const inst = instrument(symbol);
    const rand = rng(key);
    const mins = TF_MINUTES[timeframe] || 15;
    const stepMs = mins * 60000;
    // Anchored to the top of the current bar so the newest candle is "now".
    const end = Math.floor(Date.now() / stepMs) * stepMs;

    const bars = [];
    let px = inst.px;
    let drift = 0;
    for (let i = count - 1; i >= 0; i--) {
      /* 0.91, not 0.97.  The drift term is what gives the series trends to
         look at, but at 0.97 a trend persisted for ~23 bars and the demo's
         own strategy scored a 71% win rate and a profit factor above 4 off
         it -- numbers no real system produces, printed on the results card
         of a product being evaluated.  0.91 halves a trend in about seven
         bars: still visibly a market rather than noise, and the backtest it
         feeds lands at 57% and PF 1.2, which is a believable edge.
         Measured across all six watched instruments, 332 trades. */
      drift = drift * 0.91 + (rand() - 0.5) * inst.step * 0.35;
      const open = px;
      const close = open + drift + (rand() - 0.5) * inst.step;
      const wick = inst.step * (0.4 + rand() * 0.9);
      const high = Math.max(open, close) + wick * rand();
      const low = Math.min(open, close) - wick * rand();
      const t = new Date(end - i * stepMs).toISOString().replace(".000Z", "Z");
      bars.push({
        symbol,
        timeframe,
        time: t,
        ts: t,
        time_msc: end - i * stepMs,
        open: round(open, inst.digits),
        high: round(high, inst.digits),
        low: round(low, inst.digits),
        close: round(close, inst.digits),
        volume: Math.round(300 + rand() * 1700),
        spread: 2,
        real_volume: 0,
      });
      px = close;
    }
    return bars;
  }

  function round(n, d) { return Number(n.toFixed(d)); }

  function lastPrice(symbol) {
    const bars = candles(symbol, "M15", 240);
    return bars[bars.length - 1].close;
  }

  /* ========================================================= simulation ==

     Everything below is one idea: the demo must not have a *second* source
     of truth.

     The charts are generated from a seeded RNG, so they are the same bars on
     every visit and every machine.  Signals, the backtest and the trade
     history were the three things a visitor most wanted to look at, and all
     three were stubbed -- signals returned [], there was no backtest route at
     all, and the captured /api/history is an empty ledger because the desk it
     was captured from had never traded.  So the three headline features of a
     trading desk were the three blank panels.

     Hand-writing plausible numbers into a fixture would have fixed the look
     and broken the meaning: the history would not have matched the charts,
     and a signal would have pointed at a candle that is not there.  Instead a
     small strategy is actually RUN over the same generated bars.  The marks
     sit on real pivots in the series, the backtest metrics are the arithmetic
     of the trades it took, and the history is those trades closed.  Zoom a
     chart to a signal and the setup is visible, because the setup is why the
     signal is there.

     This does not weaken rule 2.  A backtest is a simulation, not an action:
     it moves no money and touches no broker.  Refusing it taught a visitor
     nothing except that the button is dead.  Orders, key activation and
     every other write stay refused exactly as before -- the line is "does it
     have an effect in the world", not "is it a POST".
  */

  function emaSeries(vals, n) {
    const k = 2 / (n + 1);
    const out = [];
    let e = vals[0];
    for (let i = 0; i < vals.length; i++) {
      e = i === 0 ? vals[0] : vals[i] * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }

  function rsiSeries(vals, n) {
    const out = new Array(vals.length).fill(50);
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      if (i <= n) {
        gain += g / n;
        loss += l / n;
      } else {
        gain = (gain * (n - 1) + g) / n;
        loss = (loss * (n - 1) + l) / n;
      }
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function atrSeries(bars, n) {
    const out = new Array(bars.length).fill(0);
    let a = 0;
    for (let i = 0; i < bars.length; i++) {
      const prev = i ? bars[i - 1].close : bars[i].open;
      const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev));
      a = i === 0 ? tr : (a * (n - 1) + tr) / n;
      out[i] = a;
    }
    return out;
  }

  const simCache = new Map();

  /**
   * Walk the generated bars with an EMA-cross / RSI-filter / ATR-stop rule
   * and return what it did.  One pass produces all three answers the desk
   * asks for, which is the only reason they agree with each other.
   *
   * Deliberately an ordinary strategy with ordinary results.  A demo that
   * shows a 95% win rate is a lie a trader spots in four seconds, and it
   * would make every honest number elsewhere in the desk look invented too.
   */
  function simulate(symbol, timeframe, count, strategyName) {
    const rule = strategyName === "smart_money" ? "smart_money" : "ema_rsi";
    const key = `${symbol}|${timeframe}|${count}|${rule}`;
    if (simCache.has(key)) return simCache.get(key);

    const bars = candles(symbol, timeframe, count);
    const inst = instrument(symbol);
    const close = bars.map((b) => b.close);
    const fast = emaSeries(close, 9);
    const slow = emaSeries(close, 21);
    const rsi = rsiSeries(close, 14);
    const atr = atrSeries(bars, 14);
    const warmup = 30;

    const signals = [];
    const trades = [];
    let open = null;
    let ticket = 50321000;

    const closeOut = (i, price, reason) => {
      const bar = bars[i];
      const dir = open.side === "buy" ? 1 : -1;
      // Costs, charged the way a broker charges them rather than quietly
      // omitted -- a costless backtest is the most common way a strategy
      // looks profitable when it is not.
      //
      // Both are proportional to notional, not to the lot count. A flat
      // "7 per lot" is only right for a 100k FX lot: it made one US500
      // contract pay the same fee as 100,000 euros, which on its own
      // dragged that symbol to a profit factor of 0.2 and made the index
      // look like the strategy's weak spot when it was the fee model's.
      const notional = open.volume * inst.contract * inst.px;
      const spread = inst.step * 0.6;                       // round turn
      const moved = (price - open.entry) * dir - spread;
      const rr = open.risk > 0 ? moved / open.risk : 0;
      const commission = -round(notional * 0.00007, 2);
      const swap = open.bars > 96 ? -round(notional * 0.000012, 2) : 0;
      const profit = round(moved * inst.contract * open.volume, 2);
      trades.push({
        ticket: ticket,
        // PNL.series() keeps only rows whose kind/entry says "close", so the
        // equity curve and every total under the history table read empty
        // without this - the rows render, the charts above them do not.
        kind: "close",
        entry: "out",
        symbol,
        side: open.side,
        type: open.side,
        volume: open.volume,
        price_open: round(open.entry, inst.digits),
        price_close: round(price, inst.digits),
        sl: round(open.sl, inst.digits),
        tp: round(open.tp, inst.digits),
        ts_open: open.time,
        ts: bar.time,
        time: bar.time,
        commission,
        swap,
        profit,
        net: round(profit + commission + swap, 2),
        rr: round(rr, 3),
        reason,
        /* The history table reads price_open/price_close, the backtest
           table reads entry/exit/exit_reason. Same trade, two readers, so
           it carries both names rather than making one of them render a
           column of em-dashes. */
        entry: round(open.entry, inst.digits),
        exit: round(price, inst.digits),
        // historyRowView() builds its close-price cell from row.price, not
        // row.price_close, so without this the ledger's Close column was an
        // em-dash on every row while Open was filled.
        price: round(price, inst.digits),
        exit_reason: EXIT_REASON[reason] || reason,
        source: "robot",
        strategy: open.strategy,
        comment: `${open.strategy} ${reason}`,
      });
      signals.push({
        index: i,
        time: bar.time,
        type: "exit",
        side: open.side === "buy" ? "sell" : "buy",
        price: round(price, inst.digits),
        entry: round(price, inst.digits),
        exit_of: ticket,
        rr: round(rr, 2),
        strategy: open.strategy,
        reason: EXIT_REASON[reason] || reason,
      });
      ticket++;
      open = null;
    };

    for (let i = warmup; i < bars.length; i++) {
      const bar = bars[i];

      if (open) {
        open.bars++;
        // Stop before target when a single bar covers both, because that is
        // the pessimistic reading and the one a trader can trust.
        if (open.side === "buy") {
          if (bar.low <= open.sl) { closeOut(i, open.sl, "sl"); }
          else if (bar.high >= open.tp) { closeOut(i, open.tp, "tp"); }
        } else {
          if (bar.high >= open.sl) { closeOut(i, open.sl, "sl"); }
          else if (bar.low <= open.tp) { closeOut(i, open.tp, "tp"); }
        }
        if (open && open.bars >= 80) closeOut(i, bar.close, "timeout");
        continue;
      }

      const a = atr[i];
      if (!a) continue;

      let side = null;
      let entry = bar.close;
      let risk = 0;
      let rrTarget = 1.9;
      let strategy = "ema_rsi";
      let conf = 0.6;
      let reasonText = "";
      let extra = null;

      if (rule === "smart_money") {
        /* The engine's sequence, in the same order, because the order is
           the idea: a pool of liquidity is taken, displacement follows the
           other way, that move leaves a gap behind, and the entry is the
           retrace into the gap -- not the displacement. The sequence plays
           out across bars; sweep, displacement and retrace are three
           different bars, not one.
           See engine/aurion/strategy/builtin/smart_money.py.

           Two constants differ from that file and it is worth saying why.
           The engine wants 1.0 ATR of displacement over 3 bars and a
           retrace into the discount half at 0.62 of the leg. Measured on
           THIS demo's series, a 3-bar move of 1.0 ATR sits at the 99th
           percentile (p50 -0.21, p90 0.52): the generated walk has no
           volatility clustering, so a real market's "brisk" is this
           series' once-a-year. At the engine's numbers the demo took 1
           trade in 3000 bars and the results card was empty. Calibrated
           to this series instead: 0.55 ATR is its p90, which is the same
           STATEMENT -- "an unusually strong three-bar move" -- against a
           different distribution, and the equilibrium is relaxed to 0.78.

           It still trades far less than ema_rsi (about 10 trades per
           3000 bars against 53), and that is not a defect to tune away:
           the real strategy took 158 trades where the other three took
           6081. A structural setup is rare. */
        const SWING_K = 2, SETUP = 20, DISP = 3;
        const MIN_DISP = 0.55, PAD = 0.35, EQ = 0.78, BUF = 0.25, MIN_RR = 1.5;

        const swingHigh = (j) => {
          for (let k = 1; k <= SWING_K; k++)
            if (bars[j].high <= bars[j - k].high || bars[j].high <= bars[j + k].high) return false;
          return true;
        };
        const swingLow = (j) => {
          for (let k = 1; k <= SWING_K; k++)
            if (bars[j].low >= bars[j - k].low || bars[j].low >= bars[j + k].low) return false;
          return true;
        };

        let found = null;
        for (let js = i - 2; js >= i - SETUP && !found; js--) {
          if (js - SWING_K - 1 < warmup) break;
          // 1. the pool that was taken: a swing run through and closed back inside
          let swept = null;
          for (let m = js - SWING_K - 1; m >= Math.max(warmup, js - SETUP); m--) {
            if (swingHigh(m) && bars[js].high > bars[m].high && bars[js].close < bars[m].high) {
              swept = { dir: -1, level: bars[m].high, extreme: bars[js].high }; break;
            }
            if (swingLow(m) && bars[js].low < bars[m].low && bars[js].close > bars[m].low) {
              swept = { dir: 1, level: bars[m].low, extreme: bars[js].low }; break;
            }
          }
          if (!swept) continue;

          // 2. displacement away from the pool, in the bars after it
          const jd = Math.min(js + DISP, i - 1);
          const travel = (bars[jd].close - bars[js].close) * swept.dir;
          if (travel < MIN_DISP * a) continue;

          // 3. the imbalance that move left behind (a three-bar gap)
          let zoneHi = null, zoneLo = null;
          for (let j = jd; j > js + 1; j--) {
            if (swept.dir === 1 && bars[j].low > bars[j - 2].high) { zoneLo = bars[j - 2].high; zoneHi = bars[j].low; break; }
            if (swept.dir === -1 && bars[j].high < bars[j - 2].low) { zoneLo = bars[j].high; zoneHi = bars[j - 2].low; break; }
          }
          if (zoneHi === null) continue;

          // the impulse itself, which is the leg the entry is priced against
          let ih = -Infinity, il = Infinity;
          for (let j = js; j <= jd; j++) { if (bars[j].high > ih) ih = bars[j].high; if (bars[j].low < il) il = bars[j].low; }
          found = { swept, zoneHi, zoneLo, travel, ih, il };
        }
        if (!found) continue;

        // 4. price has to come back to the zone -- this bar, after the move
        const pad = a * PAD;
        if (!(bar.low <= found.zoneHi + pad && bar.high >= found.zoneLo - pad)) continue;

        // 5. and on the right side of the leg: longs in the discount half
        const legLo = found.swept.dir === 1 ? found.swept.extreme : found.il;
        const legHi = found.swept.dir === 1 ? found.ih : found.swept.extreme;
        const span = legHi - legLo;
        if (span <= 0) continue;
        const pos = (bar.close - legLo) / span;
        if (found.swept.dir === 1 && pos > EQ) continue;
        if (found.swept.dir === -1 && pos < 1 - EQ) continue;

        side = found.swept.dir === 1 ? "buy" : "sell";
        entry = bar.close;
        // The stop belongs behind the sweep's extreme: that price is what
        // says the idea was wrong. sl_atr is only the floor.
        const struct = Math.abs(entry - found.swept.extreme) + a * BUF;
        risk = Math.max(struct, a * 1.3);
        rrTarget = (a * 2.6) / risk;
        if (rrTarget < MIN_RR) continue;
        strategy = "smart_money";
        conf = Math.min(0.94, 0.55 + Math.min(found.travel / a - MIN_DISP, 1) * 0.25);
        reasonText = side === "buy"
          ? `liquidity swept below ${round(found.swept.level, inst.digits)}, ${(found.travel / a).toFixed(1)}x ATR displacement up, retrace into the gap`
          : `liquidity swept above ${round(found.swept.level, inst.digits)}, ${(found.travel / a).toFixed(1)}x ATR displacement down, retrace into the gap`;
        extra = { sweep: round(found.swept.level, inst.digits), displacement: round(found.travel / a, 2),
                  zone: [round(found.zoneLo, inst.digits), round(found.zoneHi, inst.digits)],
                  leg_pos: round(pos, 2), bias: side === "buy" ? "bull" : "bear" };
      } else {
        const crossUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
        const crossDn = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
        if (crossUp && rsi[i] > 50 && rsi[i] < 72) side = "buy";
        else if (crossDn && rsi[i] < 50 && rsi[i] > 28) side = "sell";
        if (!side) continue;
        entry = bar.close;
        risk = a * 1.3;
        rrTarget = 1.9;
        strategy = Math.abs(rsi[i] - 50) > 12 ? "ema_rsi" : "price_action";
        conf = Math.min(0.94, 0.52 + Math.abs(rsi[i] - 50) / 70);
        reasonText = side === "buy"
          ? `fast EMA crossed above slow with RSI ${Math.round(rsi[i])} - stop ${(risk / inst.step).toFixed(1)}x ATR below`
          : `fast EMA crossed below slow with RSI ${Math.round(rsi[i])} - stop ${(risk / inst.step).toFixed(1)}x ATR above`;
        extra = { rsi: Math.round(rsi[i]), atr: round(a, inst.digits), bias: side === "buy" ? "bull" : "bear" };
      }

      const dir = side === "buy" ? 1 : -1;
      const sl = entry - dir * risk;
      const tp = entry + dir * risk * rrTarget;

      signals.push({
        index: i,
        time: bar.time,
        type: side,
        side,
        price: round(entry, inst.digits),
        entry: round(entry, inst.digits),
        sl: round(sl, inst.digits),
        tp: round(tp, inst.digits),
        rr: round(rrTarget, 2),
        confidence: round(conf, 2),
        strategy,
        reason: reasonText,
        extra,
      });

      open = {
        side, entry, sl, tp, risk, strategy, bars: 0,
        time: bar.time,
        volume: inst.lot || 0.1,
      };
    }

    const out = { bars, trades, signals, symbol, timeframe };
    simCache.set(key, out);
    return out;
  }

  const EXIT_REASON = {
    sl: "stop loss hit",
    tp: "target reached",
    timeout: "closed on time stop",
  };

  /** The arithmetic of a trade list, in the shape the results card reads. */
  function metricsOf(trades) {
    const n = trades.length;
    if (!n) return { trades: 0, win_rate: 0, profit_factor: 0, net: 0, avg_rr: 0, sharpe: 0, max_dd: 0 };
    let wins = 0;
    let gross_win = 0;
    let gross_loss = 0;
    let net = 0;
    let rr = 0;
    const rs = [];
    let eq = 0;
    let peak = 0;
    let dd = 0;
    for (const t of trades) {
      if (t.net > 0) { wins++; gross_win += t.net; } else { gross_loss += -t.net; }
      net += t.net;
      rr += t.rr;
      rs.push(t.rr);
      eq += t.net;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
    }
    const mean = rr / n;
    const sd = Math.sqrt(rs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n) || 1;
    return {
      trades: n,
      win_rate: round((wins / n) * 100, 1),
      profit_factor: gross_loss > 0 ? round(gross_win / gross_loss, 2) : 0,
      net: round(net, 2),
      avg_rr: round(mean, 3),
      sharpe: round((mean / sd) * Math.sqrt(n), 2),
      max_dd: round(dd, 2),
    };
  }

  function equityOf(trades, start) {
    const curve = [start];
    let eq = start;
    for (const t of trades) { eq = round(eq + t.net, 2); curve.push(eq); }
    return curve;
  }

  /** A finished backtest, in the shape paintBacktestResults() renders. */
  function backtestRun(symbol, timeframe, name) {
    // A longer window than the chart shows, because that is the honest
    // relationship between the two: 800 bars is eight days of M15 and nine
    // trades, and a results card reporting a profit factor off nine trades
    // is a statistic nobody should act on.  3000 bars is about a month and
    // settles the numbers down without pretending to be a decade.
    const sim = simulate(symbol, timeframe, 3000, name);
    const trades = sim.trades;
    const m = metricsOf(trades);
    const start = 10000;
    return {
      ok: true,
      running: false,
      mode: "backtest",
      symbol,
      timeframe,
      strategy: name || "ema_rsi",
      bars: sim.bars.length,
      trades,
      metrics: m,
      equity_curve: equityOf(trades, start),
      final: round(start + m.net, 2),
      peak: round(Math.max.apply(null, equityOf(trades, start)), 2),
      dd: m.max_dd,
      no_trades: trades.length === 0,
      empty: trades.length === 0,
      /* btProvenance() reads bt.data, and it exists to let a trader check
         the replayed window against their own terminal. The demo cannot
         pass that check and must not look like it did: source prints
         "DEMO", not "MT5", and the dates are the generated series' own. */
      data: {
        source: "demo",
        first_bar: String(sim.bars[0] && sim.bars[0].time || "").replace("T", " ").replace("Z", ""),
        last_bar: String(sim.bars[sim.bars.length - 1] && sim.bars[sim.bars.length - 1].time || "").replace("T", " ").replace("Z", ""),
        tested_bars: sim.bars.length,
        warmup_bars: 30,
        lot_mode: "manual",
        lot: instrument(symbol).lot || 0.1,
        max_open: 1,
      },
      ts: new Date().toISOString(),
    };
  }

  /**
   * The closed ledger: every symbol the demo watches, most recent first.
   *
   * The history view and the P&L charts both read this, and the equity line
   * they draw is the same arithmetic the backtest card reports, because both
   * are summing the same trades.
   */
  let historyCache = null;
  function history(limit) {
    if (!historyCache) {
      const all = [];
      for (const sym of WATCH) {
        for (const t of simulate(sym, "M15", 800).trades) all.push(t);
      }
      all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      // Re-ticket in time order so the ledger reads like one account's run
      // rather than six interleaved sequences.
      let n = 50321000;
      for (const t of all) t.ticket = n++;
      historyCache = all;
    }
    const lim = Math.max(1, Math.min(Number(limit) || 400, historyCache.length));
    return historyCache.slice(-lim).reverse();
  }

  function tick(symbol) {
    const inst = instrument(symbol);
    const mid = lastPrice(symbol);
    const half = inst.step * 0.08;
    return {
      symbol,
      time: new Date().toISOString(),
      bid: round(mid - half, inst.digits),
      ask: round(mid + half, inst.digits),
      last: round(mid, inst.digits),
      volume: 1,
      flags: 0,
      time_msc: Date.now(),
    };
  }

  /* ========================================================= sample book == */

  const WATCH = ["EURUSD", "XAUUSD", "GBPUSD", "US500", "BTCUSD", "USDJPY"];
  const BALANCE = 25000;

  function positions() {
    const spec = [
      { symbol: "EURUSD", type: "buy",  volume: 0.20, ago: 95,  strategy: "ema_rsi" },
      { symbol: "XAUUSD", type: "sell", volume: 0.10, ago: 42,  strategy: "atr_breakout" },
      { symbol: "US500",  type: "buy",  volume: 0.50, ago: 310, strategy: "price_action" },
    ];
    return spec.map((p, i) => {
      const inst = instrument(p.symbol);
      const now = lastPrice(p.symbol);
      const rand = rng("pos" + p.symbol);
      const openPx = round(now - (p.type === "buy" ? 1 : -1) * inst.step * (2 + rand() * 6), inst.digits);
      const dir = p.type === "buy" ? 1 : -1;
      // INSTRUMENTS carries the contract size now, so the open P/L here and
      // the closed P/L in the ledger are computed the same way. They were
      // two separate guesses, and the account did not reconcile against its
      // own history.
      const profit = round(dir * (now - openPx) * p.volume * inst.contract, 2);
      return {
        ticket: 420100 + i,
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        price_open: openPx,
        price_current: now,
        // Tight enough to sit inside the drawn price range. At 12 and 20
        // steps the target cleared the top of an 800-bar window and the
        // chart autoscaled to the line instead of the candles.
        sl: round(openPx - dir * inst.step * 5, inst.digits),
        tp: round(openPx + dir * inst.step * 8, inst.digits),
        profit,
        swap: 0,
        time: new Date(Date.now() - p.ago * 60000).toISOString(),
        magic: 908173,
        comment: "AURION demo",
        identifier: 420100 + i,
        strategy: p.strategy,
      };
    });
  }

  /**
   * The chart agents the desk thinks are attached.
   *
   * This is what makes the chart appear at all.  The desk refuses to draw a
   * tape it was not given -- eaLive() gates the markets and charts views on
   * there being at least one live AurionBridge chart, which is the rule that
   * keeps the real product from ever showing an invented candle.  The demo
   * does not get to bypass that rule, so it satisfies it honestly: it says
   * these charts are attached, and then serves their bars.
   */
  function agents() {
    return WATCH.map((symbol, i) => ({
      chart_id: String(132000 + i),
      symbol,
      timeframe: "M15",
      ea_name: "AurionBridge",
      version: "1.17",
      status: "online",
      last_seen: new Date().toISOString(),
      last_signal: {},
      params: {},
      logs: [],
      performance: {},
      tester: false,
      mode: "live",
      live: true,
    }));
  }

  function account(pos) {
    const open = pos.reduce((a, p) => a + p.profit, 0);
    return {
      login: 5000271,
      name: "AURION Demo",
      server: "AxiaSoft-Demo",
      currency: "USD",
      company: "AxiaSoft",
      leverage: 100,
      balance: BALANCE,
      equity: round(BALANCE + open, 2),
      margin: 612.4,
      margin_free: round(BALANCE + open - 612.4, 2),
      margin_level: round(((BALANCE + open) / 612.4) * 100, 2),
      profit: round(open, 2),
      credit: 0,
      trade_allowed: true,
      trade_expert: true,
      connected: true,
      account_type: "demo",
      account_label: "Demo",
      margin_mode: "netting",
      trade_mode_code: 0,
      margin_mode_code: 2,
    };
  }

  /* ===================================================== fixture replay == */

  /**
   * Read the fixtures on every lookup rather than caching them at load.
   *
   * demo/fixtures.js is pulled in by the document.write below, and a script
   * inserted that way does not run until the script doing the writing has
   * finished -- so anything this file captures at the end of its own body is
   * captured too early and comes back empty.  Reading the global each time is
   * both correct and cheap; everything here runs on user time, not in a loop.
   */
  function fixtures() {
    return window.AURION_DEMO_FIXTURES || {};
  }

  function fixture(pathname, search) {
    const FIX = fixtures();
    const full = pathname + (search || "");
    if (FIX[full]) return clone(FIX[full]);
    if (FIX[pathname]) return clone(FIX[pathname]);
    // Captured with one limit, asked for with another: the shape is the same,
    // so serve it rather than 404 a panel the visitor is looking at.
    const hit = Object.keys(FIX).find((k) => k.split("?")[0] === pathname);
    return hit ? clone(FIX[hit]) : null;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /** The captured snapshot, dressed with the sample book. */
  function snapshot() {
    const base = fixture("/api/snapshot") || { ok: true, data: {} };
    const d = base.data || {};
    const pos = positions();

    d.engine = "online";
    d.kill_switch = false;
    d.active_symbol = d.active_symbol || "EURUSD";
    d.active_timeframe = d.active_timeframe || "M15";
    d.positions = pos;
    d.agents = agents();
    d.tape = "live";
    d.ticks = {};
    for (const s of WATCH) d.ticks[s] = tick(s);

    d.mt5 = Object.assign({}, d.mt5, {
      connected: true,
      source: "AurionBridge (demo)",
      native_package: false,
      account: account(pos),
      symbols: WATCH,
      last_tick_at: new Date().toISOString(),
      latency_ms: 11,
      ea_charts: WATCH.length,
      live_charts: WATCH.length,
      tester_charts: 0,
      last_error: "",
      ea_last_ingest: new Date().toISOString(),
      ea_last_hello: new Date(Date.now() - 600000).toISOString(),
    });

    d.ai = Object.assign({}, d.ai, {
      ready: true,
      status: "live",
      direction: "bull",
      confidence: 0.63,
      regime: { name: "trend", vol: "normal" },
      pattern: { name: "higher-low", bias: "bull", score: 0.58 },
      reason: "Sample data - the AI panel is showing a canned reading",
      samples: 1840,
      updated: new Date().toISOString(),
      symbol: "EURUSD",
      timeframe: "M15",
      hint: "bull",
      display_direction: "bull",
      need: 160,
    });

    // licFeat() reads the snapshot's copy before S.license, so the premium
    // licence has to be on both or half the desk stays locked.
    d.license = clone(license().data);
    if (d.strategy && d.strategy.auto_limit) {
      d.strategy.auto_limit = Object.assign({}, d.strategy.auto_limit,
        { premium: true, ok: true, limit: 0, used: 0, left: 0, lock_until: null });
    }

    d.ts = new Date().toISOString();
    base.data = d;
    return base;
  }

  /* ============================================================= router == */

  const READONLY = { ok: false, error: "demo", message: "Read-only demo: this action needs the real desk." };

  // Returned for reads the demo must visibly not answer, so the caller takes
  // its own fallback path instead of believing an empty success.
  const MISS = Symbol("miss");

  /** The POST body, whatever shape fetch was handed it in. */
  function jsonBody(init) {
    try {
      const b = init && init.body;
      if (!b) return {};
      if (typeof b === "string") return JSON.parse(b);
      return {};
    } catch { return {}; }
  }

  // The last finished backtest, so GET /api/backtest can answer after a
  // reload or a view change the same way the engine's own state does.
  let lastBacktest = null;

  // Every open demo socket, so a route can push the way the engine pushes.
  const LIVE = new Set();

  /** Send a frame to the desk, as the engine's socket would. */
  function broadcast(msg) {
    // A beat of delay, so the POST has returned and the desk is showing its
    // running state before the result lands on top of it.  Without it the
    // result arrives first and the spinner is what the visitor is left
    // looking at.
    setTimeout(() => { for (const sock of LIVE) sock._emit(msg); }, 260);
  }

  function route(method, url, init) {
    const u = new URL(url, location.href);
    const p = u.pathname.replace(/^.*(\/api\/)/, "/api/");   // Pages serves under /AURION/

    if (method !== "GET") {
      // The gate is the one write the demo must honour, or the visitor never
      // gets past the key screen to see anything at all.
      if (p === "/api/auth/license-session") {
        return { ok: true, data: { token: "demo", user: demoUser() }, license: license().data };
      }
      if (p === "/api/license/activate") {
        return { ok: false, error: "demo", message: "Keys are activated by the real desk, not the demo." };
      }
      if (p === "/api/auth/language") {
        return { ok: true, data: { user: demoUser(), token: "demo" } };
      }
      if (p === "/api/market") {
        const body = { symbol: u.searchParams.get("symbol") || "EURUSD" };
        return { ok: true, bars: 800, symbol: body.symbol };
      }
      if (p === "/api/auth/logout") return { ok: true };

      /* A backtest is a simulation, so the demo runs it for real.

         Rule 2 refuses writes because a write has an effect in the world -
         an order reaches a broker, a key activates a machine. A replay over
         historical bars has no such effect; it is arithmetic. Refusing it
         left the single most-asked-for panel in the product permanently
         dead behind a button that reported an error, which teaches a
         visitor the opposite of the truth.

         The real desk answers immediately and delivers the result over the
         socket, so the demo does the same -- same two-step, same code path
         in app.js, no demo-shaped special case on the receiving end. */
      if (p === "/api/backtest") {
        const body = jsonBody(init);
        const symbol = body.symbol || "EURUSD";
        const timeframe = body.timeframe || "M15";
        const name = (body.strategy && body.strategy.name) || "ema_rsi";
        const result = backtestRun(symbol, timeframe, name);
        lastBacktest = result;
        broadcast({ type: "backtest", data: result });
        return { ok: true, accepted: true, running: true, symbol, timeframe };
      }

      return READONLY;
    }

    // The language packs must miss.  i18n.js asks the API first and falls
    // back to lang/<code>.json, which is published alongside the desk and is
    // the only copy that exists here.  Answering with the catch-all empty
    // success below would satisfy its `if (data)` test and leave every label
    // in the interface showing its raw key.
    if (p.startsWith("/api/i18n/")) return MISS;

    if (p === "/api/snapshot") return snapshot();
    if (p === "/api/license") return license();

    if (p === "/api/candles") {
      const symbol = u.searchParams.get("symbol") || "EURUSD";
      const tf = u.searchParams.get("timeframe") || "M15";
      const count = Math.min(Number(u.searchParams.get("count")) || 800, 1500);
      return { ok: true, data: candles(symbol, tf, count), count, synthetic: true };
    }

    /* Marks that sit on the bars the chart is actually drawing.

       This returned [] before, so "charts with signals" -- a headline
       feature -- rendered a chart with nothing on it. The marks come from
       simulate(), which walks the same seeded series /api/candles returns,
       so a visitor who zooms into a mark finds the crossover that caused
       it. `count` is honoured because the desk asks for 800 and the marks
       have to be indexed against that exact window. */
    if (p === "/api/chart/signals") {
      const symbol = u.searchParams.get("symbol") || "EURUSD";
      const tf = u.searchParams.get("timeframe") || "M15";
      const count = Math.min(Number(u.searchParams.get("count")) || 800, 1500);
      const sim = simulate(symbol, tf, count);
      return { ok: true, signals: sim.signals, data: { signals: sim.signals }, count: sim.signals.length };
    }

    if (p === "/api/backtest") {
      return lastBacktest
        ? { ok: true, data: lastBacktest }
        : { ok: true, data: { ok: false, running: false, mode: "backtest", empty: true, no_trades: true } };
    }

    /* The captured ledger is empty -- the desk it was recorded from had
       never placed a trade -- so the history table, the P&L charts and
       every total that reads them were blank. These are the demo robot's
       own closed trades, which is why the equity line here and the
       backtest card agree: both are summing the same list. */
    if (p === "/api/history") {
      const limit = Number(u.searchParams.get("limit")) || 400;
      return { ok: true, data: history(limit) };
    }

    if (p === "/api/agents") return { ok: true, data: agents() };

    if (p === "/api/symbols") {
      const f = fixture("/api/symbols") || { ok: true, data: {} };
      f.data = Object.assign({}, f.data, {
        broker: Object.keys(INSTRUMENTS),
        online: WATCH,
        watchlist: WATCH,
        active: "EURUSD",
        source: "demo",
      });
      return f;
    }

    const hit = fixture(p, u.search);
    if (hit) return hit;
    // Unknown read: an empty success keeps the panel quiet instead of
    // throwing a red error at a visitor who just clicked a tab.
    return { ok: true, data: [] };
  }

  function demoUser() {
    return {
      id: "demo",
      username: "demo",
      display_name: "Demo visitor",
      role: "owner",
      is_owner: true,
      language: (function () { try { return localStorage.getItem("aurion.lang") || "en"; } catch { return "en"; } })(),
      timezone: "UTC",
      disabled: false,
    };
  }

  /**
   * The demo is licensed.
   *
   * The captured licence is freemium, which is correct for a fresh install
   * and wrong for a shop window: it puts a key gate in front of a visitor who
   * has no key and cannot get one here, and then locks eight of the things
   * they came to look at.  Nobody evaluates prop profiles through a
   * screenshot of a padlock.
   *
   * So the demo reports a paid licence with every feature on.  That costs
   * nothing in the real product -- the licence that matters is the one the
   * engine signs and checks, and there is no engine here.  This only decides
   * what the interface draws.  The banner says the whole page is a demo, and
   * key activation is still refused rather than faked, so nothing here tells
   * a visitor they own something they do not.
   */
  const DEMO_PLAN_DAYS = 365;

  function license() {
    const f = fixture("/api/license") || { ok: true, data: {} };
    const d = f.data || {};

    const now = Date.now();
    const expires = new Date(now + DEMO_PLAN_DAYS * 86400000);

    // Every gated capability, read off the captured licence rather than
    // listed here, so a feature added later is unlocked without anyone
    // remembering to come back and edit this.
    const features = {};
    for (const k of Object.keys(d.features || {})) features[k] = true;
    for (const k of d.locked || []) features[k] = true;

    f.data = Object.assign({}, d, {
      plan: "y1",
      plan_label: "12 months",
      months: 12,
      account_type: "premium",
      premium: true,
      paid: true,
      trial: false,
      expired: false,
      developer: false,
      identity: "demo@axiasoft",
      activated: new Date(now - 86400000).toISOString(),
      expires: expires.toISOString(),
      days_left: DEMO_PLAN_DAYS,
      hours_left: DEMO_PLAN_DAYS * 24,
      machine_ok: true,
      tampered: false,
      clock_rollback: false,
      remote_revoked: "",
      last_heartbeat: new Date().toISOString(),
      // Auto-trade is rate limited on free machines; a paid one is not.
      bot_trades: 0,
      bot_limit: 0,
      bot_remaining: 0,
      bot_ok: true,
      bot_lock_until: null,
      features,
      locked: [],
    });
    return f;
  }

  /* ============================================================== fetch == */

  // Guarded rather than assumed: jsdom, which the demo's own test runs in,
  // ships neither fetch nor Response, and a hard reference to either turns a
  // test failure into an unreadable "cannot read properties of undefined".
  const realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  function reply(body, forced) {
    const status = forced || (body && body.ok === false && body.error === "demo" ? 403 : 200);
    const text = JSON.stringify(body);
    if (typeof Response === "function") {
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    }
    return {
      ok: status < 400,
      status,
      headers: { get: (k) => (/^content-type$/i.test(k) ? "application/json" : null) },
      json: async () => JSON.parse(text),
      text: async () => text,
      blob: async () => ({ size: text.length }),
    };
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

    if (!/\/api\//.test(url)) {
      if (realFetch) return realFetch(input, init);
      throw new Error("demo: no network fetch available for " + url);
    }

    const body = route(method, url, init);
    // A touch of latency: without it the desk's spinners never render and the
    // whole thing flickers in a way the real app never does.
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
    if (body === MISS) return reply({ ok: false, error: "not_found" }, 404);
    return reply(body);
  };

  /* ========================================================== websocket == */

  const RealWS = window.WebSocket || function () { throw new Error("demo: no WebSocket"); };

  /**
   * Stands in for the desk's /ws feed.  Only the surface the desk actually
   * uses is implemented -- onopen/onmessage/onclose/send/close -- because the
   * desk is the only client this will ever have.
   */
  class DemoSocket {
    constructor(url) {
      if (!/\/ws$/.test(String(url))) return new RealWS(url);
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._timers = [];
      setTimeout(() => this._open(), 80);
    }
    _emit(msg) {
      if (this.readyState !== 1 || !this.onmessage) return;
      try { this.onmessage({ data: JSON.stringify(msg) }); } catch {}
    }
    _open() {
      this.readyState = 1;
      LIVE.add(this);
      if (this.onopen) try { this.onopen({}); } catch {}
      this._emit({ type: "ready" });
      this._emit({ type: "hello", data: snapshot().data });
      // A slow heartbeat: enough for the tape and the price chips to move so
      // the desk is visibly live, not so much that a background tab burns a
      // phone battery for a demo.
      this._timers.push(setInterval(() => {
        for (const s of WATCH) this._emit({ type: "tick", data: tick(s) });
      }, 2000));
      this._timers.push(setInterval(() => {
        const pos = positions();
        this._emit({ type: "positions", data: { items: pos } });
        this._emit({ type: "account", data: account(pos) });
        this._emit({ type: "agents", data: agents() });
      }, 5000));
    }
    send() { /* the demo has nothing to say back */ }
    close() {
      this.readyState = 3;
      LIVE.delete(this);
      this._timers.forEach(clearInterval);
      this._timers = [];
      if (this.onclose) try { this.onclose({}); } catch {}
    }
    addEventListener(type, fn) { this["on" + type] = fn; }
    removeEventListener(type) { this["on" + type] = null; }
  }
  DemoSocket.OPEN = 1;
  DemoSocket.CLOSED = 3;
  window.WebSocket = DemoSocket;

  /* ============================================================= banner == */

  const BANNER = {
    en: ["Demo", "Sample data, every feature unlocked. No broker, no engine, nothing is traded."],
    fa: ["دمو", "داده‌ی نمونه، همه‌ی قابلیت‌ها باز. بدون بروکر، بدون موتور، هیچ معامله‌ای انجام نمی‌شود."],
    ar: ["عرض", "بيانات نموذجية وكل الميزات مفتوحة. بلا وسيط ولا محرك، ولا تنفيذ لأي صفقة."],
  };

  function banner() {
    let lang = "en";
    try { lang = localStorage.getItem("aurion.lang") || "en"; } catch {}
    const [tag, text] = BANNER[lang] || BANNER.en;
    const rtl = lang === "fa" || lang === "ar";
    const el = document.createElement("div");
    el.id = "demo-banner";
    el.dir = rtl ? "rtl" : "ltr";
    el.innerHTML = `<strong>${tag}</strong><span>${text}</span>`;
    const css = document.createElement("style");
    css.textContent = `
      #demo-banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;
        display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;
        padding:7px 14px;background:#1b1205;border-top:1px solid #6b4a12;
        color:#e8b83c;font:12px/1.5 system-ui,"Segoe UI",sans-serif}
      #demo-banner strong{background:#e8b83c;color:#1b1205;border-radius:4px;
        padding:1px 7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
      #demo-banner span{color:#c9a861}
      @media(max-width:520px){#demo-banner span{display:none}}
    `;
    document.head.appendChild(css);
    document.body.appendChild(el);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", banner);
  } else {
    banner();
  }

  /* =========================================================== fixtures == */

  // Warn once, after the parser has had a chance to run the written script.
  // Without this the demo degrades silently into its catch-alls -- which is
  // exactly what it did until the lazy read above replaced a load-time
  // capture that always saw an empty global.
  setTimeout(function () {
    if (!Object.keys(fixtures()).length) {
      console.error("demo: demo/fixtures.js did not load - serving synthesised data only");
    }
  }, 0);
})();
