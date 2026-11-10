/**
 * The chart's property panel, and what the desk looks like in Persian.
 *
 * Two reports, and they turned out to share a method: both were things
 * the source got right and the screen got wrong, so both are measured
 * against a rendered page rather than read out of a file.
 *
 * ---- the property panel -------------------------------------------
 *
 * "Redesign the chart tools and their settings." Opening Properties on
 * a trend line showed: a thickness slider with no track, just a dot
 * floating under its label; "Solid / Dashed / Dotted" printed on top
 * of each other; "Left" and "Right" rendered as "LefRight"; two
 * checkboxes with no visible control at all; and coordinates to five
 * decimal places beside an axis that prints two.
 *
 * One cause for the first four. chart.css declares `.tvp-row` twice,
 * 650 lines apart, for two unrelated things - a property row, which
 * wants `display:flex`, and a row of the positions table, which wants
 * `display:grid; grid-template-columns:subgrid`. Same specificity, so
 * the lower one won, and `subgrid` with no subgrid parent stacks every
 * child of the row. The panel has been broken in every language for as
 * long as both class sets have existed, which is the thing a source
 * review cannot see: each rule is correct, and neither knows about the
 * other.
 *
 * The property panel is now .tvo-*. Renaming it rather than the
 * positions table was the smaller change - the table reaches into
 * app.js and six suites - and renaming beats scoping, which would have
 * fixed this collision and left the next one to be found the same way.
 *
 * ---- right to left -------------------------------------------------
 *
 * "Improve RTL for fa/ar and LTR for en." The stylesheets were already
 * clean - four physical properties in 10 000 lines of CSS - so the
 * faults were in the two places a stylesheet cannot reach:
 *
 *   1. Canvas text. ctx.direction defaults to the element's own
 *      direction, so on a Persian desk the chart bidi-reordered its own
 *      labels: the time axis read "15 11-08" for 11-08 19:15 and the
 *      change read "0.52+" for +0.52. Correct behaviour, applied to
 *      text that is not in the page's language.
 *
 *   2. Latin runs in HTML with nothing isolating them - "x1.2" came out
 *      as "1.2x" - and copy that names a physical side: "Pick a tool
 *      from the left" printed beside a toolbar that is on the right.
 *
 *     node tests/chart-props-rtl.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  chart props / rtl (jsdom not installed)"); process.exit(0); }
const { JSDOM, VirtualConsole } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const CSSF = ["css/app.css", "css/skins.css", "css/chart.css", "css/themes.css"];
const CSS = CSSF.map((f) => fs.readFileSync(path.join(WEB, f), "utf8"));
const TOOLS = read("apps/web/js/chart-tools.js");
const CHARTS = read("apps/web/js/charts.js");
const APP = read("apps/web/js/app.js");
const PACKS = { en: JSON.parse(read("lang/en.json")), fa: JSON.parse(read("lang/fa.json")), ar: JSON.parse(read("lang/ar.json")) };

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("ok   " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL " + name + "\n       " + e.message);
  }
}
const must = (c, m) => { if (!c) throw new Error(m); };

/* ---- the cascade, resolved the way the browser resolves it ----------
   Same approach as number-fields.test.js: every one of these faults was
   a rule that existed and lost, which a grep reports as present. */

const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}

function boot(dir) {
  const html = `<!doctype html><html dir="${dir}" lang="${dir === "rtl" ? "fa" : "en"}"`
    + ` data-skin="aurora" data-theme="dark" data-glass="on" data-perf="rich"><head>`
    + CSS.map((c, i) => `<style data-src="${CSSF[i]}">${c}</style>`).join("")
    + `</head><body><div id="app"><div id="stage"></div></div></body></html>`;
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true,
    virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  const flat = []; let o = 0;
  for (const sh of doc.styleSheets) {
    const src = (sh.ownerNode && sh.ownerNode.getAttribute("data-src")) || "?";
    const walk = (L, mq) => {
      for (const r of L) {
        if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, (mq ? mq + " and " : "") + r.conditionText); continue; }
        if (!r.selectorText) continue;
        flat.push({ src, mq, sel: r.selectorText, style: r.style, order: o++ });
      }
    };
    try { walk(sh.cssRules, ""); } catch (e) { /* unparsed */ }
  }
  return { dom, doc, flat };
}

