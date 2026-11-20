/* The calendar's day panel, and the backtest offer that used to be in it.
 *
 *   node tests/calendar-backtest.test.js
 *
 * HISTORY, because this file is now mostly about something that is
 * gone. The request was "let me pick a past month, a week or a day and
 * test the robot on it", and it was built into the day panel: three
 * buttons that called startBacktest() with a from/to pair.
 *
 * It was then withdrawn - "remove the robot-test section from the
 * calendar, the options you added to the backtest page are enough".
 * The backtest page has its own period picker now (today, this week,
 * this month, the previous month, the quarter, or two dates), which is
 * the same capability in the place a person goes to run a backtest, so
 * the calendar's copy was a second way to do one thing.
 *
 * What this file checks now:
 *   - the removal is COMPLETE - no dead markup, styles, strings or
 *     handlers left behind, because a branch nothing renders is worse
 *     than the button it replaced;
 *   - the parts of that work which were NOT withdrawn still hold: the
 *     hover peek stays gone, a day is selected by clicking it, the
 *     panel is rebuilt on every selection, and startBacktest() is
 *     still the one published entry point the backtest page uses.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom"));

const ROOT = path.join(__dirname, "..", "apps", "web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const calJs = read("js/calendar.js");
const appJs = read("js/app.js");
const css = read("css/app.css").replace(/\/\*[\s\S]*?\*\//g, "");
const lang = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", "en.json"), "utf8"));

let failed = 0;
const ok = (c, m, d) => {
  if (!c) { failed++; console.log(`FAIL  ${m}${d ? "  — " + d : ""}`); }
  else console.log(`ok    ${m}${d ? "  — " + d : ""}`);
};

/* ------------------------------------------------------ the rig ---- */

const NOW = new Date();
const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const dayOffset = (days, hhmm) => {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days));
  return `${iso(d)}T${hhmm}:00Z`;
};
const NEWS = {
  ok: true,
  data: {
    source: "config/news_calendar.template.csv",
    blackout_before: 15, blackout_after: 15,
    events: [
      { time: dayOffset(0, "12:30"), currency: "USD", impact: "high", title: "Non-Farm Payrolls" },
      { time: dayOffset(-1, "14:00"), currency: "EUR", impact: "medium", title: "ECB Press Conference" },
    ],
  },
};
const SESSION = { ok: true, data: { state: "open", open: true, weekend: false } };

