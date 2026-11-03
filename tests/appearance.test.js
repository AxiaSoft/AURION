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

/* The sheet order is READ FROM index.html, never written down here.
 *
 * It was written down here once, as ["app.css", "themes.css", "skins.css"],
 * and that single transposition made this whole file lie: the page loads
 * skins.css BEFORE themes.css, so a theme rule of equal specificity beats
 * the "liquid glass off" override in the browser and lost to it here. Every
 * opacity assertion below passed while the real header stayed translucent.
 *
 * Source order is half of the cascade. A test that hard-codes it is testing
 * a stylesheet arrangement that does not exist. */
const FILES = (() => {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const out = [];
  const re = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']css\/([^"'?]+)/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  if (!out.length) throw new Error("no stylesheets found in index.html");
  return out;
})();

let failed = 0;
function check(name, cond) {
  if (cond === true) console.log("  ok  " + name);
  else { console.log("FAIL  " + name + (typeof cond === "string" ? "  — " + cond : "")); failed++; }
}

/* ------------------------------------------------------- tiny CSS model -- */

/* Split "a, b:is(c, d), e" on the commas that separate selectors, NOT on the
 * ones inside :is()/:where()/:not().
 *
 * A plain .split(",") tore `html[...] :is(.nav, .top, .hdr-drawer)` into three
 * pieces, the last of which was the fragment ".top)". It matched nothing, so
 * the rule that makes the header opaque was absent from the model entirely -
 * and the model happily reported the header solid on the strength of a
 * weaker rule that did survive the split. */
function splitSelectorGroup(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
}

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
      const sels = splitSelectorGroup(r[1]);
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
/* Specificity, with :is()/:not() handled the way browsers actually do it.
 *
 * The naive version counted every class inside :is(...) separately and the
 * :is itself as another pseudo-class, so
 * `html[data-glass="off"] :is(.nav, .top, .hdr-drawer)` scored as if it had
 * four classes. In a browser :is() contributes the specificity of its
 * SINGLE most specific argument, so that selector is (0,2,1) - exactly
 * equal to `html[data-skin] .top` in themes.css, which loads afterwards and
 * therefore wins. That tie is the whole reason the header stayed
 * translucent, and the inflated score was hiding it. */
