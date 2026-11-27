/**
 * The build number names the BUILD, not the machine.
 *
 * Reported in these words:
 *
 *   "before an update the build is AURION-26N2601, and the update
 *    screen shows that same number. After the update it becomes
 *    AURION-26N2606 - the sixth update. But when I install the very
 *    same sixth build from the MSI it says AURION-26N2601 again."
 *
 * One cause behind all three: the last two digits were counted locally
 * (build-seq.js counts distinct engine fingerprints this installation
 * has seen today), so the number described how much history a machine
 * had watched rather than which software it was running.
 *
 * What is pinned here:
 *
 *   1. The number travels with the build - counted once, at the
 *      source, off the repository's own history.
 *   2. An update carries the number of the build being OFFERED.
 *   3. Installing records it, so the stamp changes when the software
 *      does.
 *   4. A check that finds nothing to install records it too - that is
 *      the only way a fresh MSI install learns which build it is.
 *   5. A stamp that no longer matches the files on disk is not shown.
 *   6. The local count survives only as the last resort.
 *
 *     node tests/build-stamp.test.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-stamp-"));
process.env.AURION_DATA_DIR = TMP;

const stamp = require(path.join(ROOT, "backend", "src", "build-stamp.js"));
const buildId = require(path.join(ROOT, "backend", "src", "build-id.js"));

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const note = fn();
    pass++;
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    fails.push(name);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ── 1. the record itself ──────────────────────────────────────────── */

check("what the build says about itself is what comes back", () => {
  stamp.reset();
  stamp.record({ date: "2026-11-26", seq: "6", version: "1.0.3" });
  const got = stamp.current();
  if (!got) throw new Error("nothing was recorded");
  if (got.date !== "2026-11-26") throw new Error("date is " + got.date);
  if (got.seq !== "06") throw new Error("seq is " + got.seq + ", not two digits of the build's own number");
  if (got.version !== "1.0.3") throw new Error("the version was lost");
  return got.date + " / " + got.seq;
});

check("the number is the build's, not a count of what this machine has seen", () => {
  stamp.reset();
  /* The same desk, told twice that it is on build 06. A counter would
     now say 02; a fact says 06 both times. */
  stamp.record({ date: "2026-11-26", seq: "06", version: "1.0.3" });
  stamp.record({ date: "2026-11-26", seq: "06", version: "1.0.3" });
  const got = stamp.current();
  if (!got || got.seq !== "06") throw new Error("got " + (got && got.seq));
  return "still 06";
});

check("a stamp is tied to the files it was taken from", () => {
  stamp.reset();
  stamp.record({ date: "2026-11-26", seq: "06" });
  const saved = JSON.parse(fs.readFileSync(stamp.FILE, "utf8"));
  if (!saved.fingerprint) throw new Error("the stamp names no build at all");
  if (saved.fingerprint !== buildId.diskBuildId()) {
    throw new Error("the stamp does not describe the engine source on disk");
  }
  /* Pretend an update replaced the files underneath it. */
  fs.writeFileSync(stamp.FILE, JSON.stringify({ ...saved, fingerprint: "0000000000000000" }), "utf8");
  if (stamp.current() !== null) {
    throw new Error("a stamp from software that is no longer here is still being shown");
  }
  return "a stale stamp says nothing";
});

check("nonsense is refused rather than rounded into a number", () => {
  stamp.reset();
  if (stamp.record({ date: "", seq: "06" }) !== null) throw new Error("a stamp with no day was written");
  if (stamp.record({ date: "last tuesday" }) !== null) throw new Error("a stamp with no date was written");
  if (stamp.current() !== null) throw new Error("something was recorded after all");
  stamp.reset();
  return "no day, no stamp";
});

/* ── 2. where the number comes from ────────────────────────────────── */

const GH = read("backend", "src", "github-update.js");
const UPDATER = read("backend", "src", "updater.js");
const INDEX = read("backend", "src", "index.js");
const APP = read("apps", "web", "js", "app.js");

