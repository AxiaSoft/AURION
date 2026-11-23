/**
 * Stopping a backtest that is already running.
 *
 * Asked for directly: "put an option in the backtest to cancel it". A
 * replay asks the AI for a fresh read on every bar, so a long window is
 * minutes of work, and a run started with the wrong symbol or the wrong
 * period could only be escaped by closing the desk.
 *
 * The button is the easy half. What these checks are really about is
 * everything that has to be true around it:
 *
 *   * it exists only while a run is going, and once pressed it SAYS it
 *     was pressed - the replay finishes its current bar before it
 *     notices, and a button that looks unpressed gets pressed again;
 *   * the request reaches an endpoint that exists, through the proxy
 *     and in the demo, or the trader is told the desk is read-only;
 *   * a stopped run is labelled in the result, because its figures
 *     cover fewer bars than the form above it asked for;
 *   * the refusal is a CODE, never an English sentence, because that
 *     is the only thing the desk can translate.
 *
 * The functions are executed, not grepped: a grep passes for the whole
 * life of the bug.
 *
 *     node tests/backtest-cancel.test.js
 */
import fs from 'node:fs';

const src = fs.readFileSync('apps/web/js/app.js', 'utf8');
const demo = fs.readFileSync('apps/web/js/demo.js', 'utf8');
const css = fs.readFileSync('apps/web/css/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const api = fs.readFileSync('engine/aurion/api/server.py', 'utf8');
const proxy = fs.readFileSync('backend/src/index.js', 'utf8');
const trader = fs.readFileSync('engine/aurion/runtime/trader.py', 'utf8');
const btengine = fs.readFileSync('engine/aurion/backtest/engine.py', 'utf8');
const packs = {
  en: JSON.parse(fs.readFileSync('lang/en.json', 'utf8')),
  fa: JSON.parse(fs.readFileSync('lang/fa.json', 'utf8')),
  ar: JSON.parse(fs.readFileSync('lang/ar.json', 'utf8')),
};

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

const grab = (name) => {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  // Keep an `async` prefix: slicing from `function` turns an async
  // function into one whose `await`s do not parse.
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
};

/* ------------------------------------------------- a DOM for two buttons */
function el(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    _cls: new Set(),
    classList: {
      toggle(name, on) { on ? this._owner._cls.add(name) : this._owner._cls.delete(name); },
    },
    querySelector() { return this._span; },
  };
}
function makeDom() {
  const nodes = {};
  for (const id of ['h-bt', 'bt-stop', 'bt-load']) {
    nodes[id] = el(id);
    nodes[id].classList._owner = nodes[id];
  }
  nodes['bt-load']._span = { textContent: '' };
  return nodes;
}

const harness = (over = {}) => {
  const dom = makeDom();
  const toasts = [];
  const posts = [];
  const stub = `
    const I18N={lang:'en',has:()=>true,t:(k)=>k};
    const dom=__dom, toasts=__toasts, posts=__posts;
    const $=(id)=>dom[id]||null;
    const liveSymbols=()=>[{symbol:'EURUSD'}];
    const toast=(m)=>toasts.push(String(m));
    const errText=(r)=>String((r&&(r.code||r.error))||'errors.generic');
    const API={post:async(p,b)=>{posts.push(p); return __reply(p,b);}};
    const S=__S;
  `;
  const fn = new Function('__dom', '__toasts', '__posts', '__reply', '__S',
    stub + [grab('setBacktestBusy'), grab('cancelBacktest')].join('\n') +
    '\nreturn {setBacktestBusy, cancelBacktest, S, dom, toasts, posts};');
  const S = over.S || { backtest: { running: true, progress: 40 }, _btBusy: true };
  const reply = over.reply || (async () => ({ ok: true, cancelling: true }));
  return fn(dom, toasts, posts, reply, S);
};

