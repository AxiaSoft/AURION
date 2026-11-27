/**
 * Less loading on open, more history when you drag - and a calendar
 * date that actually lands on its candle.
 *
 * Reported, in four parts:
 *   "the chart loads far too much; when I drag back it should show the
 *    older bars then"
 *   "the engine should serve only the newest candles - but the old
 *    charts must still be reachable"
 *   "the backtest is different: every candle has to be read"
 *   "pressing a date in the calendar leaves the chart on the newest
 *    candles" - and the date must be read as the Gregorian instant,
 *    not through the Jalali or Hijri display.
 *
 *     node tests/chart-lazy-history.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CAL = read("apps", "web", "js", "calendar.js");
const DEMO = read("apps", "web", "js", "demo.js");
const SERVER = read("engine", "aurion", "api", "server.py");
const STORE = read("engine", "aurion", "runtime", "store.py");

const results = [];
const queue = [];
function check(name, fn) { queue.push([name, fn]); }
function pass(n, note) { results.push(true); console.log("PASS  " + n + (note ? "  - " + note : "")); }
function fail(n, e) { results.push(false); console.log("FAIL  " + n + "\n      " + e.message); }

/** Lift one function out of app.js so the arithmetic itself is tested. */
function liftFn(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing");
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  return src.slice(at, end + 1);
}

/** The same, for a method on an object literal (calendar.js). */
function liftMethod(src, name) {
  const re = new RegExp("^  (async )?" + name + "\\([^)]*\\) \\{", "m");
  const m = re.exec(src);
  if (!m) throw new Error(name + " is missing");
  const open = src.indexOf("{", m.index);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  return src.slice(m.index, end + 1).trim();
}

/* ------------------------------------------------- 1. the chart ask */

check("a drag asks for bars BEHIND what is held, not a bigger newest window", () => {
  const body = liftFn(APP, "loadOlderSlab");
  if (!/before=\$\{encodeURIComponent\(before\)\}/.test(body)) {
    throw new Error("the request does not say where the held history begins");
  }
  if (!/mergeOlder\(older/.test(body)) throw new Error("the slab is not prepended to what is held");
  if (/barsForDays\(f\.timeframe, HISTORY_DAYS\)/.test(body)) {
    throw new Error("it is back to pulling the whole promise on a drag");
  }
});

check("the slab is bounded on every timeframe, including M1", () => {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    /const TF_MINUTES = \{[^}]*\};/.exec(APP)[0] + "\n"
    + /const HISTORY_DAYS = \d+;/.exec(APP)[0] + "\n"
    + /const HISTORY_MAX = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_BARS = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_DAY_STEPS = \[[^\]]*\];/.exec(APP)[0] + "\n"
    + liftFn(APP, "barsForDays") + "\n" + liftFn(APP, "pageDays") + "\n"
    + liftFn(APP, "pageWindow") + "\n" + liftFn(APP, "historyStep")
    + "\nthis.historyStep = historyStep; this.PAGE_BARS = PAGE_BARS;", box);
  for (const tf of ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]) {
    const n = box.historyStep(tf);
    if (!Number.isFinite(n)) throw new Error(tf + " gives " + n);
    /* Big enough that a drag is worth making, small enough that no
       single reply is the quarter-million-bar download that caused
       the complaint. */
    if (n < 400) throw new Error(tf + " only fetches " + n + " bars a drag");
    /* The bound is the page budget now, not a number of its own. A
       drag used to have its own formula - twenty days, floored at
       1000, capped at 8000 - unrelated to what a chart opens with or
       to what either actually costs. One budget, both paths; see
       tests/chart-history-paging.test.js. */
    if (n > box.PAGE_BARS * 1.1) {
      throw new Error(tf + " fetches " + n + " bars at once, over the " + box.PAGE_BARS + " budget");
    }
  }
  return "M1 " + box.historyStep("M1") + ", D1 " + box.historyStep("D1");
});

check("older bars are merged without duplicating the joint", () => {
  const box = { console };
  vm.createContext(box);
  /* barTime is charts.js's, and mergeOlder de-duplicates with it. */
  const barTimeSrc = "function barTime(v){let t=String(v==null?'':v).trim();"
    + "if(!t)return '';return t.replace(' ','T').replace(/\\.\\d+/,'')"
    + ".replace(/(Z|[+-]\\d{2}:?\\d{2})$/,'');}";
  vm.runInContext(barTimeSrc + "\n" + liftFn(APP, "mergeOlder") + "\nthis.mergeOlder = mergeOlder;", box);
  const have = [{ time: "b" }, { time: "c" }];
  const out = box.mergeOlder([{ time: "a" }, { time: "b" }], have);
  if (out.length !== 3) throw new Error("got " + out.length + " bars, expected 3");
  if (out[0].time !== "a" || out[2].time !== "c") throw new Error("the order is wrong");
  if (box.mergeOlder([], have) !== have) throw new Error("an empty slab replaced the series");
});

/* --------------------------------------------- 2. the backtest path */

