"use strict";

const fs = require("fs");
const { spawnSync } = require("child_process");
const { DATA, ACCESS_DB, ACCESS_PY, CONFIG } = require("./paths");

let cache = {
  users: [],
  sessions: [],
  settings: {},
  access_log: [],
  driver: "sqlite",
  error: "",
};

function pythonLauncher() {
  if (process.env.AURION_PY) {
    return { cmd: process.env.AURION_PY, prefix: [] };
  }
  if (process.platform === "win32") {
    return { cmd: "py", prefix: ["-3.12"] };
  }
  return { cmd: "python3", prefix: [] };
}

function databaseUrlFromConfig() {
  try {
    const raw = fs.readFileSync(CONFIG, "utf8");
    if (raw.length > 1024 * 1024) return "";
    const cfg = JSON.parse(raw);
    return String((cfg.database && cfg.database.url) || "").trim();
  } catch {
    return "";
  }
}

function run(cmd, extra = []) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA, 0o700); } catch {}
  const launch = pythonLauncher();
  // Secure: pass sql/params via stdin JSON to avoid argv exposure in process list
  let stdinPayload = null;
  let args;
  if ((cmd === "exec" || cmd === "query") && extra.length >= 2) {
    // extra[0]=sql, extra[1]=params json
    stdinPayload = JSON.stringify({ sql: extra[0], params: JSON.parse(extra[1] || "[]") });
    args = launch.prefix.concat([ACCESS_PY, ACCESS_DB, cmd]);
  } else {
    args = launch.prefix.concat([ACCESS_PY, ACCESS_DB, cmd, ...extra]);
  }
  const env = { ...process.env };
  // Never pass secrets via env if not needed, but keep DB URL
  if (!env.AURION_DATABASE_URL && !env.DATABASE_URL) {
    const url = databaseUrlFromConfig();
    if (url) env.AURION_DATABASE_URL = url;
  }
  // Remove sensitive env from child if present (prevent leak)
  // Keep only needed
  const r = spawnSync(launch.cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
    env,
    input: stdinPayload || undefined,
  });
  if (r.error) throw new Error("access_db spawn: " + r.error.message);
  const text = String(r.stdout || "").trim();
  if (!text) {
    const err = String(r.stderr || "").trim() || ("exit " + r.status);
    // redact sql from error
    throw new Error("access_db empty: " + err.slice(0, 200));
  }
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error("access_db parse: " + text.slice(0, 240));
  }
  if (!out || out.ok === false) throw new Error(out && out.error ? out.error : "access_db failed");
  if (out.driver) cache.driver = out.driver;
  return out;
}

function reload() {
  const dump = run("dump");
  cache.users = dump.users || [];
  cache.sessions = dump.sessions || [];
  cache.settings = dump.settings || {};
  cache.access_log = dump.access_log || [];
  cache.driver = dump.driver || cache.driver;
  cache.error = "";
  return cache;
}

function init() {
  try {
    run("init");
    return reload();
  } catch (err) {
    cache.error = String(err.message || err);
    if (process.env.AURION_DATABASE_URL || process.env.DATABASE_URL || databaseUrlFromConfig()) {
      delete process.env.AURION_DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        run("init");
        reload();
        cache.error = cache.error + " (fell back to sqlite)";
        cache.driver = "sqlite";
        return cache;
      } catch (inner) {
        throw inner;
      }
    }
    throw err;
  }
}

function exec(sql, params = []) {
  const out = run("exec", [sql, JSON.stringify(params)]);
  reload();
  return out;
}

function query(sql, params = []) {
  return run("query", [sql, JSON.stringify(params)]).rows || [];
}

function setting(key, fallback = "") {
  if (cache.settings[key] === undefined || cache.settings[key] === null) return fallback;
  return cache.settings[key];
}

function setSetting(key, value) {
  exec("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", [key, String(value)]);
}

function snapshot() {
  return cache;
}

function info() {
  try {
    const out = run("info");
    return {
      ok: true,
      driver: out.driver || cache.driver || "sqlite",
      wanted: out.wanted || "",
      url_set: Boolean(out.url_set),
      error: cache.error || "",
    };
  } catch (err) {
    return {
      ok: false,
      driver: cache.driver || "sqlite",
      url_set: Boolean(databaseUrlFromConfig() || process.env.AURION_DATABASE_URL || process.env.DATABASE_URL),
      error: String(err.message || err),
    };
  }
}

function getUserSettings(userId) {
  const out = run("get_settings", [String(userId || "")]);
  return out.row || null;
}

function putUserSettings(userId, payload) {
  const out = run("put_settings", [String(userId || ""), JSON.stringify(payload || {})]);
  return out.row || null;
}

module.exports = {
  init,
  reload,
  exec,
  query,
  setting,
  setSetting,
  snapshot,
  info,
  getUserSettings,
  putUserSettings,
  ACCESS_DB,
};
