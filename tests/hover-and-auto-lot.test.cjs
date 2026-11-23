/**
 * Two more from the same morning.
 *
 *   "In the backtest, when I hover the chart, the window showing the
 *    details lands inside that square which is the trade's range, and
 *    I cannot see the range. Make the details not come inside it."
 *
 *   "For auto lot, make the robot decide how much to stake from how
 *    strong its own signal is, between 0.01 and 1 lot - it only ever
 *    trades 0.1. That way there is money management too."
 *
 * The first is geometry: the panel was placed from the hovered marker,
 * and the marker is a corner of the rectangle the hover exists to
 * draw, so the text sat on the picture. The second is the desk's
 * description of what auto now means; the sizing itself is the
 * engine's, and is tested in engine/tests/test_auto_lot.py.
 *
 *     node tests/hover-and-auto-lot.test.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "apps", "web", "js", "app.js"), "utf8");
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

/* ================================= the panel stands clear of the box */

const place = new Function(grab(APP, "btPlaceTip") + "\nreturn btPlaceTip;")();

const HOST = { clientWidth: 620, clientHeight: 260 };
const TIP = { w: 170, h: 90 };

/** Where the panel ended up, in the chart's own coordinates. */
function put(px, py, avoid, host) {
  const el = { style: {}, hidden: true, offsetWidth: TIP.w, offsetHeight: TIP.h };
  place(el, host || HOST, px, py, avoid);
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  return { left, top, right: left + TIP.w, bottom: top + TIP.h, hidden: el.hidden };
}

const overlaps = (r, b) =>
  r.left < b.x1 && r.right > b.x0 && r.top < b.y1 && r.bottom > b.y0;

const inside = (r, host) =>
  r.left >= 0 && r.top >= 0 && r.right <= (host || HOST).clientWidth && r.bottom <= (host || HOST).clientHeight;

{
  /* A trade in the middle of the window: the band runs the full height
     of the chart between the two bars, with the price rectangle inside
     it. The marker the pointer is on is a corner of that. */
  const band = { x0: 240, x1: 330, y0: 8, y1: 252, boxed: true, yTop: 90, yBot: 170 };
  const r = put(240, 90, band);
  ok(!overlaps(r, band), "the details are placed clear of the trade's range, not on top of it");
  ok(inside(r), "and still inside the chart");

  /* Same trade, hovered from its exit corner. The panel should move to
     whichever side has room rather than always trying the same one. */
  const r2 = put(330, 170, band);
  ok(!overlaps(r2, band), "hovering the exit corner keeps it clear too");
  ok(inside(r2), "also inside the chart");
}

{
  // A trade hard against the left edge: only the right side has room.
  const band = { x0: 6, x1: 120, y0: 8, y1: 252, boxed: true, yTop: 40, yBot: 100 };
  const r = put(10, 40, band);
  ok(!overlaps(r, band) && inside(r), "a trade at the left edge is described on its right");
  ok(r.left >= band.x1, "...beside the band rather than over it");
}

{
  // And one against the right edge.
  const band = { x0: 500, x1: 614, y0: 8, y1: 252, boxed: true, yTop: 150, yBot: 210 };
  const r = put(610, 200, band);
  ok(!overlaps(r, band) && inside(r), "a trade at the right edge is described on its left");
  ok(r.right <= band.x0, "...beside the band rather than over it");
}

{
  /* A trade that ran across nearly the whole window. There is no room
     beside it, so the panel has to clear the price rectangle instead -
     that is the part carrying the two prices; the band behind it is a
     tint and reading through it costs nothing. */
  const wide = { x0: 10, x1: 610, y0: 8, y1: 252, boxed: true, yTop: 150, yBot: 220 };
  const r = put(300, 150, wide);
  ok(!overlaps(r, { x0: wide.x0, x1: wide.x1, y0: wide.yTop, y1: wide.yBot }),
    "a trade too wide to stand beside is still never covered where its prices are");
  ok(inside(r), "and the panel is not pushed off the chart to achieve it");
  ok(r.bottom <= wide.yTop, "it takes the side with more room - above, here");

  const low = { x0: 10, x1: 610, y0: 8, y1: 252, boxed: true, yTop: 30, yBot: 90 };
  const r2 = put(300, 60, low);
  ok(r2.top >= low.yBot && inside(r2), "and below when the rectangle sits high");
}

{
  // Nothing highlighted: the old placement, beside the point.
  const r = put(300, 120, null);
  ok(inside(r), "with no highlight the panel just stays in the frame");
  const tiny = put(300, 120, { x0: 0, x1: 620, y0: 0, y1: 260, boxed: false });
  ok(inside(tiny), "a highlight with nowhere to stand still leaves the panel on the chart");
}

{
  // The wiring: the box has to be recorded when it is drawn, and handed
  // to the placer when the panel is written.
  ok(/hoverBox\s*=\s*\{/.test(APP), "the highlight's rectangle is remembered as it is drawn");
  ok(/box:\s*hoverBox/.test(APP), "...and kept with the rest of the chart's geometry");
  ok(/btPlaceTip\(el, host, m\.x, m\.y, \(S\._btGeom \|\| \{\}\)\.box\)/.test(APP),
    "the trade panel is placed against it");
  ok(/btPlaceTip\(el, host, px, py\);/.test(APP),
    "the equity curve's own panel is unchanged - it has no box to avoid");
}

/* ========================================= what auto lot now promises */
{
  const en = PACKS.find(([c]) => c === "en")[1];
  const sub = en.strategies.lot_auto_sub;
  ok(!/preset volume/i.test(sub),
    "auto no longer claims to trade the strategy's preset volume");
  ok(/0\.01/.test(sub) && /1\.00/.test(sub), "it states the range the robot may choose inside");
  ok(/strong|signal/i.test(sub), "and that the signal is what moves the size");
  ok(/equity|balance/i.test(sub), "and that the account is what caps it");
  ok(!/0\.10,/.test(sub), "the old per-strategy figures are gone");

  /* Persian and Arabic write their own digits, here as everywhere else
     on the desk, so the numbers are compared after folding them back. */
  const latin = (t) => String(t).replace(/[\u0660-\u0669\u06f0-\u06f9]/g,
    (d) => String(d.charCodeAt(0) & 0xf));
  for (const [name, pack] of PACKS) {
    const text = latin(pack.strategies.lot_auto_sub);
    ok(/0\.01/.test(text) && /1\.00/.test(text),
      `${name} gives the trader the same two numbers`);
    ok(!/strategy's own|الاستراتيجية نفسها|خود استراتژی/.test(pack.bt.prov_lot_auto),
      `${name}'s backtest provenance no longer says "the strategy's own"`);
  }
}

console.log(fails ? `\n${fails} failed` : "\nall good");
process.exit(fails ? 1 : 0);
