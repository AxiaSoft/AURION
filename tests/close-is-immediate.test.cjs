/* "I press close on a position and it takes far too long. It should
 *  close fast - don't even ask me a question to close a position."
 *
 * Three separate delays were stacked on one button.
 *
 * The first was ceremony: closing one position opened a confirmation
 * dialog. A trader pressing Close has already decided, and the dialog
 * put a modal, a render and a second deliberate press between the
 * decision and the order.
 *
 * The second was a dropped command. Commands reach the expert through a
 * file, and the engine wrote it with write_bytes - which REPLACES what
 * is there. Two commands issued inside one poll window left only the
 * second; the first was lost, and the engine then sat out its
 * twelve-second acknowledgement timeout waiting for a reply to a
 * command nobody still held. Closing several positions sends one
 * command per ticket, back to back, so this was the ordinary case.
 *
 * The third was the poll itself: the expert looked for work every
 * 400ms, so almost half a second was spent before the terminal had even
 * been asked.
 *
 *     node tests/close-is-immediate.test.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CSS = read("apps", "web", "css", "app.css");
const EA = read("engine", "ea", "AurionBridge.mq5");
const PY = read("engine", "aurion", "mt5", "bridge.py");

let fails = 0;
function ok(cond, what) {
  if (cond) console.log("ok   " + what);
  else { fails += 1; console.log("FAIL " + what); }
}

function liftFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") { depth -= 1; if (!depth) return src.slice(at, j + 1); }
  }
  return "";
}

/* ---- the desk asks nothing ---------------------------------------- */
{
  const bind = liftFn(APP, "bindCloseButtons");
  ok(Boolean(bind), "bindCloseButtons is gone");
  ok(!/askConfirm/.test(bind),
    "closing one position still stops to ask a question");
  ok(/API\.post\("\/api\/order", \{ action: "close"/.test(bind),
    "the close no longer goes straight to the order endpoint");

  /* Feedback instead of a question. Without it the button just goes
     dead and the trader presses it again. */
  ok(/exec\.closing/.test(bind), "the button says nothing while the order is in flight");
  ok(/is-busy/.test(bind), "there is no busy state on the button");
  ok(/\[data-close\]\.is-busy/.test(CSS), "the busy state is not styled");

  /* Closing EVERYTHING is a different decision and still asks: one
     mis-tap there is the whole account. */
  const flat = liftFn(APP, "flattenAll");
  ok(/askConfirm/.test(flat),
    "closing every position no longer asks, which a mis-tap should never be able to do");
}

/* ---- a queued command cannot be overwritten ------------------------ */
{
  const at = PY.indexOf("def _write_cmd_file");
  ok(at >= 0, "_write_cmd_file is gone");
  const body = PY.slice(at, PY.indexOf("\n    def ", at + 10));
  /* The CALL, not the word: the docstring records the old behaviour at
     length and names it while doing so. */
  ok(!/\)\.write_bytes\(|handle\.write_bytes\(/.test(body),
    "the command file is still overwritten, so a second command still drops the first");
  ok(/open\([^\n]*"ab"\)/.test(body), "the command file is not opened for append");
  ok(/\\n/.test(body), "commands are not separated, so the expert cannot tell them apart");
}

/* ---- and the expert drains every one of them ----------------------- */
{
  const at = EA.indexOf("bool PollCommands()\n  {");
  ok(at >= 0, "PollCommands is gone, or still returns nothing the timer can use");
  const body = EA.slice(at, EA.indexOf("\n  }\n", at));
  ok(/StringSplit\(/.test(body),
    "PollCommands still handles one command per pass and leaves the rest queued");
  ok(/for\(int i = 0; i < n; i\+\+\)/.test(body), "the queued commands are not walked");
  ok(/return true;/.test(body) && /return false;/.test(body),
    "PollCommands cannot tell the timer whether anything arrived");
}

/* ---- the expert looks far more often ------------------------------- */
{
  ok(!/EventSetMillisecondTimer\(400\)/.test(EA),
    "the idle poll is still 400ms - half a second before the terminal is even asked");
  const idle = /#define AURION_IDLE_TIMER_MS\s+(\d+)/.exec(EA);
  const fast = /#define AURION_FAST_TIMER_MS\s+(\d+)/.exec(EA);
  const win = /#define AURION_FAST_WINDOW_MS\s+(\d+)/.exec(EA);
  ok(Boolean(idle && fast && win), "the poll rates are not named constants");
  ok(idle && Number(idle[1]) <= 150, "the idle poll is still slow: " + (idle && idle[1]));
  ok(fast && idle && Number(fast[1]) < Number(idle[1]), "the fast lane is not faster than idle");
  ok(win && Number(win[1]) >= 1000, "the fast lane closes again too soon to catch a burst");

  /* A command arriving opens the fast lane - commands come in bursts,
     and the trader is watching. */
  ok(/if\(PollCommands\(\)\)/.test(EA), "a command landing no longer speeds the timer up");
  ok(/g_fast_until = now \+ AURION_FAST_WINDOW_MS/.test(EA), "the fast window is never opened");
  ok(/now < g_fast_until \? AURION_FAST_TIMER_MS : AURION_IDLE_TIMER_MS/.test(EA),
    "the timer does not choose between the two rates");
  ok(/g_fast_until = 0;/.test(EA), "the fast window is not reset on init");
}

console.log(fails ? "\nclose-is-immediate: " + fails + " check(s) failed" : "\nall good");
process.exit(fails ? 1 : 0);
