/**
 * The shell scripts, checked the way powershell-syntax.test.cjs checks
 * the PowerShell ones.
 *
 * These are the first thing a machine that cannot yet run AURION runs,
 * so a broken one is not a typo - it is a phone or a server that
 * installs nothing and explains nothing. Unlike PowerShell, bash is
 * actually present here, so `bash -n` does the parsing properly rather
 * than a brace counter approximating it.
 *
 * The rest pins the decisions in scripts/start-termux.sh that are
 * invisible in the code and expensive to rediscover. Each one was
 * learned by watching the obvious version fail on a real device.
 *
 * Note on matching: assertions run against the script with comments
 * stripped. A grep for "python3.13" would otherwise match the comment
 * explaining why 3.13 is refused, and the test would pass against a
 * script that had lost the check entirely.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** Every tracked .sh file, wherever it lives. */
function shellScripts(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".venv") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) shellScripts(p, out);
    else if (e.name.endsWith(".sh")) out.push(p);
  }
  return out;
}

/* Strip comments so an assertion cannot be satisfied by the prose that
   describes the thing it is checking for. Quotes are left alone: a '#'
   inside a string is rare in these scripts and dropping the line would
   be worse than keeping it. */
function code(src) {
  return src
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s#\s.*$/, "")))
    .join("\n");
}

/* ---- every script parses ---- */

const scripts = shellScripts(ROOT);
check("there are shell scripts to check", scripts.length > 0, String(scripts.length));

for (const p of scripts) {
  const rel = path.relative(ROOT, p);
  let ok = true;
  let detail = "";
  try {
    execFileSync("bash", ["-n", p], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    ok = false;
    detail = String((err.stderr || "")).trim().split("\n")[0];
  }
  check(`${rel} parses`, ok, detail);
}

/* ---- the Termux launcher's reasoning ---- */

const TERMUX = path.join(ROOT, "scripts", "start-termux.sh");
check("scripts/start-termux.sh exists", fs.existsSync(TERMUX));

if (fs.existsSync(TERMUX)) {
  const raw = fs.readFileSync(TERMUX, "utf8");
  const src = code(raw);

  check("it is executable",
    Boolean(fs.statSync(TERMUX).mode & 0o111));

  /* The whole point of the script. Termux's platform tag is
     aarch64-linux-android, so no manylinux wheel will install and
     pydantic-core cannot even build - rustup publishes no such target.
     If a future edit "simplifies" this into a plain pip install, a
     phone gets a twenty-minute compile and then an error. */
  check("Termux is handed to a proot distro, not installed into directly",
    /proot-distro\s+login/.test(src) && /proot-distro\s+install/.test(src));

  /* Bound, not cloned: two copies means a git pull that updates the
     one you are not running. */
  check("the checkout is bind-mounted into the distro rather than re-cloned",
    /--bind\s+"\$ROOT:/.test(src) && !/git\s+clone/.test(src));

  /* exec, so the Termux shell is replaced rather than left waiting
     around holding a second process group over the real one. */
  check("it execs into the distro",
    /exec\s+proot-distro\s+login/.test(src));

  /* There must be no upper bound on the interpreter.
     
     This is the inverse of the assertion that used to live here. The
     cap at 3.12 was a proxy for NumPy's x86-64-v2 baseline, which is
     an x86 concern; engine/requirements.txt states that with markers
     now, so capping the version here would re-impose on every
     architecture a limit that applies to one - and would again make
     AURION uninstallable on the current Debian, which ships 3.13. */
  check("the interpreter has no upper version bound",
    !/version_info\s*<\s*\(3,\s*1[3-9]\)/.test(src)
    && !/sys\.exit\(0 if[^)]*<[^)]*\(3,\s*1[3-9]\)/.test(src));
  check("...but still requires at least 3.9",
    /-ge\s+309/.test(src));
  check("...and plain python3 is a candidate, so a release newer than any listed is found",
    /for cand in python3\s/.test(src));

  /* Detection by filesystem, not by parsing another tool's output.
     The grep against `proot-distro list --installed` did not match on
     a real device, so the script tried to install a container that
     already existed and set -e killed the run. */
  check("an existing container is detected from the filesystem",
    /installed-rootfs/.test(src) && !/proot-distro list --installed/.test(src));
  check("...and a redundant install cannot abort the run",
    /proot-distro install "\$DISTRO" \|\| true/.test(src));

  /* Android shared storage has no exec bit and no symlinks, so a venv
     and node_modules cannot live in a repository kept there - which
     is exactly where someone who wants to see their files puts it. */
  check("installability is probed by trying, not by matching the path",
    /can_install_into/.test(src)
    && /ln -s/.test(src)
    && /chmod \+x/.test(src)
    && !/\/storage\/emulated/.test(src));
  check("...and the environment relocates off it rather than refusing",
    /VENV="\$WORK\/venv"/.test(src) && /NPM_PREFIX/.test(src));
  check("...using the parent directory for node, which node searches anyway",
    /NPM_PREFIX="\$\(dirname "\$ROOT"\)"/.test(src));
  check("...and the SQLite tree moves too",
    /AURION_DATA_DIR="\$\{AURION_DATA_DIR:-\$WORK\/data\}"/.test(src));

  /* A phone's engine takes the better part of a minute to import
     numpy, pandas and sklearn. Starting the desk first leaves the
     browser on "Waiting for the engine..." with nothing to act on. */
  check("the desk waits for the engine's /health before starting",
    src.indexOf("/health") > 0
    && src.indexOf("/health") < src.indexOf("node backend/src/index.js"));

  /* And a dead engine must be noticed at once rather than waited out
     for the full budget, with its log shown. */
  check("a crashed engine is detected and its log printed",
    /kill\s+-0\s+"\$ENGINE_PID"/.test(src) && /tail\s+-n\s+40\s+"\$ENGINE_LOG"/.test(src));

  check("both children are killed on the way out",
    /trap\s+cleanup\s+EXIT\s+INT\s+TERM/.test(src));

  /* Android suspends the process group when the screen goes off, which
     would stop the engine mid-trade. */
  check("a wake lock is taken on Termux",
    /termux-wake-lock/.test(src));

  /* The setup stamp has to live somewhere git ignores, or every run
     dirties the tree. .venv/ is ignored; data/ is only ignored file by
     file. */
  check("the setup stamp is written inside the ignored .venv",
    /STAMP="\$VENV\//.test(src));

  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  check("...and .venv really is ignored",
    /^\.venv\/?$/m.test(ignore));

  check("it fails loudly rather than continuing",
    /set -euo pipefail/.test(src));
}

/* ---- report ---- */

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`shell-syntax: ${failed.length} FAILED`);
  process.exit(1);
}
console.log(`shell-syntax: all ${results.length} checks passed`);
