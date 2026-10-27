/* Calendar redesign regression test.
 *
 *   node tests/calendar-layout.test.js
 *
 * The calendar was rebuilt for both shapes, and this suite exists to stop it
 * regressing back into the layout it came from. What was actually wrong, and
 * is asserted here as measured numbers rather than opinion:
 *
 *   - the old grid gave each of the seven columns a 30px CONTENT box on a
 *     390px phone (and 20px at 320px), while the cell still tried to carry a
 *     two-digit day, two companion dates (~30px), up to four 7px impact dots
 *     (~37px) and an absolutely positioned "Closed" text tag that landed on
 *     top of the day number;
 *   - `.cal-side` stayed `position:sticky` after the two-column layout had
 *     already collapsed, so the day panel pinned itself over the content;
 *   - the only way to read a day's detail was a hover tooltip, which a touch
 *     screen cannot produce;
 *   - clicking a day both filled the side panel AND pinned that same tooltip
 *     over the grid, putting one day's text on screen twice.
 *
 * Two halves: a cascade model over the real app.css for the layout maths, and
 * a jsdom boot of the real calendar.js for the behaviour.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require(require.resolve("jsdom"));

const ROOT = path.join(__dirname, "..", "apps", "web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/* A checker that does not strip comments will lie: a selector named inside a
   comment is not a rule, and this stylesheet documents every fix in prose
   directly above it. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (c, m, d) => {
  if (!c) { failed++; console.log(`FAIL  ${m}${d ? "  — " + d : ""}`); }
  else console.log(`ok    ${m}${d ? "  — " + d : ""}`);
};

/* ----------------------------------------------- a small cascade model */

function blocks(src, cond, out) {
  out = out || [];
  let i = 0;
  while (i < src.length) {
    const b = src.indexOf("{", i);
    if (b < 0) break;
    let d = 1;
    let j = b + 1;
    for (; j < src.length && d; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}") d--;
    }
    const head = src.slice(i, b).trim();
    const body = src.slice(b + 1, j - 1);
    if (head.startsWith("@media")) blocks(body, (cond ? cond + " and " : "") + head.replace("@media", "").trim(), out);
    else if (!head.startsWith("@")) out.push({ sel: head, body, cond: cond || "" });
    i = j;
  }
  return out;
}

function holds(cond, w) {
  if (!cond) return true;
  if (/pointer|hover|prefers|orientation|print/.test(cond)) return false;
  for (const m of cond.matchAll(/max-width:\s*(\d+)px/g)) if (!(w <= Number(m[1]))) return false;
  for (const m of cond.matchAll(/min-width:\s*(\d+)px/g)) if (!(w >= Number(m[1]))) return false;
  return true;
}

