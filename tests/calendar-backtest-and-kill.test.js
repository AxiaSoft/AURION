/**
 * Five reported faults, pinned.
 *
 *   1. the calendar needed scrolling on a desktop, and the reminder
 *      and the legend were a column beside it rather than under it;
 *   2. the calendar's backtest buttons threw ReferenceError and ran
 *      nothing, and the backtest page could only test all of history;
 *   3. an update ended with "the engine is still running the previous
 *      version", curable only by closing the whole product;
 *   4. the charts were asked to show six months, not thirty days;
 *   5. opening the intelligence page while the kill switch is armed
 *      said nothing about it.
 *
 *     node tests/calendar-backtest-and-kill.test.js
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
const calJs = read("apps/web/js/calendar.js");
const supJs = read("backend/src/engine-supervisor.js");
const idxJs = read("backend/src/index.js");
const ea = read("engine/ea/AurionBridge.mq5");
const langs = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

function body(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`${name} is missing`);
  let depth = 0;
  const from = src.indexOf("{", at);
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`cannot find the end of ${name}`);
}

/**
 * Every CSS rule inside EVERY block with this @media prelude.
 *
 * All of them, not the first: app.css legitimately opens the same
 * breakpoint several times (the ladder of .ct-grid overrides is one),
 * and a test that reads only the first block reports a rule as missing
 * while it sits in the second. That produced four false failures the
 * first time this file was run.
 */
function mediaRules(prelude) {
  const needle = "@media " + prelude + "{";
  const out = [];
  let found = 0;
  for (let at = appCss.indexOf(needle); at !== -1; at = appCss.indexOf(needle, at + 1)) {
    found++;
    let depth = 0;
    const from = appCss.indexOf("{", at);
    let end = -1;
    for (let i = from; i < appCss.length; i++) {
      if (appCss[i] === "{") depth++;
      else if (appCss[i] === "}" && --depth === 0) { end = i; break; }
    }
    const inner = appCss.slice(from + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(inner))) out.push([m[1].trim(), m[2].trim()]);
  }
  if (!found) throw new Error(`no @media ${prelude}`);
  return out;
}

