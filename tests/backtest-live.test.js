/**
 * The backtest, while it is running, and where its result lands.
 *
 * Three faults were reported together:
 *   1. the result was split across two cards with the form wedged
 *      between them, instead of arriving in one container;
 *   2. nothing scrolled to it on the socket path, so a result the
 *      trader had scrolled away from appeared off-screen;
 *   3. a run in progress showed a spinner and a percentage and nothing
 *      about the symbol it was replaying.
 *
 * These are wiring questions, so the real functions are executed against
 * a small DOM rather than grepped for. A grep would pass the entire time
 * the bug exists.
 *
 *     node tests/backtest-live.test.js
 */
import fs from 'node:fs';

const src = fs.readFileSync('apps/web/js/app.js', 'utf8');
const css = fs.readFileSync('apps/web/css/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const en = JSON.parse(fs.readFileSync('lang/en.json', 'utf8'));
const fa = JSON.parse(fs.readFileSync('lang/fa.json', 'utf8'));
const ar = JSON.parse(fs.readFileSync('lang/ar.json', 'utf8'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

/* ---------------------------------------------------- pull the functions */
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
};

/* A DOM just big enough for the panel: elements by id, class queries and
   textContent. Writing innerHTML re-parses, so "did a rebuild happen" is
   observable, which is the thing these checks are about. */
function makeEl(tag = 'div') {
  const el = {
    tag,
    attrs: {},
    style: {},
    children: [],
    _html: '',
    textContent: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this.parses = (this.parses || 0) + 1;
      this.children = parseish(String(v));
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const want = sel.trim().split(/\s+/).pop();
      return el.children.filter((c) => c.matches(want));
    },
    matches(sel) {
      if (sel.startsWith('#')) return this.attrs.id === sel.slice(1);
      if (sel.startsWith('.')) return (this.cls || []).includes(sel.slice(1));
      const m = /^([a-z]+)?(?:\.(.+))?$/.exec(sel);
      if (!m) return false;
      if (m[1] && this.tag !== m[1]) return false;
      if (m[2] && !(this.cls || []).includes(m[2])) return false;
      return true;
    },
    classList: { add() {}, remove() {}, toggle() {} },
    scrollIntoView() { el.revealed = (el.revealed || 0) + 1; },
  };
  return el;
}

/* A deliberately small HTML reader: enough to find the tags the updater
   writes into (.bt-prog, .bt-prog i, .bt-prog b, .bt-kv b, #bt-curve). */
function parseish(html) {
  const out = [];
  const re = /<([a-z]+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const node = makeEl(m[1]);
    const attrs = m[2] || '';
    const id = /id="([^"]+)"/.exec(attrs);
    const cl = /class="([^"]+)"/.exec(attrs);
    if (id) node.attrs.id = id[1];
    node.cls = cl ? cl[1].split(/\s+/) : [];
    // tags nested inside .bt-prog / .bt-kv need to answer "i", "b"
    out.push(node);
  }
  return out;
}

const stub = `
  const I18N={lang:'en',locale:()=>'en-US',t:(k)=>k};
  const esc=(x)=>String(x);
  const fmt=(v,d=2)=>Number(v||0).toFixed(d);
  const clsPnl=(n)=>Number(n)>0?'up':Number(n)<0?'down':'';
  const S={backtest:null};
  let curveDraws=0, chartPaints=0, replayDraws=0, replayBars=0, replayMarks=0;
  const requestAnimationFrame=(f)=>{f();};
  const drawEquityCurve=(c)=>{curveDraws++; S._lastCurve=c;};
  // Still stubbed, so that a panel which went back to pulling the live
  // feed would register here rather than throwing.
  const paintMiniCharts=()=>{chartPaints++;};
  const drawReplayChart=(b,m)=>{replayDraws++; replayBars=(b||[]).length; replayMarks=(m||[]).length;};
  const counts=()=>({curveDraws, chartPaints, replayDraws, replayBars, replayMarks});
  // Only the canvas lookup; the panel itself is passed in as \`box\`.
  const $=()=>null;
  let fetches=0;
  const API={get:()=>{fetches++; return new Promise(()=>{});}};
  const ResizeObserver=class{observe(){}disconnect(){}};
  const fetchCount=()=>fetches;
`;
/* paintReplay and the window it chooses are real here. Stubbing them
   would have let the panel fall back to the live feed -- which is the
   one thing it must never do -- without a single test noticing. */
