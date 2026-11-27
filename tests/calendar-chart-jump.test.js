/**
 * Two things the trader asked for, checked rather than described.
 *
 * 1. From the calendar to the chart. Reading a release and then wanting
 *    to see the candle it landed on meant leaving the calendar, opening
 *    the chart and dragging back through months - so in practice the
 *    two halves of one question were never put together. There is now a
 *    "see the chart on this date" button on the day panel, and pressing
 *    it opens the EA chart for the selected instrument, loads enough
 *    history to reach that day, and marks the moment.
 *
 * 2. The state of the download. Six months of M15 is 17 280 candles and
 *    of M1 is 259 200; they arrive from MetaTrader in chunks over tens
 *    of seconds, and a chart that is still filling looks exactly like
 *    one that has given up. The engine now reports the expert's own
 *    progress and the desk shows it - then says which period ended up
 *    on screen.
 *
 *     node tests/calendar-chart-jump.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, ...p.split("/")), "utf8");

const APP = read("apps/web/js/app.js");
const CAL = read("apps/web/js/calendar.js");
const CHARTS = read("apps/web/js/charts.js");
const CSS = read("apps/web/css/app.css");
const CHARTCSS = read("apps/web/css/chart.css");
const BRIDGE = read("engine/aurion/mt5/bridge.py");
const TRADER = read("engine/aurion/runtime/trader.py");
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

/* One top-level function out of app.js, by brace matching. */
function liftFn(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(name + " is missing");
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error(name + " never closes");
}

/* A method of an object literal or a class, which `function name(` does
   not match. Same brace walk from the signature line. */
function liftMethod(src, name) {
  const re = new RegExp("^\\s{2,4}" + name + "\\s*\\([^)]*\\)\\s*\\{", "m");
  const m = re.exec(src);
  if (!m) throw new Error(name + " is missing");
  const open = src.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) return src.slice(m.index, i + 1); }
  }
  throw new Error(name + " never closes");
}

/* ── 1. the calendar button ───────────────────────────────────────── */

check("the day panel offers the chart for that date", () => {
  if (!/_chartBtn\(key, evs\)/.test(CAL)) throw new Error("the button is not rendered from the day panel");
  const btn = liftMethod(CAL, "_chartBtn");
  if (!/cal-chart-go/.test(btn)) throw new Error("the button has no class to delegate on");
  if (!/data-day=|data-at=/.test(btn)) throw new Error("the button carries neither the day nor the instant");
  if (!/calendar\.see_chart/.test(btn)) throw new Error("the label is a hard-coded string");
  /* Offered only when there is somewhere to go. Without an expert
     attached there is no candle to land on, and a button that explains
     itself by failing is worse than no button. */
  if (!/calendarChartSymbol\(\)/.test(btn)) throw new Error("it is offered with no chart to open");
  return "one button per day, labelled with the instrument";
});

check("the instant it jumps to is the loudest release of that day", () => {
  const sandbox = { out: null };
  vm.createContext(sandbox);
  vm.runInContext("this.fn = { " + liftMethod(CAL, "_chartMoment") + " };", sandbox);
  const day = "2026-03-06";
  const base = Date.UTC(2026, 2, 6, 12, 0, 0);
  const host = {
    byDay: new Map(),
    _fromDayKey: () => base,
    _chartMoment: sandbox.fn._chartMoment,
  };
  const low = { ms: 1000, level: "low" };
  const high = { ms: 2000, level: "high" };
  if (host._chartMoment(day, [low, high]) !== 2000) throw new Error("it does not prefer the high-impact release");
  if (host._chartMoment(day, [low]) !== 1000) throw new Error("it ignores the only release there is");
  /* A quiet day still answers "what was the market doing then". */
  if (host._chartMoment(day, []) !== base) throw new Error("a day with no releases has no moment at all");
  /* A row with no usable timestamp must not become NaN on the button. */
  if (host._chartMoment(day, [{ ms: 0, level: "high" }]) !== base) throw new Error("an undated row is taken as a moment");
  return "high impact, then first, then midday";
});