/** Boot calendar.js alone, with a recording stand-in for startBacktest. */
async function boot() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on("jsdomError", (e) => errs.push(String(e.message || e)));
  const dom = new JSDOM("<!doctype html><html lang='en'><body><div id='root'></div></body></html>",
    { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  win.matchMedia = (q) => ({ matches: false, media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.fetch = async (u) => ({
    ok: true, status: 200,
    json: async () => (String(u).includes("/api/news") ? NEWS
      : String(u).includes("/api/market/session") ? SESSION
      : { ok: true, data: lang }),
  });
  win.eval(`
    window.I18N = {
      lang: "en", dict: ${JSON.stringify(lang)},
      t(k, v) {
        const s = k.split(".").reduce((a, p) => (a == null ? a : a[p]), this.dict);
        if (s == null) return k;
        return String(s).replace(/\\{(\\w+)\\}/g, (_, n) => (v && v[n] != null ? v[n] : ""));
      },
    };
    window.API = { get: async (p) => (await (await fetch(p)).json()) };
    window.esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    /* app.js is not loaded here - only the one function the calendar
       is allowed to reach for. Recording it is how we see what the
       calendar would actually have asked the engine to replay. */
    window.__runs = [];
    window.startBacktest = (o) => { window.__runs.push(o); return true; };
    var S = { symbol: "EURUSD", timeframe: "M15" };
    window.S = S;
  `);
  win.eval(calJs + "\n;window.__CAL = Calendar;");
  const Cal = win.__CAL;
  Cal.anchor = null;
  Cal.selected = "";
  await Cal.load();
  const root = win.document.getElementById("root");
  await Cal.mount(root);
  return { win, doc: win.document, Cal, root, errs };
}

(async () => {
  const p = await boot();
  ok(p.errs.length === 0, "the calendar boots clean", p.errs.join(" | ") || "no errors");

  /* ------------------------------- 1. the click, not the hover ---- */

  const cells = [...p.doc.querySelectorAll(".cal-cell")];
  const todayKey = iso(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate())));
  const today = cells.find((c) => c.dataset.day === todayKey) || cells[10];

  today.dispatchEvent(new p.win.MouseEvent("mouseover", { bubbles: true }));
  ok(!p.doc.getElementById("cal-tip"), "hovering a day number opens nothing");

  today.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  const panel = p.doc.getElementById("cal-day");
  ok(p.Cal.selected === today.dataset.day, "clicking a day selects it", p.Cal.selected);
  ok(panel.querySelector(".cal-dp-main"), "...and the day panel is filled with that day");
  ok(panel.textContent.trim().length > 10, "the panel says something", `${panel.textContent.trim().length} chars`);

  /* The panel is rebuilt from scratch on every selection. That is why
     the buttons it used to carry had to be bound by delegation, and it
     is still the reason nothing may hold a reference to its children. */
  const otherCell = cells.find((c) => c.dataset.day && c.dataset.day !== today.dataset.day);
  otherCell.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  ok(p.Cal.selected === otherCell.dataset.day, "a second click moves the selection", p.Cal.selected);
  ok(p.doc.getElementById("cal-day").textContent.includes(
       String(p.Cal._num(p.Cal.parts(p.Cal._fromDayKey(otherCell.dataset.day), p.Cal.system).d))),
     "the panel follows the selection rather than keeping the first day");

  /* ------------------------- 2. the offer is gone, not hidden ----- */

  ok(!p.doc.querySelector(".cal-bt"), "no backtest offer is rendered in the day panel");
  ok(!p.doc.querySelector(".cal-bt-go"), "...and no period buttons with it");

  /* Source-level, because a feature can be "not rendered" and still be
     one condition away from coming back. */
  const live = calJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const dead of ["_backtestOffer", "_ranges", "cal-bt", "btSymbol", "btTimeframe", "startBacktest"]) {
    ok(!live.includes(dead), `calendar.js no longer carries ${dead}`);
  }
  ok(!/\.cal-bt\b/.test(css), "the styles went with it");
  for (const key of ["bt_title", "bt_hint", "bt_day", "bt_week", "bt_month"]) {
    ok(!(key in lang.calendar), `calendar.${key} is gone from the pack`);
  }

  /* Pressing a day must not start anything at all now. __runs is the
     rig's record of startBacktest() calls. */
  p.win.__runs.length = 0;
  [...p.doc.querySelectorAll(".cal-cell")].slice(0, 6)
    .forEach((c) => c.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true })));
  ok(p.win.__runs.length === 0, "clicking days starts no backtests", `${p.win.__runs.length} runs`);

  /* ------------------------------ 3. what survived the removal ---- */

  ok(/window\.startBacktest = startBacktest/.test(appJs),
    "app.js still publishes the one shared starter");
  ok(/async function startBacktest\(opts\)/.test(appJs),
    "...still a real top-level function, not a closure in a view binding");
  ok(/if \(from\) body\.from = from;/.test(appJs) && /if \(to\) body\.to = to;/.test(appJs),
    "a period still reaches the request body - the backtest page sends one now");
  ok(/backtestPeriodHtml\(\)/.test(appJs),
    "the picker that replaced the calendar's buttons is on the backtest page");

  /* Three packs, identical key sets - a missing Arabic string shows the
     reader a raw dotted key. */
  for (const code of ["fa", "ar"]) {
    const other = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", `${code}.json`), "utf8"));
    const missing = Object.keys(lang.calendar).filter((k) => !(k in other.calendar));
    ok(missing.length === 0, `${code} has every calendar string`, missing.join(", ") || "none");
  }

  console.log("");
  if (failed) { console.log(`calendar-backtest: ${failed} FAILED`); process.exit(1); }
  console.log("calendar-backtest: all checks passed");
})();
