/**
 * An update that does not take effect is not an update.
 *
 * Reported from a customer's machine, twice, and the second time after
 * the fix for the first one had already been installed: the desk kept
 * answering with an error whose line no longer existed in the source on
 * its own disk. Two causes, both in the deployment path rather than in
 * the code anybody was reading:
 *
 *   A. The apply wrote the files and stopped. Nothing restarted the
 *      engine, which is a service behind the window and does not die
 *      when the window closes, and Python holds the modules it imported
 *      for the life of the process. New files, old behaviour, and a
 *      screen saying "installed".
 *
 *   B. Stale bytecode. Python reuses a .pyc when the source's size and
 *      timestamp match what the .pyc recorded, and a copy can satisfy
 *      that with a .pyc months older than the source beside it. The
 *      updater skipped __pycache__ when downloading - correctly - and
 *      so had never cleaned it either. Forty-five .pyc were also
 *      committed to the repository, which put September's bytecode back
 *      on any machine that pulled.
 *
 * What is pinned here is the shape of the cure, not its wording:
 * the apply restarts, the bytecode goes, the engine says which build it
 * is running and the desk checks that answer after the restart, there
 * is a repair install for the machine whose files hash correctly and
 * behaves wrongly anyway, and no compiled bytecode is tracked.
 *
 * Run: npm run test:updeffect
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const failures = [];
function say(cond, name) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { failures.push(name); console.log("FAIL  " + name); }
}

const UPDATER = read("backend/src/updater.js");
const INDEX = read("backend/src/index.js");
const ENGINEJS = read("backend/src/engine.js");
const APP = read("apps/web/js/app.js");
const SERVER_PY = read("engine/aurion/api/server.py");
const PACKS = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

/* --------------------------------------------------------------- */
console.log("\n=== A. the install restarts the thing it updated ===");
{
  const i = UPDATER.indexOf("async function applyUpdate(");
  const body = UPDATER.slice(i, UPDATER.indexOf("\n}\n", UPDATER.indexOf("copyExpertsToTerminals()", i)));
  say(/hostctl\.scheduleRestart\(\)/.test(body),
    "the successful apply schedules the restart itself");
  say(/opts\.restart !== false/.test(body),
    "and it is the default - declining has to be said out loud");
  say(/restarting: restartScheduled/.test(body),
    "the answer states which of the two actually happened");
  say(/const hostctl = require\("\.\/host"\);/.test(UPDATER),
    "the updater can reach the restart at all");

  const route = INDEX.slice(INDEX.indexOf('guarded.post("/system/update/apply"'),
    INDEX.indexOf('guarded.post("/system/update/repair"'));
  say(/restart: \(req\.body \|\| \{\}\)\.restart !== false/.test(route),
    "the route passes the caller's choice through and defaults to restarting");
  say(/owner_only/.test(route), "and installing is still owner-only");
}

