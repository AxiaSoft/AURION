/**
 * Every chart control is wired to something that actually contains it.
 *
 * The tools FAB on mobile did nothing when tapped. The cause was not CSS
 * and not the touch layer: the button is built by railHtml() into
 * .tv-body, but its click handler was registered on .tv-top. A delegated
 * handler only ever sees clicks inside its own element, so the FAB - and
 * the two scrims, built the same way - were unreachable. Nothing threw,
 * nothing logged; the button was simply inert.
 *
 * A test asserting "the FAB exists" would have passed throughout. So
 * this walks the real markup into a tree, finds every `X.onclick`
 * handler and the element X resolves to, and checks that each id the
 * handler tests with closest() is genuinely a descendant of it.
 *
 *     node tests/chart-wiring.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcPath = path.join(root, "apps/web/js/chart-tools.js");
const src = fs.readFileSync(srcPath, "utf8");
const css = fs.readFileSync(path.join(root, "apps/web/css/chart.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FAIL " + m); } else console.log("ok   " + m); };

/* ------------------------------------------------- compose the markup */

/** The body of a `function name(...) { ... }`, braces balanced. */
function fnBody(name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("no function " + name);
  let d = 0;
  const j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (!d) return src.slice(j + 1, k); }
  }
  throw new Error("unterminated " + name);
}

// html() composes the shell from topHtml() and railHtml(). Inline them so
// the tree under test is the one the browser is actually given.
let markup = fnBody("html");
markup = markup.replace(/\$\{topHtml\(o\)\}/g, () => fnBody("topHtml"))
  .replace(/\$\{railHtml\(\)\}/g, () => fnBody("railHtml"));

// Interpolations can hide tags (a group's buttons come from a .map), so
// pull the template literals out of the inlined helpers too, then drop
// what is left of the ${...} expressions.
markup = markup.replace(/\$\{[^{}]*\}/g, " ");
for (let pass = 0; pass < 4; pass++) markup = markup.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, " ");

/* ------------------------------------------------------ parse to a tree */

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "path", "use", "source"]);

function parse(html) {
  const docRoot = { tag: "#root", id: null, cls: [], kids: [], parent: null };
  let cur = docRoot;
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing) {
      // Tolerate the odd unmatched tag inside a stripped template.
      let up = cur;
      while (up && up.tag !== tag) up = up.parent;
      if (up && up.parent) cur = up.parent;
      continue;
    }
    const id = /\bid="([^"]+)"/.exec(attrs);
    const cl = /\bclass="([^"]+)"/.exec(attrs);
    const node = {
      tag,
      id: id ? id[1] : null,
      cls: cl ? cl[1].split(/\s+/).filter(Boolean) : [],
      kids: [],
      parent: cur,
    };
    cur.kids.push(node);
    if (!VOID.has(tag) && !selfClose) cur = node;
  }
  return docRoot;
}

const tree = parse(markup);

function walk(node, fn) { fn(node); node.kids.forEach((k) => walk(k, fn)); }

const byId = new Map();
const byClass = new Map();
walk(tree, (n) => {
  if (n.id && !byId.has(n.id)) byId.set(n.id, n);
  n.cls.forEach((c) => { if (!byClass.has(c)) byClass.set(c, n); });
});

