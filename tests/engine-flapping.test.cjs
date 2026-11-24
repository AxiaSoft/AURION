/**
 * The engine must not go offline, online, offline - and must come back.
 *
 * Reported several times, and the previous fixes all missed because
 * they treated the symptom. The engine log that finally showed it had
 * no crash in it at all: uvicorn answered `GET /health 200 OK` from
 * start to finish. Nothing was dying. The desk was *saying* the engine
 * was down, and then acting on it.
 *
 * The mechanism, start to finish:
 *
 *   1. The engine is momentarily too busy to answer inside the desk's
 *      5-second health timeout. Normal: a history download, an AI
 *      retrain, four charts ingesting at once.
 *   2. Three missed checks later the supervisor starts "the engine",
 *      believing it is gone.
 *   3. uvicorn binds its socket AFTER running application startup, and
 *      application startup is trader.start() - the EA socket, the
 *      MetaTrader attach, every trading loop. So the spare engine boots
 *      the entire product, several seconds of numpy / pandas /
 *      scikit-learn, before it reaches the bind and discovers it was
 *      never needed.
 *   4. Those seconds are spent on a machine that was already too busy
 *      to answer a health check. So the next checks are missed too, and
 *      another spare is launched. The cure was causing the disease.
 *   5. Five attempts later the supervisor gives up, and that was the
 *      "then nothing works at all".
 *
 * Two independent fixes, either of which breaks the loop, and both are
 * here because the failure cost real money:
 *
 *   * the engine refuses to be a duplicate, in milliseconds, having
 *     touched nothing (engine/main.py::_claim_port);
 *   * the desk never starts an engine onto a held port, and a busy
 *     engine no longer counts towards giving up (engine-supervisor.js).
 *
 * Driven, not grepped. The supervisor is run against real sockets.
 */
const assert = require("assert");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log("ok   " + what); }
  else { fail++; console.log("  x  " + what); }
}
function section(t) { console.log("\n— " + t + "\n"); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server that listens and never answers: an engine that is busy. */
function silentListener(port) {
  return new Promise((resolve) => {
    const live = new Set();
    const srv = net.createServer((sock) => {
      /* Accept, say nothing, ever - but remember the socket. Without
         this, close() below waits forever for connections the health
         probes opened and abandoned, the loop empties, and node exits
         mid-test with a success code and no output. */
      live.add(sock);
      sock.on("close", () => live.delete(sock));
    });
    srv.listen(port, "127.0.0.1", () => resolve({
      close: () => new Promise((done) => {
        for (const sock of live) { try { sock.destroy(); } catch { /* */ } }
        srv.close(() => done());
      }),
    }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function main() {
  /* ---------------------------------------------------------------- *
   * 1. A busy engine is not a dead engine
   * ---------------------------------------------------------------- */
  section("1. an engine that holds its port is never replaced");

  const port = await freePort();
  process.env.AURION_ENGINE_PORT = String(port);
  process.env.AURION_NO_ENGINE_SUPERVISOR = "";

  // Loaded after the port is set: enginePort() reads the environment.
  const sup = require(path.join(ROOT, "backend", "src", "engine-supervisor.js"));

  let spawned = 0;
  sup.setStarter(() => { spawned += 1; return true; });

  const busy = await silentListener(port);

  /* Five ticks, against MISSES_BEFORE_START = 3. On the old code the
     third would have spawned a spare engine, and the spare's boot is
     what made the next check fail too. (Each tick costs a real 5s
     health timeout, which is why this is five and not fifty.) */
  for (let i = 0; i < 5; i++) await sup.tick();

  ok(spawned === 0,
    `a listening-but-silent engine is never replaced (spawned ${spawned})`);
  ok(sup.state().gave_up === false,
    "...and a busy spell cannot walk the supervisor towards giving up");
  ok(Number(sup.state().attempts || 0) === 0,
    `...so no attempt is ever recorded against it (attempts=${sup.state().attempts})`);

  await busy.close();

  /* ---------------------------------------------------------------- *
   * 2. A genuinely absent engine is still started
   * ---------------------------------------------------------------- */
  section("2. an engine that is really gone is still started");

  sup.resume("test");
  spawned = 0;
  for (let i = 0; i < 4; i++) await sup.tick();

  ok(spawned >= 1,
    `with nothing on the port, the engine IS started (spawned ${spawned})`);
  ok(spawned === 1,
    "...exactly once, not once per tick");

  /* ---------------------------------------------------------------- *
   * 3. The engine declines to be a second engine
   * ---------------------------------------------------------------- */
  section("3. a duplicate engine declines, cheaply, having touched nothing");

  const { spawnSync } = require("child_process");
  const taken = await freePort();
  const holder = await silentListener(taken);

  const py = process.env.PYTHON || "python3";
  const t0 = Date.now();
  const run = spawnSync(py, ["main.py", "--host", "127.0.0.1", "--port", String(taken)], {
    cwd: path.join(ROOT, "engine"),
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, PYTHONPATH: path.join(ROOT, "engine") },
  });
  const took = Date.now() - t0;

  ok(run.status === 3,
    `a second engine exits with the "already running" code (got ${run.status})`);
  ok(/already listening/i.test(String(run.stderr || "")),
    "...and says why, in words");
  /* The whole point. Booting the product took seconds of CPU on a
     machine that was already too busy; declining must cost nothing.
     Ten seconds is a very loose ceiling for an interpreter start -
     what it rules out is numpy, pandas, scikit-learn and a
     MetaTrader attach, which together are far more than that. */
  ok(took < 10000,
    `...in ${took} ms, without booting the product`);
  /* Proof it never reached application startup: trader.start() opens
     the EA socket and logs it, and the news feed warns on its first
     pass. Neither can have happened. */
  const said = String(run.stdout || "") + String(run.stderr || "");
  ok(!/EA socket listening/.test(said),
    "...never opened the EA socket");
  ok(!/AURION engine started/.test(said) && !/aurion\.news/.test(said),
    "...never started the trader or attached to MetaTrader");

  ok(await stillListening(taken),
    "and the engine that was already running is untouched");

  await holder.close();

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function stillListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