check("the backtest still reads every candle", () => {
  /* The point of the whole change is to send fewer bars - and the one
     place that must NOT happen is the run the trader is measuring. A
     backtest drawn over a month of a six-month run is a lie told with
     a chart. */
  const body = liftFn(APP, "ensureBacktestBars");
  if (!/HISTORY_DAYS/.test(body)) {
    throw new Error("the backtest no longer asks for the full history window");
  }
  if (/before=/.test(body)) throw new Error("the backtest was put on the paged path");
});

check("the engine's backtest and training reads are untouched by paging", () => {
  /* `before` is a chart affordance. If it ever leaks into the server's
     bulk reads, a backtest silently runs on one slab. */
  const paged = SERVER.split("if before:")[1] || "";
  const guard = paged.slice(0, paged.indexOf("return {"));
  if (!/candles_before/.test(guard)) throw new Error("the paged branch does not read the archive");
  /* The archive first, always. The terminal may be asked, but only
     after both the database and the live tape have come up empty -
     otherwise every drag is a download again. */
  const diskAt = guard.indexOf("candles_before");
  const pullAt = guard.indexOf("pull_candles");
  if (pullAt >= 0) {
    if (pullAt < diskAt) throw new Error("the terminal is asked before the archive is read");
    if (!/if not older:[\s\S]{0,200}pull_candles/.test(guard)) {
      throw new Error("the terminal is asked even when older bars are already held");
    }
  }
  const train = SERVER.slice(SERVER.indexOf("/v1/ai/train"));
  if (/before=/.test(train.slice(0, 2000))) throw new Error("training was put on the paged path");
});

/* ------------------------------------------------- 3. the archive */

check("the engine can serve bars older than a mark, oldest first", () => {
  const fn = STORE.slice(STORE.indexOf("def candles_before"));
  const body = fn.slice(0, fn.indexOf("\n    def ", 10));
  if (!/ts<\?/.test(body)) throw new Error("it does not restrict to older bars");
  if (!/ORDER BY ts DESC LIMIT \?/.test(body)) throw new Error("it reads the wrong end of the table");
  if (!/reversed\(rows\)/.test(body)) throw new Error("the slab is not returned oldest-first");
  if (!/bar\["time"\] = bar\.pop\("ts", None\)/.test(body)) {
    throw new Error("the rows keep the column name `ts`, which no reader of a candle understands");
  }
  if (!/min\(size, \d+\)/.test(body)) throw new Error("the slab size is unbounded");
});

check("the demo answers a drag the same way the engine does", () => {
  const at = DEMO.indexOf('if (p === "/api/candles")');
  const body = DEMO.slice(at, DEMO.indexOf('if (p === "/api/chart/signals")', at));
  if (!/searchParams\.get\("before"\)/.test(body)) {
    throw new Error("the demo ignores `before`, so dragging back stops at the first screen");
  }
  if (!/String\(b\.time\) < before/.test(body)) throw new Error("the demo does not filter to older bars");
});

/* ----------------------------------------------- 4. the calendar */