const spec = (sel) => [
  (sel.match(/#[\w-]+/g) || []).length,
  (sel.match(/\.[\w-]+|\[[^\]]+\]|:not\(/g) || []).length,
  (sel.match(/(^|[\s>])[a-z][\w-]*/gi) || []).length,
];
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

function simple(sel, el) {
  if (!el) return false;
  for (const m of sel.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
  for (const m of sel.matchAll(/\.([\w-]+)/g)) if (!el.classes.includes(m[1])) return false;
  for (const m of sel.matchAll(/\[([\w-]+)(?:[~|^$*]?=)?("?)([^\]"]*)\2\]/g)) {
    if (!el.attrs || !Object.prototype.hasOwnProperty.call(el.attrs, m[1])) return false;
    if (m[3] && el.attrs[m[1]] !== m[3]) return false;
  }
  const t = /^([a-z][\w-]*)/i.exec(sel);
  if (t && el.tag && el.tag !== t[1]) return false;
  // Pseudo-elements and pseudo-classes beyond :not are out of scope.
  if (/::/.test(sel)) return false;
  if (/:(?!not\()/.test(sel)) return false;
  return true;
}

function walk(toks, els) {
  let ti = toks.length - 1;
  let ei = els.length - 1;
  if (!simple(toks[ti].sel, els[ei])) return false;
  ti--; ei--;
  while (ti >= 0) {
    if (toks[ti + 1].child) {
      if (ei < 0 || !simple(toks[ti].sel, els[ei])) return false;
      ti--; ei--;
    } else {
      let found = false;
      while (ei >= 0) {
        if (simple(toks[ti].sel, els[ei])) { found = true; break; }
        ei--;
      }
      if (!found) return false;
      ti--; ei--;
    }
  }
  return true;
}

function matches(sel, pathEls) {
  const parts = sel.trim().split(/\s+(?![^(]*\))/).filter(Boolean);
  const toks = [];
  let child = false;
  for (const p of parts) {
    if (p === ">" || p === "+" || p === "~") { child = p === ">"; if (p !== ">") return false; continue; }
    toks.push({ sel: p, child });
    child = false;
  }
  return walk(toks, pathEls);
}

function resolve(rules, pathEls, prop, w) {
  let winner = null;
  const cmpRank = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  rules.forEach((r, idx) => {
    if (!holds(r.cond, w)) return;
    let best = null;
    for (const s of r.sel.split(",").map((x) => x.trim()).filter(Boolean)) {
      let m = false;
      try { m = matches(s, pathEls); } catch (e) { m = false; }
      if (m) { const sp = spec(s); if (!best || cmp(sp, best) > 0) best = sp; }
    }
    if (!best) return;
    const d = [...r.body.matchAll(new RegExp("(?:^|;)\\s*" + prop + "\\s*:([^;]+)", "g"))].pop();
    if (!d) return;
    const rank = [/!important/.test(d[1]) ? 1 : 0, ...best, idx];
    if (!winner || cmpRank(rank, winner.rank) >= 0) {
      winner = { val: d[1].replace("!important", "").trim(), rank };
    }
  });
  return winner;
}

const el = (tag, id, classes, attrs) => ({ tag, id, classes: classes || [], attrs: attrs || {} });
const px = (v) => (v ? Number(String(v.val).match(/(-?[\d.]+)px/)?.[1] ?? NaN) : NaN);

const css = strip(read("css/app.css"));
const rules = blocks(css);
const calJs = read("js/calendar.js");
const calJsNC = strip(calJs);
const appJsNC = strip(read("js/app.js"));

ok(rules.length > 300, `app.css parsed into rules (${rules.length})`);

/* ------------------------------------------------- 1. the layout maths */

/* Element paths through the new markup. */
const PANE = [el("div", "", ["cal"]), el("div", "", ["cal-main"]), el("section", "cal-pane", ["cal-pane", "card"])];
const CELL = [...PANE, el("div", "cal-grid", ["cal-grid"]), el("div", "", ["cal-body"]), el("button", "", ["cal-cell"])];
const BODY = [...PANE, el("div", "cal-grid", ["cal-grid"]), el("div", "", ["cal-body"])];
const ASIDE = [el("div", "", ["cal"]), el("div", "", ["cal-main"]), el("aside", "", ["cal-aside"])];
const SUBS = [...CELL, el("span", "", ["cal-subs"])];

/** Width of one of the seven columns at a given viewport. */
function cellWidth(vw) {
  const stage = 12 * 2; // .stage padding, unchanged by this work
  const pad = (px(resolve(rules, PANE, "padding", vw)) || 0) * 2;
  const gapV = resolve(rules, BODY, "gap", vw);
  const gap = (px(gapV) || 0) * 6;
  return (vw - stage - pad - gap) / 7;
}

for (const [vw, floor] of [[430, 50], [390, 44], [360, 40], [320, 34]]) {
  const w = cellWidth(vw);
  ok(w >= floor, `a ${vw}px phone gives each column at least ${floor}px`, `${w.toFixed(1)}px`);
}

/* The real fix is not the column width - that barely moved - but what the
   cell is asked to put inside it. The old cell had padding:6px 7px 18px,
   which ate 14px of a 44px column and left a 30px content box. */
const cellPad = resolve(rules, CELL, "padding", 390);
const padX = Number(String(cellPad.val).split(/\s+/)[1]?.match(/(-?[\d.]+)px/)?.[1] ?? NaN);
ok(padX <= 2, "the cell's side padding no longer eats the column", `${padX}px each side`);
const content390 = cellWidth(390) - padX * 2;
ok(content390 >= 42, "a 390px phone leaves a usable content box in the cell", `${content390.toFixed(1)}px (was 30.3px)`);
const content320 = cellWidth(320) - padX * 2;
ok(content320 >= 30, "even a 320px phone leaves a usable content box", `${content320.toFixed(1)}px (was 20.3px)`);

/* The cell is square and sized by its column, instead of a fixed 74px tall
   box that made a 44px-wide cell into a narrow ravine. */
ok(/\.cal-cell\{[^}]*aspect-ratio:\s*1/.test(css.replace(/\s*\n\s*/g, "")),
  "the cell is square, not a fixed-height box");
ok(!/min-height:\s*74px/.test(css), "the 74px fixed cell height is gone");

/* Companion dates are in the markup for desktop and hidden on a phone,
   rather than squeezed into a 30px box; the day panel carries them. */
ok(resolve(rules, SUBS, "display", 1280) === null ||
   resolve(rules, SUBS, "display", 1280).val !== "none",
  "companion dates are shown in the cell on desktop");
ok(resolve(rules, SUBS, "display", 390)?.val === "none",
  "companion dates are not squeezed into a phone cell");

/* Two panes on desktop, stacked below 1100px - and crucially the aside
   stops being sticky once it is a block underneath the grid. */
ok(/330px|320px/.test(resolve(rules, [el("div", "", ["cal"]), el("div", "", ["cal-main"])], "grid-template-columns", 1280).val),
  "desktop lays the pane and the aside side by side");
ok(resolve(rules, [el("div", "", ["cal"]), el("div", "", ["cal-main"])], "grid-template-columns", 900).val === "minmax(0,1fr)",
  "the two panes stack on a narrow screen");
ok(resolve(rules, ASIDE, "position", 1280)?.val === "sticky", "the aside follows the grid on desktop");
ok(resolve(rules, ASIDE, "position", 900)?.val === "static",
  "the aside stops being sticky once it is stacked below the grid");
ok(resolve(rules, ASIDE, "position", 390)?.val === "static", "...on a phone too");

/* The text tag that used to sit on top of the day number is gone from both
   the stylesheet and the markup. */
ok(!/cal-wk-tag/.test(css) && !/cal-wk-tag/.test(calJs),
  "the weekend text tag that overlapped the day number is gone");
ok(/\.cal-cell\.wk\{/.test(css.replace(/\s*\n\s*/g, "")), "weekends are marked with a tint instead");

ok(/if \(isWeekend\) cls\.push\("wk"\)/.test(strip(calJs)),
  "the cell is actually given the weekend class");

/* No absolutely positioned child inside the cell: that is how the tag got
   on top of the number in the first place. */
const cellBlock = /\.cal-cell\{([^}]*)\}/.exec(css);
ok(cellBlock && !/position:\s*absolute/.test(cellBlock[1]), "the cell itself is not a positioning trap");

/* ------------------------------------- 2. no dead selectors either way */

const emitted = new Set();
for (const m of calJsNC.matchAll(/class="([^"$]*)"/g)) {
  m[1].split(/\s+/).filter((c) => c.startsWith("cal-") || c === "dot" || c === "card").forEach((c) => emitted.add(c));
}
const missing = [...emitted].filter((c) => !new RegExp("\\." + c + "(?![\\w-])").test(css));
ok(missing.length === 0, "every class the calendar emits is styled", missing.join(", ") || "none");

const styled = new Set();
for (const m of css.matchAll(/\.(cal-[\w-]+)/g)) styled.add(m[1]);
const orphan = [...styled].filter((c) => !new RegExp(c + "(?![\\w-])").test(calJsNC) && !new RegExp(c + "(?![\\w-])").test(appJsNC));
ok(orphan.length === 0, "no calendar rule styles markup that no longer exists", orphan.join(", ") || "none");

/* ----------------------------------------------- 3. the pinning is gone */

ok(!/pinned/.test(calJsNC), "clicking a day no longer pins a floating copy of the day panel");
ok(!/pinned/.test(appJsNC), "...and the desk has no pinned state left to unwind");
ok(!/cal-tip-x/.test(css) && !/cal-tip-x/.test(calJs), "the tooltip's close button went with it");
ok(/pointer-events:\s*none/.test(/\.cal-tip\{([^}]*)\}/.exec(css)?.[1] || ""),
  "the hover peek never swallows a click");

/* ---------------------------------------------------- 4. the behaviour */

const NOW = new Date();
const dayOffset = (days, hhmm) => {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${hhmm}:00Z`;
};
const NEWS = {
  ok: true,
  data: {
    source: "config/news_calendar.template.csv",
    blackout_before: 15,
    blackout_after: 15,
    events: [
      { time: dayOffset(0, "12:30"), currency: "USD", impact: "high", title: "Non-Farm Payrolls" },
      { time: dayOffset(0, "14:00"), currency: "EUR", impact: "medium", title: "ECB Press Conference" },
      { time: dayOffset(0, "15:00"), currency: "GBP", impact: "low", title: "BoE Speech" },
      { time: dayOffset(0, "16:00"), currency: "JPY", impact: "holiday", title: "Bank Holiday" },
      { time: dayOffset(1, "01:00"), currency: "AUD", impact: "low", title: "RBA Rate Decision" },
    ],
  },
};
const SESSION = { ok: true, data: { state: "open", open: true, weekend: false } };

/** Boot calendar.js alone in a DOM that reports the given viewport. */
async function boot(viewport, hover) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on("jsdomError", (e) => errs.push(String(e.message || e)));
  vc.on("error", (...a) => errs.push(a.join(" ")));
  const dom = new JSDOM("<!doctype html><html lang='en'><body><div id='root'></div></body></html>",
    { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  /* Answer media queries against a real machine instead of a blanket
     `false`: the calendar asks about width AND pointer, and a stub that
     denies everything makes the desktop branch look like a phone. */
  win.matchMedia = (q) => {
    const query = String(q || "");
    let m = true;
    if (/hover:\s*hover/.test(query) || /pointer:\s*fine/.test(query)) m = hover;
    if (/hover:\s*none/.test(query) || /pointer:\s*coarse/.test(query)) m = !hover;
    for (const x of query.matchAll(/max-width:\s*(\d+)px/g)) if (viewport > +x[1]) m = false;
    for (const x of query.matchAll(/min-width:\s*(\d+)px/g)) if (viewport < +x[1]) m = false;
    return { matches: m, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
  const lang = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lang", "en.json"), "utf8"));
  win.fetch = async (u) => ({
    ok: true, status: 200,
    json: async () => (String(u).includes("/api/news") ? NEWS
      : String(u).includes("/api/market/session") ? SESSION
      : { ok: true, data: lang }),
  });
  // Minimal stand-ins for the two globals calendar.js reaches for.
  win.eval(`
    window.I18N = {
      lang: "en", dict: ${JSON.stringify(lang)},
      t(k, v) {
        const s = k.split(".").reduce((a, p) => (a == null ? a : a[p]), this.dict);
        if (s == null) return k;
        return String(s).replace(/\\{(\\w+)\\}/g, (_, n) => (v && v[n] != null ? v[n] : ""));
      },
    };
    window.API = { get: async (p) => (await (await fetch(p)).json()) };
    window.esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  `);
  win.eval(calJs + "\n;window.__CAL = Calendar;");
  const Cal = win.__CAL;
  Cal.mode = "";
  Cal.anchor = null;
  Cal.selected = "";
  await Cal.load();
  const root = win.document.getElementById("root");
  /* mount(), not view()+bind(): rerender() re-renders into Calendar.root,
     which only mount() sets, so a harness that painted by hand left the
     view switch repainting into nothing. */
  await Cal.mount(root);
  return { win, doc: win.document, Cal, root, errs };
}

(async () => {
  /* ---- desktop opens on the month grid ---- */
  const d = await boot(1280, true);
  ok(d.errs.length === 0, "the calendar boots clean on desktop", d.errs.join(" | ") || "no errors");
  ok(d.Cal.effectiveMode() === "month", "a desktop opens on the month grid");
  ok(d.doc.querySelectorAll(".cal-cell").length === 42, "42 day cells",
    String(d.doc.querySelectorAll(".cal-cell").length));
  ok(d.doc.querySelectorAll(".cal-cell .cal-sub").length === 84,
    "both companion calendars are in every cell",
    String(d.doc.querySelectorAll(".cal-cell .cal-sub").length));
  /* Four impact levels fall on one day; a cell that drew all four overflowed
     its 30px box, so it draws three and a "more" pip. */
  const busy = [...d.doc.querySelectorAll(".cal-cell")].find((c) => c.querySelectorAll(".dot").length);
  ok(busy && busy.querySelectorAll(".dot").length <= 3, "a cell never draws more than three dots",
    busy ? `${busy.querySelectorAll(".dot").length} dots` : "no busy cell");
  ok(busy && busy.querySelector(".cal-more"), "a fourth impact level is shown as an overflow pip");

  /* ---- a phone opens on the agenda ---- */
  const p = await boot(390, false);
  ok(p.errs.length === 0, "the calendar boots clean on a phone", p.errs.join(" | ") || "no errors");
  ok(p.Cal.effectiveMode() === "agenda", "a phone opens on the agenda, not a 7-column grid");
  const days = p.doc.querySelectorAll(".cal-ag-day");
  ok(days.length >= 2, "the agenda lists every day that has news", `${days.length} days`);
  const order = [...days].map((x) => x.dataset.day);
  ok(order.join() === [...order].sort().join(), "the agenda is in date order", order.join(" "));
  ok(p.doc.querySelectorAll(".cal-agenda .cal-ev").length === 5,
    "every event of the month is listed",
    String(p.doc.querySelectorAll(".cal-agenda .cal-ev").length));
  /* A touch device must never be given a card it cannot dismiss. */
  ok(!p.doc.getElementById("cal-tip"), "no hover tooltip is created on a touch device");

  /* Tapping an agenda day fills the same panel a grid cell would. */
  const target = days[days.length - 1];
  target.dispatchEvent(new p.win.MouseEvent("click", { bubbles: true }));
  ok(p.Cal.selected === target.dataset.day, "tapping an agenda day selects it", p.Cal.selected);
  const panel = p.doc.getElementById("cal-day").textContent;
  ok(panel.length > 20, "...and fills the day panel", `${panel.length} chars`);
  ok(target.classList.contains("sel"), "...and the tapped day is marked as selected");

  /* The detail the cell can no longer carry has to be in the panel. */
  const dl = p.doc.querySelectorAll("#cal-day .cal-dp-sys div").length;
  ok(dl === 2, "the day panel carries the two companion calendars the cell dropped", `${dl} shown`);

  /* ---- the mode switch ---- */
  const m = await boot(1280, true);
  m.doc.querySelector('#cal-mode button[data-mode="agenda"]').dispatchEvent(new m.win.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  ok(m.Cal.mode === "agenda", "the view switch changes mode", m.Cal.mode);
  ok(m.doc.querySelector(".cal-agenda") && !m.doc.querySelector(".cal-grid"),
    "...and repaints the pane as an agenda");
  ok(m.win.localStorage.getItem("aurion.cal.mode") === "agenda", "...and the choice is remembered");
  m.doc.querySelector('#cal-mode button[data-mode="month"]').dispatchEvent(new m.win.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  ok(m.doc.querySelector(".cal-grid") && !m.doc.querySelector(".cal-agenda"), "...and back again");

  /* ---- keyboard ---- */
  const k = await boot(1280, true);
  const cells = [...k.doc.querySelectorAll(".cal-cell")];
  cells[10].focus();
  cells[10].dispatchEvent(new k.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  ok(k.Cal.selected === cells[17].dataset.day, "ArrowDown moves a week forward", k.Cal.selected);
  k.doc.activeElement.dispatchEvent(new k.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  ok(k.Cal.selected === cells[18].dataset.day, "ArrowRight moves a day", k.Cal.selected);

  /* The cells are real buttons, so Enter and Space come for free - which is
     only true if they are actually buttons. */
  ok(cells[0].tagName === "BUTTON", "day cells are real buttons", cells[0].tagName);
  ok(cells[0].getAttribute("aria-label")?.length > 2, "...with a spoken label",
    cells[0].getAttribute("aria-label"));

  /* ---- the month still says what it used to say ---- */
  const status = k.doc.querySelector(".cal-status").textContent;
  ok(/\d/.test(status), "the status strip counts the month's events", status.trim().replace(/\s+/g, " "));
  ok(status.includes("active") || status.includes("configured"), "...and reports the news source", status.trim().replace(/\s+/g, " ").slice(0, 80));
  ok(k.doc.querySelectorAll(".cal-legend li").length === 4, "the impact legend still has all four levels");
  ok(/15/.test(k.doc.querySelector(".cal-fine").textContent), "the blackout note still states the window",
    k.doc.querySelector(".cal-fine").textContent.trim());

  /* A weekend day must still say so, in the one place with room for words. */
  const weekendCells = k.doc.querySelectorAll(".cal-cell.wk").length;
  ok(weekendCells >= 10, "weekends are marked across the whole grid", `${weekendCells} of 42`);
  const sat = [...k.doc.querySelectorAll(".cal-cell.wk")][0];
  ok(!!sat, "there is a weekend cell to open");
  sat.dispatchEvent(new k.win.MouseEvent("click", { bubbles: true }));
  ok(k.doc.querySelector("#cal-day .cal-dp-wk"), "a weekend day still carries the market-closed notice");

  /* No raw i18n keys anywhere in the rebuilt markup. */
  const raw = (k.root.innerHTML.match(/\bcalendar\.[a-z_]+\b/g) || []);
  ok(raw.length === 0, "no untranslated keys in the rebuilt calendar", [...new Set(raw)].join(", ") || "none");

  console.log(failed ? `\ncalendar-layout: ${failed} FAILED` : "\ncalendar-layout: all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  /* Without this an exception mid-suite printed no FAIL line at all, so a
     mutation that made a queried element vanish read as a clean run. */
  console.log("FAIL  the suite threw before it finished  — " + (e && e.stack ? e.stack : e));
  console.log("\ncalendar-layout: ABORTED");
  process.exit(1);
});
