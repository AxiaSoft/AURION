/**
 * Spacing between controls, and the header in particular.
 *
 * Reported as "the header buttons are too far apart, and the spacing pushes
 * the emergency button off the screen on mobile".
 *
 * The cause was a rule this project added itself: every .btn following
 * another .btn was given margin-inline-start, with a hand-written list of
 * containers where it was cancelled again because their own gap already did
 * the job. The list was short; the number of gapped containers was not.
 *
 * The arithmetic in the header:
 *
 *     8 controls  ->  7 gaps
 *     before:  7 x 8px                    =  56px
 *     after:   7 x (8px gap + 10px margin) = 126px
 *     touch:   7 x (8px gap + 12px margin) = 140px   (--ctl-gap grows)
 *
 * 84 extra pixels on a phone, which is what pushed #btn-kill out of frame.
 *
 * So these checks do not grep for a selector - the previous test did that
 * and passed throughout. They re-derive the set of row-direction flex/grid
 * containers that declare their own gap, and assert that nothing gives
 * their children a competing horizontal margin.
 */
const fs = require("node:fs");

const raw = fs.readFileSync("apps/web/css/app.css", "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const html = fs.readFileSync("apps/web/index.html", "utf8");
const app = fs.readFileSync("apps/web/js/app.js", "utf8");

let fails = 0;
const ok = (c, m, d) => { if (!c) { fails++; console.log("FAIL " + m + (d ? "  — " + d : "")); } else console.log("ok   " + m + (d ? "  — " + d : "")); };

const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  rules.push({ sels: m[1].split(",").map((s) => s.trim()), body: m[2].replace(/\s/g, "") });
}

/** Single-class containers that lay children out in a row and bring a gap. */
const gappedRows = new Set();
for (const r of rules) {
  if (!/(^|;)gap:/.test(r.body)) continue;
  if (!/display:(flex|grid|inline-flex)/.test(r.body)) continue;
  for (const sel of r.sels) {
    const m = /^\.([\w-]+)$/.exec(sel);
    if (!m) continue;
    // a column never stacks horizontally, so an inline margin cannot double it
    const isColumn = rules.some((x) => x.sels.includes(sel) && /flex-direction:column/.test(x.body));
    if (!isColumn) gappedRows.add(m[1]);
  }
}
ok(gappedRows.size > 20, "the stylesheet really is built out of gapped rows",
  `${gappedRows.size} such containers`);
ok(gappedRows.has("top-actions"), "the header's button row is one of them");

/* ---- nothing may give a control a competing horizontal margin ---- */
const offenders = [];
for (const r of rules) {
  const m = /(^|;)margin-inline-start:([^;]+)/.exec(r.body);
  if (!m || m[2] === "0") continue;
  for (const sel of r.sels) {
    if (/\+\s*\.?(btn|icon-btn|switch)\b/.test(sel) || /^\.(btn|icon-btn|switch)\s*\+/.test(sel)) {
      offenders.push(`${sel} -> ${m[2]}`);
    }
  }
}
ok(offenders.length === 0,
  "no blanket margin between adjacent controls — the container owns the spacing",
  offenders.join("; ") || "none");

/* ---- and the one container that genuinely had no gap now has one ---- */
const modal = rules.find((r) => r.sels.includes(".modal-actions"));
ok(Boolean(modal), "the confirm dialog's buttons have a rule of their own");
ok(modal && /display:flex/.test(modal.body) && /(^|;)gap:/.test(modal.body),
  "it spaces them with a gap, the same as every other row of controls",
  modal ? modal.body.slice(0, 60) : "missing");

/* The dialog is the case the blanket rule existed for. If its buttons were
   left bare they would touch, which is the fault that started all this. */
