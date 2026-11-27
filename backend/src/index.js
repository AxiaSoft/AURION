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
const supervisor = require("./engine-supervisor");
const support = require("./support-window");
const buildId = require("./build-id");
const buildSeq_ = require("./build-seq");
const buildStamp = require("./build-stamp");

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

/* Make a router forward a rejected promise to the error handler.
 *
 * Express 4 calls a route handler and ignores what it returns. For a
 * synchronous handler that is fine - a throw unwinds into Express's own
 * try/catch and becomes a 500. For an `async` handler it is not: the
 * throw becomes a rejected promise that Express never looks at, so
 *
 *   - the request is never answered and the desk waits forever, and
 *   - Node sees an unhandled rejection, and since Node 15 the default
 *     for that is to PRINT THE STACK AND EXIT.
 *
 * The second one is the serious half. This process serves index.html,
 * every /api route and the websocket, so one `undefined` dereferenced
 * in one handler does not fail one request - it takes the entire desk
 * down, mid-session, with every in-flight order request dropped. There
 * are twenty async handlers here and nineteen of them do their argument
 * checking before they reach their try/catch.
 *
 * So the promise is given somewhere to land. Handlers keep their own
 * try/catch and their own error shapes; this only catches what they
 * did not.
 *
 * Only functions are touched, which leaves `app.get("port")` (Express's
 * settings getter) and `app.use(router)` working as before, and 4-arity
 * functions are left alone because those are error handlers, whose
 * signature Express detects by length.
 */
function forwardAsyncErrors(target) {
  const wrap = (fn) => {
    if (typeof fn !== "function" || fn.length === 4) return fn;
    const wrapped = function (req, res, next) {
      let out;
      try {
        out = fn.apply(this, arguments);
      } catch (err) {
        next(err);
        return undefined;
      }
      if (out && typeof out.then === "function") {
        // `next` is only called on rejection; a handler that resolves
        // has already answered, and calling next() there would run the
        // 404 after it.
        Promise.resolve(out).catch(next);
      }
      return out;
    };
    // Express reads .length to tell a handler from an error handler, and
    // a wrapper is always 3, which is what a plain handler should be.
    Object.defineProperty(wrapped, "name", { value: fn.name || "handler" });
    return wrapped;
  };
  for (const verb of ["use", "all", "get", "post", "put", "patch", "delete", "head", "options"]) {
    const original = target[verb];
    if (typeof original !== "function") continue;
    target[verb] = function (...args) {
      return original.apply(this, args.map(wrap));
    };
  }
  return target;
}
forwardAsyncErrors(app);

