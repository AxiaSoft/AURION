/**
 * The AI analysis must update in place, and the backtest must say which
 * lot rule it ran under.
 *
 * Two complaints, both about the desk telling the trader too little or
 * telling it too disruptively:
 *
 *   1. "I don't want the whole page refreshing all the time, I want the
 *      analysis shown live." The card used to be rebuilt with
 *      card.replaceWith(fresh) on every tick. Every node was a new node,
 *      so anything the reader had done to the old ones - scrolled a
 *      console, opened or closed a <details>, put a text selection
 *      somewhere - was thrown away roughly once a second. It read as the
 *      page constantly refreshing because, in the only sense that
 *      matters to a reader, it was.
 *
 *   2. The backtest had to run under the robot's own lot rule, auto or
 *      fixed. The engine already did; nothing in the result said so, so
 *      there was no way to tell a correct run from an incorrect one.
 *
 * Both are behavioural, so the real functions run against a real DOM.
 * A grep would pass the entire time either bug existed: replaceWith and
 * morphElement produce identical markup, and that is precisely the
 * point - the difference is node identity, which only execution shows.
 *
 *     node tests/analysis-inplace.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'apps', 'web');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

/* ------------------------------------------------------------ the desk */
const FILES = ['themes.js', 'skins.js', 'i18n.js', 'api.js', 'calendar.js',
  'chart-series.js', 'charts.js', 'chart-tools.js', 'pnl-charts.js', 'app.js'];
const src = FILES.map((f) => fs.readFileSync(path.join(WEB, 'js', f), 'utf8')).join('\n;\n');

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
win.fetch = () => new Promise(() => {});
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
win.ResizeObserver = win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
win.URL.createObjectURL = () => 'blob:x';
win.AudioContext = class {};
win.HTMLCanvasElement.prototype.getContext = () => null;
win.requestAnimationFrame = (f) => { f(0); return 1; };
win.eval(src + ';window.__T={patchAnalysisCard,analysisCardHtml,morphElement,stampAnalysisAge,'
  + 'btProvenance,btLotProvenance,S,I18N};');

const T = win.__T;
const S = T.S;
const doc = win.document;

/* ============================================= 1. the analysis updates
                                                    without being rebuilt */

const snap = (conf, blockers, ready) => ({
  analysis: {
    symbol: 'EURUSD', timeframe: 'M15', strategy: 'ema_rsi', strategy_enabled: true,
    ready: !!ready, setup: ready ? {} : null, when: 'waiting for a cross',
    ai: { confidence: conf, min_confidence: 0.6, gate: true },
    blockers: blockers || [{ text: 'spread too wide', fix: 'wait' }],
    console: ['one', 'two', 'three'], refusals: [], resting: [],
  },
});

S.snap = snap(0.61);
doc.getElementById('host').innerHTML = T.analysisCardHtml();
S._anHtml = T.analysisCardHtml();

const card0 = doc.getElementById('an-card');
const conf0 = card0.querySelector('.ai-conf-head b');
const state0 = card0.querySelector('.ai-v-state');
const why0 = card0.querySelector('.an-why');
const det0 = card0.querySelector('details.ai-console');

/* A plain JS property is the honest identity marker: the morph never
   copies properties, so if the node survived, this survives with it. */
conf0.__id = 'confidence';
if (why0) why0.__id = 'blockers';

S.snap = snap(0.62);
T.patchAnalysisCard();
const card1 = doc.getElementById('an-card');

ok(card1 === card0, 'the card element itself is never replaced');
ok(card1.querySelector('.ai-conf-head b') === conf0, 'the confidence node is the same node');
ok(conf0.__id === 'confidence', 'it really is the original node, not a lookalike');
ok(card1.querySelector('.ai-v-state') === state0, 'the verdict line is the same node');
ok(card1.querySelector('.an-why') === why0, 'the blocker list is the same node');

/* ...and it must still actually update, or "in place" just means "stale". */
ok(conf0.textContent.trim() === '62%', `the confidence figure updated (${conf0.textContent.trim()})`);

S.snap = snap(0.62, [{ text: 'news window', fix: 'wait for 14:30' }]);
T.patchAnalysisCard();
ok(/news window/.test(card0.textContent), 'changed blocker text is written through');
ok(!/spread too wide/.test(card0.textContent), 'and the old text is gone');
ok(card0.querySelector('.an-why') === why0, 'the list node was reused rather than swapped');

