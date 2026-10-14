/**
 * What the customer's copy is actually born with.
 *
 * The installer ships config/aurion.factory.json and nothing else from
 * config/: the engine creates the live aurion.json from it on first
 * run, which is what stops an upgrade from overwriting a trader's
 * settings. The consequence catches everyone out exactly once —
 *
 *     editing config/aurion.json on the build machine changes
 *     nothing whatsoever for the customer.
 *
 * — and there is no way to fix it afterwards, because nobody can touch
 * their machine. So the three addresses that connect an install to its
 * owner's servers have to be in the FACTORY file, and the build has to
 * carry the bot token.
 *
 * These checks are about that, and about set-endpoints.mjs refusing the
 * one mistake that cannot be noticed: a localhost address, which works
 * perfectly on the build machine and is dead everywhere else.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const factory = JSON.parse(read("config/aurion.factory.json"));

/* --------------------------------------------- the settings must exist */

check("the factory config has an update server section",
  Boolean(factory.update_server) && "url" in factory.update_server,
  JSON.stringify(factory.update_server || null));

check("...with auto-check off until someone asks for it",
  factory.update_server.auto_check === false);

check("the factory config has the licence endpoints",
  "keyserver_url" in (factory.license || {}) && "store_url" in (factory.license || {}));

// Shipping a build pointed at the author's own machine is the failure
// this whole file exists to prevent, so the defaults are empty, not
// localhost.
const addresses = [
  factory.update_server.url,
  factory.license.keyserver_url,
  factory.license.store_url,
];
check("and none of them defaults to a local address",
  addresses.every((u) => !/127\.0\.0\.1|localhost/.test(String(u))),
  addresses.filter((u) => /127\.0\.0\.1|localhost/.test(String(u))).join(", "));

/* ------------------------------------------------- the token travels */

const stage = read("installer/tools/stage.ps1");
check("the build stages config/telegram.token when there is one",
  /telegram\.token"/.test(stage) && /Copy-Item \$tgToken/.test(stage));

check("...and says so either way, since a silent omission turns the bot off",
  /telegram\.token included/.test(stage) && /will be off on the installed copy/.test(stage));

check("the token is never committed",
  /^config\/telegram\.token$/m.test(read(".gitignore")));

/* ----------------------------------------------- the provisioning tool */

const tool = "scripts/set-endpoints.mjs";
check("there is one command that sets all of it", fs.existsSync(path.join(ROOT, tool)));

function run(args) {
  try {
    const out = execFileSync(process.execPath, [tool, ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || "") + String(err.stderr || "") };
  }
}

const before = read("config/aurion.factory.json");

const shown = run(["--show"]);
check("--show reports without changing anything",
  shown.code === 0 && read("config/aurion.factory.json") === before);

const local = run(["--updates", "http://127.0.0.1:8898"]);
check("a localhost address is refused, with the reason",
  local.code === 2 && /means "this computer"/.test(local.out), local.out.slice(0, 120));

const badToken = run(["--telegram", "not-a-token"]);
check("a mistyped bot token is refused before it reaches a build",
  badToken.code === 2 && /BotFather/.test(badToken.out));

const notUrl = run(["--store", "keys.example.com"]);
check("an address with no scheme is refused rather than half-working",
  notUrl.code === 2 && /is not a URL/.test(notUrl.out));

check("and a refusal writes nothing",
  read("config/aurion.factory.json") === before);

/* ------------------------------------------------------ and it is said */

const guide = read("AURION-GUIDE.html");
check("the guide tells you these go in the factory file, before the build",
  /update_server\.url/.test(guide)
  && /aurion\.factory\.json/.test(guide)
  && /set-endpoints/.test(guide));

console.log(failed === 0
  ? "\nendpoints: all checks passed"
  : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