/** Every declaration of `prop` that reaches `el`, winner last. */
function stack(flat, el, prop, opts) {
  const o = opts || {};
  const out = [];
  for (const r of flat) {
    const v = r.style.getPropertyValue(prop);
    if (!v) continue;
    if (r.mq) {
      if (/prefers-reduced-motion|forced-colors|print/.test(r.mq)) continue;
      /* Touch sizing is a different device, not a different width. */
      if (!o.coarse && /pointer:\s*coarse|hover:\s*none/.test(r.mq)) continue;
      if (o.coarse && !/pointer:\s*coarse/.test(r.mq) && /pointer:/.test(r.mq)) continue;
      const mx = /max-width:\s*(\d+)px/.exec(r.mq), mn = /min-width:\s*(\d+)px/.exec(r.mq);
      const W = o.width || 1440;
      if (mx && W > Number(mx[1])) continue;
      if (mn && W < Number(mn[1])) continue;
      if (/@container|container/.test(r.mq) && !o.container) continue;
    }
    for (const raw of r.sel.split(",")) {
      const s = raw.trim();
      const st = (s.match(STATE) || []).join("");
      if (/hover|active|focus/.test(st)) continue;
      /* Skipped, not stripped. Stripping "::after" leaves a selector
         that matches the element itself, so the knob's 16px was read
         back as the switch's own width. */
      if (/::[-\w]/.test(s)) continue;
      const b = s.replace(STATE, "").trim() || "*";
      let m = false;
      try { m = el.matches(b); } catch (e) { continue; }
      if (!m) continue;
      out.push({ sp: spec(s), order: r.order, sel: s, src: r.src, v: v.trim() });
      break;
    }
  }
  out.sort((a, b) => (a.sp - b.sp) || (a.order - b.order));
  return out;
}
const winner = (flat, el, prop, opts) => {
  const s = stack(flat, el, prop, opts);
  return s.length ? s[s.length - 1] : null;
};

/** A property row, built the way renderProps builds one. */
function propRow(doc, inner, cls) {
  const host = doc.getElementById("stage");
  const row = doc.createElement("div");
  row.className = cls || "tvo-row";
  row.innerHTML = inner;
  host.appendChild(row);
  return row;
}

/* ================= 1. the collision, and that it is gone ============= */

