/* Desk render regression test.
 *
 *   npm i --no-save jsdom && node tests/desk-render.test.js
 *
 * Renders the real apps/web scripts in jsdom and asserts on the DOM, which is
 * what caught: an async view printing "[object Promise]", a banner built from
 * CSS classes that do not exist (giant unstyled <svg>), Calendar calling the
 * non-existent UI.page(), and Intl emitting Persian digits so every parsed
 * Jalali/Hijri year came back as 0.
 *
 * Nothing here is wired into a runner; it is a plain script with exit code 1
 * on failure.
 */
/* Regression harness: actually renders the desk views in a DOM.
 * Catches the three defects reported from the browser:
 *   1. async view -> "[object Promise]"
 *   2. marketBanner using classes that do not exist in app.css -> giant <svg>
 *   3. Calendar calling UI.page(), which is not defined anywhere
 * Run: node /tmp/desk-render-test.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom"));

const WEB = path.join(__dirname, "..", "apps", "web");

// The calendar opens on the *current* month, so the fixture has to land in it
// — a hard-coded date turns this suite into a time bomb that starts failing
// the month after it was written.
const NOW = new Date();
// Offsets from today, not days of the Gregorian month.
//
// The first version pinned the fixture to the 5th and 7th of the current
// Gregorian month, which quietly broke the moment the desk defaulted to the
// Jalali calendar: the grid shows the Persian month, and Aban 1405 starts on
// 23 October, so "the 5th" was simply not on screen and the dot checks read
// zero. Anchoring to today keeps the events inside whichever month the grid
// opens on, in every calendar system.
const dayOffset = (days, hhmm) => {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${hhmm}:00Z`;
};

const NEWS = {
  ok: true,
  data: {
    count: 3,
    source: "config/news_calendar.template.csv",
    blackout_before: 15,
    blackout_after: 15,
    events: [
      { time: dayOffset(1, "12:30"), currency: "USD", impact: "high", title: "Non-Farm Payrolls" },
      { time: dayOffset(1, "14:00"), currency: "EUR", impact: "medium", title: "ECB Press Conference" },
      { time: dayOffset(3, "01:00"), currency: "AUD", impact: "low", title: "RBA Rate Decision" },
    ],
  },
};

const SESSION = {
  ok: true,
  data: {
    open: false, state: "weekend", reason: "market_closed_weekend",
    weekday: 5, weekday_key: "saturday", utc: "2026-09-05T12:00:00+00:00",
    next_open: "2026-09-07T00:00:00+00:00", hours_to_open: 36,
    weekend: true, allow_weekend: false, trading_allowed: false,
  },
};

const SYMBOLS = { ok: true, data: { symbols: ["EURUSD", "XAUUSD", "GBPUSD"], broker: [], online: [], watchlist: [], active: "EURUSD", source: "default" } };

function makeFetch(errors) {
  return async (url, opts) => {
    const u = String(url);
    const body = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    if (u.includes("/api/news")) return body(NEWS);
    if (u.includes("/api/market/session")) return body(SESSION);
    if (u.includes("/api/symbols")) return body(SYMBOLS);
    if (u.includes("/api/i18n/")) return body({ ok: true, data: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", "fa.json"), "utf8")) });
    errors.push("unstubbed fetch: " + u);
    return body({ ok: true, data: {} });
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

(async () => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const fetchErrors = [];
  const consoleErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => consoleErrors.push(String(e.message || e)));
  vc.on("error", (...a) => consoleErrors.push(a.join(" ")));

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  win.fetch = makeFetch(fetchErrors);
  win.HTMLAnchorElement.prototype.click = function () {};
  // jsdom implements neither of these; the desk uses both at boot.
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.AudioContext = win.AudioContext || function () { return { createGain: () => ({}), createOscillator: () => ({}), destination: {}, currentTime: 0, resume: async () => {} }; };
  win.URL.createObjectURL = () => "blob:stub";
  win.URL.revokeObjectURL = () => {};
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

  // One eval: jsdom gives each win.eval() its own lexical scope, so separate
  // calls would not share the top-level const bindings the way a browser does.
  const bundle = ["js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8"))
    .join("\n;\n");
  // Publish the top-level bindings: jsdom gives each win.eval() its own lexical
  // scope, so a later eval cannot see the bundle's const declarations.
  const EXPORT = "\n;window.__T = { S, views, marketBanner, Calendar, I18N, show, icon, esc, bindView };";
  try {
    win.eval(bundle + EXPORT);
  } catch (e) {
    console.log("bundle threw on load:", e.message);
  }
  await new Promise((r) => setTimeout(r, 300));
  if (!win.__T) { console.log("FATAL: bundle did not expose its globals"); process.exit(1); }
  const T = win.__T;
  // Load the real Persian pack so a missing key would show up as a raw key.
  await T.I18N.load("fa");
  const packLoaded = Object.keys(T.I18N.pack || {}).length > 0;
  const doc = win.document;
  const ev = (code) => win.eval(code);

  // ---------- 1. market banner on the command tab ----------
  T.S.snap = { market: SESSION.data, mt5: {}, prop: {}, positions: [] };
  const banner = T.marketBanner();
  check("marketBanner renders something on a weekend", banner.length > 0, `${banner.length} chars`);
  check("marketBanner contains NO <svg> (the giant icon)", !banner.includes("<svg"), banner.slice(0, 90));
  check("marketBanner uses a class that exists in app.css", /class="tape-banner/.test(banner));
  const css = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
  const cls = (banner.match(/class="([^"]+)"/) || [, ""])[1].split(/\s+/);
  check("every banner class has a CSS rule", cls.every((c) => css.includes("." + c)), cls.join(" "));

  check("i18n pack actually loaded", packLoaded, `${Object.keys(T.I18N.pack || {}).length} top-level sections`);
  check("weekend banner text is translated, not a raw key",
    !/^[a-z_]+\.[a-z_]+$/.test(banner.replace(/<[^>]+>/g, "").trim()),
    banner.replace(/<[^>]+>/g, "").trim());

  // ---------- 2. calendar view is not a Promise ----------
  const shell = T.views.calendar();
  check('views.calendar() returns markup, not "[object Promise]"', !String(shell).includes("[object"), String(shell).slice(0, 70));

  doc.getElementById("stage").innerHTML = T.views.calendar();
  T.Calendar.mount(doc.getElementById("cal-root"));
  await new Promise((r) => setTimeout(r, 400));

  const rootHtml = doc.getElementById("cal-root").innerHTML;
  check("calendar painted (no [object Promise] left)", !rootHtml.includes("[object"), `${rootHtml.length} chars`);
  const cells = doc.querySelectorAll("#cal-grid .cal-cell").length;
  check("calendar grid rendered 42 day cells", cells === 42, `got ${cells}`);
  const dots = doc.querySelectorAll("#cal-grid .cal-dots .dot").length;
  check("news events rendered as impact dots", dots >= 2, `${dots} dots`);
  const subs = doc.querySelectorAll("#cal-grid .cal-sub").length;
  check("companion calendars shown in cells (Jalali+Hijri)", subs > 40, `${subs} sub-numbers`);
  const hasHigh = !!doc.querySelector("#cal-grid .dot.i-high");
  check("high-impact event coloured", hasHigh);
  const weekendTag = doc.querySelectorAll("#cal-grid .cal-wk-tag").length;
  check("weekend days marked on the grid", weekendTag > 8, `${weekendTag} weekend cells`);

  const rawKeys = (rootHtml.match(/\b(?:calendar|risk|telegram|status|strategies|history)\.[a-z_]+\b/g) || [])
    .filter((k) => !/\.(py|txt|js|csv)$/.test(k));
  check("no untranslated i18n keys rendered in the calendar", rawKeys.length === 0, [...new Set(rawKeys)].join(", ") || "none");
  const jalaliLabel = doc.querySelector("#cal-sys button.on") ? doc.querySelector("#cal-sys button.on").textContent : "";
  check("calendar-system buttons are labelled in Persian", jalaliLabel === "شمسی", JSON.stringify(jalaliLabel));
  const legend = doc.querySelector(".cal-legend").textContent;
  check("legend shows impact labels in Persian", legend.includes("اهمیت بالا"), legend.trim().slice(0, 40));
  const tipTxt = doc.querySelector(".cal-tip") ? doc.querySelector(".cal-tip").textContent : "";

  // ---------- 3. the three controls that called the non-existent UI.page ----------
  const before = T.Calendar.monthName(T.Calendar.anchor, T.Calendar.system);
  let threw = "";
  try {
    doc.getElementById("cal-next").click();
  } catch (e) { threw = e.message; }
  await new Promise((r) => setTimeout(r, 50));
  const after = T.Calendar.monthName(T.Calendar.anchor, T.Calendar.system);
  check("next-month button works (no ReferenceError)", threw === "" && before !== after, threw || `${before} -> ${after}`);

  threw = "";
  try { doc.getElementById("cal-prev").click(); } catch (e) { threw = e.message; }
  await new Promise((r) => setTimeout(r, 50));
  check("prev-month button works", threw === "", threw || "ok");

  threw = "";
  try { doc.getElementById("cal-today").click(); } catch (e) { threw = e.message; }
  await new Promise((r) => setTimeout(r, 50));
  check("today button works", threw === "", threw || "ok");

  threw = "";
  try { doc.querySelector('#cal-sys button[data-sys="gregorian"]').click(); } catch (e) { threw = e.message; }
  await new Promise((r) => setTimeout(r, 80));
  const sys = T.Calendar.system;
  const cells2 = doc.querySelectorAll("#cal-grid .cal-cell").length;
  check("calendar-system switch works and repaints", threw === "" && sys === "gregorian" && cells2 === 42, threw || `system=${sys} cells=${cells2}`);

  // ---------- 4. hover tooltip ----------
  threw = "";
  try {
    const c = doc.querySelector("#cal-grid .cal-cell.has");
    c.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
  } catch (e) { threw = e.message; }
  const tipEl = doc.getElementById("cal-tip");
  const tip = tipEl && !tipEl.hidden ? tipEl.textContent.length : 0;
  check("hover opens the detail tooltip", threw === "" && tip > 0, threw || `${tip} chars of detail`);

  // ---------- 5. day click ----------
  threw = "";
  try { doc.querySelector("#cal-grid .cal-cell.has").click(); } catch (e) { threw = e.message; }
  const dayPanel = doc.getElementById("cal-day").textContent.length;
  check("clicking a day fills the detail panel", threw === "" && dayPanel > 0, threw || `${dayPanel} chars`);

  // ---------- 6. the backtest results card renders in a real DOM ----------
  //
  // The card was an empty <div> for a long time, so the thing worth proving
  // is that a finished run now puts its curve and its trades on screen
  // through the real template and the real translation pack.
  {
    const curve = [1000, 1012, 991, 1033, 1048];
    T.S.backtest = {
      ok: true, running: false, mode: "backtest",
      symbol: "EURUSD", timeframe: "M15", strategy: "ema_rsi", bars: 900,
      metrics: { win_rate: 60, profit_factor: 1.7, sharpe: 0.9, avg_rr: 1.4, net: 48, trades: 5 },
      equity_curve: curve,
      trades: [
        { type: "buy", entry: 1.0812, exit: 1.0840, profit: 28, time: "2026-01-02T08:00:00Z", exit_reason: "tp" },
        { type: "sell", entry: 1.0851, exit: 1.0862, profit: -11, time: "2026-01-02T11:00:00Z", exit_reason: "sl" },
      ],
    };
    let threw = "";
    let html = "";
    try { html = String(T.views.backtest()); } catch (e) { threw = e.message; }
    check("views.backtest() renders without throwing", threw === "", threw || "ok");
    check("the results card is no longer an empty div",
      /id="bt-extra">\s*\S/.test(html), html.includes('id="bt-extra"') ? "has content" : "no bt-extra at all");
    check("a finished run draws an equity-curve canvas", html.includes('id="bt-curve"'));

    check("the results card can be scrolled to", html.includes('id="bt-extra-card"'));

    // Every string must come from the Persian pack, not leak as a raw key.
    const text = html.replace(/<[^>]+>/g, " ");
    /* fmt() localises, so under the Persian pack every figure comes back in
       Persian digits. Fold them to ASCII before asserting on values -
       otherwise this checks the locale, not the arithmetic. */
    const ascii = (x) => String(x)
      .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
      .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace(/\u066B/g, ".").replace(/[\u060C\u066C]/g, ",");
    const plain = ascii(text);
    const raw = text.match(/\b(?:bt|history|upd)\.[a-z_]+/g) || [];
    check("no untranslated keys in the backtest view", raw.length === 0, [...new Set(raw)].join(", ") || "none");

    check("the trades it took are listed",
      plain.includes("1.0812") && plain.includes("1.0862"),
      plain.slice(plain.indexOf("1.08") - 10, plain.indexOf("1.08") + 60));
    check("a losing trade is shown as a loss, not an absolute value",
      /[-\u2212]\s?11/.test(plain), plain.includes("11") ? "11 present" : "no 11 at all");

    /* A drawdown is a fall from a peak that PRECEDES it. In
       [1000, 1012, 991, 1033, 1048] the only such fall is 1012 -> 991, so
       the answer is 21. (1033 is higher than 991 but comes after it, which
       is exactly the trap a naive max-minus-min would fall into: that
       would report 1048 - 991 = 57 and overstate the risk.) */
    check("the drawdown is measured peak-to-trough, not max-minus-min",
      /\b21\b/.test(plain) && !/\b57\b/.test(plain),
      (plain.match(/-?\d[\d,]*(?:\.\d+)?/g) || []).join(" ").slice(0, 100));
    check("the final equity is the last curve point", /1,?048/.test(plain));
  }

  // ---------- 7. symbol picker ----------
  const pickerSrc = fs.readFileSync(path.join(WEB, "js/app.js"), "utf8");
  check("symbol picker writes to the hidden field the engine reads", /id="pr-syms" type="hidden"|type="hidden" id="pr-syms"/.test(pickerSrc));

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (consoleErrors.length) console.log("console/jsdom errors:", consoleErrors.slice(0, 5));
  process.exit(failed.length ? 1 : 0);
})();
