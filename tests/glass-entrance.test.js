/* Switching page used to show flat, borderless panels for about half a
 * second and then snap them all to glass at once.
 *
 * The cause is not a timing bug, it is a rendering rule: while an
 * opacity animation is RUNNING on a backdrop-filter pane, or on any
 * ancestor of one, the blur samples nothing and the pane renders flat.
 * Not merely while opacity is below 1 - for the entire animation, even
 * after it reaches 1, because the element stays promoted to its own
 * backdrop root until the animation ends. Measured in Chrome: an
 * ancestor transform animation keeps the blur intact, an ancestor
 * opacity animation kills it, and it returns the moment the animation
 * finishes. That return is the snap people see.
 *
 * So entrances on glass surfaces must animate transform only. This
 * guard pins that for the page-transition family. */
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "apps", "web", "css", f), "utf8");
const app = read("app.css");
const themes = read("themes.css");

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + "\n      " + e.message); fail++; }
};

/* Which keyframe sets mention opacity at all. */
function keyframesWithOpacity(css) {
  const out = new Set();
  const re = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = re.lastIndex - 1, depth = 0, end = i;
    for (let k = i; k < css.length; k++) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") { depth--; if (!depth) { end = k; break; } }
    }
    if (/(^|[^-\w])opacity\s*:/.test(css.slice(i, end))) out.add(m[1]);
  }
  return out;
}

const fades = new Set([...keyframesWithOpacity(app), ...keyframesWithOpacity(themes)]);

check("the glass-safe entrance keyframes exist and really carry no opacity", () => {
  for (const k of ["riseIn", "leaveOut", "setIn"]) {
    if (!new RegExp("@keyframes\\s+" + k + "\\b").test(app)) throw new Error("@keyframes " + k + " is gone");
    if (fades.has(k)) throw new Error(k + " animates opacity again, which flattens every pane it runs on");
  }
});

/* The rules that run on a page change, in both stylesheets. */
const GUARDED = [
  [app, "app.css", /\.stage\.is-entering\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [app, "app.css", /\.stage\.is-leaving\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [app, "app.css", /\.stage\s+\.card\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [app, "app.css", /\.set-main\s+\.set-block\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [app, "app.css", /\.glass-rise\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [themes, "themes.css", /html\[data-skin\]\s+\.stage\.is-entering\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [themes, "themes.css", /html\[data-skin\]\s+\.stage\.is-leaving\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
  [themes, "themes.css", /html\[data-skin\]\s+\.stage\s+\.card\s*\{[^}]*animation:\s*([A-Za-z0-9_-]+)/],
];

check("nothing in the page-transition path fades a glass pane", () => {
  for (const [css, file, re] of GUARDED) {
    const m = css.match(re);
    if (!m) throw new Error("the rule " + re + " is gone from " + file + " - retarget this guard, do not drop it");
    if (fades.has(m[1])) {
      throw new Error(file + ": " + m[1] + " animates opacity, so panels render flat for its whole duration "
        + "and snap to glass when it ends");
    }
  }
});

check("the card stagger cannot outlast the entrance it belongs to", () => {
  /* The flash was long because .26s of stagger sat on top of the
     animation. Movement-only entrances are cheap, but a delay longer
     than the animation still reads as a stall. */
  const delays = [...app.matchAll(/\.stage\s+\.grid\s*>\s*\.card:nth-child\([^)]*\)\{animation-delay:([\d.]+)s\}/g)]
    .map((m) => parseFloat(m[1]));
  if (!delays.length) throw new Error("the stagger is gone - retarget this guard");
  const dur = parseFloat((app.match(/\.stage\s+\.card\{animation:riseIn\s+([\d.]+)s/) || [0, 0])[1]);
  if (!dur) throw new Error("cannot read the card entrance duration");
  if (Math.max(...delays) > dur) throw new Error("a card waits " + Math.max(...delays) + "s for a " + dur + "s entrance");
});

console.log("\nglass-entrance: " + pass + " of " + (pass + fail) + " checks passed");
process.exitCode = fail ? 1 : 0;