function specificity(sel) {
  const s = sel.replace(/::[\w-]+/g, " ");
  const triple = [0, 0, 0]; // ids, classes+attrs+pseudo-classes, elements

  // Pull out :is()/:where()/:not() first and score them by their best branch.
  let rest = s;
  const fnRe = /:(is|where|not|has)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while ((m = fnRe.exec(s))) {
    rest = rest.replace(m[0], " ");
    if (m[1] === "where") continue; // :where() always contributes zero
    let best = [0, 0, 0];
    for (const branch of splitSelectorGroup(m[2])) {
      const b = specificity(branch);
      const bt = [Math.floor(b / 10000), Math.floor((b % 10000) / 100), b % 100];
      if (bt[0] > best[0] || (bt[0] === best[0] && bt[1] > best[1]) ||
          (bt[0] === best[0] && bt[1] === best[1] && bt[2] > best[2])) best = bt;
    }
    triple[0] += best[0]; triple[1] += best[1]; triple[2] += best[2];
  }

  triple[0] += (rest.match(/#[\w-]+/g) || []).length;
  triple[1] += (rest.match(/\.[\w-]+/g) || []).length
             + (rest.match(/\[[^\]]+\]/g) || []).length
             + (rest.match(/:(?!:)[\w-]+/g) || []).length;
  triple[2] += (rest.replace(/[#.][\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g, " ")
                    .match(/\b[a-zA-Z][\w-]*\b/g) || []).length;

  return triple[0] * 10000 + triple[1] * 100 + triple[2];
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

/* Expand `var(--x)` so a colour defined one hop away can still be judged.
 *
 * Every theme paints its card with `background:var(--card-bg)`, and
 * --card-bg is a gradient of translucent stops declared elsewhere. Reading
 * the literal string "var(--card-bg)" and asking whether it looks
 * see-through answers "no" for every theme on the desk. */
function resolveVars(value, chain, rootAttrs, depth) {
  if (depth === undefined) depth = 0;
  if (!value || depth > 4) return value || "";
  return String(value).replace(/var\((--[\w-]+)(?:\s*,[^()]*)?\)/g, (whole, name) => {
    /* Custom properties are looked up on <html>, not on the element.
       They inherit, and every one of them in this codebase is declared on
       the root; asking for them at the element finds nothing, because a
       declaration only counts here when the selector's last step lands on
       the element itself. */
    const win = winning(name, [chain[0]], rootAttrs);
    return win ? resolveVars(win.decls[name], chain, rootAttrs, depth + 1) : whole;
  });
}

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
/* Is this colour see-through?
 *
 * Twice now this function has answered "no" to something translucent and
 * hidden a real fault: first for `rgb(var(--s7) / .62)`, where a naive
 * `[^)]*` stopped at the var()'s own bracket, and then for
 * `rgb(var(--s2) / calc(var(--surface-alpha) * .62))`, the form every theme
 * in themes.css actually uses - which it read as opaque and passed.
 *
 * So the rule is inverted: anything with a slash-alpha is treated as
 * translucent unless the alpha is provably 1. A calc() we cannot evaluate
 * is reported as translucent, because "I could not tell" must never come
 * out as "it is solid" - that is the answer that lets the bug ship. */
function isTranslucent(value) {
  if (!value) return false;
  const v = String(value);

  // modern: <colour> / <alpha>, where alpha may be a number, a percentage,
  // a var() or a calc().
  for (const m of v.matchAll(/\/\s*([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
    const alpha = m[1].trim();
    if (/^[0-9]*\.?[0-9]+$/.test(alpha)) { if (parseFloat(alpha) < 1) return true; continue; }
    if (/^[0-9]*\.?[0-9]+%$/.test(alpha)) { if (parseFloat(alpha) < 100) return true; continue; }
    // not a literal we can evaluate - calc(), var(), anything else
    return true;
  }

  // legacy: rgba(r, g, b, a)
  for (const m of v.matchAll(/rgba\(\s*[^)]*?,\s*([0-9]*\.?[0-9]+)\s*\)/g)) {
    if (parseFloat(m[1]) < 1) return true;
  }
  return false;
}

const html = (attrs) => ({ classes: [], tags: ["html"], attrs });

/* The attributes the real <html> always carries.
 *
 * themes.js sets data-skin, data-bg and data-motion on every boot, before
 * anything is painted. Leaving them out of the simulated root here meant
 * every `html[data-skin] ...` rule in themes.css was silently skipped - and
 * those are exactly the rules that compete with "liquid glass off". The
 * header was reported translucent twice while this file reported it solid.
 *
 * A theme id has to be named: `html[data-skin="frost"] .top` restates the
 * header background, so "any theme" is not good enough to prove the
 * override holds. The default theme is the one most desks run. */
function desk(extra) {
  return Object.assign({
    "data-theme": "dark",
    "data-skin": "glass",
    "data-bg": "soft",
    "data-motion": "full",
  }, extra || {});
}

/* ------------------------------------------------- 1. header heights -- */

{
  const root = desk();
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
  const root = desk({ [attr]: attr === "data-glass" ? "off" : "fast" });
  for (const [name, tail] of Object.entries(SURFACES)) {
    const chain = [html(root), ...tail];
    const win = winning("background", chain, root) || winning("background-color", chain, root);
    const value = win
      ? resolveVars(win.decls.background || win.decls["background-color"], chain, root)
      : "";
    check(`${label}: ${name} is solid`,
      (win && !isTranslucent(value)) ||
      (!win ? "no background rule won at all" : `wins "${win.sel}" -> ${value}`));
  }
  for (const v of ["--glass", "--glass2"]) {
    const win = winning(v, [html(root)], root);
    const value = resolveVars(win && win.decls[v], [html(root)], root);
    check(`${label}: ${v} is opaque`,
      (win && !isTranslucent(value)) ||
      (!win ? `${v} never set` : `${win.sel} -> ${value}`));
  }
}

// The frosted look must survive when it is actually wanted.
{
  const root = desk({ "data-glass": "on", "data-perf": "rich" });
  const chain = [html(root), { classes: ["card"] }];
  const win = winning("background", chain, root);
  const value = resolveVars(win && win.decls.background, chain, root);
  check("with glass on and a capable renderer the card is still frosted",
    isTranslucent(value) || `wins ${win && win.sel} -> ${value.slice(0, 90)}`);
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
  check("the fast tier greys the switch out",
    /\[data-perf="fast"\][^{]*#sw-glass/.test(css));
}

console.log(failed ? `\nappearance: ${failed} check(s) failed` : "\nappearance: all checks passed");
process.exit(failed ? 1 : 0);
