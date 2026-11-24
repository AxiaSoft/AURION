/**
 * Four faults and one new behaviour, asserted rather than described.
 *
 *     node tests/candle-merge-and-shutdown.test.cjs
 *
 * 1. "When a new candle arrives the new one is in the right place, but
 *    the candles before it come away from it, get taller, ride upward
 *    and even read at higher prices."
 *
 *    Three causes, all of them the same mistake in different places: a
 *    bar that is re-sent REPLACED the bar already on the chart. The
 *    copies do not agree - a forming bar has a smaller range than the
 *    finished one, a history answer may carry a different open, and an
 *    expert on an M15 chart feeding an H4 desk was re-announcing the
 *    previous H4 bar as freshly closed four times an hour. So: bars are
 *    merged under a bar's own arithmetic (the open never moves, the
 *    high only rises, the low only falls), a live bar for another
 *    timeframe is not accepted at all, the series cache is keyed on a
 *    revision rather than on a length that does not change when a bar
 *    is replaced, and the expert mirrors only the FORMING bar.
 *
 * 2. "In the command centre, when nobody is trading, put a sad face
 *    instead of the dash - not a circle, just eyes and a sad mouth."
 *
 * 3. "Settings, System: the Aurion Bridge version must always be
 *    identified, not 'version unknown'. And when I detach and reattach
 *    the EA in MetaTrader that part does not update until I refresh."
 *
 * 4. "In Settings, Robot, the lot input is not like the other lot
 *    inputs: it has a circle inside it and the inner corners next to
 *    the plus and minus have gone triangular."
 *
 * 5. New: a terminate asks "shut AURION down?" and a kill does it at
 *    once - and either way the engine and the desk really stop.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let passed = 0;
let failed = 0;
const ok = (cond, name) => {
  if (cond) { passed += 1; console.log("ok   " + name); }
  else { failed += 1; console.log("  x  " + name); }
};
const section = (t) => console.log("\n— " + t);

const APP = read("apps", "web", "js", "app.js");
const CHARTS = read("apps", "web", "js", "charts.js");
const EA = read("engine", "ea", "AurionBridge.mq5");
const THEMES = read("apps", "web", "css", "themes.css");
const INDEX = read("backend", "src", "index.js");
const SUP = read("backend", "src", "engine-supervisor.js");
const WINDOW = read("installer", "window", "AppWindow.cs");
const BRIDGE = read("engine", "aurion", "mt5", "bridge.py");

/* ====================================================== 1. the merge == */
section("1. a bar that is re-sent is merged, not swapped in");

const { mergeBar, CandleChart } = require("../apps/web/js/charts.js");

{
  const closed = { time: "2026-11-24T10:00:00", open: 1.10, high: 1.14, low: 1.08, close: 1.12, closed: true };
  /* The same bar as it looked earlier, while it was still forming. */
  const earlier = { time: "2026-11-24T10:00:00", open: 1.10, high: 1.11, low: 1.095, close: 1.105 };
  const merged = mergeBar(closed, earlier);
  ok(merged.high === 1.14, "a narrower re-send cannot shrink the high");
  ok(merged.low === 1.08, "...nor raise the low");
  ok(merged.closed === true, "...nor re-open a bar that has closed");

  const wider = { time: "2026-11-24T10:00:00", open: 1.10, high: 1.19, low: 1.04, close: 1.18 };
  const grown = mergeBar(closed, wider);
  ok(grown.high === 1.19 && grown.low === 1.04, "a genuinely wider re-send still widens the bar");
  ok(grown.close === 1.18, "the close is what a re-send is for");

  const movedOpen = { time: "2026-11-24T10:00:00", open: 1.13, high: 1.14, low: 1.08, close: 1.12 };
  ok(mergeBar(closed, movedOpen).open === 1.10, "the open of a bar already seen never moves again");

  const short = { time: "2026-11-24T10:00:00", o: 1.10, h: 1.20, l: 1.07, c: 1.19 };
  const abbrev = mergeBar(closed, short);
  ok(abbrev.high === 1.20 && abbrev.low === 1.07, "the short field names are read too");
  ok(!("h" in abbrev) && !("l" in abbrev) && !("o" in abbrev) && !("c" in abbrev),
    "...and are not left behind to disagree with the long ones");

  const odd = mergeBar(
    { time: "t", open: 1, high: 1.05, low: 0.99, close: 1.02 },
    { time: "t", open: 1, high: 1.05, low: 0.99, close: 1.40 },
  );
  ok(odd.high >= 1.40, "a close outside the high drags the high with it rather than drawing a wick upside down");
}

