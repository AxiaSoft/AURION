/**
 * Updating the build tree must not be a negotiation.
 *
 * Reported for the third time, in the same words:
 *
 *     error: Your local changes to the following files would be
 *     overwritten by merge ... Aborting
 *
 * That is git doing precisely the right thing for a working copy and
 * precisely the wrong thing for D:\AURION-BUILD. Nobody develops in
 * that folder. What git calls "your local changes" there is a file that
 * was pasted in to test a fix, or a line ending that an editor rewrote
 * on save. The cost of refusing is not theoretical: the machine stays
 * behind the branch while its owner believes it is current, and the
 * failures that follow get investigated as bugs in code that was never
 * on the disk. This session spent two rounds on exactly that.
 *
 * The update script used to make the same mistake - it stopped and
 * asked for -Force. So:
 *
 *   1. There is a root command that updates the tree, and it pauses, so
 *      a double-click leaves its output readable.
 *   2. The script takes the branch even when the tree is dirty.
 *   3. It saves what it is about to overwrite FIRST, as a patch, and
 *      the patch goes somewhere the sweep afterwards will not delete.
 *   4. -Keep still exists for the one person who really is editing
 *      there.
 *   5. Differences that are only whitespace are named as such, because
 *      they come back every time until the setting that causes them is
 *      changed.
 *   6. None of this ships to a trader: it is a build-tree tool.
 *
 *     node tests/build-tree-update.test.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const UPDATER = read("scripts/update-build-tree.ps1");
const CMD = read("update.cmd");
const STAGE = read("installer/tools/stage.ps1");

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const note = fn();
    pass++;
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (err) {
    fails.push(name + ": " + err.message);
    console.log("FAIL  " + name + "  — " + err.message);
  }
}

/* ------------------------------------------------ 1. one command */

check("there is a root command that updates the tree", () => {
  if (!/update-build-tree\.ps1/.test(CMD)) throw new Error("update.cmd does not call the updater");
  if (!/-ExecutionPolicy Bypass/.test(CMD)) throw new Error("it would be blocked by the execution policy");
  if (!/-Branch/.test(CMD)) throw new Error("it cannot be pointed at a branch other than main");
  if (!/\bmain\b/.test(CMD)) throw new Error("it has no default branch");
  return "update.cmd [branch]";
});

check("the window stays open", () => {
  /* Double-clicked, a cmd window closes the instant the script ends,
     and the list of what arrived is the whole point of running it. */
  if (!/\bpause\b/.test(CMD)) throw new Error("update.cmd exits without pausing");
  return "it pauses";
});

/* ------------------------------------- 2./3. it no longer refuses */

check("a dirty tree does not stop the update", () => {
  if (/run this again with -Force/.test(UPDATER)) {
    throw new Error("it still refuses and asks for -Force");
  }
  if (!/Taking the branch as it is on GitHub/.test(UPDATER)) {
    throw new Error("nothing says it proceeds");
  }
  return "it proceeds";
});

check("what is about to be overwritten is saved first", () => {
  const at = (s) => {
    const i = UPDATER.indexOf(s);
    if (i < 0) throw new Error("not found in the updater: " + s);
    return i;
  };
  const saved = at("local-changes");
  const diff = at("git diff HEAD --binary");
  const reset = at("git reset --hard FETCH_HEAD");
  if (!(diff < reset)) throw new Error("the reset happens before the patch is written");
  if (!(saved < reset)) throw new Error("the save happens after the thing it protects against");
  if (!/git apply/.test(UPDATER)) throw new Error("it never says how to get them back");
  return "patch, then reset";
});

check("the saved patch is not swept away by the clean that follows", () => {
  /* git clean -fd runs a few lines later. The keep list decides
     whether the file written thirty lines above still exists
     afterwards - and a backup that the same script deletes is worse
     than no backup, because it was announced. */
  const keep = UPDATER.slice(UPDATER.indexOf("$keep = @("), UPDATER.indexOf("git clean -nd"));
  if (!/"data\//.test(keep)) throw new Error("data/ is not protected from the sweep");
  if (!/data\\local-changes/.test(UPDATER)) throw new Error("the patch is written somewhere else");
  return "data/ is kept";
});

/* ------------------------------------------------- 4./5. the edges */

check("-Keep still stops for someone who really is editing here", () => {
  if (!/\[switch\] \$Keep/.test(UPDATER)) throw new Error("there is no way to say 'do not touch my work'");
  const block = UPDATER.slice(UPDATER.indexOf("if ($Keep)"), UPDATER.indexOf("if ($Keep)") + 400);
  if (!/exit 2/.test(block)) throw new Error("-Keep does not actually stop");
  return "-Keep";
});

check("-Force is still accepted, because every note and habit uses it", () => {
  if (!/\[switch\] \$Force/.test(UPDATER)) {
    throw new Error("an instruction given in three earlier sessions now errors out");
  }
  return "harmless no-op";
});

check("a difference that is only whitespace is named as one", () => {
  if (!/--ignore-all-space/.test(UPDATER)) {
    throw new Error("it cannot tell a real edit from a line-ending rewrite");
  }
  if (!/core\.autocrlf/.test(UPDATER)) {
    throw new Error("it diagnoses the cause but does not give the one-line cure");
  }
  return "named, with the setting that stops it";
});

/* --------------------------------------------------- 6. not shipped */

check("none of this reaches a trader's machine", () => {
  /* stage.ps1 copies root files by name. update.cmd is a tool for the
     one machine that has a git checkout; shipping it would put a
     `git reset --hard` button in an installed product. */
  const roots = /foreach \(\$f in @\(([\s\S]*?)\)\) \{/.exec(STAGE);
  if (!roots) throw new Error("stage.ps1 no longer copies root files by name (check this test)");
  if (/update\.cmd/.test(roots[1])) throw new Error("update.cmd is staged into the package");
  return "build-tree only";
});

console.log("\nbuild-tree-update: " + pass + " of " + (pass + fails.length) + " checks passed");
if (fails.length) {
  console.error("\nFAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
