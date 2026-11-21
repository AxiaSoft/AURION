/**
 * A history request that waits for the download, and a chart that says
 * where its history actually ends.
 *
 * The fault: MetaTrader answers CopyRates with -1 while it is still
 * fetching a series from the broker. That is the NORMAL first answer on
 * a timeframe the chart has never been opened on. PumpHistory() read it
 * as "there is no history", set g_hist_pos = -1 and went silent for
 * good - no retry, no reply, nothing in the log. The engine then waited
 * for an answer that was never coming, timed out, and the desk drew
 * whatever handful of bars it already held. From the outside that is
 * indistinguishable from a broker with no archive, which is why months
 * of "the chart shows very little" could never be pinned down.
 *
 * Two things are checked here. The expert re-asks instead of giving up,
 * and when it finally does give up it SAYS so, carrying how many bars
 * the terminal holds and the date of the oldest one - so the desk can
 * tell a broker's limit from MetaTrader's own "Max bars in chart"
 * setting rather than leaving the trader to guess.
 *
 *     node tests/history-not-abandoned.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, ...p.split("/")), "utf8");

const EA = read("engine/ea/AurionBridge.mq5");
const BRIDGE = read("engine/aurion/mt5/bridge.py");
const SERVER = read("engine/aurion/api/server.py");
const APP = read("apps/web/js/app.js");
const PACKS = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("ok   " + name + (typeof note === "string" ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL " + name + "\n       " + e.message);
  }
}

/* The body of one MQL function.
 *
 * Not by brace matching: every one of these functions builds JSON, and
 * JSON is made of braces inside string literals. And not by the first
 * occurrence of the name either - each function is forward-declared at
 * the top of the file, so the first hit is a prototype with no body at
 * all. The definition is the one whose signature is followed by MQL's
 * own two-space `{`, and it ends at the matching two-space `}`. */
function mqlFn(name) {
  const re = new RegExp("^\\w[\\w ]*\\b" + name + "\\([^;]*\\)\\s*\\n  \\{", "m");
  const m = re.exec(EA);
  if (!m) throw new Error(name + " has no definition in the expert");
  const end = EA.indexOf("\n  }", m.index);
  if (end < 0) throw new Error(name + " never closes");
  return EA.slice(m.index, end + 4);
}

/* ── the expert ────────────────────────────────────────────────────── */

check("a 'not yet' from CopyRates is no longer the end of the request", () => {
  const body = mqlFn("PumpHistory");
  const at = body.indexOf("if(n <= 0)");
  if (at < 0) throw new Error("the CopyRates failure branch is gone");
  const branch = body.slice(at, at + 3000);
  if (!/g_hist_tries\+\+/.test(branch)) throw new Error("the attempt is not counted");
  if (!/AURION_HIST_TRIES/.test(branch)) throw new Error("there is no ceiling on the attempts");
  /* Out of patience is not the same as having nothing. The range the
     engine asked for may be more than this broker will serve, and the
     bars the terminal does hold are still what the trader can see on
     their own chart - so they are sent rather than thrown away. */
  if (!/CopyRates\(_Symbol, g_hist_tf, 0, depth, g_hist_rates\)/.test(branch)) {
    throw new Error("a period the broker refuses now returns nothing at all");
  }
  /* The abandon must be reachable ONLY after the ceiling. A bare
     `g_hist_pos = -1; return;` before the retry is the original bug. */
  const giveUp = branch.indexOf("g_hist_pos = -1");
  const retry = branch.indexOf("g_hist_next");
  if (giveUp < 0) throw new Error("the request never ends, even out of patience");
  if (retry < 0 || retry > giveUp) throw new Error("it still abandons the request before trying again");
  return "counted, capped, and retried before it gives up";
});

check("the retry waits, and the wait widens", () => {
  const body = mqlFn("PumpHistory");
  if (!/GetTickCount\(\) < g_hist_next/.test(body)) throw new Error("nothing honours the backoff");
  if (!/250 \* g_hist_tries/.test(body)) throw new Error("the delay does not grow with the attempt");
  if (!/wait > 3000/.test(body)) throw new Error("the delay is unbounded");
  /* A retry that never nudges the terminal can wait for a download
     nobody scheduled. */
  if (!/SeriesInfoInteger\(_Symbol, g_hist_tf, SERIES_BARS_COUNT\)/.test(body)) {
    throw new Error("nothing asks the terminal to build the series");
  }
  return "250ms widening to 3s, and the series is touched each time";
});