/* ------------------------------------------------------- 1. the markup */
const view = (() => {
  const i = src.indexOf('backtest() {');
  return src.slice(i, src.indexOf('\n  history() {', i));
})();
const card = view.slice(view.indexOf('id="bt-card"'), view.indexOf('id="bt-extra-card"'));
ok(card.includes('id="bt-stop"'), 'the form card carries a stop button');
ok(/id="bt-stop"[^>]*\$\{running \? "" : " hidden"\}/.test(card),
  'the stop button only exists while a run is going');
ok(card.includes('I18N.t("bt.cancel")'),
  'the stop button is labelled from the language pack, not in English');

/* --------------------------------------------- 2. what the button does */
{
  const h = harness();
  h.setBacktestBusy(true, 40);
  ok(h.dom['bt-stop'].hidden === false, 'a running replay shows the stop button');
  ok(h.dom['bt-stop'].disabled === false, 'and it can be pressed');
  ok(h.dom['bt-stop'].textContent === 'bt.cancel', 'it reads as a stop button');

  h.setBacktestBusy(false);
  ok(h.dom['bt-stop'].hidden === true, 'no run, no stop button');
}

{
  const h = harness();
  h.setBacktestBusy(true, 10);
  await h.cancelBacktest();
  ok(h.posts.includes('/api/backtest/cancel'),
    'pressing it asks the engine to stop the run');
  ok(h.dom['bt-stop'].textContent === 'bt.cancelling',
    'the button says the stop was asked for');
  ok(h.dom['bt-stop'].disabled === true,
    'and refuses a second press while it is being honoured');
  ok(h.toasts.length === 1, 'the trader is told the stop is on its way');
}

{
  /* A second press must not send a second request: the run is already
     stopping, and two cancels would read as "the first did nothing". */
  const h = harness();
  h.setBacktestBusy(true, 10);
  await h.cancelBacktest();
  await h.cancelBacktest();
  ok(h.posts.length === 1, 'pressing twice sends one request');
}

{
  /* The panel must not be torn down here. The run reports its own
     ending over the bus, exactly as a completed one does. */
  const h = harness();
  h.setBacktestBusy(true, 10);
  await h.cancelBacktest();
  ok(h.S._btBusy === true && h.dom['bt-load'].hidden !== true,
    'the live panel stays up until the engine says the run ended');
}

{
  /* A refusal has to surface, and surface translated. */
  const h = harness({ reply: async () => ({ ok: false, code: 'backtest_idle', error: 'no backtest is running' }) });
  h.setBacktestBusy(true, 10);
  const out = await h.cancelBacktest();
  ok(out === false, 'a refused stop reports failure');
  ok(h.toasts.some((t) => t.includes('backtest_idle')),
    'the refusal is shown by its code, not its English sentence');
  ok(h.dom['bt-stop'].disabled === false,
    'and the button becomes pressable again');
}

{
  /* Nothing running: there is nothing to stop, and no request to send. */
  const h = harness({ S: { backtest: { running: false }, _btBusy: false } });
  const out = await h.cancelBacktest();
  ok(out === false && h.posts.length === 0,
    'with no run in progress the button sends nothing');
}

{
  /* A dead connection must leave the button usable, not stuck. */
  const h = harness({ reply: async () => { throw new Error('offline'); } });
  h.setBacktestBusy(true, 10);
  await h.cancelBacktest();
  ok(h.dom['bt-stop'].disabled === false, 'a failed request re-arms the button');
  ok(h.toasts.length === 1, 'and says so');
}

/* ------------------------------------------------- 3. the waiting line */
{
  const h = harness();
  h.setBacktestBusy(true, 55);
  const before = h.dom['bt-load']._span.textContent;
  h.setBacktestBusy(true, 55, true);
  const after = h.dom['bt-load']._span.textContent;
  ok(before !== after, 'the progress line changes once a stop is asked for');
  ok(after.includes('bt.cancel_wait'), 'and says what it is waiting for');
  ok(after.includes('55'), 'while still showing how far the run got');
}