/** Source with comments removed - for asserting on what RUNS. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 2. the ReferenceError ─────────────────────────────────────────────
check("startBacktest navigates with a function that exists", () => {
  const fn = code(body(appJs, "startBacktest"));
  if (/\bgo\(/.test(fn)) throw new Error("go() is back; there is no such helper on this desk");
  if (!/show\("backtest"\)/.test(fn)) throw new Error("it no longer moves to the backtest page");
});

check("the navigation happens before the request is sent, so a throw there kills the run", () => {
  const fn = body(appJs, "startBacktest");
  const nav = fn.indexOf('show("backtest")');
  const post = fn.indexOf('API.post("/api/backtest"');
  if (nav === -1 || post === -1) throw new Error("cannot find both halves");
  if (nav > post) return "navigation now follows the POST";
  return "still above the POST - which is why it must not throw";
});

check("the call checker resolves names by scope, not by 'exists somewhere'", () => {
  const src = read("apps/web/js/check-calls.mjs");
  if (/const declared = new Set\(\)/.test(src)) {
    throw new Error("still one flat set of every binding in the file");
  }
  if (!/parent/.test(src) || !/function resolves\(/.test(src)) {
    throw new Error("no scope chain");
  }
});

// ── 2b. the period picker ─────────────────────────────────────────────
check("the backtest page can test a period, not only all of history", () => {
  if (!appJs.includes("backtestPeriodHtml()")) throw new Error("the picker is not rendered");
  const card = appJs.slice(appJs.indexOf('id="bt-card"'), appJs.indexOf('id="bt-extra-card"'));
  if (!card.includes("backtestPeriodHtml()")) throw new Error("it is not on the backtest card");
  if (card.indexOf("backtestPeriodHtml()") > card.indexOf('id="h-bt"')) {
    throw new Error("the period is chosen after the run button, which reads backwards");
  }
});

check("it offers the same spans the calendar does, plus explicit dates", () => {
  const m = appJs.match(/const BT_SPANS = \[([^\]]+)\]/);
  if (!m) throw new Error("BT_SPANS is gone");
  for (const want of ["all", "today", "week", "month", "custom"]) {
    if (!m[1].includes(`"${want}"`)) throw new Error("missing span " + want);
  }
});

check("no span can ask for bars that do not exist yet", () => {
  const fn = body(appJs, "btRange");
  if (!/clamp\(/.test(fn)) throw new Error("end bounds are not trimmed to today");
  const uses = (fn.match(/clamp\(at\(/g) || []).length;
  if (uses < 3) throw new Error(`only ${uses} bounds are clamped`);
  return uses + " clamped bounds";
});

check("the week runs Monday to Sunday, with Sunday pulled back six days", () => {
  const fn = body(appJs, "btRange");
  if (!/dow === 0 \? 6 : dow - 1/.test(fn)) {
    throw new Error("the Sunday off-by-one is back: every Sunday would test the week after itself");
  }
});

check("dates are built in local time, not from toISOString", () => {
  const fn = body(appJs, "btDayKey");
  if (/toISOString/.test(fn)) {
    throw new Error("toISOString is UTC - east of Greenwich after midnight it hands back yesterday");
  }
  if (!/getFullYear|getMonth|getDate/.test(fn)) throw new Error("not reading local parts");
});

check("the run refuses an impossible range instead of asking the engine", () => {
  const at = appJs.indexOf('const goBt = $("h-bt")');
  const fn = appJs.slice(at, at + 1800);
  if (!/period_pick/.test(fn) || !/period_backwards/.test(fn)) {
    throw new Error("a half-filled or reversed range is still sent");
  }
});

check("a run launched from the calendar shows its period on the page", () => {
  const fn = body(appJs, "startBacktest");
  if (!/S\._btSpan = "custom"/.test(fn)) {
    throw new Error("the page would say 'all history' beside a one-week result");
  }
});

check("the calendar still launches runs through the one shared entry point", () => {
  if (!calJs.includes("window.startBacktest")) throw new Error("the calendar lost its route in");
  if (!/run\(\{ symbol: this\.btSymbol\(\)/.test(calJs)) throw new Error("it no longer passes a symbol");
});

// ── 1. the calendar fits a desktop screen ─────────────────────────────
check("there is a desktop rule at all", () => {
  mediaRules("(min-width:1101px)");
});

check("the month grid is not seven squares on a desktop", () => {
  const cell = mediaRules("(min-width:1101px)").find(([sel]) => sel === ".cal-cell");
  if (!cell) throw new Error(".cal-cell is untouched: six rows of squares cannot fit a landscape screen");
  if (!/aspect-ratio:\s*auto/.test(cell[1])) throw new Error("aspect-ratio is still 1/1: " + cell[1]);
});

check("the reminder and the legend sit under the month, not beside it", () => {
  const rules = mediaRules("(min-width:1101px)");
  const main = rules.find(([sel]) => sel === ".cal-main");
  if (!main) throw new Error(".cal-main still has the 330px side column at desktop width");
  if (!/grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(main[1])) {
    throw new Error("still two columns: " + main[1]);
  }
  const aside = rules.find(([sel]) => sel === ".cal-aside");
  if (!aside || !/flex-direction:\s*row/.test(aside[1])) {
    throw new Error("the three cards are not a row under the month");
  }
});

check("the height comes from the stage, so nothing has to be scrolled", () => {
  const rules = mediaRules("(min-width:1101px)");
  const root = rules.find(([sel]) => sel === "#cal-root");
  if (!root || !/block-size:\s*100%/.test(root[1])) {
    throw new Error("the view does not fill the stage, so the rows have no height to divide up");
  }
  const main = rules.find(([sel]) => sel === ".cal-main");
  if (!/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/.test(main[1])) {
    throw new Error("the month does not take the leftover height: " + main[1]);
  }
});

check("#desk is still the 100dvh grid that height depends on", () => {
  const at = appCss.indexOf("#desk{");
  const rule = appCss.slice(at, appCss.indexOf("}", at));
  if (!/height:\s*100dvh/.test(rule)) throw new Error("the stage no longer has a definite height");
  if (!/grid-template-rows:auto minmax\(0,1fr\)/.test(rule.replace(/\s+/g, " "))) {
    throw new Error("the stage row is not the one that absorbs the leftover height");
  }
});

check("a short laptop gets a floor rather than unreadable rows", () => {
  const rules = mediaRules("(min-width:1101px)");
  const pane = rules.filter(([sel]) => sel === ".cal-pane").map(([, d]) => d).join(";");
  if (!/min-block-size:\s*\d+px/.test(pane)) throw new Error("no minimum height on the month");
});

check("the phone layout is left alone", () => {
  const narrow = mediaRules("(max-width:1100px)");
  if (!narrow.some(([sel]) => sel === ".cal-main")) throw new Error("the stacked narrow rule is gone");
});

// ── 5. the kill switch on the intelligence page ───────────────────────
check("the intelligence page checks the kill switch before anything else", () => {
  const at = appJs.indexOf("  intelligence() {");
  if (at === -1) throw new Error("the view is gone");
  const head = appJs.slice(at, at + 400);
  if (!/aiKillBlocked\(\)/.test(head)) throw new Error("nothing is checked");
  if (!/return `<div class="cmd ai-page">\$\{aiKillBlockHtml\(\)\}<\/div>`/.test(head)) {
    throw new Error("the page is drawn behind the notice rather than replaced by it");
  }
});

check("the notice offers a way out of the state it describes", () => {
  const html = body(appJs, "aiKillBlockHtml");
  if (!html.includes("ai.kill_title")) throw new Error("it does not say what is wrong");
  if (!html.includes('id="ai-kill-off"')) throw new Error("no way to turn the kill switch off");
  if (!html.includes('role="alert"')) throw new Error("a screen reader is not told");
});

check("turning it off goes through the one endpoint the header uses", () => {
  const fn = body(appJs, "bindAiKillBlock");
  if (!/API\.post\("\/api\/kill", \{ armed: false \}\)/.test(fn)) {
    throw new Error("a second way of disarming the kill switch is a second thing to get wrong");
  }
  if (!/refresh\(/.test(fn)) throw new Error("the page would keep showing the old state");
});

check("nobody is trapped behind it", () => {
  const html = body(appJs, "aiKillBlockHtml");
  if (!html.includes('id="ai-kill-anyway"')) throw new Error("no way to read the page anyway");
  const fn = body(appJs, "aiKillBlocked");
  if (!/S\._aiKillSeen = false/.test(fn)) {
    throw new Error("re-arming the switch would not bring the notice back");
  }
});

check("the rest of the page is not bound when it was not rendered", () => {
  const at = appJs.indexOf('if (view === "intelligence" && aiKillBlocked())');
  if (at === -1) throw new Error("bindView still binds elements that do not exist");
  if (!appJs.slice(at, at + 200).includes("bindAiKillBlock()")) throw new Error("the notice is not bound");
});

check("bindView's shared tail still runs in that case", () => {
  const fn = body(appJs, "bindView");
  const branch = fn.indexOf('if (view === "intelligence" && aiKillBlocked())');
  const tail = fn.indexOf('bindUpgradeLinks($("stage"))');
  if (tail === -1) throw new Error("the shared tail is gone");
  const between = fn.slice(branch, tail);
  if (/\n  if \(view === "intelligence" && aiKillBlocked\(\)\) \{\n    bindAiKillBlock\(\);\n    return;/.test(between)) {
    throw new Error("an early return skips bindUpgradeLinks for the whole desk");
  }
});

check("the notice centres itself in the stage", () => {
  const at = appCss.indexOf(".ai-blocked{");
  if (at === -1) throw new Error("no style for the notice");
  const rule = appCss.slice(at, appCss.indexOf("}", at));
  if (!/place-items:\s*center/.test(rule)) throw new Error("not centred");
  if (!/min-block-size:\s*100%/.test(rule)) throw new Error("not full height, so 'centred' is not mid-screen");
});

// ── 3. the stale engine after an update ───────────────────────────────
check("the backend can replace the engine without restarting the desk", () => {
  if (!/function replaceEngine\(/.test(supJs)) throw new Error("no replaceEngine");
  if (!/module\.exports = \{[^}]*replaceEngine/.test(supJs)) throw new Error("not exported");
});

check("it asks the engine to persist before stopping it", () => {
  const fn = code(body(supJs, "replaceEngine"));
  const persist = fn.indexOf("/v1/persist");
  const shutdown = fn.indexOf("/v1/shutdown");
  if (persist === -1) throw new Error("settings would be lost");
  if (shutdown === -1 || shutdown < persist) throw new Error("it stops before it saves");
});

check("it never starts a second engine on top of a survivor", () => {
  const fn = body(supJs, "replaceEngine");
  const guard = fn.indexOf("if (!gone)");
  const start = fn.lastIndexOf("startEngine()");
  if (guard === -1) throw new Error("nothing checks that the old process went away");
  if (start < guard) throw new Error("it starts one before deciding the old one is gone");
  if (!/engine_would_not_stop/.test(fn)) throw new Error("a failure to stop is not reported");
});

check("the forced stop targets the engine's ports only", () => {
  const fn = body(supJs, "replaceEngine");
  if (!/"-Ports", String\(port\)/.test(fn)) throw new Error("the port list is not the engine's");
  if (/8080/.test(fn)) throw new Error("the desk's own port is in the kill list: it would kill itself");
});

check("the route is owner-only", () => {
  const at = idxJs.indexOf('guarded.post("/system/engine/replace"');
  if (at === -1) throw new Error("no route");
  if (!/owner_only/.test(idxJs.slice(at, at + 400))) throw new Error("anyone could stop the engine");
});

check("an update heals this by itself before calling it an error", () => {
  const fn = body(appJs, "finishUpdateRestart");
  const auto = fn.indexOf("replaceEngineInPlace()");
  /* The LAST one: there is an earlier mark("wait","failed") for the
     engine that never came back at all, which is a different ending. */
  const err = fn.lastIndexOf('mark("wait", "failed")');
  if (auto === -1) throw new Error("the update still gives up and tells the user to restart everything");
  if (auto > err) throw new Error("it reports the stale engine before trying the fix");
  if (!/verdict\.stale && !verdict\.differentTree/.test(fn)) {
    throw new Error("it would also retry a second installation's engine, which it can never fix");
  }
});

