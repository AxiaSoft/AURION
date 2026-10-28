/**
 * Real market data in the published demo.
 *
 * The demo is a static page: no Node desk, no Python engine. It drew a
 * seeded random walk, so the chart -- the one thing a visitor judges a
 * trading product by -- was invented. It cannot fetch a price itself
 * either, because Yahoo sends no CORS header and a public proxy would
 * put a stranger's uptime in front of our demo.
 *
 * So candles are captured server-side and committed. What has to hold:
 *
 *   1. the capture turns a real Yahoo response into real candles, and
 *      drops the nulls Yahoo pads its arrays with rather than carrying a
 *      price forward into a bar that never traded;
 *   2. it refuses to write anything at all when every symbol fails,
 *      instead of leaving a half-empty file that reads as real;
 *   3. the demo serves those candles when they are there;
 *   4. the demo still works when they are not;
 *   5. the banner says which of the two a visitor is looking at.
 *
 * Point 5 is the one with teeth. A real chart under a banner reading
 * "sample data" is as misleading as fake candles under "real" -- and the
 * live tape stays simulated either way, which the visitor must be told.
 *
 *     node tests/demo-market.test.js
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

/**
 * A recorded Yahoo chart response.
 *
 * Shaped exactly as the real one is, including the nulls: Yahoo pads its
 * arrays for timestamps it has no trade for, and those rows are the
 * interesting case.
 */
function chartPayload({ stamps, open, high, low, close, volume }) {
  return {
    chart: {
      result: [{
        meta: { currency: "USD" },
        timestamp: stamps,
        indicators: { quote: [{ open, high, low, close, volume }] },
      }],
      error: null,
    },
  };
}

