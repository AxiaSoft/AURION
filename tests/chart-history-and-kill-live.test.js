/**
 * Four follow-up faults, pinned.
 *
 *   A. the desk sat on the start-up video, because six months of bars
 *      were pulled for every attached chart before anything was drawn;
 *   B. six months were held and a day and a half was shown, so "I still
 *      cannot see six months" was true even when the bars were there;
 *   C. arming the kill switch while the intelligence page was open did
 *      nothing until the page was left and re-entered;
 *   D. the calendar's own backtest offer was withdrawn (its removal is
 *      pinned in tests/calendar-backtest-and-kill.test.js).
 *
 *     node tests/chart-history-and-kill-live.test.js
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
const chartsJs = read("apps/web/js/charts.js");
const toolsJs = read("apps/web/js/chart-tools.js");
const bridgePy = read("engine/aurion/mt5/bridge.py");
const serverPy = read("engine/aurion/api/server.py");
const traderPy = read("engine/aurion/runtime/trader.py");
const historyPy = read("engine/aurion/util/history.py");
const langs = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

/** A function body by name, braces balanced. */
function body(src, name) {
  let at = src.indexOf(`function ${name}(`);
  if (at === -1) at = src.indexOf(`${name}(`);
  if (at === -1) throw new Error(`${name} is missing`);
  const from = src.indexOf("{", at);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`cannot find the end of ${name}`);
}
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── A. the start-up load ──────────────────────────────────────────── */

check("the promise and the first fetch are two different numbers", () => {
  if (!/const HISTORY_DAYS = 180;/.test(appJs)) throw new Error("the promise moved or shrank");
  const open = /const CHART_OPEN_DAYS = (\d+);/.exec(appJs);
  if (!open) throw new Error("nothing says how much a chart opens with");
  if (Number(open[1]) >= 180) throw new Error("a chart still opens on the whole window: " + open[1]);
  const prime = /const CHART_PRIME_BARS = (\d+);/.exec(appJs);
  if (!prime) throw new Error("the background prime has no budget of its own");
  if (Number(prime[1]) > 2000) throw new Error("the prime is not a prime: " + prime[1]);
  return `open ${open[1]}d, prime ${prime[1]} bars`;
});

check("the fetch that runs before any chart exists asks for the prime, not the window", () => {
  const fn = code(body(appJs, "pickMarket"));
  if (!/prime\s*\?\s*CHART_PRIME_BARS/.test(fn)) {
    throw new Error("pickMarket does not distinguish a background fill from a chart");
  }
  if (/count=\$\{barsForDays\(timeframe, HISTORY_DAYS\)\}/.test(fn)) {
    throw new Error("it still pulls the whole promise on every call");
  }
  const prime = code(body(appJs, "primeEaChart"));
  if (!/\{ prime: true \}/.test(prime)) throw new Error("the socket's hello still primes at full size");
});

check("no path asks for six months before the trader does", () => {
  /* The one legitimate exception is the explicit range. Everything else
     that asked for HISTORY_DAYS at load time is what made the desk
     appear frozen behind the start-up video. */
  const offenders = [];
  const re = /barsForDays\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(code(appJs)))) {
    if (/HISTORY_DAYS/.test(m[1])) offenders.push(m[0]);
  }
  /* Two are allowed, and both are the trader asking.
     - the backtest's own chart, drawn after a run they started over
       the period they picked;
     - the drag at the oldest bar, which is the ONLY gesture left for
       "show me further back" and must fetch the whole promise rather
       than a slice of it. See loadMoreHistory. */
  const allowed = offenders.filter((o) => o.includes("bt.timeframe") || o.includes("f.timeframe"));
  if (offenders.length !== allowed.length) {
    throw new Error("still fetching the whole window up front: " + offenders.filter((o) => !allowed.includes(o)).join(", "));
  }
  return offenders.length + " remaining, all post-backtest";
});

check("the marks are analysed over the bars we hold, not over six months", () => {
  const fn = code(body(appJs, "fetchChartSignals"));
  if (/count=\$\{barsForDays\(timeframe, HISTORY_DAYS\)\}/.test(fn)) {
    throw new Error("every chart that opens still replays every strategy over the full window");
  }
  if (!/S\.candles \|\| \[\]\)\.length/.test(fn)) throw new Error("it does not look at how many bars are held");
});