{
  /* The chart's own copy, through setLastBar. */
  const chart = Object.create(CandleChart.prototype);
  chart.type = "candles";
  chart.bars = [
    { time: "2026-11-24T09:00:00", open: 1, high: 1.2, low: 0.9, close: 1.1, closed: true },
    { time: "2026-11-24T10:00:00", open: 1.1, high: 1.4, low: 1.05, close: 1.3, closed: true },
  ];
  chart.draw = () => {};
  const before = JSON.parse(JSON.stringify(chart.bars[0]));

  chart.setLastBar({ time: "2026-11-24T10:00:00", open: 1.1, high: 1.15, low: 1.09, close: 1.12 });
  ok(chart.bars.length === 2, "a re-send of the last bar does not add a bar");
  ok(chart.bars[1].high === 1.4 && chart.bars[1].low === 1.05,
    "...and cannot shrink the bar the chart is already showing");

  /* A late copy of an OLDER bar: the one that used to make an earlier
     candle jump. */
  chart.setLastBar({ time: "2026-11-24T09:00:00", open: 1, high: 1.9, low: 0.95, close: 1.1 });
  ok(chart.bars.length === 2, "a late copy of a bar already held does not add one either");
  ok(chart.bars[0].low === before.low, "...and does not raise its low");
  ok(chart.bars[0].open === before.open, "...and does not move its open");

  const newBar = { time: "2026-11-24T11:00:00", open: 1.3, high: 1.35, low: 1.28, close: 1.33 };
  chart.setLastBar(newBar);
  ok(chart.bars.length === 3 && chart.bars[2].time === newBar.time, "a genuinely new bar is still appended");
}

{
  /* The series cache. A Renko/Heikin-Ashi transform recomputes every
     synthetic bar from the raw ones, so serving it from a cache that
     cannot see a replaced bar is how earlier candles end up disagreeing
     with the head of the chart. */
  const chart = Object.create(CandleChart.prototype);
  chart.type = "candles";
  chart.bars = [{ time: "t1", open: 1, high: 2, low: 0.5, close: 1.5 }];
  chart.draw = () => {};
  const first = chart.rows();
  ok(chart.rows() === first, "an untouched series is served from the cache");
  chart.setLastBar({ time: "t1", open: 1, high: 3, low: 0.5, close: 2.9 });
  const after = chart.rows();
  ok(after !== first, "a bar replaced in place invalidates the cache even though the length did not change");
  ok(after[0].h === 3, "...and the rows that come back are the bars as they are now");
}

ok(/_seriesRev === \(this\._rev \|\| 0\)/.test(CHARTS), "rows() is keyed on the revision, not on the length alone");

/* ============================================ 1b. one series, one timeframe */
section("1b. a live bar for another timeframe is not merged into this chart");

