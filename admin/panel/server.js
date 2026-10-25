/* AURION — the admin panel.
 *
 * One process, one port, one token, three tabs: Updates, Telegram and
 * Licences. It replaces two separate panels that each had their own
 * port, their own token and their own look, and a licence workflow that
 * had no panel at all and lived in three scripts.
 *
 * What it does NOT do is reimplement any of them.
 *
 *   Updates   proxied to the update server, which owns release storage
 *             and file uploads. Rewriting that here would mean two
 *             programs writing the same data directory.
 *
 *   Telegram  proxied to the engine's own local-only admin endpoint,
 *             exactly as the old panel did. The bot token never reaches
 *             this process, let alone the browser.
 *
 *   Licences  minted by the engine, through its own CLI. Key minting is
 *             Ed25519 over a seed that must exist in exactly one place;
 *             a second implementation in JavaScript is how two minters
 *             start disagreeing about what a valid key looks like.
 *
 * So this is a façade, deliberately. The useful thing it adds is that
 * there is now one address to open, one secret to keep, and one place
 * that says plainly which of the three backends is not running.
 *
 * Binds 127.0.0.1 only, and that is not configurable.
 *
 *   node admin/panel/server.js      ->  http://127.0.0.1:8900
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..", "..");
const TOKEN_FILE = path.join(HERE, "panel.token");

const PORT = Number(process.env.AURION_PANEL_PORT || 8900);
const HOST = "127.0.0.1";                       // never 0.0.0.0

const ENGINE = (process.env.AURION_ENGINE_URL || "http://127.0.0.1:18765").replace(/\/+$/, "");

/* ------------------------------------------------------- borrowed secrets
 *
 * Two secrets belong to other programs: the update server's ADMIN_TOKEN
 * and the licence signing seed. The panel used to demand both as
 * environment variables, which on Windows means setting a variable in
 * the same console before launching, or setx and a new console. That
 * step failed often enough to be the fault itself — "I could not set the
 * update token" — and when it failed the only symptom was 401.
 *
 * So: look where the value already lives before asking anyone to type
 * it. An explicit environment variable still wins, for the case where
 * the servers run on different machines.
 */

/** Read a .env into a plain object. Missing file is not an error. */
function readEnvFile(file) {
  const values = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

const UPDATE_ENV = readEnvFile(path.join(ROOT, "admin", "update-server", ".env"));

const UPDATES = (
  process.env.AURION_UPDATE_URL
  || `http://127.0.0.1:${UPDATE_ENV.PORT || 8898}`
).replace(/\/+$/, "");

const UPDATE_TOKEN = String(
  process.env.AURION_UPDATE_TOKEN || UPDATE_ENV.ADMIN_TOKEN || ""
).trim();

const UPDATE_TOKEN_FROM = !UPDATE_TOKEN
  ? "nowhere"
  : (String(process.env.AURION_UPDATE_TOKEN || "").trim()
      ? "AURION_UPDATE_TOKEN"
      : "admin/update-server/.env");

/** The signing seed: environment, then the key server's .env, then a file. */
function signingSeed() {
  const fromEnv = String(process.env.AURION_KEY_PRIVATE_HEX || "").trim();
  if (fromEnv) return { seed: fromEnv, from: "AURION_KEY_PRIVATE_HEX" };

  const store = readEnvFile(path.join(ROOT, "store", "keyserver", ".env"));
  if (String(store.AURION_KEY_PRIVATE_HEX || "").trim()) {
    return { seed: store.AURION_KEY_PRIVATE_HEX.trim(), from: "store/keyserver/.env" };
  }
  try {
    const saved = fs.readFileSync(path.join(HERE, "seed.key"), "utf8").trim();
    if (saved) return { seed: saved, from: "admin/panel/seed.key" };
  } catch {
    /* not there */
  }
  return { seed: "", from: "nowhere" };
}

const SEED = signingSeed();

/* ------------------------------------------------------------------ auth */

/** The panel's own secret, made once and kept beside it. */
function panelToken() {
  const fromEnv = String(process.env.AURION_PANEL_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {
    /* first run */
  }
  const made = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, made + "\n", { mode: 0o600 });
  return made;
}

const TOKEN = panelToken();

/** Constant time, so the token cannot be guessed a character at a time. */
function tokenOk(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- plumbing */

function send(res, status, body, type = "application/json; charset=utf-8") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Call one of the backends.
 *
 * Returns a shape the browser can always render, including when the
 * backend is simply not running - which is the single most common state
 * and the one the old panels reported as a blank screen.
 */
async function callUp(base, route, { method = "GET", body = null, token = "" } = {}) {
  const url = base + route;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      offline: true,
      data: { error: "not_running", at: base, detail: String(err && err.message || err) },
    };
  }
}

/* --------------------------------------------------------------- licences */

/**
 * Mint a key by asking the engine, which is the only thing that holds
 * the signing code.
 *
 * The seed itself has to be in the environment of this process. It is
 * never written anywhere by the panel and never sent to the browser.
 */
