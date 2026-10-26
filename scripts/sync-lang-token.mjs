/* Keep the language pack's cache token honest.
 *
 * i18n.js fetches lang/<code>.json, which has no version in its name, and
 * caches the result in localStorage. To know when that cache is stale it
 * borrows the build token from its own <script src="js/i18n.js?v=...">
 * tag - so a desk only picks up new or changed strings when THAT token
 * changes.
 *
 * Adding strings without touching the token is therefore invisible: the
 * desk keeps serving yesterday's pack and every new key renders as its own
 * key, which is exactly what shipped once already ("themes.wall_cut_dark"
 * appearing on screen instead of "دارک").
 *
 * Deriving the token from the content of the packs removes the chance to
 * forget. Run this after editing anything under lang/; the test in
 * tests/lang-token.test.js fails the build if it was not run.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANG = join(ROOT, "lang");
const INDEX = join(ROOT, "apps", "web", "index.html");

export function langToken() {
  const files = readdirSync(LANG).filter((f) => f.endsWith(".json")).sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    /* Hash the PARSED pack re-serialised, not the raw bytes, so that
       reindenting a file does not invalidate every trader's cache while a
       real change to a string always does. */
    h.update(JSON.stringify(JSON.parse(readFileSync(join(LANG, f), "utf8"))));
  }
  return "lang" + h.digest("hex").slice(0, 10);
}

export function currentToken(html) {
  const m = /js\/i18n\.js\?v=([^"']+)/.exec(html);
  return m ? m[1] : null;
}

if (process.argv[1] && process.argv[1].endsWith("sync-lang-token.mjs")) {
  const want = langToken();
  const html = readFileSync(INDEX, "utf8");
  const have = currentToken(html);
  if (have === want) {
    console.log("lang token already current: " + want);
  } else {
    writeFileSync(INDEX, html.replace(/js\/i18n\.js\?v=[^"']+/, "js/i18n.js?v=" + want));
    console.log("lang token " + have + " -> " + want);
  }
}
