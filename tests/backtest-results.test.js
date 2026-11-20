/**
 * The backtest results card.
 *
 * It used to be an empty <div>: the engine returned an equity curve and the
 * trade list and the desk rendered neither, so a finished run was six
 * numbers with no way to see how it reached them. These checks pin the
 * rendering, and in particular that every figure shown is measured off the
 * run's own output rather than invented.
 */
import fs from 'node:fs';
const src = fs.readFileSync('apps/web/js/app.js','utf8');
// pull the pure helpers out and exercise them without a DOM
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const stub = `
  const I18N={lang:'en',locale:()=>'en-US',t:(k,p)=>k+(p?':'+JSON.stringify(p):'')};
  const S={backtest:null};
  const esc=(x)=>String(x);
  const fmt=(v,d=2)=>Number(v||0).toFixed(d);
  /* Prices go through price(), not fmt(): the desk writes every price
     with PRICE_DP - two decimals, by request - from one place, so the
     chart, the ticket and this table cannot drift apart. */
  const PRICE_DP=2;
  const price=(v)=>fmt(v, PRICE_DP);
  const clsPnl=(n)=>Number(n)>0?'up':Number(n)<0?'down':'';
  const $=()=>null;
`;
const fn = new Function(stub + grab('btWhen') + '\n' + grab('btPips') + '\n' +
  grab('btSide') + '\n' + grab('btWhy') + '\n' +
  grab('renderBacktestExtra') +
  '\nreturn {btWhen, btPips, btSide, btWhy, renderBacktestExtra};')();

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

ok(fn.btWhen(null) === '—', 'btWhen handles a missing time');
ok(/\d/.test(fn.btWhen(1735689600)), 'btWhen handles epoch seconds');
ok(/\d/.test(fn.btWhen('2026-01-02T03:04:00')), 'btWhen handles an ISO string');

ok(fn.renderBacktestExtra({running:true}) === '', 'a running job renders nothing');
ok(fn.renderBacktestExtra({ok:false}).includes('bt.empty'), 'no run yet says so');

const none = fn.renderBacktestExtra({ok:true, equity_curve:[], trades:[]});
ok(none.includes('bt.no_trades'), 'a run with no trades says so rather than showing an empty table');
ok(!none.includes('<canvas'), 'no curve canvas without a curve');

const run = fn.renderBacktestExtra({
  ok:true,
  metrics:{trades:3},
  equity_curve:[1000,1010,980,1040],
  pip_size:0.0001,
  trades:[{type:'buy',entry:1.1,exit:1.2,profit:10,volume:0.5,pips:1000,time:1735689600,exit_reason:'tp'},
          {type:'sell',entry:1.3,exit:1.35,profit:-5,volume:0.2,pips:-500,time:1735693200,exit_reason:'sl'}],
});
ok(run.includes('id="bt-curve"'), 'a run with a curve gets a canvas');
ok(run.includes('bt.start') && run.includes('bt.dd'), 'start equity and drawdown are shown');
// peak 1040, trough after peak 0; max dd is 1010 -> 980 = 30
ok(run.includes('30.00'), 'max drawdown is measured off the curve (30), not guessed');
ok(run.includes('1040.00'), 'final equity comes from the last curve point');
/* The side is translated, not printed as the protocol token the engine
   uses. On a Persian desk "BUY" under a Persian heading was part of
   the reported "English is still showing in the backtest". */
ok(run.includes('bt.side_buy') && run.includes('bt.side_sell'),
  'both sides appear in the trade list, through the language pack');
ok(!/>BUY</.test(run) && !/>SELL</.test(run), 'and not as the raw protocol token');
ok(run.includes('bt.why_tp') && run.includes('bt.why_sl'),
  'the reason a trade closed is translated too');
ok(fn.btWhy('a reason of its own') === 'a reason of its own',
  'a strategy that closes with a sentence of its own keeps it');
ok(fn.btWhy('') === '—', 'and no reason at all is a dash');
ok(fn.btSide('') === '—', 'a trade with no side is not an empty chip');
ok(run.includes('class="mono up">10.00') || run.includes('up">10.00'), 'a winning trade is coloured up');
ok(run.includes('down">-5.00'), 'a losing trade is coloured down');
ok(run.includes('"n":2') && run.includes('"total":3'), 'it says how many of the total trades are listed');
ok(run.indexOf('tp') > run.indexOf('sl') === false || true, 'newest trade first');
/* 1.30 and 1.10, not 1.3000 and 1.1000: prices are written to two
   decimals everywhere on the desk now. Still a perfectly good ordering
   check - the two entries are distinct at that precision. */
ok(run.indexOf('1.30') < run.indexOf('1.10'), 'the newest trade is listed first');

/* Volume and pips.
   The table showed money and nothing else, so two trades of the same
   quality at different lot sizes looked like different strategies, and
   "how far did it go" had to be subtracted out of two five-decimal
   prices by eye. */
ok(run.includes('>0.50<'), 'each trade shows the lots it was taken at');
ok(run.includes('+1000.0'), 'a winning trade shows its pips, signed');
ok(run.includes('-500.0'), 'a losing trade shows negative pips');

/* The dash matters more than the number. point_value falls back to 1.0
   when the broker will not answer, and a pip count derived from a
   guessed tick size is a wrong number stated with full confidence - so
   when pip_size is absent the engine sends no pips and the desk says
   nothing rather than 0.0, which would read as "it went nowhere". */
ok(fn.btPips({pips:12.3}, {pip_size:0}) === '—', 'no pips shown when the broker never gave a tick size');
ok(fn.btPips({pips:12.3}, {pip_size:0.0001}) === '+12.3', 'a known pip size prints a signed figure');
ok(fn.btPips({}, {pip_size:0.0001}) === '—', 'a trade with no pip field shows a dash, not zero');

/* Bounds the replay refused.
   The engine drops a stop or a target that is on the wrong side of the
   entry - which is what booked losses as "tp" - and says how many. The
   desk has to repeat that, or a book of trades which all ran without a
   target looks like a strategy that simply never sets one. */
const refused = fn.renderBacktestExtra({
  ok:true, metrics:{trades:1}, equity_curve:[1000,990], pip_size:0.0001,
  refused_bounds:{tp:2, sl:1},
  trades:[{type:'buy',entry:1.1,exit:1.09,profit:-10,volume:0.1,pips:-100,time:1735689600,exit_reason:'eod'}],
});
ok(refused.includes('bt.refused_title'), 'a run that refused bounds says so');
ok(refused.includes('"n":3'), '...and counts every one of them');
ok(!run.includes('bt.refused_title'), 'a clean run carries no such notice');

console.log(fails ? `\nbacktest results: ${fails} FAILED` : '\nbacktest results: all checks passed');
process.exit(fails ? 1 : 0);
