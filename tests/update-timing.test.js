/**
 * When the update check happens, and when the desk is told what that
 * costs it.
 *
 * Three faults, reported together, all of them about time.
 *
 *   1. "Check every 6 hours" checked AFTER six hours. The scheduler was
 *      a setInterval armed when the process started, so the check
 *      landed on the far edge of the window - a release published a
 *      minute after one tick sat unseen for the whole of the next
 *      period - and because the interval counted UPTIME rather than
 *      time, a desk that is closed in the evening and opened in the
 *      morning never reached a tick at all. The only thing covering
 *      that was an unconditional check thirty seconds after every
 *      boot, which ignored the setting in the other direction: six
 *      launches in a day meant six checks whatever the interval said.
 *
 *   2. After an update installed, nothing anywhere said that this
 *      build stops working five days after the next version is
 *      published. The rule existed in the settings panel and on the
 *      screen that locks the desk - which is the worst possible place
 *      to read a deadline for the first time.
 *
 *   3. The countdown was whatever the last poll had said. Between
 *      polls, and for as long as a poll kept failing, "2 days left"
 *      was a number that had been true some time ago, it never counted
 *      in minutes inside the last hour, and the desk did not lock when
 *      the clock ran out - it locked when a later request happened to
 *      be refused.
 *
 * The guards below are about placement and arithmetic, not appearance.
 *
 *     node tests/update-timing.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const UPD = require("../backend/src/updater.js");
const UPDSRC = read("backend/src/updater.js");
const APP = read("apps/web/js/app.js");
const CSS = read("apps/web/css/app.css");

const results = [];
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? "ok   " : "  x  ") + name + (note ? "  \u2014 " + note : ""));
};

const HOUR = 3600 * 1000;
const WINDOW = 6 * HOUR;
const NOW = Date.parse("2031-03-04T12:00:00Z");

/* ------------------------------------------------------------------ */
console.log("=== the check happens inside the window, not at the end of it ===");

{
  /* The fraction is injected so this can be read as arithmetic rather
     than as a coin toss: 0 is the earliest placement the rule allows
     and 1 the latest. Both must be strictly inside the window. */
  const earliest = UPD.nextCheckDelayMs(WINDOW, NOW, NOW, 0);
  const latest = UPD.nextCheckDelayMs(WINDOW, NOW, NOW, 1);
  check(
    "the earliest placement is inside the window",
    earliest > 0 && earliest < WINDOW,
    `${(earliest / HOUR).toFixed(2)}h of 6h`
  );
  check(
    "and so is the latest",
    latest > earliest && latest < WINDOW,
    `${(latest / HOUR).toFixed(2)}h of 6h - never the full six`
  );
  check(
    "no window can pass without a check",
    latest <= WINDOW * 0.9,
    "which is the only promise the setting makes"
  );
  check(
    "and a check is never immediate either",
    earliest >= WINDOW * 0.5,
    "a restart must not mean a check; the interval is still a budget"
  );
}

{
  /* Ten placements drawn for real. The point is not the distribution,
     it is that nothing escapes the window. */
  let worstLow = Infinity;
  let worstHigh = 0;
  for (let i = 0; i < 200; i++) {
    const d = UPD.nextCheckDelayMs(WINDOW, NOW, NOW);
    worstLow = Math.min(worstLow, d);
    worstHigh = Math.max(worstHigh, d);
  }
  check(
    "two hundred unseeded draws all land inside the window",
    worstLow > 0 && worstHigh < WINDOW,
    `${(worstLow / HOUR).toFixed(2)}h..${(worstHigh / HOUR).toFixed(2)}h`
  );
}

