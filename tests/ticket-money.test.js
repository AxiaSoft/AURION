/**
 * What a ticket is worth, and where a resting order is drawn.
 *
 * Four things were asked for and three of them meet here:
 *
 *   - a limit or a stop must appear on the chart the moment its price
 *     is typed, not after the broker has confirmed it;
 *   - the stop and the target must say how many points away they are
 *     and what that costs at the lot in the field;
 *   - the money-management setting must be in money, against a stated
 *     lot, with the system doing the arithmetic from there.
 *
 * The arithmetic is lifted out of app.js and run for real rather than
 * grepped for. A check that looks for the word "tick_value" passes
 * just as happily when the multiplication behind it is wrong, and a
 * wrong multiplication here does not raise - it misstates somebody's
 * risk by a factor of a hundred, quietly, which is the exact failure
 * this file exists to prevent.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("apps/web/js/app.js");
const CHARTS = read("apps/web/js/charts.js");
const CSS = read("apps/web/css/app.css");
const LANGS = { en: 0, fa: 0, ar: 0 };
Object.keys(LANGS).forEach((l) => { LANGS[l] = JSON.parse(read(`lang/${l}.json`)); });

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error("returned false");
    pass++;
  } catch (e) {
    fails.push(name + ": " + e.message);
  }
}

/* ---------------------------------------------------------------- lift -- */