/* --------------------------------------------------------- 4. wiring */
ok(/stopBt\.onclick\s*=\s*\(\)\s*=>\s*cancelBacktest\(\)/.test(src),
  'the stop button is bound when the page is shown');
{
  const start = grab('startBacktest');
  ok(/_btCancelling = false/.test(start),
    'a new run clears any stop left over from the last one');
}
{
  const sock = src.slice(src.indexOf('if (msg.type === "backtest")'), src.indexOf('if (msg.type === "deals")'));
  ok(/setBacktestBusy\(Boolean\(d\.running\), d\.progress, Boolean\(d\.cancelling\)\)/.test(sock),
    'the socket path carries the cancelling state into the panel');
  ok(/d\.cancelled/.test(sock),
    'and a stopped run is announced as stopped, not as a plain finish');
}
{
  const watch = grab('watchBacktest');
  ok(/d\.cancelling/.test(watch), 'the polling fallback knows about cancelling too');
}
{
  const cardFn = grab('renderBacktestCard');
  ok(/bt\.cancelled/.test(cardFn) && /bt\.cancelled_note/.test(cardFn),
    'a stopped run is labelled on the result, so a short window is not read as the whole one');
}
ok(/cancelled: 1/.test(grab('btWhy')),
  'trades the stop closed are named rather than printed raw');

/* ---------------------------------------------------- 5. the endpoints */
ok(/@app\.post\("\/v1\/backtest\/cancel"\)/.test(api),
  'the engine exposes a cancel endpoint');
ok(/trader\.cancel_backtest\(\)/.test(api),
  'and it calls the trader rather than reaching into its state');
ok(/guarded\.post\("\/backtest\/cancel", passthrough\("POST", "\/v1\/backtest\/cancel"\)\)/.test(proxy),
  'the desk proxy forwards the cancel');
ok(/"\/api\/backtest\/cancel"/.test(demo),
  'the demo answers the cancel route instead of "read-only"');

/* ------------------------------------------------- 6. the engine stops */
ok(/async def cancel_backtest/.test(trader), 'the trader can call a run off');
ok(/_backtest_cancel = threading\.Event\(\)/.test(trader),
  'the stop is a thread event: the replay runs in a worker thread, so an asyncio cancel cannot reach it');
ok(/self\._backtest_cancel\.is_set,/.test(trader),
  'and the flag is handed to the backtester');
ok(/"code": "backtest_idle"/.test(trader),
  'refusing to cancel nothing carries a code the desk can translate');
ok(/should_stop/.test(btengine) && /stopped_at = max\(warmup, i - 1\)/.test(btengine),
  'the bar loop breaks where the trader stopped it');
ok(/"cancelled": True/.test(btengine),
  'and the result says it was stopped');

/* --------------------------------------------------------- 7. language */
const keys = ['cancel', 'cancelling', 'cancel_wait', 'cancel_sent', 'cancelled_toast', 'cancelled_note', 'why_cancelled'];
for (const [name, pack] of Object.entries(packs)) {
  const missing = keys.filter((k) => !pack.bt || !pack.bt[k]);
  ok(missing.length === 0, `${name} translates the stop control (${missing.join(', ') || 'all present'})`);
  ok(Boolean(pack.engerr && pack.engerr.backtest_idle), `${name} translates backtest_idle`);
}
for (const [name, pack] of Object.entries(packs)) {
  if (name === 'en') continue;
  ok(!/[A-Za-z]{4,}/.test(String(pack.bt.cancel) + String(pack.bt.cancelling)),
    `${name} actually translates the button rather than keeping English`);
}

/* ---------------------------------------------------------- 8. styling */
ok(/\.bt-cancelled\{/.test(css.replace(/\s+/g, '')) || /\.bt-cancelled\s*\{/.test(css),
  'the stopped-run note is styled');
ok(/#bt-stop\[hidden\]\{display:none\}/.test(css.replace(/\s+/g, '')),
  'the hidden attribute really hides the button');

console.log(fails ? `\n${fails} failed` : '\nall good');
process.exit(fails ? 1 : 0);
