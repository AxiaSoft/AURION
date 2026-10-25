const http = require("http");
const { load } = require("./config");

function base() {
  const cfg = load();
  const host = process.env.AURION_ENGINE_HOST || cfg.engine.host || "127.0.0.1";
  const port = process.env.AURION_ENGINE_PORT || cfg.engine.port || 18765;
  return { host, port };
}

function request(method, path, body, timeoutMs = 25000) {
  const { host, port } = base();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode, data: { ok: false, error: raw } });
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("engine timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function proxy(method, path, body) {
  try {
    const result = await request(method, path, body);
    return result.data;
  } catch (err) {
    // "Offline" is a diagnosis, not a symptom, and it was being handed out
    // for a request that simply took longer than we were willing to wait.
    // A backtest did that every time: it finished perfectly in an engine
    // that was answering health checks throughout, and the desk told the
    // trader their engine had died. Ask before saying it.
    if (String(err && err.message) === "engine timeout") {
      const alive = await healthy();
      if (alive) return { ok: false, error: "engine_busy", detail: `${method} ${path} took too long` };
    }
    return { ok: false, error: "engine_offline", detail: err.message };
  }
}

async function healthy() {
  try {
    const result = await request("GET", "/health", undefined, 2500);
    return Boolean(result.data && result.data.ok);
  } catch {
    return false;
  }
}

module.exports = { proxy, request, healthy, base };
