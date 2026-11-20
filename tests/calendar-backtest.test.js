/* Backtesting a period picked from the calendar.
 *
 *   node tests/calendar-backtest.test.js
 *
 * The request: "let me pick a past month, a week or a day and test the
 * robot on it". Two things had to change for that to be possible.
 *
 * ONE. Hovering a day number opened a floating card of that day's news
 * and that was the only thing a day number did. It was mouse-only, and
 * what it showed was a copy of the day panel already open beside it. A
 * card that disappears when the pointer leaves it can never carry a
 * button, so the peek is gone and the click does the work.
 *
 * TWO. Starting a run lived inside the backtest page's go button, so
 * running one meant being on that page with its three fields filled in.
 * It was lifted into startBacktest(), which the calendar calls with a
 * from/to pair.
 *
 * The risky parts are the date arithmetic - a week that runs Monday to
 * Sunday, a month that stops at today - so those are computed here
 * against known dates rather than eyeballed.
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
  ok(panel.querySelector(".cal-bt"), "...and the day panel offers to backtest the period");

  const buttons = [...panel.querySelectorAll(".cal-bt-go")];
  ok(buttons.length === 3, "three periods are offered", `${buttons.length} buttons`);
  ok(buttons.map((b) => b.dataset.bt).join(",") === "day,week,month",
    "a day, a week and a month", buttons.map((b) => b.dataset.bt).join(","));
  ok(buttons.every((b) => b.textContent.trim() && !b.textContent.includes("calendar.")),
    "every button is translated", buttons.map((b) => b.textContent.trim()).join(" / "));

  /* ------------------------------------- 2. what actually gets run - */

  p.win.__runs.length = 0;
  buttons[2].dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  const run = p.win.__runs[0];
  ok(!!run, "pressing a period button starts a run");
  ok(run && run.from && run.to, "the run carries a period", run ? `${run.from} .. ${run.to}` : "none");
  ok(run && run.symbol === "EURUSD" && run.timeframe === "M15",
    "it uses the instrument the desk is already showing",
    run ? `${run.symbol} ${run.timeframe}` : "none");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(run.from) && /^\d{4}-\d{2}-\d{2}$/.test(run.to),
    "the dates are plain Gregorian keys, whatever calendar is on screen",
    `${run.from} .. ${run.to}`);

  /* The desk may be set to the Persian or Hijri calendar. The engine
     matches these against bar timestamps, so they must not be
     localised - a Jalali 1405-02-15 matches no bar that ever existed. */
  p.Cal.system = "jalali";
  p.Cal.rerender();
  const jalaliPanel = p.doc.getElementById("cal-day");
  const jBtn = jalaliPanel.querySelector(".cal-bt-go");
  ok(jBtn && /^\d{4}-\d{2}-\d{2}$/.test(jBtn.dataset.from) && Number(jBtn.dataset.from.slice(0, 4)) > 1900,
    "a Persian calendar still sends Gregorian dates to the engine",
    jBtn ? jBtn.dataset.from : "no button");
  p.Cal.system = "gregorian";
  p.Cal.rerender();

  /* ----------------------------------- 3. the date arithmetic ------ */

  /* Known dates rather than "today", because the two things that can
     be wrong here - which day a week starts on, and whether a period
     may run past today - are both invisible on most dates. */
  const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

  // 2026-03-11 is a Wednesday. Monday is the 9th, Sunday the 15th.
  let r = p.Cal._ranges(at(2026, 3, 11));
  ok(r.week[0] === "2026-03-09", "a week starts on the Monday", r.week[0]);
  ok(r.week[1] === "2026-03-15", "...and ends on the Sunday", r.week[1]);
  ok(r.month[0] === "2026-03-01" && r.month[1] === "2026-03-31",
    "a month runs first to last", `${r.month[0]} .. ${r.month[1]}`);
  ok(r.day[0] === "2026-03-11" && r.day[1] === "2026-03-11", "a day is itself", r.day[0]);

  /* The off-by-one that matters: getDay() calls Sunday 0, so a naive
     "subtract getDay()-1" sends every Sunday forward into the week
     after itself. 2026-03-15 is a Sunday and belongs to the week that
     began on the 9th. */
  r = p.Cal._ranges(at(2026, 3, 15));
  ok(r.week[0] === "2026-03-09" && r.week[1] === "2026-03-15",
    "a Sunday belongs to the week that just ended, not the one starting",
    `${r.week[0]} .. ${r.week[1]}`);

  // 2026-02-28 is a Saturday; February 2026 has 28 days.
  r = p.Cal._ranges(at(2026, 2, 28));
  ok(r.month[1] === "2026-02-28", "the month end is the real last day, not the 31st", r.month[1]);

  /* ------------------------------ 4. nothing in the future -------- */

  /* A future period has no bars. The engine would correctly answer
     "no bars in that period", which is a true answer to a question
     that should never have been askable. */
  const todayStr = p.Cal._dayKey(Date.now());
  const thisMonth = p.Cal._ranges(Date.now());
  ok(thisMonth.month[1] <= todayStr,
    "the current month stops at today rather than asking for bars that do not exist yet",
    `${thisMonth.month[1]} vs today ${todayStr}`);
  ok(thisMonth.month[0] <= todayStr, "...and still starts at the first of the month", thisMonth.month[0]);

  /* Re-queried, not reused. The calendar-system switch above called
     rerender(), which replaces every cell - the originals are detached
     nodes whose clicks reach no delegated listener and silently do
     nothing, which would make this check pass for the wrong reason. */
  const live = [...p.doc.querySelectorAll(".cal-cell")];
  const future = live.find((c) => c.dataset.day > todayStr);
  if (future) {
    future.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
    ok(!p.doc.getElementById("cal-day").querySelector(".cal-bt"),
      "a future day is not offered a backtest at all", future.dataset.day);
  } else {
    ok(true, "a future day is not offered a backtest at all", "no future day in this month");
  }

  /* --------------------------- 5. the offer survives a repaint ---- */

  /* The panel's HTML is replaced on every selection, so a handler
     bound to the buttons themselves would be dropped the first time
     another day was clicked. */
  const past = live.find((c) => c.dataset.day < todayStr && c.dataset.day);
  if (past) {
    past.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
    p.win.__runs.length = 0;
    p.doc.querySelector("#cal-day .cal-bt-go").dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
    ok(p.win.__runs.length === 1, "the buttons still work after the panel has been rebuilt");
  }

  /* ------------------------------------- 6. the wiring, by source - */

  ok(/window\.startBacktest = startBacktest/.test(appJs),
    "app.js publishes the starter the calendar calls");
  ok(/async function startBacktest\(opts\)/.test(appJs),
    "...and it is a real top-level function, not a closure in a view binding");
  ok(/if \(from\) body\.from = from;/.test(appJs) && /if \(to\) body\.to = to;/.test(appJs),
    "the period reaches the request body");
  ok(/\.cal-bt\b/.test(css) && /\.cal-bt-go\b/.test(css), "the offer is styled");
  for (const key of ["bt_title", "bt_hint", "bt_day", "bt_week", "bt_month"]) {
    ok(typeof lang.calendar[key] === "string" && lang.calendar[key].length > 2,
      `calendar.${key} exists`);
  }
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
