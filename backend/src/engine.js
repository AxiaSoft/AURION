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
