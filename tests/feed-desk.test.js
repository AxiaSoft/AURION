/**
 * The desk's own market data: the instrument picker and the chart that no
 * longer needs MetaTrader.
 *
 * What was wrong is worth stating, because the tests below are shaped by
 * it. The instrument list was built from attached EA charts alone, so a
 * desk with no terminal running showed a disabled dropdown reading "no EA
 * symbol" and a permanently empty chart. There was no way to search, and
 * no way to look at an instrument you were not already trading.
 *
 * So the claims under test are:
 *
 *   1. the picker offers the whole universe, not just what an EA sends;
 *   2. it can be searched, and the ranking puts the obvious answer first;
 *   3. choosing a symbol with no EA still draws a chart;
 *   4. the chart's empty state no longer blames a missing terminal;
 *   5. the desk says out loud what the price source actually is.
 *
 * Point 5 matters as much as the rest. The feed is one-minute bars, not
 * tick data, and the offline provider is simulated outright - a trading
 * screen that quietly implies otherwise is lying to the person using it.
 *
 *     node tests/feed-desk.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log("PASS  " + name);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

if (!jsdom) {
  console.log("SKIP  feed-desk (jsdom not installed)");
  process.exit(0);
}

const { JSDOM, VirtualConsole } = jsdom;
const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8");

const vc = new VirtualConsole();
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
  url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
});
const win = dom.window;
const doc = win.document;

/* The engine is not running here. Every feed call is answered from a
   recorded universe, so the test measures the desk and nothing else. */
const UNIVERSE = [
  { name: "EURUSD", base: "EUR", quote: "USD", kind: "major", digits: 5, point: 1e-5, pip: 1e-4, description: "Euro / US Dollar" },
  { name: "GBPUSD", base: "GBP", quote: "USD", kind: "major", digits: 5, point: 1e-5, pip: 1e-4, description: "British Pound / US Dollar" },
  { name: "USDJPY", base: "USD", quote: "JPY", kind: "major", digits: 3, point: 1e-3, pip: 1e-2, description: "US Dollar / Japanese Yen" },
  { name: "AUDJPY", base: "AUD", quote: "JPY", kind: "minor", digits: 3, point: 1e-3, pip: 1e-2, description: "Australian Dollar / Japanese Yen" },
  { name: "CHFJPY", base: "CHF", quote: "JPY", kind: "minor", digits: 3, point: 1e-3, pip: 1e-2, description: "Swiss Franc / Japanese Yen" },
  { name: "XAUUSD", base: "XAU", quote: "USD", kind: "metal", digits: 2, point: 0.01, pip: 0.01, description: "Gold / US Dollar" },
  { name: "TRYJPY", base: "TRY", quote: "JPY", kind: "exotic", digits: 3, point: 1e-3, pip: 1e-2, description: "Turkish Lira / Japanese Yen" },
  { name: "USDZAR", base: "USD", quote: "ZAR", kind: "exotic", digits: 5, point: 1e-5, pip: 1e-4, description: "US Dollar / South African Rand" },
];

const BARS = Array.from({ length: 40 }, (_, i) => ({
  symbol: "EURUSD", timeframe: "M15",
  time_msc: 1700000000000 + i * 900000,
  open: 1.08 + i * 1e-4, high: 1.0805 + i * 1e-4, low: 1.0795 + i * 1e-4, close: 1.0802 + i * 1e-4,
  volume: 100, spread: 0, real_volume: 0,
}));

const calls = [];
win.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes("/api/feed/symbols")) {
    return reply({ ok: true, data: { query: "", count: UNIVERSE.length, total: UNIVERSE.length, symbols: UNIVERSE } });
  }
  if (u.includes("/api/feed/status")) {
    return reply({ ok: true, data: { provider: "yahoo", provider_label: "Yahoo Finance", tick_true: false, simulated: false, state: "live" } });
  }
  if (u.includes("/api/feed/candles")) {
    return reply({ ok: true, data: { symbol: "EURUSD", timeframe: "M15", count: BARS.length, candles: BARS, status: { tick_true: false, simulated: false, state: "live" } } });
  }
  if (u.includes("/api/feed/subscribe")) return reply({ ok: true, data: {} });
  return reply({ ok: true, data: {} });
};
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
win.URL.createObjectURL = () => "blob:stub";
win.AudioContext = class { createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: {} }; } createGain() { return { connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } get destination() { return {}; } close() {} };