function mintKey({ plan, note, offline }) {
  return new Promise((resolve) => {
    const args = ["-m", "aurion.license.guard", String(plan || ""), String(note || "panel")];
    if (offline) args.push("--offline");

    const python = process.env.AURION_PYTHON || "python3";
    const child = spawn(python, args, {
      cwd: path.join(ROOT, "engine"),
      env: {
        ...process.env,
        PYTHONPATH: path.join(ROOT, "engine"),
        // The seed may have come from a file rather than this process's
        // environment; the minter only reads the environment.
        ...(SEED.seed ? { AURION_KEY_PRIVATE_HEX: SEED.seed } : {}),
      },
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ ok: false, error: String(e.message || e) }));
    child.on("close", (code) => {
      const key = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";

      // The minter writes its own notes to stderr, and Python writes
      // runpy warnings to the same place. A RuntimeWarning about
      // sys.modules sitting next to the key somebody just paid for is
      // noise that reads as a fault.
      const notes = err
        .split(/\r?\n/)
        .map((line) => line.replace(/^#\s?/, "").trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/RuntimeWarning|warnings\.warn|sys\.modules/.test(line))
        .join("\n");

      if (code === 0 && key) return resolve({ ok: true, key, note: notes });
      resolve({
        ok: false,
        error: err.trim() || `the minter exited with code ${code}`,
        hint: /PRIVATE/i.test(err)
          ? "No signing seed. Make one with: python admin/new-seed.py --save"
          : "",
      });
    });
  });
}

/* ----------------------------------------------------------------- routes */

async function api(req, res, route) {
  if (!tokenOk(req.headers["x-panel-token"])) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }

  /* --- where everything is, and whether it answers ------------------- */
  if (route === "/api/status" && req.method === "GET") {
    const [engine, updates] = await Promise.all([
      callUp(ENGINE, "/health"),
      callUp(UPDATES, "/api/health"),
    ]);
    return send(res, 200, {
      ok: true,
      engine: { url: ENGINE, up: engine.ok },
      updates: { url: UPDATES, up: updates.ok, token: Boolean(UPDATE_TOKEN) },
      licences: { seed: Boolean(SEED.seed), from: SEED.from },
    });
  }

  /* --- updates -------------------------------------------------------- */
  if (route.startsWith("/api/updates")) {
    if (!UPDATE_TOKEN) {
      // Say which secret is missing. Passing the upstream's bare 401
      // straight through is the dead end the old panel had: a rejection
      // with no hint that a second token exists at all.
      return send(res, 503, {
        ok: false,
        error: "no_update_token",
        detail: "AURION_UPDATE_TOKEN is not set for this panel. It is the "
              + "ADMIN_TOKEN from admin/update-server/.env, and that file "
              + "does not exist yet. Run admin/start-update-server.cmd once: "
              + "it writes the file, and this panel reads it by itself.",
      });
    }
    const tail = route.slice("/api/updates".length) || "";
    const body = req.method === "GET" ? null : JSON.parse((await readBody(req)) || "{}");
    const up = await callUp(UPDATES, "/api/admin/updates" + tail, {
      method: req.method,
      body,
      token: UPDATE_TOKEN,
    });
    return send(res, up.offline ? 503 : up.status, { ok: up.ok, ...up.data });
  }

  /* --- telegram ------------------------------------------------------- */
  if (route.startsWith("/api/telegram")) {
    const body = req.method === "GET" ? null : JSON.parse((await readBody(req)) || "{}");
    const up = await callUp(ENGINE, "/v1/telegram/admin", { method: req.method, body });
    return send(res, up.offline ? 503 : up.status, { ok: up.ok, ...up.data });
  }

  /* --- licences ------------------------------------------------------- */
  if (route === "/api/licence" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const plan = String(body.plan || "");
    if (!["m1", "m3", "m6", "y1", "developer"].includes(plan)) {
      return send(res, 400, { ok: false, error: "plan must be m1, m3, m6, y1 or developer" });
    }
    const out = await mintKey({ plan, note: body.note, offline: Boolean(body.offline) });
    return send(res, out.ok ? 200 : 400, out);
  }

  return send(res, 404, { ok: false, error: "no such route" });
}

/* ------------------------------------------------------------------ serve */

const server = http.createServer(async (req, res) => {
  const route = (req.url || "/").split("?")[0];

  try {
    if (route.startsWith("/api/")) return await api(req, res, route);

    if (route === "/" || route === "/index.html") {
      const html = fs.readFileSync(path.join(HERE, "public", "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    return send(res, 404, "not found", "text/plain; charset=utf-8");
  } catch (err) {
    return send(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  const seeded = Boolean(SEED.seed);
  console.log("");
  console.log("  AURION admin panel");
  console.log("  ------------------");
  console.log(`  ${`http://${HOST}:${PORT}`}`);
  console.log(`  token  ${TOKEN}`);
  console.log("");
  console.log(`  updates   ${UPDATES}   ${UPDATE_TOKEN
    ? `token from ${UPDATE_TOKEN_FROM}`
    : "NO TOKEN - start admin/start-update-server.cmd once, which writes it"}`);
  console.log(`  engine    ${ENGINE}`);
  console.log(`  licences  ${seeded
    ? `signing seed from ${SEED.from}`
    : "NO SEED - minting is off. Make one: python admin/new-seed.py --save"}`);
  console.log("");
});
