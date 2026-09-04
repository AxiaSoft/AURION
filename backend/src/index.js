#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { load, ensureDirs } = require("./config");
const { WEB, LANG, DATA } = require("./paths");
const auth = require("./auth");
const engine = require("./engine");
const identity = require("./identity");
const otp = require("./otp");
const billing = require("./billing");
const notify = require("./notify");
const { pack, detect } = require("./i18n");
const { exportHistory } = require("./excel");
const hostctl = require("./host");
const owner = require("./owner");
const deskCfg = require("./config");
const db = require("./db");
const updater = require("./updater");

ensureDirs();
auth.boot();
const cfg = load();
try {
  const logsDir = path.join(DATA, "logs");
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(logsDir, 0o700); } catch {}
  const deskLog = path.join(logsDir, "desk.log");
  const appendDesk = (line) => {
    try {
      // redact sensitive patterns
      let out = String(line);
      out = out.replace(/code=\d{6}/gi, "code=***");
      out = out.replace(/password[=:]\s*\S+/gi, "password=***");
      out = out.replace(/Bearer\s+[A-Za-z0-9\-_\.]+/gi, "Bearer ***");
      fs.appendFileSync(deskLog, out.endsWith("\n") ? out : out + "\n");
      try { fs.chmodSync(deskLog, 0o600); } catch {}
    } catch { /* */ }
  };
  const wrap = (fn) => (...args) => {
    fn(...args);
    try {
      const safeArgs = args.map((a) => {
        if (typeof a === "string") {
          let s = a;
          s = s.replace(/code=\d{6}/gi, "code=***");
          s = s.replace(/\"password\"\s*:\s*\"[^\"]+\"/gi, '"password":"***"');
          return s;
        }
        try {
          const j = JSON.stringify(a);
          return j.replace(/code=\d{6}/gi, "code=***");
        } catch { return String(a); }
      });
      appendDesk(safeArgs.join(" "));
    } catch {}
  };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
  console.warn = wrap(console.warn.bind(console));
} catch { /* keep going without file tee */ }
const app = express();
app.disable("x-powered-by");
// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // CSP for API - very strict
  if (req.path.startsWith("/api/") || req.path.startsWith("/v1/")) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
const allowedOriginRegex = /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?|app:\/\/aurion|https:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Electron, curl, same-origin
    if (allowedOriginRegex.test(origin)) return cb(null, true);
    // For development, allow file:// is handled as no origin
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// AurionBridge WebRequest often sends no Content-Type. Parse raw JSON
// before express.json() so hello is never dropped as an empty body.
async function eaIngestProxy(req, res) {
  let payload = {};
  try {
    const strip = (s) => String(s || "").replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
    const parseLoose = (raw) => {
      const text = strip(raw);
      if (!text) return {};
      try { return JSON.parse(text); } catch { /* fall through */ }
      const startObj = text.indexOf("{");
      const startArr = text.indexOf("[");
      let start = -1;
      if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
      else start = Math.max(startObj, startArr);
      if (start < 0) throw new Error("invalid json");
      try { return JSON.parse(text.slice(start)); } catch { /* */ }
      const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (end > start) return JSON.parse(text.slice(start, end + 1));
      throw new Error("invalid json");
    };
    if (Buffer.isBuffer(req.body)) {
      payload = parseLoose(req.body.toString("utf8"));
    } else if (typeof req.body === "string") {
      payload = parseLoose(req.body);
    } else if (req.body && typeof req.body === "object") {
      payload = req.body;
    }
  } catch {
    return res.status(200).json({ ok: false, error: "invalid json", has_cmd: false });
  }
  const data = await engine.proxy("POST", "/v1/ea/ingest", payload);
  const status = data && data.error === "engine_offline" ? 503 : 200;
  res.status(status).json(data);
}
const ingestRaw = express.raw({ type: () => true, limit: "4mb" });
app.post("/v1/ea/ingest", ingestRaw, eaIngestProxy);
app.post("/api/ea/ingest", ingestRaw, eaIngestProxy);
app.get("/v1/ea/ingest", (_req, res) => {
  res.json({ ok: true, service: "ea-ingest-desk", hint: "AurionBridge POSTs JSON here" });
});

app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  req.lang = detect(req);
  next();
});

app.get("/api/health", async (_req, res) => {
  const engineUp = await engine.healthy();
  res.json({ ok: true, product: "AURION", backend: "online", engine: engineUp ? "online" : "offline" });
});

app.get("/api/meta", async (req, res) => {
  let buildDate = "";
  try {
    const fs = require("fs");
    const path = require("path");
    const stat = fs.statSync(path.join(__dirname, "..", "..", "config", "aurion.json"));
    buildDate = stat.mtime.toISOString().slice(0,10);
  } catch { buildDate = new Date().toISOString().slice(0,10); }
  res.json({
    ok: true,
    data: {
      first_run: auth.firstRun(),
      needs_owner: auth.needsOwner(),
      owner: owner.publicState(),
      database: db.info(),
      languages: ["en", "fa", "ar"],
      version: cfg.version || "1.0.0",
      build_date: buildDate,
      engine: await engine.healthy(),
    },
  });
});

