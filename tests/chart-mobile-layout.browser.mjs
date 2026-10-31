/**
 * The same bug, measured instead of inferred.
 *
 * tests/chart-mobile-layout.test.js asserts the two fixes are in place.
 * This one proves they do the job, because the defect is a LAYOUT fact
 * and jsdom has no layout - every box it reports is 0x0. Three rounds of
 * reading the stylesheet got the cause wrong; one run of this printed it:
 *
 *     .tv  390x844  scrollWidth=690  scrollLeft=-151
 *
 * It needs a Chromium. There is no network in CI for one, so it is opt
 * in and skips cleanly:
 *
 *   npm i -D puppeteer-core @sparticuz/chromium      # or any Chrome
 *   npx http-server apps/web -p 8099 -s &
 *   AURION_CHROME=/path/to/chrome node tests/chart-mobile-layout.browser.mjs
 *
 * It walks RTL and LTR across portrait, large phone, landscape and
 * tablet, opens an EA chart the way a thumb does - scroll the card list,
 * tap the last card - and fails if the workspace has any scroll offset,
 * if it is not flush with the viewport, or if the back button, the panel
 * toggle or the tools button is off screen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ORIGIN = process.env.AURION_ORIGIN || "http://127.0.0.1:8099";
const CHROME = process.env.AURION_CHROME;

let puppeteer = null;
try { puppeteer = (await import("puppeteer-core")).default; } catch { /* optional */ }
if (!puppeteer) { console.log("SKIP  chart mobile layout, measured (puppeteer-core not installed)"); process.exit(0); }
if (!CHROME || !fs.existsSync(CHROME)) { console.log("SKIP  chart mobile layout, measured (set AURION_CHROME)"); process.exit(0); }
try {
  const r = await fetch(ORIGIN + "/index.html");
  if (!r.ok) throw new Error(String(r.status));
} catch (e) {
  console.log(`SKIP  chart mobile layout, measured (nothing serving ${ORIGIN}: ${e.message})`);
  process.exit(0);
}

/* A desk with EA charts on it and no backend behind it. */
const SEED = () => {
  localStorage.setItem("aurion.token", "probe-token");
  localStorage.setItem("aurion.view", "charts");
  localStorage.setItem("aurion.welcome.seen", "1");
  const J = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  const real = window.fetch;
  window.fetch = async (u, o) => (/\/api\//.test(String(u)) ? J({ ok: true, data: {} }) : real(u, o));
  window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} addEventListener() {} removeEventListener() {} };
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
};
const DESK = () => {
  document.getElementById("welcome")?.remove();
  document.getElementById("auth")?.classList.add("hidden");
  const a = (s, t) => ({ symbol: s, timeframe: t, alive: true, online: true, last_seen: Date.now(), ea_name: "AurionBridge" });
  // eslint-disable-next-line no-undef
  S.snap = Object.assign({}, S.snap, {
    engine: "online",
    agents: [a("EURUSD", "M15"), a("XAUUSD", "H1"), a("GBPUSD", "M5"), a("USDJPY", "H4"), a("AUDUSD", "M30")],
    mt5: { connected: true, account: { login: 1, currency: "USD", leverage: 500, equity: 1, balance: 1, profit: 0, margin: 0, margin_free: 1 } },
    positions: [], orders: [], ticks: {},
  });
  const bars = []; let p = 1.08; const t0 = Math.floor(Date.now() / 1000) - 240 * 900;
  for (let i = 0; i < 240; i++) {
    const o = p; p += (Math.sin(i / 7) + Math.random() - 0.5) * 0.002;
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, p) + 0.001, low: Math.min(o, p) - 0.001, close: p, volume: 100 });
  }
  // eslint-disable-next-line no-undef
  S.candles = bars; show("charts", { animate: false });
};
const MEASURE = () => {
  const tv = document.querySelector(".tv");
  if (!tv) return { noTv: true };
  const r = tv.getBoundingClientRect();
  const reach = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return "missing";
    const b = e.getBoundingClientRect();
    return (b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1)
      ? "ok" : `off(${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)})`;
  };
  return {
    sl: tv.scrollLeft, st: tv.scrollTop, sw: tv.scrollWidth, cw: tv.clientWidth,
    ov: getComputedStyle(tv).overflow,
    x: Math.round(r.x), w: Math.round(r.width), vw: innerWidth, vh: innerHeight,
    statusBottom: Math.round(document.querySelector(".tv-status").getBoundingClientRect().bottom),
    back: reach("#tv-back"), dock: reach("#tv-dock-toggle"), fab: reach("#tv-toolsfab"),
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "shell",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});

let failed = 0;
for (const lang of ["fa", "en"]) {
  for (const [W, H, label] of [[390, 844, "phone portrait"], [414, 896, "large phone"], [844, 390, "phone landscape"], [768, 1024, "tablet"]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: W < 900, hasTouch: true });
    await page.evaluateOnNewDocument(SEED);
    await page.evaluateOnNewDocument((l) => localStorage.setItem("aurion.lang", l), lang);
    await page.goto(ORIGIN + "/index.html", { waitUntil: "networkidle0", timeout: 45000 });
    await sleep(900);
    await page.evaluate(DESK);
    await sleep(400);
    // a thumb scrolls the card list, then taps the last chart
    await page.evaluate(() => { document.querySelector(".stage").scrollTop = 1200; });
    await page.evaluate(() => { const c = [...document.querySelectorAll("[data-open-chart]")]; (c.at(-1) || c[0]).click(); });
    await sleep(1500);

    const m = await page.evaluate(MEASURE);
    // and again after the two parked panels have been opened and closed
    await page.evaluate(() => document.getElementById("tv-toolsfab")?.click());
    await sleep(450);
    await page.evaluate(() => document.getElementById("tv-toolsfab")?.click());
    await page.evaluate(() => document.getElementById("tv-dock-toggle")?.click());
    await sleep(550);
    const m2 = await page.evaluate(MEASURE);

    const why = [];
    if (m.noTv) why.push("no workspace rendered");
    else {
      if (m.sl !== 0 || m.st !== 0) why.push(`workspace scrolled to (${m.sl},${m.st})`);
      if (m2.sl !== 0 || m2.st !== 0) why.push(`scrolled to (${m2.sl},${m2.st}) after using the panels`);
      if (m.ov !== "clip") why.push(`overflow is ${m.ov}, so it can be scrolled`);
      if (m.x < 0 || m.x + m.w > m.vw + 1) why.push(`workspace at x=${m.x} w=${m.w} in a ${m.vw}px viewport`);
      if (m.statusBottom > m.vh + 1) why.push(`status bar at ${m.statusBottom} below a ${m.vh}px viewport`);
      for (const k of ["back", "dock", "fab"]) if (m[k] !== "ok" && m[k] !== "missing") why.push(`${k} is ${m[k]}`);
    }
    if (why.length) failed++;
    console.log(`${why.length ? "FAIL" : "PASS"}  ${lang === "fa" ? "RTL" : "LTR"} ${(W + "x" + H).padEnd(9)} ${label.padEnd(16)}`
      + (why.length ? "-- " + why.join("; ") : `tv.scroll=(0,0) ov=${m.ov} x=${m.x} w=${m.w}/${m.vw}`));
    await page.close();
  }
}
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nchart mobile layout: all configurations clean");
process.exit(failed ? 1 : 0);
