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
const PACKS = Object.fromEntries(
  ["en", "fa", "ar"].map((c) => [c, JSON.parse(read("lang/" + c + ".json"))])
);

const results = [];
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? "ok   " : "  x  ") + name + (note ? "  \u2014 " + note : ""));
};

const HOUR = 3600 * 1000;
const NOW = Date.parse("2031-03-04T12:00:00Z");

/* ------------------------------------------------------------------ */
console.log("=== the check is frequent, fixed, and not a setting ===");

/* The interval setting is gone, and so is autoCheckWindowMs. The owner
   asked for it to be removed, and the reason stands on its own: nobody
   knows when a release will be cut, so no number entered in that box
   could be right, and every number in it was a delay between a fix
   existing and this desk hearing about it -- out of a five-day support
   window that starts counting at PUBLICATION, not at discovery. A desk
   checking twice a day could spend a sixth of its grace period simply
   not knowing. The cadence is now half an hour, fixed. */

const FIRST = UPD.AUTO_CHECK_FIRST_MS;
const WINDOW = UPD.AUTO_CHECK_WINDOW_MS;

check(
  "the interval setting is gone from the scheduler",
  typeof UPD.autoCheckWindowMs === "undefined"
    && !/auto_check_interval_hours/.test(UPDSRC.replace(/\/\*[\s\S]*?\*\//g, "")),
  "a setting that is still read is still a setting"
);
check(
  "the cadence is frequent enough to be worth calling automatic",
  WINDOW > 0 && WINDOW <= 60 * 60 * 1000,
  `${WINDOW / 60000} minutes`
);
check(
  "and not so frequent it could spend the hourly API ceiling",
  // GitHub allows 60 requests an hour per IP and a check costs at most
  // three; anything at or above a minute apart is far inside it.
  (60 * 60 * 1000) / WINDOW * 3 < 60,
  `${Math.round((60 * 60 * 1000) / WINDOW * 3)} requests an hour at worst, against 60`
);
check(
  "a desk that has never checked goes soon after boot",
  UPD.nextCheckDelayMs(NaN, NOW) === FIRST,
  "a release published while this machine was switched off is found on the way up"
);
check(
  "but never in the first seconds of one",
  FIRST >= 10 * 1000,
  "the engine is still coming up and the trader is waiting for it, not for this"
);
check(
  "a desk switched off for a week checks promptly, not a window later",
  UPD.nextCheckDelayMs(NOW - 7 * 24 * HOUR, NOW) === FIRST,
  "overdue is overdue"
);
check(
  "the window is measured from the last check, not from startup",
  UPD.nextCheckDelayMs(NOW - 20 * 60 * 1000, NOW) < UPD.nextCheckDelayMs(NOW, NOW),
  "twenty minutes into the window leaves less of it, however many times the desk was restarted"
);
check(
  "a check that just happened waits the whole window",
  UPD.nextCheckDelayMs(NOW, NOW) === WINDOW,
  "and no restart can shorten it, which is what stops a restart loop hammering the API"
);
check(
  "no window can pass without a check",
  UPD.nextCheckDelayMs(NOW, NOW) <= WINDOW,
  "which is the only promise the cadence makes"
);
check(
  "the delay is pure arithmetic, with no randomness left in it",
  (() => {
    const a = UPD.nextCheckDelayMs(NOW - 5 * 60 * 1000, NOW);
    for (let i = 0; i < 50; i++) {
      if (UPD.nextCheckDelayMs(NOW - 5 * 60 * 1000, NOW) !== a) return false;
    }
    return true;
  })(),
  "the jitter existed to spread a six-hour window; half an hour does not need it"
);
check(
  "the panel no longer asks for an interval it cannot use",
  !/upd-interval/.test(APP) && !/auto_check_interval_hours/.test(APP),
  "a field that is saved and ignored is worse than no field"
);
check(
  "and says what the cadence is instead of asking for one",
  /upd\.auto_how/.test(APP),
  "removing the box without replacing it leaves the reader guessing"
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
console.log("\n=== the notice, once per launch ===");

/* Asked for: when an update is published and the desk notices it, put
   a modal in front of the trader encouraging the update, warn that
   this build stops being supported five days later, say WHEN, and
   show it once every time the app comes up. */

check(
  "there is a notice, and it is a modal rather than another bar",
  /async function maybeShowUpdateNotice\(\)/.test(APP)
    && /role="alertdialog" aria-modal="true"/.test(APP.slice(APP.indexOf("maybeShowUpdateNotice"))),
  "the warning bar already existed and is dismissable past; a deadline that locks the desk is not"
);
check(
  "it is shown once per launch, not once per render",
  (() => {
    if (!/sessionStorage\.getItem\("aurion\.updNag"\)/.test(APP)) return false;
    if (!/sessionStorage\.setItem\("aurion\.updNag", "1"\)/.test(APP)) return false;
    // And the guard is actually consulted on the way in. A store that
    // is written and never read shows the dialog on every poll.
    const fn = APP.slice(APP.indexOf("async function maybeShowUpdateNotice"),
                         APP.indexOf("function paintSupportBar"));
    return /if \(updateNagShown\(\)\) return false;/.test(fn);
  })(),
  "sessionStorage dies with the window, so closing and reopening the app is a new launch"
);
check(
  "and the flag is set before the dialog is built, not after it is answered",
  (() => {
    const fn = APP.slice(APP.indexOf("async function maybeShowUpdateNotice"));
    const body = fn.slice(0, fn.indexOf("\nfunction paintSupportBar"));
    const mark = body.indexOf("markUpdateNagShown()");
    const paint = body.indexOf("host.innerHTML");
    // Both must be there. A missing call makes indexOf -1, which would
    // otherwise satisfy "before" and let the guard be deleted.
    return mark > 0 && paint > 0 && mark < paint;
  })(),
  "setting it on dismissal means two polls landing together show it twice"
);
check(
  "a desk with no update to install is not interrupted",
  /!st\.data\.update_available \|\| !st\.data\.latest\) return false/.test(APP),
  "a modal on every launch regardless is how a notice becomes wallpaper"
);
check(
  "nor is one that is already being told something louder",
  /document\.getElementById\("sup-lock"\)\) return false/.test(APP),
  "two modals about the same deadline is one too many"
);
check(
  "nor somebody who could not install it anyway",
  /S\.user\.is_owner \|\| S\.user\.role === "owner"/.test(
    APP.slice(APP.indexOf("async function maybeShowUpdateNotice"), APP.indexOf("function paintSupportBar"))),
  "a call to action that answers 403 is worse than silence"
);
check(
  "it states the deadline, not merely the rule",
  /function updateNagDeadlineHtml\(st\)/.test(APP)
    && /supportMoment\(st\.deadline\)/.test(APP)
    && /supportLeftText\(st\)/.test(APP),
  "the one thing asked for was WHEN this desk stops working"
);
check(
  "and falls back to the rule rather than inventing a date",
  /sup\.policy", \{ n: fmtNum\(supportGraceDays\(\), 0\) \}/.test(
    APP.slice(APP.indexOf("function updateNagDeadlineHtml"), APP.indexOf("async function maybeShowUpdateNotice"))),
  "an offer with no publication date cannot be timed, and a guessed deadline is worse than none"
);
check(
  "the warning says what happens when the clock runs out",
  /upd\.nag_warn/.test(APP) && PACKS.en.upd.nag_warn.length > 40
    && /\{n\}/.test(PACKS.en.upd.nag_warn),
  "the grace period is interpolated from the server's own number, not written into the sentence"
);
check(
  "it shows both builds, so the reader can see they differ",
  (() => {
    const fn = APP.slice(APP.indexOf("async function maybeShowUpdateNotice"), APP.indexOf("function paintSupportBar"));
    return /buildTag\(S\.buildDate, S\.buildSeq\)/.test(fn) && /updateStamp\(latest\)/.test(fn);
  })(),
  "most updates come from main without moving the version, so the version alone shows nothing"
);
check(
  "its action installs rather than sending the reader to go and find the button",
  /runUpdateInstall\(latest\)/.test(APP),
  "a call to action that ends on a settings page is a chore"
);
check(
  "it can be dismissed, by button, by Escape and by the backdrop",
  (() => {
    const fn = APP.slice(APP.indexOf("async function maybeShowUpdateNotice"), APP.indexOf("function paintSupportBar"));
    return /upd-nag-later/.test(fn) && /e\.key !== "Escape"/.test(fn) && /e\.target === host/.test(fn);
  })(),
  "a dialog with no way out is a lock screen, and this is advice"
);
check(
  "it is raised when the desk opens, and again if an update appears mid-session",
  (() => {
    const n = APP.split("maybeShowUpdateNotice()").length - 1;
    return n >= 2 && /live\.update_available\) \{[\s\S]{0,160}maybeShowUpdateNotice\(\)/.test(APP);
  })(),
  "the server checks every half hour, so the news can arrive while the desk is already open"
);
check(
  "and never at the cost of the desk starting",
  /try \{ maybeShowUpdateNotice\(\); \} catch \(e\) \{/.test(APP),
  "a notice that can throw during boot is a desk that does not open"
);
check(
  "the notice is translated in all three languages",
  ["en", "fa", "ar"].every((c) => ["nag_title", "nag_body", "nag_warn", "nag_later",
    "nag_now", "nag_installed", "nag_offered", "auto_how", "build_no"]
    .every((k) => typeof PACKS[c].upd[k] === "string" && PACKS[c].upd[k].length > 1)),
  "9 keys x 3 languages"
);
check(
  "and the interval string went with the field",
  ["en", "fa", "ar"].every((c) => PACKS[c].upd.interval === undefined),
  "a key for a control that no longer exists"
);
check(
  "it is styled, and its facts read the same way the lock screen's do",
  /\.upd-nag-card\{/.test(CSS) && /\.upd-nag-facts\{/.test(CSS) && /\.upd-nag-dl\{/.test(CSS),
  "the two screens that discuss this deadline should present it alike"
);

/* ------------------------------------------------------------------ */
console.log("\n=== the build number, beside the version ===");

check(
  "the panel has a row for it",
  /id="upd-current-build"/.test(APP) && /upd\.build_no/.test(APP),
  'two machines both reading "v1.0.0" can be weeks apart'
);
check(
  "filled with this machine's build, not the offered one",
  /curBuild\.textContent = S\.buildDate \? buildTag\(S\.buildDate, S\.buildSeq\)/.test(APP),
  "the row is labelled installed; the update's stamp would answer the opposite question"
);
check(
  "and it is painted by the same function that paints the version",
  (() => {
    const i = APP.indexOf("function paintUpdateFacts(o)");
    return APP.slice(i, i + 1400).includes("upd-current-build");
  })(),
  "a second call site is how the first one came to read a dash"
);
check(
  "the stamp does not wrap mid-identifier",
  /\.upd-facts \.mono\{white-space:nowrap\}/.test(CSS),
  "it is read back to support as one token"
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
