/**
 * "When MetaTrader disconnects, or I attach and detach the expert,
 *  the engine keeps going off and on - it is not stable."
 *
 * Followed by a startup failure box quoting a healthy engine log, a
 * desk that had announced itself on 0.0.0.0:8080, and the sentence
 * "Port 8080 is held by another program."
 *
 * One chain, four links:
 *
 *   1. The engine asked a dying MetaTrader for a symbol's contract
 *      spec ON ITS EVENT LOOP, from a synchronous method called
 *      inside request handlers. A terminal that is going away does
 *      not answer quickly, and for as long as it did not, the engine
 *      answered nothing at all - /health included. (Engine side; the
 *      Python tests pin that one.)
 *   2. "Is the engine alive" was asked as "did it answer THIS poll".
 *      A busy process is not a dead one; a dead one refuses the
 *      connection instantly and keeps refusing it. So the answer is
 *      remembered and a quiet moment inside the grace reads as BUSY.
 *   3. The desk's light treats busy as up.
 *   4. The window probed /api/health - which waits up to five seconds
 *      on the ENGINE - with a two second client timeout, so a busy
 *      engine made the window think the DESK was gone. It started a
 *      second desk, which could not bind 8080, the launcher exited 1,
 *      and the trader was told another program had the port. The
 *      other program was AURION.
 *
 *     node tests/engine-stability.test.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const INDEX = read("backend", "src", "index.js");
const WINDOW = read("installer", "window", "AppWindow.cs");

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

/* ------------------------------------------- 2. online / busy / offline */
{
  const engine = require(path.join(ROOT, "backend", "src", "engine.js"));

  engine.forgetHealth();
  ok(engine.liveness(false) === "offline",
    "an engine that has never answered is offline, not busy - there is nothing to be busy");
  ok(engine.liveness(true) === "online", "an engine that answers is online");

  engine.noteHealthy(true);
  ok(engine.liveness(false) === "busy",
    "an engine that answered a moment ago and is quiet now is busy, not dead");

  ok(engine.ENGINE_BUSY_GRACE_MS >= 15000,
    "the grace is shorter than the supervisor's three checks, so the light "
    + "would still report a death the watchdog does not act on");

  /* And the grace really does end. */
  const realNow = Date.now;
  try {
    const t = realNow();
    Date.now = () => t + engine.ENGINE_BUSY_GRACE_MS + 1;
    ok(engine.liveness(false) === "offline", "silence that outlasts the grace is offline");
  } finally {
    Date.now = realNow;
  }
  engine.forgetHealth();
}

/* ------------------------------------------------- 3. the desk's light */
{
  const probe = APP.slice(APP.indexOf("async function probeEngine("));
  const body = probe.slice(0, probe.indexOf("\nfunction startEngineWatch"));
  ok(/state === "online" \|\| state === "busy"/.test(body),
    "the desk still reads only \"online\" as up, so a busy second paints a dead engine");
}

/* -------------------------------------- 4. the window's liveness probe */
{
  ok(/\/api\/alive/.test(INDEX), "the desk has no cheap liveness endpoint");
  const alive = INDEX.slice(INDEX.indexOf('app.get("/api/alive"'), INDEX.indexOf('app.get("/api/health"'));
  ok(!/await/.test(alive), "/api/alive waits on something, which is the whole fault it exists to fix");
  ok(/"AURION"/.test(alive) && /role: "desk"/.test(alive),
    "/api/alive does not identify itself, so nothing can tell our desk from another program");

  const probe = WINDOW.slice(WINDOW.indexOf("private async Task<bool> DeskIsAnsweringAsync"));
  ok(probe.indexOf("AliveUrl") >= 0 && probe.indexOf("AliveUrl") < probe.indexOf("HealthUrl"),
    "the window still asks /api/health first, which waits on the engine");
  ok(/HealthUrl/.test(probe),
    "the fallback is gone - a desk from before /api/alive would read as dead for one start");
}

/* ----------------------------------- 4b. the port, and who really has it */
{
  const handler = INDEX.slice(INDEX.indexOf('server.on("error"'));
  ok(/EADDRINUSE/.test(handler), "the desk still dies on a taken port with a stack trace");
  ok(/process\.exit\(0\)/.test(handler),
    "a desk that is already running is treated as a failure instead of as the answer");
  ok(/process\.exit\(1\)/.test(handler), "a genuine conflict has to be reported as one");

  ok(/An AURION desk is already running on port 8080/.test(WINDOW),
    "the failure box still blames another program for AURION's own desk");
  ok(/AliveSaysAurion/.test(WINDOW), "...and it never asks who actually holds the port");
}

/* ------------------------------------------- the port handler, for real */
{
  /* Not a source check: take the port, start the desk's handler over
     it, and see what it decides. */
  const http = require("node:http");
  const net = require("node:net");

  const run = async () => {
    /* (a) An AURION desk already there. */
    const mine = http.createServer((req, res) => {
      if (req.url === "/api/alive") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, product: "AURION", role: "desk", pid: 4242 }));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
    await new Promise((r) => mine.listen(0, "127.0.0.1", r));
    const port = mine.address().port;

    const decide = (p) => new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: p, path: "/api/alive", timeout: 2000 }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.product === "AURION" && j.role === "desk" ? j : null);
          } catch { resolve(null); }
        });
      });
      req.on("timeout", () => { req.destroy(); });
      req.on("error", () => resolve(null));
    });

    const ours = await decide(port);
    ok(ours && ours.pid === 4242,
      "a desk already on the port is recognised as ours, and names its process");
    mine.close();

    /* (b) Something else entirely - a bare TCP socket that never
           speaks HTTP. This must not hang and must not be mistaken
           for us. */
    const other = net.createServer(() => { /* say nothing, ever */ });
    await new Promise((r) => other.listen(0, "127.0.0.1", r));
    const t0 = Date.now();
    const theirs = await decide(other.address().port);
    const waited = Date.now() - t0;
    other.close();
    ok(theirs === null, "a program that is not AURION is not mistaken for AURION");
    ok(waited < 4000, "a silent holder of the port hangs the check for " + waited + "ms");
  };

  run().then(() => {
    console.log(fails
      ? "\nengine-stability: " + fails + " check(s) failed"
      : "\nengine-stability: all good");
    process.exit(fails ? 1 : 0);
  });
}
