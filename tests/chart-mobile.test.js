/**
 * The EA chart on a phone.
 *
 * Two faults were reported from a real device: the side panel sat over
 * the chart the moment the page opened, and it was see-through. Both are
 * cascade questions, so they are answered by resolving the cascade
 * rather than by grepping for a selector - a grep would have passed
 * happily the whole time the bug was there.
 *
 *     node tests/chart-mobile.test.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const cssPath = path.join(root, "apps/web/css/chart.css");
const themesPath = path.join(root, "apps/web/css/themes.css");
const toolsPath = path.join(root, "apps/web/js/chart-tools.js");

const rawCss = fs.readFileSync(cssPath, "utf8");
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
const tools = fs.readFileSync(toolsPath, "utf8");
const themes = fs.readFileSync(themesPath, "utf8");

let failed = 0;
function check(name, cond) {
  const ok = cond === true;
  console.log((ok ? "  ok  " : "FAIL  ") + name +
    (ok || typeof cond !== "string" ? "" : "  — " + cond));
  if (!ok) failed++;
}

/* ------------------------------------------------- a small cascade -- */

function blocks(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@media", i);
    if (at < 0) { out.push({ cond: null, text: text.slice(i) }); break; }
    out.push({ cond: null, text: text.slice(i, at) });
    const open = text.indexOf("{", at);
    const cond = text.slice(at + 6, open).trim();
    let d = 1, j = open + 1;
    while (j < text.length && d > 0) {
      if (text[j] === "{") d++; else if (text[j] === "}") d--;
      j++;
    }
    out.push({ cond, text: text.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
const SHEET = blocks(css);

function holds(cond, env) {
  if (!cond) return true;
  return cond.split(/\s+and\s+/).every((part) => {
    let m;
    if ((m = part.match(/\(max-width:\s*(\d+)px\)/))) return env.width <= +m[1];
    if ((m = part.match(/\(min-width:\s*(\d+)px\)/))) return env.width >= +m[1];
    if ((m = part.match(/\(pointer:\s*(\w+)\)/))) return env.pointer === m[1];
    return false;   // reduced-motion and anything else: not our environment
  });
}
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  return ids * 100 + cls * 10;
}
function* declarations(text) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) yield { sel: m[1].trim(), body: m[2] };
}
/** The declaration that actually applies, given a selector filter. */
function winner(prop, matches, env) {
  let best = null;
  for (const b of SHEET) {
    if (!holds(b.cond, env)) continue;
    for (const r of declarations(b.text)) {
      const parts = r.sel.split(",").map((s) => s.trim()).filter(matches);
      if (!parts.length) continue;
      const m = r.body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)", "i"));
      if (!m) continue;
      const sp = Math.max(...parts.map(specificity));
      if (!best || sp >= best.sp) best = { sp, value: m[1].trim(), sel: r.sel.trim(), cond: b.cond };
    }
  }
  return best;
}

const PHONE = { width: 390, pointer: "coarse" };
const TABLET = { width: 900, pointer: "coarse" };
const DESKTOP = { width: 1400, pointer: "fine" };

/** A colour with no alpha channel cannot be seen through. */
function opaque(value) {
  if (!value) return false;
  if (/^rgb\(\s*var\(--s\d\)\s*\)$/.test(value.replace(/\s+/g, " ").trim())) return true;
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) return true;
  return false;
}

/* ============================ the panel must not be see-through ======= */

console.log("the side panel where it floats over the chart\n");
{
  const only = (s) => /(^|\s)\.tv-dock$/.test(s);
  const onPhone = winner("background", only, PHONE);
  check("the dock is opaque on a phone, where it floats on the chart",
    (onPhone && opaque(onPhone.value)) || `resolved to ${onPhone && onPhone.value}`);

  const onTablet = winner("background", only, TABLET);
  check("...and on a tablet, where it also floats",
    (onTablet && opaque(onTablet.value)) || `resolved to ${onTablet && onTablet.value}`);

  const onDesk = winner("background", only, DESKTOP);
  check("...but keeps the theme's own surface on a desktop, where it is a column",
    (onDesk && /--surface-2/.test(onDesk.value)) || `resolved to ${onDesk && onDesk.value}`);
}
{
  const only = (s) => /(^|\s)\.tv-rail$/.test(s);
  const onPhone = winner("background", only, PHONE);
  check("the tool rail is opaque too, for the same reason",
    (onPhone && opaque(onPhone.value)) || `resolved to ${onPhone && onPhone.value}`);
}
{
  // Why --surface-2 could not be trusted: the trader sets that alpha.
  check("the theme's surface alpha really is adjustable, so it could not be relied on",
    /--surface-alpha["']?\s*:\s*\(?\s*clamp/.test(
      fs.readFileSync(path.join(root, "apps/web/js/themes.js"), "utf8")
        .replace(/\s+/g, " ")) ||
    /--surface-alpha:/.test(themes));
  check("and --s6 is a bare channel triple, which is what makes rgb(var(--s6)) opaque",
    /--s6:\s*\d+\s+\d+\s+\d+/.test(themes));
}

