/**
 * Nothing that moves money happens quietly.
 *
 *     node tests/signal-alerts.test.js
 *
 * Three separate reports, one subject - the trader is not told in time:
 *
 *   1. a setup the AI refused was never published, so the desk said
 *      nothing at all;
 *   2. a setup seen while the robot was disarmed wrote one line into a
 *      log nobody has open - no chime, no card, no Windows toast - and
 *      that is the mode where a human is supposed to act on it;
 *   3. the cards that did appear went to the inline-end corner, which
 *      is the LEFT of a Persian desk, while every other notification on
 *      the product arrives at the top centre.
 *
 * The engine half is guarded behaviourally in
 * engine/tests/test_a_signal_is_announced_at_once.py, and the placement
 * is measured through the real cascade in tests/toast-placement.test.js.
 * This file pins the desk wiring between them: that the bus event still
 * reaches announceSignal, that an unsent signal is announced like any
 * other but cannot be mistaken for an order on its way, and that the
 * de-duplication does not swallow the second of the two.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("apps/web/js/app.js");
const CSS = read("apps/web/css/app.css");
const PACKS = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass++;
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    failures.push(name);
    console.log("  x  " + name + "  \u2014 " + e.message);
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const slice = (from, to) => {
  const i = APP.indexOf(from);
  must(i >= 0, "cannot find " + from);
  const j = APP.indexOf(to, i);
  must(j > i, "cannot find " + to);
  return APP.slice(i, j);
};

/* ================= 1. the signal reaches the desk at all ============= */

check("the bus's signal event is announced, not merely stored", () => {
  const body = slice('if (msg.type === "signal") {', 'if (msg.type === "trade")');
  must(/announceSignal\(sig\)/.test(body), "the event is handled without announcing anything");
  must(/S\.snap\.last_signal = sig/.test(body), "the snapshot no longer keeps the last signal");
  return "announceSignal";
});

check("a trade is announced on the same bus, in the same breath", () => {
  must(/if \(msg\.type === "trade"\) \{\s*\n?\s*announceTrade\(/.test(APP),
    "a trade event does not reach announceTrade");
  return "announceTrade";
});

check("announcing a signal does everything announcing a trade does", () => {
  const fn = slice("function announceSignal(sig) {", "function documentHidden(");
  must(/playSound\(prefs\.entry/.test(fn), "no sound - a card nobody is looking at is not a notification");
  must(/pushSignalCard\(sig\)/.test(fn), "no on-screen card");
  must(/if \(prefs\.windows\) notifyHost\(sig\)/.test(fn), "it never reaches the Windows toast");
  return "sound + card + host";
});

/* ================= 2. seen but not sent ============================== */

check("'seen but not sent' is a different piece of news from 'sent'", () => {
  const fn = slice("function announceSignal(sig) {", "function documentHidden(");
  const key = /const key = \[([^\]]+)\]/.exec(fn);
  must(key, "the de-duplication key is gone");
  must(/sig\.armed/.test(key[1]),
    "armed is not part of the identity, so whichever arrived second is silently dropped");
  return key[1].trim();
});

check("the card says when the robot will not send it", () => {
  const fn = slice("function pushSignalCard(sig) {", "function openSignalChart(");
  must(/sig\.armed === false/.test(fn), "an unsent signal is drawn as though it were on its way");
  must(/signal\.not_sent/.test(fn), "there is no sentence for it");
  must(/sig\.why/.test(fn), "the reason the gate is shut is not shown");
  must(/=== false/.test(fn), "a truthiness test would hide the line whenever armed is absent");
  return "armed === false";
});

check("...and an older engine that sends no flag is not treated as blocked", () => {
  const fn = slice("function pushSignalCard(sig) {", "function openSignalChart(");
  /* `sig.armed === false` and nothing looser: a build whose engine
     predates the flag sends undefined, and undefined must read as an
     ordinary signal rather than as a refusal. */
  must(!/!sig\.armed/.test(fn), "undefined would be read as 'not sent'");
  return "undefined is not false";
});

check("the sentence exists in every language pack", () => {
  for (const code of ["en", "fa", "ar"]) {
    const v = PACKS[code].signal && PACKS[code].signal.not_sent;
    must(typeof v === "string" && v.trim().length > 5, code + " cannot say it");
    must(!/\b(left|right|EURUSD|XAUUSD|US30)\b/.test(v), code + " names a side or an instrument");
  }
  const keys = ["en", "fa", "ar"].map((c) => Object.keys(PACKS[c].signal).sort().join(","));
  must(keys[0] === keys[1] && keys[1] === keys[2], "the signal.* key sets have drifted apart");
  return "en / fa / ar";
});

check("it is toned as a caution, not as a failure and not in --faint", () => {
  must(/\.notify-card \.n-only\{[^}]*var\(--warning\)/.test(CSS),
    "the line has no colour of its own, or is not the caution token");
  must(!/\.notify-card \.n-only\{[^}]*var\(--faint\)/.test(CSS),
    "--faint measures about 3.5:1 and is never for text somebody must read");
  return "--warning";
});

/* ================= 3. the stack itself ============================== */

check("anything that adds a card un-hides the stack", () => {
  for (const fn of ["function pushSignalCard(sig) {", "function pushTradeCard(t) {"]) {
    const body = APP.slice(APP.indexOf(fn), APP.indexOf(fn) + 1400);
    must(/stack\.hidden = false/.test(body), fn + " leaves the stack hidden");
  }
  return "both";
});

check("and the stack is hidden again exactly when it empties", () => {
  const body = slice("function pushTradeCard(t) {", "function notifyHostTrade(t)");
  must(/if \(stack\.children\.length === 0\) stack\.hidden = true/.test(body),
    "an empty stack keeps a fixed, invisible box over the page");
  return "children.length === 0";
});

check("the stack is not pinned to an inline edge in the stylesheet", () => {
  const i = CSS.indexOf(".notify-stack{");
  must(i > 0, ".notify-stack has no rule at all");
  const block = CSS.slice(i, CSS.indexOf("}", i));
  must(!/inset-inline-end/.test(block),
    "inset-inline-end is the LEFT of a Persian desk - this is the reported fault");
  must(/inset-inline:0/.test(block) && /justify-items:center/.test(block),
    "it does not span the window and centre its cards");
  must(/pointer-events:none/.test(block),
    "a full-width fixed strip that takes clicks swallows the whole header");
  return "centred";
});

check("the reason it was moved is written where it could be moved back", () => {
  must(/the LEFT-hand corner in Persian/.test(CSS),
    "nothing records why the corner placement was wrong");
  return "noted in app.css";
});

/* --------------------------------------------------------------------- */

if (failures.length) {
  console.log("\nsignal-alerts: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nsignal-alerts: " + pass + " checks passed");
