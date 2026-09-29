/**
 * Catch calls to desk helpers that do not exist.
 *
 * A call to a function nobody defined - renderSettings() was the real case -
 * is silent until a user clicks the control: the handler throws, the click
 * looks like it did nothing, and the UI only catches up after some other
 * render. `node --check` cannot see it, because it is valid syntax.
 *
 *     node apps/web/js/check-calls.mjs
 *
 * Uses a real parser (acorn), so strings, template literals, comments and
 * regex literals can never be mistaken for code - a hand-rolled scanner got
 * that wrong in dozens of places before this existed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { simple, ancestor } from "acorn-walk";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["app.js", "skins.js", "themes.js", "calendar.js", "charts.js", "api.js", "i18n.js"];

// Globals the desk legitimately expects from the page or the platform.
const AMBIENT = new Set([
  "window", "document", "console", "localStorage", "sessionStorage", "navigator",
  "location", "history", "fetch", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
  "matchMedia", "alert", "confirm", "prompt", "parseInt", "parseFloat", "isNaN",
  "isFinite", "encodeURIComponent", "decodeURIComponent", "structuredClone",
  "queueMicrotask", "requestIdleCallback", "Math", "JSON", "Date", "Object", "Array",
  "String", "Number", "Boolean", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "RegExp", "Error", "TypeError", "Symbol", "Intl", "Blob", "File", "FileReader",
  "FormData", "URL", "URLSearchParams", "AbortController", "MutationObserver",
  "ResizeObserver", "IntersectionObserver", "Image", "Audio", "Event", "CustomEvent",
  "WebSocket", "XMLHttpRequest", "atob", "btoa", "performance", "crypto", "screen",
  "Notification", "globalThis", "undefined", "NaN", "Infinity",
]);

const declared = new Set();
const called = [];

for (const file of FILES) {
  const code = readFileSync(join(here, file), "utf8");
  const tree = parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true });

  // Every binding introduced anywhere in the file, at any depth.
  simple(tree, {
    FunctionDeclaration: (n) => { if (n.id) declared.add(n.id.name); n.params.forEach(collectPattern); },
    ClassDeclaration: (n) => n.id && declared.add(n.id.name),
    VariableDeclarator: (n) => collectPattern(n.id),
    // Parameters are bindings too: a Promise executor's resolve(), or a
    // callback passed a renderInner(), is defined - just not at file scope.
    FunctionExpression: (n) => { if (n.id) declared.add(n.id.name); n.params.forEach(collectPattern); },
    ArrowFunctionExpression: (n) => n.params.forEach(collectPattern),
    CatchClause: (n) => collectPattern(n.param),
    Property: (n) => { if (!n.computed && n.key.type === "Identifier") declared.add(n.key.name); },
    ImportDefaultSpecifier: (n) => declared.add(n.local.name),
    ImportSpecifier: (n) => declared.add(n.local.name),
  });

  // Direct calls by bare name: foo(...) - not obj.foo(...)
  ancestor(tree, {
    CallExpression(node) {
      if (node.callee.type === "Identifier") {
        called.push({ name: node.callee.name, file, line: node.loc.start.line });
      }
    },
  });
}

function collectPattern(pattern) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier": declared.add(pattern.name); break;
    case "ObjectPattern": pattern.properties.forEach((p) => collectPattern(p.value || p.argument)); break;
    case "ArrayPattern": pattern.elements.forEach(collectPattern); break;
    case "AssignmentPattern": collectPattern(pattern.left); break;
    case "RestElement": collectPattern(pattern.argument); break;
  }
}

const missing = called.filter((c) => !declared.has(c.name) && !AMBIENT.has(c.name));

if (missing.length) {
  console.log("Calls to functions that are never defined:\n");
  for (const m of missing) console.log(`  ${m.file}:${m.line}  ${m.name}()`);
  console.log(`\n${missing.length} problem(s).`);
  process.exit(1);
}
console.log(`No calls to undefined helpers (${called.length} call sites checked).`);
