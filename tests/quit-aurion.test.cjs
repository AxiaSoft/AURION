/**
 * Quitting AURION, and being told that it is quitting.
 *
 * Three complaints and a bug, all of them about the same thing - the
 * product and the window being two different ideas of "running":
 *
 *   1. Pressing the X stopped the window and said nothing while it
 *      stopped everything else. The desk sat there looking live over
 *      an engine that was already going down.
 *   2. "End task" had to tear the whole thing down with no question
 *      asked - a kill is not a request.
 *   3. There was no way to quit from inside AURION at all. The only
 *      way out of the product was a Windows control that belongs to
 *      the window, not to the product.
 *   4. After a reset or an F5, the engine never came back - and the
 *      desk never came back with it. Only closing AURION helped,
 *      which is the one thing a stuck trader should not have to do.
 *
 * (4) was the supervisor: after five failed starts it gave up for
 * good, and nothing short of a new desk process cleared that. A
 * reload is a person saying "go on, then", so a reload now clears it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const APP = read("apps/web/js/app.js");
const CSS = read("apps/web/css/app.css");
const INDEX = read("backend/src/index.js");
const SUP = read("backend/src/engine-supervisor.js");
const WINDOW = read("installer/window/AppWindow.cs");
const EN = JSON.parse(read("lang/en.json"));
const FA = JSON.parse(read("lang/fa.json"));
const AR = JSON.parse(read("lang/ar.json"));

let pass = 0;
let fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log("ok   " + what); }
  else { fail++; console.log("  x  " + what); }
}
function section(t) { console.log("\n— " + t + "\n"); }

/** The body of a function, from its signature to the next top-level close. */
function body(src, signature, endMarker) {
  const at = src.indexOf(signature);
  if (at < 0) return "";
  const end = src.indexOf(endMarker || "\n}\n", at);
  return src.slice(at, end < 0 ? src.length : end);
}

// ------------------------------------------------------- 1. it says so

section("1. closing the window says so, on the desk, while it happens");

ok(/function showShutdownScreen\(reason\)/.test(APP),
  "there is one shutdown screen, and one function that raises it");

{
  const b = body(APP, "function showShutdownScreen(reason)");
  ok(/S\._shuttingDown = true/.test(b),
    "raising it latches: a shutdown is not something to come back from");
  ok(/I18N\.t\("quit\.stopping"\)/.test(b),
    "it is written in the trader's language, not in English only");
  ok(/S\.live && typeof S\.live\.close/.test(b),
    "the live feed is closed - it is part of what is stopping");
  ok(/clearInterval\(S\._poll\)/.test(b) && /clearInterval\(S\._engineWatch\)/.test(b),
    "and the pollers stop, so a dying desk is not reported as a fault");
}

