"use strict";
/**
 * End of support: a build stops being usable five days after a newer one
 * is published.
 *
 * Why this exists. An installed copy that never updates is not a stable
 * copy, it is a copy that keeps whatever was wrong with it - including
 * the faults the next release fixes. Updating has been voluntary until
 * now, and "voluntary" in practice meant a desk sitting months behind
 * the engine it talks to, reporting bugs that were fixed long ago.
 *
 * So the offer has a clock on it. The moment a newer version is
 * published, this installation has five days of grace. During those days
 * nothing changes except that the desk says, plainly and with a
 * countdown, when it will stop. After them the desk is locked to one
 * screen: install the update.
 *
 * Three deliberate properties:
 *
 *   1. The clock starts when the update was PUBLISHED, not when this
 *      machine first noticed it. A desk that was switched off for a week
 *      does not get a fresh five days for having missed the news.
 *
 *   2. It fails OPEN. No update known, no publish date, an unreadable
 *      state file, a check that never succeeded because the machine is
 *      offline - every one of those leaves the desk working. A lockout
 *      is only ever the result of a positive, dated fact.
 *
 *   3. The lock is never total. The update routes stay open, so the way
 *      out is always reachable, and so do "close everything" and "disarm"
 *      - a trader must not be shut out of their own open positions by a
 *      maintenance policy. Auto-trading is halted separately, by the
 *      caller, so the engine does not keep opening trades behind a
 *      screen nobody can see.
 */

const fs = require("fs");
const path = require("path");
const { DATA } = require("./paths");

/** The grace period, in days. The one number this policy is made of. */
const SUPPORT_GRACE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = SUPPORT_GRACE_DAYS * DAY_MS;

/* Written by the updater's check. Read here rather than imported, so
   this module has no dependency on the updater and the updater has no
   dependency on the policy - either can be reasoned about alone. */
const UPDATE_STATE_FILE = path.join(DATA, "update-state.json");

function readState() {
  try {
    if (!fs.existsSync(UPDATE_STATE_FILE)) return null;
    const raw = fs.readFileSync(UPDATE_STATE_FILE, "utf8");
    if (!raw || raw.length > 5 * 1024 * 1024) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseWhen(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
}

/**
 * The support status implied by one update-state object.
 *
 * Split out from the file read so it can be reasoned about, and tested,
 * as what it is: a pure function of (what we know, what time it is).
 */
function evaluate(state, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const out = {
    grace_days: SUPPORT_GRACE_DAYS,
    update_available: false,
    latest_version: "",
    published_at: "",
    deadline: "",
    ms_left: null,
    days_left: null,
    hours_left: null,
    expired: false,
    supported: true,
    reason: "current",
  };

  const latest = state && state.update_available && state.latest ? state.latest : null;
  if (!latest) return out;

  /* The second lock, and the one that matters most.
     A desk is only ever locked over something a person PUBLISHED. The
     check writes published:true for a release and nothing else, so an
     update-state file that cannot make that statement - an old one
     written before this rule existed, one describing the head of a
     development branch, a hand-edited one - leaves the desk working.
     Failing open on silence is the whole design; this is where the
     silence is read. */
  if (latest.published !== true) {
    out.update_available = false;
    out.reason = "not_a_release";
    return out;
  }

  out.update_available = true;
  out.latest_version = String(latest.version || "");

  /* published_at is the release date, or the date of the head commit
     when there is no release - either way, when the thing on offer came
     into existence. build_date is the same instant truncated to a day
     and is only a fallback. */
  const published = parseWhen(latest.published_at) ?? parseWhen(latest.build_date);
  if (published === null) {
    /* An update with no date cannot be timed, and guessing one would
       mean inventing the deadline. Nothing is enforced. */
    out.reason = "no_release_date";
    return out;
  }

  const deadline = published + GRACE_MS;
  out.published_at = new Date(published).toISOString();
  out.deadline = new Date(deadline).toISOString();
  out.ms_left = deadline - now;
  out.days_left = Math.max(0, Math.ceil(out.ms_left / DAY_MS));
  out.hours_left = Math.max(0, Math.ceil(out.ms_left / (60 * 60 * 1000)));
  out.expired = out.ms_left <= 0;
  out.supported = !out.expired;
  out.reason = out.expired ? "expired" : "grace";
  return out;
}

/** The status of this installation, right now. */
function status(nowMs) {
  return evaluate(readState(), nowMs);
}

/* ---- what still works once support has ended ----------------------- */

/* Everything the way out is made of. The update panel's own routes are
   the point of the exercise; /host/restart is how the new build starts;
   /profile and /license are what the locked screen needs in order to
   render a name and a plan instead of blanks. */
const ALLOW_PREFIXES = ["/auth/", "/system/update/", "/system/support"];
const ALLOW_PATHS = new Set([
  "/auth",
  "/system/update",
  "/profile",
  "/license",
  "/host-logs",
  "/host/restart",
  /* Money first. A trader whose desk has just locked must still be able
     to flatten the book and arm the kill switch; refusing those would
     turn a maintenance policy into a position they cannot close. */
  "/flatten",
  "/kill",
]);

function normalisePath(p) {
  let out = String(p || "");
  const q = out.indexOf("?");
  if (q >= 0) out = out.slice(0, q);
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Whether one request may still be served by an out-of-support desk. */
function isAllowedWhileExpired(method, reqPath) {
  const p = normalisePath(reqPath);
  if (String(method || "").toUpperCase() === "OPTIONS") return true;
  if (ALLOW_PATHS.has(p)) return true;
  return ALLOW_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, "") || p.startsWith(prefix));
}

/**
 * The gate itself.
 *
 * Mounted on the guarded router after authentication, so the status is
 * computed for a known user and the 403 carries enough for the desk to
 * draw the end-of-support screen without a second request - which
 * matters, because the request that would have fetched it is exactly
 * the kind this blocks.
 */
function middleware(opts) {
  const onExpired = opts && typeof opts.onExpired === "function" ? opts.onExpired : null;
  /* The status function is a seam, so the gate can be exercised against
     a made-up state without a file on disk anywhere near the real one. */
  const readStatus = opts && typeof opts.status === "function" ? opts.status : status;
  return function supportGate(req, res, next) {
    let st;
    try {
      st = readStatus();
    } catch {
      /* Fail open, loudly in the log and nowhere else. A desk must not
         lock itself because a JSON file would not parse. */
      return next();
    }
    res.locals.support = st;
    if (!st.expired) return next();
    if (onExpired) {
      try { onExpired(st); } catch { /* halting is best effort */ }
    }
    if (isAllowedWhileExpired(req.method, req.path)) return next();
    return res.status(403).json({ ok: false, error: "support_expired", support: st });
  };
}

module.exports = {
  SUPPORT_GRACE_DAYS,
  GRACE_MS,
  DAY_MS,
  evaluate,
  status,
  isAllowedWhileExpired,
  middleware,
};
