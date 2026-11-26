/**
 * History arrives one page at a time, and a page that has arrived is
 * never thrown away.
 *
 * Asked for in these words:
 *   "load seven days at a time, it is faster"
 *   "do not fetch the next seven until I scroll back past what is
 *    loaded"
 *   "when I come forward again the older candles must not be deleted,
 *    only hidden"
 *   "and the ceiling for every timeframe is the last six months"
 *
 * The seven days needed translating. A page is measured in BARS,
 * because that is what the engine, the wire and the browser actually
 * pay for, and a week means two different things: a week of M1 is
 * 10 080 bars and a week of D1 is five. The budget is PAGE_BARS, and
 * M1 lands on exactly the week that was asked for because a week of
 * M1 IS the budget.
 *
 *     node tests/chart-history-paging.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CHARTS = read("apps", "web", "js", "charts.js");
const HISTORY_PY = read("engine", "aurion", "util", "history.py");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/** Lift one function out of a source file so the arithmetic itself is tested. */
function liftFrom(src, name, where) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing from " + where);
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) { end = i; break; } }
  }
  return src.slice(at, end + 1);
}

const liftFn = (name) => liftFrom(APP, name, "app.js");

const konst = (name) => {
  const m = new RegExp("const " + name + " = [^;]+;").exec(APP);
  if (!m) throw new Error(name + " is missing from app.js");
  return m[0];
};

/** app.js's paging arithmetic, runnable. */
function paging() {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    /const TF_MINUTES = \{[^}]*\};/.exec(APP)[0] + "\n"
    + konst("HISTORY_DAYS") + "\n" + konst("HISTORY_MAX") + "\n"
    + konst("PAGE_BARS") + "\n" + konst("PAGE_DAY_STEPS") + "\n"
    + liftFn("barsForDays") + "\n" + liftFn("pageDays") + "\n"
    + liftFn("pageWindow") + "\n" + liftFn("chartDays") + "\n"
    + liftFn("historyStep") + "\n"
    + "this.pageDays = pageDays; this.pageWindow = pageWindow;"
    + "this.chartDays = chartDays; this.historyStep = historyStep;"
    + "this.barsForDays = barsForDays; this.PAGE_BARS = PAGE_BARS;"
    + "this.HISTORY_DAYS = HISTORY_DAYS;", box);
  return box;
}

const TFS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

/* ── the page itself ───────────────────────────────────────────────── */

check("a page is a bar budget, and every timeframe stays near it", () => {
  const box = paging();
  const out = [];
  for (const tf of TFS) {
    const bars = box.pageWindow(tf);
    if (!Number.isFinite(bars)) throw new Error(tf + " gives " + bars);
    /* The whole point: no single reply is the quarter-million-bar
       download that caused the complaint. A little over the budget is
       allowed - M1's seven days is 10 080 - but nowhere near an order
       of magnitude. */
    if (bars > box.PAGE_BARS * 1.1) {
      throw new Error(tf + " fetches " + bars + " bars in one page, over the " + box.PAGE_BARS + " budget");
    }
    /* And enough bars for an indicator to have an opinion, which is
       the floor barsForDays carries. */
    if (bars < 400) throw new Error(tf + " opens with only " + bars + " bars");
    out.push(tf + " " + box.pageDays(tf) + "d/" + bars);
  }
  return out.join(", ");
});

check("M1 pages in exactly the seven days that were asked for", () => {
  const box = paging();
  const d = box.pageDays("M1");
  if (d !== 7) throw new Error("M1 pages in " + d + " days, not 7");
  return "7 days = " + box.pageWindow("M1") + " bars";
});

check("no page reaches past the six-month ceiling", () => {
  const box = paging();
  for (const tf of TFS) {
    if (box.pageDays(tf) > box.HISTORY_DAYS) {
      throw new Error(tf + " pages in " + box.pageDays(tf) + " days, past the " + box.HISTORY_DAYS + "-day promise");
    }
  }
  return "all within " + box.HISTORY_DAYS + " days";
});

check("opening a chart and dragging it back cost the same page", () => {
  /* They are the same question - "how much history arrives at once" -
     and two answers is how a chart came to open on one amount and
     grow by an unrelated other. */
  const box = paging();
  for (const tf of TFS) {
    const open = box.barsForDays(tf, box.chartDays(tf));
    const drag = box.historyStep(tf);
    if (open !== drag) {
      throw new Error(tf + " opens with " + open + " bars but drags in " + drag);
    }
  }
  return "one number, both paths";
});

check("the old single opening period is gone", () => {
  /* CHART_OPEN_DAYS was thirty days on every timeframe, which is
     43 200 bars of M1 and 2 880 of M15 - seven different loads
     wearing one number. */
  if (/const CHART_OPEN_DAYS/.test(APP)) {
    throw new Error("CHART_OPEN_DAYS is back; a page is per-timeframe now");
  }
  if (/chartDays\(\)/.test(APP)) {
    throw new Error("chartDays() is still called without a timeframe somewhere");
  }
});