ok(/msg\.type === "shutdown"/.test(APP) && /showShutdownScreen\(msg\.reason/.test(APP),
  "the window's X reaches it through the host bridge");

{
  const b = body(APP, "function bindHostBridge", "\n}\n\n");
  ok(b.indexOf("shutdown") > 0, "...handled where every other host message is handled");
}

ok(/private void TellDeskWeAreStopping\(string reason\)/.test(WINDOW),
  "the window has one way to tell the desk, and uses it");
{
  const b = body(WINDOW, "private void TellDeskWeAreStopping", "\n    }\n");
  ok(/PostWebMessageAsString/.test(b) && !/await|\.Wait\(/.test(b),
    "posted and never waited on - a wedged page cannot delay a shutdown");
  ok(/catch/.test(b), "and a view that never started is not an error here");
}

// --------------------------------------------- 2. a kill is not a question

section("2. End task tears it down, with nothing asked");

{
  const at = WINDOW.indexOf("private async void OnFormClosing");
  const b = WINDOW.slice(at, WINDOW.indexOf("\n    }\n", WINDOW.indexOf("Close();", at)));
  ok(/CloseReason\.TaskManagerClosing/.test(b),
    "'End task' is recognised as what it is");
  ok(/var forced = [^;]*TaskManagerClosing/.test(b) || /TaskManagerClosing;/.test(b),
    "...and grouped with the other closes nobody is asking about");
  const forcedAt = b.indexOf("if (forced)");
  const askAt = b.indexOf("AskToShutDown()");
  ok(forcedAt > 0 && askAt > forcedAt,
    "the forced branch returns before any question is put");
  ok(/StopAurionNow\(hard: true\)/.test(b),
    "and it stops AURION hard rather than politely");
}

// ------------------------------------------- 3. the same door, from inside

section("3. the power button in the menu is the X, from the other side");

ok(/power: '<path/.test(APP), "there is a power icon, drawn like the rest of them");
ok(/icon\("power"\)/.test(APP), "and the menu entry uses it");
ok(/id="nav-quit"/.test(APP), "the entry is in the nav foot, away from the ten daily buttons");
ok(/quitBtn\.onclick = \(\) => \{ setMenu\(false\); quitAurion\(\); \}/.test(APP),
  "pressing it quits AURION");
ok(!/\["quit",/.test(APP.slice(APP.indexOf("const NAV"), APP.indexOf("const NAV") + 1200)),
  "it is not in NAV - every entry there is somewhere to go, this is the way out");

{
  const b = body(APP, "async function quitAurion()");
  ok(/if \(shuttingDown\(\)\) return;/.test(b),
    "pressing it twice does not start two shutdowns");
  ok(/await askConfirm\(/.test(b) && /danger: true/.test(b),
    "it asks first - it is not undoable and it lives among harmless buttons");
  const askAt = b.indexOf("askConfirm");
  const screenAt = b.indexOf("showShutdownScreen");
  const postAt = b.search(/postMessage|API\.post/);
  ok(askAt < screenAt && screenAt < postAt,
    "asked, then said, then done - the screen is up before the painter goes away");
  ok(/type: "shutdown"/.test(b),
    "inside the window the host is told, so the window closes too");
  ok(/API\.post\("\/api\/shutdown"/.test(b),
    "and in a browser the desk is asked directly");
  ok(/await waitUntilStopped\(\)/.test(b),
    "'asked it to stop' is not 'it stopped' - it waits for silence");
}

{
  const b = body(APP, "async function waitUntilStopped(budgetMs)");
  ok(/fetch\("\/api\/alive"/.test(b), "silence is measured against the desk itself");
  ok(/showStoppedScreen\(\)/.test(b), "and when it goes quiet, the screen says so");
  ok(/I18N\.t\("quit\.stuck"\)/.test(b),
    "a desk that will not stop is reported, not spun over for ever");
}

ok(/raw\.Contains\("\\"shutdown\\""\)/.test(WINDOW),
  "the host hears the desk's power button");
{
  const at = WINDOW.indexOf('raw.Contains("\\"shutdown\\"")');
  const b = WINDOW.slice(at, at + 400);
  ok(/_askedByDesk = true/.test(b), "...remembers that the trader has already been asked");
  ok(/BeginInvoke\(new Action\(Close\)\)/.test(b),
    "and closes the window, which runs the one shutdown path there is");
}
ok(/var answer = _askedByDesk \? DialogResult\.Yes : AskToShutDown\(\);/.test(WINDOW),
  "so the question is never put twice, in two languages, over its own screen");

ok(/POST|post\("\/api\/shutdown"/.test(INDEX) || /app\.post\("\/api\/shutdown"/.test(INDEX),
  "the desk endpoint both paths end at still exists");

// --------------------------------- 4. a reset or an F5 brings it all back

section("4. after a reset or a refresh, the engine comes back");

ok(/GIVE_UP_REST_MS/.test(SUP),
  "giving up is now a rest, not a retirement");
{
  const b = body(SUP, "function resume(");
  ok(/misses = 0/.test(b) && /attempts = 0/.test(b) && /gaveUpAt = 0/.test(b),
    "resume clears every counter that was holding the engine down");
}
ok(/module\.exports = \{ start, stop, resume,/.test(SUP),
  "...and it is exported, so the desk can reach it");
{
  const b = body(SUP, "async function tick()");
  ok(/gaveUpAt/.test(b), "the give-up branch records when it happened");
}
{
  const at = INDEX.indexOf('"/api/meta"');
  const b = INDEX.slice(at, at + 1600);
  ok(/supervisor\.resume\(/.test(b),
    "a page opening - the first thing F5 does - un-sticks a supervisor that gave up");
  ok(/gave_up/.test(b),
    "...only when it HAD given up, so an ordinary reload cannot postpone a due restart");
  ok(/try \{/.test(b),
    "and it can never make /api/meta itself fail");
}
{
  const b = body(APP, "  if (retry) retry.onclick = async () => {", "\n  };\n");
  ok(/API\.get\("\/api\/meta"\)/.test(b),
    "'try again' on the key screen reaches the engine, not just the licence");
}

// --------------------------------------------------------------- strings

section("5. every word of it is translated");

const KEYS = ["menu", "title", "body", "confirm", "stopping", "stopping_sub",
  "stopped", "stopped_sub", "stuck", "stuck_sub"];
for (const [tag, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
  const quit = pack.quit || {};
  const missing = KEYS.filter((k) => !quit[k] || !String(quit[k]).trim());
  ok(missing.length === 0, `lang/${tag}.json carries every quit string` +
    (missing.length ? ` (missing: ${missing.join(", ")})` : ""));
}
ok(FA.quit.title !== EN.quit.title && AR.quit.title !== EN.quit.title,
  "...actually translated, not copied from English");
ok(/AURION/.test(EN.quit.body) && /بروکر/.test(FA.quit.body),
  "and the question says what stopping costs: the engine stops watching");

// ------------------------------------------------------------------- css

section("6. the screen covers everything, and cannot be dismissed");

ok(/\.shutdown-veil\{/.test(CSS), "the veil is styled");
{
  const at = CSS.indexOf(".shutdown-veil{");
  const b = CSS.slice(at, CSS.indexOf("}", at));
  ok(/position:fixed;inset:0/.test(b), "it covers the whole desk");
  const z = /z-index:(\d+)/.exec(b);
  ok(z && Number(z[1]) >= 900,
    "above the welcome curtain and the modals - nothing under it is true any more");
}
ok(/\.nav button\.nav-quit\{/.test(CSS),
  "the power button reads as different in kind from the navigation above it");
ok(/prefers-reduced-motion[\s\S]{0,160}sd-bar i\{animation:none/.test(CSS),
  "and the progress bar respects reduced motion");

// -------------------------------------------------------------- cache

section("7. the browser is told to fetch the new files");

const HTML = read("apps/web/index.html");
/* A floor, not a pin. These assert that the buster was bumped past
   the version that shipped this change - pinning the exact number
   means every later change to app.js fails an unrelated test about
   quitting, which has happened repeatedly. */
const jsBust = Number((HTML.match(/js\/app\.js\?v=desk(\d+)/) || [])[1] || 0);
const cssBust = Number((HTML.match(/css\/app\.css\?v=desk(\d+)/) || [])[1] || 0);
ok(jsBust >= 282, `app.js cache-buster bumped (desk${jsBust})`);
ok(cssBust >= 264, `app.css cache-buster bumped (desk${cssBust})`);

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
