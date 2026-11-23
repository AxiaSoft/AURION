/**
 * The daily release number in the build stamp.
 *
 * The stamp is AURION-YY<M>DD<NN>. <NN> is the one part of it that is
 * not a restatement of the date, so it is the one part that can lie:
 * a counter nudged by the wrong event would tell a trader they were on
 * the fourth build of a day on which nothing was released.
 *
 * What is pinned here:
 *
 *   1. It counts BUILDS, not readings. The same engine fingerprint
 *      read a hundred times is still build one.
 *   2. A new fingerprint on the same day is the next number.
 *   3. Midnight resets it, and the ledger never accumulates days.
 *   4. Not knowing writes nothing. An engine that cannot report a
 *      fingerprint must not inflate the count on every page refresh.
 *   5. Two digits, always, and it never runs past 99.
 *   6. The number travels: /api/meta sends it, and it is counted off
 *      the engine source rather than off the config file's mtime -
 *      that file is rewritten whenever a setting is saved.
 *
 *     node tests/build-seq.test.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/* A scratch data directory, so the test never touches a real ledger. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-seq-"));
process.env.AURION_DATA_DIR = TMP;

const seqMod = require(path.join(ROOT, "backend", "src", "build-seq.js"));

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

check("the first build of a day is 01", () => {
  seqMod.reset();
  const got = seqMod.seqFor("2026-11-23", "aaaaaaaaaaaaaaaa");
  if (got !== "01") throw new Error("got " + got);
  return got;
});

check("reading the same build again does not advance the number", () => {
  seqMod.reset();
  seqMod.seqFor("2026-11-23", "aaaaaaaaaaaaaaaa");
  for (let i = 0; i < 25; i++) {
    const got = seqMod.seqFor("2026-11-23", "aaaaaaaaaaaaaaaa");
    if (got !== "01") throw new Error("refresh " + i + " reported " + got);
  }
  return "still 01 after 25 readings";
});

check("a new build on the same day is the next number", () => {
  seqMod.reset();
  if (seqMod.seqFor("2026-11-23", "aaaa") !== "01") throw new Error("first");
  if (seqMod.seqFor("2026-11-23", "bbbb") !== "02") throw new Error("second");
  if (seqMod.seqFor("2026-11-23", "cccc") !== "03") throw new Error("third");
  /* And going back to an earlier one reports that one, not the latest. */
  if (seqMod.seqFor("2026-11-23", "aaaa") !== "01") throw new Error("the first build lost its number");
  return "01, 02, 03";
});

check("midnight starts again at 01, and the ledger holds one day", () => {
  seqMod.reset();
  seqMod.seqFor("2026-11-23", "aaaa");
  seqMod.seqFor("2026-11-23", "bbbb");
  if (seqMod.seqFor("2026-11-24", "cccc") !== "01") throw new Error("the new day inherited yesterday's count");
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, "build-seq.json"), "utf8"));
  if (raw.date !== "2026-11-24") throw new Error("the ledger still says " + raw.date);
  if (raw.builds.length !== 1) throw new Error("yesterday's builds are still in the file");
  return "one day at a time";
});

check("an unknown fingerprint writes nothing and never inflates", () => {
  /* The engine is offline, or too old to report one. A guess that grew
     on every poll would be worse than no number at all. */
  seqMod.reset();
  for (let i = 0; i < 10; i++) {
    const got = seqMod.seqFor("2026-11-23", "");
    if (got !== "01") throw new Error("poll " + i + " reported " + got);
  }
  if (fs.existsSync(path.join(TMP, "build-seq.json"))) throw new Error("it wrote a ledger out of a guess");
  /* And once a real build is known, silence reports that build's count
     rather than resetting it. */
  seqMod.seqFor("2026-11-23", "aaaa");
  seqMod.seqFor("2026-11-23", "bbbb");
  if (seqMod.seqFor("2026-11-23", "") !== "02") throw new Error("silence forgot what was already counted");
  return "no fingerprint, no write";
});

check("the number is two digits and stops at 99", () => {
  if (seqMod.pad2(1) !== "01") throw new Error(seqMod.pad2(1));
  if (seqMod.pad2(9) !== "09") throw new Error(seqMod.pad2(9));
  if (seqMod.pad2(10) !== "10") throw new Error(seqMod.pad2(10));
  if (seqMod.pad2(0) !== "01") throw new Error("zero is not a release number");
  if (seqMod.pad2(-4) !== "01") throw new Error("negative is not a release number");
  if (seqMod.pad2(1000) !== "99") throw new Error("the tail grew past two digits");
  return "01..99";
});

check("a missing date answers 01 rather than guessing", () => {
  seqMod.reset();
  if (seqMod.seqFor("", "aaaa") !== "01") throw new Error("a stamp with no date was counted");
  return "01";
});

check("the desk is sent the number, counted off the engine source", () => {
  const api = fs.readFileSync(path.join(ROOT, "backend", "src", "index.js"), "utf8");
  if (!/build_seq: buildSeq/.test(api)) throw new Error("/api/meta does not send build_seq");
  if (!/seqFor\(buildDate, buildId\.diskBuildId\(\)\)/.test(api)) {
    throw new Error("the number is not counted off the engine-source fingerprint");
  }
  /* config/aurion.json is rewritten on every settings save, so its
     mtime must never be what advances the count. */
  if (/seqFor\(buildDate, *stat/.test(api)) throw new Error("the count follows a file that settings rewrite");
  const app = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
  if (!/S\.buildSeq = meta\.data\.build_seq/.test(app)) throw new Error("the desk drops the number on the floor");
  if (/buildTag\(S\.buildDate\)/.test(app)) throw new Error("a caller still stamps without the number");
  return "/api/meta -> S.buildSeq -> buildTag";
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* scratch */ }

console.log("\nbuild-seq: " + pass + " of " + (pass + fails.length) + " checks passed");
if (fails.length) {
  console.error("\nFAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
