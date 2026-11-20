/**
 * The desk half of "prop mode must not reduce the number of trades".
 *
 * The engine side is pinned by engine/tests/test_prop_trade_count.py:
 * the five gates that count tickets rather than money are opt-in per
 * profile, and the firm-shaped presets ship with them off.
 *
 * Two things have to be true on this side.
 *
 * First, the switch has to exist and be saved. The prop page still
 * shows the count boxes - max open trades, per symbol, per day, the
 * gap, the losing streak - and a box that is displayed, is editable
 * and is then ignored is worse than no box at all. The switch says
 * whether those numbers are enforced, and it has to reach the engine
 * in the same payload as everything else.
 *
 * Second, the verdict has to be announced BOTH ways. The refusal used
 * to go to the robot log, which is a page nobody has open while they
 * are watching a chart, and the pass went nowhere at all - so "prop is
 * quietly doing its job" and "prop is eating my trades" looked exactly
 * the same from the desk. That is the half of the report that a
 * silent pass cannot answer.
 *
 *     node tests/prop-trade-count.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (name, fn) => {
  try {
    const note = fn();
    console.log("ok   " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    fails++;
    console.log("FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appJs = read("apps/web/js/app.js");
const appCss = read("apps/web/css/app.css");
const guideJs = read("apps/web/js/prop-guide.js");
const langs = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

/** The body of one top-level function, by brace counting. */
function body(name) {
  const at = appJs.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`${name} is gone from app.js`);
  let depth = 0;
  const from = appJs.indexOf("{", at);
  for (let i = from; i < appJs.length; i++) {
    if (appJs[i] === "{") depth++;
    else if (appJs[i] === "}" && --depth === 0) return appJs.slice(from, i + 1);
  }
  throw new Error(`cannot find the end of ${name}`);
}

// ── the switch ────────────────────────────────────────────────────────
check("the prop form carries the count-limit switch", () => {
  const form = body("propFormHtml");
  if (!form.includes('id="pr-throttle"')) throw new Error("pr-throttle is not on the page");
  if (!form.includes("risk.throttle")) throw new Error("the switch has no translated label");
});

check("the switch reflects the saved profile rather than defaulting on", () => {
  const form = body("propFormHtml");
  if (!/pr-throttle"\s*\$\{pr\.throttle_entries \?/.test(form)) {
    throw new Error("the checkbox is not driven by profile.throttle_entries");
  }
});

check("the form says, in words, which limits are being enforced", () => {
  const form = body("propFormHtml");
  if (!form.includes("risk.throttle_on") || !form.includes("risk.throttle_off")) {
    throw new Error("the page never states whether the count boxes are live");
  }
});

check("saving the profile sends the switch to the engine", () => {
  const payload = body("customPropPayload");
  if (!/throttle_entries:\s*Boolean\(\$\("pr-throttle"\)\?\.checked\)/.test(payload)) {
    throw new Error("customPropPayload drops throttle_entries, so the switch would never stick");
  }
});

check("the switch is explained in the prop guide", () => {
  if (!guideJs.includes('id: "pr-throttle"')) {
    throw new Error("a prop control shipped without a guide entry");
  }
});

check("the three language packs carry the new keys", () => {
  for (const [lang, pack] of Object.entries(langs)) {
    for (const key of ["throttle", "throttle_on", "throttle_off"]) {
      if (!pack.risk || !pack.risk[key]) throw new Error(`${lang} is missing risk.${key}`);
    }
    for (const key of ["prop_pass", "prop_stop"]) {
      if (!pack.notify || !pack.notify[key]) throw new Error(`${lang} is missing notify.${key}`);
    }
  }
});

// ── both verdicts are announced ───────────────────────────────────────
check("the desk listens for the engine's prop verdict", () => {
  if (!/msg\.type === "prop_check"/.test(appJs)) {
    throw new Error("nothing handles the prop_check event");
  }
  if (!/announcePropCheck\(msg\.data \|\| msg\)/.test(appJs)) {
    throw new Error("the event arrives and is thrown away");
  }
});

check("a pass and a refusal are both turned into a card", () => {
  const fn = body("announcePropCheck");
  if (!fn.includes("notify.prop_pass") || !fn.includes("notify.prop_stop")) {
    throw new Error("only one of the two verdicts has a headline");
  }
  if (/if \(!ok\) return/.test(fn) || /if \(ok\) return/.test(fn)) {
    throw new Error("one of the two verdicts returns early and is never shown");
  }
});

check("a refusal shows the sentence that names the rule", () => {
  const fn = body("announcePropCheck");
  if (!fn.includes("d.why")) throw new Error("the reason the order was refused is not displayed");
});

check("the card un-hides the stack it is prepended to", () => {
  // The notify stack ships hidden and is hidden again whenever it
  // empties, so anything that puts a card in it has to turn it back
  // on - the fault that once made signals invisible until a manual
  // trade happened to reveal the whole backlog.
  const fn = body("announcePropCheck");
  if (!/stack\.hidden = false/.test(fn)) throw new Error("the card would be added to a hidden stack");
});

check("a repeated verdict is not announced twice", () => {
  const fn = body("announcePropCheck");
  if (!/_lastPropCheckKey/.test(fn)) {
    throw new Error("the bus republishes on reconnect; there is no duplicate guard");
  }
});

check("a pass is silent and a refusal is not", () => {
  const fn = body("announcePropCheck");
  if (!/if \(!ok\) playSound/.test(fn)) {
    throw new Error("either every allowed order chimes, or a refusal is silent");
  }
});

check("the card has a style of its own", () => {
  for (const sel of [".notify-card.prop-card", ".notify-card.prop-card.is-block"]) {
    if (!appCss.includes(sel)) throw new Error("missing CSS for " + sel);
  }
});

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exitCode = fails ? 1 : 0;
