/* AURION's market data client.
 *
 * The desk used to get its symbol list from whatever MetaTrader charts
 * happened to be attached, so with no EA running the instrument dropdown
 * said "no EA symbol" and the chart stayed blank. This talks to the
 * engine's own feed instead, which needs no terminal.
 *
 * The whole universe is ~150 symbols, which is small enough to fetch once
 * and filter in memory. That matters for the picker: a request per
 * keystroke would make typing feel laggy and would hammer the engine for
 * data that never changes during a session.
 *
 * Prices are NOT polled from here. The engine pushes `tick` and `candle`
 * events over the existing socket, which is what lets the forming candle
 * move as fast as prices arrive rather than once per refresh.
 */
const Feed = {
  /** Every symbol the engine can chart, by name. Loaded once. */
  universe: new Map(),
  groups: {},
  _loaded: false,
  _loading: null,
  /** Last reported feed health, as returned by /api/feed/status. */
  state: null,

  /* ------------------------------------------------------------ loading */

  async load(force) {
    if (this._loaded && !force) return this.universe;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const res = await API.get("/api/feed/symbols?q=&limit=1000");
        const rows = (res && res.data && res.data.symbols) || [];
        this.universe = new Map(rows.map((r) => [r.name, r]));
        this._loaded = rows.length > 0;
      } catch (_) {
        this._loaded = false;
      } finally {
        this._loading = null;
      }
      return this.universe;
    })();
    return this._loading;
  },

  async loadStatus() {
    try {
      const res = await API.get("/api/feed/status");
      this.state = (res && res.data) || null;
    } catch (_) {
      this.state = null;
    }
    return this.state;
  },

  spec(symbol) {
    return this.universe.get(String(symbol || "").toUpperCase()) || null;
  },

  /** Price decimals for a symbol, so the chart never prints 1.08500000. */
  digits(symbol) {
    const s = this.spec(symbol);
    return s && Number.isFinite(s.digits) ? s.digits : 5;
  },

  /* ------------------------------------------------------------- search */

  /**
   * Rank symbols for the picker, in the browser.
   *
   * Mirrors the engine's ordering deliberately: liquidity first, then match
   * quality. Sorting purely by match quality puts nine exotics that merely
   * begin with "JPY" above USDJPY, which is never what was meant.
   */
  search(query, limit) {
    const cap = limit || 40;
    const q = String(query || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const tier = { major: 0, minor: 1, metal: 2, exotic: 3 };
    const all = [...this.universe.values()];
    if (!q) {
      return all
        .slice()
        .sort((a, b) => (tier[a.kind] - tier[b.kind]) || a.name.localeCompare(b.name))
        .slice(0, cap);
    }
    const hits = [];
    for (const s of all) {
      const name = s.name;
      const desc = String(s.description || "").toUpperCase();
      let score;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (s.base === q || s.quote === q) score = 2;
      else if (name.includes(q)) score = 3;
      else if (desc.startsWith(q)) score = 4;
      else if (desc.includes(q)) score = 5;
      else continue;
      hits.push({
        s,
        k: [
          name === q ? 0 : 1,
          tier[s.kind] ?? 9,
          // The dollar leg is the one people chart.
          (s.base === "USD" || s.quote === "USD") ? 0 : 1,
          score,
          name,
        ],
      });
    }
    hits.sort((a, b) => {
      for (let i = 0; i < a.k.length; i += 1) {
        if (a.k[i] !== b.k[i]) return a.k[i] < b.k[i] ? -1 : 1;
      }
      return 0;
    });
    return hits.slice(0, cap).map((h) => h.s);
  },

  /* -------------------------------------------------------------- data */

  async candles(symbol, timeframe, count) {
    const q = new URLSearchParams({
      symbol: String(symbol || ""),
      timeframe: String(timeframe || "M15"),
      count: String(count || 240),
    });
    try {
      const res = await API.get(`/api/feed/candles?${q.toString()}`);
      if (!res || !res.ok) return { ok: false, candles: [], error: (res && res.error) || "feed" };
      const d = res.data || {};
      if (d.status) this.state = d.status;
      return { ok: true, symbol: d.symbol, timeframe: d.timeframe, spec: d.spec, candles: d.candles || [] };
    } catch (err) {
      return { ok: false, candles: [], error: (err && err.message) || "network" };
    }
  },

  async subscribe(symbols, replace) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    try {
      return await API.post("/api/feed/subscribe", { symbols: list.filter(Boolean), replace: !!replace });
    } catch (_) {
      return { ok: false };
    }
  },

  /* ------------------------------------------------------------ honesty */

  /**
   * One line describing what the feed actually is, for the desk to show.
   *
   * Returns null when there is nothing worth saying. The two cases that
   * must never be silent: a simulated source, and a source that is real
   * but is not tick data -- implying tick accuracy on a trading screen
   * would be a lie the user explicitly asked us not to tell.
   */
  notice() {
    const st = this.state;
    if (!st) return null;
    if (st.simulated) return { kind: "warn", key: "feed.simulated" };
    if (st.state === "error") return { kind: "warn", key: "feed.error" };
    if (st.state === "stale") return { kind: "warn", key: "feed.stale" };
    if (!st.tick_true) return { kind: "info", key: "feed.not_tick" };
    return null;
  },
};

if (typeof window !== "undefined") window.Feed = Feed;
if (typeof globalThis !== "undefined") globalThis.Feed = Feed;