function liftFn(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("no function " + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let d = 0, started = false;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") { d++; started = true; }
    else if (src[k] === "}") { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* A class method - `fmtPrice(p) {` at one indent inside CandleChart -
   which liftFn cannot see, because it looks for the `function`
   keyword. */
function liftMethod(src, name) {
  const m = new RegExp("\\n  " + name + "\\s*\\(").exec(src);
  if (!m) throw new Error("no method " + name);
  const i = m.index + 1;
  let d = 0, started = false;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") { d++; started = true; }
    else if (src[k] === "}") { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* The money functions, in a sandbox with the desk's state faked. The
   `const` at a context's top level is a lexical binding rather than a
   sandbox property, so the exports are hung on `window` to get them
   back out. */
function moneyBox(snapMoney, fields) {
  const els = {};
  Object.entries(fields || {}).forEach(([id, value]) => { els[id] = { value: String(value) }; });
  const ctx = {
    S: { snap: { strategy: { money: snapMoney || {} }, ticks: {} } },
    $: (id) => els[id] || null,
    I18N: {
      locale: () => "en",
      t: (key, vars) => {
        const src = LANGS.en;
        const [ns, k] = key.split(".");
        let out = String((src[ns] || {})[k] || key);
        Object.entries(vars || {}).forEach(([n, v]) => {
          out = out.split("{" + n + "}").join(String(v));
        });
        return out;
      },
    },
    deskLot: () => 0.1,
    Math, Number, String, Object, console,
    window: {},
  };
  vm.createContext(ctx);
  const names = ["specFor", "priceMoney", "fmtNum", "fmtMoney", "riskPhrase",
    "moneyRefLot", "fmtLot", "liveMoney", "moneyAtLot"];
  const src = names.map((n) => liftFn(APP, n)).join("\n") +
    "\nwindow.X = {" + names.join(",") + "};";
  vm.runInContext(src, ctx);
  return ctx.window.X;
}

const EURUSD = {
  tick_size: 0.00001, tick_value: 1.0, digits: 5,
  currency: "USD", volume_min: 0.01, volume_step: 0.01, contract_size: 100000,
};
const PRICED = {
  max_loss_per_lot: 10, reference_lot: 0.01, priced: true,
  symbol: "EURUSD", currency: "USD", max_stop_points: 250,
  specs: { EURUSD: EURUSD },
};

/* ------------------------------------------------- the arithmetic ------- */

check("a stop's distance becomes points and money at the lot", () => {
  const X = moneyBox(PRICED);
  const r = X.priceMoney("EURUSD", 0.002, 0.1);     /* 200 points, 0.10 lot */
  if (Math.round(r.points) !== 200) throw new Error("points: " + r.points);
  if (Math.abs(r.money - 20) > 1e-9) throw new Error("money: " + r.money);
  if (r.currency !== "USD") throw new Error("currency: " + r.currency);
});

check("the money is proportional to the lot, the points are not", () => {
  /* This is the whole of what the desk asked for: 0.01 lot costs the
     cap, and a bigger lot costs proportionally more over the same
     distance. If these two ever stop agreeing, the setting lies. */
  const X = moneyBox(PRICED);
  const a = X.priceMoney("EURUSD", 0.002, 0.01);
  const b = X.priceMoney("EURUSD", 0.002, 0.10);
  const c = X.priceMoney("EURUSD", 0.002, 1.00);
  if (Math.round(a.points) !== 200 || Math.round(c.points) !== 200) {
    throw new Error("the distance moved with the lot: " + a.points + " vs " + c.points);
  }
  if (Math.abs(b.money / a.money - 10) > 1e-9) throw new Error("10x lot was not 10x money");
  if (Math.abs(c.money / a.money - 100) > 1e-9) throw new Error("100x lot was not 100x money");
});

check("it refuses to price a symbol the broker has not described", () => {
  /* runtime/risk.py states the rule - a guessed tick value is a wrong
     number stated with confidence - and the desk has to keep it, or
     the two disagree about the same ticket. */
  const X = moneyBox(PRICED);
  if (X.priceMoney("XAUUSD", 1.5, 0.1) !== null) throw new Error("it priced an unknown symbol");
  if (X.specFor("XAUUSD") !== null) throw new Error("specFor invented a spec");
});

check("a zero or missing tick value is refused, not divided by", () => {
  const X = moneyBox({ specs: { ODD: { tick_size: 0, tick_value: 0 } } });
  if (X.priceMoney("ODD", 1, 1) !== null) throw new Error("priced from an empty spec");
  const Y = moneyBox({ specs: { HALF: { tick_size: 0.01, tick_value: 0 } } });
  if (Y.priceMoney("HALF", 1, 1) !== null) throw new Error("priced with no tick value");
});

check("a broker suffix still finds the symbol", () => {
  const X = moneyBox(PRICED);
  if (!X.specFor("EURUSD.m")) throw new Error("EURUSD.m did not match EURUSD");
  if (X.specFor("EURJPY")) throw new Error("a different pair matched");
});

check("zero volume and zero distance are refused", () => {
  const X = moneyBox(PRICED);
  if (X.priceMoney("EURUSD", 0.002, 0) !== null) throw new Error("priced at no lot");
  if (X.priceMoney("EURUSD", 0, 0.1) !== null) throw new Error("priced a zero distance");
});

check("a hundred points reads as 100, not 100.0", () => {
  /* 0.00100 / 0.00001 is 99.99999999999999 in binary floating point,
     which rounded the wrong way and printed a lone decimal beside
     plain whole numbers. */
  const X = moneyBox(PRICED);
  const phrase = X.riskPhrase(X.priceMoney("EURUSD", 0.001, 0.1), "−");
  if (!/\b100\b/.test(phrase) || /100\.0/.test(phrase)) throw new Error(phrase);
});

/* ------------------------------------------- the cap, at a real lot ----- */

check("the cap is restated at the lot in the field", () => {
  const X = moneyBox(PRICED, { "st-money-cap": 10, "st-vol": 0.5 });
  const line = X.moneyAtLot(X.liveMoney());
  if (!/0\.50/.test(line)) throw new Error("the lot is not named: " + line);
  if (!/500\.00/.test(line)) throw new Error("0.50 lot on a 10 cap is 500: " + line);
  if (!/250/.test(line)) throw new Error("the distance is not named: " + line);
});

check("the reference lot comes from the engine, not from a guess here", () => {
  const X = moneyBox(PRICED);
  if (X.moneyRefLot({ reference_lot: 0.1 }) !== 0.1) throw new Error("the engine's value was ignored");
  /* ...but a snapshot that predates the field must not price the cap
     against a full lot, which is a hundredfold overstatement. */
  if (X.moneyRefLot({}) !== 0.01) throw new Error("the fallback is not 0.01");
});

check("an unpriced symbol gets the short wording, not a made-up distance", () => {
  const X = moneyBox({ max_loss_per_lot: 10, reference_lot: 0.01, priced: false },
    { "st-money-cap": 10, "st-vol": 0.1 });
  const line = X.moneyAtLot(X.liveMoney());
  if (/points|نقطه|پوینت/.test(line)) throw new Error("it invented a distance: " + line);
  if (!/100\.00/.test(line)) throw new Error("the money is still owed: " + line);
});

check("one state object feeds every repaint of the money line", () => {
  /* The cap field and the lot field each built this themselves. The
     lot field's copy had no currency and no `priced`, so typing a lot
     silently swapped the broker's currency for the fallback and
     downgraded the sentence. */
  const n = (APP.match(/liveMoney\(/g) || []).length;
  if (n < 3) throw new Error("liveMoney has " + n + " uses; the callers are not sharing it");
  const vol = APP.slice(APP.indexOf('stVol.addEventListener("input"'));
  const head = vol.slice(0, vol.indexOf("});"));
  if (/S\.snap\s*&&\s*S\.snap\.strategy/.test(head)) {
    throw new Error("the lot field still assembles its own money state");
  }
});

/* ------------------------------------------- the resting order line ----- */

check("the chart is told the entry price, not only the stop and target", () => {
  const fn = liftFn(APP, "syncChartPending");
  /* Pin the call, not the vocabulary. This read /entry/ over the
     whole body, which the explaining comment above the code satisfies
     all by itself - the entry could be dropped from setPending and
     the check still passed. */
  const call = /setPending\(\{([^}]*)\}\)/.exec(fn);
  if (!call) throw new Error("setPending is not called with an object");
  if (!/\bentry\b/.test(call[1])) {
    throw new Error("setPending is still called with sl and tp alone: " + call[0]);
  }
  if (!/\bkind\b/.test(call[1])) throw new Error("the chart is not told which kind of order it is");
  if (!/ct-price/.test(fn)) throw new Error("the entry field is never read");
  /* A market order has no resting price, and the field keeps its last
     value while hidden - drawing it would put a line at a price
     nothing is waiting at. */
  if (!/kind \? Number/.test(fn) && !/kind\s*\?/.test(fn)) {
    throw new Error("the entry is read regardless of the order type");
  }
});

check("typing a resting price redraws the chart", () => {
  const bind = APP.slice(APP.indexOf("function bindChartTicket("));
  const body = bind.slice(0, bind.indexOf("\nfunction "));
  const i = body.indexOf('["ct-price"]');
  if (i < 0) throw new Error("the entry field is not bound");
  const block = body.slice(i, i + 420);
  if (!/syncChartPending\(\)/.test(block)) {
    throw new Error("the price field stores the number without drawing it");
  }
});

check("switching back to a market order takes the line away", () => {
  const fn = APP.slice(APP.indexOf("const paintType = () => {"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  if (!/syncChartPending\(\)/.test(body)) {
    throw new Error("a leftover resting line survives the switch to market");
  }
});

check("the chart actually draws the entry it is given", () => {
  const fn = liftMethod(CHARTS, "setPending");
  if (!/entry/.test(fn)) throw new Error("setPending drops the entry");
  const paint = liftMethod(CHARTS, "paintPending");
  if (!/pending\.entry|pending && this\.pending\.entry/.test(paint)) {
    throw new Error("paintPending never reads the entry");
  }
  if (!/L\.yOf\(entry\)/.test(paint)) throw new Error("the entry is not placed on the price axis");
});

check("the preview line takes no side until one is chosen", () => {
  /* The same price is a buy limit or a sell limit depending on which
     button is pressed. Painting it green would be the chart asserting
     a direction the trader has not. */
  const paint = liftMethod(CHARTS, "paintPending");
  if (!/T\.muted/.test(paint)) throw new Error("there is no neutral colour for an unsided entry");
});

check("a placed order is drawn before the refresh lands", () => {
  const fn = liftFn(APP, "showRestingOrder");
  if (!/setOrders/.test(fn)) throw new Error("it never reaches the chart");
  if (!/setPending/.test(fn)) {
    throw new Error("the preview line is left behind, so one order draws twice");
  }
  const send = liftFn(APP, "sendDeskOrder");
  const call = send.indexOf("showRestingOrder(");
  const refresh = send.indexOf("await refresh(");
  if (call < 0) throw new Error("sendDeskOrder never draws the order it placed");
  if (call > refresh) throw new Error("the optimistic draw happens after the refresh, so it does nothing");
  if (!/r\.ok && orderType/.test(send)) {
    throw new Error("a rejected or market order would be drawn as resting");
  }
});

/* ------------------------------------------------------ the readout ----- */

check("the ticket carries a row for what the levels are worth", () => {
  if (!/id="ct-risk"/.test(APP)) throw new Error("no readout in the ticket markup");
  if (!/aria-live="polite"/.test(APP.slice(APP.indexOf('id="ct-risk"') - 120, APP.indexOf('id="ct-risk"') + 60))) {
    throw new Error("the row changes under the eye but is not announced");
  }
  if (!/\.ct-risk\s*\{/.test(CSS)) throw new Error("the row has no styling");
});

check("the readout follows the lot, the levels and the quote", () => {
  const n = (APP.match(/paintTicketRisk\(\)/g) || []).length;
  if (n < 6) throw new Error("only " + n + " call sites; something that changes the answer is missed");
  /* A market order's risk is measured from the live price, so a new
     tick has to move it. */
  const prices = liftFn(APP, "paintTicketPrices");
  if (!/paintTicketRisk\(\)/.test(prices)) throw new Error("a new quote leaves the money stale");
});

check("the distance is measured from where the trade would open", () => {
  /* Measuring a limit order's stop from the current price instead of
     the resting price overstates the risk by the gap between them. */
  const fn = liftFn(APP, "paintTicketRisk");
  if (!/kind \? Number\(\$\("ct-price"\)/.test(fn)) {
    throw new Error("the resting price is not used as the origin");
  }
  if (!/bid/.test(fn) || !/ask/.test(fn)) {
    throw new Error("a market order has no live price to measure from");
  }
});

check("it says so when it cannot price the symbol", () => {
  const fn = liftFn(APP, "paintTicketRisk");
  if (!/exec\.risk_unpriced/.test(fn)) throw new Error("an unpriced symbol shows nothing at all");
  if (!/specFor\(symbol\)/.test(fn)) throw new Error("it does not check before computing");
});

/* ----------------------------------------------------------- wording ---- */

check("every new string exists in all three languages", () => {
  const keys = ["exec.risk_line", "exec.risk_unpriced", "exec.risk_need_price",
    "money.at_lot", "money.at_lot_unpriced", "money.ref_note", "money.per_lot", "money.cap"];
  const missing = [];
  for (const key of keys) {
    const [ns, k] = key.split(".");
    for (const [lang, d] of Object.entries(LANGS)) {
      if (!((d[ns] || {})[k] || "").trim()) missing.push(lang + ":" + key);
    }
  }
  if (missing.length) throw new Error(missing.join(", "));
});

check("the lot placeholder survives translation", () => {
  /* "per lot" was the old wording and it was wrong by a factor of a
     hundred. A translation that drops {lot} puts it back. */
  for (const [lang, d] of Object.entries(LANGS)) {
    for (const key of ["per_lot", "ref_note", "at_lot", "at_lot_unpriced"]) {
      if (!String((d.money || {})[key] || "").includes("{lot}")) {
        throw new Error(lang + " money." + key + " lost {lot}");
      }
    }
    if (!String((d.exec || {}).risk_line || "").includes("{points}")) {
      throw new Error(lang + " exec.risk_line lost {points}");
    }
    if (!String((d.exec || {}).risk_line || "").includes("{money}")) {
      throw new Error(lang + " exec.risk_line lost {money}");
    }
  }
});

check("the card no longer claims the cap is per whole lot", () => {
  const card = APP.slice(APP.indexOf('id="set-money"'), APP.indexOf('id="st-money-save"'));
  if (!/money\.per_lot", \{ lot:/.test(card)) {
    throw new Error("the unit is printed without the lot it refers to");
  }
  if (!/st-money-ref/.test(card)) throw new Error("the card does not state its reference lot");
  if (!/st-money-at-lot/.test(card)) throw new Error("the card does not restate the cap at the real lot");
});

/* ------------------------------------------------------ two decimals ---- */

check("prices on the EA chart are written to two decimals", () => {
  const fn = liftMethod(CHARTS, "fmtPrice");
  if (/a >= 1000|toFixed\(5\)|toFixed\(4\)|toFixed\(3\)/.test(fn)) {
    throw new Error("the widening table is back: " + fn.replace(/\s+/g, " "));
  }
  if (!/CandleChart\.PRICE_DP/.test(fn)) throw new Error("the precision is not read from one place");
  if (!/static PRICE_DP = 2;/.test(CHARTS)) throw new Error("PRICE_DP is not 2");
});

check("the axis still reports the value it landed on", () => {
  /* Rounding to two decimals makes neighbouring labels read alike on
     a sub-1.00 pair. Anything judging that the axis is well formed
     has to read the number, not the text. */
  if (!/value: pct \? u : price/.test(CHARTS)) {
    throw new Error("priceTicks no longer carries the unrounded value");
  }
});

/* ----------------------------------------------------------- report ---- */

/* ------------------------------------------------------------------ *
 * The lot in Settings is the lot the ticket offers
 *
 * Reported: changing the lot in Settings from 1 to 2 left the market
 * ticket and the EA chart still showing 1.
 *
 * ticketLot() preferred S.ticket.vol - what had last been typed into a
 * ticket - over the setting, and S.ticket.vol never expired. So the
 * first number ever typed outranked every later change to the setting,
 * for the whole session, silently. A trader who sets 2 and sends what
 * the ticket shows sends 1.
 *
 * The remembered value still wins while the setting stands still: a
 * one-off size typed for a single trade must survive a repaint. It is
 * tagged with the setting it was typed against, and when the setting
 * moves the tag stops matching.
 * ------------------------------------------------------------------ */

check("a lot typed on the ticket survives a repaint", () => {
  const ctx = { S: { ticket: { vol: "0.50", volFrom: 0.10 }, snap: { strategy: { manual_volume: 0.10 } } } };
  const fn = liftFn(APP, "ticketLot");
  const dl = liftFn(APP, "deskLot");
  const run = new vm.Script(dl + "\n" + fn + "\n;ticketLot();");
  const got = run.runInNewContext(ctx);
  if (got !== 0.5) throw new Error("expected the typed 0.5, got " + got);
});

check("...and loses to the setting once the setting changes", () => {
  // typed 0.50 while the setting was 0.10; the setting is 2 now
  const ctx = { S: { ticket: { vol: "0.50", volFrom: 0.10 }, snap: { strategy: { manual_volume: 2 } } } };
  const fn = liftFn(APP, "ticketLot");
  const dl = liftFn(APP, "deskLot");
  const got = new vm.Script(dl + "\n" + fn + "\n;ticketLot();").runInNewContext(ctx);
  if (got !== 2) throw new Error("the ticket kept offering " + got + " after the setting moved to 2");
});

check("an untouched ticket just follows the setting", () => {
  const ctx = { S: { ticket: {}, snap: { strategy: { manual_volume: 2 } } } };
  const fn = liftFn(APP, "ticketLot");
  const dl = liftFn(APP, "deskLot");
  const got = new vm.Script(dl + "\n" + fn + "\n;ticketLot();").runInNewContext(ctx);
  if (got !== 2) throw new Error("expected 2, got " + got);
});

check("the ticket input asks ticketLot rather than reading the memory raw", () => {
  // value="${esc(String(t.vol || ticketLot()))}" put the stale remembered
  // value first and never reached the function that resolves the conflict.
  if (/t\.vol \|\| ticketLot\(\)/.test(APP)) {
    throw new Error("the input short-circuits past ticketLot()");
  }
  if (!/value="\$\{esc\(String\(ticketLot\(\)\)\)\}"/.test(APP)) {
    throw new Error("the lot input no longer renders from ticketLot()");
  }
});

check("the remembered lot records which setting it was typed against", () => {
  if (!/volFrom: deskLot\(\),/.test(APP)) throw new Error("rememberTicket drops the tag");
});

/* ------------------------------------------------------------------ *
 * Smart filters are no longer a control on this screen
 *
 * Removed from the bot's settings by request. The dangerous half of a
 * removal like this is the save path: $("st-smart")?.classList with no
 * such element is undefined, and sending that on every save would have
 * turned the filters off for everybody without anybody asking.
 * ------------------------------------------------------------------ */

check("the smart-filters switch is gone from the settings", () => {
  if (/st-smart/.test(APP)) throw new Error("the control, its handler, or its id is still there");
});

check("...and the save no longer sends a value for it", () => {
  if (/smart_filters:/.test(APP)) {
    throw new Error("the payload still carries smart_filters, now sourced from an element that does not exist");
  }
});

if (fails.length) {
  console.log("\nticket-money: " + fails.length + " check(s) failed");
  fails.forEach((f) => console.log("  x " + f));
  process.exitCode = 1;
} else {
  console.log("\nticket-money: " + pass + " checks passed");
}