check("a day that has not traded is not offered as a chart", () => {
  /* Reported: the calendar lists releases weeks ahead, and every one of
     those future days carried "see the chart on this date" - a chart
     that cannot exist, because no candle has been printed in a day
     that has not come. */
  const sandbox = {
    esc: (v) => String(v),
    I18N: { t: (k) => k },
    calendarChartSymbol: () => "SYM",
  };
  vm.createContext(sandbox);
  vm.runInContext("this.fn = { " + liftMethod(CAL, "_chartBtn") + ","
    + liftMethod(CAL, "_chartMoment") + "," + liftMethod(CAL, "_dayStart") + ","
    + liftMethod(CAL, "_fromDayKey") + " };", sandbox);
  const host = Object.assign({ byDay: new Map() }, sandbox.fn);
  const key = (ms) => {
    const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const DAY = 86400000;
  const now = Date.now();

  const soon = key(now + 2 * DAY);
  const ahead = host._chartBtn(soon, [{ ms: now + 2 * DAY, level: "high" }]);
  if (/cal-chart-go/.test(ahead)) throw new Error("a day two days out still offers a chart");
  if (!/calendar\.chart_not_yet/.test(ahead)) {
    throw new Error("the button vanishes with no reason given, which reads as a broken day");
  }

  const past = key(now - 30 * DAY);
  const back = host._chartBtn(past, [{ ms: now - 30 * DAY, level: "high" }]);
  if (!/cal-chart-go/.test(back)) throw new Error("a day that has traded lost its button");
  if (Number(/data-at="(\d+)"/.exec(back)[1]) !== now - 30 * DAY) {
    throw new Error("a past instant was moved");
  }

  /* Today is half a day that exists and half a day that does not. */
  const later = Math.min(now + 6 * 3600000, host._dayStart(key(now)) + DAY - 1);
  const today = host._chartBtn(key(now), [{ ms: later, level: "high" }]);
  if (later > now) {
    if (!/cal-chart-go/.test(today)) throw new Error("today is refused because one release is still to come");
    const at = Number(/data-at="(\d+)"/.exec(today)[1]);
    if (at > Date.now()) throw new Error("it still asks for a candle from this afternoon");
    if (!/calendar\.chart_up_to_now/.test(today)) throw new Error("the shift to the newest candle is silent");
  }

  /* And the desk refuses it too, for a panel left open past midnight. */
  const f = liftFn(APP, "openCalendarMoment");
  if (!/when > now \+ 60000/.test(f) || !/calendar\.chart_not_yet/.test(f)) {
    throw new Error("a stale panel can still ask for a candle from the future");
  }
  if (!/at: Math\.min\(when, now\)/.test(f)) throw new Error("the instant is not clamped to now");
  return "withheld ahead of time, clamped on the day itself";
});

check("both copies of the day panel can be pressed", () => {
  /* The same markup is rendered twice - the card beside the month and
     the popover beside the number - and a handler bound to only one of
     them is a button that works in half the places it appears. */
  if (!/day\?\.addEventListener\("click", goChart\)/.test(CAL)) {
    throw new Error("the stacked day card is not wired");
  }
  if (!/node\.addEventListener\("click", goChart\)/.test(CAL)) {
    throw new Error("the popover is not wired");
  }
  const h = CAL.slice(CAL.indexOf("const goChart"), CAL.indexOf("const select"));
  if (!/stopPropagation\(\)/.test(h)) {
    throw new Error("the press also reaches the day cell, which reopens the popover over the chart");
  }
  if (!/openCalendarMoment/.test(h)) throw new Error("nothing is asked to open the chart");
  return "the card and the popover, and the press does not bubble";
});

/* ── 2. what the desk does with it ────────────────────────────────── */

check("pressing it remembers the moment and opens the EA chart", () => {
  const f = liftFn(APP, "openCalendarMoment");
  if (!/openChartDesk\(/.test(f)) throw new Error("it does not open the chart workspace");
  if (!/S\.pendingMoment = \{/.test(f)) throw new Error("the moment is not remembered for after the mount");
  if (!/calendar\.see_chart_none/.test(f)) throw new Error("no chart attached is not explained");
  /* The popover is fixed to a cell on a page that is about to be
     replaced; leaving it up means a card floating over the chart. */
  if (!/Calendar\.unpin/.test(f)) throw new Error("the calendar popover is left floating over the chart");
  return "pending moment, then openChartDesk";
});

check("the chart arrives full screen, as it does from every other door", () => {
  /* Opening a chart from the grid fills the screen. Arriving from the
     calendar did not, because the flag was simply not passed, so the
     same chart looked like a smaller feature depending on which door
     was used. */
  const f = liftFn(APP, "openCalendarMoment");
  if (!/openChartDesk\(symbol, timeframe, \{ fullscreen: true \}\)/.test(f)) {
    throw new Error("the calendar opens the chart windowed");
  }
  return "fullscreen: true, the same as the chart grid";
});

check("the jump survives the view the workspace opens with", () => {
  /* showSpan() parks the window back at the live edge, which is the
     exact opposite of "take me to this date". It runs on every mount,
     so the order of the two is the whole feature. */
  const at = APP.indexOf("S.chart.showSpan === \"function\" && !S.pendingMoment");
  if (at < 0) throw new Error("the opening span still overrides a requested date");
  const after = APP.slice(at, at + 500);
  if (!/if \(S\.pendingMoment\) goPendingMoment\(\);/.test(after)) {
    throw new Error("nothing jumps once the bars are actually on the chart");
  }
  const f = liftFn(APP, "goPendingMoment");
  if (!/if \(!\(S\.chart\.bars \|\| \[\]\)\.length\) return;/.test(f)) {
    throw new Error("an empty chart would be reported as a terminal with no archive");
  }
  if (/S\.pendingMoment = null[\s\S]{0,200}S\.chart\.bars \|\| \[\]/.test(f)) {
    throw new Error("the request is disarmed before the chart can honour it");
  }
  return "span, then bars, then the jump";
});

check("the jump is attempted when the bars exist, not before", () => {
  /* The chart is mounted before its candles have been fetched, so one
     call site is never enough. */
  const sites = (APP.match(/if \(S\.pendingMoment\) goPendingMoment\(\);/g) || []).length;
  if (sites < 2) throw new Error("only " + sites + " place(s) try the jump");
  const f = liftFn(APP, "goPendingMoment");
  if (!/loadOlderSlab\(/.test(f)) {
    throw new Error("a date outside the loaded window is not fetched before the jump");
  }
  if (!/goToTime\(want\.at/.test(f)) throw new Error("nothing moves the view");
  if (!/S\.pendingMoment = null/.test(f)) throw new Error("the request is never cleared, so it would replay");
  if (!/calendar\.see_chart_short/.test(f)) {
    throw new Error("a terminal that cannot reach that far back says nothing");
  }
  return "walk back, jump, clear, and report a short archive";
});

check("the walk back keeps going until the day is covered", () => {
  /* Reported: pressing a date left the chart on the newest candles.
     It asked for ONE window sized to the distance - a quarter of a
     million M1 bars for six months - and when the reply came back the
     ordinary live window instead, nothing reached the date and the
     view never moved. Slabs are bounded and repeated, so reaching a
     date is a walk rather than one impossible request.

     Run, not read: the loop guard survives its own deletion in the
     source text. */
  const consts = /const TF_MINUTES = \{[^}]*\};/.exec(APP);
  const days = /const HISTORY_DAYS = (\d+);/.exec(APP);
  const cap = /const HISTORY_MAX = (\d+);/.exec(APP);
  const step = 60000; // one M1 bar
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const want = now - 5000 * step; // five thousand bars back

  const held = [];
  for (let i = 500; i > 0; i -= 1) held.push({ time: stamp(now - i * step) });

  const box = {
    console,
    $: () => null,
    S: {
      chartFocus: { symbol: "EURUSD", timeframe: "M1" },
      candles: held,
      chart: { bars: held, setBars(b) { box.S.candles = b; box.S.chart.bars = b; }, goToTime(at) { box.landed = at; return true; } },
      pendingMoment: { symbol: "EURUSD", timeframe: "M1", at: want, day: "2026-10-05" },
    },
    calls: [],
    toast: () => { box.toasted = true; },
    I18N: { t: (k) => k },
    API: {
      get(url) {
        box.calls.push(url);
        const before = Date.parse(decodeURIComponent(/before=([^&]+)/.exec(url)[1]).replace(" ", "T") + "Z");
        const count = Number(/count=(\d+)/.exec(url)[1]);
        const out = [];
        for (let i = count; i > 0; i -= 1) out.push({ time: stamp(before - i * step) });
        return Promise.resolve({ data: out });
      },
    },
  };
  vm.createContext(box);
  vm.runInContext(
    (consts ? consts[0] : "") + "\n" + (days ? days[0] : "") + "\n" + (cap ? cap[0] : "") + "\n"
    + /const HIST_RETRY_MS = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_BARS = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_DAY_STEPS = \[[^\]]*\];/.exec(APP)[0] + "\n"
    + liftFn(APP, "pageDays") + "\n" + liftFn(APP, "pageWindow") + "\n"
    + liftFn(APP, "barsForDays") + "\n" + liftFn(APP, "chartDays") + "\n"
    + liftFn(APP, "historyStep") + "\n" + liftFn(APP, "oldestHeldTime") + "\n"
/* barTime lives in charts.js, which the page loads first; this
       sandbox has to be given it or mergeOlder cannot de-duplicate. */
    + "function barTime(v){let t=String(v==null?\"\":v).trim();if(!t)return \"\";"
    + "t=t.replace(\" \",\"T\").replace(/\\.\\d+/,\"\").replace(/(Z|[+-]\\d{2}:?\\d{2})$/,\"\");return t;}\n"
    + liftFn(APP, "mergeOlder") + "\n" + liftFn(APP, "noteHistoryDepth") + "\n"
    + liftFn(APP, "historyDepthOf") + "\n" + liftFn(APP, "noteHistoryProgress") + "\n"
    + liftFn(APP, "paintHistoryEdge") + "\n" + liftFn(APP, "loadOlderSlab") + "\n"
    + liftFn(APP, "goPendingMoment")
    + "\nthis.goPendingMoment = goPendingMoment;", box);

  return box.goPendingMoment().then(() => {
    if (!box.calls.length) throw new Error("the date was never fetched");
    const oldest = Date.parse(String(box.S.candles[0].time).replace(" ", "T") + "Z");
    if (oldest > want) {
      throw new Error("the walk stopped " + Math.round((oldest - want) / step) + " bars short of the date");
    }
    if (box.landed !== want) throw new Error("the view did not move to the date");
    for (const url of box.calls) {
      const n = Number(/count=(\d+)/.exec(url)[1]);
      if (n > 8000) throw new Error("one of the asks is the old enormous window: " + n);
    }
    return box.calls.length + " slabs of M1 to reach 5000 bars back";
  });
});

check("the walk stops when the history genuinely runs out", () => {
  const consts = /const TF_MINUTES = \{[^}]*\};/.exec(APP);
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const held = [{ time: "2026-10-05 11:59:00" }];
  const box = {
    console,
    $: () => null,
    S: {
      chartFocus: { symbol: "EURUSD", timeframe: "M1" },
      candles: held,
      chart: { bars: held, setBars() {}, goToTime: () => false },
      pendingMoment: { symbol: "EURUSD", timeframe: "M1", at: now - 365 * 86400000, day: "2025-10-05" },
    },
    calls: [],
    toast: (k) => { box.toasted = k; },
    I18N: { t: (k) => k },
    API: { get(url) { box.calls.push(url); return Promise.resolve({ data: [] }); } },
  };
  vm.createContext(box);
  vm.runInContext(
    (consts ? consts[0] : "") + "\n" + /const HISTORY_DAYS = \d+;/.exec(APP)[0] + "\n"
    + /const HISTORY_MAX = \d+;/.exec(APP)[0] + "\n"
    + /const HIST_RETRY_MS = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_BARS = \d+;/.exec(APP)[0] + "\n"
    + /const PAGE_DAY_STEPS = \[[^\]]*\];/.exec(APP)[0] + "\n"
    + liftFn(APP, "pageDays") + "\n" + liftFn(APP, "pageWindow") + "\n"
    + liftFn(APP, "barsForDays") + "\n" + liftFn(APP, "chartDays") + "\n"
    + liftFn(APP, "historyStep") + "\n" + liftFn(APP, "oldestHeldTime") + "\n"
/* barTime lives in charts.js, which the page loads first; this
       sandbox has to be given it or mergeOlder cannot de-duplicate. */
    + "function barTime(v){let t=String(v==null?\"\":v).trim();if(!t)return \"\";"
    + "t=t.replace(\" \",\"T\").replace(/\\.\\d+/,\"\").replace(/(Z|[+-]\\d{2}:?\\d{2})$/,\"\");return t;}\n"
    + liftFn(APP, "mergeOlder") + "\n" + liftFn(APP, "noteHistoryDepth") + "\n"
    + liftFn(APP, "historyDepthOf") + "\n" + liftFn(APP, "noteHistoryProgress") + "\n"
    + liftFn(APP, "paintHistoryEdge") + "\n" + liftFn(APP, "loadOlderSlab") + "\n"
    + liftFn(APP, "goPendingMoment")
    + "\nthis.goPendingMoment = goPendingMoment;", box);

  return box.goPendingMoment().then(() => {
    if (box.calls.length !== 1) {
      throw new Error("it kept asking after an empty answer (" + box.calls.length + " calls)");
    }
    if (box.toasted !== "calendar.see_chart_short") {
      throw new Error("a terminal that cannot reach that far back said nothing");
    }
    return "one ask, then the honest answer";
  });
});

/* ── 3. the chart lands on the right candle ───────────────────────── */

function runGoToTime(bars, want, span) {
  const rows = bars.map((t) => ({ t }));
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext("this.host = { " + liftMethod(CHARTS, "goToTime") + " };", sandbox);
  const host = {
    span: span || 10,
    offset: 0,
    timeMark: 0,
    rows: () => rows,
    maxOffset() { return Math.max(0, rows.length - this.span); },
    minOffset: () => 0,
    clampOffset() { this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset)); },
    forgetScaleFit() {},
    draw() {},
    changed() {},
    goToTime: sandbox.host.goToTime,
  };
  const ok = host.goToTime(want, { mark: true });
  return { ok, host, rows };
}