// ---------------------------------------------------------------------------
// Deployment overrides.
//
// The desk is a *local* application: by default nothing may frame it and only
// loopback origins may call it. Running it behind a reverse proxy (a remote
// VPS, a preview/tunnel host, a container) needs both of those relaxed for
// exactly the hosts the operator names — never implicitly.
//
//   AURION_ALLOWED_ORIGINS  comma-separated extra CORS origins
//                           ("https://desk.example.com"), or "*" for any.
//   AURION_FRAME_ANCESTORS  comma-separated hosts allowed to frame the desk,
//                           or "*" for any. Unset keeps X-Frame-Options: DENY.
// ---------------------------------------------------------------------------
const envList = (name) => String(process.env[name] || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const extraOrigins = envList("AURION_ALLOWED_ORIGINS");
const originWildcard = extraOrigins.includes("*");
const frameAncestors = envList("AURION_FRAME_ANCESTORS");

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (frameAncestors.length === 0) {
    res.setHeader("X-Frame-Options", "DENY");
  }
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // CSP for API - very strict
  if (req.path.startsWith("/api/") || req.path.startsWith("/v1/")) {
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  } else if (frameAncestors.length) {
    const sources = frameAncestors.includes("*") ? "*" : frameAncestors.join(" ");
    res.setHeader("Content-Security-Policy", `frame-ancestors ${sources}`);
  }
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
const allowedOriginRegex = /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?|app:\/\/aurion|https:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, same-origin
    if (allowedOriginRegex.test(origin)) return cb(null, true);
    if (originWildcard || extraOrigins.includes(origin)) return cb(null, true);
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

/* Is the DESK up? Nothing else.
 *
 * /api/health answers a different question - it asks the engine for
 * its build fingerprint, and waits up to five seconds for it. The
 * window used that as its "is the desk running" probe with a two
 * second client timeout, so any moment the engine was slow (a
 * backtest, candles being saved, a MetaTrader call waiting on a
 * terminal that is going away) the window concluded the desk was not
 * there and started a SECOND one. That one could not bind port 8080,
 * the launcher exited 1, and the trader was shown "port 8080 is held
 * by another program" - the other program being AURION.
 *
 * So: one line, no awaits, no dependencies. If this answers, the
 * desk's event loop is turning and the desk is up.
 */
app.get("/api/alive", (_req, res) => {
  res.json({ ok: true, product: "AURION", role: "desk", pid: process.pid });
});

app.get("/api/health", async (_req, res) => {
  /* Also: is the engine running the code that is on this disk? An update
     copies files under a live process, and Python keeps the modules it
     already imported - so an installation could be new and its behaviour
     old, with nothing anywhere saying so. A customer spent days on a bug
     that had already been fixed because of it. build.restart_required is
     true only when the engine answered with a fingerprint and it differs
     from the files as they are now; silence is never a mismatch. */
  const build = await engine.buildState();
  res.json({
    ok: true,
    product: "AURION",
    backend: "online",
    /* online / busy / offline.
       "busy" is an engine that answered seconds ago and is quiet
       right now - a backtest, a few thousand candles being saved, a
       MetaTrader call that is taking its time. Reported as offline,
       it made the desk's engine light flash on and off against a
       process that never went anywhere; that was the complaint. See
       engine.liveness(). */
    engine: build.liveness || (build.online ? "online" : "offline"),
    build,
    /* What the desk is doing about an engine that is not answering.
       Without this the screen can only say "offline", which reads as
       "give up", when in fact it is being started again a few seconds
       from now. */
    supervisor: supervisor.state(),
  });
});

/* ------------------------------------------------------------------ *
 * Shutting AURION down, and meaning it.
 *
 * Closing the window used to close the WINDOW. The desk kept serving on
 * 8080 and the engine kept running, holding its MetaTrader connection,
 * its timers and its port - so "I closed AURION" and "AURION is not
 * running" were two different statements, and the next start met a port
 * that was already taken by the product the user believed they had
 * quit.
 *
 * This is the one place that ends it, in the one order that is safe:
 *
 *   1. the engine is asked to persist and stop, and is WAITED for - it
 *      holds settings that are only written on the way out;
 *   2. the supervisor is stopped first of all, or it would helpfully
 *      start a fresh engine two seconds after we stopped this one;
 *   3. only then does the desk's own server go.
 *
 * Idempotent: a second call while the first is running joins it rather
 * than starting a second teardown.
 * ------------------------------------------------------------------ */
let shuttingDown = null;

function shutdownAurion(reason, opts) {
  if (shuttingDown) return shuttingDown;
  const why = String(reason || "requested");
  const hard = Boolean(opts && opts.hard);
  shuttingDown = (async () => {
    const steps = [];
    /* First of all: keep the promise to come back.
     *
     * If an update has asked for a relaunch, the script that reopens
     * AURION is sitting on a short timer in this process - and this
     * function ends in process.exit, which discards timers without
     * running them. That is the whole of "it closes and never opens
     * again": the shutdown raced the promise and won. Started here,
     * before anything is stopped, so it is already running by the
     * time the engine and the desk go. See host.flushPendingRestart. */
    try {
      if (hostctl.flushPendingRestart()) steps.push("relaunch script started");
    } catch { /* never block a shutdown over this */ }
    /* Before anything else: nothing may restart what we are stopping. */
    try { supervisor.stop(); steps.push("supervisor stopped"); } catch { /* */ }
    try {
      const halt = await supervisor.stopEngine({
        /* A kill is not allowed to be slow. A requested shutdown is,
           because that is the one that saves the settings. */
        budgetMs: hard ? 6000 : 25000,
        persist: !hard,
      });
      steps.push(...(halt.steps || []));
      steps.push(halt.stopped ? "engine stopped" : (halt.gone ? "no engine to stop" : "engine would not stop"));
    } catch (err) {
      steps.push("stopping the engine failed: " + (err && err.message ? err.message : "unknown"));
    }
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: `AURION shutting down (${why}): ${steps.join("; ")}`,
    }));
    /* The desk last, so the caller could be told what happened. */
    try { server.close(); } catch { /* */ }
    setTimeout(() => process.exit(0), hard ? 150 : 400).unref?.();
    return { ok: true, reason: why, steps };
  })();
  return shuttingDown;
}

