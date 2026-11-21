/**
 * The desk's own date and time pickers.
 *
 *   node tests/date-time-pickers.test.cjs
 *
 * Asked for: "don't make the backtest's date picker and prop's time
 * picker browser ones - they should all belong to the app", and in the
 * same list, sane bounds on the backtest range.
 *
 * Three things are pinned here, and each one is a fault that was
 * actually reported or is the direct cause of one:
 *
 *   1. No <input type="date"> or type="time" survives anywhere in the
 *      desk. The browser's widget is drawn by the OS, is not translated
 *      by us (a Persian desk got an English calendar), and differs
 *      between Edge, Chrome and a WebView2 host.
 *   2. The bounds are REAL. A native date field's max attribute stops
 *      its spinner and nothing else, so a typed or pasted date could
 *      still be in the future or before the start - which the engine
 *      could only answer with "no bars in that period".
 *   3. The value is still a plain input holding ISO text, and choosing
 *      still fires input and change on it, so everything that reads
 *      $("bt-from").value or listens for a change is unaffected.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(require.resolve("jsdom"));

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let failed = 0;
const ok = (c, m, d) => {
  if (!c) { failed++; console.log(`FAIL  ${m}${d ? "  — " + d : ""}`); }
  else console.log(`ok    ${m}${d ? "  — " + d : ""}`);
};

/* ------------------------------------------------- 1. nothing native left */

