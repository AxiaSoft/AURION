const http = require("http");
const { load } = require("./config");
const buildId = require("./build-id");

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

/**
 * Which code the engine is actually running, against which is on disk.
 *
 * An update replaces files under a live process, and Python keeps the
 * modules it imported: the installation was new and the behaviour was
 * old, with nothing anywhere saying so. The engine reports a fingerprint
 * of the source it imported; buildState() compares it with the same
 * fingerprint of those files now.
 *
 * Never throws, and never guesses. An engine that is down, or older than
 * this check, reports nothing - and nothing is not a mismatch.
 */
async function buildState() {
  let running = "";
  let online = false;
  let engineDir = "";
  let pid = 0;
  let startedAt = "";
  try {
    const result = await request("GET", "/health", undefined, 2500);
    const data = (result && result.data) || {};
    online = Boolean(data.ok);
    running = String(data.build_id || "");
    engineDir = String(data.source_dir || "");
    pid = Number(data.pid || 0) || 0;
    startedAt = String(data.started_at || "");
  } catch { online = false; }
  const cmp = buildId.compare(running);

  /* Is the engine even looking at the same tree we are?
   *
   * A permanent mismatch has two completely different causes and the
   * desk used to show one message for both. Either the engine is an old
   * process of THIS installation - restart it - or it is a perfectly
   * current process of a DIFFERENT installation on the same machine, in
   * which case restarting and repairing this one will never change the
   * number, which is exactly what was reported from the field. The
   * paths are the only thing that separates them.
   *
   * Compared case-insensitively and without a trailing separator,
   * because Windows will hand back either. Unknown on one side is not a
   * difference. */
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const differentTree = Boolean(engineDir) && norm(engineDir) !== norm(buildId.SOURCE_DIR);

  return {
    online,
    running: cmp.running,
    disk: cmp.disk,
    /* Where each fingerprint came from. Reported always, not only on a
       mismatch: "they agree, and here is the tree they agree about" is
       the sentence that ends a support thread. */
    engine_dir: engineDir,
    disk_dir: buildId.SOURCE_DIR,
    different_tree: online && differentTree,
    /* Which process, and since when. An engine that started before the
       update was downloaded is a survivor, and naming its PID is the
       difference between "restart again" and "end this process". */
    pid,
    started_at: startedAt,
    /* True only when both sides spoke and disagreed: the update is on
       disk and the engine has not been restarted into it. */
    restart_required: online && cmp.stale,
    /* An engine that cannot say which build it is (anything before this
       was added) - reported so the desk can be honest about not knowing
       rather than claiming either answer. */
    unknown: online && !cmp.known,
  };
}

module.exports = { proxy, request, healthy, base, buildState };