/* Asked by the window when the trader confirms "shut AURION down", and
 * by anything else that wants the product stopped rather than hidden.
 * Answers FIRST and shuts down behind the reply: a caller that is told
 * nothing cannot tell a shutdown from a hang. */
app.post("/api/shutdown", (req, res) => {
  /* From this machine only.
   *
   * The desk listens on 0.0.0.0 so a trader can reach it from a phone
   * on the same network, which makes "stop the whole product" the one
   * endpoint that must not be reachable from there. The caller is the
   * window that started AURION, and it is always local. */
  const from = String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (from !== "127.0.0.1" && from !== "::1" && from !== "localhost") {
    return res.status(403).json({ ok: false, error: "local_only" });
  }
  const body = req.body || {};
  const reason = String(body.reason || "requested");
  const hard = Boolean(body.hard);
  res.json({ ok: true, product: "AURION", stopping: true, reason });
  setTimeout(() => { shutdownAurion(reason, { hard }); }, 10);
});

/* The window went away without asking.
 *
 * Task Manager's "End task", taskkill /F, a crash - none of them give
 * the window a chance to run any code at all, and the trader is left
 * with a desk and an engine still running behind a window that no
 * longer exists. Nothing in the product noticed, because nothing was
 * looking.
 *
 * So the desk watches whoever launched it. AURION_OWNER_PID is set by
 * the window when it starts the product; signal 0 does not touch the
 * process, it only asks the operating system whether that pid is still
 * there. When it is not, AURION shuts itself down - the hard way, since
 * the person has already said what they want by killing it.
 *
 * Deliberately not on by default: a desk started from a terminal has no
 * owner and must not invent one.
 */
function watchOwner(pid, everyMs) {
  const owner = Number(pid);
  if (!Number.isFinite(owner) || owner <= 0) return null;
  const timer = setInterval(() => {
    let gone = false;
    try { process.kill(owner, 0); } catch (err) { gone = !err || err.code !== "EPERM"; }
    if (!gone) return;
    clearInterval(timer);
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      msg: `the AURION window (pid ${owner}) is gone - shutting the desk and the engine down with it`,
    }));
    shutdownAurion("owner_gone", { hard: true });
  }, Math.max(500, Number(everyMs) || 2000));
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/* The desk's own terminate. A console AURION is stopped with Ctrl-C or
 * by a service manager, and that must take the engine with it too. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  try { process.on(signal, () => { shutdownAurion(signal.toLowerCase(), { hard: signal === "SIGHUP" }); }); } catch { /* */ }
}