{
  const at = APP.indexOf('if (msg.type === "candle")');
  ok(at > 0, "the live candle branch is still there");
  /* Sliced to the NEXT branch, not to a byte count. A fixed 3200
     here silently stopped covering the end of the block the first
     time a comment was added above it, and the assertions below
     then failed for a reason that had nothing to do with them. */
  const branchEnd = APP.indexOf('if (msg.type === "live_signal")', at);
  ok(branchEnd > at, "the candle branch no longer ends where it used to");
  const branch = APP.slice(at, branchEnd);
  ok(/const sameTf = Boolean\(S\.timeframe\) && String\(c\.timeframe \|\| ""\) === String\(S\.timeframe\)/.test(branch),
    "the timeframe has to match, not merely not disagree");
  ok(!/if \(c\.symbol === S\.symbol && \(!S\.timeframe/.test(branch),
    "the old 'any bar will do while we have no timeframe' test is gone");
  ok(/S\.candles\[i\] = mergeBar\(S\.candles\[i\], c\)/.test(branch),
    "the desk's own series merges the bar rather than replacing it");
  ok(/setLastBar\(bar\)/.test(branch), "the chart is handed the merged bar, not the raw message");
}

{
  const at = APP.indexOf('if (msg.type === "candles")');
  const branch = APP.slice(at, at + 2000);
  ok(/const wrongTf =/.test(branch) && /!wrongTf &&/.test(branch),
    "a history broadcast for another timeframe cannot replace this chart's series");
}

/* ================================================= 1c. the expert itself == */
section("1c. a closed bar is announced on its own timeframe only");

{
  const at = EA.indexOf("void SendCandle(const int shift)");
  const body = EA.slice(at, EA.indexOf("}", EA.indexOf("SendCandleOn(g_feed_tf, shift);", at)));
  ok(/if\(shift == 0 && g_feed_tf != PERIOD_CURRENT && g_feed_tf != _Period\)/.test(body),
    "only the FORMING bar is mirrored onto the desk's timeframe");
  ok(/SendCandleOn\(g_feed_tf, 1\);/.test(EA),
    "the desk timeframe's closed bar is still sent - by MaybeClosedBar, which counts its own bars");
  /* A floor, not a pin. What this file cares about is that the version
     moved when the mirroring behaviour changed, and that it never goes
     back below the release that changed it. Pinning the exact number
     here would mean every later bump - for reasons that have nothing
     to do with candles - fails a candle test.
     The "bump only for behaviour the engine can see" gate lives in
     tests/calendar-backtest-and-kill.test.js and is the one place that
     is allowed to name the current number. */
  const said = /#define AURION_EA_VERSION "(\d+)\.(\d+)"/.exec(EA);
  ok(said, "the expert declares a version");
  const asNum = Number(said[1]) * 1000 + Number(said[2]);
  ok(asNum >= 1024, "the expert's version moved with the change: " + said[1] + "." + said[2]);
  const prop = /#property version   "(\d+)\.(\d+)"/.exec(EA);
  ok(prop && prop[1] === said[1] && prop[2] === said[2], "...in both places, and they agree");
}

/* ======================================================= 2. the sad face == */
section("2. nobody is trading: a sad face, not a dash");

{
  ok(/\n    sad: '/.test(APP), "there is a sad icon");
  const sad = APP.slice(APP.indexOf("\n    sad: '"), APP.indexOf("\n", APP.indexOf("\n    sad: '") + 2));
  ok(!/circle/.test(sad), "it has no circle around it - asked for in those words");
  ok((sad.match(/<line /g) || []).length === 2, "two eyes");
  ok(/<path d="M7\.8 17c1-2\.1 2\.4-3\.1 4\.2-3\.1s3\.2 1 4\.2 3\.1"\/>/.test(sad),
    "and a mouth that curves the sad way");
  ok(/who === "robot" \? "bolt" : who === "manual" \? "user" : "sad"/.test(APP),
    "the gate card uses it for 'nobody'");
}

/* ============================================ 3. the bridge version card == */
section("3. the expert's version is always known, and the card keeps up");

ok(/self\._ea_versions: dict\[int, str\] = \{\}/.test(BRIDGE), "the engine remembers a version per chart");
ok(/def remember_ea_version\(/.test(BRIDGE) && /def remembered_ea_version\(/.test(BRIDGE),
  "...through one pair of methods, so there is one rule");
ok(/version=self\.remembered_ea_version\(cid, symbol\)/.test(BRIDGE),
  "a chart first met through a tick inherits the version its hello reported");
ok(/self\.remember_ea_version\(chart_id, agent\.symbol, agent\.version\)/.test(BRIDGE),
  "hello files the version where a rebuilt agent will find it");
{
  const at = BRIDGE.indexOf("def remembered_ea_version(");
  const body = BRIDGE.slice(at, at + 900);
  ok(/self\._ea_versions_by_symbol/.test(body) && /self\._ea_version_seen/.test(body),
    "...falling back by symbol, then to the last version any chart reported");
}

ok(/function eaVersionState\(running, shipped\)/.test(APP),
  "the desk can reach the shipped-against-running verdict without waiting for a snapshot");
ok(/function patchExpertsCard\(\)/.test(APP), "and can repaint the expert card in place");
{
  const at = APP.indexOf('if (msg.type === "agents")');
  const branch = APP.slice(at, at + 900);
  ok(/patchExpertsCard\(\);/.test(branch),
    "a chart appearing or going away repaints it at that moment, not ten seconds later");
}
ok(/S\._eaUpdNote !== undefined/.test(APP),
  "the repaint does not re-ask the update endpoint every time an agent blinks");

/* ================================================== 4. the lot stepper == */
section("4. the lot in Settings looks like every other lot field");

{
  const at = THEMES.indexOf("html[data-skin] .field .ct-step input");
  ok(at > 0, "a skin no longer dresses the number between the two buttons as a field of its own");
  const block = THEMES.slice(at, at + 400);
  ok(/border-radius:0/.test(block), "no radius on it - that was the circle inside the box");
  ok(/background:none/.test(block), "no surface on it - that was what showed as triangles at the corners");
  ok(/:focus/.test(block), "and the same when it is clicked, which is where it actually showed");
  ok(/html\[data-skin\] \.field > \.ct-step\{/.test(THEMES), "the shell wears the field instead");
  ok(/html\[data-skin\] \.field > \.ct-step:focus-within\{/.test(THEMES), "...and lights up as one");
}

/* ======================================================= 5. shutting down */
section("5. terminate asks, kill obeys, and both really stop AURION");

ok(/app\.post\("\/api\/shutdown"/.test(INDEX), "the desk can be asked to shut down");
{
  const at = INDEX.indexOf("function shutdownAurion(");
  ok(at > 0, "...through one function");
  const body = INDEX.slice(at, INDEX.indexOf("\n}\n", at));
  ok(body.indexOf("supervisor.stop()") < body.indexOf("supervisor.stopEngine"),
    "the supervisor is stopped BEFORE the engine, or it would start a fresh one behind us");
  ok(/stopEngine\(\{/.test(body), "the engine is stopped and waited for");
  ok(/server\.close\(\)/.test(body), "the desk's own server goes last");
  ok(/if \(shuttingDown\) return shuttingDown;/.test(INDEX), "a second request joins the first teardown");
  ok(/persist: !hard/.test(body), "a requested shutdown saves the settings; a kill does not wait for it");
}
{
  const at = INDEX.indexOf('app.post("/api/shutdown"');
  const body = INDEX.slice(at, at + 900);
  ok(/local_only/.test(body),
    "the desk listens on 0.0.0.0, so 'stop the whole product' is refused from anywhere but this machine");
}
ok(/function watchOwner\(pid, everyMs\)/.test(INDEX), "the desk watches whoever launched it");
ok(/AURION_OWNER_PID/.test(INDEX) && /AURION_OWNER_PID/.test(WINDOW),
  "...and the window tells it which pid that is");
{
  const at = INDEX.indexOf("function watchOwner(pid, everyMs)");
  const body = INDEX.slice(at, INDEX.indexOf("\n}\n", at));
  ok(/process\.kill\(owner, 0\)/.test(body), "signal 0 asks whether the pid is there without touching it");
  ok(/shutdownAurion\("owner_gone", \{ hard: true \}\)/.test(body),
    "a window that was killed takes the desk and the engine with it");
}
ok(/for \(const signal of \["SIGINT", "SIGTERM", "SIGHUP"\]\)/.test(INDEX),
  "a desk stopped from a console stops the engine too");

ok(/async function stopEngine\(opts\)/.test(SUP), "stopping the engine is one routine");
ok(/module\.exports = \{ start, stop, resume, state, startEngine, stopEngine, replaceEngine,/.test(SUP),
  "...shared by the restart path and the shutdown path");
{
  const at = SUP.indexOf("async function replaceEngine(opts)");
  const body = SUP.slice(at, SUP.indexOf("\nasync function tick()", at));
  ok(/const halt = await stopEngine\(\{ budgetMs \}\);/.test(body),
    "replaceEngine uses it rather than keeping a second copy");
}

ok(/private async void OnFormClosing\(object\? sender, FormClosingEventArgs e\)/.test(WINDOW),
  "the window decides what closing means");
{
  const at = WINDOW.indexOf("private async void OnFormClosing");
  const body = WINDOW.slice(at, WINDOW.indexOf("\n    }\n", WINDOW.indexOf("Close();", at)));
  ok(/CloseReason\.WindowsShutDown/.test(body) && /CloseReason\.TaskManagerClosing/.test(body),
    "a session ending is told apart from a person pressing the X");
  ok(/StopAurionNow\(hard: true\)/.test(body), "a kill is obeyed on the spot, with no question");
  /* Still asked - unless the desk has already asked it. The power
     button in the menu puts the same question in the trader's own
     language and puts the shutdown screen up behind it; the host's
     MessageBox appearing on top of that would be the same question
     twice, the second time in English. */
  ok(/var answer = _askedByDesk \? DialogResult\.Yes : AskToShutDown\(\);/.test(body)
     && /e\.Cancel = true;/.test(body),
    "a terminate asks first, and the window stays open until it is answered");
  ok(/TellDeskWeAreStopping\(/.test(body),
    "and the desk is told, so the screen says what is happening");
  ok(/if \(_setupOnly \|\| _stopped\)/.test(body),
    "the setup pass owns nothing and must not stop a desk on its way out");
}
ok(/Shut AURION down\?/.test(WINDOW), "the question is asked in those words");
ok(/private const int WM_QUERYENDSESSION = 0x0011;/.test(WINDOW)
  && /private const int WM_ENDSESSION = 0x0016;/.test(WINDOW),
  "Windows logging out or restarting is handled as a kill, not as a question");
{
  const at = WINDOW.indexOf("protected override void WndProc(ref Message m)");
  const body = WINDOW.slice(at, WINDOW.length);
  ok(/m\.Result = \(IntPtr\)1;/.test(body), "AURION never blocks a reboot");
  ok(/m\.WParam != IntPtr\.Zero/.test(body), "a session that was cancelled does not stop anything");
}
ok(/private async Task ShutdownAurionAsync\(bool hard\)/.test(WINDOW), "one shutdown routine in the window too");
{
  const at = WINDOW.indexOf("private async Task ShutdownAurionAsync(bool hard)");
  const body = WINDOW.slice(at, WINDOW.indexOf("\n    }\n", WINDOW.indexOf("RunStopScript", at)));
  ok(/\/api\/shutdown/.test(body), "it asks the desk, which is the process that knows how");
  ok(/if \(!await DeskIsAnsweringAsync\(\)\) return;/.test(body),
    "'asked it to stop' is not 'it stopped' - it waits for silence");
  ok(/RunStopScript/.test(body), "and falls back to the product's own stop script");
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