check("the chart centres on the candle the release happened in", () => {
  const bars = [];
  for (let i = 0; i < 100; i += 1) bars.push(new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString());
  // A release at 05:07 belongs to the 05:00 candle, not to 05:15.
  const want = Date.UTC(2026, 0, 1, 5, 7);
  const { ok, host, rows } = runGoToTime(bars, want, 20);
  if (!ok) throw new Error("it reported the bars do not reach, when they do");
  const start = Math.max(0, rows.length - host.offset - host.span);
  const end = rows.length - host.offset;
  const idx = bars.indexOf(new Date(Date.UTC(2026, 0, 1, 5, 0)).toISOString());
  if (idx < start || idx >= end) throw new Error("the target candle is not on screen at all");
  const from = idx - start;
  if (from < host.span * 0.25 || from > host.span * 0.75) {
    throw new Error("it is parked at an edge rather than centred");
  }
  return "the bar at or before the instant, in the middle of the window";
});

check("a date older than the archive is reported, not faked", () => {
  const bars = [];
  for (let i = 0; i < 50; i += 1) bars.push(new Date(Date.UTC(2026, 5, 1, 0, i * 15)).toISOString());
  const { ok } = runGoToTime(bars, Date.UTC(2025, 0, 1), 20);
  if (ok) throw new Error("it claimed to have landed on a candle it does not hold");
  return "false, so the desk can say the terminal stops short";
});

