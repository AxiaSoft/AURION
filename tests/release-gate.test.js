/**
 * An update is a release somebody published. Nothing else.
 *
 * Reported by the owner: a desk that had been told "a new update is
 * available - install it or this build stops working in five days", on a
 * product for which no update had been released at all.
 *
 * It was true in the only sense the code could see. The check compared
 * the installed files with the head of the tracked branch and reported an
 * update when any of them differed, so every commit anyone pushed - a
 * merged pull request, a typo fix, work in progress - became "a new
 * version has been published" on every installation. The support window
 * then read the same field and turned that commit's date into a five-day
 * countdown to locking the desk. Our own development activity was
 * scheduling customers' machines to stop.
 *
 * The rule now: an offer, an announcement and the clock all require a
 * PUBLISHED RELEASE. A branch that has moved is still detected - the
 * owner can still install from it deliberately - but it is not an offer,
 * it is never announced, and it can never lock anything.
 *
 * Checked here behaviourally where possible: the state file, the policy
 * and the sanitiser are all run for real against a throwaway data
 * directory.
 *
 *     npm run test:relgate
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

/* =============== 1. what the check calls an update ==================== */

check("a release says so, in a field of its own", () => {
  const i = GH.indexOf('channel: "release"');
  const block = GH.slice(i, GH.indexOf("\n      };", i));
  must(/published: true/.test(block), "a release does not mark itself published");
  return "published:true";
});

check("the head of a branch says the opposite", () => {
  const i = GH.indexOf('channel: "branch"');
  const block = GH.slice(i, GH.indexOf("\n  };", i));
  must(/published: false/.test(block), "a branch head is not marked unpublished");
  return "published:false";
});

check("an offer needs both: a release, and something to install", () => {
  must(/update_available: published && files\.length > 0/.test(GH),
    "update_available is still computed from the file list alone");
  must(!/update_available: files\.length > 0/.test(GH), "the old rule is still in the file");
  return "published && files.length";
});

check("a moved branch is still detected, under its own name", () => {
  must(/behind: files\.length > 0/.test(GH), "nothing records that the branch has moved");
  const i = GH.indexOf("behind: files.length > 0");
  must(GH.slice(i - 400, i).includes("nothing in the product may act on it"),
    "the separation is not explained where it can be deleted by accident");
  return "behind";
});

/* =============== 2. what the state file is allowed to claim =========== */

check("a branch build is kept, so the owner can still install it on purpose", () => {
  const i = UPDATER.indexOf("async function checkGithub()");
  const body = UPDATER.slice(i, UPDATER.indexOf("\n}", UPDATER.indexOf("return { ok: true, ...state };", i)));
  must(/latest: behind \? res\.update : null/.test(body), "the target is dropped unless it is a release");
  must(/unpublished: behind && !res\.published/.test(body), "nothing marks the state as not an offer");
  must(/update_available: !!res\.update_available/.test(body), "the state invents its own answer");
  return "kept, flagged, not offered";
});

check("a state file written by the old rule stops claiming an update", () => {
  writeState({
    last_check: "2026-11-01T00:00:00Z",
    update_available: true,
    latest: { id: "abc123", version: "1.0.1", published_at: "2026-11-01T00:00:00Z", files: [] },
  });
  const st = updater.getUpdateState();
  must(st.update_available === false, "the stale claim survived the read");
  must(st.unpublished === true, "the reason is not recorded");
  must(st.latest && st.latest.id === "abc123", "the target was thrown away with the claim");
  return "corrected on read";
});

check("a real release still reads as one", () => {
  writeState({
    last_check: "2026-11-01T00:00:00Z",
    update_available: true,
    latest: { id: "v2", version: "2.0.0", published: true, published_at: "2026-11-01T00:00:00Z", files: [] },
  });
  const st = updater.getUpdateState();
  must(st.update_available === true, "a published release was dropped too");
  return "untouched";
});

/* =============== 3. what may lock a desk ============================== */

const branchState = (publishedIso) => ({
  last_check: "2030-01-01T00:00:00Z",
  update_available: true,
  latest: { version: "9.9.9", published_at: publishedIso, files: [] },
});

check("a branch build never ends support, however old it is", () => {
  const published = Date.parse("2026-01-01T00:00:00Z");
  for (const days of [0, 6, 100, 900]) {
    const out = SUP.evaluate(branchState("2026-01-01T00:00:00Z"), published + days * DAY);
    must(out.supported === true, "locked " + days + " days after a commit that was never released");
    must(out.expired === false, "expired " + days + " days after an unreleased commit");
  }
  return "0, 6, 100, 900 days: still supported";
});

check("...and it says why, rather than looking like 'nothing to report'", () => {
  const out = SUP.evaluate(branchState("2026-01-01T00:00:00Z"), Date.parse("2027-01-01T00:00:00Z"));
  must(out.reason === "not_a_release", "reason is " + out.reason);
  must(out.update_available === false, "it is still described as an available update");
  return "not_a_release";
});

check("a published release still ends support on time", () => {
  const published = Date.parse("2026-01-01T00:00:00Z");
  const state = {
    last_check: "2030-01-01T00:00:00Z",
    update_available: true,
    latest: { version: "9.9.9", published: true, published_at: "2026-01-01T00:00:00Z", files: [] },
  };
  must(SUP.evaluate(state, published + 4 * DAY).supported === true, "locked inside the grace period");
  must(SUP.evaluate(state, published + 6 * DAY).expired === true, "never locked at all");
  return "5-day grace unchanged";
});

check("the policy reads the field, not a channel name it was handed", () => {
  const src = read("backend/src/support-window.js");
  must(/latest\.published !== true/.test(src), "the policy does not require a published release");
  const i = src.indexOf("latest.published !== true");
  must(/fail/i.test(src.slice(i - 900, i)), "the failing-open reasoning is not stated where the test is");
  return "published !== true -> open";
});

/* =============== 4. how big the update is ============================= */

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

/* =============== 5. the desk says the right thing ===================== */

check("the panel never calls an unpublished difference an update", () => {
  must(/unpublished/.test(APP), "the desk has no idea the distinction exists");
  const i = APP.indexOf("function paintUpdateFacts(");
  const body = APP.slice(i, APP.indexOf("\n}", APP.indexOf("chip.textContent", i)));
  must(/unpublished/.test(body), "the chip has no state for 'the branch moved, nothing was released'");
  must(/st\.data\.unpublished \? 'unpublished'/.test(APP),
    "nothing ever puts the panel into that state");
  return "its own state";
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
