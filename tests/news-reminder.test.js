/**
 * The calendar's news reminder.
 *
 * Asked for in three clauses, and all three are load-bearing: remind me
 * about news, let me switch it off, and let it do nothing but inform.
 *
 * The third clause is the one worth guarding. This desk can place and
 * close trades, disarm the robot and flatten an account. A feature that
 * watches the economic calendar and fires on a schedule is one careless
 * commit away from becoming a trading rule - "pause the robot before
 * high-impact news" is a tempting line to add here and would be a
 * different product decision made by accident. So the checks below pin
 * the reminder's reach as well as its behaviour: it may raise a
 * notification, and it may not call anything that acts.
 *
 * The scanner itself is run for real - the object is loaded in a vm with
 * a stub browser, handed events around a known clock and asked what it
 * announced.
 *
 *     npm run test:newsremind
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SRC = read("apps/web/js/calendar.js");
const APP = read("apps/web/js/app.js");
const CSS = read("apps/web/css/app.css");
const EN = JSON.parse(read("lang/en.json"));
const FA = JSON.parse(read("lang/fa.json"));
const AR = JSON.parse(read("lang/ar.json"));

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass++;
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    failures.push(name);
    console.log("  x  " + name + "  \u2014 " + e.message);
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------- a calendar in a box */

function makeCal(stored) {
  const store = new Map(Object.entries(stored || {}));
  const toasts = [];
  const posted = [];
  const ctx = {
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    I18N: {
      lang: "en",
      /* Returns the key plus its arguments, so a check can see both
         which sentence was chosen and what was put in it. */
      t: (k, v) => k + (v ? ":" + JSON.stringify(v) : ""),
    },
    esc: (x) => String(x),
    document: { body: { contains: () => false }, getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, setAttribute() {}, appendChild() {} }) },
    window: { chrome: { webview: { postMessage: (m) => posted.push(m) } }, matchMedia: () => ({ matches: false }) },
    toast: (m) => toasts.push(m),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    fetch: async () => ({ ok: false }),
    Intl,
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    String,
    Map,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const cal = vm.runInContext("Calendar", ctx);
  return { cal, toasts, posted, store };
}

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const ev = (minsAway, level, title) => ({
  ms: NOW + minsAway * MIN,
  day: "2026-11-06",
  time: "12:" + String(minsAway).padStart(2, "0"),
  currency: "USD",
  impact: level,
  level,
  title: title || ("event " + minsAway),
});

/* ====================== 1. it reminds ================================= */

check("an event inside the lead time is announced once", () => {
  const { cal, toasts } = makeCal();
  cal.events = [ev(10, "high")];
  const first = cal.remindTick(NOW);
  must(first.length === 1, "nothing was announced for an event ten minutes away");
  must(toasts.length === 1, "no notification was raised");
  must(/calendar\.remind_toast/.test(toasts[0]), "the toast is not the reminder sentence: " + toasts[0]);
  must(cal.remindTick(NOW).length === 0, "the same event was announced twice");
  return "once, then remembered";
});

check("the announcement says what, when, and how long from now", () => {
  const { cal, toasts } = makeCal();
  cal.events = [ev(10, "high", "CPI")];
  cal.remindTick(NOW);
  const arg = JSON.parse(toasts[0].slice(toasts[0].indexOf(":") + 1));
  must(/CPI/.test(arg.what), "the event is not named");
  must(/USD/.test(arg.what), "the currency is missing");
  must(arg.n === "10", "the countdown is " + arg.n);
  must(arg.time, "the scheduled time is missing");
  return "USD CPI, 10 minutes, 12:10";
});

check("what has already happened is not a reminder", () => {
  const { cal } = makeCal();
  cal.events = [ev(-5, "high"), ev(-1, "high")];
  must(cal.remindTick(NOW).length === 0, "an event in the past was announced");
  return "past: silent";
});

check("what is beyond the lead time waits for its turn", () => {
  const { cal } = makeCal();
  cal.events = [ev(40, "high")];
  must(cal.remindTick(NOW).length === 0, "announced 40 minutes early at a 15-minute setting");
  must(cal.remindTick(NOW + 30 * MIN).length === 1, "never announced at all");
  return "announced when it comes due";
});