function contains(ancestor, node) {
  for (let p = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/* The shell parsed at all - otherwise everything below passes vacuously. */
ok(byId.has("tv"), "the chart shell root is found in the markup");
ok(byClass.has("tv-top"), "the top bar is found");
ok(byClass.has("tv-body"), "the body is found");
ok(byId.has("tv-toolsfab"), "the tools FAB is in the markup");
ok(byId.has("tv-toolscrim"), "the tools scrim is in the markup");
ok(byId.has("tv-scrim"), "the dock scrim is in the markup");
ok(byId.size > 15, `plenty of ids parsed (${byId.size}), so the tree is real`);

/* -------------------------------------------- the bug, stated directly */
ok(!contains(byClass.get("tv-top"), byId.get("tv-toolsfab")),
  "the FAB is NOT inside the top bar (so it must not be wired there)");
ok(contains(byClass.get("tv-body"), byId.get("tv-toolsfab")),
  "the FAB is inside the body");
ok(contains(byId.get("tv"), byId.get("tv-toolsfab")),
  "the FAB is inside #tv, which is what it is now wired to");

/* ------------------------------- every delegated handler, checked */

// `const NAME = $("id")` or `document.querySelector(".cls")`
function resolveVar(name, before) {
  const slice = src.slice(0, before);
  const idDecl = new RegExp(`const ${name} = \\$\\("([^"]+)"\\)`, "g");
  const qsDecl = new RegExp(`const ${name} = document\\.querySelector\\("([^"]+)"\\)`, "g");
  let last = null;
  for (const re of [idDecl, qsDecl]) {
    let m;
    while ((m = re.exec(slice))) last = { sel: m[1], viaId: re === idDecl, at: m.index };
  }
  return last;
}

function nodeFor(decl) {
  if (!decl) return null;
  if (decl.viaId) return byId.get(decl.sel) || null;
  if (decl.sel.startsWith(".")) return byClass.get(decl.sel.slice(1)) || null;
  if (decl.sel.startsWith("#")) return byId.get(decl.sel.slice(1)) || null;
  return null;
}

const handlerRe = /(\w+)\.onclick = \(e\) => \{/g;
let h;
let handlers = 0;
let checkedTargets = 0;
while ((h = handlerRe.exec(src))) {
  const varName = h[1];
  const decl = resolveVar(varName, h.index);
  const host = nodeFor(decl);
  if (!host) continue;               // bound to something not in this shell
  handlers++;

  // the handler's own body
  let d = 0;
  let body = "";
  const start = src.indexOf("{", h.index);
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (!d) { body = src.slice(start + 1, k); break; } }
  }

  const ids = [...body.matchAll(/closest\("#([\w-]+)"\)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const target = byId.get(id);
    if (!target) continue;           // built elsewhere (menus, dock contents)
    checkedTargets++;
    ok(contains(host, target),
      `#${id} is inside ${decl.sel}, the element its click handler is bound to`);
  }
}
ok(handlers >= 2, `found ${handlers} delegated handlers to check`);
ok(checkedTargets >= 6, `checked ${checkedTargets} wired controls`);

/* ----------------------------------- the FAB opens the sheet, and only it */
const rootHandler = (() => {
  const i = src.indexOf('const root = $("tv");');
  return i < 0 ? "" : src.slice(i, i + 700);
})();
ok(/#tv-toolsfab"\)\) \{ toggleTools\(\); return; \}/.test(rootHandler),
  "tapping the FAB toggles the tool sheet");
ok(/#tv-toolscrim"\)\) \{ toggleTools\(false\); return; \}/.test(rootHandler),
  "tapping the scrim closes the tool sheet");
ok(/#tv-scrim"\)\) \{ toggleDock\(false\)/.test(rootHandler),
  "tapping the dock scrim closes the dock");

const topHandler = src.slice(src.indexOf('const top = document.querySelector(".tv-top")'), src.indexOf('const root = $("tv");'));
for (const id of ["tv-toolsfab", "tv-toolscrim", "tv-scrim"]) {
  ok(!topHandler.includes(`#${id}`), `the top bar no longer claims #${id}`);
}
// controls that really are in the header must stay there
for (const id of ["tv-back", "tv-undo", "tv-redo", "tv-dock-toggle", "tv-full"]) {
  ok(topHandler.includes(`#${id}`), `#${id} stays on the top bar handler`);
  ok(contains(byClass.get("tv-top"), byId.get(id)), `#${id} really is in the top bar`);
}

/* --------------------------------------------------------- the pencil */
const icons = src.slice(src.indexOf("const I = {"), src.indexOf("function svg("));
const pencil = /pencil:\s*"([^"]+)"/.exec(icons);
ok(Boolean(pencil), "a pencil icon is defined");
ok(/\$\{svg\(I\.pencil\)\}/.test(src), "the tools FAB draws the pencil");
ok(!/class="tv-toolsfab"[\s\S]{0,260}svg\(I\.brush\)/.test(src),
  "the FAB no longer uses the brush squiggle");
