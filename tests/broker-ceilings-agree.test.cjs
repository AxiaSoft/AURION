/* The ceilings the broker declares, read the same way on both sides.
 *
 * Phase zero, last slice. The expert now sends freeze_level,
 * volume_limit and the margin one lot costs; the engine resolves them
 * and publishes the answers. This checks the desk reads those answers
 * rather than inventing its own.
 *
 * The margin rule is the one that matters here. Every other number on
 * the ticket is about what the trade can LOSE. Margin is what it costs
 * to HOLD, which is a different question - a 2-lot gold ticket risking
 * $40 on its stop still needs about $2000 of margin, and on a $500
 * account the broker refuses it outright. The desk was already showing
 * free margin two panels away and never once compared the two.
 *
 * The engine half is engine/tests/test_broker_ceilings.py. The
 * resolution order for a missing side is the part that must agree:
 * both fall back to the other side before giving up, and both treat 0
 * as "unknown", never as "free".
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");

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

/* A sandbox holding the two lifted helpers and a stub specFor, so the
   arithmetic is exercised rather than described. */
function sandboxFor(specs, account) {
  const ctx = {
    S: { snap: { account: account || {} } },
    specFor: (sym) => specs[sym] || null,
    Number, Math, String, console,
  };
  vm.createContext(ctx);
  vm.runInContext(liftFn("marginNeeded") + "\n" + liftFn("freeMargin"), ctx);
  return ctx;
}

const GOLD = {
  currency: "USD", tick_size: 0.01, tick_value: 1.0, digits: 2,
  margin_per_lot_buy: 1000.0, margin_per_lot_sell: 990.0,
};

console.log("— what the ticket costs to hold ----------------------------");

{
  const ctx = sandboxFor({ XAUUSD: GOLD }, { margin_free: 500 });
  ok(ctx.marginNeeded("XAUUSD", "buy", 2) === 2000,
    "2 lots of gold need 2000 in margin");
  ok(ctx.marginNeeded("XAUUSD", "sell", 2) === 1980,
    "the two sides are allowed to differ, and do");
  ok(ctx.marginNeeded("XAUUSD", "buy", 0.5) === 500,
    "margin is linear in volume, as the engine computes it");
  ok(ctx.freeMargin() === 500, "free margin is read off the account");
  ok(ctx.marginNeeded("XAUUSD", "buy", 2) > ctx.freeMargin(),
    "and the comparison that was never made is now makeable");
}

{
  /* The fallback order has to match aurion/runtime/risk.py margin_for:
     the other side first, and 0 is unknown rather than free. */
  const one = sandboxFor({ X: { ...GOLD, margin_per_lot_sell: 0 } }, {});
  ok(one.marginNeeded("X", "sell", 1) === 1000,
    "a missing side falls back to the other before giving up");

  const none = sandboxFor(
    { X: { currency: "USD", margin_per_lot_buy: 0, margin_per_lot_sell: 0 } }, {});
  ok(none.marginNeeded("X", "buy", 1) === null,
    "an unanswered margin is null, never 0 - 0 would read as free");

  const nospec = sandboxFor({}, {});
  ok(nospec.marginNeeded("X", "buy", 1) === null,
    "no specification means no claim about margin");

  ok(sandboxFor({ X: GOLD }, {}).marginNeeded("X", "buy", 0) === null,
    "no size, no margin question");
}

{
  const noAcc = sandboxFor({ X: GOLD }, {});
  ok(noAcc.freeMargin() === null,
    "an account that has not reported free margin says so, rather than 0");
  ok(sandboxFor({ X: GOLD }, { margin_free: 0 }).freeMargin() === null,
    "and a literal 0 is treated the same way - it blocks nothing");
}

console.log("\n— the ticket shows it, and warns ---------------------------");

{
  const fn = liftFn("paintTicketRisk");
  ok(/marginNeeded/.test(fn), "the ticket asks what the position costs to hold");
  ok(/freeMargin/.test(fn), "and compares it against what the account has spare");
  ok(/exec\.margin_short/.test(fn),
    "and says so before the order is sent, not after 'no money' comes back");
  ok(/ct-risk-margin/.test(fn) && /ct-risk-warn/.test(fn),
    "the figure and the complaint are styled apart");
}

console.log("\n— the engine publishes the resolved answers ----------------");

{
  const trader = fs.readFileSync(
    path.join(ROOT, "engine/aurion/runtime/trader.py"), "utf8");
  for (const key of ["freeze_distance", "volume_limit",
                     "margin_per_lot_buy", "margin_per_lot_sell"]) {
    ok(trader.includes(`"${key}"`), `the desk is sent ${key}`);
  }
  ok(!/"freeze_level": spec/.test(trader),
    "raw points stay in the engine, where the unit is known");
}

{
  const ea = fs.readFileSync(path.join(ROOT, "engine/ea/AurionBridge.mq5"), "utf8");
  ok(ea.includes("SYMBOL_TRADE_FREEZE_LEVEL"), "the expert reads the freeze level");
  ok(ea.includes("SYMBOL_VOLUME_LIMIT"), "the expert reads the total volume ceiling");
  ok(ea.includes("OrderCalcMargin"),
    "margin is asked of the terminal, not read from SYMBOL_MARGIN_INITIAL "
    + "(0 on most forex books)");
}

console.log("\n— the strings exist in every language ----------------------");

for (const lang of ["en", "fa", "ar"]) {
  const pack = JSON.parse(
    fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
  for (const key of ["margin_need", "margin_short"]) {
    const v = (pack.exec || {})[key];
    ok(typeof v === "string" && v.length > 8, `${lang}: exec.${key} is written`);
  }
  ok(/\{need\}/.test(pack.exec.margin_short) && /\{free\}/.test(pack.exec.margin_short),
    `${lang}: the shortfall names both figures`);
}

console.log(`\n${ok_} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