check("a burst of releases does not bury the desk in toasts", () => {
  const { cal, toasts } = makeCal();
  cal.events = [ev(5, "high"), ev(6, "high"), ev(7, "high"), ev(8, "high"), ev(9, "high")];
  const due = cal.remindTick(NOW);
  must(due.length === 5, "the scan missed some");
  must(toasts.length === 4, "expected three announcements plus one summary, got " + toasts.length);
  must(/remind_more/.test(toasts[3]), "the rest are not accounted for");
  must(cal.remindTick(NOW).length === 0, "the ones that were only summarised come back again");
  return "3 + \u201cand 2 more\u201d";
});

/* ====================== 2. it can be switched off ===================== */

check("off is off: nothing is announced at all", () => {
  const { cal, toasts } = makeCal({ "aurion.cal.remind": JSON.stringify({ on: false }) });
  cal.events = [ev(5, "high"), ev(10, "high")];
  must(cal.remindTick(NOW).length === 0, "a switched-off reminder still fired");
  must(toasts.length === 0, "a switched-off reminder still raised a notification");
  return "silent";
});

check("switching it off stops the timer, it does not just mute it", () => {
  must(/stopReminder\(\)/.test(SRC), "there is no way to stop the scan");
  const i = SRC.indexOf("if (sw) sw.onclick");
  const body = SRC.slice(i, i + 700);
  must(/this\.stopReminder\(\)/.test(body), "the switch does not stop the timer");
  must(/this\.startReminder\(\)/.test(body), "the switch cannot start it again");
  return "clearInterval";
});

check("the choice survives a reload, and a broken one does not break it", () => {
  const { cal, store } = makeCal();
  cal.saveRemindPrefs({ on: false, lead: 60, level: "all" });
  const saved = JSON.parse(store.get("aurion.cal.remind"));
  must(saved.on === false && saved.lead === 60 && saved.level === "all", "the preference was not stored");
  const junk = makeCal({ "aurion.cal.remind": "{not json" }).cal.remindPrefs();
  must(junk.on === true && junk.lead === 15, "unreadable preferences do not fall back to the default");
  const silly = makeCal({ "aurion.cal.remind": JSON.stringify({ lead: 99999, level: "banana" }) }).cal.remindPrefs();
  must(silly.lead === 15 && silly.level === "high", "a nonsense value was accepted: " + JSON.stringify(silly));
  return "stored, validated";
});

check("the switch is on screen, with the two choices beside it", () => {
  must(/id="cal-remind"/.test(SRC), "no switch");
  must(/id="cal-remind-lead"/.test(SRC) && /id="cal-remind-level"/.test(SRC), "no lead time or impact choice");
  must(/this\._bindRemind\(root\)/.test(SRC), "the panel is drawn but never wired");
  must(/\.cal-remind:not\(\.is-on\) \.cal-remind-opts/.test(CSS), "switched off does not look switched off");
  return "switch + 2 selects";
});

/* ====================== 3. it only informs ============================ */

