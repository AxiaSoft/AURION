/**
 * An update is anything on main. A VERSION is the builder's number.
 * Only the second one may ever lock a desk.
 *
 * ---------------------------------------------------------------------
 * THIS SUITE WAS REVERSED, AND THE REASON IS KEPT HERE ON PURPOSE.
 *
 * It used to pin the opposite rule: `update_available: published &&
 * files.length > 0`, with every difference from main suppressed on the
 * way out of getUpdateState(). That rule existed for a real fault, and
 * the fault was NOT "customers received a fix too easily" - it was this:
 *
 *     a desk was told "a new update is available - install it or this
 *     build stops working in five days", on a product for which no
 *     update had been released at all.
 *
 * One field carried two meanings. "There is something to install" and
 * "a new version has been published" were the same boolean, the support
 * window read it, and so every commit anyone pushed scheduled every
 * installation in the field to stop five days later.
 *
 * The first fix cut the offer. That removed the lockout and took the
 * delivery with it: main is the release branch - nothing lands on it
 * except through a pull request the owner merged - so a merged fix was
 * shipped work that the desk could see, name in the panel, and never
 * install. Reported by the owner, looking at "your copy differs in 1
 * file" with no way to take the file.
 *
 * The fix now is the split the first one should have been:
 *
 *     update_available  = main has a shipped file this machine lacks.
 *                         Offered, installable, announced. Not a clock.
 *     version_changed   = config/aurion.factory.json says a different
 *                         number than the installed copy. Only the
 *                         builder writes that file.
 *     the support clock = version_changed, or a tagged release.
 *                         Nothing else, ever.
 *
 * So the original fault stays fixed - an ordinary merge cannot start a
 * countdown, and that is checked below over 900 days - while the fix
 * actually reaches the customer it was written for.
 *
 * Checked behaviourally where possible: the state file, the policy and
 * the sanitiser are all run for real against a throwaway data directory.
 *
 *     npm run test:relgate
 * ---------------------------------------------------------------------
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* A data directory of its own, set before anything is required: both
   modules resolve their paths at load time. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-relgate-"));
process.env.AURION_DATA_DIR = TMP;

const SUP = require("../backend/src/support-window.js");
const updater = require("../backend/src/updater.js");
const GH = read("backend/src/github-update.js");
const UPDATER = read("backend/src/updater.js");
const APP = read("apps/web/js/app.js");
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

const DAY = 24 * 60 * 60 * 1000;
const writeState = (o) => fs.writeFileSync(path.join(TMP, "update-state.json"), JSON.stringify(o), { mode: 0o600 });

/* =============== 1. where an update may come from ==================== */