const appJs = strip(read("js/app.js"));
const allWebJs = fs.readdirSync(path.join(WEB, "js"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => strip(read("js/" + f)))
  .join("\n");
const html = read("index.html");

ok(!/type\s*=\s*["']date["']/.test(allWebJs) && !/type\s*=\s*["']date["']/.test(html),
  "no browser date input is rendered anywhere on the desk");
ok(!/type\s*=\s*["']time["']/.test(allWebJs) && !/type\s*=\s*["']time["']/.test(html),
  "no browser time input is rendered anywhere on the desk");
ok(/AurionWhen\.dateField\(/.test(appJs), "the backtest range uses the desk's picker");
ok(/AurionWhen\.timeField\(/.test(appJs), "the prop session hours use the desk's picker");
ok(html.includes("js/datetime.js"), "index.html loads the picker");

/* ------------------------------------------------------ 2. the behaviour */

const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const win = dom.window;
const doc = win.document;
win.eval(read("js/datetime.js"));
const W = win.AurionWhen;

ok(typeof W === "object" && typeof W.dateField === "function", "the module is there");

/* ---- the value is still an input, and still ISO ---- */

doc.body.innerHTML = W.dateField({ id: "bt-from", value: "2026-03-10", max: "2026-10-05" }) +
  W.timeField({ id: "pr-hs", value: "7:5", step: 5 });
W.bind(doc);

const fromInput = doc.getElementById("bt-from");
ok(fromInput && fromInput.tagName === "INPUT" && fromInput.value === "2026-03-10",
  "the date value lives in a real input, in ISO", fromInput && fromInput.value);
ok(doc.getElementById("pr-hs").value === "07:05",
  "a sloppy time is normalised on the way in", doc.getElementById("pr-hs").value);

let fired = [];
fromInput.addEventListener("input", () => fired.push("input"));
fromInput.addEventListener("change", () => fired.push("change"));

/* ---- opening, and the bounds ---- */

const btn = doc.querySelector('.dt-btn[data-dt-for="bt-from"]');
btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
let pop = doc.querySelector(".dt-pop-date");
ok(Boolean(pop), "clicking the field opens the desk's own calendar");

/* March 2026 is entirely inside the allowed span, so every day is live. */
let days = [...pop.querySelectorAll(".dt-day")];
ok(days.length === 31 && days.every((d) => !d.disabled),
  "a month inside the allowed span offers all of its days", `${days.length} days`);

/* Walk forward to the month the max falls in: days after it are refused. */
const toOct = () => {
  for (let i = 0; i < 12; i += 1) {
    const label = pop.querySelector(".dt-month").textContent;
    if (/October|اکتبر|أكتوبر/.test(label)) return true;
    const fwd = pop.querySelector('[data-dt-step="1"]');
    if (fwd.disabled) return false;
    fwd.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  }
  return false;
};
ok(toOct(), "the months can be walked to the one the bound falls in",
  pop.querySelector(".dt-month").textContent);
days = [...pop.querySelectorAll(".dt-day")];
ok(days[4] && !days[4].disabled, "the 5th of October is allowed - it is the max");
ok(days[5] && days[5].disabled, "the 6th is refused, because it is past the max");
ok(pop.querySelector('[data-dt-step="1"]').disabled,
  "and there is no walking past the last allowed month");

/* ---- choosing writes the value and announces it ---- */

days[4].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok(fromInput.value === "2026-10-05", "choosing writes an ISO value", fromInput.value);
ok(fired.includes("input") && fired.includes("change"),
  "...and fires input and change, exactly as the native field did", fired.join("+"));
ok(!doc.querySelector(".dt-pop"), "the popover closes once a day is chosen");
ok(!/2026-10-05/.test(btn.querySelector(".dt-text").textContent),
  "the button shows the date written out, not the ISO string",
  btn.querySelector(".dt-text").textContent);

/* ---- a bound added after the fact is honoured ---- */

W.setBounds("bt-from", "2026-10-01", "2026-10-05");
btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
pop = doc.querySelector(".dt-pop-date");
days = [...pop.querySelectorAll(".dt-day")];
ok(days[0] && !days[0].disabled && days[5] && days[5].disabled,
  "setBounds narrows a field that is already on the page");
ok(pop.querySelector('[data-dt-step="-1"]').disabled,
  "and the earlier months are closed off too");
W.close();

/* ---- the time picker ---- */

const tbtn = doc.querySelector('.dt-btn[data-dt-for="pr-hs"]');
tbtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const tpop = doc.querySelector(".dt-pop-time");
ok(Boolean(tpop), "the time field opens the desk's own picker");
ok(tpop.querySelectorAll("[data-dt-h]").length === 24, "all 24 hours are offered");
ok(tpop.querySelectorAll("[data-dt-m]").length === 12,
  "minutes are offered in fives", String(tpop.querySelectorAll("[data-dt-m]").length));
tpop.querySelector('[data-dt-h="9"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
tpop.querySelector('[data-dt-m="30"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok(doc.querySelector(".dt-pop-time"), "picking an hour does not close it - a time is two choices");
doc.querySelector("[data-dt-ok]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok(doc.getElementById("pr-hs").value === "09:30",
  "the chosen time is written as HH:MM", doc.getElementById("pr-hs").value);

/* ---- junk in, nothing out ---- */

ok(W.parseISO("2026-02-30") === null, "an impossible date is refused, not rolled over");
ok(W.parseISO("not a date") === null, "...and so is junk");
ok(W.parseTime("25:70") === null, "an impossible time is refused");

/* --------------------------------------------- 3. the backtest's bounds */

ok(/function btDateBounds\(/.test(appJs), "the backtest states what its two fields may hold");
const bounds = appJs.slice(appJs.indexOf("function btDateBounds("), appJs.indexOf("function paintBacktestPeriod("));
ok(/fromMax/.test(bounds) && /toMin/.test(bounds) && /toMax/.test(bounds),
  "both ends are bounded in both directions");
ok(/toMax:\s*today/.test(bounds), "neither end may be after today");
ok(/toMin:\s*from/.test(bounds), "the end may not be before the start");
ok(/AurionWhen\.setBounds\("bt-from"/.test(appJs) && /AurionWhen\.setBounds\("bt-to"/.test(appJs),
  "and the live fields are renarrowed whenever either end moves");
ok(/S\._btTo\s*<\s*S\._btFrom/.test(appJs),
  "moving the start past the end drags the end with it rather than leaving an impossible range");

/* ------------------------------------------- 4. the same picker, by thumb */

/* Reported from a phone: "in the backtest, the selectors in the date
   section are tiny". Everything in the picker was a fixed px sized for
   a mouse, so a 390px screen got the same 288px calendar with 34px day
   cells - and a day has to be hit between its neighbours, which makes
   it the smallest target on the page. */
const themesCss = read("css/themes.css");
const appCssRaw = read("css/app.css");
const touch = themesCss.slice(themesCss.indexOf("@media (pointer: coarse), (max-width: 560px)"));
ok(themesCss.includes("@media (pointer: coarse), (max-width: 560px)"),
  "the pickers have a touch size at all, and it answers to a thumb as well as to a narrow window");
const dayRule = touch.slice(touch.indexOf(".dt-day{"), touch.indexOf("}", touch.indexOf(".dt-day{")));
const dayPx = Number((/font-size:(\d+(?:\.\d+)?)px/.exec(dayRule) || [])[1]);
ok(dayPx >= 15, "a day in the calendar is legible on a phone", dayPx + "px");

/* 360px of popover, less its padding and the six gaps between seven
   columns, is what decides how big a day actually is. */
const popRule = touch.slice(touch.indexOf(".dt-pop-date{"), touch.indexOf("}", touch.indexOf(".dt-pop-date{")));
const popW = Number((/min\(94vw,\s*(\d+)px\)/.exec(popRule) || [])[1]);
const pad = Number((/padding:(\d+)px/.exec(touch.slice(touch.indexOf(".dt-pop{"), touch.indexOf("}", touch.indexOf(".dt-pop{")))) || [])[1]);
const gap = Number((/gap:(\d+)px/.exec(touch.slice(touch.indexOf(".dt-wd,.dt-grid{"), touch.indexOf("}", touch.indexOf(".dt-wd,.dt-grid{")))) || [])[1]);
const cell = (popW - pad * 2 - gap * 6) / 7;
ok(cell >= 40, "and the cell it sits in is a thumb's target", cell.toFixed(1) + "px square");
ok(popW <= 366, "...while the popover still fits a 390px screen with room either side", popW + "px");
ok(/max-block-size:calc\(100vh - 16px\)/.test(touch) && /overflow:auto/.test(touch),
  "a popover taller than the screen scrolls inside itself instead of running off the bottom");
ok(/\.dt-opt\{[^}]*font-size:15px/.test(touch), "the time list is readable too");

/* The two controls the complaint actually names, and the seven chips
   above them. */
const btTouch = appCssRaw.slice(appCssRaw.indexOf("#bt-card .bt-span{flex-wrap:wrap}"));
const chip = btTouch.slice(btTouch.indexOf("#bt-card .bt-span button{"), btTouch.indexOf("}", btTouch.indexOf("#bt-card .bt-span button{")));
ok(/min-height:4\dpx/.test(chip) && /font-size:1[4-9]px/.test(chip),
  "the period chips are a thumb tall on a phone, not the 30px toolbar height",
  chip.replace(/\s+/g, " "));
/* The thing that is tapped, as opposed to the calendar that opens.
   Reported twice, because the first answer shrank it: min-height:46px
   and font-size:15px are both SMALLER than what .ctrl already gives a
   control on a touch pointer (48px from --ctl-h, 16px from the
   iOS-zoom rule), and being more specific they won. A rule that sizes
   a target may only ever raise it. */
const dtBtn = btTouch.slice(btTouch.indexOf(".bt-dates .dt-btn{"), btTouch.indexOf("}", btTouch.indexOf(".bt-dates .dt-btn{")));
const btnH = Number((/min-block-size:(\d+)px/.exec(dtBtn) || [])[1]);
const btnF = Number((/font-size:(\d+)px/.exec(dtBtn) || [])[1]);
ok(btnH >= 48, "the button that opens the calendar is at least the desk's touch height", btnH + "px");
ok(btnF >= 16, "and its date is at least the size every other field is given on a phone", btnF + "px");
ok(/flex-direction:column/.test(btTouch.slice(btTouch.indexOf(".bt-dates > .field{"),
  btTouch.indexOf("}", btTouch.indexOf(".bt-dates > .field{")))),
  "...with its caption above it, so the whole card width is the target rather than a third of a row");

/* And the same button everywhere else a picker is opened. */
ok(/\.dt-btn\{ min-block-size:48px; font-size:16px/.test(touch),
  "every picker trigger on the desk gets a touch height, not just the backtest's two");

/* ----------------------------------------------------------- the report */

console.log(failed ? `\ndate-time-pickers: ${failed} FAILED` : "\ndate-time-pickers: all checks passed");
process.exit(failed ? 1 : 0);
