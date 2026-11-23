"use strict";

/**
 * Which build of today is this?
 *
 * The build stamp is AURION-YY<M>DD<NN>, and the last two digits are
 * the release number within that day: 01 for the first, 02 for the
 * second. A date alone cannot tell two builds of the same afternoon
 * apart, which is exactly the case where somebody reads a stamp back
 * to support and the answer matters.
 *
 * The number has to come from a fact, not from a counter that any
 * event can nudge. The obvious candidate - the mtime of
 * config/aurion.json, which is where build_date comes from - is not
 * one: that file is rewritten every time a setting is saved, so a
 * trader who changed their risk cap twice would be told they were on
 * the third build of the day.
 *
 * So this counts the thing that actually changes when a build changes:
 * the fingerprint of the engine source, which build-id.js already
 * computes for the "restart required" check. A new fingerprint seen
 * today is a new build today. The same fingerprint read a thousand
 * times is still build one.
 *
 * Only the current day is kept. At the first reading after midnight
 * the ledger is replaced, so the file holds at most a handful of
 * strings and can never grow without bound.
 */

const fs = require("fs");
const path = require("path");
const { DATA } = require("./paths");

const LEDGER = path.join(DATA, "build-seq.json");

/** Two digits, because a stamp with a variable tail is not a format. */
function pad2(n) {
  return String(Math.max(1, Math.min(99, Number(n) || 1))).padStart(2, "0");
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    const date = String(raw && raw.date ? raw.date : "");
    const builds = Array.isArray(raw && raw.builds) ? raw.builds.map(String) : [];
    return { date, builds };
  } catch {
    return { date: "", builds: [] };
  }
}

function write(state) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(state), "utf8");
  } catch {
    /* A stamp is not worth failing a request over. Without the ledger
       every reading answers 01, which is what an installation that has
       seen one build today should say anyway. */
  }
}

/**
 * The 1-based position of `fingerprint` among the distinct builds seen
 * on `date`, as a two-digit string.
 *
 * An unknown fingerprint - the engine is offline, or too old to report
 * one - writes nothing and answers with the count so far, or 01. A
 * guess that grew every time the page was refreshed would be worse
 * than no number at all.
 */
function seqFor(date, fingerprint) {
  const day = String(date || "").slice(0, 10);
  const id = String(fingerprint || "").trim();
  if (!day) return "01";
  const state = read();
  const fresh = state.date !== day;
  const builds = fresh ? [] : state.builds;
  if (!id) return pad2(builds.length || 1);
  let at = builds.indexOf(id);
  if (at < 0) {
    builds.push(id);
    at = builds.length - 1;
    write({ date: day, builds });
  } else if (fresh) {
    write({ date: day, builds });
  }
  return pad2(at + 1);
}

/** Forget everything - for tests, and for a repair that resets state. */
function reset() {
  try { fs.unlinkSync(LEDGER); } catch { /* nothing to forget */ }
}

module.exports = { seqFor, reset, pad2, LEDGER };
