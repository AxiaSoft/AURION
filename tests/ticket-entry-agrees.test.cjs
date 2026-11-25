/* The desk must price a ticket from the price it would actually open at.
 *
 * Phase zero. A market buy fills at the ask and a market sell at the bid;
 * the desk measured both from the MID, which is not a price anybody
 * trades at. Every market stop was understated by half the spread - 15%
 * on gold - always in the direction that looks safer than it is.
 *
 * The fill rule is shared with the engine (risk.market_entry) and pinned
 * by tests/fixtures/ticket-entry.json; the Python half is
 * engine/tests/test_ticket_entry_agrees.py.
 *
 * Reading the SIDE off a half-written ticket is the desk's own problem -
 * the engine is always told which way the trade goes, but the risk line
 * has to be drawn while the stop is still being typed - so that half is
 * exercised here only.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps/web/js/app.js"), "utf8");
const FIX = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/ticket-entry.json"), "utf8"));

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

const box = { Number, String, Math, console };
vm.createContext(box);
vm.runInContext(
  [liftFn("marketEntry"), liftFn("impliedSide"), liftFn("ticketEntry")].join("\n")
  + "\nthis.marketEntry = marketEntry;"
  + "\nthis.impliedSide = impliedSide;"
  + "\nthis.ticketEntry = ticketEntry;", box);

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

console.log("\n— where a market order opens (shared with the engine) ------");

for (const c of FIX.market) {
  const got = box.marketEntry(c.side, c.bid, c.ask);
  ok(near(got, c.entry),
    `${c.why}  —  got ${got}` + (near(got, c.entry) ? "" : `, expected ${c.entry}`));
}

console.log("\n— never the mid -------------------------------------------");

{
  const mid = (100 + 101) / 2;
  let leaked = 0;
  for (const side of ["", null, undefined, "close", "cancel", "pending"]) {
    if (box.marketEntry(side, 100, 101) === mid) leaked += 1;
  }
  ok(leaked === 0, "an unknown side gives 0, never a plausible-looking mid");
  ok(box.marketEntry("buy", 100, 101) === 101 && box.marketEntry("sell", 100, 101) === 100,
    "and a known side gives the price that is actually paid");
}

console.log("\n— which way is this ticket pointing ------------------------");

for (const c of FIX.implied) {
  const got = box.impliedSide(c.sl, c.tp, c.mid);
  ok(got === c.side,
    `${c.why}  —  got "${got}"` + (got === c.side ? "" : `, expected "${c.side}"`));
}

console.log("\n— a pending order rests where it was told -------------------");

ok(box.ticketEntry("buy", "limit", 2600, 2650, 2650.3) === 2600,
  "a limit prices from its resting price, not from the quote");
ok(box.ticketEntry("sell", "stop", 2700, 2650, 2650.3) === 2700,
  "and so does a stop order");
ok(box.ticketEntry("buy", "", 2600, 2650, 2650.3) === 2650.3,
  "a market order ignores whatever is left in the price field");

console.log("\n— the money this was actually about -------------------------");

/* The regression as a trader meets it: gold, a 100-tick stop, one lot. */
{
  const bid = 2650.0, ask = 2650.3, tickSize = 0.01, tickValue = 1.0;
  const entry = box.marketEntry("buy", bid, ask);
  const sl = entry - 100 * tickSize;
  const mid = (bid + ask) / 2;
  const real = Math.abs(entry - sl) / tickSize * tickValue;
  const old = Math.abs(mid - sl) / tickSize * tickValue;
  ok(near(real, 100) && near(old, 85),
    `gold, 0.30 spread, 100-tick stop: the mid said ${old}, the fill says ${real}`);
  ok(real > old, "the old reading understated the risk, rather than overstating it");
}

console.log("\n— the ticket actually uses it ------------------------------");

{
  const fn = liftFn("paintTicketRisk");
  ok(/ticketEntry\(/.test(fn), "paintTicketRisk measures from the shared entry rule");
  ok(/impliedSide\(/.test(fn), "and reads the side off the ticket");
  ok(!/const from = kind \? Number\(\$\("ct-price"\)\?\.value \|\| 0\) : mid/.test(fn),
    "the old mid-for-a-market-order line is gone, not merely unused");
  ok(/risk_no_side/.test(fn),
    "a ticket whose stop and target disagree is named rather than priced");
}

{
  /* The new strings have to exist everywhere, like every other one. */
  for (const lang of ["en", "fa", "ar"]) {
    const pack = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang + ".json"), "utf8"));
    for (const key of ["risk_no_side", "risk_stop_too_close"]) {
      ok(typeof (pack.exec || {})[key] === "string" && pack.exec[key].length > 10,
        `${lang}: exec.${key} is written`);
    }
    ok(/\{points\}/.test(pack.exec.risk_stop_too_close)
      && /\{min\}/.test(pack.exec.risk_stop_too_close),
      `${lang}: the too-close warning names both distances`);
  }
}

console.log("\n— a stop the broker will refuse is named -------------------");

{
  const fn = liftFn("paintTicketRisk");
  ok(/min_stop_distance/.test(fn),
    "the ticket knows the broker's minimum stop distance");
  ok(/risk_stop_too_close/.test(fn),
    "and says so before the order is sent, not after it is rejected");
  /* The money stays on screen: it is true, and the warning is about
     whether the ticket can be sent at all, not about the arithmetic. */
  const at = fn.indexOf("risk_stop_too_close");
  ok(fn.indexOf("ct-risk-sl") < at,
    "the warning is added beside the money rather than replacing it");

  const css = fs.readFileSync(path.join(ROOT, "apps/web/css/app.css"), "utf8");
  ok(/\.ct-risk-warn\{/.test(css.replace(/\s+/g, "")) || /ct-risk-warn/.test(css),
    "the warning has a style of its own, not the faint one used for absences");
}

console.log(`\n${ok_} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
