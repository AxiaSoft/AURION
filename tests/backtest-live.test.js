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
  let curveDraws=0, chartPaints=0;
  const requestAnimationFrame=(f)=>{f();};
  const drawEquityCurve=(c)=>{curveDraws++; S._lastCurve=c;};
  const paintMiniCharts=()=>{chartPaints++;};
  const counts=()=>({curveDraws, chartPaints});
`;
const api = new Function(
  stub + grab('renderBacktestLive') + '\n' + grab('paintBacktestLive') +
  '\nreturn {renderBacktestLive, paintBacktestLive, S, counts};'
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
ok(started.includes('data-mini="EURUSD"'), "the running panel charts the run's own symbol");
ok(started.includes('data-tf="M15"'), 'the chart uses the timeframe being replayed');
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
ok(afterFirst.chartPaints === 1, "the symbol's candles are fetched when the panel appears");
ok(afterFirst.curveDraws === 1, 'the live curve is drawn');

const next = { ...mid, progress: 55, live: { ...mid.live, equity: 10400, trades_so_far: 9, at: '2026.01.05 09:00:00', open_side: null } };
api.paintBacktestLive(box, next, true);
ok(box.parses === 1, 'a later snapshot updates in place instead of rebuilding');
ok(api.counts().curveDraws === 2, 'the curve is redrawn on the new snapshot');
ok(api.counts().chartPaints === 1, 'the candle chart is not re-requested on every snapshot');
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
ok(box.innerHTML.includes('data-mini="XAUUSD"'), 'and charts the new symbol');

api.paintBacktestLive(box, { running: false, ok: true }, false);
ok(box.innerHTML === '', 'the live panel clears when the run finishes');
ok(box.getAttribute('data-run') === null, 'and forgets which run it was showing');

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