check("the automatic attempt re-checks rather than assuming", () => {
  const fn = body(appJs, "finishUpdateRestart");
  if (!/if \(swapped\) verdict = await verifyEngineBuild\(\)/.test(fn)) {
    throw new Error("success is assumed from the swap, not measured");
  }
});

check("replacing waits for the engine itself, not just the desk's server", () => {
  const fn = body(appJs, "replaceEngineInPlace");
  if (!/waitForEngineHealth/.test(fn)) throw new Error("it returns before the engine can answer");
  const wait = body(appJs, "waitForEngineHealth");
  if (!/data\.build && data\.build\.online === true/.test(wait)) {
    throw new Error("it reads the desk's health, which is up throughout - that is the whole trap");
  }
});

check("the settings panel offers the same cure days later", () => {
  if (!appJs.includes('id="upd-swap"')) throw new Error("no button in the update panel");
  if (!/swapRow\.hidden = !\(verdict\.stale && !verdict\.differentTree\)/.test(appJs)) {
    throw new Error("it is offered where it cannot work, which is the original support loop");
  }
});

// ── 4. six months, everywhere ─────────────────────────────────────────
check("the engine's window is 180 days", () => {
  const hist = read("engine/aurion/util/history.py");
  if (!/HISTORY_DAYS = 180/.test(hist)) throw new Error("not 180");
  if (!/MAX_BARS = 300_000/.test(hist)) throw new Error("the ceiling would truncate 259 200 M1 bars");
});