check("the moment is pointed at, not just scrolled to", () => {
  if (!/this\.paintTimeMark\(L\);/.test(CHARTS)) throw new Error("the mark is never painted");
  const f = liftMethod(CHARTS, "paintTimeMark");
  if (!/setLineDash/.test(f)) throw new Error("the mark is a solid line, indistinguishable from a drawing");
  /* A filled band would recolour the very candle being asked about. */
  if (/fillRect/.test(f)) throw new Error("it paints over the candle it is pointing at");
  if (!/this\.timeMark/.test(f)) throw new Error("it does not read the marked instant");
  if (!/clearTimeMark\(\)/.test(CHARTS)) throw new Error("the mark can never be taken off");
  return "a dashed line and a pennant, from timeMark";
});

/* ── the popover a tap opens must stay open ───────────────────────── */

check("a scroll repositions the card instead of destroying it", () => {
  /* Reported: on the phone a tap on a day flashes the window up and it
     vanishes, and it takes a second tap - the same on a desktop.
     Choosing a day rewrites the day panel, whose list of releases is a
     scroller; its scrollTop snapping back to zero is a scroll event,
     arriving milliseconds after the tap that opened the card. The old
     handler closed the card on any scroll from anywhere. */
  const h = CAL.slice(CAL.indexOf("const follow = ()"), CAL.indexOf("on(document, \"pointerdown\""));
  if (!h) throw new Error("the follow/scroll handlers are gone");
  if (!/placePop\(node, popCell\)/.test(h)) throw new Error("a scroll no longer re-places the card");
  if (!/getBoundingClientRect\(\)/.test(h)) throw new Error("it closes without looking at where the cell is");
  if (!/closest\("#cal-day"\)/.test(h)) {
    throw new Error("rewriting the day panel still counts as the ground moving");
  }
  if (!/if \(!popKey\) return;/.test(h)) throw new Error("it runs with no popover open");
  /* resize is the same event in disguise on a phone: the URL bar
     sliding away resizes the window mid-read. */
  if (!/on\(window, "resize", follow\)/.test(CAL)) throw new Error("a resize still closes the card outright");
  return "follow the cell, close only once it has left the screen";
});

