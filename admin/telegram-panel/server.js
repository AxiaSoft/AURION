/* AURION — standalone Telegram admin panel.
 *
 * Deliberately NOT part of the dashboard: this is an owner-only surface and it
 * lives outside apps/web entirely.  It talks straight to the engine's
 * local-only /v1/telegram/admin endpoint; the desk backend never proxies it.
 *
 *   node admin/telegram-panel/server.js
 *   -> http://127.0.0.1:8913
 *
 * Security posture:
 *   - binds 127.0.0.1 only, never 0.0.0.0
 *   - every /api call needs the panel token from panel.token (gitignored) or
 *     AURION_ADMIN_PANEL_TOKEN; one is generated on first run and printed
 *   - the bot token itself is never returned to the browser — only its origin
 *     and a masked hint, exactly as the engine already reports it
 *
 * No dependencies: node:http only.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HERE = __dirname;
const TOKEN_FILE = path.join(HERE, "panel.token");
const ENGINE = process.env.AURION_ENGINE_URL || "http://127.0.0.1:18765";
const PORT = Number(process.env.AURION_ADMIN_PANEL_PORT || 8913);
const HOST = "127.0.0.1"; // never make this configurable to 0.0.0.0

function panelToken() {
  const fromEnv = String(process.env.AURION_ADMIN_PANEL_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  } catch (_) {
    /* not created yet */
  }
  const made = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, `${made}\n`, { mode: 0o600 });
  console.log("");
  console.log("  A panel token was generated and written to:");
  console.log(`    ${TOKEN_FILE}`);
  console.log("");
  console.log(`    ${made}`);
  console.log("");
  console.log("  Keep it out of git (it is gitignored). Delete the file to rotate.");
  console.log("");
  return made;
}

const TOKEN = panelToken();

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function send(res, status, body, headers) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...(headers || {}),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** Forward to the engine's local-only admin endpoint. */
async function engineCall(method, body) {
  const url = new URL("/v1/telegram/admin", ENGINE);
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  return await res.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      return send(res, 200, fs.readFileSync(path.join(HERE, "index.html"), "utf8"));
    } catch (_) {
      return send(res, 500, { ok: false, error: "panel page missing" });
    }
  }

  if (url.pathname.startsWith("/api/")) {
    if (!safeEqual(req.headers["x-panel-token"], TOKEN)) {
      return send(res, 401, { ok: false, error: "bad_token" });
    }
    try {
      if (url.pathname === "/api/state" && req.method === "GET") {
        return send(res, 200, await engineCall("GET"));
      }
      if (url.pathname === "/api/action" && req.method === "POST") {
        const body = await readJson(req);
        const action = String(body.action || "");
        if (!["start", "stop", "restart", "test"].includes(action)) {
          return send(res, 400, { ok: false, error: "action" });
        }
        return send(res, 200, await engineCall("POST", { action }));
      }
      return send(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      return send(res, 502, { ok: false, error: "engine_unreachable", detail: String(err && err.message) });
    }
  }

  return send(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log(`AURION Telegram admin panel on http://${HOST}:${PORT}`);
  console.log(`Proxying to engine at ${ENGINE}`);
  console.log("Bound to loopback only — this panel is not reachable from the network.");
});