check("the reminder cannot act on the market", () => {
  /* The reminder's own code, with its comments taken out: the comments
     say what it must not do, in the words of the things it must not do. */
  const start = SRC.indexOf("  REMIND_KEY:");
  const end = SRC.indexOf("  stopReminder() {");
  must(start > 0 && end > start, "the reminder is no longer where this check looks for it");
  const region = SRC.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const forbidden = [
    /API\.post/, /API\.del/, /fetch\(/, /flatten/i, /\/api\/order/, /auto_trade/,
    /closePosition/, /sendDeskOrder/, /robot/i, /disarm/i,
  ];
  for (const re of forbidden) {
    must(!re.test(region), "the reminder region contains " + re);
  }
  return "no call that changes anything";
});

check("...and the only thing it calls is a notification", () => {
  const i = SRC.indexOf("  _remindAnnounce(ev, now) {");
  const body = SRC.slice(i, SRC.indexOf("\n  _remindSay(", i));
  must(/this\._remindSay\(/.test(body), "it does not raise a toast");
  must(/postMessage/.test(body), "the desktop host is not told");
  must(/type: "news"/.test(body), "the host message is not flagged as news");
  must(!/playSound|setLang|save|post\(/.test(body.replace(/postMessage/g, "")),
    "the announcement does more than announce");
  return "toast + host notification";
});

check("the promise is made in words too, in every language", () => {
  for (const [name, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
    const c = pack.calendar || {};
    for (const k of ["remind_title", "remind_sub", "remind_lead", "remind_level",
      "remind_minutes", "remind_high", "remind_medium", "remind_all",
      "remind_toast", "remind_more", "remind_on", "remind_off"]) {
      must(typeof c[k] === "string" && c[k].trim(), name + " is missing calendar." + k);
    }
    must(c.remind_sub.length > 25, name + "'s explanation of what it will not do is too short to say it");
  }
  must(/only notifies/i.test(EN.calendar.remind_sub), "the English text does not say it only notifies");
  return "12 keys x 3";
});

/* ====================== 4. it works when unwatched ==================== */

check("it runs whether or not the calendar page is open", () => {
  must(/Calendar\.startReminder\(\)/.test(APP), "nothing starts the reminder from the desk");
  const i = SRC.indexOf("  startReminder() {");
  const body = SRC.slice(i, SRC.indexOf("  stopReminder() {", i));
  must(/setInterval/.test(body), "there is no timer");
  must(/this\.load\(\)/.test(body), "it never fetches the news by itself");
  must(/document\.body\.contains\(this\.root\)/.test(body),
    "it refetches underneath the open calendar, which is already keeping itself fresh");
  must(/if \(this\._remindTimer\) return;/.test(SRC), "two timers can be started");
  return "30s, self-feeding, idempotent";
});

check("a reload does not re-announce what was already said", () => {
  const first = makeCal();
  first.cal.events = [ev(10, "high")];
  first.cal.remindTick(NOW);
  const carried = {};
  for (const [k, v] of first.store) carried[k] = v;
  const second = makeCal(carried);
  second.cal.events = [ev(10, "high")];
  must(second.cal.remindTick(NOW).length === 0, "a fresh page announced it again");
  return "remembered across sessions";
});

check("the memory of what was announced cannot grow for ever", () => {
  const { cal, store } = makeCal();
  cal.events = [ev(10, "high")];
  cal.remindTick(NOW);
  /* An entry from last week has no reason to still be there. */
  const seen = JSON.parse(store.get("aurion.cal.remind.seen"));
  seen["old|stale|USD|gone"] = NOW - 7 * 24 * 60 * MIN;
  store.set("aurion.cal.remind.seen", JSON.stringify(seen));
  cal.events = [ev(11, "high", "another")];
  cal.remindTick(NOW);
  const after = JSON.parse(store.get("aurion.cal.remind.seen"));
  must(!("old|stale|USD|gone" in after), "a week-old entry was kept");
  return "pruned at two days";
});

/* ====================== 5. the impact filter ========================== */

check("'high impact only' means only high impact", () => {
  const { cal } = makeCal({ "aurion.cal.remind": JSON.stringify({ level: "high" }) });
  cal.events = [ev(5, "high"), ev(6, "medium"), ev(7, "low")];
  const due = cal.remindTick(NOW);
  must(due.length === 1 && due[0].level === "high", "announced " + due.map((e) => e.level).join(","));
  return "high";
});

check("the wider settings widen it, and a holiday is never a release", () => {
  const med = makeCal({ "aurion.cal.remind": JSON.stringify({ level: "medium" }) }).cal;
  med.events = [ev(5, "high"), ev(6, "medium"), ev(7, "low"), ev(8, "holiday")];
  must(med.remindTick(NOW).length === 2, "high+medium did not announce exactly two");
  const all = makeCal({ "aurion.cal.remind": JSON.stringify({ level: "all" }) }).cal;
  all.events = [ev(5, "high"), ev(6, "medium"), ev(7, "low"), ev(8, "holiday")];
  const due = all.remindTick(NOW);
  must(due.length === 3, "'everything' announced " + due.length + " of three releases plus a holiday");
  must(!due.some((e) => e.level === "holiday"), "a public holiday was announced as news");
  return "holiday excluded at every setting";
});

check("an event with no clock time is not given one", () => {
  const { cal } = makeCal();
  cal.events = [{ ms: 0, day: "2026-11-06", time: "", currency: "USD", level: "high", title: "all day" },
    { ms: NaN, day: "2026-11-06", time: "", currency: "USD", level: "high", title: "unknown" }];
  must(cal.remindTick(NOW).length === 0, "an undated event was given a countdown");
  return "skipped, not guessed";
});

/* --------------------------------------------------------------------- */

if (failures.length) {
  console.log("\nnews-reminder: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nnews-reminder: " + pass + " checks passed");
