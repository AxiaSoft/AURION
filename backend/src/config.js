const fs = require("fs");
const path = require("path");
const { CONFIG, DATA, ROOT } = require("./paths");

// The factory defaults always ship with the source tree, even when the live
// config has been relocated with AURION_CONFIG_DIR.
const FACTORY_CANDIDATES = [
  path.join(path.dirname(CONFIG), "aurion.factory.json"),
  path.join(ROOT, "config", "aurion.factory.json"),
];
const FACTORY = FACTORY_CANDIDATES.find((p) => fs.existsSync(p)) || FACTORY_CANDIDATES[0];

function ensureConfig() {
  // First-run bootstrap. The MSI deliberately does NOT ship config/aurion.json
  // (shipping it would let every installer upgrade overwrite the user's live
  // config — mt5 credentials, license otp, settings). When the file is missing
  // (fresh install), create it from the factory defaults so it exists, is
  // writable, and later upgrades/updates never replace it.
  if (fs.existsSync(CONFIG)) return;
  try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); } catch { /* best effort */ }
  let json;
  try {
    const raw = fs.readFileSync(FACTORY, "utf8");
    json = JSON.parse(raw);
    if (!json || typeof json !== "object") throw new Error("factory not an object");
  } catch {
    json = { runtime: {}, prop: {}, execution: {}, mt5: {}, ai: {} };
  }
  const tmp = CONFIG + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG);
  try { fs.chmodSync(CONFIG, 0o600); } catch { /* best effort */ }
}

function deepUpdate(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      if (Object.prototype.hasOwnProperty.call(base, k)) {
        deepUpdate(base[k], v);
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(base, k) || base[k] === undefined) {
        // only allow known keys, prevent injection of new top-level secrets via overlay
        base[k] = v;
      } else {
        // allow but still skip dangerous
        base[k] = v;
      }
    }
  }
  return base;
}

function isSafeKey(k) {
  return k !== "__proto__" && k !== "constructor" && k !== "prototype";
}

function sanitizeOverlay(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (!isSafeKey(k)) continue;
    if (v && typeof v === "object") {
      out[k] = sanitizeOverlay(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  ensureConfig();
  const data = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const statePath = path.join(DATA, "runtime-state.json");
  const bakPath = path.join(DATA, "runtime-state.bak.json");
  for (const p of [statePath, bakPath]) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf8");
      // basic size limit to prevent DoS
      if (raw.length > 64 * 1024) continue;
      let overlay = JSON.parse(raw);
      if (overlay && typeof overlay === "object") {
        overlay = sanitizeOverlay(overlay);
        // never allow overlay to inject database url or secrets
        if (overlay.database) delete overlay.database;
        if (overlay.license && overlay.license.otp) {
          // otp secrets must not be overridden by runtime-state
          delete overlay.license.otp;
        }
        if (overlay.mt5 && overlay.mt5.password) {
          delete overlay.mt5.password;
        }
        deepUpdate(data, overlay);
        break;
      }
    } catch { /* keep aurion.json */ }
  }
  return data;
}

function slimState(data) {
  const runtime = data.runtime || {};
  const prop = data.prop || {};
  const mt5 = data.mt5 || {};
  const execution = data.execution || {};
  const ai = data.ai || {};
  return {
    runtime,
    prop: {
      enabled: prop.enabled,
      active_profile: prop.active_profile,
      profile: prop.profile,
    },
    execution: {
      kill_switch_default: execution.kill_switch_default,
      flatten_on_disconnect: execution.flatten_on_disconnect,
    },
    mt5: {
      terminal_path: mt5.terminal_path,
      login: mt5.login,
      server: mt5.server,
      portable: mt5.portable,
    },
    ai: {
      enabled: ai.enabled,
      min_bars_to_train: ai.min_bars_to_train,
      retrain_every_bars: ai.retrain_every_bars,
      online_learning: ai.online_learning,
      confidence_threshold: ai.confidence_threshold,
    },
    default_language: data.default_language,
  };
}

// Some installers ship config files read-only, which
// makes renameSync() over an existing file fail with EPERM and
// writeFileSync() onto it fail the same way. Clearing the bit first is the
// fix; no-op on POSIX and when the target does not exist yet.
function clearReadonly(filePath) {
  try {
    if (process.platform === "win32" && fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {}
}

function writeSecureFile(filePath, content) {
  // Either the bytes fully reach the disk or this throws — callers decide
  // what is best-effort. (The old version swallowed write failures, so a
  // failed save could leave a stale *.tmp behind that a later rename
  // resurrected over fresh data: settings "saved" but lost on restart.)
  const tmp = filePath + ".tmp";
  try { fs.unlinkSync(tmp); } catch {} // a stale temp must never win
  clearReadonly(filePath);
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch {
    // fallback without chmod on Windows; still throws when the disk is bad
    try { fs.unlinkSync(tmp); } catch {}
    clearReadonly(filePath);
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(CONFIG), 0o700); } catch {}
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = CONFIG + ".tmp";
  try { fs.unlinkSync(tmp); } catch {} // a stale temp must never win
  writeSecureFile(tmp, text);
  clearReadonly(CONFIG);
  try { fs.renameSync(tmp, CONFIG); } catch { clearReadonly(CONFIG); fs.writeFileSync(CONFIG, text, "utf8"); }
  try { fs.chmodSync(CONFIG, 0o600); } catch {}
  // verify-after-write: a save that did not reach the disk must throw here
  // instead of reporting success and losing the settings on restart.
  if (fs.readFileSync(CONFIG, "utf8") !== text) {
    throw new Error("config save verification failed");
  }
  try {
    const statePath = path.join(DATA, "runtime-state.json");
    const bakPath = path.join(DATA, "runtime-state.bak.json");
    if (fs.existsSync(statePath)) {
      try { fs.copyFileSync(statePath, bakPath); } catch { /* */ }
      try { fs.chmodSync(bakPath, 0o600); } catch {}
    }
    const slimTmp = statePath + ".tmp";
    writeSecureFile(slimTmp, JSON.stringify(slimState(data), null, 2) + "\n");
    fs.renameSync(slimTmp, statePath);
    try { fs.chmodSync(statePath, 0o600); } catch {}
  } catch { /* overlay is best-effort */ }
  try {
    // Backup without secrets - never write mt5.password or otp secrets to backup
    const safeCopy = JSON.parse(JSON.stringify(data));
    if (safeCopy.mt5) delete safeCopy.mt5.password;
    if (safeCopy.license && safeCopy.license.otp) {
      safeCopy.license.otp = { configured: Boolean(safeCopy.license.otp.smtp_host) };
    }
    if (safeCopy.billing && safeCopy.billing.zarinpal) {
      safeCopy.billing.zarinpal = { sandbox: safeCopy.billing.zarinpal.sandbox };
    }
    const backupPath = path.join(DATA, "settings-backup.json");
    const backupTmp = backupPath + ".tmp";
    writeSecureFile(backupTmp, JSON.stringify(safeCopy, null, 2) + "\n");
    fs.renameSync(backupTmp, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch {}
  } catch { /* backup is best-effort */ }
  return data;
}

function ensureDirs() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA, 0o700); } catch {}
  for (const sub of ["exports", "uploads", "archive", "logs", "license", "cache"]) {
    const p = path.join(DATA, sub);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(p, 0o700); } catch {}
  }
}

module.exports = { load, save, ensureDirs, ensureConfig, FACTORY };
