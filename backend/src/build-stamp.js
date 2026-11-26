"use strict";

/**
 * Which build is this, as a fact about the BUILD rather than about
 * this machine.
 *
 * Reported from the field, and the reason this file exists:
 *
 *   "the build number is wrong. Before an update it says
 *    AURION-26N2601, the update screen says the same number, and
 *    after the update it becomes AURION-26N2606 - the sixth build.
 *    But when I install the very same sixth build from the MSI it
 *    says AURION-26N2601 again."
 *
 * All three readings came from build-seq.js, which counts the distinct
 * engine fingerprints THIS INSTALLATION has seen today. That is a
 * property of the machine's history, not of the software: a desk that
 * has watched five updates land says 06, and a desk that was installed
 * from the MSI an hour ago says 01, while both are running the same
 * bytes. Two identical installations are then unable to agree on what
 * they are, which is the one thing a build identifier has to do - it
 * exists so a trader can read it back to support.
 *
 * So the number is no longer counted here. It is counted once, at the
 * source, off the repository's own history (see dailySeq in
 * github-update.js: the position of this build's commit among the
 * commits published that day), and it travels with the build:
 *
 *   * an update carries it in the offer and records it when it
 *     installs, so the stamp changes at the moment the software does;
 *   * a fresh install from the MSI records it at the first successful
 *     update check that finds nothing to install - "you are already on
 *     the newest build" is also a statement about WHICH build that is.
 *
 * The recording is tied to the engine-source fingerprint that was on
 * disk when it was made. A stamp whose fingerprint no longer matches
 * describes software that is no longer here and is therefore ignored
 * rather than shown - a wrong number is worse than a modest one.
 */

const fs = require("fs");
const path = require("path");
const { DATA } = require("./paths");
const buildId = require("./build-id");

const FILE = path.join(DATA, "build-stamp.json");

/** Two digits, always: a stamp with a variable tail is not a format. */
function pad2(n) {
  return String(Math.max(1, Math.min(99, Number(n) || 1))).padStart(2, "0");
}

/** A date is only a date in the one shape the whole system uses. */
function isDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

/** What was last recorded, or null. Never throws. */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const date = String(raw.date || "");
    if (!isDay(date)) return null;
    return {
      date,
      seq: pad2(raw.seq),
      version: String(raw.version || ""),
      fingerprint: String(raw.fingerprint || ""),
      at: String(raw.at || ""),
    };
  } catch {
    return null;
  }
}

/**
 * Remember which build is on this disk.
 *
 * `date` and `seq` come from the release - from GitHub's own history -
 * and the fingerprint is taken here, from the files as they are now,
 * so the record can never be attributed to a build that replaced it.
 *
 * Writing nothing is a correct outcome: without a day there is nothing
 * to say, and a stamp is never worth failing an install over.
 */
function record(info) {
  const date = String((info && info.date) || "").slice(0, 10);
  if (!isDay(date)) return null;
  let fingerprint = "";
  try {
    /* The files may have been rewritten a moment ago by the very
       install that is recording this. */
    buildId.invalidate();
    fingerprint = buildId.diskBuildId();
  } catch { fingerprint = ""; }
  const out = {
    date,
    seq: pad2((info && info.seq) || 1),
    version: String((info && info.version) || ""),
    fingerprint,
    at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(out), "utf8");
  } catch {
    /* An unwritable data directory is somebody else's emergency. The
       desk falls back to what it can work out locally. */
  }
  return out;
}

/**
 * The recorded stamp, but only if it still describes what is on disk.
 *
 * Returns null when there is no record, when the record predates the
 * files that are here now, or when the fingerprint cannot be read at
 * all - "I do not know" must never be dressed up as a number.
 */
function current() {
  const saved = read();
  if (!saved) return null;
  if (!saved.fingerprint) return null;
  let disk = "";
  try { disk = buildId.diskBuildId(); } catch { disk = ""; }
  if (!disk || disk !== saved.fingerprint) return null;
  return saved;
}

/** Forget it - for tests, and for a repair that resets local state. */
function reset() {
  try { fs.unlinkSync(FILE); } catch { /* nothing to forget */ }
}

module.exports = { record, read, current, reset, pad2, FILE };