check("the desk asks for the same number", () => {
  if (!/const HISTORY_DAYS = 180/.test(appJs)) throw new Error("the desk and the engine disagree");
});

check("the helper is no longer named after a window it does not enforce", () => {
  const hist = read("engine/aurion/util/history.py");
  if (!/def at_least_window\(/.test(hist)) throw new Error("at_least_window is missing");
  for (const f of ["engine/aurion/api/server.py", "engine/aurion/mt5/bridge.py",
    "engine/aurion/runtime/store.py", "engine/aurion/runtime/trader.py"]) {
    if (/at_least_30_days/.test(read(f))) throw new Error(f + " still calls the old name");
  }
});

check("the EA imposes no window of its own", () => {
  if (/thirty days/i.test(ea)) throw new Error("the expert still describes a thirty-day window");
  if (!/#define AURION_HIST_MAX 300000/.test(ea)) throw new Error("the ceiling changed");
  if (!/g_hist_want > 0 \? g_hist_want : InpCandleDepth/.test(ea)) {
    throw new Error("the expert no longer honours the depth the engine asks for");
  }
});

check("the EA version did not move for a comment", () => {
  if (!/#define AURION_EA_VERSION "1\.19"/.test(ea)) {
    throw new Error("the version changed, which costs every user a recompile they do not need");
  }
});

// ── strings ───────────────────────────────────────────────────────────
check("every new string exists in all three packs", () => {
  const want = {
    bt: ["period", "span_all", "span_today", "span_week", "span_month", "span_prev_month",
      "span_q", "span_custom", "from", "to", "period_all", "period_from_to", "period_pick",
      "period_backwards"],
    ai: ["kill_title", "kill_body", "kill_off", "kill_anyway"],
    upd: ["engine_replacing", "engine_replace_btn", "engine_replace_ok", "engine_replace_failed"],
  };
  for (const [lang, pack] of Object.entries(langs)) {
    for (const [group, keys] of Object.entries(want)) {
      for (const key of keys) {
        if (!pack[group] || !pack[group][key]) throw new Error(`${lang} is missing ${group}.${key}`);
      }
    }
  }
});

check("the period sentence names both ends", () => {
  for (const [lang, pack] of Object.entries(langs)) {
    const s = pack.bt.period_from_to;
    if (!s.includes("{from}") || !s.includes("{to}")) throw new Error(lang + " drops a placeholder");
  }
});

check("no new string names an instrument or a side", () => {
  const words = /\b(EURUSD|XAUUSD|GBPUSD|gold|buy|sell)\b/i;
  for (const [lang, pack] of Object.entries(langs)) {
    for (const key of ["kill_title", "kill_body", "kill_off", "kill_anyway"]) {
      if (words.test(pack.ai[key])) throw new Error(`${lang} ai.${key} names an instrument or a side`);
    }
  }
});

// ── it still parses ───────────────────────────────────────────────────
check("app.js parses", () => { new vm.Script(appJs, { filename: "app.js" }); });
check("the supervisor parses", () => { new vm.Script(supJs, { filename: "engine-supervisor.js" }); });

check("the backtest card is balanced markup", () => {
  const card = appJs.slice(appJs.indexOf('<div class="card" id="bt-card">'),
    appJs.indexOf('id="bt-extra-card"'));
  const opens = (card.match(/<div/g) || []).length;
  const closes = (card.match(/<\/div>/g) || []).length;
  if (opens !== closes + 1) throw new Error(`${opens} <div> vs ${closes} </div> in the slice`);
  return opens + " divs";
});

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exitCode = fails ? 1 : 0;