app.get("/api/meta", async (req, res) => {
  /* A desk being opened is a person asking for AURION to work.
   *
   * Reported as "when I reset or refresh, the engine never comes up
   * again, and neither does the app". The supervisor gives the engine
   * five tries and then stops; the only thing that ever un-stopped it
   * was the engine answering by itself, which nothing was left to
   * bring about. So the state outlived every reload - the page was
   * never what was broken - and the one cure was closing the whole
   * product, which is the very thing the supervisor exists to avoid.
   *
   * This is the first call the desk makes when it loads. Reloading
   * now means what the trader plainly intends it to mean: try again.
   * Guarded on gave_up so that an ordinary page load cannot keep
   * resetting the miss counter and hold off a restart that is due. */
  try {
    if (supervisor.state().gave_up) supervisor.resume("a desk page opening");
  } catch { /* never fail /api/meta over this */ }
  /* The build stamp: which build is this, as a fact about the build.
   *
   * First choice is what the build itself says - the date and the
   * daily number the release carries, recorded when it was installed
   * or when a check confirmed this machine was already on it. That is
   * the same answer on every installation of the same build, which is
   * the whole point of an identifier a trader reads back to support.
   *
   * Everything below it is a local guess, kept for the case where
   * there is no stamp yet - an installation that has never reached
   * GitHub. The date is this machine's config mtime and the number is
   * counted off the fingerprints this machine has seen today, so two
   * desks on the same build can disagree. That disagreement was the
   * reported fault; it now only survives where there is no better
   * answer at all. See build-stamp.js. */
  let buildDate = "";
  let buildSeq = "01";
  let stamped = null;
  try { stamped = buildStamp.current(); } catch { stamped = null; }
  if (stamped) {
    buildDate = stamped.date;
    buildSeq = stamped.seq;
  } else {
    try {
      const fs = require("fs");
      const path = require("path");
      const stat = fs.statSync(path.join(__dirname, "..", "..", "config", "aurion.json"));
      buildDate = stat.mtime.toISOString().slice(0,10);
    } catch { buildDate = new Date().toISOString().slice(0,10); }
    try { buildSeq = buildSeq_.seqFor(buildDate, buildId.diskBuildId()); } catch { /* 01 */ }
  }
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
      build_seq: buildSeq,
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
    // 503 means "gone". A request that merely outran its timeout while
    // the engine kept answering health checks is 504, and the desk reads
    // the difference rather than painting the engine dead.
    const status = data && data.error === "engine_offline" ? 503 : data && data.error === "engine_busy" ? 504 : 200;
    res.status(status).json(data);
  };
}

const guarded = express.Router();
// Same reason as the app itself - see forwardAsyncErrors. Most of the
// async handlers in this file hang off this router.
forwardAsyncErrors(guarded);
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

/* End of support.
 *
 * Five days after a newer VERSION is published - the builder's number,
 * not merely an available update - this desk stops serving
 * anything but the way out of that situation. The policy itself lives in
 * support-window.js; what belongs here is the one side effect it must
 * not own - stopping the robot.
 *
 * A locked screen does not stop the engine. It is a separate process
 * with its own loop, and leaving it opening positions behind a desk
 * nobody can read would be the worst of both: no supervision and no
 * ability to intervene. So the first blocked request also disarms
 * auto-trading. Once, per process, best effort, never blocking the
 * response. */
let tradingHaltedForSupport = false;
function haltTradingForSupport() {
  if (tradingHaltedForSupport) return;
  tradingHaltedForSupport = true;
  engine.proxy("POST", "/v1/auto", { enabled: false }).catch(() => { /* retried next boot */ });
}
guarded.use(support.middleware({ onExpired: haltTradingForSupport }));

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
  let machineSaved = true;
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
    } catch { machineSaved = false; /* account row is the source of truth */ }
  }
  res.json({ ok: true, data: saved, machine: canMachine, machine_saved: machineSaved });
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
  /* The countdown rides along with the poll the desk already makes
     every twelve seconds, rather than costing a request of its own.
     res.locals.support was computed by the gate a moment ago. */
  if (data && typeof data === "object") data.support = res.locals.support || support.status();
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
guarded.post("/danger", passthrough("POST", "/v1/danger"));
guarded.post("/risk_free", passthrough("POST", "/v1/risk_free"));
guarded.post("/money", passthrough("POST", "/v1/money"));
guarded.post("/timezone", passthrough("POST", "/v1/timezone"));
guarded.post("/strategies/upload", passthrough("POST", "/v1/strategies/upload"));
guarded.get("/strategies/source", passthrough("GET", "/v1/strategies/source"));
guarded.post("/strategies/update", passthrough("POST", "/v1/strategies/update"));
guarded.post("/strategies/delete", passthrough("POST", "/v1/strategies/delete"));
guarded.get("/strategies/template", passthrough("GET", "/v1/strategies/template"));
// The MetaTrader experts: which ones this build ships, which version each
// attached chart is running, and the source itself so the desk can hand the
// user the file to compile instead of telling them to go and find it.
guarded.get("/experts", passthrough("GET", "/v1/experts"));
guarded.get("/experts/source", passthrough("GET", "/v1/experts/source"));
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
guarded.post("/backtest/cancel", passthrough("POST", "/v1/backtest/cancel"));
guarded.get("/backtest", passthrough("GET", "/v1/backtest"));
guarded.get("/analysis", passthrough("GET", "/v1/analysis"));
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
// The Telegram control plane is deliberately NOT proxied here. The dashboard is
// a client of the bot only; admin lives in admin/telegram-panel/ and talks to
// the engine's local-only /v1/telegram/admin directly.
guarded.get("/robot", passthrough("GET", "/v1/robot"));
guarded.post("/persist", passthrough("POST", "/v1/persist"));
/* Bring the product back.
 *
 * Two different things, and the caller says which. `full` closes
 * AURION completely - engine, desk and window - and opens it from
 * nothing; anything else stops the engine and leaves the window
 * standing.
 *
 * An update must use `full`, and this is where that used to be lost:
 * the update's "Restart now" button posted here, this handler called
 * scheduleRestart() with no argument, and scheduleRestart defaults to
 * the weak one. So an update applied this way left the old desk
 * process, the old shell assemblies and the old service worker
 * running - which is the state the whole relaunch exists to avoid,
 * and which the trader sees as "the window never closed". */
