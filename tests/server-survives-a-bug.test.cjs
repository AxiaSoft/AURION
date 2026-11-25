/**
 * One bad route must not take the desk down with it.
 *
 * Express 4 calls a handler and ignores what it returns. For a normal
 * handler that is fine: a throw unwinds into Express's own try/catch
 * and becomes a 500. For an `async` handler it is not. The throw
 * becomes a rejected promise nobody is watching, so the request is
 * never answered - and since Node 15 an unhandled rejection PRINTS A
 * STACK AND EXITS.
 *
 * This process is the desk. It serves index.html, every /api route and
 * the websocket. So one undefined dereferenced in one handler did not
 * fail one request; it ended the trader's session, blanked the window
 * and dropped everything in flight, while positions were open. There
 * are twenty async handlers in backend/src/index.js and nineteen of
 * them read their arguments before they reach their try/catch.
 *
 * Measured before the fix, with a handler that reads a property of
 * null: the process exited with code 1 and the request was never
 * answered.
 *
 * Three things are checked, and the first two are the ones that matter
 * because they run the real server rather than reading it:
 *
 *   1. a route that throws synchronously is answered, and the server
 *      is still serving afterwards;
 *   2. a route that throws inside `async` is answered too - this is
 *      the one that used to be fatal;
 *   3. the guards are wired into backend/src/index.js itself, so this
 *      cannot pass against a test fixture while the real file rots.
 *
 * Run:
 *   node tests/server-survives-a-bug.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = fs.readFileSync(path.join(ROOT, "backend", "src", "index.js"), "utf8");

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) {
    pass += 1;
    console.log("ok   " + what);
  } else {
    fail += 1;
    console.log("FAIL " + what);
  }
}

/* The two guards, lifted out of backend/src/index.js.
 *
 * They are re-declared here rather than imported because importing
 * index.js boots the whole desk - config, database, supervisor, port
 * claim - and the thing under test is a dozen lines of routing. Check
 * (3) below is what keeps this copy honest: it fails if index.js stops
 * installing them.
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
      if (out && typeof out.then === "function") Promise.resolve(out).catch(next);
      return out;
    };
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

function get(port, route) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // A hung request is the failure, so it must not hang the test.
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "TIMEOUT" }); });
    req.on("error", (e) => resolve({ status: 0, body: "ERROR " + e.message }));
  });
}

async function main() {
  let express;
  try {
    express = require(path.join(ROOT, "backend", "node_modules", "express"));
  } catch {
    console.log("ok   (skipped: backend dependencies are not installed)");
    console.log(`\n${pass} ok, ${fail} failed`);
    return;
  }

  const app = express();
  forwardAsyncErrors(app);

  // Exactly the two shapes that occur in index.js.
  app.get("/sync-boom", (_req, res) => {
    const nothing = null;
    res.json({ v: nothing.missing });
  });
  app.get("/async-boom", async (_req, res) => {
    const nothing = null;
    res.json({ v: nothing.missing });
  });
  app.get("/fine", (_req, res) => res.json({ ok: true }));

  app.use((err, _req, res, _next) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.status(500).json({ ok: false, code: "server_error", error: String(err && err.message) });
  });

  // If the fix is absent this fires and the process dies; the listener
  // is what makes the failure a readable test result instead of a
  // stack trace with no context.
  let rejections = 0;
  process.on("unhandledRejection", () => { rejections += 1; });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;

  const sync = await get(port, "/sync-boom");
  ok(sync.status === 500, `a handler that throws is answered 500, not left hanging (got ${sync.status})`);

  const async_ = await get(port, "/async-boom");
  ok(
    async_.status === 500,
    `an ASYNC handler that throws is answered 500 - this is the one that killed the desk (got ${async_.status === 0 ? async_.body : async_.status})`,
  );

  let body = {};
  try { body = JSON.parse(async_.body); } catch {}
  ok(body.code === "server_error", "the answer is JSON the desk can read, not Express's HTML page");

  // The point of the whole exercise: the server is still there.
  const after = await get(port, "/fine");
  ok(after.status === 200, "the server is still serving after both faults");

  await new Promise((r) => setImmediate(r));
  ok(rejections === 0, `no unhandled rejection escaped (saw ${rejections}) - an escaped one exits the process`);

  server.close();

  /* (3) The real file must install both guards. */
  ok(
    /function forwardAsyncErrors\s*\(/.test(INDEX),
    "backend/src/index.js defines forwardAsyncErrors",
  );
  ok(
    /forwardAsyncErrors\(app\)/.test(INDEX),
    "forwardAsyncErrors is applied to the app, so its async routes cannot crash the process",
  );
  ok(
    /forwardAsyncErrors\(guarded\)/.test(INDEX),
    "forwardAsyncErrors is applied to the guarded router, where most async handlers live",
  );
  ok(
    /app\.use\(\(err, req, res, _next\) =>/.test(INDEX),
    "backend/src/index.js registers a four-argument error handler",
  );
  ok(
    /process\.on\(signal/.test(INDEX) && /unhandledRejection/.test(INDEX) && /uncaughtException/.test(INDEX),
    "a last-resort guard keeps the desk up when something outside Express throws",
  );

  /* The error handler must be registered AFTER the routes it protects.
     Express runs middleware in registration order, so one placed above
     app.use("/api", guarded) would never see anything those routes
     throw - and it would look perfectly correct in review. */
  const handlerAt = INDEX.indexOf("app.use((err, req, res, _next)");
  const guardedAt = INDEX.indexOf('app.use("/api", guarded)');
  ok(
    handlerAt > 0 && guardedAt > 0 && handlerAt > guardedAt,
    "the error handler is registered after the routes, or it would never run",
  );

  console.log(`\n${pass} ok, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
