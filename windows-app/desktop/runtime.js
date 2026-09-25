"use strict";

/**
 * Shared runtime helpers for the AURION Windows app.
 *
 * Everything in here exists because of a concrete constraint in this tree:
 *
 *  - engine/main.py exits(2) on Windows when CPython >= 3.13 is used and
 *    engine/requirements.txt pins numpy==1.26.4, whose wheels only exist for
 *    CPython 3.9-3.12.  So the app must never select 3.13/3.14, and must use
 *    the SAME interpreter for pip and for launching the engine.
 *  - A packaged Electron app inherits the PATH it was started with.  When the
 *    bundled installer has just put Python/Node on the machine PATH, the
 *    running process still cannot see them, so PATH is re-read from the
 *    registry before every lookup (start-aurion.cmd does the same in
 *    :REFRESHPATH).
 *  - "py.exe" is a launcher that spawns the real python.exe as a child, so
 *    killing the launcher leaves the engine bound to port 18765.  Cleanup has
 *    to kill the whole tree.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

// engine/main.py refuses 3.13+ on Windows; numpy 1.26.4 has no 3.13 wheels.
const PY_VERSIONS = ["3.12", "3.11", "3.10"];
const NODE_MIN_MAJOR = 18;
const NODE_MAX_MAJOR = 30;
const DESK_PORTS = [8080, 18765, 18766];

let pathRefreshed = false;

function isWindows() {
  return process.platform === "win32";
}

function knownInstallDirs() {
  if (!isWindows()) return [];
  const la = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const dirs = [
    path.join(la, "Programs", "Python", "Python312"),
    path.join(la, "Programs", "Python", "Python312", "Scripts"),
    path.join(la, "Programs", "Python", "Python311"),
    path.join(la, "Programs", "Python", "Python311", "Scripts"),
    path.join(la, "Programs", "Python", "Python310"),
    path.join(la, "Programs", "Python", "Python310", "Scripts"),
    path.join(la, "Programs", "Python", "Launcher"),
    path.join(pf, "Python312"),
    path.join(pf, "Python312", "Scripts"),
    path.join(pf, "nodejs"),
    path.join(pf86, "nodejs"),
    path.join(la, "Programs", "nodejs"),
  ];
  return dirs.filter((d) => d && d !== path.join("", "nodejs"));
}

/**
 * Merge Machine + User PATH (and the well known install dirs) into this
 * process.  Idempotent; call with force=true after an install finished.
 */
function refreshPath(force = false) {
  if (pathRefreshed && !force) return process.env.PATH || "";
  pathRefreshed = true;
  if (!isWindows()) return process.env.PATH || "";

  let registryPath = "";
  try {
    registryPath = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true }
    );
  } catch {
    registryPath = "";
  }

  const merged = [];
  const seen = new Set();
  for (const chunk of [registryPath, process.env.PATH || "", knownInstallDirs().join(";")]) {
    for (const raw of String(chunk || "").split(";")) {
      const part = raw.trim();
      if (!part) continue;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
  }
  process.env.PATH = merged.join(";");
  return process.env.PATH;
}

function runQuiet(cmd, args, timeout) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: timeout || 10000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Resolve a supported interpreter.  Returns { cmd, prefix, version, label }
 * or null.  3.12 is preferred because that is what start-aurion.cmd calls.
 */
function findPython() {
  refreshPath();
  if (isWindows()) {
    for (const ver of PY_VERSIONS) {
      try {
        const out = runQuiet("py", [`-${ver}`, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], 10000);
        if (String(out).trim() === ver) {
          return { cmd: "py", prefix: [`-${ver}`], version: ver, label: `py -${ver}` };
        }
      } catch { /* try the next one */ }
    }
  }
  const exe = isWindows() ? "python" : "python3";
  try {
    const out = runQuiet(exe, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], 10000);
    const ver = String(out).trim();
    // Never hand back 3.13+: the engine aborts on it.
    if (PY_VERSIONS.includes(ver)) {
      return { cmd: exe, prefix: [], version: ver, label: `${exe} ${ver}` };
    }
  } catch { /* nothing usable */ }
  return null;
}

/** True when the interpreter can import the engine's runtime stack. */
function pythonHasPackages(py) {
  if (!py) return false;
  try {
    execFileSync(py.cmd, [...py.prefix, "-c", "import fastapi, numpy, pandas, sklearn"], {
      timeout: 60000,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to a usable node.exe (or null). */
function findNode() {
  refreshPath();
  const candidates = [];
  if (isWindows()) {
    try {
      const out = runQuiet("where", ["node"], 10000);
      for (const line of String(out).split(/\r?\n/)) {
        const t = line.trim();
        if (t) candidates.push(t);
      }
    } catch { /* fall through to the known dirs */ }
    for (const dir of knownInstallDirs()) {
      if (dir.toLowerCase().endsWith("nodejs")) candidates.push(path.join(dir, "node.exe"));
    }
  } else {
    candidates.push("node");
  }
  for (const cand of candidates) {
    try {
      if (cand !== "node" && !fs.existsSync(cand)) continue;
      const out = runQuiet(cand, ["-p", "process.versions.node.split('.')[0]"], 10000);
      const major = parseInt(String(out).trim(), 10);
      if (major >= NODE_MIN_MAJOR && major <= NODE_MAX_MAJOR) {
        return { exe: cand, major, version: String(out).trim() };
      }
    } catch { /* next candidate */ }
  }
  return null;
}

/** True when the desk's runtime dependencies are already unpacked. */
function hasDeskPackages(root) {
  for (const mod of ["express", "ws", "jsonwebtoken", "bcryptjs"]) {
    if (!fs.existsSync(path.join(root, "backend", "node_modules", mod))) return false;
  }
  return true;
}

/**
 * Kill a spawned process AND its children.  "py.exe" spawns python.exe, so a
 * plain kill() leaves the engine listening on 18765.
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (isWindows() && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 15000,
        stdio: "ignore",
      });
      return;
    } catch { /* fall back to kill() */ }
  }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

/**
 * Free the AURION ports, but only when the owner really is one of our own
 * processes.  Killing whatever happens to hold 8080 would take down unrelated
 * software the user is running.
 */
function freeStalePorts(ports) {
  if (!isWindows()) return 0;
  const list = (ports || DESK_PORTS).join(",");
  const script =
    "$own = @('node','python','pythonw','py');" +
    `$killed = 0;` +
    `foreach ($p in ${list}) {` +
    "  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object {" +
    "    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;" +
    "    if ($proc -and ($own -contains $proc.ProcessName.ToLower())) {" +
    "      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; $killed++" +
    "    }" +
    "  }" +
    "}" +
    "Write-Output $killed";
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 30000, windowsHide: true }
    );
    return parseInt(String(out).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Escape a value before it is interpolated into an HTML page. */
function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip secrets before a line reaches a log file. */
function redact(line) {
  return String(line || "")
    .replace(/code=\d{4,8}/gi, "code=***")
    .replace(/(password|passwd|pwd|token|secret|private_key|authorization)([=:])(\s*)(\S+)/gi, "$1$2$3***");
}

module.exports = {
  PY_VERSIONS,
  NODE_MIN_MAJOR,
  NODE_MAX_MAJOR,
  DESK_PORTS,
  isWindows,
  refreshPath,
  findPython,
  pythonHasPackages,
  findNode,
  hasDeskPackages,
  killTree,
  freeStalePorts,
  esc,
  redact,
};
