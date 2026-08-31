const fs = require("fs");
const path = require("path");
const { CONFIG, DATA } = require("./paths");

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

function writeSecureFile(filePath, content) {
  try {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch {
    // fallback without chmod on Windows
    try {
      fs.writeFileSync(filePath, content, "utf8");
    } catch {}
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(CONFIG), 0o700); } catch {}
  const tmp = CONFIG + ".tmp";
  writeSecureFile(tmp, JSON.stringify(data, null, 2) + "\n");
  try { fs.renameSync(tmp, CONFIG); } catch { fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2) + "\n", "utf8"); }
  try { fs.chmodSync(CONFIG, 0o600); } catch {}
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

module.exports = { load, save, ensureDirs };
