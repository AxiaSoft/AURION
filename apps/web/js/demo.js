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

  // Pull in the 59 KB of captured responses, here rather than from a tag in
  // index.html, so the real desk never downloads demo data it will not use.
  //
  // document.write is the deliberate choice: this script is parser-inserted,
  // so the write lands synchronously and the fixtures are defined before
  // app.js parses and calls boot().  Anything async -- fetch, a dynamic
  // <script>, an import() -- races the licence call that decides whether the
  // key gate appears.  Same-origin and parser-time, so none of the reasons
  // document.write is usually a mistake apply.
  document.write('<script src="demo/fixtures.js?v=desk111"><\/script>');

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
  const INSTRUMENTS = {
    EURUSD: { px: 1.0865, step: 0.00035, digits: 5 },
    GBPUSD: { px: 1.2712, step: 0.00042, digits: 5 },
    USDJPY: { px: 151.42, step: 0.052, digits: 3 },
    USDCHF: { px: 0.8834, step: 0.00031, digits: 5 },
    AUDUSD: { px: 0.6598, step: 0.00030, digits: 5 },
    USDCAD: { px: 1.3604, step: 0.00036, digits: 5 },
    NZDUSD: { px: 0.6012, step: 0.00028, digits: 5 },
    XAUUSD: { px: 2338.4, step: 1.65, digits: 2 },
    XAGUSD: { px: 27.42, step: 0.055, digits: 3 },
    US30:   { px: 39210, step: 28, digits: 1 },
    US500:  { px: 5235.5, step: 4.1, digits: 2 },
    NAS100: { px: 18240, step: 22, digits: 1 },
    GER40:  { px: 18115, step: 19, digits: 1 },
    UK100:  { px: 8142, step: 9, digits: 1 },
    BTCUSD: { px: 64120, step: 185, digits: 2 },
    ETHUSD: { px: 3142, step: 14, digits: 2 },
    WTI:    { px: 79.35, step: 0.28, digits: 2 },
    BRENT:  { px: 83.60, step: 0.29, digits: 2 },
  };

  const TF_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

  function instrument(symbol) {
    return INSTRUMENTS[symbol] || { px: 100, step: 0.4, digits: 2 };
  }

  const barCache = new Map();

  /**
   * A random walk with a slow drift term, which is what makes it read as a
   * market rather than as noise: pure Brownian motion has no trends to see,
   * and a trend is the thing every panel on this desk is about.
   */
  function candles(symbol, timeframe, count) {
    const key = `${symbol}|${timeframe}|${count}`;
    if (barCache.has(key)) return barCache.get(key);

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
      drift = drift * 0.97 + (rand() - 0.5) * inst.step * 0.35;
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
    barCache.set(key, bars);
    return bars;
  }

  function round(n, d) { return Number(n.toFixed(d)); }

  function lastPrice(symbol) {
    const bars = candles(symbol, "M15", 240);
    return bars[bars.length - 1].close;
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
      // Contract size is a per-class thing; this is close enough to make the
      // P/L column plausible without pretending to be a broker's maths.
      const contract = inst.digits >= 5 ? 100000 : (p.symbol === "XAUUSD" ? 100 : 10);
      const profit = round(dir * (now - openPx) * p.volume * contract, 2);
      return {
        ticket: 420100 + i,
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        price_open: openPx,
        price_current: now,
        sl: round(openPx - dir * inst.step * 12, inst.digits),
        tp: round(openPx + dir * inst.step * 20, inst.digits),
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

  let FIX = {};

  function fixture(pathname, search) {
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

    d.ts = new Date().toISOString();
    base.data = d;
    return base;
  }

  /* ============================================================= router == */

  const READONLY = { ok: false, error: "demo", message: "Read-only demo: this action needs the real desk." };

  // Returned for reads the demo must visibly not answer, so the caller takes
  // its own fallback path instead of believing an empty success.
  const MISS = Symbol("miss");

  function route(method, url) {
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

    if (p === "/api/chart/signals") return { ok: true, data: [] };

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

  function license() {
    const f = fixture("/api/license") || { ok: true, data: {} };
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

    const body = route(method, url);
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
      }, 5000));
    }
    send() { /* the demo has nothing to say back */ }
    close() {
      this.readyState = 3;
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
    en: ["Demo", "Sample data. No broker, no engine, nothing is traded.", "Source"],
    fa: ["دمو", "داده‌ی نمونه. بدون بروکر، بدون موتور، هیچ معامله‌ای انجام نمی‌شود.", "سورس"],
    ar: ["عرض", "بيانات نموذجية. بلا وسيط ولا محرك، ولا تنفيذ لأي صفقة.", "المصدر"],
  };

  function banner() {
    let lang = "en";
    try { lang = localStorage.getItem("aurion.lang") || "en"; } catch {}
    const [tag, text, src] = BANNER[lang] || BANNER.en;
    const rtl = lang === "fa" || lang === "ar";
    const el = document.createElement("div");
    el.id = "demo-banner";
    el.dir = rtl ? "rtl" : "ltr";
    el.innerHTML =
      `<strong>${tag}</strong><span>${text}</span>` +
      `<a href="https://github.com/AxiaSoft/AURION" target="_blank" rel="noopener">${src}</a>`;
    const css = document.createElement("style");
    css.textContent = `
      #demo-banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;
        display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;
        padding:7px 14px;background:#1b1205;border-top:1px solid #6b4a12;
        color:#e8b83c;font:12px/1.5 system-ui,"Segoe UI",sans-serif}
      #demo-banner strong{background:#e8b83c;color:#1b1205;border-radius:4px;
        padding:1px 7px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
      #demo-banner span{color:#c9a861}
      #demo-banner a{color:#e8b83c}
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

  // demo/fixtures.js is a plain <script> loaded ahead of this one, so by the
  // time anything here runs the global is already there.  It is a script and
  // not a .json fetch on purpose: app.js calls boot() the moment it parses,
  // and the licence call that decides whether the gate appears happens within
  // milliseconds -- an async load would race it.  A script tag also still
  // works when the page is opened straight off disk, where fetch and XHR on a
  // sibling file are refused.
  FIX = window.AURION_DEMO_FIXTURES || {};
  if (!Object.keys(FIX).length) {
    console.error("demo: fixtures missing -- demo/fixtures.js did not load");
  }
})();