const dlg = app.slice(app.indexOf('class="modal-actions"'), app.indexOf('class="modal-actions"') + 400);
ok((dlg.match(/class="btn/g) || []).length >= 2,
  "it does hold two buttons side by side", `${(dlg.match(/class="btn/g) || []).length} buttons`);

/* ---- the header fits ---- */
const head = html.slice(html.indexOf('class="top-actions"'));
const controls = (head.slice(0, head.indexOf("</header>") + 1).match(/<button/g) || []).length;
ok(controls >= 6, "the header carries the controls this is about", `${controls} buttons`);

const ctlGap = /--ctl-gap:\s*([\d.]+)px/.exec(css);
const actions = rules.find((r) => r.sels.includes(".top-actions"));
const hdrGap = actions && /(^|;)gap:([\d.]+)px/.exec(actions.body);
ok(Boolean(ctlGap && hdrGap), "both numbers are readable from the stylesheet");
if (ctlGap && hdrGap) {
  const gaps = controls - 1;
  const now = gaps * Number(hdrGap[2]);
  const before = gaps * (Number(hdrGap[2]) + Number(ctlGap[1]));
  ok(now < before,
    "the header spends less width on air than it did with the blanket rule",
    `${now}px now vs ${before}px before, across ${gaps} gaps`);
}

/* ---- the emergency button must survive a narrow screen ---- */
ok(/#btn-kill/.test(css), "the emergency button is styled explicitly");

/* Find the narrow-screen rule by reading the breakpoints out of the file.
   The first version of this check assumed 760px; the header actually uses
   820px, so it failed on a stylesheet that was perfectly correct. Assuming
   a number that lives in the source is the same mistake as assuming the
   order of the stylesheets. */
const mqs = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\s*\)\s*\{/g)];
let narrowGap = null;
let narrowAt = null;
for (const m of mqs) {
  // take the block this query opens
  let depth = 0, end = m.index + m[0].length - 1;
  for (let i = end; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  const block = css.slice(m.index, end);
  const r = /\.top-actions\s*\{([^}]*)\}/.exec(block);
  if (!r) continue;
  const g = /(^|;)\s*gap:\s*([\d.]+)px/.exec(r[1]);
  if (g) { narrowGap = Number(g[2]); narrowAt = Number(m[1]); }
}
ok(narrowGap !== null,
  "the header tightens its spacing on a narrow screen",
  narrowGap === null ? "no narrow .top-actions gap found" : `gap:${narrowGap}px below ${narrowAt}px`);
ok(narrowGap !== null && hdrGap && narrowGap <= Number(hdrGap[2]),
  "and that spacing is no wider than the desktop one",
  narrowGap !== null && hdrGap ? `${narrowGap}px vs ${hdrGap[2]}px` : "");

/* Wrapping is the safety net: if the controls still do not fit, they move
   to a second line instead of overflowing the side of the screen - which
   is how the emergency button went missing.

   This check used to look for ANY media block containing a wrap rule for
   .top-actions, and it passed for months while the header was broken.
   Two such blocks existed; an UNCONDITIONAL `.top-actions{flex-wrap:
   nowrap}` was declared after both of them, same selector and same
   specificity, so it won at every width and neither block did anything.
   Then the bell was added, the unwrappable row ran past the edge, and
   #btn-kill - the highest `order` in the row, and the one control that
   must never be unreachable - was the part that left the screen.

   So the question is no longer "does a wrap rule exist" but "which
   declaration actually wins at this width". Resolve the cascade. */
function resolveProp(selector, prop, width) {
  let out = null;
  const re = /@media([^{]+)\{|([^{}]+)\{([^{}]*)\}|\}/g;
  let inMedia = null, m;
  while ((m = re.exec(css))) {
    if (m[1] !== undefined) {
      const q = m[1];
      const max = /max-width:\s*(\d+)px/.exec(q);
      const min = /min-width:\s*(\d+)px/.exec(q);
      let hit = !/prefers-|hover|print/.test(q);
      if (hit && max) hit = width <= Number(max[1]);
      if (hit && min) hit = width >= Number(min[1]);
      inMedia = { hit };
    } else if (m[2] !== undefined) {
      if (inMedia && !inMedia.hit) continue;
      if (!m[2].split(",").map((x) => x.trim()).includes(selector)) continue;
      const d = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(m[3]);
      if (d) out = d[1].trim();
    } else inMedia = null;
  }
  return out;
}

for (const w of [900, 560, 390, 360]) {
  ok(resolveProp(".top-actions", "flex-wrap", w) === "wrap",
    `at ${w}px the header row is allowed to wrap`,
    "resolved: " + resolveProp(".top-actions", "flex-wrap", w));
}
ok(resolveProp(".top-actions", "flex-wrap", 1440) === "nowrap",
  "and a desktop header still keeps its controls on one line",
  "the fix is for phones; it must not reflow the desk");

/* The kill switch specifically. It is last in the row by `order`, which
   is exactly the position that overflows first, so it carries its own
   guarantees rather than relying on the row's. */
ok(resolveProp(".top-actions #btn-kill", "flex", 390) === "0 0 auto",
  "the emergency button cannot be shrunk by a crowded row");
ok(/nowrap/.test(resolveProp(".top-actions #btn-kill", "white-space", 390) || ""),
  "nor squeezed into a wrapped sliver of itself");
ok(resolveProp(".top-actions #btn-flat", "margin-inline-start", 390) === "auto",
  "the two trading actions are pushed to the far end as a pair",
  "one logical auto margin, so it is the far end in Persian too");

/* Every control in the row is given an explicit order on a phone. Half
   of them used to sit on the default of 0 and therefore in DOM order,
   which is how the refresh key ended up after the language pill. */
{
  const ids = ["#btn-hdr-drawer", "#btn-bell", "#btn-refresh", "#btn-theme",
               "#btn-lang", "#btn-flat", "#btn-kill"];
  const orders = ids.map((id) => resolveProp(".top-actions " + id, "order", 390));
  ok(orders.every((o) => o !== null),
    "every control in the phone header has a declared position",
    ids.map((id, i) => id.slice(5) + ":" + orders[i]).join(" "));
  const nums = orders.map(Number);
  ok(nums.every((n, i) => i === 0 || n > nums[i - 1]),
    "and the positions are distinct and in the order the row reads",
    nums.join(" < "));
  ok(nums[nums.length - 1] === Math.max(...nums),
    "with the kill switch last, where it is reachable by the thumb");
}

/* The header is two rows on a phone, so the title is not competing with
   seven controls for one line. */
{
  const areas = (resolveProp(".top", "grid-template-areas", 390) || "").replace(/\s+/g, " ");
  ok(/"menu\s+title"/.test(areas) && /"actions actions"/.test(areas),
    "the phone header puts the title and the controls on separate rows",
    areas || "(none)");
}

console.log(fails ? `\nheader spacing: ${fails} FAILED` : "\nheader spacing: all checks passed");
process.exit(fails ? 1 : 0);
