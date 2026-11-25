/* The desk's answer to "is this the same instrument" must be the
 * engine's answer.
 *
 * Phase zero of making the engine the single source of truth. Some
 * rules cannot simply be asked for over HTTP - this one is consulted
 * while a stop is being dragged, and a round trip per mouse move is
 * not something to ship - so it exists in both languages on purpose.
 * What must not happen is the two copies drifting.
 *
 * So the cases live in one file, tests/fixtures/symbol-identity.json,
 * and both implementations are tested against it. The Python half is
 * engine/tests/test_symbol_identity_agrees.py. Adding a case to the
 * fixture is how the rule changes; it then has to pass on both sides
 * or one of them goes red.
 *
 * The case this was written for: the desk used to cut a symbol at the
 * first non-alphanumeric character, so CL.F25 and CL.G25 - two
 * different dated futures - shared one contract specification, and
 * the tick value of the wrong contract priced every stop on the
 * right one.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/symbol-identity.json"), "utf8"));

let ok_ = 0, bad = 0;
function ok(cond, what) {
  if (cond) { ok_ += 1; console.log("ok   " + what); }
  else { bad += 1; console.log("  x  " + what); }
}

function liftFn(name) {
  const at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name + " in app.js");
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j += 1) {
    if (APP[j] === "{") depth += 1;
    else if (APP[j] === "}") { depth -= 1; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unterminated " + name);
}

/* The real functions, lifted out of the real file. */
const box = { String, Boolean, console };
vm.createContext(box);
vm.runInContext(
  liftFn("symbolSeriesKey") + "\n" + liftFn("sameSeriesSymbol")
  + "\nthis.sameSeriesSymbol = sameSeriesSymbol;"
  + "\nthis.symbolSeriesKey = symbolSeriesKey;", box);

console.log("— the shared case table");

for (const [a, b] of CASES.same) {
  ok(box.sameSeriesSymbol(a, b) === true,
    `"${a}" and "${b}" are the same instrument`);
}
for (const [a, b] of CASES.different) {
  ok(box.sameSeriesSymbol(a, b) === false,
    `"${a}" and "${b}" are NOT the same instrument`);
}

console.log("\n— the rule is symmetric and total");
for (const [a, b] of [...CASES.same, ...CASES.different]) {
  /* A relation that answers differently depending on which argument
     came first would make the spec a ticket gets depend on the order
     the broker's book happened to be in. */
  ok(box.sameSeriesSymbol(a, b) === box.sameSeriesSymbol(b, a),
    `the answer for "${a}"/"${b}" does not depend on the order`);
}

console.log("\n— the desk actually uses it");
{
  const spec = (() => {
    const at = APP.indexOf("function specFor(");
    return APP.slice(at, APP.indexOf("\n}", at));
  })();
  ok(/sameSeriesSymbol\(/.test(spec),
    "specFor matches a contract specification by the shared rule");
  ok(!/replace\(\/\[\^A-Z0-9\]\.\*\$\//.test(spec),
    "...and no longer by cutting the name at the first separator");
}

console.log("\n" + ok_ + " ok, " + bad + " failed");
process.exit(bad ? 1 : 0);
