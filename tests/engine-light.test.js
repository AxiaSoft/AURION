/**
 * The engine light in the header has to be true NOW.
 *
 * Asked for in one line: "make the engine's state in the header live".
 * It was not live, and the cause was a single line in refresh():
 *
 *     } else S.snap = S.snap || null;
 *
 * A failed poll keeps the last good snapshot. That is right for the
 * tables - a stale number is better than a screen that empties itself
 * whenever a request times out - but the header chip was reading
 * Boolean(S.snap), which asks "have we ever had a snapshot", and
 * printing it as "Engine: live". An engine that died at 10:02 stayed
 * green until somebody reloaded the page. The one light whose whole
 * job is to say whether the engine is there was the one thing on the
 * screen that could not say it.
 *
 * What is pinned here, against a real desk in a DOM:
 *
 *   1. The chip follows the engine, not the age of S.snap.
 *   2. The socket is the fast path: the desk's /ws is a proxy of the
 *      engine's stream, so the backend knows the instant it drops.
 *   3. A failed poll is news. It used to throw out of refresh()
 *      entirely, because API.req does not wrap its fetch.
 *   4. /api/health is the fallback, polled only while the engine is
 *      down or quiet - never as a heartbeat on a healthy desk.
 *   5. MT5 cannot be "live" through an engine that is gone.
 *   6. The backend says "online" as well as "offline", or recovery
 *      would still wait twelve seconds.
 *
 *     node tests/engine-light.test.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const results = [];
const queue = [];

/* Queued rather than run on the spot, because two of these have to
   await a probe. A `check` that called an async function and threw
   away the promise reported PASS for a rejected assertion - which is
   the one failure mode a test suite must not have. */
function check(name, fn) {
  queue.push(async () => {
    try {
      const note = await fn();
      results.push(true);
      console.log("PASS  " + name + (note ? "  — " + note : ""));
    } catch (e) {
      results.push(false);
      console.log("FAIL  " + name + "\n      " + e.message);
    }
  });
}

const HEADER = `
  <div class="hdr-status" id="hdr-status">
    <span class="st-chip" id="st-engine" data-state="down">Engine</span>
    <span class="st-chip mt5" id="st-mt5" data-state="down">MT5</span>
    <span class="st-chip tape" id="st-tape" data-state="idle">EA</span>
    <span class="st-eq mono" id="st-eq"></span>
  </div>
  <button id="btn-kill"></button><button id="btn-lang"></button>
  <div id="hdr-drawer" hidden></div>`;