app.get("/api/i18n/:lang", (req, res) => {
  res.json({ ok: true, data: pack(req.params.lang) });
});

const rateHits = new Map();
function rateLimited(req, bucket, limit, windowMs) {
  const xf = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
  const ip = String(xf ? String(xf).split(",")[0] : (req.socket && req.socket.remoteAddress) || "local").trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const keep = (rateHits.get(key) || []).filter((t) => now - t < windowMs);
  keep.push(now);
  rateHits.set(key, keep);
  return keep.length > limit;
}

function finishAuth(res, user, req, ident) {
  if (ident) engine.proxy("POST", "/v1/license/bind", { identity: ident.value }).catch(() => {});
  const token = auth.sign(user, req);
  return res.json({ ok: true, data: { token, user: auth.publicUser(user) } });
}

const pendingSignup = new Map();

app.post("/api/auth/exists", (req, res) => {
  if (rateLimited(req, "exists", 40, 60 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "rate" });
  }
  const raw = (req.body || {}).identity || (req.body || {}).username;
  const ident = identity.normalizeLogin(raw);
  if (!ident) return res.status(400).json({ ok: false, error: ident ? "identity" : "username" });
  const taken = Boolean(auth.findByIdentity(ident));
  res.json({ ok: true, data: { exists: taken, type: ident.type } });
});

app.post("/api/auth/register/start", async (req, res) => {
  if (rateLimited(req, "register", 10, 60 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "rate" });
  }
  const body = req.body || {};
  const password = String(body.password || "");
  const uname = identity.normalizeUsername(body.username);
  if (!uname) return res.status(400).json({ ok: false, error: "username" });
  if (password.length < 8) return res.status(400).json({ ok: false, error: "weak_password" });
  if (auth.findByUsername(uname.value)) {
    return res.status(409).json({ ok: false, error: "already_registered" });
  }
  const g = body.gmail ? identity.normalizeIdentity(body.gmail) : null;
  const p = body.phone ? identity.normalizeIdentity(body.phone) : null;
  if (body.gmail && (!g || g.type !== "gmail")) return res.status(400).json({ ok: false, error: "identity" });
  if (body.phone && (!p || p.type !== "phone")) return res.status(400).json({ ok: false, error: "identity" });
  if (!g && !p) return res.status(400).json({ ok: false, error: "need_channel" });
  if (g && auth.findByIdentity(g)) return res.status(409).json({ ok: false, error: "already_registered" });
  if (p && auth.findByIdentity(p)) return res.status(409).json({ ok: false, error: "already_registered" });
  const locked = owner.lockedOwnerGmail();
  if (locked && auth.needsOwner() && g && g.value !== locked && auth.firstRun()) {
    return res.status(403).json({ ok: false, error: "owner_mismatch" });
  }
  const channels = [];
  if (g) {
    const ex = await identity.proveExists(g);
    if (!ex.ok) return res.status(400).json({ ok: false, error: ex.error || "identity" });
    const sent = otp.issue(g.value, "signup");
    channels.push({ type: "gmail", to: identity.maskGmail(g.value), hint: sent.dev_hint || "" });
  }
  if (p) {
    const ex = await identity.proveExists(p);
    if (!ex.ok) return res.status(400).json({ ok: false, error: ex.error || "identity" });
    const sent = otp.issue(p.value, "signup");
    channels.push({ type: "phone", to: identity.maskPhone(p.value), hint: sent.dev_hint || "" });
  }
  const ticket = require("crypto").randomUUID();
  pendingSignup.set(ticket, {
    username: uname.value,
    password,
    language: body.language || req.lang || "en",
    display_name: String(body.display_name || "").slice(0, 80),
    gmail: g ? g.value : "",
    phone: p ? p.value : "",
    exp: Date.now() + 10 * 60 * 1000,
  });
  res.json({ ok: true, data: { ticket, need_otp: true, channels } });
});

app.post("/api/auth/register/confirm", (req, res) => {
  if (rateLimited(req, "register_ok", 20, 60 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "rate" });
  }
  const body = req.body || {};
  const row = pendingSignup.get(String(body.ticket || ""));
  if (!row || row.exp < Date.now()) return res.status(401).json({ ok: false, error: "otp" });
  if (row.gmail && !otp.verify(row.gmail, body.gmail_code, "signup")) {
    return res.status(401).json({ ok: false, error: "otp" });
  }
  if (row.phone && !otp.verify(row.phone, body.phone_code, "signup")) {
    return res.status(401).json({ ok: false, error: "otp" });
  }
  pendingSignup.delete(String(body.ticket || ""));
  if (auth.findByUsername(row.username)) {
    return res.status(409).json({ ok: false, error: "already_registered" });
  }
  const claiming = Boolean(row.gmail && owner.shouldClaimOwner({ type: "gmail", value: row.gmail }));
  try {
    const user = auth.createUser({
      username: row.username,
      password: row.password,
      language: row.language,
      role: claiming ? "owner" : "trader",
      identity_type: "username",
      is_owner: claiming,
      gmail: row.gmail,
      phone: row.phone,
      gmail_verified: row.gmail ? 1 : 0,
      phone_verified: row.phone ? 1 : 0,
      display_name: row.display_name,
      req,
    });
    const full = auth.findById(user.id);
    auth.logAccess({ user: full, action: claiming ? "owner_register" : "register", detail: row.username, req });
    const ident = row.gmail ? { type: "gmail", value: row.gmail } : (row.phone ? { type: "phone", value: row.phone } : null);
    return finishAuth(res, full, req, ident);
  } catch (err) {
    const taken = err.message === "username taken";
    const code = taken ? 409 : (err.status || 400);
    res.status(code).json({ ok: false, error: taken ? "already_registered" : (err.message || "identity") });
  }
});

