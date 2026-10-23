/**
 * The admin panel, checked where it is cheap to check.
 *
 * Three surfaces were merged into one: the update panel, the Telegram
 * panel and a licence workflow that had no panel at all. The risk in a
 * merge like that is not that it fails loudly — it is that it quietly
 * grows a second copy of something, and the copies drift.
 *
 * So most of what follows asserts that the panel does NOT reimplement
 * the things it fronts.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const has = (p) => fs.existsSync(path.join(ROOT, p));

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const server = has("admin/panel/server.js") ? read("admin/panel/server.js") : "";
const page = has("admin/panel/public/index.html") ? read("admin/panel/public/index.html") : "";

/**
 * The code, without the prose.
 *
 * Checking "this file does not mention ed25519" against the raw text
 * failed on a comment that says the panel deliberately does not do
 * ed25519, and "it never binds 0.0.0.0" failed on the comment saying
 * never bind 0.0.0.0. A test that cannot tell an intention from an
 * implementation will keep punishing the explanation.
 */
const code = server
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/([^:])\/\/.*$/gm, "$1");

check("there is one panel", server.length > 0 && page.length > 0);

check("with one launcher on both platforms",
  has("admin/start-panel.cmd") && has("admin/start-panel.sh"));

// ---------------------------------------------------------------------------
// It fronts the three; it does not become them.
// ---------------------------------------------------------------------------

// Release storage and uploads belong to the update server. Two programs
// writing one data directory is not a design.
check("updates are proxied, not reimplemented",
  /AURION_UPDATE_URL/.test(server) &&
  /\/api\/admin\/updates/.test(server) &&
  !/multer|update_files/.test(code));

// The bot token must not reach this process, let alone the browser.
check("Telegram goes straight to the engine's own endpoint",
  /\/v1\/telegram\/admin/.test(server) &&
  !/bot_token|api\.telegram\.org/.test(code));

// Key minting is Ed25519 over a seed that exists in exactly one place.
// A second implementation in JavaScript is how two minters start
// disagreeing about what a valid key looks like.
check("licences are minted by the engine, not by the panel",
  /aurion\.license\.guard/.test(server) &&
  !/ed25519|nacl|tweetnacl/i.test(code));

check("and the seed is never written down or returned",
  /AURION_KEY_PRIVATE_HEX/.test(server) &&
  !/writeFileSync[^)]*PRIVATE/i.test(server) &&
  !/key_private/i.test(page));

// ---------------------------------------------------------------------------
// One door, one secret.
// ---------------------------------------------------------------------------

check("every route behind one token",
  /tokenOk\(req\.headers\["x-panel-token"\]\)/.test(server) &&
  /timingSafeEqual/.test(server));

// A panel that answers on 0.0.0.0 is a panel on the internet.
check("bound to the loopback, and not configurably",
  /const HOST = "127\.0\.0\.1"/.test(server) &&
  !/0\.0\.0\.0/.test(code));

check("the token is generated once and kept beside the panel",
  /panel\.token/.test(server) &&
  /randomBytes\(24\)/.test(server) &&
  /mode: 0o600/.test(server));

check("and it is gitignored",
  /admin\/panel\/panel\.token/.test(read(".gitignore")));

// ---------------------------------------------------------------------------
// Saying what is wrong, which is the whole reason the old panels failed.
// ---------------------------------------------------------------------------

// The update panel loaded fine and answered 401 to every button, with
// nothing on screen mentioning a token.
check("a backend that is not running is reported as that",
  /error: "not_running"/.test(server) &&
  /Nothing is answering at/.test(page));

check("a missing update token names itself rather than passing through a 401",
  /error: "no_update_token"/.test(server) &&
  /AURION_UPDATE_TOKEN is not set/.test(server) &&
  /no_update_token/.test(page));

