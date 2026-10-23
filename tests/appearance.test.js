/* Two appearance faults reported from a running desk.
 *
 *   1. Header buttons were not the same height. The bar puts 42px icon
 *      buttons next to 32px text buttons, and a 10px step on one row
 *      reads as a control that has slipped rather than as hierarchy.
 *
 *   2. Switching liquid glass off left things translucent. Two separate
 *      states remove the blur - the toggle (data-glass="off") and the
 *      fast rendering tier (data-perf="fast"), which a weak machine can
 *      also select on its own - but only the first replaced the
 *      see-through surface colours, so with no blur behind them those
 *      surfaces showed the wallpaper straight through.
 *
 * The second one was a *specificity* bug, not a missing rule: Settings
 * sets its own 55%-opaque card with `.set-main .set-block .card`, which
 * outranks `html[data-glass="off"] .card`, so the page stayed
 * transparent however the toggle was set. jsdom does not resolve custom
 * properties, so asserting on getComputedStyle here would pass on
 * anything; instead this walks the real cascade - every rule in the real
 * stylesheets, ordered by specificity then source order - and asks which
 * declaration actually wins for a given element. That is the thing that
 * was broken, and it is what a later rule would break again.
 *
 *   node tests/appearance.test.js
 */
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "apps", "web");
const FILES = ["app.css", "themes.css", "skins.css"];

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? "  — " + cond : "")); failed++; }
}

/* ------------------------------------------------------- tiny CSS model -- */

/** Flatten the stylesheets into ordered {selector, decls} rules. */
function rules() {
  const out = [];
  for (const file of FILES) {
    let css = fs.readFileSync(path.join(WEB, "css", file), "utf8");
    css = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // Lift at-rule bodies (media/supports) so their rules are seen too.
    // Nested blocks are rare here and are handled by one pass.
    const atRe = /@(media|supports)[^{]*\{/g;
    let m;
    while ((m = atRe.exec(css))) {
      let depth = 1, i = atRe.lastIndex;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      const body = css.slice(atRe.lastIndex, i - 1);
      css = css.slice(0, m.index) + " ".repeat(m[0].length) + body +
            " ".repeat(Math.max(0, i - atRe.lastIndex - body.length)) + css.slice(i);
      atRe.lastIndex = m.index;
    }
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = re.exec(css))) {
      const sels = r[1].split(",").map((s) => s.trim()).filter(Boolean);
      const decls = {};
      for (const d of r[2].split(";")) {
        const k = d.indexOf(":");
        if (k < 0) continue;
        decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
      }
      for (const sel of sels) out.push({ sel, decls, file });
    }
  }
  return out;
}