check("one set of global handlers, however often the grid is rebuilt", () => {
  /* Each stale copy carries its own closePop, and closePop removes
     whichever #cal-pop it finds - so after one month change a scroll
     took down a popover belonging to the handler still in use. */
  if (!/this\._off\.forEach/.test(CAL)) throw new Error("previous handlers are never removed");
  if (!/removeEventListener/.test(CAL)) throw new Error("nothing is ever unbound");
  for (const bad of ['document.addEventListener("pointerdown"', 'window.addEventListener("scroll"',
    'window.addEventListener("resize"']) {
    if (CAL.includes(bad)) throw new Error("a global handler is still registered without a way back: " + bad);
  }
  return "bind() sweeps what the previous bind() left";
});

check("a tap opens the day on the lift, not on the invented click", () => {
  const i = CAL.indexOf('pane?.addEventListener("touchend"');
  if (i < 0) throw new Error("touchend does nothing but clear a timer");
  const h = CAL.slice(i, i + 600);
  if (!/openPop\(el, true\)/.test(h)) throw new Error("the lift does not open the card");
  if (!/touchMoved/.test(h)) throw new Error("a scroll of the grid would open a day");
  /* The mouse events a browser invents after a tap must not re-enter
     the hover path and queue a second open for the same cell. */
  if (!/const TOUCH_ECHO_MS = \d+;/.test(CAL)) throw new Error("nothing marks the echo window");
  if (!/Date\.now\(\) - touchedAt < TOUCH_ECHO_MS/.test(CAL)) {
    throw new Error("the synthetic hover still competes with the finger");
  }
  return "touchend selects and pins; the echo is ignored";
});