/* --------------------------------------------------------------- */
console.log("\n=== B. stale bytecode is removed, not stepped around ===");
{
  say(/function purgeBytecode\(/.test(UPDATER), "the updater can delete compiled bytecode");
  const i = UPDATER.indexOf("const purged = purgeBytecode();");
  say(i > 0, "and the apply actually calls it");
  say(UPDATER.slice(0, i).includes("hostctl") && i < UPDATER.indexOf("hostctl.scheduleRestart()"),
    "before the restart, so the engine comes up with nothing stale to find");

  /* Behavioural: it must really delete a __pycache__, not merely exist. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurion-pyc-"));
  try {
    const deep = path.join(tmp, "aurion", "strategy", "__pycache__");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "loader.cpython-312.pyc"), "old");
    fs.writeFileSync(path.join(tmp, "aurion", "strategy", "loader.py"), "new");
    const loose = path.join(tmp, "aurion", "stray.pyc");
    fs.writeFileSync(loose, "old");
    const updater = require(path.join(ROOT, "backend", "src", "updater.js"));
    const removed = updater.purgeBytecode(tmp);
    say(!fs.existsSync(deep), "a nested __pycache__ is gone afterwards");
    say(!fs.existsSync(loose), "and a .pyc sitting loose beside the source too");
    say(fs.existsSync(path.join(tmp, "aurion", "strategy", "loader.py")),
      "while the source it was compiled from is untouched");
    say(removed.length >= 2, "and it reports what it removed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* And the repository must stop shipping the problem. */
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "*.pyc", "*.pyo"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch { tracked = ""; }
  say(tracked === "", "no compiled bytecode is tracked in git" + (tracked ? " (found: " + tracked.split("\n").length + ")" : ""));
  const ignore = read(".gitignore");
  say(/^__pycache__\/$/m.test(ignore) && /^\*\.pyc$/m.test(ignore),
    "and the ignore rules keep it that way");
}

/* --------------------------------------------------------------- */
console.log("\n=== the engine says which code it is running ===");
{
  say(fs.existsSync(path.join(ROOT, "engine", "aurion", "build_id.py")),
    "the engine has a fingerprint of its own source");
  say(/build_id\.BUILD_ID/.test(SERVER_PY) && /@app\.get\("\/health"\)/.test(SERVER_PY),
    "and reports it on health");
  const bid = read("engine/aurion/build_id.py");
  say(/BUILD_ID: str = compute\(\)/.test(bid),
    "taken once at import - a fresh reading would describe the disk, not the process");
  say(/__pycache__/.test(bid), "bytecode is excluded from it, being derived");

  /* The two implementations have to agree or the comparison is noise. */
  const nodeId = require(path.join(ROOT, "backend", "src", "build-id.js")).diskBuildId();
  let pyId = "";
  try {
    pyId = execFileSync("python3",
      ["-c", "import sys; sys.path.insert(0,'.'); from aurion import build_id; print(build_id.BUILD_ID)"],
      { cwd: path.join(ROOT, "engine"), encoding: "utf8" }).trim();
  } catch (e) { pyId = "python3 unavailable: " + e.message; }
  say(Boolean(nodeId) && nodeId.length === 16, "the desk can take the same fingerprint");
  say(nodeId === pyId, "and both ends compute it identically (" + nodeId + " vs " + pyId + ")");

  const cmp = require(path.join(ROOT, "backend", "src", "build-id.js")).compare;
  say(cmp("").stale === false, "an engine that cannot say is never accused of being stale");
  say(cmp(nodeId).stale === false, "an engine running the files on disk is not accused either");
  say(cmp("0000000000000000").stale === true, "and a real disagreement is reported");
  say(/restart_required: online && cmp\.stale/.test(ENGINEJS),
    "an offline engine cannot be stale - there is nothing running to be stale");
  const health = INDEX.slice(INDEX.indexOf('app.get("/api/health"'), INDEX.indexOf('app.get("/api/meta"'));
  say(/await engine\.buildState\(\)/.test(health) && /\n    build,/.test(health),
    "health carries it out to the desk");
}

/* --------------------------------------------------------------- */
console.log("\n=== the desk checks, instead of assuming ===");
{
  say(/async function verifyEngineBuild\(\)/.test(APP), "the desk can ask the question");
  say(/const verdict = await verifyEngineBuild\(\);/.test(APP),
    "and the install asks it after the restart");
  /* lastIndexOf: the settings panel asks the same question earlier in
     the file, and the one being pinned here is the install's. */
  const i = APP.lastIndexOf("const verdict = await verifyEngineBuild();");
  const after = APP.slice(i, i + 1800);
  say(/upd\.engine_stale_title/.test(after),
    "a desk that came back as the old build is told so, not shown a tick");
  say(/restart_required === true/.test(APP) && /return \{ stale: false, known: false \}/.test(APP),
    "anything it cannot establish counts as not stale - a false alarm is worse than silence");
  say(!/The restart is the user's to make/.test(APP),
    "the comment that made the restart optional is gone with the behaviour");
  say(/if \(ar\.restarting\) \{/.test(APP),
    "the install follows the restart the backend scheduled");
  say(/if \(!\(opts && opts\.scheduled\)\)/.test(APP),
    "and does not ask for a second restart on top of it");
}

/* --------------------------------------------------------------- */
console.log("\n=== repair, for the copy that looks right and is wrong ===");
{
  say(/async function repairInstall\(/.test(UPDATER), "there is a repair install");
  say(/github\.check\(liveConfig\(\), \{ all: true \}\)/.test(UPDATER),
    "it asks for every shipped file, not only the differing ones");
  const gh = read("backend/src/github-update.js");
  say(/if \(!opts\.all && mine === entry\.sha\) continue;/.test(gh),
    "which the check honours, while the ordinary check still skips matches");
  const i = UPDATER.indexOf("async function repairInstall(");
  const body = UPDATER.slice(i, UPDATER.indexOf("\n}\n", i));
  say(/writeSecure\(UPDATE_STATE_FILE, previous\)/.test(body),
    "a failed repair puts the previous update state back rather than leaving a lie behind");
  say(/applyUpdate\(String\(target\.update\.id\), "", opts\)/.test(body),
    "it reuses the tested apply path - backups, protected files and per-file hashes included");
  const route = INDEX.slice(INDEX.indexOf('guarded.post("/system/update/repair"'), INDEX.indexOf('guarded.get("/system/support"'));
  say(/owner_only/.test(route), "the route is owner-only");
  say(/id="upd-repair"/.test(APP), "and there is a button for it in the update panel");
  say(/async function runRepairInstall\(\)/.test(APP) && /askConfirm\(/.test(APP.slice(APP.indexOf("async function runRepairInstall()"), APP.indexOf("async function runRepairInstall()") + 600)),
    "which confirms before it runs");
}

/* --------------------------------------------------------------- */
console.log("\n=== and the chip stops saying the comforting thing ===");
{
  const i = APP.indexOf("function paintUpdateFacts(");
  const body = APP.slice(i, APP.indexOf("\n}", APP.indexOf("chip.textContent", i)));
  const unpub = body.slice(body.indexOf('state === "unpublished"'), body.indexOf('state === "uptodate"'));
  say(!/upd\.uptodate/.test(unpub),
    "a machine whose files differ is no longer labelled up to date");
  say(/upd\.differs/.test(unpub), "it is labelled as what it is");
  say(!/chip\.classList\.add\("is-ok"\)/.test(unpub), "and not in the colour that means all is well");
}

/* --------------------------------------------------------------- */
console.log("\n=== every new sentence exists in all three languages ===");
{
  const want = ["differs", "repair_btn", "repair_hint", "repair_confirm", "repair_running",
    "repair_wait", "repair_done", "repair_failed", "inst_restarting",
    "engine_stale_title", "engine_stale_body"];
  for (const code of Object.keys(PACKS)) {
    const missing = want.filter((k) => typeof PACKS[code].upd[k] !== "string" || !PACKS[code].upd[k].trim());
    say(missing.length === 0, code + " has all of them" + (missing.length ? " (missing " + missing.join(", ") + ")" : ""));
  }
}

/* --------------------------------------------------------------- */
console.log("\n=== an update can reach the files that start the product ===");
{
  const gh = require(path.join(ROOT, "backend", "src", "github-update.js"));
  /* Found while fixing a fault in start-aurion.cmd and realising the
     fix could never be delivered: INCLUDE_DIRS covers scripts/, but the
     launchers sit at the root of the tree and were in no shipped
     directory at all. The file the Windows shortcut actually runs, and
     the engine's own entry point, were both unfixable by update - for
     everyone, permanently. */
  for (const f of ["start-aurion.cmd", "stop-aurion.cmd", "engine/main.py", "engine/requirements.txt"]) {
    say(gh.isShippable(f), f + " can be delivered by an update");
  }
  /* And the lines that must stay out. A release that wrote these would
     take the machine's own state with it. */
  for (const f of ["config/aurion.json", "data/users.json", "data/license/state.json"]) {
    say(!gh.isShippable(f), f + " is still refused");
  }
  /* engine/strategies/ no longer exists in the tree, and a release
     must still never create it on a customer's disk. */
  say(!gh.isShippable("engine/strategies/my_strategy.py"),
    "a release never puts a strategy file back");
}

/* --------------------------------------------------------------- */
console.log("\n=== a user's strategy can no longer be anywhere at all ===");
{
  /* Four checks stood here, over the vault that kept an uploaded
     strategy outside the install tree so an upgrade could not take it.
     Custom strategies were removed from the product, so there is no
     uploaded strategy to protect and no vault to protect it with.

     The checks are not simply dropped. What they were defending - a
     release must never write over something that belongs to the
     machine rather than to the product - still holds, and is now
     asserted about what is left, plus the cleanup that removes the
     folders the feature left behind on a customer's disk. */
  const loader = read("engine/aurion/strategy/loader.py");
  say(!/sync_vault|save_upload|load_path/.test(loader),
    "the loader cannot read a strategy file at all any more");
  const cleanup = read("engine/aurion/strategy/cleanup.py");
  say(/DATA_DIR \/ "strategies"/.test(cleanup),
    "the vault a previous build created is deleted, not orphaned under data/");
  say(/def run_once\(/.test(cleanup) && /marker\.exists\(\)/.test(cleanup),
    "and that sweep runs once rather than on every boot");
  const trader = read("engine/aurion/runtime/trader.py");
  say(/run_once|_remove_custom_strategies/.test(trader),
    "the engine actually calls it on startup");
  /* The installer's own statement about what it owns. Still true, and
     still the reason data/ has to be cleaned up in code: the MSI will
     never go near it. */
  const wxs = read("installer/src/Package.wxs");
  say(/Schedule="afterInstallInitialize"/.test(wxs),
    "the upgrade removes the old product first, and still never touches data/");
}

if (failures.length) {
  console.log("\nupdate-takes-effect: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nupdate-takes-effect: " + pass + " checks passed");
