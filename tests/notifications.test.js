/**
 * What is allowed to make a noise, and what is not.
 *
 * The rule the user asked for is specific and easy to break later by
 * accident: a trade opening or closing interrupts - sound in the desk and
 * a Windows notification - and a change of status does neither. These
 * tests pin that down in both directions, because the failure that
 * matters is not a missing chime, it is a desk that pings at every
 * reconnect until the trader turns the sound off and then misses a fill.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "apps/web/js/app.js"), "utf8");
const host = fs.readFileSync(path.join(root, "installer/window/AppWindow.cs"), "utf8");

let passed = 0;
function ok(name, cond, detail) {
  if (!cond) { console.error("FAIL  " + name + (detail ? "  — " + detail : "")); process.exitCode = 1; return; }
  passed++; console.log("PASS  " + name);
}

/* --- a trade is announced ------------------------------------------- */

ok("the bus's trade event is handled",
   /if \(msg\.type === "trade"\)[\s\S]{0,120}announceTrade/.test(app));

const announce = app.slice(app.indexOf("function announceTrade("),
                           app.indexOf("function pushTradeCard("));
ok("announcing a trade plays a sound", /playSound\(/.test(announce));
ok("announcing a trade shows an in-app card", /pushTradeCard\(/.test(announce));
ok("announcing a trade reaches Windows", /notifyHostTrade\(/.test(announce));
ok("a losing exit picks a different sound from a winning one",
   /result === "loss" \? "loss" : "profit"/.test(announce));

/* --- a status change is not ------------------------------------------ */

const toast = app.slice(app.indexOf("function toast(msg)"), app.indexOf("function toast(msg)") + 500);
ok("toast() makes no sound", !/playSound/.test(toast));
ok("toast() never reaches Windows", !/postMessage|notifyHost/.test(toast));

/* --- the trader chooses the sounds ----------------------------------- */

ok("entry, profit and loss each have their own setting",
   /NOTIFY_DEFAULTS = \{[^}]*entry:[^}]*profit:[^}]*loss:/.test(app));
ok("the choice survives a restart", /localStorage\.setItem\("aurion\.notify"/.test(app));
ok("an unknown sound name falls back to the default",
   /SOUND_NAMES\.includes\(out\[key\]\)/.test(app));
ok("silence is one of the choices", /none:\s*null/.test(app));
ok("every sound offered has a label in all three packs", ["en", "fa", "ar"].every((code) => {
  const pack = JSON.parse(fs.readFileSync(path.join(root, "lang", code + ".json"), "utf8"));
  const names = (app.match(/const SOUNDS = \{[\s\S]*?\n\};/) || [""])[0]
    .split("\n").map((l) => (l.match(/^\s{2}(\w+):/) || [])[1]).filter(Boolean);
  return names.length > 1 && names.every((n) => pack.notify && pack.notify["snd_" + n]);
}));
ok("Windows notifications can be switched off", /sw-wintoast/.test(app) && /prefs\.windows/.test(announce));

/* ------------------------------------------------------------------ *
 * A signal is announced the same way a trade is
 *
 * Reported: when the system signalled, nothing appeared - and then the
 * moment a trade was opened by hand, every missed signal arrived at
 * once in a stack.
 *
 * It was not a delivery problem. The cards were being built and put
 * into #notify-stack the whole time, but that container ships hidden
 * and only pushTradeCard ever set hidden = false, so the signals were
 * on the page and invisible until a manual trade switched the light on
 * and revealed the backlog. The signal path was also silent and its
 * cards never expired, which is what turned the reveal into a pile.
 * ------------------------------------------------------------------ */

const announceSignal = app.slice(app.indexOf("function announceSignal("),
                                 app.indexOf("function documentHidden("));
const pushSignal = app.slice(app.indexOf("function pushSignalCard("),
                             app.indexOf("function openSignalChart("));

ok("a signal plays the same sound an entry does", /playSound\(\s*prefs\.entry/.test(announceSignal));
ok("a signal shows an in-app card", /pushSignalCard\(/.test(announceSignal));
ok("a signal reaches Windows under the same switch as a trade",
   /if \(prefs\.windows\) notifyHost\(/.test(announceSignal),
   "it was gated on the window being hidden, so a visible desk got nothing but an invisible card");

ok("putting a signal card up un-hides the stack",
   /stack\.hidden = false/.test(pushSignal),
   "this is the whole fault: cards prepended into a hidden container");

/* REWRITTEN, not deleted. This used to look for the card's own
   setTimeout(..., 20000). Every notification is now on one five-second
   clock that pauses while the card is hovered, pressed or held under a
   finger -- asked for directly -- so the thing to hold the code to is
   that the signal card is on that clock, not that it owns a timer. */
ok("a signal card does not stay for ever",
   /autoDismiss\(card\)/.test(pushSignal),
   "a card carrying an entry price is useless a minute later");

/* The other half of hidden = false: something has to put it back, or
   an empty but visible stack sits over the corner of the desk eating
   pointer events. Every removal path goes through one of these. */
const dismiss = app.slice(app.indexOf("function bindDismiss("),
                          app.indexOf("function bindDismiss(") + 900);
ok("dismissing the last card hides the stack again",
   /stack\.children\.length === 0\) stack\.hidden = true/.test(dismiss));

const pushTrade = app.slice(app.indexOf("function pushTradeCard("),
                            app.indexOf("function notifyHostTrade("));
/* Same reversal: the expiry lives in autoDismiss now, and hiding an
   emptied stack is its job. Checked where it is rather than where it
   used to be -- an empty but visible stack still eats pointer events
   over the corner of the desk. */
ok("a trade card is on the shared clock", /autoDismiss\(card\)/.test(pushTrade));
const life = app.slice(app.indexOf("function autoDismiss("),
                       app.indexOf("function autoDismiss(") + 2000);
ok("an expiry that empties the stack hides it again",
   /stack\.children\.length === 0\) stack\.hidden = true/.test(life));

ok("a signal is still de-duplicated before any of that happens",
   /_lastSignalKey/.test(announceSignal),
   "the bus republishes on reconnect and a chime per replay is worse than silence");

/* --- the host side ---------------------------------------------------- */

ok("the desktop host accepts a trade message, not only a signal",
   /isTrade\s*=\s*raw\.Contains\("\\"trade\\""\)/.test(host));
ok("a losing exit is raised with a warning icon",
   /Field\(raw, "level"\) == "warning" \? ToolTipIcon\.Warning/.test(host));

console.log(`\n${passed} checks passed`);
