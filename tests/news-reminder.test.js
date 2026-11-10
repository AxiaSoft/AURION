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

/* The real language packs, read the way the desk reads them: a dotted
   key, English as the fallback, {placeholders} filled in. Checking the
   reminder against the shipped Persian and Arabic is the whole point of
   the last section - a stub that echoes keys would have reported a
   fully translated feature while the desk announced its reminders in
   English. */
const PACKS = { en: EN, fa: FA, ar: AR };
const lookup = (pack, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), pack);
const packT = (lang) => (k, v) => {
  let s = lookup(PACKS[lang] || EN, k);
  if (typeof s !== "string") s = lookup(EN, k);
  if (typeof s !== "string") return k;
  return v ? s.replace(/\{(\w+)\}/g, (m, n) => (n in v ? String(v[n]) : m)) : s;
};

function makeCal(stored, lang) {
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
      lang: lang || "en",
      t: packT(lang || "en"),
      has: (k) => typeof lookup(PACKS[lang || "en"], k) === "string",
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
  must(/ in 10 minutes \(/.test(toasts[0]), "the toast is not the reminder sentence: " + toasts[0]);
  must(cal.remindTick(NOW).length === 0, "the same event was announced twice");
  return "once, then remembered";
});

check("the announcement says what, when, and how long from now", () => {
  const { cal, toasts } = makeCal();
  cal.events = [ev(10, "high", "Core CPI m/m")];
  cal.remindTick(NOW);
  const said = toasts[0];
  must(/CPI/.test(said), "the event is not named: " + said);
  must(/USD/.test(said), "the currency is missing: " + said);
  must(/10 minutes/.test(said), "the countdown is missing: " + said);
  must(/\(\d{1,2}[:.]\d\d/.test(said), "the scheduled time is missing: " + said);
  return said;
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
  must(/2 more/.test(toasts[3]), "the rest are not accounted for: " + toasts[3]);
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

/* ============ 3b. the three faults behind "it did not work" ==========

   Reported plainly: the reminder produced nothing - no toast in the
   desk and no Windows notification. Three separate defects, each of
   which would have been enough on its own, so each gets its own check.
   ==================================================================== */

check("the Windows host actually accepts a news message", () => {
  /* Fault one, and the reason there was never a Windows notification:
     the host's message handler returned early unless the payload
     mentioned "signal" or "trade". The reminder has posted
     {"type":"news"} since the day it was written, so the balloon was
     not broken - it was never reachable. */
  const host = read("installer/window/AppWindow.cs");
  const i = host.indexOf("core.WebMessageReceived");
  must(i > 0, "the host no longer listens for desk messages at all");
  const body = host.slice(i, i + 2200);
  must(/var isNews = raw\.Contains/.test(body), "the host does not recognise a news message");
  must(/if \(!isSignal && !isTrade && !isNews\) return;/.test(body),
    "the early return still drops news");
  must(/isNews \? "" :/.test(body),
    "a news balloon would inherit the last signal's symbol and open the wrong chart");
});

check("the ledger is dated by one clock, and by the right event", () => {
  /* Fault two. _remindMark stored the release's own timestamp and
     pruned against Date.now(), while the decision to announce was made
     against the `now` handed to remindTick. Two clocks for one
     question: an entry whose event time fell outside the other clock's
     two-day window was deleted as it was written, so the release was
     announced again on the next pass, every thirty seconds, until it
     had gone by. */
  const i = SRC.indexOf("  _remindMark(");
  const body = SRC.slice(i, SRC.indexOf("\n  _evId(", i));
  must(!/Date\.now\(\) - 2 \*/.test(body), "the prune floor is read off a second clock");
  must(/const floor = now - 2 \*/.test(body), "the prune does not use the clock it was given");
  must(/this\._remindMark\(this\._evId\(ev\), now\)/.test(SRC),
    "the ledger is still dated by the release rather than by the announcement");
});

check("a release is announced once even when the clock is not today's", () => {
  /* The behaviour the two clocks broke, driven rather than grepped,
     and at a time deliberately far from the machine's own: that is the
     whole point - the answer must not depend on when the test runs. */
  for (const when of [NOW, NOW - 400 * 24 * 60 * MIN, NOW + 400 * 24 * 60 * MIN]) {
    const { cal, toasts } = makeCal();
    cal.events = [{ ...ev(10, "high"), ms: when + 10 * MIN }];
    must(cal.remindTick(when).length === 1, "nothing was announced at " + new Date(when).toISOString());
    must(cal.remindTick(when).length === 0, "announced twice at " + new Date(when).toISOString());
    must(toasts.length === 1, "raised " + toasts.length + " toasts at " + new Date(when).toISOString());
  }
  return "once, a year either side of today";
});

check("a calendar with nothing left in it says so instead of going quiet", () => {
  /* Fault three, the one that hid the other two. The engine serves the
     last good week from cache when the feed cannot be reached - right
     call, a stale calendar beats a blank one - but the desk dropped
     the flag, so a calendar whose newest release was last week looked
     exactly like a live one. The reminder then had nothing in its
     window, was correctly silent, and was indistinguishable from
     broken. */
  const { cal, toasts } = makeCal();
  cal.events = [ev(-600, "high"), ev(-120, "high")];
  must(cal.remindTick(NOW).length === 0, "a past release was announced");
  must(cal._remindStale(NOW) === true, "nothing was said about a calendar with no future in it");
  must(toasts.length === 1, "expected one notice, got " + toasts.length);
  must(toasts[0] !== "calendar.remind_stale", "the notice is an untranslated key");
  must(toasts[0].length > 25, "the notice does not say what to do: " + toasts[0]);
  return toasts[0].slice(0, 48) + "...";
});

check("...but it does not say it twice in a day", () => {
  const { cal, toasts, store } = makeCal();
  cal.events = [ev(-120, "high")];
  must(cal._remindStale(NOW) === true, "the first notice did not happen");
  must(cal._remindStale(NOW + 60 * MIN) === false, "it complained again an hour later");
  must(cal._remindStale(NOW + 25 * 60 * MIN) === true, "it never speaks again after the first day");
  must(toasts.length === 2, "expected two notices a day apart, got " + toasts.length);
  must(store.has("aurion.cal.remind.warned"), "the notice is not remembered across a reload");
  return "once a day";
});

check("a live calendar is never called stale", () => {
  const { cal, toasts } = makeCal();
  cal.events = [ev(-120, "high"), ev(600, "high")];
  must(cal._remindStale(NOW) === false, "a calendar with a release ahead of it was called stale");
  must(toasts.length === 0, "it complained about a working calendar");
  /* And an empty calendar is a different complaint - the feed has not
     loaded at all, which the Calendar tab says in its own words. */
  cal.events = [];
  must(cal._remindStale(NOW) === false, "an empty calendar was reported as a stale one");
  return "quiet";
});

check("the engine's own report on the feed is kept rather than thrown away", () => {
  const i = SRC.indexOf("async load() {");
  const body = SRC.slice(i, i + 900);
  must(/this\.feed = /.test(body), "the desk still discards the feed's cached/error report");
});

check("the reminder complains only when it had nothing to announce", () => {
  const i = SRC.indexOf("startReminder() {");
  const body = SRC.slice(i, SRC.indexOf("stopReminder()", i));
  must(/if \(!this\.remindTick\(now\)\.length\) this\._remindStale\(now\)/.test(body),
    "a stale notice could land on top of a real reminder");
});

check("the promise is made in words too, in every language", () => {
  for (const [name, pack] of [["en", EN], ["fa", FA], ["ar", AR]]) {
    const c = pack.calendar || {};
    for (const k of ["remind_title", "remind_sub", "remind_lead", "remind_level",
      "remind_mins", "remind_lead_opt", "remind_high", "remind_medium", "remind_all",
      "remind_toast", "remind_more", "remind_stale", "remind_on", "remind_off"]) {
      must(typeof c[k] === "string" && c[k].trim(), name + " is missing calendar." + k);
    }
    must(c.remind_sub.length > 25, name + "'s explanation of what it will not do is too short to say it");
  }
  must(/only notifies/i.test(EN.calendar.remind_sub), "the English text does not say it only notifies");
  return "14 keys x 3";
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

/* ============ 6. it speaks the language the desk is set to ============ *
 *
 * Reported after the first version shipped: the reminder only worked in
 * English. The panel around it was translated, but what the reminder
 * actually SAID was not - the release names come from a feed that
 * speaks English, the counts were written in Latin digits on a desk
 * that writes Persian ones, and "5 minutes" was pluralised with the
 * English rule in Arabic, which has a different one.
 *
 * Translating the labels is not translating the feature. These run the
 * real Persian and Arabic packs.
 */

const LATIN_DIGIT = /[0-9]/;

check("the reminder announces in Persian, in Persian digits", () => {
  const { cal, toasts } = makeCal({}, "fa");
  cal.events = [ev(10, "high", "Core CPI m/m")];
  cal.remindTick(NOW);
  const said = toasts[0];
  must(/دقیقه/.test(said), "the countdown is not in Persian: " + said);
  must(/تورم/.test(said), "the release was announced by its English name: " + said);
  must(/ماهانه/.test(said), "month-on-month was left in English: " + said);
  must(!LATIN_DIGIT.test(said.replace(/USD/g, "")), "Latin digits in a Persian sentence: " + said);
  return said;
});

check("...and in Arabic, with the Arabic plural rule", () => {
  const { cal, toasts } = makeCal({}, "ar");
  cal.events = [ev(5, "high", "Non-Farm Payrolls")];
  cal.remindTick(NOW);
  const said = toasts[0];
  must(/الوظائف/.test(said), "the release was announced by its English name: " + said);
  /* Three to ten take دقائق; "5 دقيقة" is the English rule applied to a
     language that does not have it. */
  must(/دقائق/.test(said), "five minutes was pluralised as one: " + said);
  must(!LATIN_DIGIT.test(said.replace(/USD/g, "")), "Latin digits in an Arabic sentence: " + said);
  const one = makeCal({}, "ar");
  one.cal.events = [{ ...ev(14, "high", "CPI"), ms: NOW + 60 * 1000 }];
  one.cal.remindTick(NOW);
  must(/دقيقة واحدة/.test(one.toasts[0]), "one minute is not singular: " + one.toasts[0]);
  return said;
});

check("the lead-time choices are written in the reader's language too", () => {
  for (const [lang, want] of [["fa", /دقیقه/], ["ar", /دقائق|دقيقة/]]) {
    const { cal } = makeCal({}, lang);
    const html = cal._remindHtml();
    const opts = [...html.matchAll(/<option[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    must(opts.length >= 7, lang + " lost its choices");
    const leads = opts.slice(0, 4);
    for (const o of leads) {
      must(want.test(o), lang + " has an untranslated lead time: " + o);
      must(!LATIN_DIGIT.test(o), lang + " writes its lead time in Latin digits: " + o);
    }
  }
  return "5 / 15 / 30 / 60, localised";
});

check("a release nobody has named keeps the words the feed used", () => {
  const { cal, toasts } = makeCal({}, "fa");
  cal.events = [ev(10, "high", "Bundesbank Buch Speaks At Some Forum")];
  cal.remindTick(NOW);
  /* "Speaks" is on the list; the rest is not, and inventing a Persian
     name for an event somebody is about to trade would be worse than
     leaving it alone. */
  must(/سخنرانی/.test(toasts[0]), "a known term was not translated: " + toasts[0]);
  const odd = makeCal({}, "fa");
  odd.cal.events = [ev(10, "high", "Gross Loan Facility Auction")];
  odd.cal.remindTick(NOW);
  must(/Gross Loan Facility Auction/.test(odd.toasts[0]),
    "an unknown release was renamed rather than passed through: " + odd.toasts[0]);
  /* "ADP Non-Farm Employment Change" is ADP's release, not the monthly
     payrolls report it is named after - a reminder that calls it the
     wrong number is worse than no reminder. */
  const adp = makeCal({}, "fa");
  adp.cal.events = [ev(10, "high", "ADP Non-Farm Employment Change")];
  adp.cal.remindTick(NOW);
  must(/ADP/.test(adp.toasts[0]) && !/غیرکشاورزی/.test(adp.toasts[0]),
    "ADP's release was announced as the payrolls report: " + adp.toasts[0]);
  return "translated when known, verbatim when not";
});

check("English is left exactly as the feed wrote it", () => {
  const { cal, toasts } = makeCal({}, "en");
  cal.events = [ev(10, "high", "Core CPI m/m")];
  cal.remindTick(NOW);
  must(/Core CPI m\/m/.test(toasts[0]), "an English desk was shown a paraphrase: " + toasts[0]);
  return "untouched";
});

check("the calendar around it counts in the same digits", () => {
  const { cal } = makeCal({}, "fa");
  must(cal._num(1405) === "۱۴۰۵", "the day grid would still be Latin: " + cal._num(1405));
  must(makeCal({}, "ar").cal._num(15) === "١٥", "Arabic digits are not used");
  must(makeCal({}, "en").cal._num(1405) === "1405", "English was changed too");
  /* Pinned on the source because these are template literals the vm
     cannot reach without a DOM. */
  must(/<span class="cal-d">\$\{this\._num\(c\.primary\.d\)\}<\/span>/.test(SRC),
    "the day number in a grid cell is not localised");
  must(/this\._num\(this\.parts\(ms, this\.system\)\.y\)/.test(SRC),
    "the year in the day panel is not localised");
  return "grid, panel, chips";
});

check("the day panel and the hover card name releases the same way", () => {
  must(/this\.newsTitle\(e\.title\)/.test(SRC), "the day panel still prints the feed's English");
  must((SRC.match(/this\.newsTitle\(e\.title\)/g) || []).length >= 2,
    "one of the two places that list events was missed");
  return "one name everywhere";
});

/* --------------------------------------------------------------------- */

if (failures.length) {
  console.log("\nnews-reminder: " + failures.length + " FAILED of " + (pass + failures.length));
  process.exit(1);
}
console.log("\nnews-reminder: " + pass + " checks passed");
