/* The desk's preview of the automatic cap must be what the engine will
 * actually do.
 *
 * Phase zero of making the engine the single source of truth. This rule
 * cannot be asked for over HTTP on every keystroke, so it exists in both
 * languages on purpose. What must not happen is the two copies drifting.
 *
 * The cases live in one file, tests/fixtures/auto-risk-cap.json, and both
 * implementations run against it. The Python half is
 * engine/tests/test_auto_risk_cap_agrees.py.
 *
 * The case this was written for: liveMoney() reused risk_pct_effective -
 * the engine's resolved answer for the SAVED percentage - as if it were a
 * ceiling on the percentage being typed. An answer is not a ceiling, so
 * the preview sat frozen at the saved value. On a 10,000 account with 1%
 * saved, typing 3% still drew a 100 cap while the engine would go on to
 * apply 300.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/auto-risk-cap.json"), "utf8"));

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
const box = { Number, Math, console };
vm.createContext(box);
vm.runInContext(
  [liftFn("roundMoney"), liftFn("autoRiskPct"), liftFn("autoRiskCap")].join("\n")
  + "\nthis.roundMoney = roundMoney;"
  + "\nthis.autoRiskPct = autoRiskPct;"
  + "\nthis.autoRiskCap = autoRiskCap;", box);

const D = FIX.defaults;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

console.log("\n— the shared case table ------------------------------------");

for (const c of FIX.cases) {
  const got = box.autoRiskCap(c.equity, c.typed, {
    risk_pct_min: D.risk_pct_min,
    risk_pct_max: D.risk_pct_max,
    risk_pct_cap: c.prop,
  });
  ok(near(got.pct, c.pct) && near(got.cap, c.cap),
    `${c.why}  —  ${c.equity} @ ${c.typed}% → ${got.pct}% / ${got.cap} `
    + (near(got.pct, c.pct) && near(got.cap, c.cap)
      ? "" : `(expected ${c.pct}% / ${c.cap})`));
}

console.log("\n— the preview has to MOVE with the field -------------------");

/* The regression itself, stated as behaviour rather than as a number:
   the whole purpose of a preview is that it answers for what is typed. */
{
  const bounds = { risk_pct_min: 0.05, risk_pct_max: 10, risk_pct_cap: 0 };
  const seen = new Set();
  for (const typed of [0.25, 0.5, 1, 2, 3, 5]) {
    seen.add(box.autoRiskCap(10000, typed, bounds).cap);
  }
  ok(seen.size === 6, "six different percentages give six different caps");
}

{
  /* ...and it is the TYPED value that decides, not a saved one that
     happens to be lying around in the same object. */
  const base = {
    risk_pct_min: 0.05, risk_pct_max: 10, risk_pct_cap: 0,
    risk_pct: 1, risk_pct_effective: 1, equity: 10000,
  };
  ok(near(box.autoRiskCap(base.equity, 3, base).cap, 300),
    "a saved 1% in the same object does not hold the preview down at 100");
}

console.log("\n— the ceilings ---------------------------------------------");

{
  const bounds = { risk_pct_min: 0.05, risk_pct_max: 10, risk_pct_cap: 0 };
  ok(box.autoRiskPct(1e9, bounds) === 10, "a huge number is held at the maximum");
  ok(box.autoRiskPct(-5, bounds) === 0.05, "a negative one is lifted to the minimum");
  ok(box.autoRiskPct(NaN, bounds) === 0.05, "and so is junk - never zero, which reads as no rule");
}

{
  /* A prop ceiling may lower the percentage and may never raise it. */
  let raised = 0;
  for (const typed of [0.1, 0.5, 1, 2, 10]) {
    for (const prop of [0.4, 0.75, 1, 1.25]) {
      const plain = box.autoRiskPct(typed, { risk_pct_min: 0.05, risk_pct_max: 10, risk_pct_cap: 0 });
      const ceiled = box.autoRiskPct(typed, { risk_pct_min: 0.05, risk_pct_max: 10, risk_pct_cap: prop });
      if (ceiled > plain + 1e-12 || ceiled > prop + 1e-12) raised += 1;
    }
  }
  ok(raised === 0, "a prop ceiling only ever lowers the percentage, over 20 combinations");
}

console.log("\n— rounding is the rule's, not the language's ----------------");

ok(near(box.roundMoney(1.125), 1.13), "1.125 rounds up, as a trader reads it");
ok(near(box.roundMoney(2250 * 0.05 / 100), 1.13),
  "and it survives the float that arrives as 1.1249999999999998");
ok(near(box.roundMoney(-1.125), -1.13), "away from zero on the other side too");
ok(box.roundMoney(0) === 0, "zero stays zero rather than becoming -0");

console.log("\n— the desk actually uses it --------------------------------");

{
  const live = APP.slice(APP.indexOf("function liveMoney("));
  const body = live.slice(0, live.indexOf("\nfunction "));
  ok(/autoRiskCap\(/.test(body),
    "liveMoney goes through the shared rule");
  ok(!/Math\.round\(equity/.test(body),
    "and no longer carries its own arithmetic");
  ok(!/risk_pct_effective\s*!=\s*null/.test(body),
    "and no longer reads the saved answer as a ceiling");
}

{
  /* The bounds must be read from the snapshot, not hardcoded beside a
     copy in Python that somebody will later change on its own. */
  const fn = liftFn("autoRiskPct");
  ok(/risk_pct_min/.test(fn) && /risk_pct_max/.test(fn) && /risk_pct_cap/.test(fn),
    "the bounds come from the engine's snapshot, not from constants in the browser");
}

console.log(`\n${ok_} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
