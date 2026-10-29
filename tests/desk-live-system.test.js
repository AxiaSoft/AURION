/**
 * Three desk complaints.
 *
 *   1. "The live analysis is not live -- it should refresh itself
 *      instead of me refreshing by hand." It did not. The card was
 *      built once when the intelligence page mounted and never touched
 *      again: patchLive refreshed the regime, the features and the
 *      activity feed beside it, but never the verdict, the confidence
 *      meter, the blockers or the console. The one card on the page
 *      named "live analysis" was the only frozen thing on it.
 *
 *   2. The EA chart's exit-fullscreen control had to go, and on a phone
 *      the device's own back button must not drop out of fullscreen --
 *      only the chart's back button, which lands on the charts list.
 *
 *   3. Settings -> System had to gain licence activation and the
 *      interface language, both redesigned. Activation was especially
 *      worth checking: the card existed and its buttons were bound, but
 *      nothing ever rendered it.
 *
 * (1) is driven for real -- a snapshot is changed under a mounted card
 * and the DOM is read back -- because the bug was a missing call, and a
 * test that only greps for that call would pass on a card that still
 * does not update. (2) and (3) are a mix: the parts with a DOM are
 * built and inspected, the parts that are about what the browser does
 * on a real phone are checked against the source, since jsdom has
 * neither a fullscreen implementation nor a back button.
 *
 *     node tests/desk-live-system.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const appJs = read("js/app.js");
const chartJs = read("js/chart-tools.js");
const appCss = read("css/app.css");

/**
 * Source with comments removed.
 *
 * Needed because the checks below ask "does this code still call
 * setFullscreen(false)?", and the comment explaining why it no longer
 * does says those very words. Grepping the raw text matched the
 * explanation and reported the bug as unfixed.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const chartCode = code(chartJs);

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/* ------------------------------------------------------- a real desk === */

