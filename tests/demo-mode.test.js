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

// GitHub Pages serves a project site from a subpath, not the host root, and
// that is the one thing about the deployment a root-served test cannot catch:
// every relative URL in the desk and every /api/* the demo router has to
// recognise is resolved against it.
const PREFIX = "/AURION";

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let url = req.url.split("?")[0];
      if (!url.startsWith(PREFIX + "/")) { res.writeHead(404).end("outside the published prefix"); return; }
      url = url.slice(PREFIX.length);
      const rel = decodeURIComponent(url).replace(/^\/+/, "");
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
  const pageUrl = `${base}${PREFIX}/apps/web/index.html?demo=1`;
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

  // The captured responses must actually be in play. When they silently fail
  // to load, the router's catch-all answers {ok:true,data:[]} for everything
  // and the desk still looks plausible because the rest is synthesised -- so
  // this asserts on a panel that can only come from the capture.
  const news = await window.fetch("/api/news").then((r) => r.json());
  check("the captured fixtures are being served",
    news.ok && news.data && Number(news.data.count) > 0 && Array.isArray(news.data.events),
    `/api/news -> ${news.data && news.data.count} events from ${news.data && news.data.source}`);

  const mark = $("demo-banner");
  check("the demo says it is a demo", Boolean(mark),
    mark ? mark.textContent.trim().slice(0, 60) : "missing");

  // It used to be a bar pinned across the bottom of the window, over the
  // positions dock and the foot of the chart. A notice about the page is
  // not allowed to cover the page.
  check("the notice sits in the header, not across the bottom",
    Boolean(mark && mark.closest("header.top")),
    mark ? (mark.parentElement ? mark.parentElement.className || mark.parentElement.tagName : "orphan") : "missing");

  const demoSrc = fs.readFileSync(path.join(ROOT, "apps/web/js/demo.js"), "utf8");
  check("nothing pins the notice to the bottom edge",
    !/#demo-banner\{[^}]*bottom:\s*0/.test(demoSrc) && !/\.demo-mark\{[^}]*position:fixed/.test(demoSrc));

  check("the short label survives when there is no room for the sentence",
    /@media \(max-width:1100px\)\{\.demo-mark span\{display:none\}\}/.test(demoSrc)
    && /el\.title = text/.test(demoSrc),
    "sentence moves to the title");

  // Measured at 390px: the header's action row is already wider than the
  // screen, so a chip dropped in there pushes the kill switch off the edge.
  check("the notice is not in the row that holds the kill switch",
    Boolean(mark && !mark.closest(".top-actions")),
    mark && mark.parentElement ? mark.parentElement.id || mark.parentElement.className : "missing");

  check("below 900px it leaves the header instead of crowding it",
    /\(max-width:900px\)/.test(demoSrc) && /classList\.add\("loose"\)/.test(demoSrc)
    && /\.demo-mark\.loose\{position:fixed;top:calc\(var\(--top/.test(demoSrc),
    "moves to a pill under the header");

  // The engine publishes a card for every strategy file that will not load.
  // The demo has to carry the same shape or it stops being a rehearsal.
  const snap = await window.fetch("/api/snapshot").then((r) => r.json()).catch(() => null);
  check("the snapshot carries the strategy fault list the desk reads",
    Boolean(snap && snap.data && snap.data.strategy && Array.isArray(snap.data.strategy.faults)),
    snap && snap.data && snap.data.strategy
      ? `faults=${JSON.stringify((snap.data.strategy || {}).faults)}` : "no snapshot");

  // No gate. A visitor who cannot obtain a key must not be asked for one,
  // so the demo reports a paid licence and the desk opens on its own.
  const gate = $("auth");
  check("the visitor is never asked for a key",
    gate && gate.classList.contains("hidden"),
    gate ? `#auth hidden=${gate.classList.contains("hidden")}` : "no gate element");

  check("the desk opened without any interaction",
    window.document.documentElement.classList.contains("mode-desk"));

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

  /* The AI reading used to be asserted here, on the Command centre,
     because a "live outlook" slider sat at the top of it. That slider
     is gone - it printed one bias with a confidence percentage and no
     symbol beside it, which on a desk with four charts attached was
     ambiguous in a direction a visitor could act on. The per-chart
     version in Intelligence says which symbol it means, so that is
     where the demo has to prove the AI produced something. */
  const navIntel = Array.from(window.document.querySelectorAll("nav a, nav button, [data-view]"))
    .find((el) => /intelligence|هوش/i.test(el.textContent || ""));
  check("the intelligence view is reachable", Boolean(navIntel),
    navIntel ? (navIntel.textContent || "").trim().slice(0, 24) : "no nav entry");
  if (navIntel) { navIntel.click(); await sleep(800); }
  check("the AI panel is populated", /\d+%/.test(txt()),
    (txt().match(/\d+%/g) || []).slice(0, 3).join(" "));

  // Premium. Everything the licence gates must be open, or the demo is a
  // tour of padlocks.
  const chip = $("nav-acc");
  check("the account chip reads premium, not freemium",
    chip && chip.classList.contains("prem") && !/free/i.test(chip.textContent),
    chip ? `"${chip.textContent.trim()}"` : "no chip");

  const lic = await window.fetch("/api/license").then((r) => r.json());
  const feats = Object.entries(lic.data.features || {});
  // The literal count used to be 8. "strategy_upload" was retired with
  // custom strategies, so pinning a number here just records how many
  // features happened to exist on the day it was written. What this
  // check is for is that the demo unlocks everything there is.
  check("every licensed feature is unlocked",
    feats.length >= 7 && feats.every(([, on]) => on === true) && (lic.data.locked || []).length === 0,
    `${feats.length} features: ${feats.filter(([, on]) => !on).map(([k]) => k).join(", ") || "all on"}`);



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
  /* As many decimals as this instrument needs, and the same number on
     every label.
     
     This check has now been written three ways, which is the whole
     history of the rule. It first required three or more, when the
     chart printed the broker's own precision and widened to five
     under 1.00. It was then inverted to insist on exactly two, after
     the desk asked for hundredths everywhere. That was reported as
     wrong for the narrow instruments - and the demo chart is EURUSD
     at about 1.048, the exact case: at two decimals every label on
     that axis read 1.05 and the scale said nothing at all.
     
     So: between two and four, never five, and all the same. The
     consistency is the part worth pinning - one count per chart, not
     one per number, or 99.995 appears above 100.00 on the same axis
     and the extra digit looks like extra precision. */
  /* The recorder keeps every call since the canvas was created, which
     includes the first draw - before any bars had arrived, when the
     chart had no prices to judge and fell back to two. Wipe it and
     redraw, so what is measured is one frame of the finished chart
     rather than its whole history. */
  if (cv && cv.__calls) {
    cv.__calls.length = 0;
    /* A wheel event is the shortest route to a repaint from outside
       the desk - the chart binds it and draws. The zoom in and back
       out again leaves the view where it was. */
    cv.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: -120, clientX: 300, clientY: 200 }));
    cv.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, deltaY: 120, clientX: 300, clientY: 200 }));
    await sleep(400);
  }

  const priceish = () => labels().filter((t) => /^-?\d+\.\d+$/.test(t));
  check("the chart printed a price axis",
    priceish().length >= 3,
    priceish().slice(0, 4).join("  "));
  const dps = () => [...new Set(priceish().map((t) => t.split(".")[1].length))];
  check("every price on the chart carries the same number of decimals",
    dps().length === 1, "counts seen: " + dps().join(", "));
  check("that number is between two and four",
    dps().length === 1 && dps()[0] >= 2 && dps()[0] <= 4,
    priceish().slice(0, 4).join("  "));
  check("a sub-ten pair is not collapsed to hundredths",
    /* The reported fault, stated as a test: this axis is EURUSD. */
    dps()[0] >= 4 || !priceish().every((t) => /^-?[0-9]\./.test(t)),
    priceish().slice(0, 4).join("  "));

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

  // Walk the views that a freemium machine locks, and prove none of them
  // render the upgrade padlock. Last, because it navigates away.
  const visited = [];
  for (const view of ["strategies", "prop", "settings", "upgrade"]) {
    const el = window.document.querySelector(`[data-view='${view}']`);
    if (!el) continue;
    visited.push(view);
    el.click();
    await sleep(900);
  }
  const padlocks = window.document.querySelectorAll(".locked-feature");
  check("no premium feature renders an upgrade padlock", padlocks.length === 0,
    `${padlocks.length} padlocks across ${visited.join(", ") || "no views"}`);

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
