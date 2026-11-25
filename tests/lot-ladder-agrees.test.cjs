/* The desk's lot field has to be the broker's lot field.
 *
 * Phase zero. The engine publishes volume_step / volume_min / volume_max
 * in every symbol specification; the desk was not reading them. Both lot
 * inputs were written with step="0.01" min="0.01" regardless of the book
 * being traded:
 *
 *   - on a whole-lot book (indices, shares) the desk offered 0.01, which
 *     the broker refuses;
 *   - on a 0.001 book it could not offer 0.005 at all, so the trader
 *     typed 0.01 - twice the size;
 *   - and fmtLot wrote every size to two decimals, so a 0.005 lot read
 *     as "0.01" even when one had been set.
 *
 * lotDp mirrors the engine's _step_dp. The engine half of the ladder is
 * engine/tests/test_lot_rounding.py; what is checked here is that the
 * desk asks the broker rather than assuming.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const LADDER = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/lot-rounding.json"), "utf8"));

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

/* A spec table the desk can look symbols up in, plus the real lookup. */
const specs = {
  EURUSD: { tick_size: 0.00001, tick_value: 1, digits: 5, currency: "USD",
            volume_min: 0.01, volume_step: 0.01, volume_max: 200, contract_size: 100000 },
  BTCUSD: { tick_size: 0.01, tick_value: 0.01, digits: 2, currency: "USD",
            volume_min: 0.001, volume_step: 0.001, volume_max: 10, contract_size: 1 },
  US30:   { tick_size: 1, tick_value: 1, digits: 1, currency: "USD",
            volume_min: 1, volume_step: 1, volume_max: 500, contract_size: 1 },
};

const box = {
  Number, String, Math, Boolean, console,
  S: { snap: { strategy: { money: { specs } } } },
  I18N: { locale: () => "en-GB", t: (k) => k },
};
vm.createContext(box);
vm.runInContext(
  [liftFn("symbolSeriesKey"), liftFn("sameSeriesSymbol"), liftFn("specFor"),
   liftFn("lotDp"), liftFn("lotBounds"), liftFn("fmtNum"), liftFn("fmtLot")].join("\n")
  + "\nthis.lotDp = lotDp; this.lotBounds = lotBounds; this.fmtLot = fmtLot;", box);

console.log("\n— decimals come from the step, as in the engine --------------");

for (const [step, dp] of [[0.01, 2], [0.001, 3], [1, 0], [0.1, 1], [0.25, 2], [0.5, 1]]) {
  ok(box.lotDp(step) === dp, `a ${step} step is written to ${dp} decimals`);
}
ok(box.lotDp(0) === 2 && box.lotDp(undefined) === 2,
  "and an unknown step falls back to the retail two, not to zero");

console.log("\n— the ladder comes from the broker ---------------------------");

{
  const e = box.lotBounds("EURUSD");
  ok(e.step === 0.01 && e.min === 0.01 && e.max === 200, "EURUSD: 0.01 steps, 200 ceiling");

  const b = box.lotBounds("BTCUSD");
  ok(b.step === 0.001 && b.min === 0.001 && b.dp === 3,
    "BTCUSD: 0.001 steps, and three decimals to write them with");

  const u = box.lotBounds("US30");
  ok(u.step === 1 && u.min === 1 && u.dp === 0,
    "US30: whole lots, and no decimals at all");

  const unknown = box.lotBounds("NOTHING");
  ok(unknown.step === 0.01 && unknown.min === 0.01,
    "an undescribed symbol falls back to the retail ladder rather than to nothing");

  ok(box.lotBounds("BTCUSD.m").step === 0.001,
    "and a broker suffix still finds the right ladder");
}

console.log("\n— a lot is written to the precision it is traded in ----------");

ok(box.fmtLot(0.005, 0.001) === "0.005", "0.005 on a 0.001 book stays 0.005");
ok(box.fmtLot(0.005) === "0.01",
  "...while with no step stated it still rounds to two, as it always did");
ok(box.fmtLot(2, 1) === "2", "a whole-lot book writes no decimals");
ok(box.fmtLot(0.1, 0.01) === "0.10", "and a 0.01 book keeps its trailing zero");

console.log("\n— the fields and the steppers actually use it ----------------");

{
  ok(!/id="ct-vol" type="number" step="0\.01" min="0\.01"/.test(APP),
    "the chart ticket's lot field no longer hardcodes 0.01");
  ok(!/id="st-vol" type="number" step="0\.01" min="0\.01" max="1000"/.test(APP),
    "nor does the settings one");
  ok(/id="ct-vol"[^>]*step="\$\{ctLots\.step\}"/.test(APP),
    "the chart ticket steps on the broker's ladder");
  ok(/id="st-vol"[^>]*step="\$\{stLots\.step\}"/.test(APP),
    "and so does settings");

  const paint = liftFn("paintTicketRisk");
  ok(/applyLotBounds\(/.test(paint),
    "the ladder is re-applied on repaint, since the spec can arrive late");

  const apply = liftFn("applyLotBounds");
  ok(/\bel\.step\b/.test(apply) && /\bel\.min\b/.test(apply),
    "applyLotBounds writes step and min onto the live inputs");

  /* The +/- buttons read the attributes straight off the field, so
     fixing the attributes is what fixes the steppers. Worth pinning:
     if the stepper ever grows its own constant the two part company. */
  const stepper = liftFn("stepLotField");
  ok(/Number\(el\.step\)/.test(stepper) && /Number\(el\.min\)/.test(stepper),
    "the +/- buttons take their step from the field, not from a constant");
}

console.log("\n— the engine's own ladder, for the record --------------------");

/* Not re-implemented on the desk - the engine fits the lot - but the
   fixture is shared so the two cannot describe different brokers. */
{
  const steps = new Set(LADDER.cases.map((c) => c.step));
  let agreed = 0;
  for (const s of steps) if (box.lotDp(s) >= 0) agreed += 1;
  ok(agreed === steps.size,
    `every step in the shared fixture has a decimal count on the desk (${steps.size} steps)`);
}

console.log(`\n${ok_} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
