/**
 * Guard against losing a view renderer.
 *
 * A bad slice in a refactor once removed the entire `views` object - all
 * fourteen page renderers - from app.js. Everything still parsed, `node
 * --check` passed, and the desk booted to an empty stage with one
 * ReferenceError buried in a promise. This asserts the object exists and that
 * every view the navigation can reach has a renderer.
 *
 *     node apps/web/js/check-views.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "app.js"), "utf8");

const start = src.indexOf("\nconst views = {");
if (start < 0) {
  console.error("app.js no longer declares `const views` - every page would render empty.");
  process.exit(1);
}
const block = src.slice(start, src.indexOf("\n};", start));
const defined = new Set([...block.matchAll(/^  (\w+)\(\)/gm)].map((m) => m[1]));

// Every destination the navigation or a stored preference can ask for.
const required = [
  "command", "markets", "intelligence", "calendar", "strategies", "charts",
  "terminal", "backtest", "history", "upgrade", "settings", "about", "profile",
];
const missing = required.filter((v) => !defined.has(v));

if (missing.length) {
  console.error("views is missing renderers: " + missing.join(", "));
  process.exit(1);
}
console.log(`views defines ${defined.size} renderers; all ${required.length} required views present.`);
