/**
 * Four reports, one morning.
 *
 *   1. "Stop on a backtest answers bad response and does not stop it."
 *   2. "The text inside that button is in English only."
 *   3. "In the EA chart list the charts vanish when I change page."
 *   4. "The backtest equity curve does not show the losses - it counts
 *      the drops as profit."
 *
 * The first two turned out to be one thing seen twice. A desk server
 * that was started before an update serves the NEW page out of the
 * folder on disk while routing with the OLD table in memory, and
 * answers /api/i18n/<lang> out of a pack it parsed at boot. So the
 * page had a Stop button the server had never heard of - express ends
 * an unmatched request with an HTML page, which the desk's fetch can
 * only report as "bad_response" - and the Persian label the update
 * shipped was not in the pack the server was still handing out, so the
 * button fell back to English. Neither was a fault in the feature.
 *
 * The other two are the chart list fetching 240 bars per card, one
 * card at a time, from nothing, on every mount; and the equity curve
 * taking a single colour for the whole run from where it happened to
 * end.
 *
 *     node tests/desk-recovery-and-curve.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "backend", "src", "index.js"), "utf8");
const ENGINE = fs.readFileSync(path.join(ROOT, "engine", "aurion", "backtest", "engine.py"), "utf8");
const PACKS = ["en", "fa", "ar"].map((c) => [c, JSON.parse(fs.readFileSync(path.join(ROOT, "lang", c + ".json"), "utf8"))]);

let fails = 0;
const ok = (c, m) => { if (!c) { fails += 1; console.log("FAIL " + m); } else console.log("ok   " + m); };

function grab(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  const j = src.indexOf("{", i);
  let d = 0;
  for (let k = j; k < src.length; k += 1) {
    if (src[k] === "{") d += 1;
    else if (src[k] === "}") { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error("unterminated " + name);
}

/* ============================================ 1. the language pack ==
 *
 * The server's cache is keyed on the file, not on the process. Run
 * for real against the real pack: a copy is taken, the file is
 * changed, and it is put back whatever happens. */
{
  const file = path.join(ROOT, "lang", "en.json");
  const original = fs.readFileSync(file, "utf8");
  const restore = () => { try { fs.writeFileSync(file, original); } catch { /* */ } };
  process.on("exit", restore);
  try {
    const { pack } = require(path.join(ROOT, "backend", "src", "i18n.js"));
    const before = pack("en").bt.cancel;
    ok(typeof before === "string" && before.length > 0, "the pack reads at all");

    const edited = JSON.parse(original);
    edited.bt.cancel = "A STRING AN UPDATE SHIPPED";
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + "\n");
    ok(pack("en").bt.cancel === "A STRING AN UPDATE SHIPPED",
      "a pack replaced under a running server is picked up, not held from boot");

    restore();
    ok(pack("en").bt.cancel === before, "and putting the file back puts the pack back");
  } finally {
    restore();
  }
  ok(fs.readFileSync(file, "utf8") === original, "the real pack is exactly as it was");
}