check(
  "the window is measured from the last check, not from startup",
  UPD.nextCheckDelayMs(WINDOW, NOW - 3 * HOUR, NOW, 1) < UPD.nextCheckDelayMs(WINDOW, NOW, NOW, 1),
  "three hours into the window leaves less of it, however many times the desk was restarted"
);
check(
  "a desk that was switched off for a week checks promptly, not a window later",
  UPD.nextCheckDelayMs(WINDOW, NOW - 7 * 24 * HOUR, NOW, 1) === 30 * 1000,
  "overdue is overdue"
);
check(
  "but never in the first seconds of a boot",
  UPD.nextCheckDelayMs(WINDOW, NOW - 7 * 24 * HOUR, NOW, 0) >= 30 * 1000,
  "the engine is still coming up and the trader is waiting for it, not for this"
);
check(
  "an installation that has never checked gets its first check inside the first window",
  (() => {
    const d = UPD.nextCheckDelayMs(WINDOW, NaN, NOW, 0.5);
    return d > 0 && d < WINDOW;
  })(),
  "a missing last_check is a window that starts now, not a reason to check instantly"
);
check(
  "the interval is clamped the same way the route clamps it",
  UPD.autoCheckWindowMs({ auto_check_interval_hours: 0 }) === 6 * HOUR
    && UPD.autoCheckWindowMs({ auto_check_interval_hours: 9999 }) === 168 * HOUR
    && UPD.autoCheckWindowMs({ auto_check_interval_hours: 12 }) === 12 * HOUR,
  "one clamp disagreeing with the other is a setting that silently does something else"
);

check(
  "the scheduler re-arms itself after each check",
  /autoCheckTimer = setTimeout\(/.test(UPDSRC)
    && /await checkForUpdates\(\);[\s\S]{0,400}startAutoChecker\(\);/.test(UPDSRC),
  "a one-shot that does not re-arm checks once and never again"
);
check(
  "and re-reads the settings when it does",
  /Re-read the settings rather than closing over them/.test(UPDSRC),
  "an interval changed while a check was pending must take effect on the next window"
);
check(
  "the old unconditional check-on-every-boot is gone",
  !/also check shortly after start/.test(UPDSRC)
    && !/setTimeout\(async \(\) => \{ try \{ await checkForUpdates\(\); \} catch \{\} \}, 30000\)/.test(UPDSRC),
  "it ignored the interval entirely: six launches meant six checks"
);
check(
  "stopping the checker clears a timeout, not an interval",
  /function stopAutoChecker\(\)[\s\S]{0,160}clearTimeout\(autoCheckTimer\)/.test(UPDSRC),
  "clearInterval on a setTimeout handle leaves the check armed"
);
check(
  "a pending check never holds the process open",
  /autoCheckTimer\.unref === "function"\) autoCheckTimer\.unref\(\)/.test(UPDSRC)
);

/* ------------------------------------------------------------------ */
console.log("\n=== the countdown runs on this machine's clock ===");