if (pencil) {
  const d = pencil[1];
  ok(d.split("|").length === 2, "the pencil is drawn as a barrel plus its collar");
  // Trace the pen rather than scraping numbers: lowercase commands carry
  // deltas, so a bare "-3" in an arc is perfectly legal and an earlier
  // version of this check wrongly flagged it. Only the positions the pen
  // actually reaches need to be inside the box.
  const pts = [];
  for (const seg of d.split("|")) {
    let x = 0;
    let y = 0;
    const cmds = seg.match(/[A-Za-z][^A-Za-z]*/g) || [];
    for (const c of cmds) {
      const op = c[0];
      const n = (c.slice(1).match(/-?\d*\.?\d+/g) || []).map(Number);
      const rel = op === op.toLowerCase();
      if (op === "M" || op === "L" || op === "m" || op === "l") {
        for (let k = 0; k + 1 < n.length; k += 2) {
          x = rel ? x + n[k] : n[k];
          y = rel ? y + n[k + 1] : n[k + 1];
          pts.push([x, y]);
        }
      } else if (op === "H" || op === "h") {
        n.forEach((v) => { x = rel ? x + v : v; pts.push([x, y]); });
      } else if (op === "V" || op === "v") {
        n.forEach((v) => { y = rel ? y + v : v; pts.push([x, y]); });
      } else if (op === "a" || op === "A") {
        // rx ry rot large sweep ex ey - only the endpoint moves the pen.
        // The two flags are single digits and may be written without a
        // separator ("0 00-3-3"), which a plain number scan reads as one
        // value and then silently skips the whole arc - so match the
        // seven components explicitly rather than counting numbers.
        const arc = /(-?[\d.]+)[\s,]*(-?[\d.]+)[\s,]*(-?[\d.]+)[\s,]*([01])[\s,]*([01])[\s,]*(-?[\d.]+)[\s,]*(-?[\d.]+)/g;
        let a;
        while ((a = arc.exec(c.slice(1)))) {
          x = rel ? x + Number(a[6]) : Number(a[6]);
          y = rel ? y + Number(a[7]) : Number(a[7]);
          pts.push([x, y]);
        }
      }
    }
  }
  ok(pts.length >= 8, `the pencil path traces (${pts.length} points)`);
  const stray = pts.filter(([px, py]) => px < 0 || px > 24 || py < 0 || py > 24);
  ok(stray.length === 0,
    `every point the pencil reaches is inside the 24x24 viewBox${stray.length ? " (" + JSON.stringify(stray) + ")" : ""}`);
}
ok(/\.tv-toolsfab svg \{ width: 20px; height: 20px \}/.test(css),
  "the FAB icon has an explicit size");

/* svg() splits an icon on "|" into separate <path> elements, so each
   piece is a path in its own right and must begin with a move command.
   The pencil's collar line was written without one: a d attribute
   starting "14.5 7l3 3" is invalid and the browser draws nothing, which
   is invisible in a grep and in any check that only counts segments. */
let badSub = [];
let subs = 0;
for (const m of icons.matchAll(/(\w+):\s*"([^"]+)"/g)) {
  for (const sub of m[2].split("|")) {
    subs++;
    if (!/^\s*[Mm]/.test(sub)) badSub.push(`${m[1]}: ${sub}`);
  }
}
ok(subs > 60, `the icon set parsed (${subs} subpaths)`);
ok(badSub.length === 0,
  `every icon subpath starts with a move command${badSub.length ? " - " + badSub.join("; ") : ""}`);

/* the FAB is still reachable on a phone and still hidden on a desktop */
ok(/\.tv-toolsfab, \.tv-toolscrim \{ display: none \}/.test(css),
  "both overlays are off by default");
const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
ok(/\.tv-toolsfab \{[\s\S]*?display: grid/.test(phone), "the FAB appears on a narrow screen");
ok(/\.tv-toolsfab \{[\s\S]*?z-index: 36/.test(phone), "the FAB sits above the scrim it opens");
const scrimZ = /\.tv-toolscrim \{[\s\S]*?z-index: (\d+)/.exec(phone);
const fabZ = /\.tv-toolsfab \{[\s\S]*?z-index: (\d+)/.exec(phone);
ok(scrimZ && fabZ && Number(fabZ[1]) > Number(scrimZ[1]),
  "the FAB stays tappable while the sheet is open, so it can close it again");

console.log(failed ? `\n${failed} failed` : `\nall good (${byId.size} ids, ${handlers} handlers)`);
process.exit(failed ? 1 : 0);