app.post("/api/auth/register", async (req, res) => {
  if (req.body && req.body.ticket) return app._router.handle(req, res, () => {});
  req.url = "/api/auth/register/start";
  return app._router.handle(req, res, () => {});
});

app.post("/api/auth/setup", (req, res) => {
  const { username, password, language } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "need_fields" });
  const ident = identity.normalizeIdentity(username);
  if (!ident) return res.status(400).json({ ok: false, error: "identity" });
  if (String(password).length < 8) return res.status(400).json({ ok: false, error: "weak_password" });
  const claimingOwner = owner.shouldClaimOwner(ident);
  if (claimingOwner === false && auth.needsOwner() && ident.type !== "gmail") {
    return res.status(400).json({ ok: false, error: "owner_gmail" });
  }
  if (auth.needsOwner() && ident.type === "gmail" && owner.lockedOwnerGmail() && ident.value !== owner.lockedOwnerGmail()) {
    return res.status(403).json({ ok: false, error: "owner_mismatch" });
  }
  if (!auth.firstRun() && !auth.needsOwner() && !claimingOwner) {
    return res.status(409).json({ ok: false, error: "already_initialized" });
  }
  if (claimingOwner && ident.type !== "gmail") {
    return res.status(400).json({ ok: false, error: "owner_gmail" });
  }
  try {
    const user = auth.createUser({
      username: ident.value,
      password,
      language: language || req.lang,
      role: claimingOwner ? "owner" : "admin",
      identity_type: ident.type,
      is_owner: claimingOwner,
      req,
    });
    const token = auth.sign(user, req);
    engine.proxy("POST", "/v1/license/bind", { identity: ident.value }).catch(() => {});
    res.json({ ok: true, data: { token, user } });
  } catch (err) {
    const code = err.message === "username taken" ? 409 : (err.status || 400);
    res.status(code).json({ ok: false, error: err.message || "identity" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const lookup = String(username || "").trim();
  const user = auth.authenticate(lookup, password);
  if (!user) {
    auth.logAccess({ action: "login_fail", detail: lookup, req });
    return res.status(401).json({ ok: false, error: "invalid" });
  }
  if (Number(user.totp_enabled) === 1) {
    const ticket = auth.issueTotpTicket(user);
    auth.logAccess({ user, action: "login_totp_pending", req });
    return res.json({ ok: true, data: { need_totp: true, ticket } });
  }
  const ident = identity.normalizeLogin(lookup);
  auth.logAccess({ user, action: "login", req });
  return finishAuth(res, user, req, ident && ident.type !== "username" ? ident : null);
});

app.post("/api/auth/login/totp", (req, res) => {
  const ticket = String((req.body || {}).ticket || "");
  const code = String((req.body || {}).code || "");
  const user = auth.peekTotpTicket(ticket);
  if (!user) return res.status(401).json({ ok: false, error: "otp" });
  if (!auth.totpCheck(user, code)) return res.status(401).json({ ok: false, error: "otp" });
  auth.consumeTotpTicket(ticket);
  const ident = identity.normalizeIdentity(user.username);
  auth.logAccess({ user, action: "login", detail: "totp", req });
  return finishAuth(res, user, req, ident);
});

app.post("/api/auth/logout", auth.middleware, (req, res) => {
  auth.revokeSession(req.auth && req.auth.jti);
  auth.logAccess({ user: req.user, action: "logout", req });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Product-key gate — "the license key IS the login".
// The desk boots against these public routes; once the gate is passed
// (premium key OR explicit freemium continue) a session for the built-in
// owner account is issued. Username/password login is bypassed by the UI.
// ---------------------------------------------------------------------------
const gateHits = new Map();
function gateThrottle(req, limit, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  let b = gateHits.get(ip + ":" + req.path);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; gateHits.set(ip + ":" + req.path, b); }
  b.count += 1;
  return b.count <= limit;
}

app.get("/api/license", async (req, res) => {
  const data = await engine.proxy("GET", "/v1/license");
  const status = data && data.error === "engine_offline" ? 503 : 200;
  res.status(status).json(data);
});

app.post("/api/license/activate", async (req, res) => {
  if (!gateThrottle(req, 12, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "too_many_requests" });
  }
  const data = await engine.proxy("POST", "/v1/license/activate", req.body || {});
  const status = data && data.error === "engine_offline" ? 503 : 200;
  res.status(status).json(data);
});

app.post("/api/auth/license-session", async (req, res) => {
  if (!gateThrottle(req, 40, 60 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "too_many_requests" });
  }
  const lic = await engine.proxy("GET", "/v1/license");
  if (!lic || lic.error === "engine_offline") return res.status(503).json({ ok: false, error: "engine_offline" });
  const data = lic.data || {};
  const mode = String((req.body || {}).mode || "auto");
  if (!data.premium && mode !== "freemium") {
    // Freemium continues only after the user clicked "I don't have a key".
    return res.status(402).json({ ok: false, error: "key_required", license: data });
  }
  let user = auth.findByUsername("owner");
  if (!user) {
    try {
      user = auth.createUser({
        username: "owner",
        password: crypto.randomBytes(18).toString("hex"),
        language: req.lang || "en",
        role: "owner",
        is_owner: true,
        req,
      });
    } catch {
      user = auth.findByUsername("owner");
    }
  }
  if (!user) return res.status(500).json({ ok: false, error: "owner_unavailable" });
  const token = auth.sign(user, req);
  auth.logAccess({ user, action: "license_gate", detail: data.premium ? "premium" : "freemium", req });
  res.json({ ok: true, data: { token, user }, license: data });
});

