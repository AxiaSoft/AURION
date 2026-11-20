/**
 * The strategy page, and automatic money management — the desk side.
 *
 * Three things were asked for on the strategy page:
 *
 *   1. a broken strategy file must not take the section down (the
 *      engine half is engine/tests/test_strategy_section_survives.py;
 *      what is checked here is that the desk still has the card that
 *      names the file and the exact error);
 *   2. the code editor goes behind a "View code" button - a
 *      permanently-open code box is most of the page on a laptop and
 *      on the common path (drop a .py in, press upload) nobody ever
 *      types in it;
 *   3. the live strategy-status banner is deleted. It repeated three
 *      things the page already showed, and its last-signal pill named
 *      whichever strategy spoke last, so on a multi-strategy desk it
 *      disagreed with the cards underneath it.
 *
 * And one on the settings page: automatic money management, where the
 * loss cap is a percentage of live equity instead of a fixed amount
 * that goes stale.
 *
 *     node tests/strategy-section-and-money.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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

/** The strategies view, sliced by its own bounds rather than a line count. */
function strategiesView() {
  const at = appJs.indexOf("  strategies() {");
  if (at === -1) throw new Error("the strategies view is gone");
  const end = appJs.indexOf("\n  execution() {", at);
  if (end === -1) throw new Error("cannot find the end of the strategies view");
  return appJs.slice(at, end);
}

// ── 1. the broken-file card ───────────────────────────────────────────
check("the strategies view still shows the broken-file card", () => {
  const view = strategiesView();
  if (!view.includes("strategyFaultCards()")) throw new Error("the fault card is not rendered");
  if (view.indexOf("strategyFaultCards()") > view.indexOf("strategyUploadCard()")) {
    throw new Error("the fault card belongs above the uploader");
  }
});

