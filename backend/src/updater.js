"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const { ROOT, DATA } = require("./paths");
const { load: loadConfig } = require("./config");

const UPDATE_SETTINGS_FILE = path.join(DATA, "update-settings.json");
const UPDATE_STATE_FILE = path.join(DATA, "update-state.json");
const MANIFEST_FILE = path.join(DATA, "local-manifest.json");

function ensureDirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function readJsonSecure(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 5 * 1024 * 1024) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeSecure(file, data) {
  ensureDirSecure(path.dirname(file));
  const tmp = file + ".tmp";
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function getSourceUrl() {
  // Source-defined URL: config/aurion.json -> update_server.url (authoritative, not editable from dashboard)
  try {
    const cfgPath = path.join(ROOT, "config", "aurion.json");
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, "utf8");
      const cfg = JSON.parse(raw);
      const url = cfg && cfg.update_server && cfg.update_server.url ? String(cfg.update_server.url).trim() : "";
      if (url) return url;
    }
  } catch {}
  try {
    const live = loadConfig();
    if (live && live.update_server && live.update_server.url) {
      return String(live.update_server.url).trim();
    }
  } catch {}
  return "";
}

function getSettings() {
  const defaults = {
    update_server_url: "",
    auto_check_enabled: false,
    auto_check_interval_hours: 6,
    last_check: null,
    last_check_result: null,
  };
  const stored = readJsonSecure(UPDATE_SETTINGS_FILE, {});
  const sourceUrl = getSourceUrl();
  const merged = { ...defaults, ...stored };
  // Authoritative source URL overrides any dashboard stored value
  if (sourceUrl) {
    merged.update_server_url = sourceUrl;
    merged.source_url = sourceUrl;
    merged.source_defined = true;
  } else {
    merged.source_defined = false;
    merged.source_url = "";
  }
  return merged;
}

function saveSettings(patch) {
  // Disallow editing update_server_url from dashboard - source defined only
  const safePatch = { ...(patch || {}) };
  if ("update_server_url" in safePatch) delete safePatch.update_server_url;
  if ("source_url" in safePatch) delete safePatch.source_url;
  const current = getSettings();
  const next = { ...current, ...safePatch };
  // Ensure source URL remains authoritative
  const src = getSourceUrl();
  if (src) {
    next.update_server_url = src;
    next.source_url = src;
    next.source_defined = true;
  }
  writeSecure(UPDATE_SETTINGS_FILE, {
    auto_check_enabled: next.auto_check_enabled,
    auto_check_interval_hours: next.auto_check_interval_hours,
    last_check: next.last_check,
    last_check_result: next.last_check_result,
    // do not persist url from dashboard, only from source; keep placeholder for compatibility
    _note: "update_server_url is source-defined in config/aurion.json",
  });
  return getSettings();
}

function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return null;
    if (stat.size > 50 * 1024 * 1024) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

function collectLocalManifest() {
  // collect important files for diff check
  const files = [];
  const includeDirs = [
    path.join(ROOT, "backend", "src"),
    path.join(ROOT, "engine", "aurion"),
    path.join(ROOT, "apps", "web", "js"),
    path.join(ROOT, "apps", "desktop"),
  ];
  const maxFiles = 500;
  let count = 0;

  function walk(dir, base) {
    if (count >= maxFiles) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (count >= maxFiles) break;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(ROOT, full).replace(/\\/g, "/");
        if (e.isDirectory()) {
          walk(full, base);
        } else if (e.isFile()) {
          if (full.endsWith(".log") || full.endsWith(".pyc")) continue;
          const hash = computeFileHash(full);
          if (hash) {
            files.push({ path: rel, hash });
            count++;
          }
        }
      }
    } catch {}
  }

  for (const d of includeDirs) {
    if (fs.existsSync(d)) walk(d, d);
  }

  // also version from config
  try {
    const cfg = loadConfig();
    const version = cfg.version || "1.0.0";
    writeSecure(MANIFEST_FILE, { version, files, generated_at: new Date().toISOString() });
    return { version, files };
  } catch {
    const version = "1.0.0";
    writeSecure(MANIFEST_FILE, { version, files, generated_at: new Date().toISOString() });
    return { version, files };
  }
}

