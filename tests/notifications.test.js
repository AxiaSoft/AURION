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

/* --- the host side ---------------------------------------------------- */

ok("the desktop host accepts a trade message, not only a signal",
   /isTrade\s*=\s*raw\.Contains\("\\"trade\\""\)/.test(host));
ok("a losing exit is raised with a warning icon",
   /Field\(raw, "level"\) == "warning" \? ToolTipIcon\.Warning/.test(host));

console.log(`\n${passed} checks passed`);
