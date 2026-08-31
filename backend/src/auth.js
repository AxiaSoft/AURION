"use strict";

const crypto = require("crypto");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { SECRET_FILE, DATA } = require("./paths");
const { load } = require("./config");
const db = require("./db");

const ROLES = ["owner", "admin", "trader", "viewer"];
const WRITE_ROLES = ["owner", "admin", "trader"];
const ADMIN_ROLES = ["owner", "admin"];

function secret() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DATA, 0o700); } catch {}
  if (process.env.AURION_JWT_SECRET) return process.env.AURION_JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) {
    try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
    return fs.readFileSync(SECRET_FILE, "utf8").trim();
  }
  const value = crypto.randomBytes(48).toString("hex");
  try {
    fs.writeFileSync(SECRET_FILE, value, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(SECRET_FILE, 0o600);
  } catch {
    fs.writeFileSync(SECRET_FILE, value, "utf8");
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function clientIp(req) {
  if (!req) return "";
  const xf = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "";
}

function clientUa(req) {
  return (req && req.headers && req.headers["user-agent"]) || "";
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    identity_type: user.identity_type || "",
    display_name: user.display_name || "",
    gmail: user.gmail || "",
    phone: user.phone || "",
    gmail_verified: Boolean(Number(user.gmail_verified)),
    phone_verified: Boolean(Number(user.phone_verified)),
    totp_enabled: Boolean(Number(user.totp_enabled)),
    timezone: user.timezone || "Asia/Tehran",
    language: user.language || "en",
    role: user.role || "trader",
    is_owner: Boolean(Number(user.is_owner)),
    disabled: Boolean(Number(user.disabled)),
    created: user.created,
    last_login: user.last_login || null,
  };
}

function allUsers() {
  return db.snapshot().users || [];
}

function findById(id) {
  return allUsers().find((u) => u.id === id) || null;
}

function findByUsername(username) {
  const key = String(username || "").toLowerCase();
  return allUsers().find((u) => String(u.username).toLowerCase() === key) || null;
}

function findByIdentity(raw) {
  const ident = raw && typeof raw === "object" ? raw : { value: raw };
  const value = String(ident.value || "").trim();
  if (!value) return null;
  const low = value.toLowerCase();
  return (
    allUsers().find((u) => {
      if (String(u.username || "").toLowerCase() === low) return true;
      if (String(u.gmail || "").toLowerCase() === low) return true;
      const phone = String(u.phone || "");
      return Boolean(phone) && (phone === value || phone === low);
    }) || null
  );
}

function hasOwner() {
  return allUsers().some((u) => Number(u.is_owner) === 1 && Number(u.disabled) !== 1);
}

function firstRun() {
  return allUsers().length === 0;
}

function needsOwner() {
  return !hasOwner();
}

function bootId() {
  return db.setting("boot_id", "");
}

function logAccess({ user, action, detail, req }) {
  try {
    db.exec(
      "INSERT INTO access_log(ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
      [
        nowIso(),
        user && user.id ? user.id : null,
        user && user.username ? user.username : "",
        String(action || ""),
        detail ? String(detail).slice(0, 400) : "",
        clientIp(req),
      ]
    );
  } catch {
    /* never block login on log failure */
  }
}

function rotateBoot() {
  const id = crypto.randomBytes(16).toString("hex");
  db.setSetting("boot_id", id);
  try {
    db.exec("UPDATE sessions SET revoked = 1, revoked_at = ? WHERE revoked = 0", [nowIso()]);
  } catch {
    /* first boot may have empty table */
  }
  logAccess({ action: "boot", detail: "session epoch rotated" });
  return id;
}

function createUser({
  username,
  password,
  language = "en",
  role = "trader",
  identity_type = "",
  is_owner = false,
  req = null,
  gmail = "",
  phone = "",
  gmail_verified = 0,
  phone_verified = 0,
  display_name = "",
}) {
  const name = String(username || "").trim();
  if (!name) {
    const err = new Error("identity");
    err.status = 400;
    throw err;
  }
  if (findByUsername(name)) {
    const err = new Error("username taken");
    err.status = 409;
    throw err;
  }
  if (!ROLES.includes(role)) {
    const err = new Error("role");
    err.status = 400;
    throw err;
  }
  if (is_owner && hasOwner()) {
    const err = new Error("owner_exists");
    err.status = 409;
    throw err;
  }
  if (is_owner) role = "owner";
  const mail = String(gmail || (identity_type === "gmail" ? name : "")).toLowerCase();
  const mob = String(phone || (identity_type === "phone" ? name : ""));
  const user = {
    id: uuid(),
    username: name,
    identity_type: identity_type || "",
    password_hash: bcrypt.hashSync(String(password), 12),
    language: language || "en",
    role,
    is_owner: is_owner ? 1 : 0,
    disabled: 0,
    created: nowIso(),
    updated: nowIso(),
    last_login: null,
  };
  db.exec(
    `INSERT INTO users
      (id, username, identity_type, password_hash, language, role, is_owner, disabled, created, updated, last_login,
       display_name, gmail, phone, gmail_verified, phone_verified, totp_secret, totp_enabled, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, '', 0, 'Asia/Tehran')`,
    [
      user.id,
      user.username,
      user.identity_type,
      user.password_hash,
      user.language,
      user.role,
      user.is_owner,
      user.created,
      user.updated,
      String(display_name || "").slice(0, 80),
      mail,
      mob,
      gmail_verified ? 1 : 0,
      phone_verified ? 1 : 0,
    ]
  );
  try {
    db.putUserSettings(user.id, { language: user.language || "en" });
  } catch { /* settings row is created on first save if this fails */ }
  logAccess({ user, action: is_owner ? "owner_created" : "user_created", detail: role, req });
  return publicUser(findById(user.id));
}

function authenticate(login, password) {
  const identity = require("./identity");
  const ident = identity.normalizeLogin(login);
  let user = ident ? findByIdentity(ident) : findByUsername(String(login || "").trim());
  if (!user) user = findByUsername(String(login || "").trim());
  if (!user || Number(user.disabled) === 1) return null;
  if (!user.password_hash) return null;
  if (!bcrypt.compareSync(String(password || ""), user.password_hash)) return null;
  return user;
}

function sessionHours() {
  const cfg = load();
  return Number((cfg.backend && cfg.backend.jwt_expires_hours) || 12);
}

function sign(user, req) {
  const hours = sessionHours();
  const jti = uuid();
  const issued = nowIso();
  const expDate = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const bid = bootId();
  db.exec(
    `INSERT INTO sessions(id, user_id, boot_id, issued, expires, revoked, revoked_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    [jti, user.id, bid, issued, expDate, clientIp(req), clientUa(req)]
  );
  db.exec("UPDATE users SET last_login = ?, updated = ? WHERE id = ?", [issued, issued, user.id]);
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      language: user.language,
      role: user.role,
      owner: Boolean(Number(user.is_owner)),
      jti,
      boot: bid,
    },
    secret(),
    { expiresIn: `${hours}h` }
  );
}

function verify(token) {
  return jwt.verify(token, secret());
}

function sessionOf(jti) {
  if (!jti) return null;
  return (db.snapshot().sessions || []).find((s) => s.id === jti) || null;
}

function tokenValid(payload) {
  if (!payload || !payload.sub || !payload.jti) return null;
  if (payload.boot !== bootId()) return null;
  const sess = sessionOf(payload.jti);
  if (!sess || Number(sess.revoked) === 1) return null;
  if (sess.expires && Date.parse(sess.expires) < Date.now()) return null;
  const user = findById(payload.sub);
  if (!user || Number(user.disabled) === 1) return null;
  return user;
}

function revokeSession(jti) {
  if (!jti) return;
  db.exec("UPDATE sessions SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0", [nowIso(), jti]);
}

function revokeUserSessions(userId) {
  db.exec("UPDATE sessions SET revoked = 1, revoked_at = ? WHERE user_id = ? AND revoked = 0", [nowIso(), userId]);
}

function updateLanguage(userId, language) {
  const user = findById(userId);
  if (!user) return null;
  db.exec("UPDATE users SET language = ?, updated = ? WHERE id = ?", [language, nowIso(), userId]);
  return publicUser(findById(userId));
}

function setDisabled(userId, disabled, actor, req) {
  const user = findById(userId);
  if (!user) return null;
  if (Number(user.is_owner) === 1) {
    const err = new Error("owner_protected");
    err.status = 403;
    throw err;
  }
  db.exec("UPDATE users SET disabled = ?, updated = ? WHERE id = ?", [disabled ? 1 : 0, nowIso(), userId]);
  if (disabled) revokeUserSessions(userId);
  logAccess({
    user: actor,
    action: disabled ? "user_disabled" : "user_enabled",
    detail: user.username,
    req,
  });
  return publicUser(findById(userId));
}

function setRole(userId, role, actor, req) {
  if (!ROLES.includes(role) || role === "owner") {
    const err = new Error("role");
    err.status = 400;
    throw err;
  }
  const user = findById(userId);
  if (!user) return null;
  if (Number(user.is_owner) === 1) {
    const err = new Error("owner_protected");
    err.status = 403;
    throw err;
  }
  db.exec("UPDATE users SET role = ?, updated = ? WHERE id = ?", [role, nowIso(), userId]);
  logAccess({ user: actor, action: "role_changed", detail: `${user.username} -> ${role}`, req });
  return publicUser(findById(userId));
}

function listUsers() {
  return allUsers().map(publicUser);
}

function listAccess(limit = 80) {
  return (db.snapshot().access_log || []).slice(0, Math.min(300, Number(limit) || 80));
}

function extractToken(req) {
  const header = (req.headers && req.headers.authorization) || "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    // strict: token must be non-empty and not contain spaces
    if (t && !/\s/.test(t) && t.length >= 20) return t;
  }
  return "";
}

function localOperator() {
  // Internal helper only - never returned by middleware anymore
  // Used for legacy license gate session creation via explicit code path
  return {
    id: "local",
    username: "local",
    identity_type: "local",
    display_name: "AURION",
    gmail: "",
    phone: "",
    gmail_verified: true,
    phone_verified: true,
    totp_enabled: true,
    timezone: "Asia/Tehran",
    language: "en",
    role: "owner",
    is_owner: true,
    disabled: false,
    created: null,
    last_login: null,
  };
}

function middleware(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "auth_required" });
  }
  try {
    const payload = verify(token);
    const user = tokenValid(payload);
    if (user) {
      req.user = publicUser(user);
      req.auth = payload;
      return next();
    }
    return res.status(401).json({ ok: false, error: "session_expired" });
  } catch (err) {
    const msg = String(err && err.message || "");
    if (msg.includes("expired")) {
      return res.status(401).json({ ok: false, error: "token_expired" });
    }
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

function optionalMiddleware(req, _res, next) {
  // For routes that allow anonymous but enrich if token present (e.g., health)
  const token = extractToken(req);
  if (token) {
    try {
      const payload = verify(token);
      const user = tokenValid(payload);
      if (user) {
        req.user = publicUser(user);
        req.auth = payload;
      }
    } catch {}
  }
  next();
}

function requireRole(...roles) {
  const allowed = roles.length ? roles : ADMIN_ROLES;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "auth" });
    if (req.user.is_owner) return next();
    if (allowed.includes(req.user.role)) return next();
    return res.status(403).json({ ok: false, error: "forbidden" });
  };
}

const totp = require("./totp");
const pendingTotp = new Map();

function issueTotpTicket(user) {
  const ticket = uuid();
  pendingTotp.set(ticket, { userId: user.id, exp: Date.now() + 5 * 60 * 1000 });
  return ticket;
}

function peekTotpTicket(ticket) {
  const row = pendingTotp.get(ticket);
  if (!row) return null;
  if (row.exp < Date.now()) {
    pendingTotp.delete(ticket);
    return null;
  }
  return findById(row.userId);
}

function consumeTotpTicket(ticket) {
  const user = peekTotpTicket(ticket);
  if (user) pendingTotp.delete(ticket);
  return user;
}

function updateProfile(userId, patch) {
  const user = findById(userId);
  if (!user) return null;
  const display = patch.display_name != null ? String(patch.display_name).slice(0, 80) : (user.display_name || "");
  const tz = patch.timezone ? String(patch.timezone).slice(0, 64) : (user.timezone || "Asia/Tehran");
  db.exec("UPDATE users SET display_name = ?, timezone = ?, updated = ? WHERE id = ?", [display, tz, nowIso(), userId]);
  return publicUser(findById(userId));
}

function attachChannel(userId, ident) {
  const user = findById(userId);
  if (!user) return null;
  if (ident.type === "gmail") {
    db.exec("UPDATE users SET gmail = ?, gmail_verified = 0, updated = ? WHERE id = ?", [ident.value, nowIso(), userId]);
  } else if (ident.type === "phone") {
    db.exec("UPDATE users SET phone = ?, phone_verified = 0, updated = ? WHERE id = ?", [ident.value, nowIso(), userId]);
  }
  return publicUser(findById(userId));
}

function markVerified(userId, type) {
  if (type === "gmail") db.exec("UPDATE users SET gmail_verified = 1, updated = ? WHERE id = ?", [nowIso(), userId]);
  if (type === "phone") db.exec("UPDATE users SET phone_verified = 1, updated = ? WHERE id = ?", [nowIso(), userId]);
  return publicUser(findById(userId));
}

function setPassword(userId, current, next) {
  const user = findById(userId);
  if (!user) return { ok: false, error: "missing" };
  if (!bcrypt.compareSync(String(current || ""), user.password_hash)) return { ok: false, error: "invalid" };
  if (String(next || "").length < 8) return { ok: false, error: "weak_password" };
  db.exec("UPDATE users SET password_hash = ?, updated = ? WHERE id = ?", [bcrypt.hashSync(String(next), 12), nowIso(), userId]);
  return { ok: true, user: publicUser(findById(userId)) };
}

function totpStart(userId) {
  const user = findById(userId);
  if (!user) return { ok: false, error: "missing" };
  const raw = totp.generateSecret();
  const wrapped = totp.wrapSecret(raw, secret());
  db.exec("UPDATE users SET totp_secret = ?, totp_enabled = 0, updated = ? WHERE id = ?", [wrapped, nowIso(), userId]);
  return {
    ok: true,
    secret: raw,
    otpauth: totp.otpauth(raw, user.username || "aurion"),
  };
}

function totpConfirm(userId, code) {
  const user = findById(userId);
  if (!user || !user.totp_secret) return { ok: false, error: "totp" };
  const plain = totp.unwrapSecret(user.totp_secret, secret());
  if (!totp.verify(plain, code)) return { ok: false, error: "totp" };
  db.exec("UPDATE users SET totp_enabled = 1, updated = ? WHERE id = ?", [nowIso(), userId]);
  return { ok: true, user: publicUser(findById(userId)) };
}

function totpDisable(userId, code) {
  const user = findById(userId);
  if (!user) return { ok: false, error: "missing" };
  if (Number(user.totp_enabled) === 1) {
    const plain = totp.unwrapSecret(user.totp_secret, secret());
    if (!totp.verify(plain, code)) return { ok: false, error: "totp" };
  }
  db.exec("UPDATE users SET totp_secret = '', totp_enabled = 0, updated = ? WHERE id = ?", [nowIso(), userId]);
  return { ok: true, user: publicUser(findById(userId)) };
}

function totpCheck(user, code) {
  if (!user || !user.totp_secret) return false;
  return totp.verify(totp.unwrapSecret(user.totp_secret, secret()), code);
}

function publicSettings(row) {
  const raw = row || {};
  let prefs = {};
  try { prefs = typeof raw.prefs === "string" ? JSON.parse(raw.prefs || "{}") : (raw.prefs || {}); } catch { prefs = {}; }
  return {
    language: raw.language || "en",
    timezone: raw.timezone || "Asia/Tehran",
    last_view: raw.last_view || "command",
    symbol: raw.symbol || "",
    timeframe: raw.timeframe || "M15",
    mt5_path: raw.mt5_path || "",
    mt5_login: raw.mt5_login || "",
    mt5_server: raw.mt5_server || "",
    prefs: prefs && typeof prefs === "object" ? prefs : {},
    updated: raw.updated || "",
  };
}

function getSettings(userId) {
  return publicSettings(db.getUserSettings(userId));
}

function saveSettings(userId, patch) {
  const cur = getSettings(userId);
  const next = {
    language: patch.language != null ? String(patch.language) : cur.language,
    timezone: patch.timezone != null ? String(patch.timezone) : cur.timezone,
    last_view: patch.last_view != null ? String(patch.last_view) : cur.last_view,
    symbol: patch.symbol != null ? String(patch.symbol) : cur.symbol,
    timeframe: patch.timeframe != null ? String(patch.timeframe) : cur.timeframe,
    mt5_path: patch.mt5_path != null ? String(patch.mt5_path) : cur.mt5_path,
    mt5_login: patch.mt5_login != null ? String(patch.mt5_login) : cur.mt5_login,
    mt5_server: patch.mt5_server != null ? String(patch.mt5_server) : cur.mt5_server,
    prefs: patch.prefs != null ? patch.prefs : cur.prefs,
  };
  if (patch.language && ["en", "fa", "ar"].includes(String(patch.language))) {
    db.exec("UPDATE users SET language = ?, updated = ? WHERE id = ?", [patch.language, nowIso(), userId]);
  }
  return publicSettings(db.putUserSettings(userId, next));
}

function boot() {
  db.init();
  rotateBoot();
}

module.exports = {
  ROLES,
  WRITE_ROLES,
  ADMIN_ROLES,
  boot,
  firstRun,
  needsOwner,
  hasOwner,
  createUser,
  authenticate,
  sign,
  verify,
  tokenValid,
  updateLanguage,
  findById,
  findByUsername,
  findByIdentity,
  publicUser,
  middleware,
  optionalMiddleware,
  requireRole,
  extractToken,
  revokeSession,
  revokeUserSessions,
  setDisabled,
  setRole,
  listUsers,
  listAccess,
  logAccess,
  secret,
  bootId,
  updateProfile,
  attachChannel,
  markVerified,
  setPassword,
  totpStart,
  totpConfirm,
  totpDisable,
  totpCheck,
  issueTotpTicket,
  peekTotpTicket,
  consumeTotpTicket,
  localOperator,
  getSettings,
  saveSettings,
  publicSettings,
};
