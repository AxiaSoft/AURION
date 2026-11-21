/**
 * Six reported faults, one file.
 *
 * Reported, in the trader's words:
 *
 *   1. "I set a date and I can see it backtesting some other date."
 *   2. "I still cannot see six months of chart."
 *   3. "The candles in the customisation page are broken - rewrite and
 *      redesign them."
 *   4. "When every strategy is off the robot should enter on its own."
 *   5. "Put the 'market closed' tag next to the calendar event."
 *   6. "In the command centre, I want these tags filled in."
 *
 * Each of those is a specific line of code, and each check below names
 * the line rather than the symptom - a test that only asserts "a
 * backtest happened" would have passed throughout the bug.
 *
 *     node tests/period-candles-and-solo.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const TRADER = read("engine", "aurion", "runtime", "trader.py");
const ENGINE = read("engine", "aurion", "backtest", "engine.py");
const BRIDGE = read("engine", "aurion", "mt5", "bridge.py");
const ROBOT = read("engine", "aurion", "strategy", "robot.py");
const APP = read("apps", "web", "js", "app.js");
const CAL = read("apps", "web", "js", "calendar.js");
const CSS = read("apps", "web", "css", "app.css");
const PACKS = {
  en: JSON.parse(read("lang", "en.json")),
  fa: JSON.parse(read("lang", "fa.json")),
  ar: JSON.parse(read("lang", "ar.json")),
};

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (typeof note === "string" ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* Lift one Python function's source out by indentation, so the checks
   below run against the body that matters and not against a similar
   line somewhere else in a six-thousand-line file. */
function pyFn(src, name) {
  const at = src.indexOf("def " + name + "(");
  if (at < 0) throw new Error(name + " is missing");
  let lineStart = src.lastIndexOf("\n", at) + 1;
  /* "async def" puts six characters between the start of the line and
     the def, which would make the body look less indented than its own
     header and end the lift immediately. */
  const indent = src.slice(lineStart, at).replace(/async $/, "").length;
  const lines = src.slice(lineStart).split("\n");
  const out = [lines[0]];
  /* A signature split over several lines closes with ") -> X:" at the
     def's own indentation, which is not the end of the function. The
     header is consumed first, then the body is taken by indent. */
  let header = !/:\s*$/.test(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    if (header) {
      if (/:\s*$/.test(line)) header = false;
      continue;
    }
    const next = lines[i + 1];
    if (next && next.trim() && next.search(/\S/) <= indent) break;
  }
  return out.join("\n");
}

function jsFn(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) at = src.indexOf("  " + name + "(");
  if (at < 0) throw new Error(name + " is missing");
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (!depth) return src.slice(at, i + 1);
    }
  }
  throw new Error(name + " is not closed");
}

/* ---------------------------------------------- 1. the period asked for */

check("the run-up bars are handed to the replay as run-up", () => {
  const fn = pyFn(TRADER, "_run_backtest");
  if (!/prepended: int = 0/.test(fn)) throw new Error("_run_backtest cannot be told about the run-up");
  if (/self\.backtester\.run[\s\S]{0,400}?,\s*80,/.test(TRADER)) {
    throw new Error("the replay is still started with a hard-coded 80");
  }
  if (!/BACKTEST_MIN_WARMUP/.test(fn)) throw new Error("the floor is not applied");
  return "prepended, floored, clamped";
});

check("the caller passes the warmup _slice_bars worked out", () => {
  const at = TRADER.indexOf("self._run_backtest(");
  if (at < 0) throw new Error("nothing launches a backtest");
  const call = TRADER.slice(at, TRADER.indexOf(")", TRADER.indexOf("name=", at)));
  if (!/window\.get\("warmup"\)/.test(call)) {
    throw new Error("the computed warmup is still dropped on the floor");
  }
  return "window['warmup'] reaches the replay";
});

