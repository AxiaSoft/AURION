/**
 * Nobody should have to close the app to get the engine back.
 *
 * Reported from the field, right after an update: "the engine would not
 * start and I had to close the app and open it again". That was an
 * accurate description of the only recovery there was. The launcher
 * starts the engine once and nothing watched it afterwards - so an
 * engine that lost the race for its port, which an update restart makes
 * likely, left a healthy desk talking to nothing with no way back from
 * inside the product.
 *
 * Two halves are pinned here. The launcher now waits for the engine to
 * answer and starts it once more if it did not, instead of the line
 * that waited for nothing. And the desk supervises it from then on,
 * carefully: several misses before acting, one attempt at a time,
 * growing backoff, a ceiling, and a reset the moment it answers.
 *
 * Run: npm run test:supervisor
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* Before anything requires paths.js: the supervisor writes a line into
   data/logs/desk.log every time it decides something, and data/logs is
   tracked. A test suite must not leave edits in the repository, so it
   is pointed at a throwaway directory for the duration. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-sup-"));
process.env.AURION_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const failures = [];
function say(cond, name) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failures.push(name); console.log("FAIL  " + name); }
}

/* ------------------------------------------------------------------ */
console.log("\n=== the launcher no longer assumes the engine started ===");
{
  const cmd = read("start-aurion.cmd");
  say(!/^time \/t >nul\s*$/m.test(cmd),
    "the line that printed the time and waited for nothing is gone");
  const launch = cmd.slice(cmd.indexOf(":LAUNCH"), cmd.indexOf(":NOTREADY"));
  say(/18765\/health/.test(launch), "it asks the engine whether it is up");
  say(/goto :ENGINEUP/.test(launch) && /:ENGINEUP/.test(launch),
    "and branches on the answer rather than carrying on regardless");
  const firstStart = launch.indexOf("engine\\main.py");
  const secondStart = launch.indexOf("engine\\main.py", firstStart + 1);
  say(secondStart > 0, "an engine that did not answer is started once more");
  say(launch.indexOf("goto :ENGINEUP") < secondStart,
    "and only then - a healthy engine is never started twice");
}

/* ------------------------------------------------------------------ */
console.log("\n=== and the desk keeps watching it ===");
{
  const sup = read("backend/src/engine-supervisor.js");
  const index = read("backend/src/index.js");
  say(/supervisor\.start\(\)/.test(index), "the desk starts the supervisor");
  say(/require\("\.\/engine-supervisor"\)/.test(index), "and can reach it");
  say(/if \(timer\.unref\) timer\.unref\(\)/.test(sup),
    "the watcher does not by itself keep the desk process alive");
  say(/AURION_NO_ENGINE_SUPERVISOR/.test(sup),
    "a developer running the engine by hand can switch it off");
}

/* ------------------------------------------------------------------ */
console.log("\n=== it is careful, because a bad supervisor is worse ===");
{
  /* Behavioural, against a fake engine: source greps cannot tell
     "waits for three misses" from "waits for one". */
  const supPath = path.join(ROOT, "backend", "src", "engine-supervisor.js");
  delete require.cache[require.resolve(supPath)];
  delete require.cache[require.resolve(path.join(ROOT, "backend", "src", "engine.js"))];
  const engine = require(path.join(ROOT, "backend", "src", "engine.js"));
  const sup = require(supPath);

  let alive = true;
  let started = 0;
  engine.healthy = async () => alive;
  /* The rig must not perform the action it is checking for. What is
     being tested is the decision to start the engine, so the decision
     is observed and the spawn is replaced - a test suite that really
     launched interpreters would leave them running. */
  sup.setStarter(() => { started += 1; return true; });

  (async () => {
    await sup.tick();
    say(sup.state().misses === 0 && started === 0, "a healthy engine is left alone");

    alive = false;
    await sup.tick();
    await sup.tick();
    say(sup.state().misses === 2, "two misses are counted and not acted on");
    say(sup.state().attempts === 0, "nothing has been started yet");

    await sup.tick();
    say(sup.state().attempts === 1, "the third miss starts it");

    /* Immediately again: the backoff must hold it. */
    const before = sup.state().attempts;
    await sup.tick();
    say(sup.state().attempts === before, "a second attempt does not follow instantly");

    alive = true;
    await sup.tick();
    say(sup.state().attempts === 0 && sup.state().misses === 0,
      "an engine that answers resets the counters, so a bad day later gets its own attempts");
    say(sup.state().gave_up === false, "and it has not given up");

    say(started === 1, "and it started exactly one, not one per tick");

    if (failures.length) {
      console.log("\nengine-supervisor: " + failures.length + " FAILED of " + (pass + failures.length));
      process.exit(1);
    }
    console.log("\nengine-supervisor: " + pass + " checks passed");
  })();
}
