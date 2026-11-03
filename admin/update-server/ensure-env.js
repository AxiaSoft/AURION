/* AURION — make sure update-server/.env exists and has a real token.
 *
 * Why this is a program and not four lines in the .cmd launcher:
 *
 * The launcher used to generate the token inside an `if not exist (...)`
 * block, like this:
 *
 *     if not exist "update-server\.env" (
 *       for /f %%T in ('powershell ...') do set "NEWTOK=%%T"
 *       >"update-server\.env" echo ADMIN_TOKEN=%NEWTOK%
 *       echo   Admin token: %NEWTOK%
 *     )
 *
 * cmd.exe substitutes %NEWTOK% when it PARSES the block, which is before
 * the `for` inside it has run. So both lines saw an empty variable: the
 * file was written as a bare "ADMIN_TOKEN=" and the screen said
 * "Admin token:" with nothing after it. The server then started with no
 * token, the panel loaded, and every button answered 401 — which is
 * exactly the "I run start-update-server and get something else, and I
 * could not set the token" report.
 *
 * Doing it in Node also means the file can be REPAIRED rather than only
 * created: a .env left over from the broken launcher has an empty
 * ADMIN_TOKEN, and "if not exist" would never touch it again.
 *
 *     node ensure-env.js            # ensure, explain on stderr
 *     node ensure-env.js --quiet    # ensure, say nothing
 *
 * stdout is always exactly the token, so a launcher can capture it.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HERE = __dirname;
const ENV_FILE = path.join(HERE, ".env");

const DEFAULTS = {
  ADMIN_TOKEN: "",                               // filled in below
  ADMIN_PANEL_HASH: "aurion-update-admin-x9k3",
  PORT: "8898",
  DATA_DIR: "data",
};

/** Parse a .env into [key, value, rawLine] triples, keeping comments. */
function readEnv(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { lines: [], values: {} };
  }
  const lines = text.split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { lines, values };
}

/** Rewrite the file so every wanted key is present exactly once. */
function writeEnv(file, lines, values) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) { out.push(line); continue; }
    const key = m[1];
    if (seen.has(key)) continue;                 // drop duplicates
    seen.add(key);
    out.push(`${key}=${values[key] !== undefined ? values[key] : ""}`);
  }
  for (const key of Object.keys(values)) {
    if (!seen.has(key)) out.push(`${key}=${values[key]}`);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  fs.writeFileSync(file, out.join("\n") + "\n", { mode: 0o600 });
}

function ensure() {
  const { lines, values } = readEnv(ENV_FILE);
  const existed = fs.existsSync(ENV_FILE);
  const before = values.ADMIN_TOKEN || "";
  let changed = false;

  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (!String(values[key] || "").trim() && fallback) {
      values[key] = fallback;
      changed = true;
    }
  }
  if (!String(values.ADMIN_TOKEN || "").trim()) {
    values.ADMIN_TOKEN = crypto.randomBytes(16).toString("hex");
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(path.join(HERE, values.DATA_DIR || "data"), { recursive: true });
    writeEnv(ENV_FILE, lines, values);
  }

  return {
    token: values.ADMIN_TOKEN,
    hash: values.ADMIN_PANEL_HASH,
    port: values.PORT,
    state: !existed ? "created" : (before ? "kept" : "repaired"),
  };
}

const result = ensure();

if (!process.argv.includes("--quiet")) {
  const say = (t) => process.stderr.write(t + "\n");
  const where = path.relative(path.resolve(HERE, "..", ".."), ENV_FILE)
    .replace(/\//g, path.sep);
  say("");
  if (result.state === "created") {
    say("  Wrote " + where + " with a new admin token.");
  } else if (result.state === "repaired") {
    say("  " + where + " had no ADMIN_TOKEN in it — that is why every");
    say("  button in the panel answered 401. Put a new one in.");
  } else {
    say("  Using the admin token already in " + where + ".");
  }
  say("");
  say("  ADMIN TOKEN   " + result.token);
  say("");
  say("  Anyone holding it can publish an update to every installed AURION.");
  say("  You do not have to type it anywhere: admin/panel reads this same");
  say("  file. Set AURION_UPDATE_TOKEN only if the panel runs elsewhere.");
  say("");
}

process.stdout.write(result.token + "\n");
