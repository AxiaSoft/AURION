"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { DATA } = require("./paths");
const { load } = require("./config");
const mailer = require("./mailer");

const FILE = path.join(DATA, "otp.json");
const BCRYPT_COST = 12;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_PER_HOUR = 5;

function readDb() {
  if (!fs.existsSync(FILE)) return { items: {}, attempts: {} };
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    if (raw.length > 1024 * 1024) return { items: {}, attempts: {} };
    const j = JSON.parse(raw);
    if (!j.items) j.items = {};
    if (!j.attempts) j.attempts = {};
    return j;
  } catch { return { items: {}, attempts: {} }; }
}

function writeDb(db) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA, 0o700); } catch {}
  const tmp = FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, FILE);
    try { fs.chmodSync(FILE, 0o600); } catch {}
  } catch {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
  }
}

function canIssue(identity) {
  const db = readDb();
  const now = Date.now();
  const key = String(identity);
  const arr = (db.attempts[key] || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= MAX_OTP_PER_HOUR) return false;
  return true;
}

function recordAttempt(identity) {
  const db = readDb();
  const key = String(identity);
  if (!db.attempts[key]) db.attempts[key] = [];
  db.attempts[key].push(Date.now());
  // cleanup old
  const now = Date.now();
  for (const k of Object.keys(db.attempts)) {
    db.attempts[k] = db.attempts[k].filter((t) => now - t < 3600 * 1000);
    if (db.attempts[k].length === 0) delete db.attempts[k];
  }
  // cleanup expired otps
  for (const k of Object.keys(db.items)) {
    if (now > Number(db.items[k].exp || 0)) delete db.items[k];
  }
  writeDb(db);
}

function issue(identity, purpose = "verify") {
  const idStr = String(identity || "").trim();
  if (!idStr) return { ok: false, error: "identity" };
  if (!canIssue(idStr)) {
    return { ok: false, error: "rate", channel: "blocked" };
  }
  const code = String(crypto.randomInt(100000, 999999));
  const db = readDb();
  const key = `${purpose}:${idStr}`;
  db.items[key] = {
    hash: bcrypt.hashSync(code, BCRYPT_COST),
    exp: Date.now() + CODE_TTL_MS,
    purpose,
    created: Date.now(),
  };
  // keep only latest 100 otps to prevent bloat
  const keys = Object.keys(db.items);
  if (keys.length > 100) {
    const sorted = keys.sort((a, b) => (db.items[a].created || 0) - (db.items[b].created || 0));
    for (let i = 0; i < sorted.length - 100; i++) delete db.items[sorted[i]];
  }
  writeDb(db);
  recordAttempt(idStr);
  const cfg = load();
  const otpCfg = (cfg.license && cfg.license.otp) || {};
  let channel = "log";
  if (otpCfg.smtp_host && otpCfg.smtp_user && idStr.includes("@")) channel = "smtp";
  if (idStr.startsWith("09") && otpCfg.sms_url) channel = "sms";
  // NEVER log code
  mailer.logLine(`[otp] ${purpose} identity=${idStr.slice(0, 3)}*** channel=${channel}`);
  if (idStr.includes("@")) {
    mailer.smtpSend({
      to: idStr,
      subject: "AURION verification code",
      text: `Your AURION code is ${code}. It expires in 10 minutes. Do not share.`,
    }).catch(() => {});
  } else if (idStr.startsWith("09")) {
    mailer.smsSend({
      to: idStr,
      text: `AURION code: ${code} (10 min)`,
    }).catch(() => {});
  }
  return {
    ok: true,
    channel,
    purpose,
    dev_hint: channel === "log" ? "check SMTP/SMS config - code sent via secure channel only" : "queued",
  };
}

function verify(identity, code, purpose = "verify") {
  const idStr = String(identity || "").trim();
  const codeStr = String(code || "").trim();
  if (!idStr || !codeStr) return false;
  if (!/^\d{6}$/.test(codeStr)) return false;
  const db = readDb();
  const key = `${purpose}:${idStr}`;
  const row = db.items[key] || db.items[idStr];
  if (!row) return false;
  if (Date.now() > Number(row.exp || 0)) {
    delete db.items[key];
    delete db.items[idStr];
    writeDb(db);
    return false;
  }
  const ok = bcrypt.compareSync(codeStr, row.hash);
  if (ok) {
    delete db.items[key];
    delete db.items[idStr];
    writeDb(db);
  }
  return ok;
}

module.exports = { issue, verify };