check("a missing signing seed is reported before anyone presses Mint",
  /licences: \{ seed:/.test(server) &&
  /signing seed/.test(page));

// Python writes runpy warnings to the same stream the minter writes its
// notes to. A RuntimeWarning beside a freshly minted key reads as a fault.
check("the minter's output is cleaned before it is shown",
  /RuntimeWarning\|warnings\\\.warn\|sys\\\.modules/.test(server));

// ---------------------------------------------------------------------------
// The thing a reader of the Licences tab must not miss.
// ---------------------------------------------------------------------------

check("the offline-key trade-off is stated where the choice is made",
  /cannot be revoked or\s*\n?\s*machine-capped/.test(page.replace(/<[^>]+>/g, "")) ||
  /cannot be revoked/.test(page));

// ---------------------------------------------------------------------------
// The old doors still lead somewhere.
// ---------------------------------------------------------------------------

check("the old Telegram launcher redirects rather than rotting",
  /start-panel/.test(read("admin/start-telegram-panel.cmd")) &&
  /start-panel/.test(read("admin/start-telegram-panel.sh")));

check("the key server and seed generator exist for the licence flow",
  has("admin/start-keyserver.cmd") && has("admin/start-keyserver.sh") &&
  has("admin/new-seed.py"));

check("and the update server has the .env.example its launcher copies",
  has("admin/update-server/.env.example") &&
  /ADMIN_TOKEN/.test(read("admin/update-server/.env.example")));

// ---------------------------------------------------------------------------
// The token the user could not set.
//
// The launcher generated it inside an `if not exist (...)` block and
// read it back with %VAR% in the same block. cmd.exe substitutes that
// at parse time, before the block runs, so the file was written as a
// bare "ADMIN_TOKEN=" and the screen printed nothing after "token:".
// Every button in the panel then answered 401.
// ---------------------------------------------------------------------------

const launcher = read("admin/start-update-server.cmd");

check("the update launcher does not read a variable it set in the same block",
  !/for\s+\/f[^\n]*do set "?NEWTOK[\s\S]{0,400}?%NEWTOK%/i.test(launcher));

check("the token is made by a program that can also repair a broken .env",
  has("admin/update-server/ensure-env.js") &&
  /ensure-env\.js/.test(launcher) &&
  /ensure-env\.js/.test(read("admin/start-update-server.sh")));

const ensure = read("admin/update-server/ensure-env.js");
check("...which fills an ADMIN_TOKEN that exists but is empty",
  /repaired/.test(ensure) && /randomBytes/.test(ensure));

check("and prints nothing but the token on stdout, so a launcher can read it",
  /process\.stdout\.write\(result\.token/.test(ensure) &&
  /process\.stderr\.write/.test(ensure));

// Nobody should have to carry a secret between two consoles by hand.
check("the panel borrows the update token from the file that already holds it",
  /update-server[\\/"', ]+\.env/.test(code) || /"update-server",\s*"\.env"/.test(code));

check("the signing seed likewise comes from a file when it is not in the env",
  /seed\.key/.test(code) && /keyserver.*\.env|"keyserver",\s*"\.env"/.test(code));

check("an explicit environment variable still wins over both",
  /process\.env\.AURION_UPDATE_TOKEN\s*\|\|/.test(code) &&
  /process\.env\.AURION_KEY_PRIVATE_HEX\s*\|\|/.test(code));

check("the seed file is never committed",
  /admin\/panel\/seed\.key/.test(read(".gitignore")));

check("the minter is handed the seed even when it came from a file",
  /AURION_KEY_PRIVATE_HEX:\s*SEED\.seed/.test(code));

check("new-seed.py can save the seed where the panel looks for it",
  /--save/.test(read("admin/new-seed.py")) &&
  /panel.*seed\.key|"seed\.key"/.test(read("admin/new-seed.py")));

// ---------------------------------------------------------------------------
// Updating the build tree must also remove what the branch removed.
// ---------------------------------------------------------------------------

const upPs = read("scripts/update-build-tree.ps1");
const upSh = read("scripts/update-build-tree.sh");

check("the updater sweeps untracked leftovers as well as tracked deletions",
  /git clean -fd/.test(upPs) && /git clean -fd/.test(upSh));

check("but never the vendor bundle, node_modules, a .env or a token",
  ["installer/vendor", "node_modules", ".venv_dev", "*.env", "seed.key"]
    .every((k) => upPs.includes(k) && upSh.includes(k)));

check("and it says out loud which files are now gone",
  /deleted/i.test(upPs) && /deleted/i.test(upSh));

console.log(failed === 0
  ? "\nadmin panel: all checks passed"
  : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