check("main, and nothing but main", () => {
  must(/const UPDATE_BRANCH = "main";/.test(GH), "the branch is not pinned to main");
  must(!/UPDATE_BRANCH\s*=\s*[^;]*cfg|branch:\s*String\(gh\.branch/.test(GH),
    "a branch name can be read from configuration again");
  const i = GH.indexOf('const UPDATE_BRANCH = "main";');
  must(/Pinned in code rather than defaulted in config/.test(GH.slice(i - 900, i)),
    "the reason it is not configurable is no longer written where it can be undone");
  return "UPDATE_BRANCH pinned";
});

check("a release cut off main is refused as a release", () => {
  must(/async function containedInMain\(src, ref\)/.test(GH), "nothing checks where a tag lives");
  must(/cmp\.ahead_by === 0/.test(GH), "the containment test is not ahead_by === 0");
  const i = GH.indexOf("async function containedInMain");
  must(/return false;/.test(GH.slice(i, i + 1200)), "a failed comparison is treated as containment");
  return "compare main...tag, ahead_by === 0";
});

/* =============== 2. what counts as an update ========================= */

check("an offer is a file difference, and that is the whole test", () => {
  must(/update_available: files\.length > 0/.test(GH),
    "update_available still demands something other than a difference");
  must(!/update_available: published && files\.length > 0/.test(GH),
    "the published && rule is still in the file - a merged fix cannot be installed");
  return "files.length > 0";
});

check("a release still says so, in a field of its own", () => {
  const i = GH.indexOf('channel: "release"');
  const block = GH.slice(i, GH.indexOf("\n      };", i));
  must(/published: true/.test(block), "a release does not mark itself published");
  return "published:true";
});

check("the head of main still says the opposite, for notes not for access", () => {
  const i = GH.indexOf('channel: "branch"');
  const block = GH.slice(i, GH.indexOf("\n  };", i));
  must(/published: false/.test(block), "a branch head is not marked unpublished");
  must(/not about whether\n       this may be installed/.test(block),
    "what the flag still means, and what it no longer means, is not recorded beside it");
  return "published:false, notes only";
});

check("the install path has no publication test to re-grow", () => {
  const i = UPDATER.indexOf("async function applyUpdate(");
  const body = UPDATER.slice(i, i + 1400);
  must(!/published/.test(body.replace(/\/\*[\s\S]*?\*\//g, "")),
    "applyUpdate reads a published flag again");
  must(/owner-only/.test(body), "who may install is no longer stated where the gate used to be");
  return "owner-only route, no flag";
});

/* =============== 3. what counts as a new version ===================== */

check("the version is the builder's file, read from both ends", () => {
  must(/function localFactoryVersion\(\)/.test(GH), "the installed version is never read");
  must(/config", "aurion\.factory\.json"/.test(GH), "it is not read from the factory config");
  must(/aurion\.json is the live configuration/.test(GH),
    "the reason the live config is not used is not written down");
  must(/const versionChanged = Boolean\(version\) && Boolean\(localVersion\) && version !== localVersion;/.test(GH),
    "version_changed is not a real comparison of two readable numbers");
  return "factory.json both ends, silence is not a change";
});

check("it rides on the target as well as beside it", () => {
  must(/version_changed: versionChanged,/.test(GH), "the check does not report it");
  const i = GH.indexOf("    update: {");
  must(/version_changed: versionChanged,/.test(GH.slice(i, i + 900)),
    "the stored target cannot answer, so the support policy cannot read it");
  return "state.version_changed + latest.version_changed";
});

check("an update and a version are carried as two separate facts", () => {
  const i = UPDATER.indexOf("async function checkGithub()");
  const body = UPDATER.slice(i, UPDATER.indexOf("\n}", UPDATER.indexOf("return { ok: true, ...state };", i)));
  must(/update_available: !!res\.update_available/.test(body), "the state invents its own answer");
  must(/version_changed: !!res\.version_changed/.test(body), "the version fact is dropped on the way to disk");
  must(/unpublished: behind && !res\.published/.test(body), "nothing records that there are no release notes");
  must(/latest: behind \? res\.update : null/.test(body), "the target is dropped");
  return "four fields, kept apart";
});

/* =============== 4. what the state file is allowed to claim ========== */

check("an update from main survives the read", () => {
  writeState({
    last_check: "2026-11-01T00:00:00Z",
    update_available: true,
    latest: { id: "abc123", version: "1.0.0", version_changed: false, published_at: "2026-11-01T00:00:00Z", files: [] },
  });
  const st = updater.getUpdateState();
  must(st.update_available === true, "the offer is still being deleted on the way out");
  must(st.unpublished === true, "nothing records that there are no release notes");
  must(st.latest && st.latest.id === "abc123", "the target was thrown away");
  return "offered, flagged, kept";
});

check("a state file too old to mention a version does not imply one", () => {
  writeState({
    last_check: "2026-11-01T00:00:00Z",
    update_available: true,
    latest: { id: "old1", version: "1.0.1", published_at: "2026-11-01T00:00:00Z", files: [] },
  });
  const st = updater.getUpdateState();
  must(st.latest.version_changed === false, "silence was read as a new version");
  must(SUP.evaluate(st, Date.parse("2030-01-01T00:00:00Z")).supported === true,
    "an old state file can still lock the desk");
  return "absent -> false -> open";
});

check("a real release still reads as one", () => {
  writeState({
    last_check: "2026-11-01T00:00:00Z",
    update_available: true,
    latest: { id: "v2", version: "2.0.0", published: true, published_at: "2026-11-01T00:00:00Z", files: [] },
  });
  const st = updater.getUpdateState();
  must(st.update_available === true, "a published release was dropped");
  must(st.unpublished !== true, "a tagged release was marked as having no notes");
  return "untouched";
});

/* =============== 5. what may lock a desk ============================= */

const mainState = (publishedIso) => ({
  last_check: "2030-01-01T00:00:00Z",
  update_available: true,
  latest: { version: "1.0.0", version_changed: false, published_at: publishedIso, files: [] },
});

check("an ordinary merge on main never ends support, however old it is", () => {
  const at = Date.parse("2026-01-01T00:00:00Z");
  for (const days of [0, 6, 100, 900]) {
    const out = SUP.evaluate(mainState("2026-01-01T00:00:00Z"), at + days * DAY);
    must(out.supported === true, "locked " + days + " days after a merge that changed no version");
    must(out.expired === false, "expired " + days + " days after an ordinary merge");
  }
  return "0, 6, 100, 900 days: still supported";
});

check("...and it says why, rather than looking like 'nothing to report'", () => {
  const out = SUP.evaluate(mainState("2026-01-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"));
  must(out.reason === "no_new_version", "reason is " + out.reason);
  must(out.update_available === false, "the countdown screen was handed an update to count down to");
  return "no_new_version";
});

check("the builder moving the number does end support, on time", () => {
  const at = Date.parse("2026-01-01T00:00:00Z");
  const state = {
    last_check: "2030-01-01T00:00:00Z",
    update_available: true,
    latest: { version: "1.1.0", version_changed: true, published_at: "2026-01-01T00:00:00Z", files: [] },
  };
  must(SUP.evaluate(state, at + 4 * DAY).supported === true, "locked inside the grace period");
  must(SUP.evaluate(state, at + 6 * DAY).expired === true, "a new version never locks anything");
  must(SUP.evaluate(state, at + 6 * DAY).latest_version === "1.1.0", "the lock screen cannot name the version");
  return "5-day grace, from version_changed";
});

check("a published release still ends support on time", () => {
  const at = Date.parse("2026-01-01T00:00:00Z");
  const state = {
    last_check: "2030-01-01T00:00:00Z",
    update_available: true,
    latest: { version: "9.9.9", published: true, published_at: "2026-01-01T00:00:00Z", files: [] },
  };
  must(SUP.evaluate(state, at + 4 * DAY).supported === true, "locked inside the grace period");
  must(SUP.evaluate(state, at + 6 * DAY).expired === true, "never locked at all");
  return "5-day grace unchanged";
});

check("the policy reads the two fields, not a channel name it was handed", () => {
  const src = read("backend/src/support-window.js");
  must(/latest\.version_changed === true \|\| latest\.published === true/.test(src),
    "the clock is not driven by version_changed or a release");
  must(!/if \(latest\.published !== true\) \{/.test(src), "the old published-only gate is still there");
  const i = src.indexOf("const newVersion =");
  must(/every merge would schedule every desk in the field to stop/.test(src.slice(i - 1400, i)),
    "the reason an offer alone may not lock a desk is not stated where the gate is");
  return "version_changed || published";
});

check("the fail-open rule survives all of it", () => {
  for (const state of [null, {}, { update_available: true, latest: null },
                       { update_available: false, latest: { version_changed: true } }]) {
    must(SUP.evaluate(state, Date.now()).supported === true, "locked on " + JSON.stringify(state));
  }
  const noDate = { update_available: true, latest: { version: "2", version_changed: true } };
  must(SUP.evaluate(noDate, Date.now()).reason === "no_release_date", "an undated version invented a deadline");
  return "no state, no target, no date: open";
});

/* =============== 6. how big the update is ============================ */

check("the check counts the bytes it is about to write", () => {
  must(/download_bytes: downloadBytes/.test(GH), "no size is reported");
  must(/files\.reduce\(\(n, f\) => n \+ \(Number\(f\.size\) \|\| 0\), 0\)/.test(GH),
    "the size is not the sum of the files' own sizes");
  must(/file_count: files\.length/.test(GH), "the count is not reported beside it");
  return "download_bytes + file_count";
});

check("the transfer is measured, never guessed", () => {
  must(/if \(onBytes\) \{ try \{ onBytes\(total\); \}/.test(GH),
    "the archive download does not report the bytes it has taken in");
  const i = GH.indexOf("onBytes(total)");
  const why = GH.slice(i - 600, i);
  must(/Content-Length/.test(why) && /Range/.test(why),
    "the reason the size cannot be known in advance is not recorded");
  must(/setProgress\(\{ bytes: n \}\)/.test(UPDATER), "the install screen is not told");
  return "measured while it arrives";
});

check("the progress object carries both numbers from the start", () => {
  must(/bytes: 0, change_bytes: 0/.test(UPDATER.replace(/\s+/g, " ")),
    "a poll before the first chunk would see undefined");
  return "bytes + change_bytes";
});

/* =============== 7. the desk says the right thing ==================== */

check("an update with no release behind it can be installed from the panel", () => {
  const i = APP.indexOf("async function bindUpdatePanel");
  const bind = APP.slice(i, i + 7000);
  must(/upd-apply-btn/.test(bind), "the install button is gone");
  must(/st\.data\.update_available && st\.data\.latest/.test(bind),
    "the offer branch no longer keys off update_available");
  must(!/upd-dev-btn/.test(APP), "a second, separate install button for branch builds has appeared");
  return "one button, one path";
});

check("and it says where it came from, so a blank changelog is not a bug", () => {
  must(/function fromMainHtml\(res\)/.test(APP), "nothing explains an offer with no notes");
  must(/if \(!res \|\| !res\.unpublished\) return "";/.test(APP),
    "the note is drawn for tagged releases too");
  must(/\+ fromMainHtml\(st\.data\)/.test(APP), "the panel does not show it");
  must(/\+fromMainHtml\(res\)/.test(APP), "the result card after pressing check does not show it");
  must(/unpublished: Boolean\(r\.unpublished\)/.test(APP),
    "checkForUpdate drops the flag, so the result card can never draw the note");
  for (const code of ["en", "fa", "ar"]) {
    must(typeof PACKS[code].upd.from_main === "string" && PACKS[code].upd.from_main.length > 10,
      code + " cannot say it");
  }
  return "upd.from_main in en/fa/ar";
});

check("the confirmation names the build, not a version that did not move", () => {
  must(/replace\('%s', updateStamp\(upd\)\)/.test(APP),
    "the dialog still says \"install 1.0.0?\" to a desk already running 1.0.0");
  return "updateStamp in upd.confirm";
});

check("the panel still has a state for a difference it was not offered", () => {
  const i = APP.indexOf("function paintUpdateFacts(");
  const body = APP.slice(i, APP.indexOf("\n}", APP.indexOf("chip.textContent", i)));
  must(/unpublished/.test(body), "the chip lost the state entirely");
  must(/st\.data\.unpublished \? 'unpublished'/.test(APP), "nothing can put the panel into it");
  return "kept as the fallback";
});

/* --------------------------------------------------------------------- */

process.on("exit", () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

if (failures.length) {
  console.log("\nrelease-gate: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nrelease-gate: " + pass + " checks passed");