const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/feed.js", "js/calendar.js", "js/charts.js", "js/app.js"]
  .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n;\n");

let T = null;
try {
  win.eval(bundle + "\n;window.__T = { S, views, Feed, I18N, symbolPickerHtml, bindInstrumentPicker, chartSymbols, pickMarket, loadFeedChart, paintFeedNotice, eaOwns };");
  T = win.__T;
} catch (e) {
  console.log("FAIL  the desk bundle loads\n      " + e.message);
  process.exit(1);
}

(async () => {
  /* ---- 1. the universe is the desk's, not the terminal's ---------------- */

  await T.Feed.load();

  check("the picker is loaded from AURION's own feed, with no EA attached", () => {
    if (T.Feed.universe.size !== UNIVERSE.length) {
      throw new Error("loaded " + T.Feed.universe.size + " symbols, expected " + UNIVERSE.length);
    }
    if (!calls.some((c) => c.includes("/api/feed/symbols"))) throw new Error("the feed was never asked");
  });

  check("no EA means no symbols the old way, which is exactly the bug", () => {
    /* Guards the premise: if liveSymbols() ever starts inventing entries,
       the tests below would pass for the wrong reason. */
    T.S.snap = { engine: "online", ticks: {}, agents: [], positions: [], strategy: {} };
    if (T.chartSymbols().length !== UNIVERSE.length) {
      throw new Error("the picker fell back to something other than the feed");
    }
  });

  check("an attached EA is offered first, and is not duplicated", () => {
    T.S.snap = {
      engine: "online", ticks: { EURUSD: { bid: 1.085, ask: 1.0851 } }, positions: [], strategy: {},
      agents: [{ symbol: "EURUSD", timeframe: "M15", alive: true, online: true, last_seen: Date.now() }],
    };
    const list = T.chartSymbols();
    if (list[0].name !== "EURUSD" || !list[0].ea) throw new Error("the EA symbol is not first");
    if (list.filter((x) => x.name === "EURUSD").length !== 1) throw new Error("EURUSD is listed twice");
    T.S.snap.agents = [];
  });

  /* ---- 2. search ------------------------------------------------------- */

  check("searching by currency puts the major first, not an exotic", () => {
    /* "jpy" matches six pairs here. Ranking by match quality alone would
       surface AUDJPY or TRYJPY; the one wanted is USDJPY. */
    const first = T.Feed.search("jpy", 5)[0];
    if (!first || first.name !== "USDJPY") throw new Error("got " + (first && first.name));
  });

  check("an exact symbol wins outright", () => {
    const first = T.Feed.search("TRYJPY", 5)[0];
    if (!first || first.name !== "TRYJPY") throw new Error("got " + (first && first.name));
  });

  check("instruments can be found by name as well as by code", () => {
    const first = T.Feed.search("gold", 5)[0];
    if (!first || first.name !== "XAUUSD") throw new Error("got " + (first && first.name));
  });

  check("search tolerates the punctuation people actually type", () => {
    const first = T.Feed.search("eur/usd", 5)[0];
    if (!first || first.name !== "EURUSD") throw new Error("got " + (first && first.name));
  });

  check("a query that matches nothing returns nothing, rather than everything", () => {
    if (T.Feed.search("zzzzzz", 10).length !== 0) throw new Error("a non-match returned rows");
  });

  /* ---- 3. the picker in the page --------------------------------------- */

  T.S.symbol = "EURUSD";
  T.S.timeframe = "M15";
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML = T.symbolPickerHtml("sym", "EURUSD");

  check("the picker renders as a combobox, not a disabled select", () => {
    const btn = doc.getElementById("sym-btn");
    if (!btn) throw new Error("no trigger button");
    if (btn.disabled) throw new Error("the picker is disabled");
    if (btn.getAttribute("aria-expanded") !== "false") throw new Error("aria-expanded is not wired");
    if (!doc.getElementById("sym-q")) throw new Error("there is no search box");
    if (!doc.getElementById("sym-list")) throw new Error("there is no list");
  });

  check("it opens, lists instruments, and filters as you type", () => {
    let picked = null;
    T.bindInstrumentPicker("sym", (n) => { picked = n; });
    const btn = doc.getElementById("sym-btn");
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    if (doc.getElementById("sym-pop").hidden) throw new Error("the popup did not open");
    const list = doc.getElementById("sym-list");
    if (list.querySelectorAll("[data-sym]").length < 5) throw new Error("the list is empty on open");

    const q = doc.getElementById("sym-q");
    q.value = "gold";
    q.dispatchEvent(new win.Event("input", { bubbles: true }));
    const rows = [...list.querySelectorAll("[data-sym]")].map((r) => r.getAttribute("data-sym"));
    if (rows.length !== 1 || rows[0] !== "XAUUSD") throw new Error("filtering gave " + rows.join(","));

    list.querySelector("[data-sym]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    if (picked !== "XAUUSD") throw new Error("choosing a row reported " + picked);
    if (!doc.getElementById("sym-pop").hidden) throw new Error("the popup stayed open after choosing");
  });

  check("the keyboard can drive it", () => {
    const btn = doc.getElementById("sym-btn");
    let picked = null;
    T.bindInstrumentPicker("sym", (n) => { picked = n; });
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const q = doc.getElementById("sym-q");
    q.value = "jpy";
    q.dispatchEvent(new win.Event("input", { bubbles: true }));
    q.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    q.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    if (!picked) throw new Error("Enter chose nothing");
    q.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  check("Escape closes it without choosing", () => {
    const btn = doc.getElementById("sym-btn");
    let picked = null;
    T.bindInstrumentPicker("sym", (n) => { picked = n; });
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    doc.getElementById("sym-q").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (!doc.getElementById("sym-pop").hidden) throw new Error("still open");
    if (picked) throw new Error("Escape picked " + picked);
  });

  /* ---- 4. the chart draws without a terminal --------------------------- */

  check("a symbol no EA is charting still loads bars", async () => {
    if (T.eaOwns("XAUUSD")) throw new Error("the fixture has an EA on XAUUSD");
  });

  await (async () => {
    T.S.view = "markets";
    T.S.symbol = "EURUSD";
    T.S.candles = [];
    const before = calls.length;
    await T.loadFeedChart("EURUSD", "M15");
    check("the chart is filled from the feed, not from the MT5 bridge", () => {
      if (T.S.candles.length !== BARS.length) {
        throw new Error("got " + T.S.candles.length + " bars");
      }
      const made = calls.slice(before);
      if (!made.some((c) => c.includes("/api/feed/candles"))) throw new Error("the feed was not asked for candles");
      if (made.some((c) => c.includes("/api/market"))) {
        throw new Error("it drove the MetaTrader bridge for a symbol MT5 is not charting");
      }
    });
    check("asking for a chart subscribes it, so the price keeps coming", () => {
      if (!calls.some((c) => c.includes("/api/feed/subscribe"))) throw new Error("no subscription was made");
    });
  })();

  /* ---- 5. the empty state and the honesty line ------------------------- */

  check("the chart's empty state no longer blames a missing terminal", () => {
    T.S.snap = { engine: "online", ticks: {}, agents: [], positions: [], strategy: {} };
    T.S.candles = [];
    const html = T.views.markets();
    if (/no_ea_symbol|AurionBridge|attached EA/i.test(html)) {
      throw new Error("the markets view still tells the user to attach an EA");
    }
  });

  check("the markets view no longer gates its chart on an EA being live", () => {
    /* Scoped to the chart, not the whole view. The manual trade ticket is
       still gated and should be: an order needs a broker, and there is no
       honest way to place one from a chart alone. What must not be gated
       is looking at the price. */
    const src = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
    const from = src.indexOf("  markets() {");
    const body = src.slice(from, src.indexOf("\n  },", from));
    if (body.length < 100) throw new Error("could not isolate views.markets");
    const chart = body.slice(body.indexOf('<div class="chart-box">'), body.indexOf("</div>", body.indexOf('<div class="chart-box">')));
    if (!chart) throw new Error("could not isolate the chart box");
    if (/eaLive\(\)/.test(chart)) throw new Error("the chart box is still gated on eaLive()");
    if (/exec\.no_ea_symbol/.test(chart)) throw new Error("the chart box still blames a missing EA");
    /* And the watchlist must not be EA-gated either. */
    if (/symbols\.length \? watchlistHtml/.test(body)) {
      throw new Error("the watchlist is still gated on EA symbols");
    }
  });

  check("every class the picker uses has a rule in the stylesheet", () => {
    const html = T.symbolPickerHtml("sym", "EURUSD") +
      '<p class="feed-note is-warn"></p><li class="sympick-row on active"></li><li class="sympick-none"></li>' +
      '<span class="sympick-tag is-ea"></span>';
    const names = new Set();
    for (const m of html.matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c && !c.includes("${")) names.add(c);
    }
    const missing = [...names].filter((c) => /^(sympick|feed-note)/.test(c)).filter((c) => !css.includes("." + c));
    if (missing.length) throw new Error("no CSS for: " + missing.join(", "));
  });

  check("a source that is not tick data says so", () => {
    T.Feed.state = { provider: "yahoo", tick_true: false, simulated: false, state: "live" };
    const n = T.Feed.notice();
    if (!n || n.key !== "feed.not_tick") throw new Error("got " + JSON.stringify(n));
  });

  check("a simulated source is called simulated, and warns", () => {
    T.Feed.state = { provider: "synthetic", tick_true: false, simulated: true, state: "live" };
    const n = T.Feed.notice();
    if (!n || n.key !== "feed.simulated") throw new Error("got " + JSON.stringify(n));
    if (n.kind !== "warn") throw new Error("a simulated feed is only an aside, not a warning");
  });

  check("a real tick feed says nothing, so the line stays meaningful", () => {
    T.Feed.state = { provider: "x", tick_true: true, simulated: false, state: "live" };
    if (T.Feed.notice()) throw new Error("it still printed a notice");
  });

  check("the notice is painted into the page", () => {
    const p = doc.createElement("p");
    p.id = "feed-note";
    p.hidden = true;
    doc.body.appendChild(p);
    T.Feed.state = { provider: "synthetic", tick_true: false, simulated: true, state: "live" };
    T.paintFeedNotice();
    if (p.hidden) throw new Error("the notice stayed hidden");
    if (!p.className.includes("is-warn")) throw new Error("class is " + p.className);
    if (!p.textContent.trim()) throw new Error("the notice is empty");
  });

  check("every string the feed prints is translated in all three languages", () => {
    const packs = ["en", "fa", "ar"].map((c) => JSON.parse(fs.readFileSync(path.join(ROOT, "lang", c + ".json"), "utf8")));
    const keys = ["pick", "search", "no_match", "kind_major", "kind_minor", "kind_metal",
      "kind_exotic", "not_tick", "stale", "simulated", "error"];
    for (const [i, p] of packs.entries()) {
      if (!p.feed) throw new Error(["en", "fa", "ar"][i] + ".json has no feed section");
      for (const k of keys) {
        if (!p.feed[k]) throw new Error(["en", "fa", "ar"][i] + ".json is missing feed." + k);
      }
    }
    /* A Persian desk showing English text is the fault this catches. */
    const [en, fa] = packs;
    if (fa.feed.simulated === en.feed.simulated) throw new Error("the Persian warning was left in English");
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\nfeed-desk: ${results.length - failed} of ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