app.post("/api/auth/otp/request", (req, res) => {
  const ident = identity.normalizeIdentity((req.body || {}).identity || (req.body || {}).username);
  if (!ident) return res.status(400).json({ ok: false, error: "identity" });
  const out = otp.issue(ident.value);
  res.json({ ok: true, data: { channel: out.channel, hint: out.dev_hint } });
});

app.post("/api/auth/otp/verify", (req, res) => {
  const ident = identity.normalizeIdentity((req.body || {}).identity || (req.body || {}).username);
  if (!ident) return res.status(400).json({ ok: false, error: "identity" });
  if (!otp.verify(ident.value, (req.body || {}).code)) return res.status(401).json({ ok: false, error: "otp" });
  res.json({ ok: true });
});

app.get("/api/auth/me", auth.middleware, (req, res) => {
  res.json({ ok: true, data: req.user });
});

app.post("/api/auth/language", auth.middleware, (req, res) => {
  const language = req.body && req.body.language;
  if (!["en", "fa", "ar"].includes(language)) return res.status(400).json({ ok: false, error: "language" });
  const user = auth.updateLanguage(req.user.id, language);
  const token = auth.sign({ ...user });
  res.json({ ok: true, data: { user, token } });
});

function passthrough(method, enginePath) {
  return async (req, res) => {
    const payload = method === "GET" ? undefined : req.body;
    let url = enginePath;
    if (method === "GET" && req.originalUrl.includes("?")) {
      url = enginePath + req.originalUrl.slice(req.originalUrl.indexOf("?"));
    } else if (method === "GET" && Object.keys(req.query || {}).length) {
      const q = new URLSearchParams(req.query).toString();
      url = `${enginePath}?${q}`;
    }
    const data = await engine.proxy(method, url, payload);
    const status = data && data.error === "engine_offline" ? 503 : 200;
    res.status(status).json(data);
  };
}

const guarded = express.Router();
guarded.use(auth.middleware);
guarded.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.path === "/auth/language") return next();
  if (req.path === "/users" || req.path.startsWith("/users/") || req.path === "/access") return next();
  if (req.path.startsWith("/profile") || req.path.startsWith("/billing") || req.path.startsWith("/notify")) return next();
  if (req.path.startsWith("/owner") || req.path.startsWith("/database") || req.path === "/settings/machine") return next();
  if (req.path === "/host/factory-reset" || req.path === "/host/restart" || req.path === "/config") {
    return auth.requireRole("owner", "admin")(req, res, next);
  }
  return auth.requireRole("owner", "admin", "trader")(req, res, next);
});

const ownerOnly = auth.requireRole("owner");

guarded.get("/users", ownerOnly, (_req, res) => {
  res.json({ ok: true, data: auth.listUsers() });
});
guarded.get("/access", ownerOnly, (req, res) => {
  res.json({ ok: true, data: auth.listAccess(Number(req.query.limit) || 80) });
});
guarded.post("/users", ownerOnly, (req, res) => {
  const { username, password, language, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "need_fields" });
  const ident = identity.normalizeIdentity(username);
  if (!ident) return res.status(400).json({ ok: false, error: "identity" });
  if (String(password).length < 8) return res.status(400).json({ ok: false, error: "weak_password" });
  const wantRole = role && role !== "owner" ? role : "trader";
  try {
    const user = auth.createUser({
      username: ident.value,
      password,
      language: language || req.user.language || "en",
      role: wantRole,
      identity_type: ident.type,
      is_owner: false,
      req,
    });
    res.json({ ok: true, data: user });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message || "identity" });
  }
});
guarded.post("/users/:id/disable", ownerOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: "self" });
  try {
    const user = auth.setDisabled(req.params.id, true, req.user, req);
    if (!user) return res.status(404).json({ ok: false, error: "missing" });
    res.json({ ok: true, data: user });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});
