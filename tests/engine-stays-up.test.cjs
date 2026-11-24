"use strict";
/* The engine must stay up, and the desk must not lie about what it holds.
 *
 * Every assertion in here comes from one reported session, with the
 * MetaTrader Experts log and the engine log side by side. The faults
 * looked like four separate products misbehaving and were three bugs:
 *
 *   * the expert failed over between two ports that are the same
 *     engine, so a busy engine got asked twice and the desk saw a
 *     transport change every few seconds;
 *   * the engine downloaded the economic calendar on EVERY pass of a
 *     loop whose period happened to equal the cache's own lifetime,
 *     and did part of that work on the event loop;
 *   * a position missing from ONE feed snapshot was recorded as
 *     closed, which is how a trade that never touched its stop got a
 *     stop written against it, then a target, then a stop again.
 *
 * And one piece of CSS that had been broken since it was written.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let okCount = 0;
let failCount = 0;
function ok(cond, what) {
  if (cond) { okCount += 1; return; }
  failCount += 1;
  console.error("  x  " + what);
}

/* Assertions must read the CODE, not the prose around it. These files
   explain themselves at length, and a comment that quotes the broken
   line it replaced would otherwise fail the very test that proves the
   line is gone. */
const noBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ");
const noHashComments = (s) => s.replace(/^[ \t]*#.*$/gm, " ");

const EA = read("engine", "ea", "AurionBridge.mq5");
const BRIDGE = read("engine", "aurion", "mt5", "bridge.py");
const TRADER = read("engine", "aurion", "runtime", "trader.py");
const NEWS = read("engine", "aurion", "news_feed.py");
const CHARTCSS = read("apps", "web", "css", "chart.css");

/* ================================ 1. one engine, one port ============= */
{
  /* lastIndexOf: the first "bool FlushOut()" in an .mq5 is the forward
     declaration at the top of the file, not the function. */
  const flushRaw = EA.slice(EA.lastIndexOf("bool FlushOut()"), EA.indexOf("string JsonEsc("));
  const flush = noBlockComments(flushRaw);
  ok(flush.length > 100, "the expert still has a flush");

  /* The whole fault in one line: the expert used to pick "the other
     port" whenever a post was refused, and the other port is the desk,
     which forwards to the very engine that just refused it. */
  ok(!/int\s+alt\s*=/.test(flush),
    "the expert no longer keeps an alternate ingest port");
  ok(!/ingest switched to port/.test(noBlockComments(EA)),
    "and nothing can print 'ingest switched to port' any more");
  ok(!/8080/.test(flush),
    "the desk's port appears nowhere in the flush path");

  /* What it does instead: the engine, then the file drop. */
  ok(/int\s+primary\s*=\s*InpHttpPort\s*;/.test(flush),
    "it posts to the engine's own port and only that");
  ok(/WriteInbox\(json\)/.test(flush),
    "and falls back to the file inbox, which cannot time out");

  /* The queue is what stops a stall becoming a spiral. */
  ok(/#define\s+AURION_HTTP_QUEUE_MAX\s+(\d+)/.test(EA),
    "the outbound queue has a declared ceiling");
  const cap = Number(/#define\s+AURION_HTTP_QUEUE_MAX\s+(\d+)/.exec(EA)[1]);
  ok(cap > 0 && cap <= 64, "and the ceiling is small enough to post: " + cap);

  const queue = noBlockComments(
    EA.slice(EA.indexOf("void QueueOut("), EA.indexOf("bool SendRaw(")));
  ok(/AURION_HTTP_QUEUE_MAX/.test(queue), "QueueOut enforces it");
  /* Dropping the newest is the wrong end: it feeds the desk a backlog
     of stale prices and throws the current one away. */
  ok(/g_http_q\[i\]\s*=\s*g_http_q\[i\s*\+\s*drop\]/.test(queue),
    "a full queue sheds its OLDEST entries, so the newest price survives");

  /* The two declarations must AGREE - #property is what MetaTrader
     shows in the terminal, AURION_EA_VERSION is what travels to the
     engine, and a copy where they disagree is a copy whose reported
     version cannot be trusted. Compared to each other rather than
     both pinned to a literal, which is how they came to disagree:
     one got bumped and the other did not. */
  const wire = (/#define AURION_EA_VERSION "([0-9.]+)"/.exec(EA) || [])[1];
  const prop = (/#property version\s+"([0-9.]+)"/.exec(EA) || [])[1];
  ok(parseFloat(wire) >= 1.26, "the expert is at least 1.26, and is v" + wire);
  ok(wire === prop, `and says so to MetaTrader too (${wire} vs ${prop})`);
}

/* ======================= 2. silence is not absence =================== */
{
  const sweep = BRIDGE.slice(
    BRIDGE.indexOf("async def _http_sweep_loop"),
    BRIDGE.indexOf("def _inbox_dirs"),
  );
  ok(sweep.length > 200, "the sweep loop is still there");

  /* An expert speaks over three transports. HTTP going quiet says
     nothing about the other two, and retiring a chart on that alone is
     why an attached expert kept being drawn as detached. */
  const httpBlock = sweep.slice(sweep.indexOf("_http_seen.items()"), sweep.indexOf("_agent_beat.items()"));
  ok(!/_mark_agent_offline/.test(httpBlock),
    "HTTP silence alone no longer takes a chart offline");
  ok(/_agent_beat\.items\(\)[\s\S]{0,400}_mark_agent_offline/.test(sweep),
    "the beat every transport winds is what retires a chart");

  /* A watchdog must not count time it was asleep for. When the engine
     stalls, nothing is read, so EVERY chart looks stale the moment the
     loop runs again - and the sweep used to fire on all of them. */
  ok(/overrun/.test(sweep), "the sweep measures how late its own pass was");
  ok(/grace/.test(sweep) && /\+\s*grace/.test(sweep),
    "and forgives exactly that much before calling anything dead");
  ok(/min\(overrun,/.test(sweep),
    "with a ceiling, so a clock jump cannot disable the watchdog for ever");
}

/* ================= 3. the calendar stops stalling the engine ========= */
{
  const minAge = /MIN_AGE_SECONDS\s*=\s*(\d+)\s*\*\s*60/.exec(NEWS);
  ok(minAge, "the feed cache still declares how stale it may get");
  const refresh = /NEWS_REFRESH_SECONDS\s*=\s*(\d+)\s*\*\s*60/.exec(TRADER);
  ok(refresh, "and the loop still declares how often it wakes");

  /* The whole bug, arithmetic only: the loop woke every 300 seconds
     and the cache expired at 300 seconds, so every single pass went to
     the network. The terminal logs show the cost on the stroke of
     every fifth minute, for hours. */
  const ageMin = Number(minAge[1]);
  const wakeMin = Number(refresh[1]);
  ok(ageMin > wakeMin,
    "the cache outlives the loop's period, so most passes cost nothing: " +
    wakeMin + "m wake vs " + ageMin + "m cache");

  const loop = TRADER.slice(
    TRADER.indexOf("async def _news_refresh_loop"),
    TRADER.indexOf("def news_state"),
  );
  ok(loop.length > 200, "the refresh loop is still there");

  /* reload_news() re-reads the calendar off disk and builds a datetime
     for every release in it. It was being awaited straight from the
     coroutine, so the engine stopped reading the expert for as long as
     it took. It must now sit inside the function handed to the thread,
     never in the body of the loop itself.
 
     Asserted structurally rather than by line: everything from `while`
     onwards is what the event loop actually executes. */
  const body = loop.slice(loop.indexOf("while not self._news_stop"));
  ok(body.length > 100, "the loop body was found");
  ok(!/self\.prop\.reload_news\(\)/.test(body),
    "reload_news is not called from the event loop's own body");
  ok(/self\.prop\.reload_news\(\)/.test(loop.slice(0, loop.indexOf("while not self._news_stop"))),
    "it is called from the worker function instead, so it still happens");
  ok(/asyncio\.to_thread\(/.test(body), "the whole pass is on a worker thread");
  ok(/NEWS_PASS_BUDGET/.test(loop) && /wait_for/.test(loop),
    "and the pass is on a hard clock, so a dead name server cannot hold it");
  ok(/NEWS_PASS_BUDGET\s*=\s*[\d.]+/.test(TRADER), "the budget is a declared number");

  /* A socket that connects and then says nothing used to hold a thread
     for 25 seconds, twice. */
  const t = /def fetch\(timeout: float = ([\d.]+)\)/.exec(NEWS);
  ok(t, "fetch still has a timeout");
  ok(Number(t[1]) <= 10, "and it is short enough to give up on: " + t[1] + "s");
}

/* ============== 4. a close has to be shown, not inferred ============= */
{
  const sync = TRADER.slice(
    TRADER.indexOf("async def _sync_position_book"),
    TRADER.indexOf("async def _sync_position_book") + 7000,
  );
  ok(sync.length > 500, "the position book is still synced");

  /* The reported loop: a short or empty snapshot made every open
     position look closed, so an exit was written against a stop that
     was never touched; the next snapshot brought it back, so an entry
     was written; and round it went until the kill switch. */
  ok(!/closed\s*=\s*\[t for t in list\(self\._known_pos\) if t not in current\]/.test(sync),
    "a ticket missing from one snapshot is no longer called closed");
  ok(/missing\s*=\s*\[t for t in list\(self\._known_pos\) if t not in current\]/.test(sync),
    "it is called missing instead, which is all it is");
  ok(/POSITION_MISSING_STRIKES/.test(sync),
    "and it has to stay missing for several snapshots running");
  ok(/_close_is_evidenced\(ticket\)/.test(sync),
    "unless the broker's own deals confirm the close, which skips the wait");

  const strikes = /POSITION_MISSING_STRIKES\s*=\s*(\d+)/.exec(TRADER);
  ok(strikes, "the number of strikes is declared");
  ok(Number(strikes[1]) >= 2, "more than one gap is required: " + strikes[1]);
  /* Patience is cheap here, but it is not free: a real close that
     produced no deal we can see still has to show up in the blotter. */
  ok(Number(strikes[1]) <= 10, "and it is not so patient the blotter goes stale");

  /* A ticket that comes back must forget its strikes, or a chart that
     flickers once an hour would eventually accumulate three. */
  ok(/if ticket not in missing/.test(sync),
    "a ticket that reappears has its strikes cleared");

  ok(/def _close_is_evidenced/.test(TRADER), "the evidence test exists");
  const ev = TRADER.slice(
    TRADER.indexOf("def _close_is_evidenced"),
    TRADER.indexOf("def _close_is_evidenced") + 1200,
  );
  ok(/aggregate_close_deals/.test(ev),
    "and it asks the broker's closing deals, not our own guess");
  ok(/except Exception/.test(ev),
    "a deal feed that is not there yet means 'not proven', never a crash");

  ok(/_pos_missing/.test(TRADER), "the strike counter is a real field");
  ok(/self\._pos_missing:\s*dict\[int, int\]\s*=\s*\{\}/.test(TRADER),
    "declared in the constructor beside the book it guards");
}

/* ================ 5. loading means loading, not a peek ============== */
{
  const veil = noBlockComments(
    CHARTCSS.slice(CHARTCSS.indexOf(".chart-veil {"), CHARTCSS.indexOf(".chart-veil-txt")));
  ok(veil.length > 50, "the veil still has a rule");

  /* The surface tokens are RAW CHANNEL TRIPLES - "--s1: 6 7 11" - so
     `background: var(--s1)` is `background: 6 7 11`, which is not a
     colour, so the browser dropped the declaration and the veil shipped
     fully transparent. A panel whose own comment calls it "deliberately
     opaque" had no background at all. */
  ok(!/background:\s*var\(--s1/.test(veil),
    "the veil no longer paints itself with a raw channel triple");
  ok(/background:\s*rgb\(var\(--s1/.test(veil),
    "it wraps the token in rgb(), the way the rest of the product does");

  /* Every other use of these tokens in the product agrees. If one did
     not, the convention would be the thing in doubt, not this rule. */
  const APPCSS = read("apps", "web", "css", "app.css");
  const bare = noBlockComments(APPCSS + "\n" + CHARTCSS)
    .match(/background[^;{}]*:\s*var\(--s[1-9]\s*[,)]/g) || [];
  ok(bare.length === 0,
    "no stylesheet paints a background with a bare surface token: " + bare.join(" | "));

  /* And the chart itself must go, not merely be covered: a canvas
     holding one timeframe's candles while the box says it is fetching
     another one is a lie however well it is hidden. */
  ok(/\.chart-box\.is-waiting\s*>\s*canvas/.test(CHARTCSS),
    "a waiting chart box hides its canvas");
  ok(/visibility:\s*hidden/.test(
      CHARTCSS.slice(CHARTCSS.indexOf(".chart-box.is-waiting"),
                     CHARTCSS.indexOf(".chart-box.is-waiting") + 400)),
    "and hides it rather than collapsing it, so nothing reflows");

  /* The class was being set and cleared by the desk all along, with no
     rule anywhere to act on it. */
  const APP = read("apps", "web", "js", "app.js");
  ok(/box\.classList\.add\("is-waiting"\)/.test(APP), "paintVeil still sets the class");
  ok(/box\.classList\.remove\("is-waiting"\)/.test(APP), "clearVeil still clears it");
}

/* ============ 6. more than one symbol, without disruption =========== */
{
  const APP = read("apps", "web", "js", "app.js");

  /* The desk held exactly one series, so every symbol switch threw the
     previous symbol's bars away and watching two markets was a
     sequence of downloads rather than two markets. */
  ok(/const SERIES_CACHE_MAX\s*=\s*(\d+)/.test(APP),
    "the desk can hold more than one series now");
  const max = Number(/const SERIES_CACHE_MAX\s*=\s*(\d+)/.exec(APP)[1]);
  ok(max >= 2, "more than one: " + max);
  /* Bounded, or a trader working through a watchlist accumulates every
     series they have ever opened. */
  ok(max <= 32, "and bounded, so a long watchlist cannot grow without end");

  ok(/function rememberSeries\(/.test(APP), "there is one way in");
  ok(/function cachedCandlesFor\(/.test(APP), "and one way out");

  const cached = APP.slice(APP.indexOf("function cachedCandlesFor("),
                           APP.indexOf("function cachedCandlesFor(") + 900);
  /* The identity check is the thing that must not be lost: handing a
     EURUSD M15 chart the bars of XAUUSD H1 is worse than drawing
     nothing, and a cache makes that mistake easier, not harder. */
  ok(/seriesKey\(symbol, timeframe\)/.test(cached),
    "a series is still identified by symbol AND timeframe");
  ok(/S\.candlesKey === want/.test(cached), "the series on screen still answers first");
  ok(/S\.series \|\| \{\}/.test(cached), "and the cache answers for the rest");

  const remember = APP.slice(APP.indexOf("function rememberSeries("),
                             APP.indexOf("function forgetSeries"));
  ok(/if \(!key \|\| !Array\.isArray\(bars\)\) return/.test(remember),
    "nothing unidentified or unshaped gets into the cache");
  ok(/k !== S\.candlesKey/.test(remember),
    "and eviction never throws away the series being drawn");

  /* Held bars that nothing is updating are worse than no bars: they
     draw instantly and are silently stale. */
  ok(/function forgetSeries\(\)/.test(APP), "the cache can be emptied");
  ok(/forgetSeries\(\);/.test(APP), "and is, when no expert is attached anywhere");

  /* A symbol being held but not looked at must stay current, or
     switching back shows a chart frozen at the moment it was left. */
  const live = APP.slice(APP.indexOf('if (msg.type === "candle")'),
                         APP.indexOf('if (msg.type === "hist_progress")'));
  ok(/S\.series \|\| \{\}\)\[seriesKey\(c\.symbol, c\.timeframe\)\]/.test(live),
    "a live bar for a held-but-unwatched series updates that series");
  ok(/mergeBar\(other\.bars\[j\], c\)/.test(live),
    "by the same merge rule as the chart on screen, not by replacement");
  /* It must only ever touch a series already held - inventing one
     would be a way to cross two symbols. */
  ok(/if \(other && Array\.isArray\(other\.bars\)\)/.test(live),
    "and only when that series is already held, so it cannot invent one");

  /* Switching back to a warm symbol must not go behind the veil. */
  const pick = APP.slice(APP.indexOf("async function pickMarket("),
                         APP.indexOf("async function pickMarket(") + 4200);
  ok(/const warm = cachedCandlesFor\(symbol, timeframe\)/.test(pick),
    "pickMarket looks in the cache before it asks the engine");
  ok(/rememberSeries\(symbol, timeframe, S\.candles\)/.test(pick),
    "and puts what it downloads back in");
}

/* =========================== 7. the cache-buster ===================== */
{
  const INDEX = read("apps", "web", "index.html");
  const css = /css\/chart\.css\?v=desk(\d+)/.exec(INDEX);
  ok(css && Number(css[1]) >= 239, "chart.css is re-fetched after the veil fix");
  const app = /js\/app\.js\?v=desk(\d+)/.exec(INDEX);
  ok(app && Number(app[1]) >= 280, "app.js is re-fetched too");
}

console.log((failCount ? "FAIL" : "ok") + "  engine-stays-up: " +
  okCount + " ok, " + failCount + " failed");
if (failCount) process.exit(1);
