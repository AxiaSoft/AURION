/* The language pack's cache token must match the packs it describes.
 *
 * This guards a failure that is completely silent in development and very
 * visible to a trader. i18n.js caches the fetched pack in localStorage and
 * only refreshes it when the build token on its own <script> tag changes.
 * Add a string, ship it, forget the token, and the desk keeps the old pack:
 * every new key renders as its own key. That is how "themes.wall_cut_dark"
 * ended up printed on a tile where "دارک" belonged.
 *
 * Nothing about the running code is wrong in that state, which is why no
 * other test caught it - the string exists in lang/fa.json, the lookup is
 * correct, and the desk simply never asks for the new file.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "apps", "web", "index.html");

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    pass++;
  } catch (e) {
    failures.push(name + " -> " + e.message);
  }
}

/* Reuse the generator itself rather than reimplementing the hash here: two
   copies of the same rule drift, and then the test passes while the desk
   is wrong. */
const mod = execFileSync(process.execPath, ["--input-type=module", "-e",
  `import {langToken} from ${JSON.stringify("file://" + path.join(ROOT, "scripts", "sync-lang-token.mjs"))};` +
  `process.stdout.write(langToken());`], { encoding: "utf8" });

const html = fs.readFileSync(INDEX, "utf8");
const have = (/js\/i18n\.js\?v=([^"']+)/.exec(html) || [])[1];

check("the desk loads a language pack token at all", () => {
  if (!have) throw new Error('index.html has no <script src="js/i18n.js?v=...">');
});

check("the token matches the current contents of lang/", () => {
  if (have !== mod) {
    throw new Error("index.html says " + have + " but lang/ hashes to " + mod +
      " - strings changed without the token. Run: node scripts/sync-lang-token.mjs" +
      " (without it, every new key renders as its own key on an existing install)");
  }
});

check("every language pack is valid JSON with the same shape", () => {
  const packs = fs.readdirSync(path.join(ROOT, "lang")).filter((f) => f.endsWith(".json"));
  if (packs.length < 3) throw new Error("expected en, fa and ar");
  const keysOf = (o, p) => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, p + k + ".") : [p + k]);
  const sets = packs.map((f) => ({
    name: f,
    keys: new Set(keysOf(JSON.parse(fs.readFileSync(path.join(ROOT, "lang", f), "utf8")), "")),
  }));
  const base = sets.find((s) => s.name === "en.json") || sets[0];
  sets.forEach((s) => {
    if (s === base) return;
    const missing = [...base.keys].filter((k) => !s.keys.has(k));
    if (missing.length) {
      throw new Error(s.name + " is missing " + missing.length + " key(s): " +
        missing.slice(0, 6).join(", "));
    }
  });
});

if (failures.length) {
  console.error("lang-token: " + failures.length + " FAILED of " + (pass + failures.length));
  failures.forEach((f) => console.error("  x " + f));
  process.exit(1);
}
console.log("lang-token: " + pass + " checks passed");