/** A desk, in a DOM, with the header it really ships. */
function desk(fetchImpl) {
  const files = ["themes.js", "skins.js", "i18n.js", "api.js", "calendar.js",
    "chart-series.js", "charts.js", "chart-tools.js", "pnl-charts.js", "datetime.js", "app.js"];
  const src = files.map((f) => read("js/" + f)).join("\n;\n");
  const dom = new JSDOM(`<!doctype html><html><body>${HEADER}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/",
      virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.fetch = fetchImpl || (() => Promise.resolve({
    ok: true, json: () => Promise.resolve({ ok: true, engine: "online" }),
  }));
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {} });
  win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:x";
  win.AudioContext = class {};
  win.eval(src + ";window.__E={S,I18N,noteEngine,engineUp,probeEngine,headerState," +
    "onLive,mt5Live,startEngineWatch,stopEngineWatch,hdrDrawerHtml};");
  return win;
}

const chipState = (win) => win.document.getElementById("st-engine").dataset.state;

/* ====================================================== 1. the chip ==== */

check("a dead engine turns the light red even though the snapshot survives", () => {
  const win = desk();
  const T = win.__E;
  T.S.snap = { mt5: { connected: true, account: { equity: 1000, currency: "USD" } } };

  T.noteEngine(true, "test");
  if (chipState(win) !== "live") throw new Error("a live engine does not light the chip");

  /* The snapshot is deliberately left exactly where it was: the tables
     keep their last good reading, and the light still has to change. */
  T.noteEngine(false, "test");
  if (T.S.snap === null) throw new Error("the snapshot was thrown away - the tables would blank");
  if (chipState(win) !== "down") throw new Error("the engine died and the chip stayed green");
  return "snapshot kept, light honest";
});

check("the light repaints on the spot, not at the next render", () => {
  const win = desk();
  const T = win.__E;
  T.noteEngine(true, "test");
  const before = win.document.getElementById("st-engine").textContent;
  T.noteEngine(false, "test");
  const after = win.document.getElementById("st-engine").textContent;
  if (before === after) throw new Error("the label did not change without another render pass");
  return "noteEngine paints";
});

check("the chip says since when, in the trader's locale", () => {
  const win = desk();
  const T = win.__E;
  T.noteEngine(false, "test");
  const title = win.document.getElementById("st-engine").title;
  if (!title || !/·/.test(title)) throw new Error("no 'since' on the chip: " + title);
  return title;
});

/* ================================================= 2. the fast path ==== */

check("the socket's engine notice moves the light immediately", () => {
  const win = desk();
  const T = win.__E;
  T.noteEngine(true, "test");
  T.onLive({ type: "engine", data: { state: "offline" } });
  if (chipState(win) !== "down") throw new Error("the backend said offline and nothing happened");
  T.onLive({ type: "engine", data: { state: "online" } });
  if (chipState(win) !== "live") throw new Error("the backend said online and nothing happened");
  return "both directions";
});

check("any message relayed from the engine counts as proof of life", () => {
  const win = desk();
  const T = win.__E;
  T.noteEngine(false, "test");
  T.onLive({ type: "tick", data: { symbol: "EURUSD", bid: 1, ask: 1 } });
  if (chipState(win) !== "live") throw new Error("a tick arrived from an engine said to be dead");
  return "a tick is an engine";
});

check("'ready' is the desk talking, not the engine", () => {
  /* The backend sends `ready` the moment the browser authenticates -
     before it has even tried to reach the engine. Counting it as proof
     of life would light the chip green on a machine with no engine at
     all, which is precisely the machine this was reported from. */
  const win = desk();
  const T = win.__E;
  T.noteEngine(false, "test");
  T.onLive({ type: "ready", user: {} });
  if (chipState(win) !== "down") throw new Error("the desk's own hello lit the engine chip");
  return "not counted";
});

/* ================================================= 3./4. the fallbacks = */

check("a health probe that says offline turns the light red", async () => {
  const win = desk(() => Promise.resolve({
    ok: true, json: () => Promise.resolve({ ok: true, engine: "offline", supervisor: {} }),
  }));
  const T = win.__E;
  T.noteEngine(true, "test");
  await T.probeEngine();
  if (chipState(win) !== "down") throw new Error("/api/health said offline and the chip stayed green");
  return "offline";
});

check("a desk that cannot be reached at all is not a live engine", async () => {
  const win = desk(() => Promise.reject(new Error("network")));
  const T = win.__E;
  T.noteEngine(true, "test");
  await T.probeEngine();
  if (chipState(win) !== "down") throw new Error("fetch threw and the chip stayed green");
  return "rejected fetch handled";
});

check("the probe does not carry the token, and does not use the cache", () => {
  const src = read("js/app.js");
  const fn = src.slice(src.indexOf("async function probeEngine"), src.indexOf("function startEngineWatch"));
  if (/API\.(get|post|req)/.test(fn)) {
    throw new Error("it goes through API.req, whose fetch is unwrapped - the throw is the case being measured");
  }
  if (!/no-store/.test(fn)) throw new Error("a cached 'online' would be worse than no probe");
  return "plain fetch, no-store";
});

check("a healthy desk is not polled every two seconds for nothing", () => {
  const src = read("js/app.js");
  const watch = src.slice(src.indexOf("function startEngineWatch"), src.indexOf("function stopEngineWatch"));
  if (!/_engineUp !== true \|\| quiet/.test(watch)) {
    throw new Error("the probe runs regardless of what the socket is already telling us");
  }
  if (!/document\.hidden/.test(watch)) throw new Error("a hidden tab keeps polling");
  return "only while down or quiet";
});

check("a failed snapshot poll reports instead of throwing", () => {
  const src = read("js/app.js");
  const fn = src.slice(src.indexOf("async function refresh("), src.indexOf("function onLive("));
  if (!/catch \(err\)/.test(fn)) throw new Error("API.req's unwrapped fetch still throws out of refresh()");
  if (!/noteEngine\(Boolean\(r\.ok\)/.test(fn)) throw new Error("the poll's verdict never reaches the light");
  if (!/auth_required/.test(fn)) {
    throw new Error("a logged-out desk would be reported as a dead engine");
  }
  return "reported, with auth excluded";
});

/* ======================================================= 5. the MT5 ==== */

check("MT5 cannot be live through an engine that is gone", () => {
  const win = desk();
  const T = win.__E;
  T.S.snap = { mt5: { connected: true, account: {} } };
  T.noteEngine(true, "test");
  if (!T.mt5Live()) throw new Error("a connected terminal is not reported as connected");
  T.noteEngine(false, "test");
  if (T.mt5Live()) throw new Error("two green lights over a dead desk");
  if (win.document.getElementById("st-mt5").dataset.state !== "down") {
    throw new Error("the MT5 chip still claims a terminal it cannot reach");
  }
  return "one red light, not two green";
});

check("the pull-down drawer agrees with the header", () => {
  const win = desk();
  const T = win.__E;
  T.S.snap = { mt5: { connected: true, account: {} } };
  T.noteEngine(false, "test");
  const html = T.hdrDrawerHtml();
  if (/data-state="live"/.test(html.split("</span>")[0])) {
    throw new Error("the drawer's first chip disagrees with the header's");
  }
  return "same answer in both places";
});

/* =================================================== 6. the backend ==== */

check("the backend announces both directions on the socket", () => {
  const src = readRoot("backend/src/index.js");
  const fn = src.slice(src.indexOf("function connectUpstream"), src.indexOf("function connectUpstream") + 2600);
  if (!/upstream\.on\("open"[\s\S]{0,80}online/.test(fn)) {
    throw new Error("recovery is never announced, so the light waits for the next poll");
  }
  if (!/upstream\.on\("error"[\s\S]{0,120}offline/.test(fn)) {
    throw new Error("a refused connection still closes the browser's socket in silence");
  }
  if (!/upstream\.on\("close"[\s\S]{0,160}offline/.test(fn)) {
    throw new Error("a dropped engine is no longer reported");
  }
  return "open, close and error all speak";
});

/* ------------------------------------------------------------------ */

(async () => {
  for (const run of queue) await run();
  const failed = results.filter((r) => !r).length;
  console.log("\nengine-light: " + (results.length - failed) + " of " + results.length + " checks passed");
  process.exit(failed ? 1 : 0);
})();
