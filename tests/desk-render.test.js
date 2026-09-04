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

const NEWS = {
  ok: true,
  data: {
    count: 3,
    source: "config/news_calendar.template.csv",
    blackout_before: 15,
    blackout_after: 15,
    events: [
      { time: "2026-09-05T12:30:00Z", currency: "USD", impact: "high", title: "Non-Farm Payrolls" },
      { time: "2026-09-05T14:00:00Z", currency: "EUR", impact: "medium", title: "ECB Press Conference" },
      { time: "2026-09-07T01:00:00Z", currency: "AUD", impact: "low", title: "RBA Rate Decision" },
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

  // ---------- 6. symbol picker ----------
  const pickerSrc = fs.readFileSync(path.join(WEB, "js/app.js"), "utf8");
  check("symbol picker writes to the hidden field the engine reads", /id="pr-syms" type="hidden"|type="hidden" id="pr-syms"/.test(pickerSrc));

  console.log("");
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (consoleErrors.length) console.log("console/jsdom errors:", consoleErrors.slice(0, 5));
  process.exit(failed.length ? 1 : 0);
})();