check("the card prints the engine's exact message, not a summary", () => {
  const fn = body("strategyFaultCards");
  if (!/esc\(r\.error/.test(fn)) throw new Error("the error text is not shown verbatim");
  if (!/esc\(r\.file/.test(fn)) throw new Error("the file is not named");
});

// ── 2. the editor behind a button ─────────────────────────────────────
check("the uploader has a View code button", () => {
  const fn = body("strategyUploadCard");
  if (!fn.includes('id="st-code-btn"')) throw new Error("no button");
  if (!fn.includes("strategies.view_code")) throw new Error("the button has no translated label");
  if (!/aria-controls="st-code-wrap"/.test(fn)) throw new Error("the button is not wired to the panel");
});

check("the editor ships closed", () => {
  const fn = body("strategyUploadCard");
  if (!/id="st-code-wrap" hidden/.test(fn)) {
    throw new Error("the code box is open by default again");
  }
});

check("one function owns the open state", () => {
  const fn = body("setStrategyCodeOpen");
  for (const bit of ["wrap.hidden", "aria-expanded", "strategies.hide_code"]) {
    if (!fn.includes(bit)) throw new Error("setStrategyCodeOpen does not set " + bit);
  }
  // The label, the aria state and the panel cannot disagree as long as
  // exactly one place writes the panel's hidden attribute. Counted on
  // the WRITE, not on mentions of the id: reading it back
  // (strategyCodeIsOpen) is fine and is how the toggle knows which way
  // to go.
  // (Counted on $("st-code-wrap") lookups that are then written to, so
  // an unrelated `wrap` elsewhere in app.js does not count.)
  const lookups = appJs.split('$("st-code-wrap")').length - 1;
  if (lookups !== 2) {
    throw new Error(`${lookups} places reach for the panel, expected 2 (the setter and the reader)`);
  }
});

check("it opens itself when there is something to look at", () => {
  if (!/setStrategyCodeOpen\(true\)/.test(body("takeStrategyFile"))) {
    throw new Error("a dropped file stays hidden behind the button");
  }
  if (!/setStrategyCodeOpen\(true\)/.test(body("restoreStrategyEditor"))) {
    throw new Error("editing an existing strategy does not open the editor");
  }
});

check("the button is bound", () => {
  const fn = body("bindStrategyUpload");
  if (!/st-code-btn/.test(fn)) throw new Error("nothing binds the button");
  if (!/setStrategyCodeOpen\(!strategyCodeIsOpen\(\)\)/.test(fn)) {
    throw new Error("the button does not toggle");
  }
});

check("an open editor is a real editor, not a porthole", () => {
  const at = appCss.indexOf(".st-src{");
  if (at === -1) throw new Error("the editor has no style");
  const rule = appCss.slice(at, appCss.indexOf("}", at));
  if (/min-height:\s*1?[0-9]{1,2}px/.test(rule)) {
    throw new Error("the editor is back to a fixed few lines: " + rule);
  }
  if (!/min-height:\s*min\(/.test(rule)) throw new Error("no viewport-relative height");
  if (!/mono/.test(rule)) throw new Error("code is not in a monospaced face");
});

// ── 3. the live banner is gone ────────────────────────────────────────
check("the live status banner has been removed, not hidden", () => {
  const view = strategiesView();
  if (view.includes("st-live-sig")) throw new Error("the last-signal pill is still there");
  if (view.includes("auto-banner")) throw new Error("the banner markup is still there");
  if (appJs.includes('$("st-live-sig")')) throw new Error("the patcher still paints a pill that cannot exist");
});

check("the strategy cards themselves are untouched", () => {
  const view = strategiesView();
  if (!view.includes("strategyLiveCards()")) throw new Error("the cards went with the banner");
  if (!view.includes('id="st-live-grid"')) throw new Error("the grid the patcher keys off is gone");
});

// ── 4. automatic money management ─────────────────────────────────────
check("the money card offers both modes", () => {
  if (!appJs.includes('id="money-mode-tabs"')) throw new Error("no mode switch");
  for (const key of ["money.mode_fixed", "money.mode_auto"]) {
    if (!appJs.includes(key)) throw new Error("missing label " + key);
  }
});

check("automatic mode asks for a percentage, bounded like the engine's", () => {
  if (!appJs.includes('id="st-money-pct"')) throw new Error("no percentage field");
  const at = appJs.indexOf('id="st-money-pct"');
  const tag = appJs.slice(at, appJs.indexOf("/>", at));
  if (!/min="0.05"/.test(tag) || !/max="10"/.test(tag)) {
    throw new Error("the field's bounds do not match AUTO_RISK_MIN_PCT/MAX_PCT: " + tag);
  }
});

check("saving sends the mode, and the percentage only in automatic mode", () => {
  const at = appJs.indexOf('const moneySave = $("st-money-save")');
  if (at === -1) throw new Error("the save handler is gone");
  const fn = appJs.slice(at, at + 1400);
  if (!/mode:\s*auto \? "auto" : "fixed"/.test(fn)) throw new Error("the mode is not sent");
  if (!/risk_pct:/.test(fn)) throw new Error("the percentage is not sent");
});

check("the preview does the same arithmetic as the engine", () => {
  const fn = body("liveMoney");
  if (!/equity \* live/.test(fn)) {
    throw new Error("the preview does not price the percentage against equity");
  }
  if (!/scope: "trade"/.test(fn)) {
    throw new Error("the preview lets the automatic cap be read per lot");
  }
});

check("the sentence under the field covers all three states", () => {
  const fn = body("moneyAutoNote");
  for (const key of ["money.auto_held", "money.auto_no_equity", "money.auto_now", "money.auto_prop"]) {
    if (!fn.includes(key)) throw new Error("missing " + key);
  }
});

check("the note says the automatic rule is never silently off", () => {
  const en = langs.en.money;
  if (!/not off/i.test(en.auto_held)) {
    throw new Error("auto_held does not say the rule is still being applied");
  }
  if (!/no zero|never|always on/i.test(en.auto_always_on)) {
    throw new Error("auto_always_on does not explain how to turn the rule off");
  }
});

check("every new string exists in all three packs", () => {
  const want = {
    money: ["mode_fixed", "mode_auto", "risk_pct", "pct_of_equity", "auto_now",
      "auto_prop", "auto_held", "auto_no_equity", "auto_always_on", "saved_auto"],
    strategies: ["view_code", "hide_code", "code_lines"],
  };
  for (const [lang, pack] of Object.entries(langs)) {
    for (const [group, keys] of Object.entries(want)) {
      for (const key of keys) {
        if (!pack[group] || !pack[group][key]) throw new Error(`${lang} is missing ${group}.${key}`);
      }
    }
  }
});

// ── the view still parses and balances ────────────────────────────────
check("the strategies view is balanced markup", () => {
  const view = strategiesView();
  const opens = (view.match(/<div/g) || []).length;
  const closes = (view.match(/<\/div>/g) || []).length;
  if (opens !== closes) throw new Error(`${opens} <div> vs ${closes} </div>`);
});

check("the money card is balanced markup", () => {
  const at = appJs.indexOf('<div class="card" id="set-money">');
  if (at === -1) throw new Error("the money card is gone");
  const end = appJs.indexOf('id="st-money-off-note"', at);
  const card = appJs.slice(at, appJs.indexOf("</div>", end) + 6);
  const opens = (card.match(/<div/g) || []).length;
  const closes = (card.match(/<\/div>/g) || []).length;
  if (opens !== closes) throw new Error(`${opens} <div> vs ${closes} </div>`);
  return opens + " divs";
});

check("app.js still parses", () => {
  new vm.Script(appJs, { filename: "app.js" });
});

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exitCode = fails ? 1 : 0;