guarded.post("/users/:id/enable", ownerOnly, (req, res) => {
  try {
    const user = auth.setDisabled(req.params.id, false, req.user, req);
    if (!user) return res.status(404).json({ ok: false, error: "missing" });
    res.json({ ok: true, data: user });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});
guarded.post("/users/:id/role", ownerOnly, (req, res) => {
  try {
    const user = auth.setRole(req.params.id, String((req.body || {}).role || ""), req.user, req);
    if (!user) return res.status(404).json({ ok: false, error: "missing" });
    res.json({ ok: true, data: user });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

guarded.get("/profile", (req, res) => {
  const user = auth.findById(req.user.id);
  res.json({ ok: true, data: auth.publicUser(user) });
});
guarded.post("/profile", (req, res) => {
  const user = auth.updateProfile(req.user.id, req.body || {});
  res.json({ ok: true, data: user });
});
guarded.post("/profile/password", (req, res) => {
  const out = auth.setPassword(req.user.id, (req.body || {}).current, (req.body || {}).next);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});
guarded.post("/profile/channel", async (req, res) => {
  const ident = identity.normalizeIdentity((req.body || {}).identity);
  if (!ident) return res.status(400).json({ ok: false, error: "identity" });
  const exists = await identity.proveExists(ident);
  if (!exists.ok) return res.status(400).json({ ok: false, error: exists.error || "identity" });
  const user = auth.attachChannel(req.user.id, ident);
  res.json({ ok: true, data: user });
});
guarded.post("/profile/verify/request", async (req, res) => {
  const channel = String((req.body || {}).channel || "");
  const user = auth.findById(req.user.id);
  const target = channel === "phone" ? user.phone : user.gmail;
  if (!target) return res.status(400).json({ ok: false, error: "identity" });
  const exists = await identity.proveExists(target);
  if (!exists.ok) return res.status(400).json({ ok: false, error: exists.error || "identity" });
  const out = otp.issue(target, "verify");
  res.json({ ok: true, data: { channel: out.channel, hint: out.dev_hint } });
});
guarded.post("/profile/verify/confirm", (req, res) => {
  const channel = String((req.body || {}).channel || "");
  const user = auth.findById(req.user.id);
  const target = channel === "phone" ? user.phone : user.gmail;
  if (!target || !otp.verify(target, (req.body || {}).code, "verify")) {
    return res.status(401).json({ ok: false, error: "otp" });
  }
  res.json({ ok: true, data: auth.markVerified(req.user.id, channel === "phone" ? "phone" : "gmail") });
});
guarded.post("/profile/totp/start", (req, res) => {
  res.json(auth.totpStart(req.user.id));
});
guarded.post("/profile/totp/confirm", (req, res) => {
  const out = auth.totpConfirm(req.user.id, (req.body || {}).code);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});
guarded.post("/profile/totp/disable", (req, res) => {
  const out = auth.totpDisable(req.user.id, (req.body || {}).code);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});
guarded.get("/profile/settings", (req, res) => {
  res.json({ ok: true, data: auth.getSettings(req.user.id) });
});
guarded.post("/profile/settings", async (req, res) => {
  const body = req.body || {};
  const saved = auth.saveSettings(req.user.id, body);
  const canMachine = Boolean(req.user.is_owner || req.user.role === "admin");
  if (canMachine && (body.mt5_path != null || body.mt5_login != null || body.mt5_server != null)) {
    try {
      const live = deskCfg.load();
      live.mt5 = live.mt5 || {};
      if (body.mt5_path != null) live.mt5.terminal_path = String(body.mt5_path);
      if (body.mt5_login != null) live.mt5.login = Number(body.mt5_login) || 0;
      if (body.mt5_server != null) live.mt5.server = String(body.mt5_server);
      deskCfg.save(live);
      engine.proxy("POST", "/v1/config", {
        mt5: {
          terminal_path: live.mt5.terminal_path,
          login: live.mt5.login,
          server: live.mt5.server,
        },
      }).catch(() => {});
    } catch { /* account row is the source of truth */ }
  }
  res.json({ ok: true, data: saved, machine: canMachine });
});
guarded.get("/owner", (_req, res) => {
  res.json({ ok: true, data: owner.publicState() });
});
guarded.post("/owner/lock", (req, res) => {
  const actor = req.user;
  const allowed = Boolean(actor.is_owner || (auth.needsOwner() && (actor.role === "admin" || actor.role === "owner")));
  if (!allowed) return res.status(403).json({ ok: false, error: "forbidden" });
  try {
    const gmail = owner.lockOwnerGmail((req.body || {}).gmail);
    auth.logAccess({ user: actor, action: "owner_locked", detail: gmail, req });
    res.json({ ok: true, data: owner.publicState() });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message || "owner_gmail" });
  }
});
guarded.get("/database", (req, res) => {
  if (!req.user.is_owner && req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  res.json({ ok: true, data: db.info() });
});
guarded.post("/database", (req, res) => {
  if (!req.user.is_owner && req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const url = String((req.body || {}).url || "").trim();
  if (url && !/^postgres(ql)?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "db_url" });
  }
  const live = deskCfg.load();
  live.database = { ...(live.database || {}), driver: url ? "postgres" : "sqlite", url };
  deskCfg.save(live);
  auth.logAccess({ user: req.user, action: "database_url", detail: url ? "postgres" : "sqlite", req });
  res.json({ ok: true, data: { ...db.info(), saved: true, restart: true } });
});
guarded.get("/notify", (req, res) => {
  res.json({ ok: true, data: notify.list(req.user.id).map(notify.publicRow) });
});
guarded.post("/notify/:id/dismiss", (req, res) => {
  res.json(notify.dismiss(req.user.id, req.params.id));
});
guarded.get("/billing/plans", (req, res) => {
  res.json({
    ok: true,
    data: {
      plans: billing.catalog(req.user.language || req.lang),
      configured: billing.configured(),
      support: billing.support(),
    },
  });
});
guarded.get("/billing/history", (req, res) => {
  res.json({ ok: true, data: billing.history(req.user.id) });
});
guarded.post("/billing/checkout", async (req, res) => {
  const full = auth.findById(req.user.id);
  const pub = auth.publicUser(full);
  if (!pub.gmail_verified && !pub.phone_verified) {
    return res.status(400).json({ ok: false, error: "verify_first" });
  }
  const out = await billing.checkout(pub, String((req.body || {}).plan || ""), req);
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});
guarded.get("/license", passthrough("GET", "/v1/license"));
guarded.post("/license/activate", passthrough("POST", "/v1/license/activate"));
// Owner-only local mint proxy: never public, engine enforces 127.0.0.1 + private key presence
// Allows owner to mint m1,m3,m6,y1 and developer without CLI, but still local-only.
guarded.post("/admin/mint-key", async (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok:false, error:"owner_only" });
  const plan = String((req.body && req.body.plan) || "").toLowerCase();
  const note = String((req.body && (req.body.note || req.body.identity)) || req.user.username || "owner").slice(0,120);
  if (!["m1","m3","m6","y1","developer"].includes(plan)) {
    return res.status(400).json({ ok:false, error:"plan", need:["m1","m3","m6","y1","developer"] });
  }
  const data = await engine.proxy("POST", "/v1/license/issue", { plan, note });
  if (!data) return res.status(503).json({ ok:false, error:"engine_offline" });
  if (!data.ok) return res.status(400).json(data);
  auth.logAccess({ user: req.user, action: "mint_key", detail: `${plan}:${note}`, req });
  res.json(data);
});
guarded.get("/updates", passthrough("GET", "/v1/updates"));