function desk() {
  const files = ["themes.js", "skins.js", "i18n.js", "api.js", "calendar.js",
    "chart-series.js", "charts.js", "chart-tools.js", "pnl-charts.js", "app.js"];
  const src = files.map((f) => read("js/" + f)).join("\n;\n");
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>",
    { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/",
      virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:x";
  win.AudioContext = class {};
  win.eval(src + ";window.__T={views,S,I18N,showSetTab,patchLive,analysisCardHtml," +
    "patchAnalysisCard,stampAnalysisAge,licenseCardHtml,languageCardHtml};");
  return win;
}

/** An engine reading of the market, as the snapshot carries it. */
function analysis(conf, blockers, lines, ready) {
  return {
    symbol: "XAUUSD", timeframe: "M15", ready: Boolean(ready), setup: ready ? {} : null,
    strategy: "ema_rsi", strategy_enabled: true,
    ai: { confidence: conf, min_confidence: 0.6, gate: true },
    blockers, when: "at the next close", refusals: [], resting: [], console: lines,
  };
}

/* ============================================ 1. the live analysis card === */

check("the analysis card updates itself when the engine's reading changes", () => {
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { analysis: analysis(0.42, [{ text: "spread too wide" }], []), ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();

  const conf = () => doc.querySelector("#an-card .ai-conf-head b")?.textContent;
  const blockers = () => [...doc.querySelectorAll("#an-card .an-why li b")].map((e) => e.textContent);
  if (conf() !== "42%") throw new Error("the card did not paint the first reading");

  // No remount, no reload -- exactly the situation the user described.
  S.snap.analysis = analysis(0.71, [], [], true);
  T.patchLive();

  if (conf() !== "71%") throw new Error("confidence is still " + conf() + " after a live tick");
  if (blockers().length) throw new Error("a cleared blocker is still on screen");
  if (!doc.getElementById("an-card").className.includes("is-ready")) {
    throw new Error("the verdict did not follow the reading");
  }
  return "42% blocked -> 71% ready, in place";
});

check("the console on the card follows the engine too", () => {
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { analysis: analysis(0.5, [], [{ ts: "2026-10-30T10:00:01", code: "A", message: "one" }]), ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();
  const n = () => doc.querySelectorAll("#an-card #an-console .row-line").length;
  if (n() !== 1) throw new Error("expected one line, got " + n());
  S.snap.analysis = analysis(0.5, [], [
    { ts: "2026-10-30T10:00:01", code: "A", message: "one" },
    { ts: "2026-10-30T10:00:14", code: "B", message: "two" },
    { ts: "2026-10-30T10:00:27", code: "C", message: "three" }]);
  T.patchLive();
  if (n() !== 3) throw new Error("the console stopped at " + n() + " lines");
  return "1 -> 3 lines";
});

check("a tick that changes nothing does not rebuild the card", () => {
  // Rebuilding on every tick regardless would throw away the trader's
  // text selection and flicker the card several times a minute while
  // the market does nothing.
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { analysis: analysis(0.5, [], []), ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();
  T.patchLive();
  const node = doc.getElementById("an-card");
  T.patchLive();
  T.patchLive();
  if (doc.getElementById("an-card") !== node) throw new Error("the card was replaced for no reason");
  return "same node across 2 idle ticks";
});

check("a reader who closed the console keeps it closed through an update", () => {
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { analysis: analysis(0.5, [], [{ ts: "t", code: "A", message: "one" }]), ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();
  T.patchLive();
  doc.querySelector("#an-card details.ai-console").open = false;
  S.snap.analysis = analysis(0.9, [], [{ ts: "t", code: "B", message: "two" }]);
  T.patchLive();
  const det = doc.querySelector("#an-card details.ai-console");
  if (!det) throw new Error("the console disappeared");
  if (det.open) throw new Error("the update forced the console back open");
  return "stayed closed";
});

check("the card says how old its reading is, and the stamp is not in the cache", () => {
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { analysis: analysis(0.5, [], []), ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();
  if (!doc.getElementById("an-live")) throw new Error("no age stamp on the card");
  T.patchLive();
  const node = doc.getElementById("an-card");
  S._anAt = Date.now() - 9000;
  T.stampAnalysisAge();
  const aged = doc.getElementById("an-live").textContent;
  if (!aged) throw new Error("the stamp stayed empty");
  // If the stamp were part of the card's markup the comparison would
  // differ every second and the card would be rebuilt constantly.
  T.patchLive();
  if (doc.getElementById("an-card") !== node) {
    throw new Error("the ticking stamp is inside the cached markup and forces a rebuild");
  }
  return "stamp updates without rebuilding";
});

check("the waiting card can be swapped once an analysis arrives", () => {
  // It had no id, so there was nothing to find and replace.
  const win = desk();
  const T = win.__T, S = T.S, doc = win.document;
  S.snap = { ai: {} };
  S.view = "intelligence";
  doc.getElementById("host").innerHTML = T.analysisCardHtml();
  if (!doc.getElementById("an-card")) throw new Error("the waiting card is unaddressable");
  S.snap.analysis = analysis(0.8, [], [], true);
  T.patchLive();
  if (!doc.querySelector("#an-card .ai-conf-head")) {
    throw new Error("the waiting card was never replaced by the real one");
  }
  return "wait -> real card";
});

check("the age is restamped when the engine's reading actually changes", () => {
  // Without this the card would say "updated now" forever, which is a
  // worse lie than the frozen card was -- it would look live while
  // showing a reading from an hour ago. Checked against the source
  // because it happens inside the polling path, which needs a real
  // engine to drive.
  const m = /const r = await API\.get\("\/api\/snapshot"\);[\s\S]{0,600}?S\.snap = r\.data;/.exec(appJs);
  if (!m) throw new Error("the snapshot path has moved");
  if (!/S\._anAt = Date\.now\(\)/.test(m[0])) {
    throw new Error("a new analysis does not reset the age stamp");
  }
  // and only when it changed, not on every poll
  if (!/S\._anSig/.test(m[0])) {
    throw new Error("the age is restamped on every poll, so it always reads as fresh");
  }
  return "restamped on change only";
});

check("the age clock only runs while the page that shows it is open", () => {
  const m = /function startAnalysisClock\(\)[\s\S]*?\n}/.exec(appJs);
  if (!m) throw new Error("no clock");
  if (!/S\.view !== "intelligence"/.test(m[0])) {
    throw new Error("the clock does not stop when the trader leaves the page");
  }
  if (!/function stopAnalysisClock/.test(appJs)) throw new Error("the clock cannot be stopped");
  return "stops on leaving";
});

/* ================================================= 2. the EA chart === */

check("the fullscreen toggle is gone from the chart, not merely hidden", () => {
  if (chartJs.includes("tv-full")) throw new Error("#tv-full is still in the workspace");
  if (/if \(k === "f"\)[\s\S]{0,40}setFullscreen/.test(chartCode)) {
    throw new Error("the F shortcut still toggles fullscreen");
  }
  return "button, handler and shortcut removed";
});

check("the device back button no longer drags the desk out of fullscreen", () => {
  // Android's back exits the browser's fullscreen. This listener used
  // to take the desk's own fullscreen down with it, which left the
  // trader on the chart page in a window -- neither where they were
  // nor where they asked to go.
  const i = chartCode.indexOf('document.addEventListener("fullscreenchange"');
  if (i < 0) throw new Error("the fullscreenchange listener is gone entirely");
  const body = chartCode.slice(i, chartCode.indexOf("});", i));
  if (/setFullscreen\(false\)/.test(body)) {
    throw new Error("losing native fullscreen still collapses the desk's");
  }
  return "the two fullscreens are independent";
});

check("Escape does not leave the chart half-collapsed either", () => {
  const i = chartCode.indexOf('case "Escape":');
  const body = chartCode.slice(i, chartCode.indexOf('case "Delete"', i));
  if (/setFullscreen\(false\)/.test(body)) {
    throw new Error("Escape still drops fullscreen while staying on the chart");
  }
  return "Escape leaves fullscreen alone";
});

check("the chart's own back button is still the way out, and lands on the charts list", () => {
  const i = chartCode.indexOf('if (e.target.closest("#tv-back"))');
  if (i < 0) throw new Error("the back button lost its handler");
  const body = chartCode.slice(i, i + 400);
  if (!/setFullscreen\(false\)/.test(body)) throw new Error("back no longer leaves fullscreen");
  if (!/ctx\.onBack/.test(body)) throw new Error("back no longer navigates");
  // and the desk's end of it
  const close = /function closeChartDesk\(\)[\s\S]*?\n}/.exec(appJs);
  if (!close) throw new Error("closeChartDesk is gone");
  if (!/show\("charts"/.test(close[0])) throw new Error("back does not land on the charts section");
  if (!/chart-full/.test(close[0])) throw new Error("the desk's own fullscreen class is not cleared");
  return "back -> not fullscreen -> charts";
});

/* ============================================ 3. Settings -> System === */

function settingsDesk(license) {
  const win = desk();
  const T = win.__T, S = T.S;
  S.snap = {
    mt5: {}, agents: [],
    license: license,
    strategy: { system: { timezone: "UTC", choices: [] } },
  };
  S.setTab = "set-system";
  win.document.getElementById("host").innerHTML = T.views.settings();
  return win;
}
const PAID = { paid: true, plan: "m1", plan_label: "1 Month", expires: "2026-12-01",
  days_left: 20, plans: { m1: { days: 30 } }, bot_remaining: 120 };

check("licence activation is on the System page at all", () => {
  // The card was written and its buttons were bound, but no page ever
  // rendered it -- so the handler at the other end could never fire.
  const win = settingsDesk(PAID);
  const sys = win.document.getElementById("set-system");
  if (!sys) throw new Error("there is no System section");
  for (const id of ["lic-card", "lic-key", "lic-go", "lic-msg", "lic-upd"]) {
    if (!sys.querySelector("#" + id)) throw new Error("#" + id + " is not on the System page");
  }
  return "card, key field, activate and update check";
});

check("the activate button the page renders is the one the binder wires", () => {
  // The two halves drifting apart is exactly how this got lost before.
  if (!/\$\("lic-go"\)/.test(appJs)) throw new Error("nothing binds #lic-go");
  if (!/\$\("lic-key"\)/.test(appJs)) throw new Error("nothing reads #lic-key");
  const i = appJs.indexOf('const licGo = $("lic-go")');
  const body = appJs.slice(i, i + 700);
  if (!/\/api\/license\/activate/.test(body)) throw new Error("activate does not call the engine");
  return "bound to /api/license/activate";
});

check("the licence card leads with its state, in words", () => {
  const win = settingsDesk(PAID);
  const card = win.document.getElementById("lic-card");
  if (!card.querySelector(".lic-state")) throw new Error("no state line");
  if (!/is-ok/.test(card.className)) throw new Error("an active licence does not read as active: " + card.className);
  return "is-ok";
});

check("a licence about to run out is called out rather than left as a date", () => {
  const win = settingsDesk({ ...PAID, days_left: 4 });
  const card = win.document.getElementById("lic-card");
  if (!/is-warn/.test(card.className)) throw new Error("4 days left still reads as " + card.className);
  const bar = card.querySelector(".lic-bar i");
  if (!bar) throw new Error("no term bar");
  if (!/--w:13%/.test(bar.getAttribute("style") || "")) {
    throw new Error("the bar does not show 4 of 30: " + bar.getAttribute("style"));
  }
  return "is-warn, bar at 13%";
});

check("a trial has no term to draw, and says it is a trial", () => {
  const win = settingsDesk({ trial: true, paid: false, plan: "trial", bot_remaining: 3 });
  const card = win.document.getElementById("lic-card");
  if (!/is-trial/.test(card.className)) throw new Error("reads as " + card.className);
  if (card.querySelector(".lic-bar")) throw new Error("a trial drew a days-remaining bar");
  return "is-trial, no bar";
});

check("the interface language moved to System and is no longer a section of its own", () => {
  const win = settingsDesk(PAID);
  const doc = win.document;
  const sys = doc.getElementById("set-system");
  const langs = sys.querySelector("#set-langs");
  if (!langs) throw new Error("the language picker is not in System");
  const ids = [...langs.querySelectorAll("[data-lang]")].map((b) => b.dataset.lang);
  if (ids.join(",") !== "en,fa,ar") throw new Error("languages offered: " + ids.join(","));
  if (doc.getElementById("set-lang")) throw new Error("the old Language section is still built");
  if (doc.querySelector('[data-jump="set-lang"]')) throw new Error("the rail still lists Language");
  return "en,fa,ar inside System";
});

check("each language is named in its own script, not just the current one", () => {
  // Someone who cannot read the language the desk is in has to be able
  // to find their own.
  const win = settingsDesk(PAID);
  const text = win.document.querySelector("#set-langs").textContent;
  for (const [lang, native] of [["fa", "\u0641\u0627\u0631\u0633\u06cc"], ["ar", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629"], ["en", "English"]]) {
    if (!text.includes(native)) throw new Error(lang + " is not written in its own script");
  }
  return "English, \u0641\u0627\u0631\u0633\u06cc, \u0627\u0644\u0639\u0631\u0628\u064a\u0629";
});

check("the language still changes the language", () => {
  // Moving the markup must not orphan the click handler, which finds
  // the container by id.
  if (!/\$\("set-langs"\)/.test(appJs)) throw new Error("nothing binds #set-langs");
  const i = appJs.indexOf('const langs = $("set-langs")');
  if (!/setLang\(b\.dataset\.lang\)/.test(appJs.slice(i, i + 300))) {
    throw new Error("picking a language no longer calls setLang");
  }
  if (!/document\.querySelectorAll\("\[data-lang\]"\)/.test(appJs)) {
    throw new Error("nothing marks the current language");
  }
  return "bound by id, marked by [data-lang]";
});

check("a desk left on the deleted Language tab still opens", () => {
  // The tab is remembered across restarts, so this is the upgrade path
  // for anyone whose last visit was that page.
  const win = settingsDesk(PAID);
  win.__T.S.setTab = "set-lang";
  win.__T.showSetTab("set-lang");
  if (win.__T.S.setTab !== "set-system") {
    throw new Error("landed on " + win.__T.S.setTab + " instead of System");
  }
  return "set-lang -> set-system";
});

check("the build tag is a real build tag, not a dash", () => {
  // There were two buildTag functions; declarations hoist, so the
  // second always won and the no-argument calls rendered "DSK-—".
  const defs = appJs.match(/function buildTag\(/g) || [];
  if (defs.length !== 1) throw new Error(defs.length + " buildTag definitions still exist");
  if (/buildTag\(\)/.test(appJs)) throw new Error("a no-argument buildTag() call is left");
  const win = settingsDesk(PAID);
  win.__T.S.buildDate = "2026-10-30";
  win.document.getElementById("host").innerHTML = win.__T.views.settings();
  const tag = win.document.getElementById("build-tag").textContent;
  if (tag !== "DSK-301026") throw new Error("build tag reads " + tag);
  return tag;
});

check("the guides survived the move out of the Language page", () => {
  const win = settingsDesk(PAID);
  const hrefs = [...win.document.querySelectorAll("#set-system .sys-guides a")]
    .map((a) => a.getAttribute("href"));
  if (hrefs.length !== 2) throw new Error("found " + hrefs.length + " guide links");
  return hrefs.join(" ");
});

check("both new cards are styled, for a phone as well as a desktop", () => {
  for (const sel of [".lic-card", ".lic-state", ".lic-bar", ".lic-act", ".lang-grid", ".lang-opt", ".lang-tick"]) {
    if (!appCss.includes(sel)) throw new Error("no rule for " + sel);
  }
  const at = appCss.indexOf(".lic-head{");
  if (at < 0) throw new Error("the licence card has no layout");
  if (appCss.slice(at).indexOf("@media (max-width:560px)") < 0) {
    throw new Error("neither card has narrow-screen rules");
  }
  if (!/\.lang-grid\{[^}]*auto-fit/.test(appCss.replace(/\s*\n\s*/g, ""))) {
    throw new Error("the language grid does not reflow");
  }
  return "styled, with a 560px block";
});

check("the new chrome is written for RTL", () => {
  const at = appCss.indexOf("Settings -> System: licence and language");
  const block = appCss.slice(at);
  const bad = block.match(/(?:margin|padding|border)-(?:left|right):/g);
  if (bad) throw new Error("physical sides in an RTL desk: " + [...new Set(bad)].join(" "));
  if (!/border-inline-start/.test(block)) throw new Error("the state stripe is not logical");
  return "logical sides only";
});

/* ------------------------------------------------------------------ */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log(
  "\ndesk-live-system: " + (failed ? failed + " FAILED of " : "") +
  passed + " of " + results.length + " checks passed"
);
process.exit(failed ? 1 : 0);
