"use strict";

/**
 * Is the engine running the files that are on this disk?
 *
 * Reported from the field, after an update had been installed: the desk
 * said up to date, the files on disk were the new ones, and the engine
 * kept returning an error that had been fixed two releases earlier.
 * Python holds a module in memory for the life of the process, so an
 * update that copies files over a running engine changes nothing about
 * what that engine executes. Nobody -- not the user, not the desk --
 * could see the difference.
 *
 * The engine fingerprints its own source at import time and reports it
 * on /health. This takes the same fingerprint of the same files as they
 * are now. Equal means the process is the disk. Different means an
 * update is waiting for a restart, and the desk can say so instead of
 * leaving the user to conclude the fix never shipped.
 *
 * Identical rules on both sides, or the comparison is noise:
 * every .py under engine/aurion, hashed by content (so a copy that
 * preserves timestamps is still caught), __pycache__ skipped, sorted by
 * relative POSIX path. See engine/aurion/build_id.py.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ROOT } = require("./paths");

const SOURCE_DIR = path.join(ROOT, "engine", "aurion");
const SKIP_DIRS = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", "models"]);

/** Every shipped .py under `dir`, as paths relative to it, sorted. */
function sources(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name), rel ? rel + "/" + e.name : e.name);
      } else if (e.isFile() && e.name.endsWith(".py")) {
        out.push(rel ? rel + "/" + e.name : e.name);
      }
    }
  };
  walk(dir, "");
  /* Sorted the way Python's sorted(rglob) orders full paths: by the
     whole relative path, so both sides hash the same sequence. */
  out.sort();
  return out;
}

/**
 * The fingerprint of the engine source on disk right now.
 *
 * "" means "could not be read", and every caller treats "" as no
 * statement at all. "I do not know" and "they differ" lead to opposite
 * actions, and only one of them may interrupt a trader.
 */
let cached = { at: 0, value: "" };
const CACHE_MS = 2000;

/** Forget the cached reading - after an install has written files. */
function invalidate() { cached = { at: 0, value: "" }; }

function diskBuildId(root) {
  const base = root || SOURCE_DIR;
  /* Health is polled, and hashing a hundred files on every poll would
     be a silly price for an answer that changes only when an update
     writes. Two seconds is short enough that the install screen sees the
     change immediately and long enough that polling costs nothing. */
  const useCache = !root;
  if (useCache && cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;
  try {
    const files = sources(base);
    if (!files.length) return "";
    const h = crypto.createHash("sha256");
    for (const rel of files) {
      let blob;
      try { blob = fs.readFileSync(path.join(base, rel)); } catch { continue; }
      h.update(Buffer.from(rel, "utf8"));
      h.update(Buffer.from([0]));
      h.update(Buffer.from(crypto.createHash("sha256").update(blob).digest("hex"), "ascii"));
      h.update(Buffer.from("\n", "utf8"));
    }
    const out = h.digest("hex").slice(0, 16);
    if (useCache) cached = { at: Date.now(), value: out };
    return out;
  } catch {
    return "";
  }
}

/**
 * Compare what the engine reported with what is on disk.
 *
 * `stale` is only ever true when both sides gave a real answer and the
 * answers differ. An engine too old to report a build id (every build
 * before this one) says nothing, and nothing is not a mismatch.
 */
function compare(reported) {
  const disk = diskBuildId();
  const running = String(reported || "");
  const known = Boolean(disk) && Boolean(running);
  return {
    disk,
    running,
    known,
    stale: known && disk !== running,
  };
}

module.exports = { diskBuildId, compare, invalidate, SOURCE_DIR };