check("the desk and the engine agree on the budget", () => {
  /* Two implementations of one policy. They must not drift, or the
     desk asks for pages the engine does not cut on the same
     boundaries. */
  const js = /const PAGE_BARS = (\d+);/.exec(APP);
  if (!js) throw new Error("the desk has no PAGE_BARS");
  const py = /^PAGE_BARS = ([\d_]+)$/m.exec(HISTORY_PY);
  if (!py) throw new Error("the engine has no PAGE_BARS");
  const a = Number(js[1]);
  const b = Number(py[1].replace(/_/g, ""));
  if (a !== b) throw new Error("desk says " + a + ", engine says " + b);
  if (!/def page_days\(/.test(HISTORY_PY)) throw new Error("the engine has no page_days");
  if (!/def page_window\(/.test(HISTORY_PY)) throw new Error("the engine has no page_window");
  return String(a) + " bars, both sides";
});

check("the day ladder is rounded to the NEAREST step, not up", () => {
  /* Rounding up walks off the end of the ladder: M15 wants 104 days,
     the next step is 180, and a chart would open on the entire window
     again - the exact load this change removes. Checked by arithmetic
     rather than by reading the source, because a comment saying
     "nearest" is not a behaviour. */
  const box = paging();
  if (box.pageDays("M15") >= box.HISTORY_DAYS) {
    throw new Error("M15 pages in the whole window, so the rounding went up");
  }
  if (box.pageWindow("M15") > box.PAGE_BARS) {
    throw new Error("M15's page is " + box.pageWindow("M15") + " bars");
  }
  return "M15 " + box.pageDays("M15") + " days";
});

/* ── pages are hidden, never deleted ───────────────────────────────── */

function merging() {
  const box = { console };
  vm.createContext(box);
  vm.runInContext(
    liftFrom(CHARTS, "barTime", "charts.js") + "\n" + liftFn("mergeSeries") + "\n" + liftFn("mergeOlder")
    + "\nthis.mergeSeries = mergeSeries; this.mergeOlder = mergeOlder;", box);
  return box;
}

const bar = (t, close) => ({ time: t, open: 1, high: 1, low: 1, close: close === undefined ? 1 : close });

check("a longer broadcast of recent bars does not delete the pages behind it", () => {
  /* The bug, exactly. A trader pages back through January. An unasked
     `candles` broadcast arrives with MORE bars than are held, but
     starting later - the old rule called that "deeper" and replaced
     the series, so January was deleted and the chart would not go
     back any more. */
  const box = merging();
  const held = [];
  for (let d = 1; d <= 5; d += 1) held.push(bar("2026-01-0" + d + " 00:00:00"));
  const incoming = [];
  for (let d = 1; d <= 9; d += 1) incoming.push(bar("2026-03-0" + d + " 00:00:00"));
  const out = box.mergeSeries(held, incoming);
  if (out.length !== 14) throw new Error("got " + out.length + " bars, expected all 14 kept");
  if (out[0].time !== "2026-01-01 00:00:00") {
    throw new Error("the oldest bar is now " + out[0].time + " - January was deleted");
  }
  return "14 bars, oldest still January";
});

check("an overlapping bar takes the fresher reading, and is not duplicated", () => {
  const box = merging();
  const held = [bar("2026-01-01 00:00:00", 1), bar("2026-01-02 00:00:00", 2)];
  const incoming = [bar("2026-01-02 00:00:00", 99), bar("2026-01-03 00:00:00", 3)];
  const out = box.mergeSeries(held, incoming);
  if (out.length !== 3) throw new Error("got " + out.length + " bars, expected 3");
  if (out[1].close !== 99) throw new Error("the overlapping bar kept the stale value");
  return "3 bars, overlap refreshed";
});

check("the union comes back in time order", () => {
  const box = merging();
  const out = box.mergeSeries(
    [bar("2026-01-05 00:00:00"), bar("2026-01-09 00:00:00")],
    [bar("2026-01-01 00:00:00"), bar("2026-01-07 00:00:00")],
  );
  const times = out.map((b) => b.time);
  const sorted = times.slice().sort();
  if (times.join("|") !== sorted.join("|")) throw new Error("out of order: " + times.join(", "));
  return times.length + " bars in order";
});

check("the broadcast handler merges rather than assigns", () => {
  /* The arithmetic above is only reached if the socket path actually
     calls it. The first version of this test checked mergeSeries in
     isolation and would have passed with the handler still doing
     `S.candles = incoming`. */
  const at = APP.indexOf("const joined = same ? mergeSeries(S.candles, incoming) : incoming;");
  if (at < 0) throw new Error("the candles broadcast no longer builds a merged series");
  const after = APP.slice(at, at + 2000);
  if (!/S\.candles = joined;/.test(after)) {
    throw new Error("the merged series is built and then not used");
  }
  if (/S\.candles = incoming;/.test(after)) {
    throw new Error("the handler still replaces the series wholesale");
  }
});

check("an empty or absent side is handled without losing the other", () => {
  const box = merging();
  const one = [bar("2026-01-01 00:00:00")];
  if (box.mergeSeries([], one).length !== 1) throw new Error("incoming lost when nothing is held");
  if (box.mergeSeries(one, []).length !== 1) throw new Error("held bars lost to an empty broadcast");
  if (box.mergeSeries(null, null).length !== 0) throw new Error("nulls should merge to nothing");
});

console.log("");
const bad = results.filter((r) => !r).length;
console.log(`chart-history-paging: ${bad ? bad + " of " + results.length + " checks FAILED" : results.length + " checks passed"}`);
process.exit(bad ? 1 : 0);