check("the attempt ceiling is patient enough to be worth having", () => {
  const m = /#define AURION_HIST_TRIES (\d+)/.exec(EA);
  if (!m) throw new Error("AURION_HIST_TRIES is not defined");
  const tries = Number(m[1]);
  /* Sum of the widening delay: 250ms*n capped at 3s. */
  let ms = 0;
  for (let i = 1; i <= tries; i += 1) ms += Math.min(3000, 250 * i);
  if (ms < 45000) throw new Error("gives up after only " + Math.round(ms / 1000) + "s");
  if (ms > 300000) throw new Error("waits " + Math.round(ms / 1000) + "s, which is a hang");
  return tries + " attempts ≈ " + Math.round(ms / 1000) + "s of patience";
});

check("giving up is said out loud, not by going quiet", () => {
  const body = mqlFn("PumpHistory");
  if (!/SendHistoryShortfall\(/.test(body)) throw new Error("the desk is left waiting for nothing");
  const send = mqlFn("SendHistoryShortfall");
  if (!/\\"final\\":true/.test(send)) throw new Error("the reply does not release the waiting desk");
  if (!/\\"bars\\":\[\]/.test(send)) throw new Error("the reply is not an empty answer");
  if (!/HistoryDepthTag\(/.test(send)) throw new Error("it says nothing about what the terminal holds");
  if (!/Print\(/.test(send)) throw new Error("nothing is written to the terminal's log");
  return "an empty final reply, with the depth facts and a log line";
});

check("the expert reports what the terminal actually holds", () => {
  const body = mqlFn("HistoryDepthTag");
  for (const field of ["requested", "available", "oldest"]) {
    if (!body.includes('\\"' + field + '\\"')) throw new Error(field + " is not reported");
  }
  if (!/SERIES_BARS_COUNT/.test(body)) throw new Error("the bar count is invented rather than asked for");
  if (!/SERIES_FIRSTDATE/.test(body)) throw new Error("the oldest date is invented rather than asked for");
  /* It must ride on the last chunk of a NORMAL stream too, not only on
     the failure - a short-but-successful answer is the common case. */
  const pump = mqlFn("PumpHistory");
  if (!/endd >= g_hist_count[\s\S]{0,900}HistoryDepthTag\(/.test(pump)) {
    throw new Error("a successful short answer carries no depth facts");
  }
  return "requested, available and oldest, on the final chunk";
});

check("the expert version moves, so an un-recompiled copy is visible", () => {
  const wire = /#define AURION_EA_VERSION "([0-9.]+)"/.exec(EA);
  const prop = /#property version\s+"([0-9.]+)"/.exec(EA);
  if (!wire || !prop) throw new Error("the version is unreadable");
  if (wire[1] !== prop[1]) throw new Error("the wire version and #property disagree");
  if (parseFloat(wire[1]) <= 1.19) throw new Error("a protocol change shipped under an old version number");
  return "v" + wire[1] + ", matching in both places";
});

/* ── the engine ────────────────────────────────────────────────────── */

check("the engine remembers the depth and does not forget it", () => {
  if (!/_hist_depth/.test(BRIDGE)) throw new Error("the bridge throws the depth facts away");
  const at = BRIDGE.indexOf("def _note_hist_depth");
  if (at < 0) throw new Error("nothing records what the expert reported");
  const body = BRIDGE.slice(at, BRIDGE.indexOf("\n    def ", at + 10));
  /* Experts before 1.20 send none of these fields. An absent answer
     must not overwrite a known one with zeroes. */
  if (!/if "available" not in message and "oldest" not in message/.test(body)) {
    throw new Error("an old expert's silence would erase what a new one said");
  }
  if (!/def hist_depth\(/.test(BRIDGE)) throw new Error("nothing can read it back");
  return "recorded, and an old expert cannot erase it";
});

check("the depth travels to the desk both ways it can arrive", () => {
  const emits = BRIDGE.match(/await self\.emit\(\s*\n?\s*"candles"/g) || [];
  const withDepth = BRIDGE.match(/"depth": self\.hist_depth\(/g) || [];
  if (withDepth.length < emits.length) {
    throw new Error(`${emits.length} candle broadcasts but only ${withDepth.length} carry the depth`);
  }
  if (!/"depth": trader\.bridge\.hist_depth\(/.test(SERVER)) {
    throw new Error("a desk that reloads rather than listens never learns the depth");
  }
  return emits.length + " broadcasts and the REST reply";
});

/* ── the desk ──────────────────────────────────────────────────────── */

function liftFn(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing from app.js");
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  const open = APP.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < APP.length; i += 1) {
    if (APP[i] === "{") depth += 1;
    else if (APP[i] === "}") { depth -= 1; if (!depth) return APP.slice(at, i + 1); }
  }
  throw new Error(name + " never closes");
}

/* historyEdgeNote is pure given S and I18N, so it is run rather than
   pattern-matched: what matters is WHEN it stays silent. */
function edgeNote({ held, oldest, have, tf = "M15" }) {
  const sandbox = {
    S: {
      chartFocus: { symbol: "XAUUSD", timeframe: tf },
      candles: new Array(have).fill(0),
      histDepth: { ["XAUUSD." + tf]: { available: held, oldest } },
    },
    I18N: {
      locale: () => "en-GB",
      t: (key, vars) => {
        let text = key === "charts.hist_edge"
          ? PACKS.en.charts.hist_edge
          : PACKS.en.charts.hist_edge_fix;
        if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
        return text;
      },
    },
    fmt: (n) => String(n),
    Date,
    isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    liftFn("historyDepthOf") + "\n" + liftFn("histDate") + "\n" + liftFn("historyEdgeNote")
    + "\nthis.out = historyEdgeNote();", sandbox);
  return sandbox.out;
}

check("the desk says nothing while the bars are still arriving", () => {
  /* The terminal holds 20 000 bars and the desk has 3 000 of them. The
     chart ends early because the desk has not asked for the rest, not
     because history ends there - and "this is all there is" is the one
     thing it must never say wrongly. */
  const note = edgeNote({ held: 20000, oldest: "2024-01-02T00:00:00Z", have: 3000 });
  if (note) throw new Error("it claimed the end of history mid-download: " + note);
  return "silent until the desk holds what the terminal holds";
});

check("at the real edge it names the count and the date", () => {
  const note = edgeNote({ held: 7431, oldest: "2025-04-07T00:00:00Z", have: 7431 });
  if (!note) throw new Error("the trader is told nothing at the end of history");
  if (!note.includes("7431")) throw new Error("the bar count is missing");
  if (!/2025/.test(note)) throw new Error("the oldest date is missing");
  if (/Max bars in chart/.test(note)) throw new Error("an odd count was blamed on a setting");
  return note;
});

check("a round count is blamed on the setting that causes it", () => {
  /* 20 000 is not a broker's archive, it is MetaTrader's own default
     for "Max bars in chart". Naming the setting is the difference
     between a dead end and something the trader can go and change. */
  const note = edgeNote({ held: 20000, oldest: "2025-09-01T00:00:00Z", have: 20000 });
  if (!/Max bars in chart/.test(note)) throw new Error("the settings cause is not named");
  return "named, and only for terminal-shaped numbers";
});

check("the sentence exists in all three languages", () => {
  for (const [lang, pack] of Object.entries(PACKS)) {
    for (const key of ["hist_edge", "hist_edge_fix"]) {
      const text = (pack.charts || {})[key];
      if (typeof text !== "string" || !text) throw new Error(`${lang}.charts.${key} is missing`);
    }
    if (lang !== "en" && pack.charts.hist_edge === PACKS.en.charts.hist_edge) {
      throw new Error(lang + " is an English copy");
    }
  }
  for (const token of ["{n}", "{tf}", "{when}"]) {
    for (const [lang, pack] of Object.entries(PACKS)) {
      if (!pack.charts.hist_edge.includes(token)) throw new Error(`${lang} drops ${token}`);
    }
  }
  return "three packs, all three facts kept";
});

check("the note is painted where the trader hits the edge", () => {
  if (!/paintHistoryEdge\(\)/.test(APP)) throw new Error("nothing ever shows the note");
  const pan = liftFn("maybeLoadMoreHistory");
  if (!/paintHistoryEdge\(\)/.test(pan)) throw new Error("panning to the edge does not update it");
  const load = liftFn("loadMoreHistory");
  if (!/paintHistoryEdge\(\)/.test(load)) throw new Error("the reply that proves the edge does not update it");
  if (!/noteHistoryDepth\(/.test(APP)) throw new Error("the depth the engine sends is never recorded");
  return "on the pan and on the reply";
});

const failed = results.filter((x) => !x).length;
console.log("\nhistory-not-abandoned: " + (failed
  ? failed + " FAILED of " + results.length
  : results.length + " checks passed"));
if (failed) process.exitCode = 1;
