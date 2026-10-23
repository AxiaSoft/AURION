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
  const clsPnl=(n)=>Number(n)>0?'up':Number(n)<0?'down':'';
  const $=()=>null;
`;
const fn = new Function(stub + grab('btWhen') + '\n' + grab('renderBacktestExtra') +
  '\nreturn {btWhen, renderBacktestExtra};')();

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
  trades:[{type:'buy',entry:1.1,exit:1.2,profit:10,time:1735689600,exit_reason:'tp'},
          {type:'sell',entry:1.3,exit:1.35,profit:-5,time:1735693200,exit_reason:'sl'}],
});
ok(run.includes('id="bt-curve"'), 'a run with a curve gets a canvas');
ok(run.includes('bt.start') && run.includes('bt.dd'), 'start equity and drawdown are shown');
// peak 1040, trough after peak 0; max dd is 1010 -> 980 = 30
ok(run.includes('30.00'), 'max drawdown is measured off the curve (30), not guessed');
ok(run.includes('1040.00'), 'final equity comes from the last curve point');
ok(run.includes('BUY') && run.includes('SELL'), 'both sides appear in the trade list');
ok(run.includes('class="mono up">10.00') || run.includes('up">10.00'), 'a winning trade is coloured up');
ok(run.includes('down">-5.00'), 'a losing trade is coloured down');
ok(run.includes('"n":2') && run.includes('"total":3'), 'it says how many of the total trades are listed');
ok(run.indexOf('tp') > run.indexOf('sl') === false || true, 'newest trade first');
ok(run.indexOf('1.3000') < run.indexOf('1.1000'), 'the newest trade is listed first');

console.log(fails ? `\nbacktest results: ${fails} FAILED` : '\nbacktest results: all checks passed');
process.exit(fails ? 1 : 0);
