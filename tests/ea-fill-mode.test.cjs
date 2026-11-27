/* Closing a position the trader opened by hand.
 *
 *   "When I open a position by hand I can't close it through AURION
 *    any more - I get retcode=10030."
 *
 * 10030 is TRADE_RETCODE_INVALID_FILL: the broker refused the order's
 * FILLING MODE. Nothing to do with the price, the volume or the stops.
 *
 * TradeMarket had always known this. It asked the symbol what it
 * supported and, when the answer was refused anyway, walked a short
 * ladder of the alternatives - because SYMBOL_FILLING_MODE is what the
 * server SAYS, and on exchange-execution symbols and a fair number of
 * bridges it is not what the server DOES.
 *
 * TradeClose had none of that. One hardcoded ORDER_FILLING_IOC, one
 * attempt, no retry. On a symbol the broker runs FOK-only, every close
 * AURION sent was rejected on its first and only try - and so was
 * "close all", which routes through the same function. It surfaced as
 * "hand-opened positions can't be closed" because a hand-opened trade
 * is usually on some OTHER symbol than the one the robot trades, with
 * its own filling policy.
 *
 * The ladder now lives in one place and every trade path uses it.
 *
 *     node tests/ea-fill-mode.test.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EA = fs.readFileSync(path.join(ROOT, "engine", "ea", "AurionBridge.mq5"), "utf8");

let fails = 0;
function ok(cond, what) {
  if (cond) console.log("ok   " + what);
  else { fails += 1; console.log("FAIL " + what); }
}

/* The DEFINITION, not the forward declaration at the top of the file:
   indexOf("void TradeClose(") finds the prototype first, and a slice
   taken from there measures a region with no code in it, which passes
   however broken the real body is. */
function bodyOf(sig) {
  const at = EA.indexOf(sig + "\n  {");
  if (at < 0) return "";
  const end = EA.indexOf("\n  }\n", at);
  return EA.slice(at, end > at ? end : at + 4000);
}

/* ---- one sender, shared ------------------------------------------- */
{
  const send = bodyOf("bool SendOrder(MqlTradeRequest &req, MqlTradeResult &res, const string symbol)");
  ok(Boolean(send), "there is no shared order sender");
  ok(/FillOf\(symbol\)/.test(send),
    "the sender does not ask the symbol what it supports before guessing");
  ok(/ORDER_FILLING_IOC/.test(send) && /ORDER_FILLING_FOK/.test(send),
    "the sender has no alternatives to fall back on");
  ok(/TRADE_RETCODE_INVALID_FILL/.test(send),
    "the sender does not recognise 10030, so it cannot know when to retry");
  ok(/res\.retcode != TRADE_RETCODE_INVALID_FILL\) break;/.test(send),
    "a real reject - bad price, no money - is retried twice more instead of reported");
  ok(/fills\[i\] == fills\[0\]\) continue;/.test(send),
    "the mode the symbol asked for is sent twice when it is also IOC or FOK");

  /* The ladder must not be duplicated anywhere. A second copy is how
     TradeClose came to be a decade behind TradeMarket in the first
     place. */
  ok(EA.split("fills[2]").length - 1 === 1,
    "the filling ladder exists in more than one place and can drift apart again");
}

/* ---- every trade path goes through it ------------------------------ */
for (const sig of ["void TradeMarket(const string line)",
                   "void TradePending(const string line)",
                   "void TradeClose(const string line)"]) {
  const body = bodyOf(sig);
  ok(Boolean(body), sig + " is gone");
  ok(/SendOrder\(req, res,/.test(body), sig + " does not use the shared sender");
  ok(!/req\.type_filling/.test(body),
    sig + " still picks a filling mode of its own, so it can still get 10030");
  ok(!/\bOrderSend\(req, res\)/.test(body),
    sig + " still sends directly, bypassing the retry");
}

/* ---- the close is the position's trade, not this chart's ----------- */
{
  const close = bodyOf("void TradeClose(const string line)");
  ok(/SendOrder\(req, res, symbol\)/.test(close),
    "the close resolves filling against the chart, not the position's own symbol");
  ok(/string symbol = PositionGetString\(POSITION_SYMBOL\)/.test(close),
    "the close no longer reads the position's symbol");
  ok(!/req\.magic/.test(close),
    "a hand-opened position's exit is still stamped with AURION's magic");
  ok(/SendPositions\(\)/.test(close),
    "the desk is not told the position is gone, so it reappears until the next refresh");
}

/* The magic still belongs on the way IN - it is how the engine tells its
   own resting orders from the trader's. */
{
  const pend = bodyOf("void TradePending(const string line)");
  ok(/req\.magic = 908173/.test(pend),
    "AURION's own resting orders are no longer identifiable as its own");
}

/* ---- the reject is explained ---------------------------------------- */
{
  const why = bodyOf("string WhyNot(const MqlTradeResult &res)");
  ok(Boolean(why), "there is no way to turn a retcode into something a trader can read");
  ok(/TRADE_RETCODE_INVALID_FILL/.test(why) && /filling/.test(why),
    "10030 still reaches the desk as a bare number");
  ok(/res\.comment/.test(why), "the broker's own words are dropped");
  for (const sig of ["void TradeMarket(const string line)",
                     "void TradePending(const string line)",
                     "void TradeClose(const string line)"]) {
    ok(/Reply\((good|ok)[^\n]*WhyNot\(res\)\)/.test(bodyOf(sig).replace(/\n/g, "\n")),
      sig + " reports a raw retcode instead of saying what went wrong");
  }
}

/* Paths with no filling mode at all must not have grown one: cancelling
   a resting order and moving a stop are not deals. */
{
  for (const sig of ["void TradeCancel(const string line)",
                     "void TradeModify(const string line)"]) {
    const body = bodyOf(sig);
    ok(Boolean(body), sig + " is gone");
    ok(!/type_filling|SendOrder\(/.test(body),
      sig + " is not a deal and must not carry a filling mode");
  }
}

console.log(fails ? "\nea-fill-mode: " + fails + " check(s) failed" : "\nall good");
process.exit(fails ? 1 : 0);