/** CSS specificity (ids, classes+attrs+pseudo-classes, elements). */
function specificity(sel) {
  const s = sel.replace(/::[\w-]+/g, " ");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+/g) || []).length
            + (s.match(/\[[^\]]+\]/g) || []).length
            + (s.match(/:(?!:)[\w-]+/g) || []).length;
  const el = (s.replace(/[#.][\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g, " ")
               .match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return ids * 10000 + cls * 100 + el;
}

/**
 * Does `sel` match this element?
 *
 * The element is described as a list of ancestor "steps" (outermost
 * first), each a set of classes plus the root's attributes. Enough for
 * descendant selectors, classes, attributes and :is(...) - which is all
 * the surface rules in this codebase use.
 */
function matches(sel, chain, rootAttrs) {
  if (/:(hover|focus|active|focus-visible|focus-within)/.test(sel)) return false;
  if (/::/.test(sel)) return false;

  // Expand :is(a, b) / :where(a, b) into alternatives.
  const expand = (s) => {
    const m = s.match(/:(?:is|where)\(([^()]*)\)/);
    if (!m) return [s];
    return m[1].split(",").flatMap((opt) =>
      expand(s.slice(0, m.index) + opt.trim() + s.slice(m.index + m[0].length)));
  };

  return expand(sel).some((variant) => {
    const parts = variant.trim().split(/\s+/).filter((p) => p !== ">");
    let at = -1;
    for (const part of parts) {
      let found = -1;
      for (let i = at + 1; i < chain.length; i++) {
        if (stepMatches(part, chain[i], i === 0 ? rootAttrs : null)) { found = i; break; }
      }
      if (found < 0) return false;
      at = found;
    }
    // The selector's last step has to land on the element itself.
    return at === chain.length - 1;
  });
}

function stepMatches(part, step, attrs) {
  const classes = (part.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  if (!classes.every((c) => step.classes.includes(c))) return false;
  for (const a of part.match(/\[[^\]]+\]/g) || []) {
    const m = a.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
    if (!m) return false;
    const have = (attrs || step.attrs || {})[m[1]];
    if (have === undefined) return false;
    if (m[2] !== undefined && have !== m[2]) return false;
  }
  const tag = part.replace(/[#.][\w-]+|\[[^\]]+\]|:(?!:)[\w-]+|:(?:is|where)\([^)]*\)/g, "").trim();
  if (tag && tag !== "*" && !(step.tags || []).includes(tag)) return false;
  return true;
}

const ALL = rules();

/** The declaration that actually wins for this element. */
function winning(prop, chain, rootAttrs) {
  let best = null, bestSpec = -1, bestIdx = -1;
  ALL.forEach((rule, idx) => {
    if (!(prop in rule.decls)) return;
    if (!matches(rule.sel, chain, rootAttrs)) return;
    const spec = specificity(rule.sel) + (/!important/.test(rule.decls[prop]) ? 1e9 : 0);
    if (spec > bestSpec || (spec === bestSpec && idx > bestIdx)) {
      best = rule; bestSpec = spec; bestIdx = idx;
    }
  });
  return best;
}

/** Any colour in the value carrying an alpha below 1.
 *
 * Has to cope with `rgb(var(--s7) / .62)`: the nested var() means a
 * naive [^)]* never reaches the slash, which is exactly how an earlier
 * version of this test passed every surface regardless. So the
 * slash-alpha form is matched wherever it appears in the value, and the
 * legacy four-argument rgba() form separately. */
function isTranslucent(value) {
  if (!value) return false;
  const v = String(value);
  // modern: <colour> / <alpha>)
  for (const m of v.matchAll(/\/\s*([0-9]*\.?[0-9]+)\s*\)/g)) {
    if (parseFloat(m[1]) < 1) return true;
  }
  // legacy: rgba(r, g, b, a)
  for (const m of v.matchAll(/rgba\(\s*[^)]*?,\s*([0-9]*\.?[0-9]+)\s*\)/g)) {
    if (parseFloat(m[1]) < 1) return true;
  }
  return false;
}

const html = (attrs) => ({ classes: [], tags: ["html"], attrs });

/* ------------------------------------------------- 1. header heights -- */

{
  const root = { "data-theme": "dark" };
  const top = { classes: ["top"], tags: ["header"] };
  const buttons = {
    "menu button": { classes: ["menu-btn"], tags: ["button"] },
    "icon button": { classes: ["icon-btn"], tags: ["button"] },
    "text button": { classes: ["btn", "tiny", "ghost"], tags: ["button"] },
    "danger button": { classes: ["btn", "tiny", "danger"], tags: ["button"] },
  };

  const got = {};
  for (const [name, el] of Object.entries(buttons)) {
    const win = winning("height", [html(root), top, el], root);
    got[name] = win ? win.decls.height : "(none)";
  }
  const values = Object.values(got);
  check("every header button gets a height from the cascade",
    values.every((v) => v !== "(none)") || JSON.stringify(got));
  check("all header buttons resolve to the same height declaration",
    new Set(values).size === 1 ||
      Object.entries(got).map(([k, v]) => `${k}=${v}`).join(", "));
  check("that height is the header's single variable",
    /--hdr-ctl-h/.test(values[0] || "") || `got ${values[0]}`);

  // Outside the header a tiny button keeps its own smaller size.
  const loose = winning("height", [html(root), { classes: ["card"] },
                                   { classes: ["btn", "tiny"], tags: ["button"] }], root);
  check("buttons elsewhere are not forced to the header height",
    !loose || !/--hdr-ctl-h/.test(loose.decls.height));
}

/* --------------------------------------------- 2. opaque, both ways -- */

const SURFACES = {
  "a normal card": [{ classes: ["card"] }],
  "the settings card": [{ classes: ["set-main"], tags: ["main"] },
                        { classes: ["set-block"] }, { classes: ["card"] }],
  "the sticky settings jumper": [{ classes: ["set-main"], tags: ["main"] },
                                 { classes: ["set-jump"] }],
  "the header bar": [{ classes: ["top"], tags: ["header"] }],
  "the side rail": [{ classes: ["nav"], tags: ["nav"] }],
};

for (const [attr, label] of [["data-glass", "glass switched off"],
                             ["data-perf", "fast renderer (weak machine)"]]) {
  const root = { "data-theme": "dark", [attr]: attr === "data-glass" ? "off" : "fast" };
  for (const [name, tail] of Object.entries(SURFACES)) {
    const chain = [html(root), ...tail];
    const win = winning("background", chain, root) || winning("background-color", chain, root);
    const value = win ? (win.decls.background || win.decls["background-color"]) : "";
    check(`${label}: ${name} is solid`,
      (win && !isTranslucent(value)) ||
      (!win ? "no background rule won at all" : `wins "${win.sel}" -> ${value}`));
  }
  for (const v of ["--glass", "--glass2"]) {
    const win = winning(v, [html(root)], root);
    check(`${label}: ${v} is opaque`,
      (win && !isTranslucent(win.decls[v])) ||
      (!win ? `${v} never set` : `${win.sel} -> ${win.decls[v]}`));
  }
}

// The frosted look must survive when it is actually wanted.
{
  const root = { "data-theme": "dark", "data-glass": "on", "data-perf": "rich" };
  const win = winning("background", [html(root), { classes: ["card"] }], root);
  check("with glass on and a capable renderer the card is still frosted",
    isTranslucent(win && win.decls.background) || `wins ${win && win.sel}`);
}

/* -------------------------------------- the toggle cannot lie to you -- */

{
  const src = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
  const css = FILES.map((f) => fs.readFileSync(path.join(WEB, "css", f), "utf8")).join("\n");
  check("the desk knows when the renderer has forced glass off", /function glassForced\(/.test(src));
  check("glassOn reports forced-off rather than the stored preference",
    /function glassOn\(\)[\s\S]{0,260}glassForced\(\)/.test(src));
  check("the switch is disabled when it cannot do anything", /sw\.disabled = forced/.test(src));
  check("clicking it while forced does nothing", /if \(!glassForced\(\)\) setGlass/.test(src));
  check("the fast tier greys the switch out", /html\[data-perf="fast"\] #sw-glass/.test(css));
}

console.log(failed ? `\nappearance: ${failed} check(s) failed` : "\nappearance: all checks passed");
process.exit(failed ? 1 : 0);