check("the result names the first bar TRADED, not the first bar handed over", () => {
  if (!/_bar_time\(bars\[min\(int\(warmup\)/.test(ENGINE)) {
    throw new Error("first_bar is still bars[0], which is inside the run-up");
  }
  if (!/"warmup_from"/.test(ENGINE)) throw new Error("the run-up is not disclosed separately");
  return "first_bar + warmup_from";
});

/* -------------------------------------------------- 2. six months back */

check("one drag at the edge asks for the whole promised window", () => {
  const fn = jsFn(APP, "loadMoreHistory");
  if (/have \* 2/.test(fn)) throw new Error("it still doubles, so 180 days needs five drags");
  if (!/barsForDays\(f\.timeframe, HISTORY_DAYS\)/.test(fn)) {
    throw new Error("it does not ask for HISTORY_DAYS");
  }
  return "HISTORY_DAYS in one ask";
});

check("an expert that found nothing still releases the waiters", () => {
  const fn = pyFn(BRIDGE, "_resolve_hist");
  if (!/final: bool = False/.test(fn)) throw new Error("_resolve_hist cannot be told it is the last word");
  if (!/if not rows and not final/.test(fn)) {
    throw new Error("an empty final reply is still dropped, so the desk waits out the timeout");
  }
  if (!/_resolve_hist\(symbol, tf, final=True\)/.test(BRIDGE)) {
    throw new Error("the EA's final candle message does not say it is final");
  }
  return "the shortfall answer travels";
});

/* ------------------------------------------- 3. the candle preview */

check("the preview is bars again, and they are chunky", () => {
  /* Written for the canvas version and rewritten with it. The trader
     looked at the canvas and said, in these words, that the preview
     candles were wrong and to put back the fat ones - so the canvas is
     gone, the <i> bars are back, and what is checked is the thing that
     was asked for: a bar fills its own track. */
  if (/id="cndl-canvas"/.test(APP)) throw new Error("the canvas is still being rendered");
  if (!/class="cndl is-/.test(APP)) throw new Error("the bars are not emitted");
  if (!/--candle-up/.test(APP)) throw new Error("it does not read the chart's own colours");
  const block = CSS.slice(CSS.indexOf(".cndl-prev{"), CSS.indexOf(".cndl-cap"));
  if (!/display:flex/.test(block)) throw new Error("the strip is not a flex row of tracks");
  if (!/\.cndl\{[^}]*flex:1 1 0/.test(block)) throw new Error("the bars do not share the strip");
  /* "Fat ones" was the ask then; "exactly how the EA chart shows them"
     is the ask now, and the chart's body is 66% of its slot with the
     other 34% as the gap. Both are satisfied by the same rule - what
     is excluded is the sliver in the middle of an empty column. */
  const side = Number((/\.cndl::after\{[^}]*inset-inline:([\d.]+)%/.exec(block) || [])[1]);
  if (!(side >= 0 && side <= 20))
    throw new Error("the body is a sliver rather than most of its track");
  return "equal tracks, " + (100 - 2 * side) + "% bodies, same colours as the chart";
});

check("a doji is kept flat rather than inflated into a block", () => {
  const fn = jsFn(APP, "candlePreviewShapes");
  if (!/bodyH < 2/.test(fn)) throw new Error("a zero-height body has no case of its own");
  /* And the floor is taken out of the TOP of the body, or a bar that
     closed on the low of the window is drawn through the floor of the
     strip - which is what "the preview is corrupted" was. */
  if (!/bodyTop = Math\.min\(bodyTop, 100 - bodyH\)/.test(fn)) {
    throw new Error("the minimum height can push a body out of the strip");
  }
  return "flat bars stay flat, inside the box";
});

check("the colours are live during a drag, with nothing to repaint", () => {
  /* The canvas had to be told to redraw on every frame of a colour
     drag; CSS bars do not. They are painted from --candle-up and
     --candle-down, and previewColour writes those onto <html> as the
     slider moves - so the strip follows the drag by itself, and the
     four repaint calls the canvas needed are gone. */
  if (!/\.cndl\.is-up\{color:var\(--candle-up\)\}/.test(CSS)) {
    throw new Error("a rising bar does not read the variable the picker writes");
  }
  if (!/\.cndl\.is-down\{color:var\(--candle-down\)\}/.test(CSS)) {
    throw new Error("a falling bar does not read the variable the picker writes");
  }
  const calls = (APP.match(/paintCandlePreview\(\)/g) || []).length;
  if (calls > 3) throw new Error(calls + " repaint calls - the canvas-era plumbing is back");
  return "the variables are the repaint";
});

check("the stylesheet positions the candles, since nothing else does", () => {
  if (/\.cndl-prev canvas\{/.test(CSS)) throw new Error("a canvas rule is still in the sheet");
  if (!/\.cndl::before\{/.test(CSS)) throw new Error("the wick has no rule");
  if (!/\.cndl::after\{/.test(CSS)) throw new Error("the body has no rule");
  return "wick and body, placed from their own properties";
});

/* ------------------------------------------- 4. trading with no strategy */

check("an empty book means the robot decides, not that nothing happens", () => {
  const fn = pyFn(TRADER, "_run_enabled_strategies");
  if (!/_solo_robot_slot\(\)/.test(fn)) throw new Error("the empty book still just returns");
  if (!/SOLO_ROBOT_NAME/.test(TRADER)) throw new Error("the solo robot has no name");
  const slot = pyFn(TRADER, "_solo_robot_slot");
  if (!/"kind": "robot"/.test(slot)) throw new Error("it does not build the robot the backtest runs");
  if (!/min_confidence/.test(slot)) throw new Error("it does not use the live confidence floor");
  return "the same robot the replay measures";
});

check("the robot standing in for a strategy is a setting, and it persists", () => {
  if (!/self\.solo_robot = True/.test(TRADER)) throw new Error("no default");
  if (!/runtime\.get\("solo_robot", True\)/.test(TRADER)) throw new Error("it is not loaded back");
  if (!/"solo_robot": bool\(getattr\(self, "solo_robot", True\)\)/.test(TRADER)) {
    throw new Error("it is not persisted");
  }
  if (!/if "solo_robot" in body/.test(TRADER)) throw new Error("it cannot be switched off");
  return "default on, saved, switchable";
});

check("the gate stops calling an empty book a closed gate", () => {
  const fn = pyFn(TRADER, "trade_gate");
  if (!/if not enabled and not solo/.test(fn)) {
    throw new Error("no_strategy is still raised when the robot is allowed to trade alone");
  }
  if (!/"solo_robot": solo/.test(fn)) throw new Error("the desk is not told who is deciding");
  return "who == robot with an empty book";
});

check("the desk names the robot instead of printing an internal id", () => {
  if (!/g\.solo_robot \? I18N\.t\("gate\.solo_robot"\)/.test(APP)) {
    throw new Error("the strategies chip would read 'robot'");
  }
  for (const [lang, pack] of Object.entries(PACKS)) {
    const text = (pack.gate || {}).solo_robot;
    if (typeof text !== "string" || !text) throw new Error(lang + " has no gate.solo_robot");
    if (lang !== "en" && text === PACKS.en.gate.solo_robot) throw new Error(lang + " is an English copy");
  }
  return "translated in all three packs";
});

check("the robot's own docstring no longer claims it is replay-only", () => {
  if (/REPLAY ONLY/.test(ROBOT)) throw new Error("the file still says it cannot be reached live");
  if (!/_solo_robot_slot/.test(ROBOT)) throw new Error("the live way in is not documented");
  return "both doors named";
});

/* ------------------------------------------------ 5. the calendar tag */

check("the closed tag rides on the event, not on the panel", () => {
  const fn = jsFn(CAL, "_ev");
  if (!/_ev\(e, closed\)/.test(CAL)) throw new Error("_ev is never told the market is shut");
  if (!/calendar\.closed/.test(fn)) throw new Error("the event carries no closed tag");
  if (!/cal-ev-shut/.test(fn)) throw new Error("the tag has no class of its own to style");
  if (!/this\._ev\(e, weekend\)/.test(CAL)) throw new Error("the day panel does not pass it");
  return "one tag per event";
});

check("the tag is sized for the row it now sits in", () => {
  if (!/\.cal-ev-shut\{/.test(CSS)) throw new Error("no style for the event-level tag");
  if (!/\.cal-ev\.is-shut\{/.test(CSS)) throw new Error("a shut row looks exactly like a tradeable one");
  return "sized down, row dimmed";
});

/* --------------------------------------------- 6. the command centre */

check("the status chips are filled, not washed", () => {
  const at = CSS.indexOf(".gate-card .pill.ok");
  if (at < 0) throw new Error("the gate chips have no rule of their own");
  const block = CSS.slice(at, at + 600);
  if (/16%|\/ \.16|rgb\(var\(--cyan-rgb\) \/ \.1/.test(block)) {
    throw new Error("the 16% wash the trader rejected twice is still there");
  }
  if (!/background:var\(--cyan\)/.test(block) || !/background:var\(--rose\)/.test(block)) {
    throw new Error("the chip is not the state colour itself");
  }
  if (!/color:var\(--on-accent\)/.test(block)) throw new Error("the ink is not set for a filled chip");
  return "solid cyan / rose with --on-accent ink";
});

check("a chip that names several strategies can wrap", () => {
  if (!/\.gate-card \.gate-pills \.pill\{white-space:normal\}/.test(CSS)) {
    throw new Error("the strategies chip will overflow its card");
  }
  return "white-space:normal";
});

const failed = results.filter((x) => !x).length;
console.log("\nperiod-candles-and-solo: " + (failed
  ? failed + " FAILED of " + results.length
  : results.length + " checks passed"));
if (failed) process.exitCode = 1;