(async () => {
  const mod = await import("../scripts/capture-demo-market.mjs");
  const { parseChart, fold, capture, serialise, INSTRUMENTS, TIMEFRAMES } = mod;

  /* ---- 1. parsing a real response -------------------------------------- */

  const base = 1735689600; // 2025-01-01T00:00:00Z
  const payload = chartPayload({
    stamps: [base, base + 900, base + 1800, base + 2700],
    open: [1.08000, null, 1.08200, 1.08300],
    high: [1.08100, null, 1.08250, 1.08400],
    low: [1.07950, null, 1.08150, 1.08280],
    close: [1.08050, null, 1.08240, 1.08390],
    volume: [120, null, 140, 150],
  });

  check("a Yahoo response becomes candles in the desk's own shape", () => {
    const bars = parseChart(payload, "EURUSD", "M15", 5);
    if (bars.length !== 3) throw new Error("got " + bars.length + " bars, expected 3");
    const b = bars[0];
    for (const k of ["symbol", "timeframe", "time", "ts", "time_msc", "open", "high", "low", "close", "volume"]) {
      if (!(k in b)) throw new Error("the bar has no " + k);
    }
    if (b.symbol !== "EURUSD" || b.timeframe !== "M15") throw new Error("the bar is not labelled");
    if (b.time_msc !== base * 1000) throw new Error("the timestamp is wrong: " + b.time_msc);
    if (b.open !== 1.08 || b.close !== 1.0805) throw new Error("prices were altered");
  });

  check("a bar that never traded is dropped, not carried forward", () => {
    /* Yahoo's nulls are holidays and halts. Filling them with the
       previous close would put a flat candle on the chart for a time the
       market was shut, which is an invented price like any other. */
    const bars = parseChart(payload, "EURUSD", "M15", 5);
    if (bars.some((b) => b.time_msc === (base + 900) * 1000)) {
      throw new Error("the null row was kept");
    }
    if (bars.some((b) => [b.open, b.high, b.low, b.close].some((v) => !Number.isFinite(v)))) {
      throw new Error("a non-numeric price survived");
    }
  });

  check("prices are rounded to the instrument's own digits", () => {
    const odd = chartPayload({
      stamps: [base], open: [2345.6789], high: [2350.1234], low: [2340.9876], close: [2348.5432], volume: [10],
    });
    const bars = parseChart(odd, "XAUUSD", "H1", 2);
    if (bars[0].close !== 2348.54) throw new Error("got " + bars[0].close);
  });

  check("an error response yields nothing rather than throwing", () => {
    if (parseChart({ chart: { result: null, error: "Not Found" } }, "X", "M15", 5).length !== 0) {
      throw new Error("it invented bars from an error");
    }
    if (parseChart({}, "X", "M15", 5).length !== 0) throw new Error("it invented bars from junk");
  });

  /* ---- 2. folding the timeframe Yahoo does not serve -------------------- */

  check("four one-hour bars fold into one four-hour bar correctly", () => {
    const hour = 3600000;
    const bars = [
      { time_msc: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time_msc: hour, open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { time_msc: 2 * hour, open: 14, high: 14, low: 8, close: 9, volume: 3 },
      { time_msc: 3 * hour, open: 9, high: 13, low: 9, close: 12, volume: 4 },
    ];
    const [b] = fold(bars, 4);
    if (b.open !== 10) throw new Error("open came from the wrong bar: " + b.open);
    if (b.close !== 12) throw new Error("close came from the wrong bar: " + b.close);
    if (b.high !== 15) throw new Error("high is not the group's extreme: " + b.high);
    if (b.low !== 8) throw new Error("low is not the group's extreme: " + b.low);
    if (b.volume !== 10) throw new Error("volume was not summed: " + b.volume);
    if (b.time_msc !== 0) throw new Error("the bar is not stamped at its open");
  });

  check("a part-finished group is dropped, not shown as a whole bar", () => {
    const bars = Array.from({ length: 6 }, (_, i) => ({ time_msc: i, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const out = fold(bars, 4);
    if (out.length !== 1) throw new Error("got " + out.length + " folded bars, expected 1");
  });

  /* ---- 3. the capture as a whole --------------------------------------- */

  const twoTf = [{ tf: "M15", interval: "15m", range: "1mo" }, { tf: "H4", interval: "60m", range: "6mo", fold: 4 }];
  const twoSym = [{ symbol: "EURUSD", ticker: "EURUSD=X", digits: 5 }, { symbol: "XAUUSD", ticker: "GC=F", digits: 2 }];

  const manyStamps = Array.from({ length: 40 }, (_, i) => base + i * 900);
  const okPayload = chartPayload({
    stamps: manyStamps,
    open: manyStamps.map((_, i) => 1.08 + i * 1e-4),
    high: manyStamps.map((_, i) => 1.0805 + i * 1e-4),
    low: manyStamps.map((_, i) => 1.0795 + i * 1e-4),
    close: manyStamps.map((_, i) => 1.0802 + i * 1e-4),
    volume: manyStamps.map(() => 100),
  });

  const asked = [];
  const okFetch = async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => okPayload };
  };

  const captured = await capture({ fetchImpl: okFetch, instruments: twoSym, timeframes: twoTf });

  check("the capture asks the right endpoint for each symbol and timeframe", () => {
    if (asked.length !== 4) throw new Error("made " + asked.length + " requests, expected 4");
    if (!asked[0].includes("/v8/finance/chart/EURUSD%3DX")) throw new Error("wrong URL: " + asked[0]);
    if (!asked[0].includes("interval=15m")) throw new Error("wrong interval: " + asked[0]);
    if (!asked.some((u) => u.includes("GC%3DF"))) throw new Error("the gold ticker was never asked for");
  });

  check("the captured payload is keyed by symbol and timeframe", () => {
    const s = captured.symbols;
    if (!s.EURUSD || !s.XAUUSD) throw new Error("symbols: " + Object.keys(s).join(","));
    if (!s.EURUSD.timeframes.M15 || !s.EURUSD.timeframes.H4) throw new Error("timeframes are missing");
    if (s.XAUUSD.digits !== 2) throw new Error("digits were not carried through");
    if (!captured.captured_at || !captured.source) throw new Error("the payload does not record its own provenance");
  });

  check("H4 really is folded, not served as H1 under another name", () => {
    const m15 = captured.symbols.EURUSD.timeframes.M15.length;
    const h4 = captured.symbols.EURUSD.timeframes.H4.length;
    if (h4 !== Math.floor(m15 / 4)) throw new Error(`M15=${m15} H4=${h4} - H4 was not folded`);
  });

  check("a symbol that fails is recorded, and does not take the others down", () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n <= 2) throw new Error("ECONNRESET");
      return { ok: true, status: 200, json: async () => okPayload };
    };
    return capture({ fetchImpl: flaky, instruments: twoSym, timeframes: twoTf }).then((d) => {
      if (!d.symbols.XAUUSD) throw new Error("the healthy symbol was lost");
      if (d.failures.length !== 2) throw new Error("failures: " + JSON.stringify(d.failures));
    });
  });

  check("when every request fails nothing is captured, so the run can refuse to write", () => {
    const dead = async () => { throw new Error("offline"); };
    return capture({ fetchImpl: dead, instruments: twoSym, timeframes: twoTf }).then((d) => {
      if (Object.keys(d.symbols).length !== 0) throw new Error("it produced symbols from nothing");
    });
  });

  check("an HTTP error is a failure, not an empty success", () => {
    const err = async () => ({ ok: false, status: 429, json: async () => ({}) });
    return capture({ fetchImpl: err, instruments: twoSym, timeframes: twoTf }).then((d) => {
      if (Object.keys(d.symbols).length !== 0) throw new Error("a 429 was treated as data");
      if (!d.failures.some((f) => f.includes("429"))) throw new Error("the status was not reported");
    });
  });

  check("the script refuses to write an empty capture", () => {
    /* The guard is in main(), so this reads it rather than running it -
       but an unguarded write is the fault that would ship fake data
       under a real banner. */
    const src = fs.readFileSync(path.join(ROOT, "scripts", "capture-demo-market.mjs"), "utf8");
    if (!/if \(!n\) \{[\s\S]{0,300}process\.exit\(1\)/.test(src)) {
      throw new Error("main() does not exit non-zero on an empty capture");
    }
  });

  check("the output is a script that assigns a global, not JSON", () => {
    /* The demo runs from file:// too, where fetch() of a local file is
       blocked but a <script> tag still loads. */
    const js = serialise(captured);
    if (!js.includes("window.AURION_DEMO_MARKET =")) throw new Error("it does not assign the global");
    const sandbox = {};
    new Function("window", js)(sandbox);
    if (!sandbox.AURION_DEMO_MARKET.symbols.EURUSD) throw new Error("the emitted file does not evaluate");
  });

  check("every instrument the demo charts has a Yahoo ticker", () => {
    const demoJs = fs.readFileSync(path.join(WEB, "js", "demo.js"), "utf8");
    const block = demoJs.slice(demoJs.indexOf("const INSTRUMENTS = {"), demoJs.indexOf("const TF_MINUTES"));
    const shown = [...block.matchAll(/^\s{4}([A-Z0-9]+):\s*\{/gm)].map((m) => m[1]);
    if (shown.length < 10) throw new Error("could not read the demo's instrument list");
    const have = new Set(INSTRUMENTS.map((i) => i.symbol));
    const missing = shown.filter((s) => !have.has(s));
    if (missing.length) throw new Error("no ticker captured for: " + missing.join(", "));
  });

  check("every timeframe the demo offers is captured", () => {
    const appJs = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
    const m = appJs.match(/\["M1","M5","M15","M30","H1","H4","D1"\]/);
    if (!m) throw new Error("could not find the timeframe list in app.js");
    const have = new Set(TIMEFRAMES.map((t) => t.tf));
    /* M1 is deliberately absent: Yahoo keeps only a few days of it and
       the file would double in size for a timeframe a demo visitor is
       not going to study. It falls back to the generated walk. */
    const missing = ["M5", "M15", "M30", "H1", "H4", "D1"].filter((t) => !have.has(t));
    if (missing.length) throw new Error("not captured: " + missing.join(", "));
  });

  /* ---- 4. the demo page uses it ---------------------------------------- */

  let jsdom = null;
  try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

  if (!jsdom) {
    console.log("SKIP  demo page checks (jsdom not installed)");
  } else {
    const { JSDOM, VirtualConsole } = jsdom;
    const demoSrc = fs.readFileSync(path.join(WEB, "js", "demo.js"), "utf8");

    /**
     * Boot demo.js alone, with or without a captured market, and return
     * what its /api/candles route answers.
     *
     * document.write is stubbed: the real one pulls fixtures.js and
     * market.js off disk, which jsdom will not do with scripts off.
     */
    function bootDemo(market) {
      const vc = new VirtualConsole();
      const d = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
        url: "http://localhost/?demo=1", runScripts: "outside-only", virtualConsole: vc,
      });
      const w = d.window;
      w.document.write = () => {};
      if (market) w.AURION_DEMO_MARKET = market;
      w.AURION_DEMO_FIXTURES = {};
      const realFetch = w.fetch;
      w.fetch = realFetch || (async () => ({ ok: true, status: 200, json: async () => ({}) }));
      w.eval(demoSrc);
      return w;
    }

    const market = { captured_at: "2026-10-20T07:00:00Z", source: "Yahoo Finance", symbols: captured.symbols };

    await (async () => {
      const w = bootDemo(market);
      const res = await w.fetch("/api/candles?symbol=EURUSD&timeframe=M15&count=50");
      const body = await res.json();
      check("the demo serves the real recorded candles", () => {
        if (!body.ok || !body.data.length) throw new Error("no candles came back");
        const real = captured.symbols.EURUSD.timeframes.M15;
        const last = body.data[body.data.length - 1];
        if (last.close !== real[real.length - 1].close) {
          throw new Error("the close does not match the capture: " + last.close);
        }
        if (last.time_msc !== real[real.length - 1].time_msc) {
          throw new Error("the timestamp was shifted - the demo is claiming the bar is newer than it is");
        }
      });
      check("and stops calling them synthetic", () => {
        if (body.synthetic !== false) throw new Error("synthetic is " + body.synthetic);
      });
    })();

    await (async () => {
      const w = bootDemo(null);
      const res = await w.fetch("/api/candles?symbol=EURUSD&timeframe=M15&count=50");
      const body = await res.json();
      check("with no capture the demo still draws, and admits the data is made up", () => {
        if (!body.ok || body.data.length !== 50) throw new Error("the fallback did not draw " + body.data.length);
        if (body.synthetic !== true) throw new Error("it claimed generated bars were real");
      });
    })();

    await (async () => {
      /* A timeframe the capture does not hold must not blank the chart. */
      const w = bootDemo(market);
      const res = await w.fetch("/api/candles?symbol=EURUSD&timeframe=M1&count=30");
      const body = await res.json();
      check("a timeframe that was not captured falls back instead of blanking", () => {
        if (!body.data.length) throw new Error("M1 returned nothing");
        if (body.synthetic !== true) throw new Error("the fallback claimed to be real");
      });
    })();

    function bannerText(market) {
      const w = bootDemo(market);
      w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
      const el = w.document.getElementById("demo-banner");
      return el ? el.textContent : "";
    }

    check("the banner says the candles are real, and names the day", () => {
      const t = bannerText(market);
      if (!/real market candles/i.test(t)) throw new Error("banner reads: " + t);
      if (!t.includes("2026-10-20")) throw new Error("the capture date is not shown: " + t);
    });

    check("...and still says the live price is not", () => {
      const t = bannerText(market);
      if (!/simulated/i.test(t)) throw new Error("banner reads: " + t);
    });

    check("without a capture the banner goes back to calling it sample data", () => {
      const t = bannerText(null);
      if (!/sample data/i.test(t)) throw new Error("banner reads: " + t);
      if (/real market candles/i.test(t)) throw new Error("it claimed real data it does not have");
    });

    check("the demo still refuses to trade, real candles or not", () => {
      const w = bootDemo(market);
      return w.fetch("/api/order", { method: "POST", body: "{}" })
        .then((r) => r.json())
        .then((b) => {
          if (b.ok !== false || b.error !== "demo") throw new Error("an order was not refused: " + JSON.stringify(b));
        });
    });
  }

  /* ---- 5. it is wired into the page ------------------------------------ */

  check("the demo page loads the captured market", () => {
    const src = fs.readFileSync(path.join(WEB, "js", "demo.js"), "utf8");
    if (!src.includes("demo/market.js")) throw new Error("demo.js never pulls market.js in");
  });

  check("a missing capture is committed-file-optional, not a build break", () => {
    /* market.js is produced by a scheduled Action. A fresh clone will not
       have one, and that must not stop the demo working. */
    const src = fs.readFileSync(path.join(WEB, "js", "demo.js"), "utf8");
    if (!/realBars\(/.test(src) || !/function realBars/.test(src)) {
      throw new Error("there is no guarded accessor for the captured data");
    }
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\ndemo-market: ${results.length - failed} of ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