/* ====================================== 2. an endpoint nobody claims */
{
  /* Lifted and run: the handler is an arrow, so there is no function
     to grab by name. What matters is the body it writes. */
  const at = INDEX.indexOf('app.use("/api", (req, res) => {');
  ok(at > 0, "unmatched /api requests are answered by the desk, not by express's HTML page");
  ok(at > INDEX.indexOf('app.use("/api", guarded)'),
    "...and only after the real routes have had their turn");
  const body = INDEX.slice(INDEX.indexOf("{", at), INDEX.indexOf("\n});", at) + 2);
  const handler = new Function("buildId", "req", "res", body.slice(1, body.lastIndexOf("}")));
  let sent = null;
  const res = { status(c) { this.code = c; return this; }, json(o) { sent = o; } };
  handler({ diskBuildId: () => "deadbeef" }, { method: "POST", path: "/backtest/cancel" }, res);
  ok(res.code === 404, "it is a 404");
  ok(sent && sent.ok === false, "a refusal");
  ok(sent && sent.code === "unknown_endpoint",
    "carrying a code the desk can translate instead of a page it cannot read");
  ok(sent && String(sent.endpoint).includes("/api/backtest/cancel"),
    "and naming what was asked for");
  ok(sent && sent.build === "deadbeef", "with the build that is on disk, which is the one to restart into");

  /* A thrown build id must not turn a 404 into a 500. */
  sent = null;
  handler({ diskBuildId() { throw new Error("no"); } }, { method: "GET", path: "/x" }, res);
  ok(sent && sent.code === "unknown_endpoint", "an unreadable build id still leaves an answer");

  for (const [name, pack] of PACKS) {
    ok(Boolean(pack.engerr && pack.engerr.unknown_endpoint), `${name} explains it to the trader`);
  }
  for (const [name, pack] of PACKS) {
    if (name === "en") continue;
    ok(!/[A-Za-z]{5,}/.test(String(pack.engerr.unknown_endpoint).replace(/AURION/g, "")),
      `${name} says it in ${name}`);
  }
  ok(/guarded\.post\("\/backtest\/cancel"/.test(INDEX),
    "the Stop route itself is still there to be reached");
}

/* ================================ 3. the small charts on the EA cards */
{
  const made = [];
  const stub = `
    const S = __S;
    const document = { querySelectorAll: () => __nodes };
    const API = { get: __get };
    const CandleChart = function (cv) {
      this.cv = cv; __made.push(this);
      this.setBars = (b) => { cv.painted = (cv.painted || 0) + 1; cv.bars = b; };
      this.setTick = () => {};
    };
    const syncChartPrecision = () => {};
    /* The grid also raises and clears the "waiting for candles" veil;
       that is DOM work and has its own suite. */
    const paintChartVeils = () => {};
    const clearVeil = () => {};
  `;
  const mk = (sym, tf) => ({
    getAttribute: (k) => (k === "data-mini" ? sym : tf),
    isConnected: true, painted: 0, bars: null,
  });
  const nodes = [mk("EURUSD", "M15"), mk("XAUUSD", "H1")];
  const asked = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const get = async (url) => {
    asked.push(url);
    await gate;
    return { ok: true, data: [{ time: "t1", close: 1 }, { time: "t2", close: 2 }] };
  };
  const S = { _mini: { "EURUSD|M15": [{ time: "t0", close: 1 }] }, snap: {} };
  const api = new Function("__S", "__nodes", "__get", "__made",
    stub + grab(APP, "paintMiniChart") + "\n" + grab(APP, "paintMiniCharts")
    + "\nconst MINI_BARS = 240;"
    + "\nreturn { paintMiniCharts, S };")(S, nodes, get, made);

  const done = api.paintMiniCharts();
  ok(nodes[0].painted === 1,
    "a card whose bars the desk already holds is drawn at once, not after a request");
  ok(nodes[0].bars[0].time === "t0", "and drawn from those very bars");
  ok(nodes[1].painted === 0, "a card with nothing held stays empty rather than showing another symbol's bars");
  ok(asked.length === 2,
    `every card's request goes out together, not one after the other (${asked.length} in flight)`);
  release();
  return done.then(() => {
    ok(nodes[0].painted === 2 && nodes[1].painted === 1, "then every card is repainted with what arrived");
    ok(S._mini["XAUUSD|H1"] && S._mini["XAUUSD|H1"].length === 2,
      "and what arrived is kept, so the next visit draws immediately");
    ok(made.length === 2, "one chart per canvas, reused rather than rebuilt on every paint");
    rest();
  });
}

function rest() {
/* ============ 4. the colour says which side of the line; the numbers
 *                 say which way it is going ============================
 *
 * This reverses an earlier decision, on the trader's own instruction.
 *
 * The first attempt painted the line green above the starting equity
 * and red below, and was refused: "I did not ask for half the curve
 * green and half red." So it became one colour for the whole run,
 * taken from where it finished. That has now been refused in turn,
 * and precisely:
 *
 *   "even when the curve is above the line - in profit - there are
 *    falls, and those falls have to count as losses; I see it
 *    reporting a profit. The same must hold below the line. The
 *    colour of the curve must not follow the profit or loss figure -
 *    it should change only where it is above or below the line. The
 *    profit and loss NUMBERS should be shown accurately, in their own
 *    colours, according to whether the curve is rising or falling."
 *
 * Two separate questions, two separate answers, and the previous
 * design gave the same answer to both:
 *
 *   the LINE's colour  - which side of the starting line is this?
 *   the NUMBERS' colour - which way is it going right here?
 */
{
  const calls = [];
  const rec = (name) => (...a) => calls.push({ name, a });
  const ctx = {
    calls,
    setTransform: rec("setTransform"), clearRect: rec("clearRect"),
    beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"),
    closePath: rec("closePath"), arc: rec("arc"), setLineDash: rec("setLineDash"),
    save: rec("save"), restore: rec("restore"), rect: rec("rect"), clip: rec("clip"),
    stroke() { calls.push({ name: "stroke", style: ctx.strokeStyle }); },
    fill() { calls.push({ name: "fill", style: ctx.fillStyle }); },
    createLinearGradient() {
      const stops = [];
      calls.push({ name: "gradient", stops });
      return { addColorStop: (o, c) => stops.push(c) };
    },
  };
  const cv = {
    dataset: {}, style: {}, width: 0, height: 0,
    parentElement: { clientWidth: 600, clientHeight: 240, kids: [], querySelector: () => null, appendChild() {} },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 240 }),
    addEventListener() {},
  };
  const UP = "#11ff11";
  const DOWN = "#ff1111";
  const stub = `
    const S = { _btCurve: null, _btCurveAt: null };
    const $ = () => __cv;
    const window = { devicePixelRatio: 1 };
    const getComputedStyle = () => ({ getPropertyValue: (n) => (n === "--ok" ? "${UP}" : n === "--bad" ? "${DOWN}" : "#333333") });
    const btBindCurve = () => {};
    const btPaintCurveTip = () => {};
    const document = { documentElement: {} };
  `;
  const draw = new Function("__cv", stub + grab(APP, "drawEquityCurve") + "\nreturn { drawEquityCurve, S };")(cv);
  const strokes = () => [...new Set(calls.filter((c) => c.name === "stroke").map((c) => c.style))]
    .filter((c) => c === UP || c === DOWN);
  const shades = () => calls.filter((c) => c.name === "gradient").flatMap((g) => g.stops)
    .map((c) => String(c).slice(0, 7));

  /* A run that ends ahead but spends its middle well behind. Under
     the old rule the whole thing, underwater months included, was
     drawn in the colour of profit. */
  const curve = [];
  for (let i = 0; i < 60; i += 1) curve.push(10000);
  for (let i = 0; i < 60; i += 1) curve.push(9400);        // genuinely below
  for (let i = 0; i < 60; i += 1) curve.push(10600);       // and back above
  draw.drawEquityCurve(curve);

  ok(strokes().length === 2,
    "a run that went below the line and came back is drawn in one colour: " + strokes().join(" "));
  ok(shades().includes(UP) && shades().includes(DOWN),
    "the fill under it does not change at the line either");
  ok(calls.some((c) => c.name === "clip"),
    "nothing is clipped, so the colour cannot change exactly at the crossing");

  /* ...and the colour does NOT follow the final figure. The two runs
     below end at the same place and spend their time on opposite
     sides of the line; each must be drawn as what it did. */
  calls.length = 0;
  draw.drawEquityCurve([10000, 10400, 10800, 10600, 10900]);
  ok(strokes().length === 1 && strokes()[0] === UP,
    "a run that never went below the line is drawn green throughout");

  calls.length = 0;
  draw.drawEquityCurve([10000, 9800, 9600, 9000, 8800]);
  ok(strokes().length === 1 && strokes()[0] === DOWN,
    "and one that never came back above it is drawn red throughout");

  /* The numbers, which are the other half of the instruction.
   *
   * At the bottom of a dip the trader is pointing at a fall. It is
   * simultaneously true that the run is ahead of where it started -
   * both facts belong on screen, each with its own colour. */
  const tipStub = `
    const S = __S;
    const I18N = { t: (k) => k };
    const fmt = (v, dp) => Number(v).toFixed(dp === undefined ? 2 : dp);
    const clsPnl = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
    const btTip = () => __el;
    const btPlaceTip = (el, host, px, py) => { __el.at = { px, py }; };
  `;
  const el = { hidden: true, innerHTML: "", style: {} };
  const tipS = { _btCurve: null, _btCurveAt: null };
  const tip = new Function("__S", "__el",
    tipStub + grab(APP, "btPaintCurveTip") + "\nreturn { btPaintCurveTip, S };")(tipS, el);

  /* A run that climbs to 11000 and then slides to 10600: still 600
     ahead of its start, and 400 down from its peak. "I see it
     reporting a profit" was about exactly this point. */
  const dip = [10000, 10400, 11000, 10800, 10600];
  tipS._btCurve = { curve: dip, w: 600, h: 240, padL: 8, padR: 8, padT: 10, padB: 10, lo: 9900, hi: 11100, base: 10000 };
  tipS._btCurveAt = 4;
  tip.btPaintCurveTip({ parentElement: {} });
  const rows = el.innerHTML.split("<span>").slice(1);
  const row = (key) => rows.find((r) => r.startsWith("bt." + key)) || "";
  ok(/-200\.00/.test(row("tip_move")) && /mono down/.test(row("tip_move")),
    "a step DOWN above the line is reported as the loss it is: " + row("tip_move"));
  ok(/-400\.00/.test(row("tip_frompeak")) && /mono down/.test(row("tip_frompeak")),
    "the fall from the run's own peak is missing or not marked as a loss");
  ok(/\+600\.00/.test(row("tip_pnl")) && /mono up/.test(row("tip_pnl")),
    "...while the distance from the start is still the gain it is");
  ok(/10600\.00/.test(el.innerHTML), "beside the equity the run actually had there");

  /* The mirror case, which the instruction asked for by name: below
     the line, a RISE is a gain. */
  const under = [10000, 9400, 9000, 9200];
  tipS._btCurve = { curve: under, w: 600, h: 240, padL: 8, padR: 8, padT: 10, padB: 10, lo: 8900, hi: 10100, base: 10000 };
  tipS._btCurveAt = 3;
  tip.btPaintCurveTip({ parentElement: {} });
  const rows2 = el.innerHTML.split("<span>").slice(1);
  const row2 = (key) => rows2.find((r) => r.startsWith("bt." + key)) || "";
  ok(/\+200\.00/.test(row2("tip_move")) && /mono up/.test(row2("tip_move")),
    "a rise below the line is reported as a gain, not swallowed by the overall loss");
  ok(/-800\.00/.test(row2("tip_pnl")) && /mono down/.test(row2("tip_pnl")),
    "...while the run is still, correctly, behind where it started");

  /* The first point has no step into it. A fabricated 0 would read as
     "flat here" rather than "nothing has happened yet". */
  tipS._btCurveAt = 0;
  tip.btPaintCurveTip({ parentElement: {} });
  const rows3 = el.innerHTML.split("<span>").slice(1);
  ok(/—/.test(rows3.find((r) => r.startsWith("bt.tip_move")) || ""),
    "the very first point invents a move it never made");
}

/* ========================= 5. the drop has to survive being thinned */
{
  /* The desk cannot colour a dip it was never sent. _thin took every
     Nth point, so a drawdown that opened and closed between two
     samples was not drawn small - it was not in the data at all. */
  const fn = ENGINE.slice(ENGINE.indexOf("def _thin("), ENGINE.indexOf("class Backtester"));
  ok(/min\(chunk\)/.test(fn) && /max\(chunk\)/.test(fn),
    "thinning keeps the lowest and the highest point of every stretch");
  ok(/chunk\.index\(lo\) <= chunk\.index\(hi\)/.test(fn),
    "...in the order they actually happened");
  ok(/out\[0\] = values\[0\]/.test(fn) && /out\[-1\] = values\[-1\]/.test(fn),
    "and the two ends are the run's own first and last equity");
  ok(!/stepf/.test(fn), "the every-Nth sampler is gone");
}

console.log(fails ? `\n${fails} failed` : "\nall good");
process.exit(fails ? 1 : 0);
}