const api = new Function(
  stub + ['btNormBar', 'btReplayWindow', 'btWatchReplaySize', 'ensureBacktestBars',
          'paintReplay', 'renderBacktestLive', 'paintBacktestLive'].map(grab).join('\n') +
  '\nconst BT_REPLAY_SPAN = ' + (src.match(/BT_REPLAY_SPAN = (\d+)/) || [, '160'])[1] + ';' +
  '\nreturn {renderBacktestLive, paintBacktestLive, btReplayWindow, btNormBar, S, counts, fetchCount};'
)();

/* ------------------------------------------------ 1. one container */
const view = (() => {
  const i = src.indexOf('backtest() {');
  return src.slice(i, src.indexOf('\n  history() {', i));
})();

ok(/id="bt-extra-card"[\s\S]*id="bt-result"/.test(view),
  'the summary now renders inside the results card');
ok(/id="bt-extra-card"[\s\S]*id="bt-live"/.test(view),
  'the running panel renders inside the results card too');
const card = view.slice(view.indexOf('id="bt-card"'), view.indexOf('id="bt-extra-card"'));
ok(!card.includes('id="bt-result"'),
  'the form card no longer carries half the result');
ok(card.includes('id="bt-load"'),
  'the form card keeps the form and its progress line');
const resCard = view.slice(view.indexOf('id="bt-extra-card"'));
for (const id of ['bt-live', 'bt-result', 'bt-extra']) {
  ok(resCard.includes(`id="${id}"`), `${id} sits in the single results container`);
}

/* ------------------------------------------------ 2. landing on results */
const sock = src.slice(src.indexOf('if (msg.type === "backtest")'), src.indexOf('if (msg.type === "deals")'));
ok(/paintBacktestResults\(d, \{ reveal: !d\.running \}\)/.test(sock),
  'the socket path reveals the result when the run ends');
ok(!/const box = \$\("bt-result"\)/.test(sock),
  'the socket path no longer repaints only the summary, leaving the curve stale');

const paint = grab('paintBacktestResults');
ok(paint.includes('scrollIntoView'), 'revealing still scrolls the card into view');
ok(paint.includes('prefers-reduced-motion'), 'the scroll respects reduced motion');
ok(paint.includes('is-fresh'), 'the card flashes so the eye finds what changed');
ok(/running\b/.test(paint) && paint.includes('paintBacktestLive'),
  'painting routes the running state to the live panel');