/* ── the engine has to believe a smaller number ─────────────────────── */

check("the engine can tell a caller that asked from one that did not", () => {
  if (!/def requested_window\(/.test(historyPy)) throw new Error("there is no exact-request helper");
  if (!/def at_least_window\(/.test(historyPy)) throw new Error("the floor helper is gone");
  const fn = historyPy.slice(historyPy.indexOf("def requested_window("));
  if (!/if want <= 0:\s*\n\s*return bars_for_days\(timeframe\)/.test(fn)) {
    throw new Error("a caller that does not ask must still get the promise");
  }
});

check("the desk's candle endpoint honours the window the desk asked for", () => {
  const fn = serverPy.slice(serverPy.indexOf('@app.get("/v1/candles")'), serverPy.indexOf('@app.get("/v1/agents")'));
  if (!/exact=True/.test(fn)) throw new Error("the floor still turns one month into six: " + fn.trim());
});

check("the internal callers keep the floor they always had", () => {
  for (const [name, src] of [["trader.py", traderPy], ["bridge.py", bridgePy]]) {
    if (!/at_least_window\(/.test(src)) throw new Error(name + " no longer enforces the promise anywhere");
  }
  /* store.py backs every "give me this series" read inside the engine
     and must never be exact: a strategy asking for bars is not a window
     on a screen. */
  if (/exact/.test(read("engine/aurion/runtime/store.py"))) {
    throw new Error("the store learned to under-serve, which is how the window silently shrinks");
  }
});

check("an exact count is not raised again on its way to the expert", () => {
  const send = bridgePy.slice(bridgePy.indexOf("async def _request_ea_history"), bridgePy.indexOf("async def pull_candles"));
  if (/at_least_window\(tf, count\)/.test(send)) {
    throw new Error("the depth is re-floored at the point of sending, so exact requests leak back to six months");
  }
});

/* ── B. seeing the period, not just holding it ──────────────────────── */

check("the chart can be told to show a period, not only to fit", () => {
  if (!/\n  showSpan\(bars\) \{/.test(chartsJs)) throw new Error("there is no way to set the window in bars");
  const fn = body(chartsJs, "showSpan");
  if (!/Math\.min\(total, want\)/.test(fn)) throw new Error("asking for more bars than exist must not break");
  if (!/this\.offset = 0/.test(fn)) throw new Error("the window has to start at the live edge");
  /* fit() is capped at 160 bars on purpose; showSpan exists precisely
     because a range button is the opposite request. */
  if (/Math\.min\(160/.test(fn)) throw new Error("showSpan inherited fit()'s cap and cannot show a month");
});

check("the period strip is gone, and stays gone", () => {
  /* Asked for directly: "I only want to move by dragging on the
     screen". The strip set the window to a fixed span, so every drag
     into the past was one press away from being thrown back to the
     live edge - and because it was also the only thing that FETCHED
     more history, dragging alone never reached the older months.
     Deleted rather than hidden, on the same instruction. */
  if (/const RANGES = \[/.test(toolsJs)) throw new Error("the range table is back");
  if (/data-range=/.test(toolsJs)) throw new Error("the range buttons are back in the header");
  if (/ctx\.onRange/.test(toolsJs)) throw new Error("the header still calls a range handler");
  if (/tv-range/.test(toolsJs)) throw new Error("the strip is still being laid out");
  if (/rangeDays/.test(appJs)) throw new Error("the desk still hands the header a period to mark");
  if (/function applyChartRange/.test(appJs)) throw new Error("the handler outlived its buttons");
  if (/function paintChartRange/.test(appJs)) throw new Error("something is still painting a strip that is not there");
});

check("dragging is the whole of 'show me further back'", () => {
  /* With the strip gone, maybeLoadMoreHistory is the only thing left
     that can widen the series. If it stops asking, the past months are
     unreachable by any means at all. */
  const fn = code(body(appJs, "maybeLoadMoreHistory"));
  if (!/loadMoreHistory\(\)/.test(fn)) throw new Error("reaching the oldest bar no longer fetches more");
  const load = code(body(appJs, "loadMoreHistory"));
  if (!/count=\$\{want\}/.test(load)) throw new Error("the widening request stopped carrying its size");
  /* Doubling, which is what this used to require, made six months
     unreachable in practice: a chart opens on thirty days, each drag
     asked for twice what it held, and the cool-off between tries sat
     in the middle of it. Four or five successful drags to reach the
     promise, and the trader reported seeing one month. One drag now
     asks for the whole 180 days. */
  if (/Math\.max\(have \* 2/.test(load)) throw new Error("it still only doubles, so the promise takes five drags");
  if (!/barsForDays\(f\.timeframe, HISTORY_DAYS\)/.test(load)) {
    throw new Error("it no longer widens the window it asks for");
  }
});

check("one short answer does not end history forever", () => {
  /* _histDone used to be a permanent verdict per series. The expert
     streams its history in chunks, so a request answered mid-stream
     comes back short through no fault of the broker - and the desk
     then never asked again, which is "the past months are still not
     shown" surviving every fix made underneath it. */
  const fn = code(body(appJs, "loadMoreHistory"));
  if (!/HIST_RETRY_MS/.test(fn)) throw new Error("a short reply is believed forever again");
  if (!/S\._histDone = null;/.test(fn)) throw new Error("a good reply does not clear the verdict");
  if (!/if \(asked && have >= asked\) return;/.test(fn)) {
    throw new Error("the same window is refetched on every drag");
  }
});

check("a chart opens on one known period", () => {
  /* chartDays() survives the strip because a dozen callers ask "how
     much does a chart open with". It must answer, and answer the same
     thing every time - a remembered choice from a control that no
     longer exists is a setting nobody can change. */
  const fn = code(body(appJs, "chartDays"));
  if (/localStorage/.test(fn)) throw new Error("it still reads a choice that cannot be made");
  if (!/return CHART_OPEN_DAYS;/.test(fn)) throw new Error("chartDays no longer answers with the opening period");
});

/* ── C. the kill switch, on the press ───────────────────────────────── */

check("one function owns what happens when the switch moves", () => {
  const fn = code(body(appJs, "noteKillSwitch"));
  if (!/S\._killState/.test(fn)) throw new Error("it does not remember the previous value, so it cannot detect a change");
  if (!/if \(was === undefined \|\| was === now\) return;/.test(fn)) {
    throw new Error("calling it with no change would rebuild the page");
  }
  if (!/S\.view === "intelligence"/.test(fn)) throw new Error("it does not rebuild the page the switch invalidates");
  if (!/show\("intelligence"/.test(fn)) throw new Error("nothing is re-rendered");
});

check("every path that can move the switch goes through it", () => {
  const live = code(appJs);
  const poll = /S\.snap = r\.data;\s*\n\s*noteKillSwitch\(S\.snap\.kill_switch\);/.test(live);
  if (!poll) throw new Error("the snapshot poll does not report the change");
  if (!/if \("kill_switch" in d\) noteKillSwitch\(d\.kill_switch\);/.test(live)) {
    throw new Error("the live socket's status frame does not report it");
  }
  const btn = live.slice(live.indexOf('$("btn-kill").onclick'), live.indexOf('$("btn-kill").onclick') + 700);
  if (!/noteKillSwitch\(armed\)/.test(btn)) throw new Error("the header button waits for the next poll");
  if (btn.indexOf("noteKillSwitch(armed)") > btn.indexOf("await refresh(false)")) {
    throw new Error("the notice appears only after a round trip, which is the reported delay");
  }
});

check("the header button paints from the state it just set", () => {
  const live = code(appJs);
  const btn = live.slice(live.indexOf('$("btn-kill").onclick'), live.indexOf('$("btn-kill").onclick') + 700);
  if (!/S\.snap\.kill_switch = armed/.test(btn)) {
    throw new Error("the snapshot still says the old value when the page is rebuilt");
  }
  if (!/r && r\.ok === false/.test(btn)) {
    throw new Error("a refused request would still redraw the page as though it had worked");
  }
});

check("re-arming brings the notice back after a 'show anyway'", () => {
  const fn = code(body(appJs, "noteKillSwitch"));
  if (!/if \(now\) S\._aiKillSeen = false;/.test(fn)) {
    throw new Error("arming it again is a new decision and must not inherit the old dismissal");
  }
});

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);