check(
  "there is a function that recomputes the status against the deadline",
  /function supportLive\(/.test(APP)
    && /const ms = dl - Date\.now\(\);/.test(APP),
  "days_left arrives in a poll and is stale the moment it does"
);
check(
  "it is used on every status the desk receives",
  /function applySupportState\([\s\S]{0,700}const live = supportLive\(st\) \|\| st;/.test(APP),
  "trusting the number in the answer means trusting how old the answer is"
);
check(
  "a ticker keeps it counting between polls",
  /function startSupportTicker\(/.test(APP) && /\}, 60000\);/.test(APP),
  "once a minute, which is the resolution the last hour needs"
);
check(
  "and the desk locks when the clock reaches zero, without waiting for a request",
  /if \(live\.expired\) \{\s*stopSupportTicker\(\);[\s\S]{0,120}showSupportLock\(live\);/.test(APP),
  "the reported behaviour was a countdown at zero on a desk that kept trading"
);
check(
  "the ticker stops once it has nothing to count",
  /function stopSupportTicker\(\) \{\s*if \(S\._supTick\) \{ clearInterval\(S\._supTick\); S\._supTick = null; \}/.test(APP),
  "an interval left running after the lock is a leak with a visible symptom"
);
check(
  "the last hour is counted in minutes",
  /function supportLeftText\([\s\S]{0,500}sup\.warn_minutes/.test(APP)
    && /ms <= 60 \* 60 \* 1000/.test(APP),
  '"0 hours left" sat on screen for a full hour and then the desk locked'
);
check(
  "the deadline is shown as a moment, not only as a day",
  /function supportMoment\(/.test(APP)
    && /hour: "2-digit", minute: "2-digit"/.test(APP)
    && /sup\.warn_body", \{ date: supportMoment\(st\.deadline\) \}/.test(APP),
  '"Tuesday" is not a deadline; 14:05 is'
);

/* ------------------------------------------------------------------ */
console.log("\n=== the deadline is said where it will be read ===");

check(
  "the update panel's policy line becomes the deadline once there is one",
  /function paintSupportPolicyLine\(/.test(APP)
    && /el\.classList\.add\("is-counting"\)/.test(APP)
    && /sup\.until", \{ date: supportMoment\(st\.deadline\) \}/.test(APP),
  "the panel stated the rule and never the date, which is the one thing it was asked for"
);
check(
  "the panel asks for the status itself rather than waiting for a poll",
  /API\.get\('\/api\/system\/support'\)/.test(APP),
  "opened in the first seconds of a session it would otherwise show the rule where the date belongs"
);
check(
  "and the ticker keeps that line current too",
  /paintSupportBar\(live\);\s*paintSupportPolicyLine\(\);\s*\}, 60000\);/.test(APP)
);
check(
  "the screen shown after an update installs states the clock",
  /function supportWelcomeHtml\(/.test(APP)
    && /\$\{supportWelcomeHtml\(\)\}/.test(APP),
  "the reported fault: an update installs and nothing mentions the five days"
);
check(
  "with the real countdown when one is already running",
  /supportWelcomeHtml\(\) \{[\s\S]{0,700}st\.update_available && st\.deadline && !st\.expired[\s\S]{0,300}supportLeftText\(st\)/.test(APP),
  "a machine can install one build while a newer one is already published"
);
check(
  "and the rule, with no invented date, when none is",
  /supportWelcomeHtml\(\) \{[\s\S]{0,1200}sup\.after_update", \{ n: fmtNum\(supportGraceDays\(\), 0\) \}/.test(APP),
  "right after an update there is usually nothing newer, and a deadline would have to be made up"
);
check(
  "the status is fetched before that screen is built",
  /async function showUpdateWelcome\([\s\S]{0,600}API\.get\("\/api\/system\/support"\)[\s\S]{0,300}return new Promise/.test(APP),
  "it appears during boot, before the first snapshot poll"
);
check(
  "the grace days come from the server, not from a second copy of the policy",
  /sup\.after_update", \{ n: fmtNum\(supportGraceDays\(\), 0\) \}/.test(APP)
    && /function supportGraceDays\(\)[\s\S]{0,260}S\.support && S\.support\.grace_days/.test(APP),
  "two copies of five is one bug away from the screen and the server disagreeing"
);

/* ------------------------------------------------------------------ */
console.log("\n=== it looks like a deadline ===");

check(
  "the counting policy line is styled apart from the resting one",
  /\.upd-policy\.is-counting\{/.test(CSS) && /\.upd-policy\.is-counting b\{/.test(CSS)
);
check(
  "the figures in it do not jiggle as they count",
  /\.upd-policy\.is-counting b\{[^}]*tabular-nums/.test(CSS),
  "proportional digits reflow the sentence every minute"
);
check(
  "the line on the post-update screen has a box of its own",
  /\.upd-w-sup\{/.test(CSS) && /\.upd-w-sup\.is-counting\{/.test(CSS),
  "what happens next is a different kind of fact from what just happened"
);
check(
  "and it starts where the reader does",
  /\.upd-w-sup\{[^}]*text-align:start/.test(CSS),
  "a physical left would be wrong in Persian and Arabic"
);

const failed = results.filter((r) => !r.ok);
console.log(`\nupdate-timing: ${results.length - failed.length} of ${results.length}`);
if (failed.length) process.exit(1);
