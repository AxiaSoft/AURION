/**
 * The settings menu panel: can you read it, and can you tell where you are?
 *
 * "Redesign the desktop settings menu panel properly." Four faults, and
 * every one of them is a colour or a size that the stylesheet states
 * plainly and that only a measurement catches.
 *
 *   1. The name of the section you are in was invisible. skins.css
 *      lists "anything FILLED with the accent" and gives it
 *      --accent-ink, and `.set-jump button[data-jump].on` was in that
 *      list - but the rail's current entry is a 16% accent TINT over a
 *      near-black rail, not a fill. So the one word the rail exists to
 *      tell you rendered at rgb(6,16,20) on rgb(10,12,19): present,
 *      selectable, and invisible, in every skin, since the rule was
 *      written.
 *
 *   2. Hovering that same entry flipped it to a solid accent fill. The
 *      only item on the desk that repaints itself when you point at
 *      what you have already chosen, including on the way past it to
 *      something else.
 *
 *   3. The line under each name - the only thing that says what a
 *      section decides - was 11px in --faint, which measures 3.52:1 on
 *      the dark rail and 3.54:1 on the light one. Under 4.5:1 in both,
 *      in every theme, because both themes define --faint at about the
 *      same lightness. Only the active entry was legible, which is
 *      backwards: the section you are looking at is the one whose
 *      description you need least.
 *
 *   4. The group headings were 10.5px, under the desk's own 11px floor,
 *      and carried the whole structure of the list on their own.
 *
 * Contrast is computed here rather than asserted as a hex value,
 * because the tokens are redefined by ten themes and a check written
 * against one of them says nothing about the other nine.
 *
 *     node tests/settings-rail.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }
if (!jsdom) { console.log("SKIP  settings rail (jsdom not installed)"); process.exit(0); }
const { JSDOM, VirtualConsole } = jsdom;

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const CSSF = ["css/app.css", "css/skins.css", "css/chart.css", "css/themes.css"];
const CSS = CSSF.map((f) => fs.readFileSync(path.join(WEB, f), "utf8"));
const APP = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  \u2014 " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}
const must = (c, m) => { if (!c) throw new Error(m); };

/* ---- colour ---------------------------------------------------------- */

function rgb(v) {
  const s = String(v || "").trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  m = /rgba?\(([^)]+)\)/i.exec(s);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) return parts.slice(0, 3);
  }
  m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(s);           // the "8 10 16" triples
  if (m) return [1, 2, 3].map((i) => Number(m[i]));
  return null;
}
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** `fg` over `bg` at alpha `a`, which is what a tint actually is. */
const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));

/**
 * Every theme's ink tokens, read out of themes.css rather than listed
 * here. A check written against one theme says nothing about the nine
 * others, and the rail is painted in all of them.
 */
