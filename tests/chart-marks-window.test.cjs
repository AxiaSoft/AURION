/**
 * The desk side of "do not analyse the whole chart".
 *
 * Reported: with the expert detached the engine never drops; attach it
 * to one or more charts and the engine flaps and sometimes takes the
 * desk with it. The cause was work with no end - the signal marks were
 * produced by replaying every armed strategy backwards through the
 * entire history, 1500 bars per refresh, per chart, for ever. The
 * instruction was to mark the last day only, and to load history back
 * six months and no further.
 *
 * The engine half is in engine/tests/test_chart_load_is_bounded.py.
 * This is the half the trader actually sees, and there are two things
 * that had to follow the change or the screen would lie:
 *
 *   1. The "still analysing" wash is drawn over the UNANALYSED
 *      stretch. The marked region is now one day out of six months, so
 *      if the engine still reported "not complete" the wash would
 *      cover almost the whole chart, permanently. `complete` therefore
 *      had to stop meaning "reached the first bar of the history".
 *   2. The finished sentence said "Analysed all {n} candles" with the
 *      whole series length in it. Beside a range covering one day of
 *      that series, it was a sentence contradicting itself.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const APP = read("apps/web/js/app.js");
const TRADER = read("engine/aurion/runtime/trader.py");
const EA = read("engine/ea/AurionBridge.mq5");
const HIST = read("engine/aurion/util/history.py");

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log("ok   " + what); }
  else { fail++; console.log("  x  " + what); }
}

// ── 1. the work is bounded, and bounded by a period ──────────────────

ok(/^MARK_DAYS = \d+$/m.test(TRADER),
  "the marked region is stated in days, not in a bar count");
ok(!/CHART_MARK_STEP_BACK/.test(TRADER),
  "nothing walks backwards through the history a slab at a time any more");
ok(!/CHART_MARK_FIRST_PASS/.test(TRADER),
  "...and the first-pass bar count that fed it is gone too");

/* A bar count means a different amount of TIME on every timeframe,
   which is the bug util/history.py exists to prevent. The floor has
   to be computed from the timeframe. */
ok(/timeframe_minutes/.test(TRADER.slice(TRADER.indexOf("def _mark_floor"),
  TRADER.indexOf("def _chart_mark_plan"))),
  "the window is converted per timeframe rather than reused as bars");

/* bars_for_days has a 400-bar floor meant for "enough bars for an
   indicator to have an opinion". Applied to a one-day window it turns
   one day of H4 into sixty-six days, which is the whole bug back. */
ok(!/bars_for_days\([^)]*MARK_DAYS/.test(TRADER),
  "the one-day window does not go through the 400-bar analysis floor");

// ── 2. "complete" means the window, not the whole series ─────────────

const mergeBlock = TRADER.slice(
  TRADER.indexOf("def _chart_marks_merge"),
  TRADER.indexOf("async def chart_signals"),
);
ok(/complete = covered_lo <= self\._mark_floor\(/.test(mergeBlock),
  "a chart is complete when its marked window is covered");
ok(!/complete = covered_lo <= WARMUP_BARS/.test(mergeBlock),
  "...not when it has reached the first bar of six months of history");

/* The wash is drawn only while !complete. If complete never arrived,
   the trader would stare at "still analysing" over five months of
   chart for the rest of the session. */
ok(/if \(!cov \|\| cov\.complete \|\| !this\.showSignals\) return;/
  .test(read("apps/web/js/charts.js")),
  "the unanalysed wash is only drawn while there is really work left");

// ── 3. the finished sentence tells the truth ─────────────────────────

const noteBlock = APP.slice(
  APP.indexOf("function signalCoverageNote"),
  APP.indexOf("function signalCoveragePct"),
);
const doneBlock = noteBlock.slice(noteBlock.indexOf("cov.complete"));
ok(/n: fmt\(done, 0\)/.test(doneBlock),
  "the finished line counts the candles analysed, not the whole series");
ok(!/n: fmt\(total, 0\)/.test(doneBlock),
  "...so it cannot claim 17 280 candles beside a one-day date range");

for (const [lang, file] of [["en", "lang/en.json"], ["fa", "lang/fa.json"], ["ar", "lang/ar.json"]]) {
  const pack = JSON.parse(read(file));
  const line = String(pack.charts && pack.charts.scan_done || "");
  ok(line.includes("{n}") && line.includes("{from}") && line.includes("{to}"),
    `the ${lang} finished line still names the count and both ends`);
  ok(!/\ball\b/i.test(line) && !/\bهر\b/.test(line) && !/\bكل\b/.test(line),
    `the ${lang} finished line no longer says "all" of them were analysed`);
}

// ── 4. six months is a limit, not a target to clear ──────────────────

ok(/return min\(bars_for_days\(timeframe\), max\(60, want\)\)/.test(HIST),
  "a chart request is capped at the promise, not at the memory guard");
ok(/#define AURION_HIST_MAX 259200/.test(EA),
  "the expert will not hand over more than six months of M1 either");
/* 300 000 was the old ceiling and is still MAX_BARS in the engine, as
   a memory guard. What must not come back is it being the CHART
   ceiling: on M15 that is eight and a half years. */
ok(!/min\(MAX_BARS, max\(60, want\)\)/.test(HIST),
  "...and the flat 300 000-bar ceiling is no longer what a chart gets");

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
