/**
 * The MSI must not ship the web demo.
 *
 * installer/tools/stage.ps1 drops apps/web/demo/ and apps/web/js/demo.js from
 * the payload and strips the <script> tag that loads them out of the
 * installed index.html. That script only runs on a Windows build machine, so
 * the contract it depends on is unguarded everywhere else -- somebody can
 * reformat one line of index.html on a laptop and not find out until a
 * release build fails, or worse, until a trader's desk 404s on launch.
 *
 * This checks the two halves of that contract from here:
 *
 *   1. index.html still loads the demo the way stage.ps1 expects, by applying
 *      the very regex out of stage.ps1 to the real file.
 *   2. Nothing else in the shipped tree reaches for the demo, so removing it
 *      cannot break the installed desk.
 *
 * It is not a substitute for running the staging script. It is the part of
 * the staging script's assumptions that can be checked on any machine.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const stage = read("installer/tools/stage.ps1");
const index = read("apps/web/index.html");

// Lift the pattern out of stage.ps1 rather than copying it, so the two cannot
// drift apart without this failing.
const quoted = stage.match(/'(\(\?s\)[^']*demo\\\.js[^']*)'/);
check("stage.ps1 still carries the strip pattern", Boolean(quoted),
  quoted ? `${quoted[1].length} chars` : "not found in installer/tools/stage.ps1");

if (quoted) {
  // .NET and JS agree on everything this pattern uses; (?s) is the one
  // exception, and JS spells it with the s flag.
  const re = new RegExp(quoted[1].replace(/^\(\?s\)/, ""), "gs");
  const stripped = index.replace(re, "");

  check("the pattern matches the real index.html", stripped !== index,
    `${index.length} -> ${stripped.length} bytes`);
  check("stripping removes every demo reference",
    !/demo\.js|AURION_DEMO/.test(stripped),
    (stripped.match(/demo[\w.]*/gi) || []).slice(0, 3).join(" ") || "none left");
  check("stripping leaves the rest of the desk alone",
    ["js/app.js", "js/api.js", "js/charts.js", "js/i18n.js"].every((f) => stripped.includes(f)),
    "app, api, charts, i18n still loaded");
  check("stripping leaves valid-looking html",
    stripped.trimEnd().endsWith("</html>") && !/<script[^>]*>\s*$/.test(stripped));
}

check("stage.ps1 excludes the demo directory and script",
  /-ExcludeDirs @\("demo"\)/.test(stage) && /-ExcludeFiles @\("demo\.js"\)/.test(stage));

check("stage.ps1 excludes the fixture capture tool",
  /capture-demo-fixtures\.mjs/.test(stage));

check("the payload guard would catch a demo that slipped through",
  /Pattern = "demo\.js"/.test(stage) && /Pattern = "fixtures\.js"/.test(stage) &&
  /still references the demo/.test(stage));

// Nothing but index.html may mention the demo, or removing it breaks the
// installed desk in a way staging cannot see.
const shipped = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "demo") walk(rel); continue; }
    if (/\.(js|html|css|json)$/.test(e.name) && e.name !== "demo.js") shipped.push(rel);
  }
})("apps/web");

const strays = shipped.filter((f) => {
  if (f === path.join("apps", "web", "index.html")) return false;
  return /demo\.js|AURION_DEMO|demo\/fixtures/.test(read(f));
});
check("no other shipped file depends on the demo", strays.length === 0,
  strays.join(", ") || `${shipped.length} files scanned`);

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