check("the two things called tvp-row are not both called tvp-row", () => {
  const chart = CSS[2];
  const bodies = [...chart.matchAll(/(^|\})\s*([^{}@]*\.tvp-row[^{}]*)\{/g)].map((m) => m[2].trim());
  must(bodies.length, "the positions table lost its rows entirely");
  /* Whatever rules are left under .tvp-row must all be the positions
     table's. The property panel's are .tvo-. */
  const propLike = bodies.filter((b) => /tvo-/.test(b));
  must(!propLike.length, "a property rule is still answering to .tvp-row: " + propLike.join(" / "));
  must(/\.tvo-row\s*\{/.test(chart), "the property row has no rule at all");
});

check("a property row lays itself out, and the positions table does not reach it", () => {
  const { doc, flat } = boot("ltr");
  const row = propRow(doc, '<span>Thickness</span><input type="range" />');
  const d = winner(flat, row, "display");
  must(d && d.v === "flex", `a property row is display:${d && d.v} - the positions grid is winning again`);
  const tpl = winner(flat, row, "grid-template-columns");
  must(!tpl, "a property row inherited the positions table's subgrid: " + (tpl && tpl.sel));
  /* And the table still gets its own. */
  const pos = propRow(doc, "<span>x</span>", "tvp-row");
  const pd = winner(flat, pos, "display");
  must(pd && pd.v === "grid", `the positions row lost its grid (${pd && pd.v})`);
});

check("a slider has a track to slide along", () => {
  const chart = CSS[2];
  for (const pseudo of ["-webkit-slider-runnable-track", "-moz-range-track", "-webkit-slider-thumb", "-moz-range-thumb"]) {
    must(new RegExp("\\.tvo-row input\\[type=\"range\"\\]::" + pseudo).test(chart),
      "no ::" + pseudo + " rule, so the browser default shows through");
  }
  must(/appearance:\s*none/.test(chart.slice(chart.indexOf('.tvo-row input[type="range"]'), chart.indexOf('.tvo-row input[type="range"]') + 300)),
    "the native appearance was never turned off, so the custom track is ignored");
});

check("a slider says what it is set to", () => {
  must(/<output>/.test(TOOLS), "there is no readout element");
  must(/function range\(o\)/.test(TOOLS), "the slider rows are not built from one place");
  must(/function syncRange\(/.test(TOOLS), "nothing keeps the readout in step with the drag");
  /* Bound to the live input, not to a re-render: rebuilding the panel
     mid-drag destroys the element being dragged. */
  const i = TOOLS.indexOf("dock.oninput");
  const body = TOOLS.slice(i, i + 400);
  must(/if \(t\.type === "range"\) syncRange\(t\)/.test(body),
    "the readout is not updated on input");
  must(!/renderProps\(\)/.test(body.slice(0, 200)), "the panel is rebuilt mid-drag");
});

check("a segmented control can spell its own options", () => {
  const { doc, flat } = boot("ltr");
  const row = propRow(doc, '<span>Line style</span><span class="tvo-choice">'
    + "<button>Solid</button><button>Dashed</button><button>Dotted</button></span>");
  const choice = row.querySelector(".tvo-choice");
  const d = winner(flat, choice, "display");
  must(d && /flex/.test(d.v), `the options are ${d && d.v}, so they do not sit side by side`);
  const basis = winner(flat, choice, "flex");
  must(basis && !/0 1 auto/.test(basis.v), "the control is allowed to shrink to nothing: " + (basis && basis.v));
  must(/190px|200px|180px/.test(basis.v), "no basis wide enough to spell three options: " + basis.v);
  /* And the row may wrap, so a long label does not squeeze it. */
  const wrap = winner(flat, row, "flex-wrap");
  must(wrap && wrap.v === "wrap", "the row cannot wrap, so the control is squeezed instead");
});

check("a true/false property has a control you can see and hit", () => {
  const { doc, flat } = boot("ltr");
  const row = propRow(doc, '<span>Show the price</span><input type="checkbox" />');
  const box = row.querySelector("input");
  const w = winner(flat, box, "width"), h = winner(flat, box, "height");
  must(w && h, "the checkbox has no size of its own, so it is the browser's 13px square");
  must(parseFloat(w.v) >= 36 && parseFloat(h.v) >= 22, `${w.v} x ${h.v} is still a speck`);
  const app = winner(flat, box, "appearance") || winner(flat, box, "-webkit-appearance");
  must(app && app.v === "none", "the native checkbox is still being drawn under the switch");
});

check("the panel is reachable with a finger", () => {
  const { doc, flat } = boot("ltr");
  const row = propRow(doc, '<span>Line style</span><span class="tvo-choice"><button>Solid</button></span>');
  const min = winner(flat, row, "min-height", { coarse: true });
  must(min && parseFloat(min.v) >= 44, `a row is ${min && min.v} under a finger`);
  const btn = row.querySelector("button");
  const bh = winner(flat, btn, "height", { coarse: true });
  must(bh && parseFloat(bh.v) >= 32, `a segment is ${bh && bh.v} under a finger`);
});

check("coordinates are written to the chart's own precision", () => {
  must(/function priceDp\(/.test(TOOLS), "the panel has no idea what precision the chart uses");
  must(/CandleChart && global\.CandleChart\.PRICE_DP/.test(TOOLS),
    "the precision is restated here rather than read from the engine");
  must(!/toFixed\(5\)/.test(TOOLS), "something is still printing five decimals");
  must(/static PRICE_DP = 2;/.test(CHARTS), "the engine's own answer moved");
});

check("a drawing is not labelled with its own kind twice", () => {
  /* Run, not read. A version of this that only grepped for the helper
     passed against a body that returned the caption unconditionally -
     the function existed and did the wrong thing, which is the exact
     failure mode this whole file exists for. */
  const src = TOOLS;
  const i = src.indexOf("function kindCaption(");
  must(i > 0, "the caption is unconditional again");
  const end = src.indexOf("\n  }", i);
  const body = src.slice(i, end + 4);
  const fn = new Function("esc", "nameOf", "TOOL_BY_ID", "objectName",
    body + "; return kindCaption;")(
    (x) => String(x),
    () => "Trend line",
    {},
    (d) => d.name);
  must(fn({ kind: "trend", name: "Trend line" }) === "",
    "an unrenamed drawing still prints its kind under its own name");
  const renamed = fn({ kind: "trend", name: "Support" });
  must(/Trend line/.test(renamed), "a renamed drawing lost the caption that says what it is");
  must(/tvo-kind/.test(renamed), "the caption is not the caption element any more");
  return "silent when it would repeat";
});

/* ======================= 2. right to left ============================ */

check("the chart draws its own labels left to right", () => {
  /* A price, a timestamp, an indicator's short name: all Latin runs,
     all reordered by canvas text inheriting the page's direction. */
  const i = CHARTS.indexOf("paint() {");
  must(i > 0, "paint() is gone");
  const head = CHARTS.slice(i, i + 1800);
  must(/ctx\.direction = "ltr"/.test(head), "the chart context still takes the page's direction");
  const grid = head.indexOf("this.paintGrid(L)");
  must(head.indexOf('ctx.direction = "ltr"') < grid, "direction is set after the first text is drawn");
});

check("...and so does the replay chart", () => {
  const i = APP.indexOf("function drawReplayChart(");
  must(i > 0, "drawReplayChart is gone");
  const body = APP.slice(i, i + 2600);
  must(/g\.direction = "ltr"/.test(body), "the replay chart reorders its own axis under RTL");
  must(!/g\.fillText\(fmt\(/.test(APP.slice(i, i + 9000)),
    "the replay axis localises its digits while the chart beside it does not");
});

check("a machine-readable value is isolated from the sentence around it", () => {
  const { doc, flat } = boot("rtl");
  const host = doc.getElementById("stage");
  const b = doc.createElement("b");
  b.className = "mono";
  b.textContent = "\u00d71.2";
  host.appendChild(b);
  const dir = winner(flat, b, "direction");
  const bidi = winner(flat, b, "unicode-bidi");
  must(dir && dir.v === "ltr", `a .mono value runs ${dir && dir.v}, so x1.2 prints as 1.2x`);
  must(bidi && /isolate/.test(bidi.v), "it is not isolated, so it drags the Persian around it out of order");
});

check("a timestamp keeps its offset on the right end", () => {
  const { doc, flat } = boot("rtl");
  const term = doc.createElement("div");
  term.className = "term";
  term.innerHTML = '<span class="ts">2026-10-05T11:36:04+00:00</span>';
  doc.getElementById("stage").appendChild(term);
  const ts = term.querySelector(".ts");
  const dir = winner(flat, ts, "direction");
  must(dir && dir.v === "ltr", `the log timestamp runs ${dir && dir.v}`);
});

check("no copy names a side of the screen", () => {
  /* The toolbar is on the left in English and on the right in Persian,
     so a sentence that says "from the left" is wrong half the time.
     chart.left / chart.right are exempt: they are the two directions a
     drawing extends in chart space, which is never mirrored. */
  const exempt = new Set(["chart.left", "chart.right"]);
  const bad = [];
  const walk = (o, pre) => {
    for (const [k, v] of Object.entries(o)) {
      const key = pre ? pre + "." + k : k;
      if (v && typeof v === "object") { walk(v, key); continue; }
      if (typeof v !== "string" || exempt.has(key)) continue;
      if (/\bfrom the (left|right)\b|\b(left|right)-hand\b|\bon the (left|right)\b/i.test(v)) bad.push(key + ": " + v.slice(0, 60));
    }
  };
  walk(PACKS.en, "");
  must(!bad.length, bad.join(" | "));
  /* And the Persian one that started this: it said "the left bar" with
     the bar on the right. */
  must(!/\u0686\u067E/.test(PACKS.fa.chart.no_objects),
    "the Persian hint still sends the trader to the left: " + PACKS.fa.chart.no_objects);
});

check("the desk does not print English at a Persian reader", () => {
  /* Two buttons and an EA status word were written straight into the
     markup and never translated. Everything a reader sees goes through
     I18N. */
  /* Comments first: the note explaining this fix quotes the string it
     removed, and a bare grep cannot tell the two apart. */
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  must(!/Signals ON|Signals OFF/.test(code), "the signals toggle is hard-coded English");
  must(/signal\.toggle_on/.test(APP) && /signal\.toggle_off/.test(APP), "it does not go through the packs");
  must(/function agentState\(/.test(APP), "an EA's state is printed verbatim from the engine");
  for (const [name, pack] of Object.entries(PACKS)) {
    for (const k of ["toggle_on", "toggle_off"]) {
      must(typeof pack.signal[k] === "string" && pack.signal[k].trim(), name + " has no signal." + k);
    }
    for (const k of ["st_online", "st_offline", "st_idle"]) {
      must(typeof pack.charts[k] === "string" && pack.charts[k].trim(), name + " has no charts." + k);
    }
  }
  /* An unknown state is still shown - swallowing it would be worse. */
  const i = APP.indexOf("function agentState(");
  must(/I18N\.has\(key\)/.test(APP.slice(i, i + 420)), "an unknown state would render as a raw key");
  return "3 packs";
});

check("the slider and the switch mirror, rather than staying put", () => {
  const chart = CSS[2];
  must(/html\[dir="rtl"\] \.tvo-row input\[type="range"\]/.test(chart),
    "the slider keeps its left-to-right origin on a Persian desk");
  must(/html\[dir="rtl"\] \.tvo-row input\[type="checkbox"\]:checked::after/.test(chart),
    "the switch knob travels the wrong way in RTL");
  must(/translate: -16px 0/.test(chart), "...and there is no mirrored travel to replace it");
});

check("nothing in the property panel is positioned by a physical side", () => {
  const chart = CSS[2];
  const from = chart.indexOf(".tvo-head");
  const to = chart.indexOf("@media (pointer: coarse)", from);
  must(from > 0 && to > from, "the property block moved");
  const block = chart.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, "");
  const bad = block.match(/(?:margin|padding|border|inset)-(?:left|right)\s*:|(?:^|[;{])\s*(?:left|right)\s*:/gm);
  must(!bad, "physical sides in a panel that mirrors: " + [...new Set(bad || [])].join(" "));
  return "logical only";
});

/* ------------------------------------------------------------------ */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log("\nchart-props-rtl: " + (failed ? failed + " FAILED of " : "") + passed + " of " + results.length + " checks passed");
process.exit(failed ? 1 : 0);
