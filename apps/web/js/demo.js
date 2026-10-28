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
        this._emit({ type: "agents", data: agents() });
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