check("hover still opens it on a pointer, and a click still pins it", () => {
  if (!/openTimer = setTimeout\(\(\) => \{ openTimer = 0; openPop\(el, false\); \}, POP_OPEN_MS\)/.test(CAL)) {
    throw new Error("hover no longer previews");
  }
  const click = CAL.slice(CAL.indexOf('pane?.addEventListener("click"'), CAL.indexOf('/* Hover and keyboard focus'));
  if (!/select\(el\.dataset\.day\)/.test(click) || !/openPop\(el, true\)/.test(click)) {
    throw new Error("a click no longer chooses the day and pins the card");
  }
  return "both ways in, as asked";
});

/* ── 4. the download, while it is happening ───────────────────────── */

check("the engine reports the expert's progress, not a guess", () => {
  if (!/async def _say_history_progress\(/.test(BRIDGE)) throw new Error("the bridge says nothing about progress");
  if (!/if not final and tape == self\.active_tape\(\):/.test(BRIDGE)) {
    throw new Error("progress is only reported when the stream has already finished");
  }
  const fn = BRIDGE.slice(BRIDGE.indexOf("async def _say_history_progress"),
    BRIDGE.indexOf("def _history_timeout"));
  for (const field of ["have", "want", "done", "depth"]) {
    if (!fn.includes(`"${field}"`)) throw new Error(field + " is not reported");
  }
  if (!/self\._hist_want\[key\] = /.test(BRIDGE)) {
    throw new Error("the size of the ask is never recorded, so progress has no denominator");
  }
  if (!/bus\.publish\("hist_progress"/.test(TRADER)) throw new Error("it never reaches the desk");
  return "have / want / done, from the chunks themselves";
});

check("the desk shows how far through it is, with a bar that moves", () => {
  if (!/msg\.type === "hist_progress"/.test(APP)) throw new Error("the event is ignored");
  const f = liftFn(APP, "paintHistoryEdge");
  if (!/charts\.hist_getting/.test(f)) throw new Error("the count is not shown while it downloads");
  if (!/tv-hint-bar/.test(f)) throw new Error("there is no progress bar");
  if (!/Math\.min\(100,/.test(f)) throw new Error("the bar can run past 100%");
  if (!/charts\.hist_loading/.test(f)) {
    throw new Error("a download with no known size has nothing to say");
  }
  if (!/\.tv-hint-bar/.test(CHARTCSS)) throw new Error("the bar is not styled");
  return "a sentence with the numbers in it and a bar under it";
});

check("when it finishes it says which period is on screen", () => {
  const f = liftFn(APP, "historyShownNote");
  if (!/charts\.hist_shown/.test(f)) throw new Error("nothing names the period");
  /* From the BARS, not from the depth the expert reports: that one says
     what the terminal holds, which is a different number for as long as
     a download is running. */
  if (!/S\.candles/.test(f)) throw new Error("the sentence is not about what is drawn");
  if (/histDepth|historyDepthOf/.test(f)) throw new Error("it describes the terminal rather than the chart");
  const p = liftFn(APP, "paintHistoryEdge");
  if (!/historyShownNote\(\)/.test(p)) throw new Error("the sentence is never painted");
  if (!/HIST_SHOWN_MS/.test(p)) throw new Error("the line never goes away");
  if (!/setTimeout\(paintHistoryEdge/.test(p)) {
    throw new Error("nothing comes back to take it down, so it stays until the next repaint");
  }
  return "from and to and a count, for a few seconds after the last chunk";
});

check("the edge note still wins when nothing is downloading", () => {
  /* The three states are exclusive and ordered: a download in flight, a
     download that just finished, and the end of history. Losing that
     order means claiming "this is all there is" mid-stream, which is
     the one thing this line must never be wrong about. */
  const f = liftFn(APP, "paintHistoryEdge");
  const i = f.indexOf("charts.hist_getting");
  const j = f.indexOf("historyShownNote()");
  const k = f.indexOf("historyEdgeNote()");
  if (!(i > 0 && j > i && k > j)) throw new Error("the three states are no longer in order");
  return "downloading, then just-finished, then the edge";
});

/* ── 5. the words ─────────────────────────────────────────────────── */

check("every new string exists in all three packs", () => {
  const want = {
    calendar: ["see_chart", "see_chart_none", "see_chart_short", "chart_not_yet", "chart_up_to_now"],
    charts: ["hist_getting", "hist_shown", "hist_loading"],
  };
  for (const [lang, pack] of Object.entries(PACKS)) {
    for (const [group, keys] of Object.entries(want)) {
      for (const key of keys) {
        if (!pack[group] || !pack[group][key]) throw new Error(`${lang} is missing ${group}.${key}`);
      }
    }
  }
  return "three packs, eight keys";
});

check("the placeholders survive translation", () => {
  const need = {
    "calendar.see_chart": ["{symbol}"],
    "charts.hist_getting": ["{have}", "{want}"],
    "charts.hist_shown": ["{from}", "{to}", "{n}", "{tf}"],
  };
  for (const [lang, pack] of Object.entries(PACKS)) {
    for (const [dotted, holes] of Object.entries(need)) {
      const [group, key] = dotted.split(".");
      const text = pack[group][key];
      for (const hole of holes) {
        if (!text.includes(hole)) throw new Error(`${lang} ${dotted} drops ${hole}`);
      }
    }
  }
  return "symbol, counts, dates";
});

check("no new string names an instrument", () => {
  /* House rule: help text never names a specific market - the symbol in
     see_chart is filled in from what is attached, not written down. */
  const words = /\b(EURUSD|XAUUSD|GBPUSD|gold|طلا|ذهب)\b/i;
  for (const [lang, pack] of Object.entries(PACKS)) {
    for (const key of ["see_chart", "see_chart_none", "see_chart_short", "chart_not_yet", "chart_up_to_now"]) {
      if (words.test(pack.calendar[key])) throw new Error(`${lang} calendar.${key} names an instrument`);
    }
    for (const key of ["hist_getting", "hist_shown"]) {
      if (words.test(pack.charts[key])) throw new Error(`${lang} charts.${key} names an instrument`);
    }
  }
});

check("the button is a real touch target on a phone", () => {
  const at = CSS.indexOf(".cal-chart-go{");
  if (at < 0) throw new Error("the button has no styles of its own");
  const block = CSS.slice(at, at + 400);
  if (!/inline-size:100%/.test(block)) throw new Error("it does not span the panel");
  const coarse = CSS.slice(at, at + 600);
  const m = /pointer:coarse\)\{ \.cal-chart-go\{ min-block-size:(\d+)px/.exec(coarse);
  if (!m || Number(m[1]) < 44) throw new Error("under 44px on a touch screen");
  return m[1] + "px on a coarse pointer";
});


/* --- the picker must not cost the news its space --------------------
   Reported immediately after the picker shipped: "the news card in the
   calendar got smaller - the news moved down and that area shrank."
   The day card's height is fixed (see .cal-day), so a control stacked
   ABOVE the release list is subtracted from the release list. */

check("the picker sits above the button, not beside it", () => {
  /* Side by side was tried and reported broken: the picker is not a
     bare <select> on screen but the desk's own .dd-wrap control, and
     two controls of different built widths sharing a line inside a
     panel this narrow collided. */
  if (!/cal-chart-row/.test(CAL)) throw new Error("calendar.js builds no wrapper");
  if (/cal-chart-sym/.test(CAL)) throw new Error("the old captioned field is still built");
  const at = CSS.indexOf(".cal-chart-row{");
  if (at < 0) throw new Error("the wrapper has no styles");
  const block = CSS.slice(at, at + 300);
  if (!/flex-direction:column/.test(block)) throw new Error("they are still side by side");
  const g = /gap:(\d+)px/.exec(block);
  if (!g || Number(g[1]) > 8) throw new Error("the gap between them is wider than it needs to be");
  const m = /margin:0 0 (\d+)px/.exec(block);
  if (!m) throw new Error("the pair does not declare its own bottom margin");
  if (Number(m[1]) > 12) throw new Error("it still pushes the news down");
  return `stacked, ${g[1]}px apart and ${m[1]}px above the releases`;
});

check("the picker reaches the button's own order in the markup", () => {
  const at = CAL.indexOf("cal-chart-row");
  const block = CAL.slice(at, at + 40);
  if (!/\$\{picker\}/.test(CAL.slice(at, at + 200)))
    throw new Error("the picker is not the first thing in the wrapper");
  return "picker first, button second";
});

check("the picker is a bare control, with no caption line to pay for", () => {
  if (!/cal-chart-pick/.test(CAL)) throw new Error("no picker class");
  /* No <span> caption: it says what it is through aria-label and title,
     which costs no vertical space and still reads out loud. */
  if (!/aria-label/.test(CAL.slice(CAL.indexOf("cal-chart-row") - 600, CAL.indexOf("cal-chart-row") + 900)))
    throw new Error("the picker has no accessible name without a caption");
  return "labelled without a caption";
});

check("both controls get the full width they were built for", () => {
  if (!/\.cal-chart-row > \.dd-wrap\{ inline-size:100% \}/.test(CSS))
    throw new Error("the picker does not span its line");
  if (!/\.cal-chart-pick\{ inline-size:100% \}/.test(CSS))
    throw new Error("the native control behind it does not either");
  return "100% each, on their own lines";
});

const bad = results.filter((r) => r === false).length;
console.log(`\ncalendar-chart-jump: ${bad ? bad + " FAILED of " + results.length : results.length + " checks passed"}`);
process.exit(bad ? 1 : 0);