check("the number is counted off the repository's history", () => {
  if (!/async function dailySeq\(/.test(GH)) throw new Error("there is no source-side count at all");
  const fn = GH.slice(GH.indexOf("async function dailySeq("), GH.indexOf("async function resolveTarget("));
  if (!/\/commits/.test(fn)) throw new Error("the count does not look at the commits of that day");
  if (!/since=/.test(fn) || !/until=/.test(fn)) {
    throw new Error("the window is not bounded to one day, so the number is not a daily one");
  }
  if (!/return "";/.test(fn)) {
    throw new Error("a failed lookup still produces a number, which is the fault being fixed");
  }
});

check("the offer names the build being offered", () => {
  if (!/build_seq: target\.build_seq \|\| ""/.test(GH)) {
    throw new Error("the update panel has nothing but the installed build's number to show");
  }
  if (!/build_seq: await dailySeq\(/.test(GH)) {
    throw new Error("the target carries no number of its own");
  }
  if (!/buildTag\(d, upd && upd\.build_seq\)/.test(APP)) {
    throw new Error("the desk does not stamp the offer with its own number");
  }
});

/* ── 3. when it is recorded ────────────────────────────────────────── */

check("installing an update records the build it installed", () => {
  if (!/const buildStamp = require\("\.\/build-stamp"\)/.test(UPDATER)) {
    throw new Error("the updater cannot record a stamp");
  }
  const apply = UPDATER.slice(UPDATER.indexOf("async function applyUpdate("));
  if (!/buildStamp\.record\(\{[\s\S]{0,200}state\.latest\.build_date/.test(apply)) {
    throw new Error("an install leaves the machine calling itself the previous build");
  }
  if (!/seq: state\.latest\.build_seq/.test(apply)) {
    throw new Error("the installed build's number is not taken from the release");
  }
});

check("a check that finds nothing records it too - the MSI case", () => {
  const fn = UPDATER.slice(UPDATER.indexOf("async function checkGithub("), UPDATER.indexOf("async function checkForUpdates("));
  if (!/if \(!behind && res\.update\)/.test(fn)) {
    throw new Error("being already up to date teaches a fresh install nothing");
  }
  if (!/buildStamp\.record\(/.test(fn)) throw new Error("nothing is recorded on an up-to-date check");
});

/* ── 4. what the desk is told ──────────────────────────────────────── */

check("/api/meta prefers the build's own stamp over the local count", () => {
  const meta = INDEX.slice(INDEX.indexOf("let buildDate = \"\";"));
  const head = meta.slice(0, 1200);
  if (!/buildStamp\.current\(\)/.test(head)) throw new Error("the stamp is never consulted");
  const stampAt = head.indexOf("buildStamp.current()");
  const seqAt = head.indexOf("buildSeq_.seqFor(");
  if (seqAt < 0) throw new Error("the local fallback was removed - an offline desk now has no number at all");
  if (stampAt > seqAt) throw new Error("the local count still wins over the build's own number");
  if (!/\} else \{/.test(head)) throw new Error("both are used at once, which cannot be right");
});

/* ── 7. it counts builds, not commits ──────────────────────────────── */

/* Reported after the fix above had shipped: "the build number is going
 * up two at a time - I had taken two updates, it should have been 12
 * and it counted 14."
 *
 * It was. dailySeq counted every commit the day's window returned, and
 * a pull request merged with a merge commit puts two of them there: the
 * work, and the merge that brought it in. A branch of three commits
 * would have moved the number by four. The number was describing how
 * the work was WRITTEN rather than how many builds were published.
 *
 * A build number means "how many times the branch moved today", which
 * is its first-parent history. These run the real function over the
 * shape GitHub actually returns.
 */

const gh = require(path.join(ROOT, "backend", "src", "github-update.js"));

/** A commit as the API gives it: a sha and its parents, newest first. */
function c(sha, ...parents) {
  return { sha, parents: parents.map((p) => ({ sha: p })) };
}

check("two merged pull requests are two builds, not four", () => {
  /* m2 merges b2 into m1; m1 merges b1 into base. Four commits, two
     landings - the exact shape that counted double. */
  const list = [
    c("m2", "m1", "b2"),
    c("b2", "m1"),
    c("m1", "base", "b1"),
    c("b1", "base"),
  ];
  const chain = gh.firstParentChain(list);
  if (chain.length !== 2) {
    throw new Error(`counted ${chain.length} landings from ${list.length} commits`);
  }
  if (chain[0] !== "m2" || chain[1] !== "m1") {
    throw new Error("the chain is not the first-parent history: " + chain.join(","));
  }
  return "4 commits, 2 builds";
});

check("a branch of several commits is still one build", () => {
  const list = [
    c("m1", "base", "b3"),
    c("b3", "b2"), c("b2", "b1"), c("b1", "base"),
  ];
  if (gh.firstParentChain(list).length !== 1) {
    throw new Error("a three-commit branch still moves the number by three");
  }
  return "3 commits on a branch, 1 build";
});

check("a commit pushed straight to the branch is a build of its own", () => {
  /* Not everything arrives through a pull request, and a direct push is
     a landing like any other. */
  const list = [c("d2", "d1"), c("d1", "base")];
  if (gh.firstParentChain(list).length !== 2) {
    throw new Error("direct pushes are no longer counted");
  }
  return "2 direct pushes, 2 builds";
});

check("a release tag on the work is counted as the merge that shipped it", () => {
  /* A tag usually points at the branch commit, which is not on the
     first-parent chain at all. Counting it as "not found" would make
     every tagged release report the day's full count. */
  const list = [c("m2", "m1", "b2"), c("b2", "m1"), c("m1", "base", "b1"), c("b1", "base")];
  const chain = gh.firstParentChain(list);
  if (gh.landingFor(list, chain, "b1") !== "m1") {
    throw new Error("the work is not mapped back to its landing");
  }
  if (gh.landingFor(list, chain, "m2") !== "m2") {
    throw new Error("a landing is no longer itself");
  }
  if (gh.landingFor(list, chain, "nope") !== "") {
    throw new Error("an unknown commit is given a landing it does not have");
  }
  return "b1 -> m1";
});

check("nothing in the count can loop or throw", () => {
  /* The commits endpoint is a page of someone else's data. */
  for (const junk of [[], null, undefined, [null], [{}], [c("a", "a")],
                      [c("x", "y")], [{ sha: "s" }]]) {
    const chain = gh.firstParentChain(junk);
    if (!Array.isArray(chain)) throw new Error("it did not answer with a list");
  }
  /* A commit that is its own parent is the one that can spin for ever. */
  if (gh.firstParentChain([c("a", "a")]).length !== 1) {
    throw new Error("a self-referencing commit is counted more than once");
  }
  return "no loop, no throw";
});

check("the day is still the window, and a failure is still no number", () => {
  const fn = GH.slice(GH.indexOf("async function dailySeq("), GH.indexOf("async function resolveTarget("));
  if (!/firstParentChain\(list\)/.test(fn)) {
    throw new Error("dailySeq does not use the first-parent walk");
  }
  if (/list\.length - at/.test(fn) && !/chain\.length - at/.test(fn)) {
    throw new Error("the position is still measured against every commit");
  }
  return "counted off the chain";
});

console.log("");
if (fails.length) {
  console.log(`build-stamp: ${fails.length} of ${pass + fails.length} checks FAILED`);
  process.exit(1);
}
console.log(`build-stamp: ${pass} checks passed`);