function httpsJson(url, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "AURION-Updater/1.0",
        },
        timeout: timeoutMs,
      };
      if (isHttps) {
        opts.rejectUnauthorized = true;
        opts.minVersion = "TLSv1.2";
      }
      if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

      const req = lib.request(opts, (res) => {
        let data = "";
        let total = 0;
        res.on("data", chunk => {
          total += chunk.length;
          if (total > 5 * 1024 * 1024) {
            req.destroy(new Error("response_too_large"));
            return;
          }
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, json, headers: res.headers });
          } catch (e) {
            reject(new Error("invalid_json"));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      if (payload) req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function checkForUpdates() {
  const settings = getSettings();
  if (!settings.update_server_url) {
    return { ok: false, error: "update_server_not_configured" };
  }
  const manifest = collectLocalManifest();
  const url = String(settings.update_server_url).replace(/\/+$/, "") + "/api/updates/check";
  try {
    const result = await httpsJson(url, {
      current_version: manifest.version,
      files: manifest.files,
    }, 20000);
    const data = result.json;
    if (!data || !data.ok) {
      return { ok: false, error: data?.error || "server_error" };
    }
    // save state
    const state = {
      last_check: new Date().toISOString(),
      update_available: !!data.update_available,
      latest: data.update || null,
    };
    writeSecure(UPDATE_STATE_FILE, state);
    saveSettings({ last_check: state.last_check, last_check_result: state });

    return { ok: true, ...state };
  } catch (e) {
    return { ok: false, error: e.message || "network_error" };
  }
}

async function downloadUpdateFile(updateId, fileId, serverUrl) {
  const url = String(serverUrl).replace(/\/+$/, "") + `/api/updates/file/${encodeURIComponent(updateId)}/${encodeURIComponent(fileId)}`;
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname,
        method: "GET",
        headers: { "User-Agent": "AURION-Updater/1.0", "Accept": "application/octet-stream" },
        timeout: 30000,
      };
      if (isHttps) {
        opts.rejectUnauthorized = true;
        opts.minVersion = "TLSv1.2";
      }
      const req = lib.request(opts, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`http_${res.statusCode}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", chunk => {
          total += chunk.length;
          if (total > 50 * 1024 * 1024) {
            req.destroy(new Error("file_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const filePath = res.headers["x-file-path"];
          const fileHash = res.headers["x-file-hash"];
          const hash = crypto.createHash("sha256").update(buf).digest("hex");
          if (fileHash && hash !== fileHash) {
            reject(new Error("hash_mismatch"));
            return;
          }
          resolve({ buffer: buf, filePath, hash });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.end();
    } catch (e) { reject(e); }
  });
}

async function applyUpdate(updateId, serverUrl) {
  // only apply if published and exists
  const settings = getSettings();
  const url = String(serverUrl || settings.update_server_url).replace(/\/+$/, "");
  if (!url) return { ok: false, error: "no_server" };

  const state = readJsonSecure(UPDATE_STATE_FILE, {});
  const latest = state.latest;
  if (!latest || latest.id !== updateId) {
    // re-check
    const check = await checkForUpdates();
    if (!check.ok || !check.latest || check.latest.id !== updateId) {
      return { ok: false, error: "update_not_found" };
    }
  }

  const files = (state.latest?.files || []);
  if (!files.length) return { ok: false, error: "no_files" };

  const backupDir = path.join(DATA, "update_backups", updateId + "_" + Date.now());
  ensureDirSecure(backupDir);

  const applied = [];
  try {
    for (const f of files) {
      const dl = await downloadUpdateFile(updateId, f.id, url);
      const targetPath = path.join(ROOT, dl.filePath);
      const safeRoot = path.resolve(ROOT);
      const safeTarget = path.resolve(targetPath);
      if (!safeTarget.startsWith(safeRoot)) {
        throw new Error("path_traversal_blocked: " + dl.filePath);
      }
      // backup old file if exists
      if (fs.existsSync(safeTarget)) {
        const backupPath = path.join(backupDir, dl.filePath);
        ensureDirSecure(path.dirname(backupPath));
        fs.copyFileSync(safeTarget, backupPath);
      }
      ensureDirSecure(path.dirname(safeTarget));
      // atomic write
      const tmp = safeTarget + ".tmp." + Date.now();
      fs.writeFileSync(tmp, dl.buffer, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, safeTarget);
      try { fs.chmodSync(safeTarget, 0o600); } catch {}
      applied.push(dl.filePath);
    }

    // update version in config if needed
    try {
      const cfgPath = path.join(ROOT, "config", "aurion.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        cfg.version = state.latest.version || cfg.version;
        const tmp = cfgPath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, cfgPath);
      }
    } catch {}

    writeSecure(path.join(DATA, "last-update.json"), {
      update_id: updateId,
      version: state.latest.version,
      applied_at: new Date().toISOString(),
      files: applied,
      backup_dir: backupDir,
    });

    return { ok: true, applied, backup_dir: backupDir, version: state.latest.version };
  } catch (e) {
    return { ok: false, error: e.message, applied };
  }
}

function getUpdateState() {
  return readJsonSecure(UPDATE_STATE_FILE, { last_check: null, update_available: false, latest: null });
}

let autoCheckTimer = null;
function startAutoChecker() {
  if (autoCheckTimer) clearInterval(autoCheckTimer);
  const settings = getSettings();
  if (!settings.auto_check_enabled || !settings.update_server_url) return;
  const hours = Math.max(1, Math.min(168, Number(settings.auto_check_interval_hours) || 6));
  const ms = hours * 3600 * 1000;
  autoCheckTimer = setInterval(async () => {
    try { await checkForUpdates(); } catch {}
  }, ms);
  // also check shortly after start
  setTimeout(async () => { try { await checkForUpdates(); } catch {} }, 30000);
}

function stopAutoChecker() {
  if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null; }
}

module.exports = {
  getSettings,
  saveSettings,
  checkForUpdates,
  applyUpdate,
  getUpdateState,
  collectLocalManifest,
  startAutoChecker,
  stopAutoChecker,
};