function themes() {
  const out = [];
  const src = CSS[3];
  /* The themes are keyed on data-skin, with a data-theme="light"
     variant beside each - not on data-theme alone. Any block that
     defines all of ink/muted/faint/s2 is one of them. */
  const re = /(html\[data-skin[^{]*|:root[^{]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[2];
    const pick = (name) => {
      const g = new RegExp("--" + name + "\\s*:\\s*([^;}]+)").exec(body);
      return g ? g[1].trim() : null;
    };
    const ink = pick("ink"), muted = pick("muted"), faint = pick("faint");
    const s2 = pick("s2"), s4 = pick("s4");
    if (!ink || !muted || !faint || !s2) continue;
    out.push({ sel: m[1].trim().slice(0, 48), ink: rgb(ink), muted: rgb(muted), faint: rgb(faint),
               s2: rgb(s2), s4: rgb(s4 || s2) });
  }
  return out.filter((t) => t.ink && t.muted && t.faint && t.s2);
}

/** The surface the rail paints, per app.css: s4 at .92 over s2 at .88. */
const railBg = (t) => over(t.s4 || t.s2, t.s2, 0.92);

/* ---- the cascade ----------------------------------------------------- */

const STATE = /:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel) {
  const s = sel.replace(/\*/g, " ");
  const id = (s.match(/#[-\w]+/g) || []).length;
  const cl = (s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g) || []).length;
  const el = (s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g) || []).length;
  return id * 10000 + cl * 100 + el;
}

function boot(dir, theme) {
  const html = `<!doctype html><html dir="${dir}" lang="${dir === "rtl" ? "fa" : "en"}"`
    + ` data-skin="aurora" data-theme="${theme || "dark"}" data-glass="on" data-perf="rich"><head>`
    + CSS.map((c, i) => `<style data-src="${CSSF[i]}">${c}</style>`).join("")
    + `</head><body><div id="app"><div class="set-desk set-rail stx">`
    + `<nav class="set-jump" id="set-jump"><div class="sj-list">`
    + `<div class="sj-grp">Trading</div>`
    + `<button data-jump="set-robot" class="on"><span class="sj-ic"></span>`
    + `<span class="sj-txt"><b>Robot</b><small>mode, risk, symbols</small></span></button>`
    + `<button data-jump="set-prop"><span class="sj-ic"></span>`
    + `<span class="sj-txt"><b>Prop risk</b><small>prop rules, drawdown</small></span></button>`
    + `<div class="sj-grp">Personal</div>`
    + `<button data-jump="set-personal"><span class="sj-ic"></span>`
    + `<span class="sj-txt"><b>Personalization</b><small>theme &amp; look</small></span></button>`
    + `</div></nav><div class="set-main"></div></div></div></body></html>`;
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
  return { doc, flat };
}

/** Winning declaration of `prop` on `el`, optionally in a state. */
function winner(flat, el, prop, state) {
  const c = [];
  for (const r of flat) {
    const v = r.style.getPropertyValue(prop);
    if (!v) continue;
    if (r.mq) {
      if (/prefers-reduced-motion|forced-colors|print|pointer:\s*coarse/.test(r.mq)) continue;
      const mx = /max-width:\s*(\d+)px/.exec(r.mq);
      const mn = /min-width:\s*(\d+)px/.exec(r.mq);
      if (mx && 1440 > Number(mx[1])) continue;
      if (mn && 1440 < Number(mn[1])) continue;
    }
    for (const raw of r.sel.split(",")) {
      const s = raw.trim();
      if (/::[-\w]/.test(s) && !(state && state.pseudo)) continue;
      const st = (s.match(STATE) || []).join("");
      if (st && !(state && state.on && st.includes(state.on))) continue;
      const b = s.replace(STATE, "").replace(/::[-\w]+(\([^)]*\))?/g, "").trim() || "*";
      let m = false;
      try { m = el.matches(b); } catch (e) { continue; }
      if (!m) continue;
      c.push({ sp: spec(s) + (st ? 10 : 0), order: r.order, sel: s, src: r.src, v: v.trim() });
      break;
    }
  }
  if (!c.length) return null;
  c.sort((a, b) => (a.sp - b.sp) || (a.order - b.order));
  return c[c.length - 1];
}

/* ===================================================================== */

check("the section you are in is not painted in its own background", () => {
  /* The fault, stated as the thing a reader would notice: the active
     entry's name came out near-black on a near-black rail. It is
     written as "which token wins" because that is what it was. */
  const { doc, flat } = boot("ltr", "dark");
  const b = doc.querySelector("[data-jump].on .sj-txt b");
  const w = winner(flat, b, "color") || winner(flat, b.closest("[data-jump]"), "color");
  must(w, "nothing colours the current entry at all");
  must(!/accent-ink/.test(w.v),
    "the current entry still takes the foreground meant for a solid accent fill "
    + `(${w.src} \u2192 ${w.sel} \u2192 ${w.v})`);
});

check("...and it clears 4.5:1 in every theme the desk ships", () => {
  const all = themes();
  must(all.length >= 6, "only found " + all.length + " themes - the parser missed some");
  const bad = [];
  for (const t of all) {
    /* The active row is the rail's own surface with a 16% accent tint
       over it; the darkest case for the text is the untinted rail. */
    const r = contrast(t.ink, railBg(t));
    if (r < 4.5) bad.push(`${t.sel} ${r.toFixed(2)}`);
  }
  must(!bad.length, "the current entry's name is unreadable in: " + bad.join(", "));
  return all.length + " themes, worst "
    + Math.min(...all.map((t) => contrast(t.ink, railBg(t)))).toFixed(2) + ":1";
});

check("pointing at the entry you are already on does not repaint it", () => {
  const skins = CSS[1];
  const i = skins.indexOf(".set-jump button[data-jump].on:hover");
  must(i > 0, "the hover state is gone entirely");
  const body = skins.slice(i, skins.indexOf("}", i));
  must(!/background:\s*var\(--accent\)\s*;/.test(body),
    "hover still fills the current entry with solid accent: " + body.replace(/\s+/g, " "));
  must(!/color:\s*var\(--accent-ink\)/.test(body), "...and still inks it for that fill");
  must(/var\(--ink\)/.test(body), "the hovered current entry has no legible foreground");
});

check("the line that says what a section decides is readable", () => {
  const { doc, flat } = boot("ltr", "dark");
  const small = doc.querySelector("[data-jump]:not(.on) .sj-txt small");
  const col = winner(flat, small, "color");
  must(col, "the description has no colour of its own");
  must(!/--faint/.test(col.v), "the description is still --faint, which is about 3.5:1 on this rail");
  const size = winner(flat, small, "font-size");
  must(size && parseFloat(size.v) >= 11, `the description is ${size && size.v}, under the 11px floor`);

  /* And the token it moved to has to hold up across the themes. */
  const bad = themes().filter((t) => contrast(t.muted, railBg(t)) < 4.5)
    .map((t) => `${t.sel} ${contrast(t.muted, railBg(t)).toFixed(2)}`);
  must(!bad.length, "--muted is not enough in: " + bad.join(", "));
  return "worst " + Math.min(...themes().map((t) => contrast(t.muted, railBg(t)))).toFixed(2) + ":1";
});

check("...for every entry, not only the one you are on", () => {
  /* The active row used to be the single legible description in the
     list, which is the wrong way round. */
  const { doc, flat } = boot("ltr", "dark");
  const on = winner(flat, doc.querySelector("[data-jump].on .sj-txt small"), "color");
  const off = winner(flat, doc.querySelector("[data-jump]:not(.on) .sj-txt small"), "color");
  must(on && off, "one of the two states has no colour");
  must(!/--faint/.test(off.v), "the inactive descriptions are the faint ones again");
});

check("the group headings are above the desk's own text floor", () => {
  const { doc, flat } = boot("ltr", "dark");
  const grp = doc.querySelector(".sj-grp");
  const size = winner(flat, grp, "font-size");
  must(size && parseFloat(size.v) >= 11, `a group heading is ${size && size.v}`);
  const col = winner(flat, grp, "color");
  must(col && !/--faint/.test(col.v), "a group heading is still --faint");
});

check("the groups are separated by something other than a faint word", () => {
  const app = CSS[0];
  must(/\.sj-list > \.sj-grp:not\(:first-child\)/.test(app),
    "no rule separates one group from the next");
  const i = app.indexOf(".sj-list > .sj-grp:not(:first-child)");
  const body = app.slice(i, app.indexOf("}", i));
  must(/border-block-start/.test(body), "the separator is not a rule above the heading");
  must(!/border-top|border-left|border-right/.test(body), "a physical side in a panel that mirrors");
});

check("the current entry is marked by shape, not only by tint", () => {
  const app = CSS[0];
  must(/\.set-jump button\[data-jump\]\.on::before/.test(app),
    "there is no marker on the current entry");
  const i = app.indexOf(".set-jump button[data-jump].on::before");
  const body = app.slice(i, app.indexOf("}", i));
  must(/inset-inline-start/.test(body), "the marker is placed by a physical side");
  must(!/\b(left|right)\s*:/.test(body), "the marker is placed by a physical side");
  must(/html\[dir="rtl"\] \.set-jump button\[data-jump\]\.on::before/.test(app),
    "the marker's own corners do not mirror");
});

check("the entry is still a target a finger can hit", () => {
  const { doc, flat } = boot("ltr", "dark");
  const btn = doc.querySelector("[data-jump]");
  const pad = winner(flat, btn, "padding");
  must(pad, "the entry lost its padding");
  /* Two lines of text plus padding; the rendered height was measured
     at 53px in a browser. The check is that the padding did not shrink
     while the type grew. */
  must(parseFloat(pad.v) >= 8, "the entry's padding is " + pad.v);
});

check("a keyboard can see where it is", () => {
  const app = CSS[0];
  must(/\.set-jump button\[data-jump\]:focus-visible/.test(app),
    "the rail has no focus ring, so tabbing through it is invisible");
});

check("the AI card does not print its own title twice", () => {
  /* "Require AI agreement" as the card heading and again as the
     switch's label, four lines apart, in two type sizes. */
  const i = APP.indexOf('switchRow({ id: "st-ai"');
  must(i > 0, "the AI switch is gone");
  const card = APP.slice(APP.lastIndexOf('<div class="card">', i), i);
  must(!/strategies\.ai_gate"/.test(card),
    "the card heading repeats the switch's own label: " + card.replace(/\s+/g, " ").slice(-160));
  must(/strategies\.ai_gate_help/.test(card), "the card lost the line that explains the setting");
});

/* ------------------------------------------------------------------ */

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
console.log("\nsettings-rail: " + (failed ? failed + " FAILED of " : "") + passed + " of " + results.length + " checks passed");
process.exit(failed ? 1 : 0);
