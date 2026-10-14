/**
 * Point an AURION build at your servers — before the MSI is built.
 *
 * This exists because of one fact that is easy to get wrong and
 * impossible to recover from afterwards:
 *
 *     The installer ships config/aurion.factory.json ONLY.
 *
 * config/aurion.json is the trader's live file; the engine creates it
 * from the factory copy on first run, which is what stops an upgrade
 * from overwriting their settings. So editing config/aurion.json on the
 * build machine changes nothing at all for the customer — their copy
 * was never built from it. Every address has to be in the FACTORY file
 * at build time, because you cannot touch their machine later.
 *
 *     node scripts/set-endpoints.mjs \
 *       --updates https://updates.example.com \
 *       --store   https://keys.example.com \
 *       --telegram 123456:AA...
 *
 *     node scripts/set-endpoints.mjs --show     (just report)
 *
 * Flags, all optional:
 *   --updates  <url>    update server      -> update_server.url
 *   --store    <url>    key/licence server -> license.keyserver_url
 *                                             license.store_url
 *   --telegram <token>  bot token          -> config/telegram.token
 *   --auto-check        let the desk check for updates by itself
 *   --local             allow 127.0.0.1 addresses (development only)
 *   --show              print what is set and change nothing
 *
 * It writes the factory file and the live file, so the build tree runs
 * with the same addresses it will ship.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY = path.join(ROOT, "config", "aurion.factory.json");
const LIVE = path.join(ROOT, "config", "aurion.json");
const TG_TOKEN = path.join(ROOT, "config", "telegram.token");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/* ------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
function flag(name) { return argv.includes("--" + name); }
function value(name) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
}

const want = {
  updates: value("updates"),
  store: value("store"),
  telegram: value("telegram"),
  autoCheck: flag("auto-check"),
  allowLocal: flag("local"),
  show: flag("show"),
};

/* ------------------------------------------------------------- checking */

const problems = [];
const notes = [];

function checkUrl(label, url) {
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(`${label}: "${url}" is not a URL. It needs the scheme too, e.g. https://keys.example.com`);
    return "";
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    problems.push(`${label}: only http and https work here, not ${parsed.protocol}`);
    return "";
  }
  const host = parsed.hostname;
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";

  if (isLocal && !want.allowLocal) {
    // The single most expensive mistake available here: it works
    // perfectly on the build machine and is dead on every customer's.
    problems.push(
      `${label}: ${host} means "this computer". On the customer's machine it `
      + `points at THEIR computer, where nothing is listening, so the feature `
      + `is silently off forever. Use the address your server answers on from `
      + `the internet. Pass --local if this build really is only for you.`
    );
    return "";
  }
  if (parsed.protocol === "http:" && !isLocal) {
    notes.push(`${label} is plain http — anyone on the path can read and alter it. https is worth the hour.`);
  }
  return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
}

function checkToken(token) {
  if (!token) return "";
  // Telegram tokens are "<bot id>:<35 chars>".
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) {
    problems.push(
      `--telegram: "${token.slice(0, 12)}…" does not look like a bot token. `
      + `BotFather gives you something like 7123456789:AAE...  (digits, a colon, 35 characters)`
    );
    return "";
  }
  return token;
}

/* ------------------------------------------------------------- the work */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function apply(cfg) {
  if (!cfg.update_server) cfg.update_server = { url: "", auto_check: false, interval_hours: 6 };
  if (!cfg.license) cfg.license = {};
  if (!cfg.telegram) cfg.telegram = {};

  if (want.updates) cfg.update_server.url = want.updates;
  if (want.autoCheck) cfg.update_server.auto_check = true;
  if (want.store) {
    cfg.license.keyserver_url = want.store;
    cfg.license.store_url = want.store;
  }
  if (want.telegram) cfg.telegram.enabled = true;
  return cfg;
}

function report(cfg) {
  const tgFile = fs.existsSync(TG_TOKEN);
  const rows = [
    ["update server", cfg.update_server?.url || "", "به‌روزرسانی — update_server.url"],
    ["auto check", String(cfg.update_server?.auto_check ?? false), "update_server.auto_check"],
    ["key server", cfg.license?.keyserver_url || "", "لایسنس — license.keyserver_url"],
    ["store page", cfg.license?.store_url || "", "license.store_url"],
    ["telegram", tgFile ? "config/telegram.token" : (cfg.telegram?.bot_token ? "aurion.factory.json" : ""), "ربات"],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v, why] of rows) {
    const set = v && v !== "false";
    console.log(
      "  " + k.padEnd(w) + "  "
      + (set ? C.cyan(v) : C.amber("not set"))
      + "  " + C.dim(why)
    );
  }
}

/* --------------------------------------------------------------- output */

console.log("");
console.log("  AURION endpoints");
console.log("  ----------------");

const factory = readJson(FACTORY);
if (!factory) {
  console.log(C.red("  config/aurion.factory.json is missing or not valid JSON. Nothing done."));
  process.exit(1);
}

if (want.show || argv.length === 0) {
  console.log(C.dim("  what the next MSI will carry (config/aurion.factory.json):"));
  console.log("");
  report(factory);
  console.log("");
  console.log(C.dim("  set them with:  node scripts/set-endpoints.mjs --updates <url> --store <url> --telegram <token>"));
  console.log("");
  process.exit(0);
}

want.updates = checkUrl("--updates", want.updates);
want.store = checkUrl("--store", want.store);
want.telegram = checkToken(want.telegram);

if (problems.length) {
  console.log("");
  for (const p of problems) console.log(C.red("  " + p));
  console.log("");
  console.log("  Nothing was written.");
  console.log("");
  process.exit(2);
}

writeJson(FACTORY, apply(factory));
console.log(C.green("  wrote config/aurion.factory.json") + C.dim("   (this is the copy the MSI ships)"));

const live = readJson(LIVE);
if (live) {
  writeJson(LIVE, apply(live));
  console.log(C.green("  wrote config/aurion.json") + C.dim("        (so this build tree runs the same way)"));
}

if (want.telegram) {
  fs.writeFileSync(TG_TOKEN, want.telegram + "\n", { mode: 0o600 });
  console.log(C.green("  wrote config/telegram.token") + C.dim("     (gitignored; staged into the MSI)"));
  notes.push(
    "the bot token travels inside every copy you ship, which is how the desk "
    + "talks to your bot without the trader supplying anything. Anyone who "
    + "unpacks an install can read it, so use a bot that only posts "
    + "notifications and owns nothing else."
  );
}

console.log("");
report(readJson(FACTORY));

if (notes.length) {
  console.log("");
  for (const n of notes) console.log(C.amber("  note: ") + n);
}

console.log("");
console.log("  Next:  powershell -ExecutionPolicy Bypass -File installer\\tools\\build-msi.ps1");
console.log("");