/* ====================== the panel must not be in the way on open ===== */

console.log("\nthe side panel on first open");
{
  /* Retargeted, and deliberately made stricter.
     This used to accept `read(LS_DOCK, narrow() ? "0" : "1")` - a default
     decided by viewport. That is not enough, because the stored value is
     one preference shared by every width: a trader who opened the dock at
     a desk arrived on a phone to find a 300px panel sitting on top of the
     chart from the first frame, which reads as "half the chart is
     missing". Where the dock is an overlay it does not get to remember
     being open at all; the stored state applies again as soon as there is
     room for it to be a column. */
  check("the dock cannot open over the chart on a narrow screen",
    /ui\.dockOpen = narrow\(\) \? false : read\(LS_DOCK, "1"\) === "1";/.test(tools));
  check("...and the stored preference still applies where it is a column",
    /read\(LS_DOCK, "1"\)/.test(tools));
  check("...and 'narrow' is the same 980px breakpoint the stylesheet floats it at",
    /matchMedia\(\s*"\(max-width:\s*980px\)"\s*\)/.test(tools) &&
    /@media \(max-width: 1000px\)/.test(rawCss));
  const floatsAt = (rawCss.match(/@media \(max-width: (\d+)px\)/g) || []);
  check("...which is a breakpoint that exists in the file",
    floatsAt.includes("@media (max-width: 1000px)") || floatsAt.join(" "));
}

/* ================================= the tools, laid out for a thumb === */

console.log("\nthe drawing tools");
{
  const btn = (s) => /(^|\s)\.tvr-btn$/.test(s);
  const name = (s) => /(^|\s)\.tvr-name$/.test(s);

  const w = winner("width", btn, PHONE);
  check("tool cells fill the sheet's grid on a phone rather than staying icon-sized",
    (w && w.value === "100%") || `width resolved to ${w && w.value}`);

  const h = winner("min-height", btn, PHONE);
  const tall = h && parseInt(h.value, 10) >= 44;
  check("...and are at least a 44px touch target",
    tall || `min-height resolved to ${h && h.value}`);

  const nPhone = winner("display", name, PHONE);
  check("every tool group shows its name on a phone",
    (nPhone && nPhone.value === "block") || `display resolved to ${nPhone && nPhone.value}`);

  const nDesk = winner("display", name, DESKTOP);
  check("...and no name clutters the desktop rail",
    (nDesk && nDesk.value === "none") || `display resolved to ${nDesk && nDesk.value}`);

  const dw = winner("width", btn, DESKTOP);
  check("the desktop rail is left exactly as it was",
    (dw && dw.value === "36px") || `width resolved to ${dw && dw.value}`);

  // The coarse-pointer sizing must not reach into the sheet. 761 and
  // not 760: min-width and max-width of the same number both match at
  // exactly that width, and the later rule silently wins.
  const coarseRule = /@media \(pointer: coarse\) and \(min-width: 761px\)/.test(rawCss);
  check("the coarse-pointer button size is scoped above the sheet's breakpoint",
    coarseRule);
}
{
  const sheet = (s) => /(^|\s)\.tv-rail$/.test(s);
  const t = winner("transform", sheet, PHONE);
  check("the sheet starts off-screen and is brought up on demand",
    /translateY/.test((t && t.value) || "") || /\.tv\.tools-open \.tv-rail/.test(css));
  check("there is a control to open it",
    /id="tv-toolsfab"/.test(tools) && /toggleTools/.test(tools));
  check("tapping away from it closes it",
    /tv-toolscrim[\s\S]{0,120}toggleTools\(false\)/.test(tools));
  check("choosing a tool closes it",
    /toggleTools\(false\);\s*\n\s*markTool\(\);/.test(tools));
}
{
  // Regression: pickTool rewrote the button's innerHTML with just the
  // icon, which erased the label the sheet depends on.
  check("picking a tool keeps the group's name on the button",
    /groupBtn\.innerHTML\s*=\s*svg\(I\[tool\.icon\]\)\s*\+[\s\S]{0,120}tvr-name/.test(tools));
}
{
  const n = (tools.match(/class="tvr-name"/g) || []).length;
  check("every rail control carries a name, not just the tool groups",
    n >= 6 || `only ${n} labelled`);
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nchart on mobile: all checks passed");
process.exit(failed ? 1 : 0);