ok(/if \(!running && bt\.ok/.test(paint),
  'the finished curve is only drawn once the run is actually finished');

const watch = grab('watchBacktest');
ok(watch.includes('paintBacktestResults(d, { reveal: true })'),
  'the polling fallback still reveals the finished result');
ok(/d\.running[\s\S]{0,260}paintBacktestResults\(d\)/.test(watch),
  'the polling fallback also drives the live panel');

const runner = src.slice(src.indexOf('const goBt = $("h-bt")'), src.indexOf('if (view === "history")'));
ok(/paintBacktestResults\(S\.backtest, \{ reveal: true \}\)/.test(runner),
  'starting a run scrolls to the panel the result will appear in');

/* ------------------------------------------------ 3. the live view */
ok(api.renderBacktestLive({ running: false, ok: true }) === '',
  'a finished run renders no live panel');

const started = api.renderBacktestLive({ running: true, symbol: 'EURUSD', timeframe: 'M15', strategy: 'ema_rsi', progress: 0 });
// The panel used to embed the watchlist's live-feed thumbnail here, so
// the chart on screen was the market as it is now while the figures
// beside it replayed a window in the past. It draws the replay itself.
ok(!started.includes('data-mini'), 'the running panel no longer shows the live market');
ok(started.includes('id="bt-replay"'), 'the running panel has its own replay canvas');
ok(started.includes('EURUSD') && started.includes('ema_rsi'), 'the panel names the symbol and strategy');
ok(started.includes('role="progressbar"'), 'progress is announced to assistive tech');
ok(!started.includes('id="bt-curve"'), 'no equity canvas before any equity has been reported');
ok(started.includes('—'), 'figures not yet reported show a dash, never a stand-in number');
ok(!/\b10000\b|\b0\.00\b/.test(started.replace(/width:0%/, '')),
  'an unstarted run invents no equity figure');

const mid = {
  running: true, symbol: 'EURUSD', timeframe: 'M15', strategy: 'ema_rsi', progress: 42,
  live: { equity: 10250.5, peak: 10300, equity_curve: [10000, 10100, 10250.5], trades_so_far: 7, at: '2026.01.04 12:00:00', open_side: 'buy' },
};
const half = api.renderBacktestLive(mid);
ok(half.includes('width:42%'), 'the bar reflects the reported progress');
ok(half.includes('10250.50'), 'live equity is the figure the engine reported');
ok(half.includes('7'), 'the closed-trade count is shown while running');
ok(half.includes('2026.01.04 12:00:00'), 'the bar the replay has reached is shown');
ok(half.includes('BUY'), 'an open position is shown while running');
ok(half.includes('id="bt-curve"'), 'the equity curve appears once there is a curve to draw');

/* --------------------------------- the updater does not thrash the chart */
const box = makeEl();
box.attrs.id = 'bt-live';
api.paintBacktestLive(box, mid, true);
const afterFirst = { ...api.counts(), parses: box.parses };
ok(box.parses === 1, 'the panel is built once when the run starts');
ok(afterFirst.chartPaints === 0, 'the panel never reaches for the live market feed');
ok(afterFirst.curveDraws === 1, 'the live curve is drawn');

const next = { ...mid, progress: 55, live: { ...mid.live, equity: 10400, trades_so_far: 9, at: '2026.01.05 09:00:00', open_side: null } };
api.paintBacktestLive(box, next, true);
ok(box.parses === 1, 'a later snapshot updates in place instead of rebuilding');
ok(api.counts().curveDraws === 2, 'the curve is redrawn on the new snapshot');
ok(api.counts().chartPaints === 0, 'and still never reaches for it on a later snapshot');
ok(box.querySelector('.bt-prog i').style.width === '55%', 'the progress bar moved');
ok(box.querySelector('.bt-prog').getAttribute('aria-valuenow') === '55', 'the announced value moved too');
const kv = box.querySelectorAll('.bt-kv b');
ok(kv[0].textContent === '10400.00', 'equity updated in place');
ok(kv[1].textContent === '9', 'the trade count updated in place');
ok(kv[2].textContent === '2026.01.05 09:00:00', 'the current bar updated in place');
ok(kv[3].textContent === '—', 'a closed position reads as a dash, not a stale side');

// a different run must rebuild, or it would chart the previous symbol
const other = { ...mid, symbol: 'XAUUSD' };
api.paintBacktestLive(box, other, true);
ok(box.parses === 2, 'a different run rebuilds the panel');
ok(box.innerHTML.includes('id="bt-replay"'), 'and gives the new run a replay canvas');
ok(!box.innerHTML.includes('data-mini'), 'without dragging the live feed back in');

/* ------------------------------------------- the replay is what is drawn */
const withBars = {
  ...mid,
  live: {
    ...mid.live,
    at: 'b2',
    replay_bars: [
      { t: 'b0', o: 1, h: 2, l: 0.5, c: 1.5 },
      { t: 'b1', o: 1.5, h: 2.5, l: 1, c: 1.2 },
      { t: 'b2', o: 1.2, h: 1.8, l: 0.9, c: 1.7 },
    ],
    marks: [{ t: 'b1', kind: 'in', side: 'buy', price: 1.5, volume: 0.1 }],
  },
};
const box2 = makeEl();
box2.attrs.id = 'bt-live';
const before = api.counts().replayDraws;
api.paintBacktestLive(box2, withBars, true);
const after = api.counts();
ok(after.replayDraws === before + 1, 'a progress update draws the bars being replayed');
ok(after.replayBars === 3, 'every bar the engine sent reaches the chart');
ok(after.replayMarks === 1, "and so do the run's own trades");

const moved = { ...withBars, live: { ...withBars.live, at: 'b3', replay_bars: [...withBars.live.replay_bars, { t: 'b3', o: 1.7, h: 2.2, l: 1.6, c: 2.1 }] } };
api.paintBacktestLive(box2, moved, true);
ok(api.counts().replayDraws === before + 2, 'the chart is repainted as the replay moves on');
ok(api.counts().replayBars === 4, 'the new bar is on it');

api.paintBacktestLive(box, { running: false, ok: true }, false);
ok(box.innerHTML === '', 'the live panel clears when the run finishes');
ok(box.getAttribute('data-run') === null, 'and forgets which run it was showing');

/* ----------------------------------- the chart when the engine sends none

   Reported as "the live chart is blank". An older engine - or one whose
   progress payload is trimmed - sends no replay_bars at all, and the
   panel then had nothing to draw. The desk now falls back to the candles
   it can fetch for itself. What it must NOT do is draw the live market:
   a replay that silently becomes "now" is worse than a blank box,
   because it looks right. */
{
  const bar = (t, c) => ({ t, o: c, h: c + 1, l: c - 1, c });
  const cached = [];
  for (let i = 0; i < 400; i++) cached.push(bar('2024-01-01T' + String(i).padStart(4, '0'), 100 + i));
  const run = { symbol: 'EURUSD', timeframe: 'M15', running: true };

  api.S._btBars = null;
  ok(api.btReplayWindow(run, {}).source === 'none',
    'with nothing cached and nothing sent, the window is empty');

  api.S._btBars = { key: 'EURUSD|M15', pending: false, bars: cached };

  const w = api.btReplayWindow(run, { at: cached[300].t });
  ok(w.source === 'desk', 'the desk supplies the window when the engine sends none');
  ok(w.bars.length === 160, `the window is bounded (${w.bars.length})`);
  ok(w.bars[w.bars.length - 1].t === cached[300].t,
    'the window ends exactly on the bar the replay has reached');
  ok(w.bars[0].t === cached[141].t, 'and starts one span earlier');

  const later = api.btReplayWindow(run, { at: cached[340].t });
  ok(later.bars[later.bars.length - 1].t === cached[340].t,
    'the window moves forward with the run');

  ok(api.btReplayWindow(run, { at: '1999-01-01T0000' }).source === 'unmatched',
    'a bar the desk has never seen yields no window');
  ok(api.btReplayWindow(run, { at: '1999-01-01T0000' }).bars.length === 0,
    'and emphatically not the live tail');
  ok(api.btReplayWindow(run, {}).source === 'unmatched',
    'no reported bar yields no window either');

  ok(api.btReplayWindow({ symbol: 'GBPUSD', timeframe: 'M15', running: true },
    { at: cached[300].t }).source === 'none',
    'a cache for another symbol is not reused');

  /* The engine still wins when it does send bars. */
  const sent = [bar('e1', 10), bar('e2', 11), bar('e3', 12)];
  const eng = api.btReplayWindow(run, { at: cached[300].t, replay_bars: sent });
  ok(eng.source === 'engine' && eng.bars.length === 3,
    'engine-sent bars still take precedence');

  /* Both bar shapes normalise: the progress payload uses {t,o,h,l,c},
     /api/candles uses {time,open,high,low,close}. */
  const n = api.btNormBar({ time: 'x', open: '1.5', high: '2', low: '1', close: '1.8' });
  ok(n && n.t === 'x' && n.o === 1.5 && n.c === 1.8, 'the candles endpoint shape is accepted');
  ok(api.btNormBar({ t: 'x', o: 0, h: 1, l: 0, c: 1 }) === null, 'a zero price is rejected');
  ok(api.btNormBar({ t: 'x', o: NaN, h: 1, l: 1, c: 1 }) === null, 'a non-finite price is rejected');
  ok(api.btNormBar(null) === null, 'and so is nothing at all');

  api.S._btBars = null;
}

/* ------------------------------------------------ styling and language */
ok(/\.bt-live-chart\{[^}]*height:/.test(css), 'the live chart has a height, so its canvas can size itself');
ok(/\.bt-prog\{/.test(css) && /\.bt-prog i\{/.test(css), 'the progress bar is styled');
ok(/prefers-reduced-motion[\s\S]*?\.bt-prog i\{transition:none\}/.test(css),
  'the bar does not animate for a trader who asked for no motion');
ok(/@media \(max-width:760px\)\{[^}]*\}[\s\S]{0,120}\.bt-live-chart\{height:200px\}/.test(css)
  || /max-width:760px[\s\S]{0,200}\.bt-live-chart\{height:200px\}/.test(css),
  'the live chart is shorter on a phone');

const keys = ['live_running', 'live_equity', 'live_trades', 'live_bar', 'live_position', 'live_chart_hint', 'live_curve_hint'];
for (const [name, pack] of [['en', en], ['fa', fa], ['ar', ar]]) {
  const missing = keys.filter((k) => !pack.bt || !pack.bt[k]);
  ok(missing.length === 0, `${name} translates the live panel (${missing.join(', ') || 'all present'})`);
}
ok(!/EURUSD|XAUUSD|gold/i.test(JSON.stringify([en.bt, fa.bt, ar.bt])),
  'the new help text names no specific instrument');

console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