guarded.post("/host/restart", (req, res) => {
  const full = Boolean((req.body || {}).full);
  res.json({ ok: true, restarting: true, full });
  if (full) hostctl.scheduleRelaunch();
  else hostctl.scheduleRestart();
});

/* Replace the engine process without restarting the product.
 *
 * For the one state that had no proportionate cure: an update has
 * written new files and the engine that imported the old ones is still
 * running and still healthy. The supervisor only starts an engine that
 * is down, so it leaves this one alone - correctly - and the desk was
 * left telling the trader to restart everything, or to close the
 * window and open it again, because of one process.
 *
 * Owner-only, like every other route that can stop something. It can
 * take tens of seconds: the engine persists its settings on the way
 * out and the port has to be observed going quiet before a new process
 * is started on top of it. */
guarded.post("/system/engine/replace", async (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok: false, error: "owner_only" });
  let result;
  try {
    result = await supervisor.replaceEngine({ budgetMs: 45000 });
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err || "replace_failed") };
  }
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
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
  /* No GitHub token is accepted here, by design.
     
     The panel used to offer one to raise the hourly ceiling. It is not
     needed - a check costs three requests cold and none when nothing
     has moved, an install costs none at all - and accepting a secret
     over the dashboard means storing it, guarding it, and never
     echoing it, for no benefit. A token that reaches this route is
     dropped on the floor rather than saved; the only places one is
     read from now are the environment and the operator's own config,
     neither of which the dashboard can write. */
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

/* Polled by the install screen while the apply above is still in
   flight, so the bar it draws is the real count of files written and
   not an animation standing in for one. Cheap by construction: it
   reads an object this process already holds. */
guarded.get("/system/update/progress", (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") return res.status(403).json({ ok:false, error:"forbidden" });
  res.json({ ok:true, data: updater.getApplyProgress() });
});