guarded.get("/snapshot", async (req, res) => {
  const data = await engine.proxy("GET", "/v1/snapshot");
  if (data && data.data && data.data.license) {
    billing.warnExpiry(req.user, data.data.license);
  }
  const status = data && data.error === "engine_offline" ? 503 : 200;
  res.status(status).json(data);
});
guarded.get("/status", passthrough("GET", "/v1/status"));
guarded.get("/account", passthrough("GET", "/v1/account"));
guarded.get("/positions", passthrough("GET", "/v1/positions"));
guarded.get("/orders", passthrough("GET", "/v1/orders"));
guarded.get("/ticks", passthrough("GET", "/v1/ticks"));
guarded.get("/candles", passthrough("GET", "/v1/candles"));
guarded.get("/agents", passthrough("GET", "/v1/agents"));
guarded.get("/chart/signals", passthrough("GET", "/v1/chart/signals"));
guarded.post("/chart/signals", passthrough("POST", "/v1/chart/signals"));
guarded.get("/terminals", passthrough("GET", "/v1/terminals"));
guarded.post("/terminals/restart", passthrough("POST", "/v1/terminals/restart"));
guarded.get("/ai", passthrough("GET", "/v1/ai"));
guarded.post("/ai/train", passthrough("POST", "/v1/ai/train"));
guarded.post("/market", passthrough("POST", "/v1/market"));
guarded.post("/mt5/connect", async (req, res) => {
  const body = req.body || {};
  try {
    auth.saveSettings(req.user.id, {
      mt5_path: body.terminal_path,
      mt5_login: body.login,
      mt5_server: body.server,
    });
  } catch { /* keep going */ }
  try {
    const live = deskCfg.load();
    live.mt5 = live.mt5 || {};
    if (body.terminal_path != null) live.mt5.terminal_path = String(body.terminal_path);
    if (body.login != null) live.mt5.login = Number(body.login) || 0;
    if (body.server != null) live.mt5.server = String(body.server);
    if (body.password) live.mt5.password = String(body.password);
    deskCfg.save(live);
  } catch { /* account row already stored */ }
  const data = await engine.proxy("POST", "/v1/mt5/connect", body);
  if (data && data.error === "engine_offline") {
    return res.json({ ok: true, saved: true, engine: "offline", error: "engine_offline" });
  }
  res.json(data && typeof data === "object" ? { ...data, saved: true } : { ok: true, saved: true });
});
guarded.post("/mt5/disconnect", passthrough("POST", "/v1/mt5/disconnect"));
guarded.post("/order", passthrough("POST", "/v1/order"));
guarded.post("/flatten", passthrough("POST", "/v1/flatten"));
guarded.post("/kill", passthrough("POST", "/v1/kill"));
guarded.post("/safe", passthrough("POST", "/v1/safe"));
guarded.get("/strategies", passthrough("GET", "/v1/strategies"));
guarded.post("/strategies/apply", passthrough("POST", "/v1/strategies/apply"));
guarded.post("/strategies/toggle", passthrough("POST", "/v1/strategies/toggle"));
guarded.post("/auto", passthrough("POST", "/v1/auto"));
guarded.post("/strategies/upload", passthrough("POST", "/v1/strategies/upload"));
guarded.get("/strategies/source", passthrough("GET", "/v1/strategies/source"));
guarded.post("/strategies/update", passthrough("POST", "/v1/strategies/update"));
guarded.post("/strategies/delete", passthrough("POST", "/v1/strategies/delete"));
guarded.get("/strategies/template", passthrough("GET", "/v1/strategies/template"));
guarded.get("/prop", passthrough("GET", "/v1/prop"));
guarded.post("/prop", passthrough("POST", "/v1/prop"));
guarded.post("/prop/unlock", passthrough("POST", "/v1/prop/unlock"));
guarded.post("/prop/lock", passthrough("POST", "/v1/prop/lock"));
guarded.post("/prop/enable", passthrough("POST", "/v1/prop/enable"));
guarded.get("/history", passthrough("GET", "/v1/history"));
guarded.get("/equity", passthrough("GET", "/v1/equity"));
guarded.get("/logs", passthrough("GET", "/v1/logs"));
guarded.get("/host-logs", (req, res) => {
  const dir = path.join(DATA, "logs");
  const tail = (file) => {
    try {
      if (!fs.existsSync(file)) return "";
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - 160000);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString("utf8");
    } catch (err) {
      return "";
    }
  };
  res.json({
    ok: true,
    data: {
      engine: tail(path.join(dir, "engine.log")),
      desk: tail(path.join(dir, "desk.log")),
    },
  });
});
guarded.post("/history/reset", passthrough("POST", "/v1/history/reset"));
guarded.post("/backtest", passthrough("POST", "/v1/backtest"));
guarded.get("/backtest", passthrough("GET", "/v1/backtest"));
guarded.get("/config", passthrough("GET", "/v1/config"));
guarded.post("/config", passthrough("POST", "/v1/config"));
guarded.get("/telegram", passthrough("GET", "/v1/telegram"));
guarded.post("/telegram", passthrough("POST", "/v1/telegram"));
guarded.post("/telegram/pair", passthrough("POST", "/v1/telegram/pair"));
guarded.post("/telegram/test", passthrough("POST", "/v1/telegram/test"));
guarded.post("/telegram/unlink", passthrough("POST", "/v1/telegram/unlink"));
// Weekend / session awareness, the economic calendar and the symbol list the
// prop filter dropdown is built from.
guarded.get("/market/session", passthrough("GET", "/v1/market/session"));
guarded.get("/news", passthrough("GET", "/v1/news"));
guarded.get("/symbols", passthrough("GET", "/v1/symbols"));
// Owner-only Telegram control plane. The dashboard is a client of the bot; the
// token itself is provisioned in the source, never through the UI.
guarded.get("/admin/telegram", ownerOnly, passthrough("GET", "/v1/telegram/admin"));
guarded.post("/admin/telegram", ownerOnly, passthrough("POST", "/v1/telegram/admin"));
guarded.get("/robot", passthrough("GET", "/v1/robot"));
guarded.post("/persist", passthrough("POST", "/v1/persist"));
guarded.post("/host/restart", (_req, res) => {
  res.json({ ok: true, restarting: true });
  hostctl.scheduleRestart();
});
guarded.post("/host/factory-reset", async (req, res) => {
  const phrase = String((req.body && req.body.confirm) || "").trim().toUpperCase();
  if (phrase !== "FACTORY") {
    return res.status(400).json({ ok: false, error: "type FACTORY to confirm" });
  }
  let engineResult = { ok: true };
  try {
    engineResult = await engine.proxy("POST", "/v1/factory-reset", {});
  } catch (err) {
    engineResult = { ok: false, error: err.message };
  }
  hostctl.restoreFactoryConfig();
  hostctl.wipeDeskState();
  res.json({ ok: true, factory: true, engine: engineResult, restarting: true });
  hostctl.scheduleRestart();
});

