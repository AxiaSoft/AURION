/**
 * Catch calls to desk helpers that do not exist.
 *
 * A call to a function nobody defined - renderSettings() was the first
 * real case - is silent until a user clicks the control: the handler
 * throws, the click looks like it did nothing, and the UI only catches
 * up after some other render. `node --check` cannot see it, because it
 * is valid syntax.
 *
 *     node apps/web/js/check-calls.mjs
 *
 * Uses a real parser (acorn), so strings, template literals, comments and
 * regex literals can never be mistaken for code - a hand-rolled scanner got
 * that wrong in dozens of places before this existed.
 *
 * SCOPE MATTERS, and this checker learnt that the expensive way.
 *
 * It used to collect every binding anywhere in a file into one flat set
 * and ask only "does this name exist somewhere?". That is not the
 * question. startBacktest() called go("backtest"); no such helper has
 * ever existed on this desk, but four unrelated functions happen to
 * contain `const go = ...` locals, so the flat set said yes and the
 * check passed. The call threw ReferenceError for every backtest
 * started from the calendar, and because it sat above the POST, no
 * backtest was run either.
 *
 * A name is now resolved up the chain of enclosing functions, so a
 * local in a function you are not inside cannot vouch for you.
 *
 * Block scoping inside one function is deliberately NOT modelled: a
 * `let` in a sibling block still counts. Being exact there would buy
 * almost nothing - the failure mode it would catch is a temporal-dead-
 * zone error, which throws loudly on the first run - and would cost
 * false positives, which are what makes a checker get switched off.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["app.js", "skins.js", "themes.js", "calendar.js", "chart-series.js",
  "charts.js", "chart-tools.js", "api.js", "i18n.js"];

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

const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** Every file's top level shares one scope: these are scripts, not modules. */
const fileScope = { parent: null, names: new Set() };
const calls = [];

for (const file of FILES) {
  const code = readFileSync(join(here, file), "utf8");
  const tree = parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true });
  walk(tree, fileScope, file);
}

/**
 * Walk a subtree, creating a child scope at every function boundary.
 *
 * Done by hand rather than with acorn-walk because the bindings of a
 * function have to be collected BEFORE its body is walked - a helper
 * declared at the bottom of a file is callable from the top of it, and
 * so is a sibling function from inside another.
 */
function walk(node, scope, file) {
  if (FN.has(node.type)) {
    const inner = { parent: scope, names: new Set() };
    if (node.id) inner.names.add(node.id.name);       // a named expression can recurse
    node.params.forEach((p) => declarePattern(p, inner));
    if (node.body.type === "BlockStatement") hoist(node.body, inner);
    else collectCall(node.body, inner, file);          // concise arrow body
    for (const child of children(node.body)) walk(child, inner, file);
    if (node.body.type !== "BlockStatement") walk(node.body, inner, file);
    return;
  }
  collectCall(node, scope, file);
  for (const child of children(node)) walk(child, scope, file);
}

/**
 * Bindings a function body introduces, nested blocks included, nested
 * FUNCTIONS excluded - their bindings belong to their own scope.
 */
function hoist(node, scope) {
  for (const child of children(node)) {
    switch (child.type) {
      case "FunctionDeclaration":
        if (child.id) scope.names.add(child.id.name);
        continue;                                      // do not descend
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        continue;
      case "ClassDeclaration":
        if (child.id) scope.names.add(child.id.name);
        continue;
      case "VariableDeclarator":
        declarePattern(child.id, scope);
        break;
      case "CatchClause":
        declarePattern(child.param, scope);
        break;
      default:
        break;
    }
    hoist(child, scope);
  }
}

function declarePattern(pattern, scope) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier": scope.names.add(pattern.name); break;
    case "ObjectPattern": pattern.properties.forEach((p) => declarePattern(p.value || p.argument, scope)); break;
    case "ArrayPattern": pattern.elements.forEach((e) => declarePattern(e, scope)); break;
    case "AssignmentPattern": declarePattern(pattern.left, scope); break;
    case "RestElement": declarePattern(pattern.argument, scope); break;
    default: break;
  }
}

/** Direct calls by bare name: foo(...) - not obj.foo(...). */
function collectCall(node, scope, file) {
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    calls.push({ name: node.callee.name, file, line: node.loc.start.line, scope });
  }
}

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") out.push(item);
    } else if (value && typeof value.type === "string") {
      out.push(value);
    }
  }
  return out;
}

function resolves(name, scope) {
  for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
  return AMBIENT.has(name);
}

// The top-level scope is only complete once every file has been walked,
// so resolution happens here rather than during the walk.
hoistProgramLevel();

function hoistProgramLevel() {
  for (const file of FILES) {
    const code = readFileSync(join(here, file), "utf8");
    const tree = parse(code, { ecmaVersion: "latest", sourceType: "script", locations: true });
    hoist(tree, fileScope);
  }
}

const missing = calls.filter((c) => !resolves(c.name, c.scope));

if (missing.length) {
  console.log("Calls to functions that are not defined in any enclosing scope:\n");
  for (const m of missing) console.log(`  ${m.file}:${m.line}  ${m.name}()`);
  console.log(`\n${missing.length} problem(s).`);
  process.exit(1);
}
console.log(`No calls to undefined helpers (${calls.length} call sites checked, scope-aware).`);