S.snap = snap(0.62, [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
T.patchAnalysisCard();
ok(card0.querySelectorAll('.an-why li').length === 3, 'a longer list grows');
S.snap = snap(0.62, [{ text: 'only' }]);
T.patchAnalysisCard();
ok(card0.querySelectorAll('.an-why li').length === 1, 'a shorter list shrinks');

/* ---------------------------------- what the reader did is not undone */

ok(det0 && det0.open === true, 'the console starts open');
det0.open = false;
for (let i = 0; i < 5; i++) { S.snap = snap(0.63 + i * 0.01, [{ text: 'only' }]); T.patchAnalysisCard(); }
ok(card0.querySelector('details.ai-console').open === false,
  'a console the reader closed stays closed across five updates');

det0.open = true;
S.snap = snap(0.70, [{ text: 'only' }]);
T.patchAnalysisCard();
ok(card0.querySelector('details.ai-console').open === true,
  'and one they reopened stays open');

const con = doc.getElementById('an-console');
if (con) {
  con.scrollTop = 42;
  S.snap = snap(0.71, [{ text: 'only' }]);
  T.patchAnalysisCard();
  ok(doc.getElementById('an-console').scrollTop === 42,
    'a scrolled console keeps its scroll position');
}

/* The age stamp lives outside the cached markup and is written by
   stampAnalysisAge. Reconciling it would blank it on every tick. */
S._anAt = Date.now() - 5000;
T.stampAnalysisAge();
const stamped = doc.getElementById('an-live').textContent;
ok(stamped.length > 0, 'the age stamp is written');
S.snap = snap(0.72, [{ text: 'only' }]);
T.patchAnalysisCard();
ok(doc.getElementById('an-live').textContent === stamped,
  'and an update does not blank it');

/* Structure that genuinely changes must still change. */
S.snap = snap(0.90, [], true);
T.patchAnalysisCard();
ok(/is-ready/.test(doc.getElementById('an-card').className),
  'the card restyles when the verdict flips to ready');
ok(doc.getElementById('an-card') === card0,
  'even a verdict flip reuses the card rather than replacing it');

/* The identical-markup short circuit must still hold, or every tick
   walks the tree for nothing. */
{
  const before = card0.querySelectorAll('*').length;
  S._anHtml = T.analysisCardHtml();
  T.patchAnalysisCard();
  ok(doc.getElementById('an-card') === card0 && card0.querySelectorAll('*').length === before,
    'an unchanged analysis is not re-rendered at all');
}

/* ------------------------------------------------- morphElement itself */
{
  const make = (html) => { const d = doc.createElement('div'); d.innerHTML = html; return d; };

  const a = make('<p class="x" title="old">hi</p>');
  const p0 = a.firstElementChild;
  T.morphElement(p0, make('<p class="y">bye</p>').firstElementChild);
  ok(a.firstElementChild === p0, 'morph keeps a matching node');
  ok(p0.className === 'y', 'it syncs changed attributes');
  ok(!p0.hasAttribute('title'), 'and removes ones that are gone');
  ok(p0.textContent === 'bye', 'and updates the text');

  const b = make('<div><span>a</span></div>');
  const span = b.firstElementChild.firstElementChild;
  T.morphElement(b.firstElementChild, make('<div><em>a</em></div>').firstElementChild);
  ok(b.firstElementChild.firstElementChild !== span, 'a different tag is replaced, not morphed');
  ok(b.firstElementChild.firstElementChild.tagName === 'EM', 'and replaced with the right one');

  /* The attributes the reader owns. The fresh markup always carries
     them; copying them across is what reopened a closed console. */
  const c = make('<details open><p>x</p></details>');
  c.firstElementChild.open = false;
  T.morphElement(c.firstElementChild, make('<details open><p>y</p></details>').firstElementChild);
  ok(c.firstElementChild.open === false, 'morph never re-applies "open"');
  ok(c.firstElementChild.textContent === 'y', 'while still updating the content inside it');

  const d = make('<input value="a" />');
  d.firstElementChild.value = 'typed';
  T.morphElement(d.firstElementChild, make('<input value="b" />').firstElementChild);
  ok(d.firstElementChild.value === 'typed', 'and never clobbers what someone has typed');
}

/* ------------------------------------------------- no rebuild in source */
{
  const app = fs.readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const i = app.indexOf('function patchAnalysisCard(');
  const body = app.slice(i, app.indexOf('\nfunction ', i + 10));
  ok(!/replaceWith/.test(body), 'patchAnalysisCard no longer replaces the card');
  ok(/morphElement/.test(body), 'it reconciles instead');
}

/* ========================================== 2. which lot rule it ran on */

const prov = (bt) => {
  const html = T.btProvenance(bt);
  return typeof html === 'string' ? html : String(html || '');
};

{
  const base = { symbol: 'EURUSD', timeframe: 'M15', strategy: 'ema_rsi',
    data: { source: 'mt5', tested_bars: 3000, first_bar: '2024-01-01', last_bar: '2024-06-01' } };

  const auto = prov({ ...base, volume_mode: 'auto', manual_volume: 0, max_open: 3 });
  const fixed = prov({ ...base, volume_mode: 'manual', manual_volume: 0.25, max_open: 1 });

  ok(auto !== fixed, 'the two lot rules do not read the same');
  ok(/prov_lot_auto|[Aa]uto/.test(auto), 'an auto-lot run says so');
  ok(/0\.25/.test(fixed), 'a fixed-lot run shows the lot it used');
  ok(!/0\.25/.test(auto), 'and an auto run does not invent one');
  ok(/3/.test(auto), 'the concurrent-position cap is shown');

  /* The figures must come from the run, never from a default. A result
     that silently reports "auto" for a run that used a fixed lot is
     worse than reporting nothing. */
  const other = prov({ ...base, volume_mode: 'manual', manual_volume: 0.5, max_open: 1 });
  ok(/0\.5/.test(other) && !/0\.25/.test(other), 'the lot is read from the run, not cached');

  const lot = (bt) => String(T.btLotProvenance(bt) || '');
  ok(lot({ ...base, volume_mode: 'manual', manual_volume: 0.1, max_open: 1 }).includes('0.1'),
    'btLotProvenance reports the manual lot');
  ok(!/undefined|NaN|null/.test(auto + fixed), 'no placeholder leaks into the text');
}

/* ---------------------------------------------------------- translated */
{
  const packs = ['en', 'fa', 'ar'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, 'lang', l + '.json'), 'utf8'))]);
  const btKeys = ['prov_lot_auto', 'prov_lot_manual', 'prov_max_open', 'replay_wait', 'replay_outside'];
  for (const [l, pack] of packs) {
    const missing = btKeys.filter((k) => !pack.bt || !pack.bt[k]);
    ok(missing.length === 0, `${l} translates the new backtest lines (${missing.join(', ') || 'all present'})`);
  }
  ok(!/EURUSD|XAUUSD|gold/i.test(JSON.stringify(packs.map(([, p]) => btKeys.map((k) => p.bt[k])))),
    'the new help text names no specific instrument');
}

console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