// ---------------- Update System - Hidden Panel Integration ----------------
guarded.get("/system/update/settings", (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  res.json({ ok:true, data: updater.getSettings() });
});

guarded.post("/system/update/settings", (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  const body = req.body || {};
  const patch = {};
  // update_server_url is source-defined in config/aurion.json, not editable from dashboard
  if (body.auto_check_enabled !== undefined) patch.auto_check_enabled = !!body.auto_check_enabled;
  if (body.auto_check_interval_hours !== undefined) {
    const h = Number(body.auto_check_interval_hours);
    if (isNaN(h) || h < 1 || h > 168) return res.status(400).json({ ok:false, error:"invalid_interval" });
    patch.auto_check_interval_hours = h;
  }
  const saved = updater.saveSettings(patch);
  if (patch.auto_check_enabled !== undefined || patch.auto_check_interval_hours !== undefined) {
    updater.stopAutoChecker();
    updater.startAutoChecker();
  }
  res.json({ ok:true, data: saved, note: "update_server_url is source-defined and cannot be changed from dashboard" });
});

guarded.get("/system/update/state", (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  res.json({ ok:true, data: updater.getUpdateState(), settings: updater.getSettings() });
});

guarded.post("/system/update/check", async (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  const result = await updater.checkForUpdates();
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

guarded.post("/system/update/apply", async (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok:false, error:"owner_only" });
  const { update_id } = req.body || {};
  if (!update_id) return res.status(400).json({ ok:false, error:"need_update_id" });
  const result = await updater.applyUpdate(String(update_id));
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

guarded.get("/system/update/manifest", (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  const manifest = updater.collectLocalManifest();
  res.json({ ok:true, data: manifest });
});
// ---------------------------------------------------------------------------

guarded.post("/export/excel", async (req, res) => {
  const lang = req.body.lang || req.user.language || req.lang;
  const [history, equity, account, snapshot] = await Promise.all([
    engine.proxy("GET", "/v1/history?limit=2000"),
    engine.proxy("GET", "/v1/equity?limit=4000"),
    engine.proxy("GET", "/v1/account"),
    engine.proxy("GET", "/v1/snapshot"),
  ]);
  const trades = (history && history.data) || [];
  const eq = (equity && equity.data) || [];
  const acc = (account && account.data) || {};
  const metrics = ((snapshot && snapshot.data) || {}).prop || {};
  try {
    const file = await exportHistory({ lang, trades, equity: eq, account: acc, metrics });
    res.json({ ok: true, data: { filename: file.filename, url: `/api/exports/${file.filename}` } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Workbook download.  Behind auth.middleware, so it is only reachable with an
// Authorization header - which is why the desk fetches it as a blob instead of
// navigating an <a href> (a navigation cannot send that header and the token
// must never travel in the query string).
app.get("/api/exports/:name", auth.middleware, (req, res) => {
  const name = path.basename(String(req.params.name || ""));
  if (!/^[A-Za-z0-9._-]+\.xlsx$/i.test(name)) {
    return res.status(400).json({ ok: false, error: "bad_filename" });
  }
  const dest = path.join(DATA, "exports", name);
  if (!dest.startsWith(path.join(DATA, "exports") + path.sep) || !fs.existsSync(dest)) {
    return res.status(404).json({ ok: false, error: "missing" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.download(dest, name, (err) => {
    if (err && !res.headersSent) res.status(500).json({ ok: false, error: "send_failed" });
  });
});

app.use("/api", guarded);

app.use("/lang", express.static(LANG, { fallthrough: false }));
app.use(express.static(WEB, {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
  res.sendFile(path.join(WEB, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function tokenFromRequest(req) {
  // Only Bearer header, never query param (prevents log leakage)
  const header = (req.headers && req.headers.authorization) || "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t && !/\s/.test(t) && t.length >= 20) return t;
  }
  // For Electron preload, token can be sent as first message, not URL
  return "";
}

wss.on("connection", (socket, req) => {
  let authenticated = false;
  let user = null;
  let upstream = null;
  let authTimeout = null;

  const closeUnauth = () => {
    if (!authenticated) {
      try { socket.send(JSON.stringify({ type: "error", error: "auth_required" })); } catch {}
      try { socket.close(4401, "auth_required"); } catch {}
    }
  };

  // Require auth within 5 seconds via header or first message
  try {
    const token = tokenFromRequest(req);
    if (token) {
      const payload = auth.verify(token);
      const full = auth.tokenValid(payload);
      if (full) {
        user = auth.publicUser(full);
        authenticated = true;
      }
    }
  } catch {}

  if (authenticated) {
    socket.send(JSON.stringify({ type: "ready", user }));
    connectUpstream();
  } else {
    // Wait for auth message: {type:"auth", token:"..."}
    authTimeout = setTimeout(closeUnauth, 5000);
    socket.on("message", function authHandler(buf) {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg && msg.type === "auth" && msg.token) {
          const payload = auth.verify(String(msg.token));
          const full = auth.tokenValid(payload);
          if (full) {
            user = auth.publicUser(full);
            authenticated = true;
            clearTimeout(authTimeout);
            socket.off("message", authHandler);
            socket.send(JSON.stringify({ type: "ready", user }));
            connectUpstream();
            // re-emit any other handlers will be attached in connectUpstream
            return;
          }
        }
      } catch {}
      // If first message not auth, close
      if (!authenticated) {
        clearTimeout(authTimeout);
        closeUnauth();
      }
    });
  }

  function connectUpstream() {
    const { host, port } = engine.base();
    upstream = new (require("ws"))(`ws://${host}:${port}/v1/stream`);
    upstream.on("message", (buf) => {
      if (socket.readyState === 1) socket.send(buf.toString());
    });
    upstream.on("close", () => {
      if (socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: "engine", data: { state: "offline" } })); } catch { /* */ }
        socket.close();
      }
    });
    upstream.on("error", () => {
      try { socket.close(); } catch { /* */ }
    });
    socket.on("message", (buf) => {
      // Prevent auth message loop after authenticated
      try {
        const m = JSON.parse(buf.toString());
        if (m && m.type === "auth") return;
      } catch {}
      if (upstream && upstream.readyState === 1) upstream.send(buf.toString());
    });
    socket.on("close", () => {
      try { if (upstream) upstream.close(); } catch {}
    });
  }
});

const host = process.env.AURION_HOST || cfg.backend.host || "0.0.0.0";
const port = Number(process.env.AURION_PORT || cfg.backend.port || 8080);
// Start update auto-checker
try { updater.startAutoChecker(); } catch {}
server.listen(port, host, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `AURION desk on ${host}:${port}` }));
});