guarded.post("/system/update/apply", async (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok:false, error:"owner_only" });
  const { update_id } = req.body || {};
  if (!update_id) return res.status(400).json({ ok:false, error:"need_update_id" });
  /* The restart is part of the install, not a separate favour: writing
     new files under a running engine changes nothing until the process
     that imported the old ones goes away. A caller may opt out, and the
     answer always says which of the two happened. */
  const result = await updater.applyUpdate(String(update_id), "", {
    restart: (req.body || {}).restart !== false,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/* Stop an install or repair that is already running.
 *
 * Asked for about the repair, which writes every shipped file rather
 * than the few an update differs by: without this the only way out
 * was to kill the desk part way through, leaving the half-written
 * installation a repair exists to cure. It stops at the next file
 * boundary and puts back everything already written - see
 * updater.cancelApply. */
guarded.post("/system/update/cancel", (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok:false, error:"owner_only" });
  const result = updater.cancelApply();
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

/* Write every shipped file again, matching or not, then restart.
 *
 * For the installation whose files hash correctly and whose behaviour is
 * still wrong - the state in which the ordinary update truthfully and
 * uselessly answers "already up to date". Owner-only and never
 * automatic. */
guarded.post("/system/update/repair", async (req, res) => {
  if (req.user.role !== "owner") return res.status(403).json({ ok:false, error:"owner_only" });
  const result = await updater.repairInstall({ restart: (req.body || {}).restart !== false });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

/* How long this build has left, and why.
 *
 * Open to every role on purpose: the lock falls on the trader as much
 * as on the owner, and a trader who cannot ask why their desk stopped
 * is left with a screen that looks broken. It reads one small file. */
guarded.get("/system/support", (_req, res) => {
  res.json({ ok: true, data: support.status() });
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

/* An /api path nobody claimed, answered in JSON.
 *
 * Express ends an unmatched request with its own HTML page, and the
 * desk's fetch wrapper can only report that as "bad_response" - which
 * is what a trader saw when they pressed Stop on a backtest: a server
 * process started before the update, serving the NEW page out of the
 * folder on disk while routing with the OLD table in memory. The page
 * had the button; the server had never heard of the endpoint.
 *
 * The honest answer to that is not a generic error. It is: this
 * server is older than the page it just served you, and restarting
 * AURION fixes it. So the body carries a code the desk translates,
 * the path that was asked for, and the build on disk - and anything
 * genuinely unknown lands here too, in JSON, rather than as an HTML
 * page a fetch cannot read. */
app.use("/api", (req, res) => {
  let build = "";
  try { build = buildId.diskBuildId(); } catch { /* not fatal */ }
  res.status(404).json({
    ok: false,
    code: "unknown_endpoint",
    error: `unknown endpoint ${req.method} /api${req.path}`,
    endpoint: `${req.method} /api${req.path}`,
    build,
  });
});

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

/* The last word on a request that went wrong.
 *
 * Registered after every route, with four arguments, which is how
 * Express recognises an error handler. Anything a handler threw - or,
 * via forwardAsyncErrors above, anything an async handler rejected with
 * - arrives here instead of killing the process or hanging the desk.
 *
 * The body is the shape the desk's fetch wrapper already understands,
 * so an unexpected failure reads as a failure rather than as
 * "bad_response". The message is included because this server is run by
 * the same person who would be reading the log, on their own machine;
 * there is no third party to leak it to.
 */
app.use((err, req, res, _next) => {
  const ts = new Date().toISOString();
  try {
    console.error(JSON.stringify({
      ts,
      msg: `unhandled error in ${req.method} ${req.originalUrl}`,
      error: String((err && err.stack) || err),
    }));
  } catch { /* logging must not throw here of all places */ }
  if (res.headersSent) {
    // Something was already sent, so the only honest thing left is to
    // stop writing. Leaving the socket open would hang the desk.
    try { res.end(); } catch { /* already gone */ }
    return;
  }
  res.status(500).json({
    ok: false,
    code: "server_error",
    error: String((err && err.message) || err || "server error"),
  });
});

/* A desk that is still up is worth more than a clean exit.
 *
 * These are the two ways Node ends a process on its own. Everything
 * above is meant to stop either from firing - the error handler catches
 * what routes throw - but the websocket handlers, the engine
 * supervisor, the updater and every timer in this file live outside
 * Express and have no such net under them.
 *
 * The default behaviour for both is to exit. For a server whose death
 * blanks the trader's screen while positions are open, that is the
 * wrong trade: a logged fault with the desk still serving is strictly
 * better than a silent process that is simply gone. The log line is
 * what makes the fault findable afterwards.
 *
 * uncaughtException is deliberately NOT turned into a clean shutdown.
 * Node's own guidance is that state may be inconsistent after one, and
 * that is true - but the state most likely to be inconsistent here is
 * one request's, while the state certainly lost by exiting is the
 * trader's whole session.
 */
for (const signal of ["unhandledRejection", "uncaughtException"]) {
  process.on(signal, (err) => {
    try {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        msg: `${signal} - the desk is staying up; this is a bug, please report it`,
        error: String((err && err.stack) || err),
      }));
    } catch { /* nothing left to do */ }
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function tokenFromRequest(req) {
  // Only Bearer header, never query param (prevents log leakage)
  const header = (req.headers && req.headers.authorization) || "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t && !/\s/.test(t) && t.length >= 20) return t;
  }
  // The token can be sent as the first message, not in the URL
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
    /* The header's engine light is fed from here.
     *
     * This socket is a proxy of the engine's own stream, so this
     * process learns that the engine has gone the instant the TCP
     * connection drops - seconds before any poll would. It was
     * already telling the browser on a clean close; it was silent on
     * the two cases that matter more. A refused connection (the
     * engine is not listening at all) closed the browser's socket
     * with no explanation, and a successful one said nothing, so
     * recovery waited for the next twelve-second snapshot. Both are
     * one line. */
    const tell = (state) => {
      if (socket.readyState !== 1) return;
      try { socket.send(JSON.stringify({ type: "engine", data: { state } })); } catch { /* */ }
    };

    /* A dropped upstream is not automatically a dead engine.
     *
     * Reported: "the engine keeps going off and on in the desk". Every
     * hiccup on this proxy socket - the engine restarting after an
     * update, a stream closed by a slow write, anything at all - used
     * to say "offline" to the browser and then close the browser's
     * own socket. The desk went red, waited its two second reconnect,
     * said green again, and the trader watched that cycle instead of
     * their chart.
     *
     * So the drop is treated as what it is: this connection ended.
     * It is reconnected here, a few times, quickly - the browser
     * keeps its socket throughout and gets a fresh `hello` with a
     * full snapshot the moment the new upstream opens. Only when the
     * engine really will not take a connection is "offline" sent, and
     * then the browser socket is closed so the desk's own reconnect
     * takes over.
     */
    const RETRIES = 4;
    const RETRY_MS = 600;
    let tries = 0;
    let gone = false;

    const open = () => {
      if (gone || socket.readyState !== 1) return;
      upstream = new (require("ws"))(`ws://${host}:${port}/v1/stream`);
      upstream.on("open", () => { tries = 0; tell("online"); });
      upstream.on("message", (buf) => {
        if (socket.readyState === 1) socket.send(buf.toString());
      });
      const retry = () => {
        if (gone || socket.readyState !== 1) return;
        if (tries >= RETRIES) {
          tell("offline");
          try { socket.close(); } catch { /* */ }
          return;
        }
        tries += 1;
        setTimeout(open, RETRY_MS);
      };
      upstream.on("close", retry);
      upstream.on("error", () => { try { upstream.close(); } catch { /* */ } });
    };
    open();
    socket.on("message", (buf) => {
      // Prevent auth message loop after authenticated
      try {
        const m = JSON.parse(buf.toString());
        if (m && m.type === "auth") return;
      } catch {}
      if (upstream && upstream.readyState === 1) upstream.send(buf.toString());
    });
    socket.on("close", () => {
      gone = true;
      try { if (upstream) upstream.close(); } catch {}
    });
  }
});

const host = process.env.AURION_HOST || cfg.backend.host || "0.0.0.0";
const port = Number(process.env.AURION_PORT || cfg.backend.port || 8080);
// Start update auto-checker
try { updater.startAutoChecker(); } catch {}

/* The support clock has to be wound by something.
 *
 * The auto-checker above is the user's: it is off by default and they
 * may turn it off again. Enforcement cannot depend on a switch the
 * thing being enforced upon owns, so this runs unconditionally - four
 * checks a day, which is three GitHub requests cold and none when
 * nothing has moved, against a ceiling of sixty an hour.
 *
 * It also re-disarms auto-trading on every boot of an expired desk, so
 * restarting the machine is not a way to get the robot running again
 * behind the lock screen. */
const SUPPORT_WATCH_MS = 6 * 60 * 60 * 1000;

/* The deadline itself, to the minute.
 *
 * The six-hourly tick is how the desk LEARNS; it is not how the
 * deadline is kept. A grace period that ends at 14:05 and is enforced
 * at 18:00 is not a five day policy, it is a five day policy plus
 * however long the next tick takes - and the trader watching the
 * countdown on their own screen reach zero while the desk keeps
 * trading is being shown something untrue.
 *
 * So whenever the status says there is a known, finite time left,
 * one shot is armed for that moment. It costs nothing while nothing is
 * pending, it is re-armed from every tick, and if the facts change -
 * the update was installed, the check now says something else - the
 * next tick re-reads them and this timer finds an unexpired desk and
 * does nothing. */
let supportDeadlineTimer = null;
function armSupportDeadline(st) {
  if (supportDeadlineTimer) { clearTimeout(supportDeadlineTimer); supportDeadlineTimer = null; }
  const left = Number(st && st.ms_left);
  if (!Number.isFinite(left) || left <= 0) return;
  /* Only the window this process can see to the end of. A deadline
     four days out is the next tick's business, not a four day timer. */
  if (left > SUPPORT_WATCH_MS) return;
  supportDeadlineTimer = setTimeout(() => {
    supportDeadlineTimer = null;
    try {
      if (support.status().expired) haltTradingForSupport();
    } catch { /* never let the policy crash the desk */ }
  }, left + 1000);
  if (typeof supportDeadlineTimer.unref === "function") supportDeadlineTimer.unref();
}

async function supportWatchTick() {
  try { await updater.checkForUpdates(); } catch { /* offline is not a lockout */ }
  try {
    const st = support.status();
    if (st.expired) haltTradingForSupport();
    else armSupportDeadline(st);
  } catch { /* never let the policy crash the desk */ }
}
try {
  /* Before any network call, from what is already on disk.
   *
   * A build that has been sitting on a shelf comes back up knowing
   * perfectly well that it is out of support - the last check wrote it
   * down - and it used to spend the first forty-five seconds of that
   * boot with auto-trading armed, waiting to be told something it
   * already knew. The stored answer is also the only one available to
   * a machine that is offline, and a grace period does not pause
   * because GitHub is unreachable. */
  const startup = support.status();
  if (startup.expired) haltTradingForSupport();
  else armSupportDeadline(startup);
} catch { /* never let the policy stop the desk starting */ }
try {
  setTimeout(() => { supportWatchTick(); }, 45000);
  setInterval(() => { supportWatchTick(); }, SUPPORT_WATCH_MS);
} catch {}
/* Keep the engine running.
 *
 * Reported from the field: after an update the engine did not come up
 * and the only way back was closing the app and opening it again. The
 * launcher starts the engine once and nothing watched it afterwards, so
 * a process that lost the race for its port - which is exactly what an
 * update restart risks - left a healthy desk talking to nothing, with
 * no way to fix it from inside the product. */
try { supervisor.start(); } catch { /* never let it stop the desk starting */ }

/* ...and stop everything when whoever started us is killed. See
   watchOwner: the window passes its own pid in AURION_OWNER_PID. */
try { watchOwner(process.env.AURION_OWNER_PID); } catch { /* */ }

/* Somebody already has the port.
 *
 * Until now this was an unhandled error: node printed a stack, the
 * process died, the launcher exited 1, and the window showed a box
 * saying port 8080 was held by another program. Nine times in ten
 * the other program is AURION - a desk from a previous start that is
 * still perfectly alive - and the right thing to do about a desk
 * that is already running is nothing at all.
 *
 * So ask who it is. If it answers as an AURION desk, this process is
 * not needed: say so plainly and exit 0, and the window attaches to
 * the one that is already there. If it is something else, name the
 * port and exit non-zero, because that is a real conflict a person
 * has to resolve.
 */
function whoHasPort(cb) {
  const req = require("http").get(
    { host: "127.0.0.1", port, path: "/api/alive", timeout: 2000 },
    (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          cb(j && j.product === "AURION" && j.role === "desk" ? j : null);
        } catch { cb(null); }
      });
    },
  );
  req.on("timeout", () => { req.destroy(); });
  req.on("error", () => cb(null));
}

server.on("error", (err) => {
  if (!err || err.code !== "EADDRINUSE") throw err;
  whoHasPort((mine) => {
    const ts = new Date().toISOString();
    if (mine) {
      console.log(JSON.stringify({ ts, msg:
        `an AURION desk is already running on ${host}:${port} (pid ${mine.pid || "?"}) - `
        + "this one is not needed, leaving it to serve" }));
      process.exit(0);
    }
    console.error(JSON.stringify({ ts, msg:
      `port ${port} is held by something that is not an AURION desk. `
      + "AURION cannot start while another program has it - close that program, "
      + "or set AURION_PORT to a free port." }));
    process.exit(1);
  });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `AURION desk on ${host}:${port}` }));
});
