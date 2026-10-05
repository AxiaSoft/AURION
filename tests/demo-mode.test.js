/**
 * Drive the published demo the way a visitor does.
 *
 * The demo is the only build of the desk nobody runs locally before pushing,
 * which makes it exactly the build that rots.  This loads the real page from
 * a plain static server -- the same thing GitHub Pages is -- and checks that
 * a visitor gets through the gate and onto a desk with data in it.
 *
 *   node tests/demo-mode.test.js                     # serves the repo itself
 *   node tests/demo-mode.test.js --base http://host  # against a deployment
 */

const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");

/**
 * Fetch the scripts and nothing else.
 *
 * apps/web ships 21 MB of artwork and a welcome video. jsdom will happily
 * pull all of it and then sit there, and none of it affects whether the demo
 * answers the API, which is what this is checking.
 */
class ScriptsOnly extends ResourceLoader {
  fetch(url, options) {
    if (options && options.element && options.element.tagName === "SCRIPT") {
      return super.fetch(url, options);
    }
    if (/\.(js|mjs|json)(\?|$)/.test(url)) return super.fetch(url, options);
    return null;
  }
}

const ROOT = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ico": "image/x-icon",
};

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail: detail || "" });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;

  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    if (!/Not implemented/.test(String(e && e.message))) console.error("jsdom:", e.message);
  });

  // The page is read directly and handed to jsdom with its real URL, rather
  // than JSDOM.fromURL, because the resource loader below returns null for
  // everything that is not a script and fromURL routes the document itself
  // through that same loader.
  const pageUrl = `${base}/apps/web/index.html?demo=1`;
  const html = await fetch(pageUrl).then((r) => r.text());

  const dom = new JSDOM(html, {
    url: pageUrl,
    runScripts: "dangerously",
    resources: new ScriptsOnly(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    // jsdom implements none of these and the desk uses all of them at boot.
    // They have to exist before the page's own scripts parse, which is what
    // beforeParse is for.
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      win.AudioContext = win.AudioContext || function () {
        return { createGain: () => ({}), createOscillator: () => ({}), destination: {}, currentTime: 0, resume: async () => {} };
      };
      win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.scrollTo = () => {};
      win.Element.prototype.setPointerCapture = function () {};
      win.Element.prototype.releasePointerCapture = function () {};
      win.Element.prototype.hasPointerCapture = function () { return false; };
      // jsdom has no canvas backend, so getContext("2d") returns null and the
      // chart dies on its first paint. This records the drawing instead of
      // rasterising it, which is better than a real canvas here: the test can
      // then assert on what the chart drew rather than on pixels.
      win.HTMLCanvasElement.prototype.getContext = function () {
        const calls = (this.__calls = this.__calls || []);
        const noop = (name) => (...args) => { calls.push([name, ...args]); };
        const ctx = {
          canvas: this, __calls: calls,
          fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
          textBaseline: "", globalAlpha: 1, lineCap: "", lineJoin: "", filter: "",
          shadowBlur: 0, shadowColor: "", lineDashOffset: 0,
          measureText: () => ({ width: 10 }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          createPattern: () => null,
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData: noop("putImageData"),
          setLineDash: noop("setLineDash"), getLineDash: () => [],
          isPointInPath: () => false, isPointInStroke: () => false,
        };
        for (const m of ["setTransform", "resetTransform", "transform", "scale", "rotate",
          "translate", "save", "restore", "beginPath", "closePath", "moveTo", "lineTo",
          "bezierCurveTo", "quadraticCurveTo", "arc", "arcTo", "ellipse", "rect",
          "roundRect", "fill", "stroke", "clip", "clearRect", "fillRect", "strokeRect",
          "fillText", "strokeText", "drawImage"]) ctx[m] = noop(m);
        return ctx;
      };
      // jsdom has no fetch at all.  The demo replaces it for /api/*, but the
      // language pack is a real file request and has to reach the server,
      // and Node's fetch will not take the relative URL the desk uses.
      win.Response = Response;
      win.Headers = Headers;
      win.fetch = (input, init) => {
        const u = typeof input === "string" ? input : input.url;
        return fetch(new URL(u, pageUrl).href, init);
      };
      // The desk greets you with a video. There is no point waiting out the
      // welcome clip in a headless check of the panels behind it.
      win.HTMLMediaElement.prototype.play = function () { return Promise.reject(new Error("no media")); };
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);

  await sleep(3000);

  check("demo mode switched itself on", window.AURION_DEMO === true);
  check("the demo banner is on the page", Boolean($("demo-banner")),
    $("demo-banner") ? $("demo-banner").textContent.trim().slice(0, 60) : "missing");

  // The gate: a visitor with no key has to be able to get in.
  const gate = $("auth");
  check("the key gate rendered", gate && !gate.classList.contains("hidden"));

  const free = window.document.querySelector("#gate-free, [data-act='gate-free'], #auth .gate-free");
  const freeBtn = free || Array.from(window.document.querySelectorAll("#auth button"))
    .find((b) => /free|رایگان|مجاني/i.test(b.textContent));
  check("the free-entry button is offered", Boolean(freeBtn),
    freeBtn ? freeBtn.textContent.trim().slice(0, 48) : "not found");

  if (freeBtn) {
    freeBtn.click();
    await sleep(2500);
  }

  check("the gate closed and the desk opened",
    gate && gate.classList.contains("hidden"));

  // The desk keeps its state in module-scope consts, so what it actually
  // rendered is the only thing worth asserting on.
  const txt = () => window.document.body.textContent.replace(/\s+/g, " ");

  check("the interface is translated, not showing label keys",
    !/nav\.command|keygate\.title/.test(txt()),
    (txt().match(/\b\w+\.\w+\b/g) || []).slice(0, 3).join(" ") || "no raw keys");

  check("the account panel has a balance", /25,000/.test(txt()),
    (txt().match(/[\d,]+\.?\d* USD/g) || []).slice(0, 3).join(", "));

  check("the account is the sample broker account", /AxiaSoft-Demo/.test(txt()));

  const rows = window.document.querySelectorAll("tbody tr");
  check("the book shows open positions",
    /EURUSD/.test(txt()) && /XAUUSD/.test(txt()) && /US500/.test(txt()),
    `${rows.length} table rows`);

  check("the AI panel is populated", /63%/.test(txt()));

  check("the desk believes a chart feed is attached",
    /EURUSD/.test(txt()) && /M15/.test(txt()));

  const engine = $("st-engine");
  check("the engine chip reads live", engine && engine.getAttribute("data-state") === "live",
    engine ? `data-state=${engine.getAttribute("data-state")}` : "no chip");

  // The chart. The whole reason the demo claims attached chart agents is so
  // a visitor has something to pan, zoom and draw on.
  const navCharts = window.document.querySelector("[data-view='markets'], [data-nav='markets']")
    || Array.from(window.document.querySelectorAll("nav a, nav button, [data-view]"))
      .find((el) => /markets|بازار/i.test(el.textContent || ""));
  check("the markets view is reachable", Boolean(navCharts),
    navCharts ? (navCharts.textContent || "").trim().slice(0, 24) : "no nav entry");

  if (navCharts) {
    navCharts.click();
    await sleep(2000);
  }

  const cv = $("cv");
  check("the chart canvas mounted", Boolean(cv));

  // The recording context makes the drawing itself assertable. A candle is a
  // stroked path per bar, so the stroke count is the honest measure of
  // "something was plotted"; fillText carries the axes.
  const drawn = () => (cv && cv.__calls) || [];
  const strokes = () => drawn().filter((c) => c[0] === "stroke").length;
  const labels = () => drawn().filter((c) => c[0] === "fillText").map((c) => String(c[1]));

  check("the chart plotted the bars", strokes() > 100, `${strokes()} stroked paths`);
  check("the chart printed a price axis",
    labels().filter((t) => /^\d+\.\d{3,}$/.test(t)).length >= 3,
    labels().filter((t) => /^\d+\.\d{3,}$/.test(t)).slice(0, 4).join("  "));

  const chartTxt = () => (cv && cv.parentElement ? cv.parentElement.textContent : "");
  check("the chart is not showing its empty state",
    !/waiting|empty|منتظر/i.test(chartTxt()), chartTxt().trim().slice(0, 48) || "(canvas only)");

  // Interaction: the desk binds these to the canvas, and a chart that throws
  // on the first wheel event is worse than no chart.
  let threw = "";
  const before = strokes();
  try {
    const ev = (type, init) => cv.dispatchEvent(new window.MouseEvent(type, Object.assign({ bubbles: true, clientX: 300, clientY: 200 }, init)));
    cv.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -120, clientX: 300, clientY: 200 }));
    ev("pointerdown"); ev("pointermove", { clientX: 220 }); ev("pointerup", { clientX: 220 });
    ev("mousedown"); ev("mousemove", { clientX: 180 }); ev("mouseup", { clientX: 180 });
    cv.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 240, clientX: 300, clientY: 200 }));
  } catch (e) { threw = String(e && e.message); }
  check("zooming and dragging the chart does not throw", !threw, threw);

  await sleep(400);
  check("interacting repaints the chart", strokes() > before,
    `${before} -> ${strokes()} stroked paths`);

  // The transport, checked directly: the desk draws these but a canvas tells
  // a headless test nothing.
  const bars = await window.fetch("/api/candles?symbol=EURUSD&timeframe=M15&count=800")
    .then((r) => r.json());
  check("candles are served", bars.ok && bars.data.length === 800, `${bars.data.length} bars`);
  const b = bars.data[bars.data.length - 1];
  check("candles are well formed",
    b && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.time,
    b ? `${b.time} o=${b.open} h=${b.high} l=${b.low} c=${b.close}` : "none");

  const again = await window.fetch("/api/candles?symbol=EURUSD&timeframe=M15&count=800")
    .then((r) => r.json());
  check("candles are deterministic across calls",
    JSON.stringify(again.data[10]) === JSON.stringify(bars.data[10]));

  // Honesty: writes must be refused, not faked.
  const order = await window.fetch("/api/order", {
    method: "POST", body: JSON.stringify({ symbol: "EURUSD", volume: 0.1 }),
  }).then((r) => r.json());
  check("placing an order is refused", order && order.ok === false && order.error === "demo",
    JSON.stringify(order).slice(0, 70));

  const activate = await window.fetch("/api/license/activate", {
    method: "POST", body: JSON.stringify({ key: "AXI-TEST" }),
  }).then((r) => r.json());
  check("activating a key is refused", activate && activate.ok === false,
    JSON.stringify(activate).slice(0, 70));

  const i18n = await window.fetch("/api/i18n/en");
  check("the language pack falls through to the published file", i18n.status === 404,
    `http ${i18n.status}`);

  dom.window.close();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