check("the week is written to this machine's disk", () => {
  if (!/CACHE_KEY: "aurion\.cal\.week"/.test(CAL)) throw new Error("there is no stored week");
  const w = CAL.slice(CAL.indexOf("_writeCache()"));
  if (!/localStorage\.setItem\(this\.CACHE_KEY/.test(w.slice(0, 600))) {
    throw new Error("the week is never written down");
  }
  const load = CAL.slice(CAL.indexOf("  async load()"));
  if (!/if \(this\.events\.length\) \{\s*\n\s*this\._cachedAt/.test(load)) {
    throw new Error("an empty answer would overwrite a good copy with nothing");
  }
});

check("re-entering the calendar paints from disk instead of fetching", () => {
  const m = CAL.slice(CAL.indexOf("  async mount(root)"));
  const body = m.slice(0, m.indexOf("\n  /** Cheap"));
  const firstAwait = body.indexOf("await this.load()");
  const firstPaint = body.indexOf("root.innerHTML = this.view()");
  if (firstPaint < 0) throw new Error("mount no longer paints");
  if (firstAwait >= 0 && firstAwait < firstPaint) {
    throw new Error("mount still waits for the network before drawing anything");
  }
  if (!/if \(!this\._stale\(\)\) return;/.test(body)) {
    throw new Error("a fresh stored week is still refetched on every entry");
  }
});

check("the week is fetched at boot, before the desk is on screen", () => {
  if (!/Calendar\.warm\b/.test(APP)) throw new Error("nothing warms the calendar at start-up");
  if (!/async warm\(\)/.test(CAL)) throw new Error("Calendar has no warm()");
  const w = CAL.slice(CAL.indexOf("  async warm()"));
  const body = w.slice(0, w.indexOf("\n  /** Group"));
  if (!/this\._useCache\(\)/.test(body)) throw new Error("boot ignores the stored week");
  if (!/if \(!had \|\| this\._stale\(\)\)/.test(body)) {
    throw new Error("boot downloads the week even when a fresh one is on disk");
  }
});

check("a cached week really does stop the second visit from fetching", () => {
  /* Run, do not read: both guards above survive their own deletion in
     the source text. */
  const store = new Map();
  const box = {
    console,
    document: { body: { contains: () => true } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    calls: 0,
  };
  vm.createContext(box);
  /* The real object, minus everything that needs a browser: load() is
     replaced by a counter and the paint by a no-op, so what is being
     exercised is the caching decision itself. */
  vm.runInContext(`
    const C = {
      events: [], byDay: new Map(), source: "", root: null,
      CACHE_KEY: "aurion.cal.week", REFRESH_MS: 20 * 60 * 1000,
      ${liftMethod(CAL, "_readCache")},
      ${liftMethod(CAL, "_writeCache")},
      ${liftMethod(CAL, "_useCache")},
      ${liftMethod(CAL, "_stale")},
      ${liftMethod(CAL, "_index")},
      ${liftMethod(CAL, "warm")},
      async load() {
        calls += 1;
        this.events = [{ ms: 1, day: "2026-10-05", title: "CPI" }];
        this._cachedAt = Date.now();
        this._writeCache();
      },
    };
    this.C = C;
  `.replace(/\n      async warm/, "\n      async warm"), box);
  return box.C.warm().then(() => {
    if (box.calls !== 1) throw new Error("boot did not fetch a week it did not have");
    /* A fresh desk, same machine: nothing at all should go out. */
    box.C._warmed = false;
    box.C.events = [];
    box.C._cachedAt = 0;
    return box.C.warm().then(() => {
      if (box.calls !== 1) throw new Error("the second start-up fetched again (" + box.calls + " calls)");
      if (box.C.events.length !== 1) throw new Error("the stored week was not restored");
      if (!box.C.byDay.get("2026-10-05")) throw new Error("the restored week was not indexed");
    });
  });
});

/* ------------------------------------------- 5. the date jump */

check("a calendar date walks the chart back until it reaches the day", () => {
  const body = liftFn(APP, "goPendingMoment");
  if (!/loadOlderSlab\(/.test(body)) {
    throw new Error("the jump still asks for one enormous newest window");
  }
  if (!/while|for \(/.test(body)) throw new Error("it gives up after a single slab");
  if (!/!reaches\(\)/.test(body)) throw new Error("nothing checks whether the day was reached");
  if (!/if \(!gained\) break;/.test(body)) throw new Error("it would loop forever at the start of history");
});

check("the instant travelling to the chart is Gregorian, whatever the calendar shows", () => {
  /* The calendar can be displayed in the Jalali or Hijri systems. The
     day key and the moment must still be built from the Gregorian
     fields of a Date - anything else asks the broker for a year that
     has no candles in it. */
  const key = liftMethod(CAL, "_dayKey");
  if (!/getFullYear\(\)/.test(key) || !/getMonth\(\) \+ 1/.test(key) || !/getDate\(\)/.test(key)) {
    throw new Error("_dayKey is not built from Gregorian fields");
  }
  for (const name of ["_fromDayKey", "_dayStart"]) {
    const fn = liftMethod(CAL, name);
    if (/this\.parts\(|this\.system/.test(fn)) throw new Error(name + " reads the display calendar");
  }
  const moment = liftMethod(CAL, "_chartMoment");
  if (/this\.parts\(/.test(moment)) throw new Error("_chartMoment converts through the display calendar");
  /* And the number actually handed over is epoch milliseconds. */
  if (!/data-at="\$\{ms\}"/.test(CAL)) throw new Error("the button does not carry an absolute instant");
  /* The third argument is the instrument the trader picked for this
     date, on a desk with several attached - see cal-chart-pick. The
     instant is what this test is about and it still travels as
     epoch milliseconds. */
  if (!/openCalendarMoment\(btn\.dataset\.day, Number\(btn\.dataset\.at\), symbol\)/.test(CAL)) {
    throw new Error("the click does not pass the instant through");
  }
});

check("_dayKey and _fromDayKey round-trip on a Jalali-displayed day", () => {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(`
    const C = {
      ${liftMethod(CAL, "_dayKey")},
      ${liftMethod(CAL, "_fromDayKey")},
      ${liftMethod(CAL, "_dayStart")},
    };
    this.C = C;`, box);
  /* Nowruz 1405 = 21 March 2026. Whatever the header says, this is the
     day the market traded and the key must say so. */
  const ms = new Date(2026, 2, 21, 14, 30).getTime();
  const key = box.C._dayKey(ms);
  if (key !== "2026-03-21") throw new Error("got " + key);
  const back = box.C._fromDayKey(key);
  if (box.C._dayKey(back) !== key) throw new Error("the round trip moved the day");
  if (box.C._dayStart(key) > ms) throw new Error("the day starts after its own events");
  return key;
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      const note = await fn();
      pass(name, typeof note === "string" ? note : "");
    } catch (e) { fail(name, e); }
  }
  const bad = results.filter((r) => !r).length;
  console.log(`\nchart-lazy-history: ${bad ? bad + " of " + results.length + " checks FAILED" : results.length + " checks passed"}`);
  process.exit(bad ? 1 : 0);
})();
