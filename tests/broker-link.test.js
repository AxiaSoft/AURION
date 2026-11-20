/**
 * The broker-connection card in Settings > MetaTrader 5.
 *
 * The desk answered "is the broker connected?" with one green dot. That
 * dot is true of two arrangements that behave completely differently -
 * the engine logged into the account itself, or AurionBridge running on
 * a chart - and it is also true of a connection that will refuse every
 * order it is given, because the password saved was the investor one.
 *
 * The card states the route, the account number, the server, the broker
 * and, separately from "connected", whether an order sent down this
 * link would be accepted. The reason is the engine's word, not a guess
 * made here: only the engine can tell an investor password from a
 * terminal with AutoTrading switched off, and a desk that guesses sends
 * the trader to change the wrong thing.
 *
 *     node tests/broker-link.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (name, fn) => {
  try {
    const note = fn();
    console.log("ok   " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    fails++;
    console.log("FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appJs = read("apps/web/js/app.js");
const demoJs = read("apps/web/js/demo.js");
const langs = {
  en: JSON.parse(read("lang/en.json")),
  fa: JSON.parse(read("lang/fa.json")),
  ar: JSON.parse(read("lang/ar.json")),
};

/* brokerLinkHtml is lifted out of app.js and run on its own.

   Booting the whole desk to read one card would drag in the chart
   engine, the websocket and the audio layer, and the suite would then
   be testing those. Sliced by indexOf bounds rather than by a line
   count, because a line count is wrong the moment anything above it
   moves. */
function linkCard(link, lang = "en") {
  const start = appJs.indexOf("function brokerLinkHtml()");
  if (start === -1) throw new Error("brokerLinkHtml is gone from app.js");
  const end = appJs.indexOf("\nfunction propStatusHtml", start);
  if (end === -1) throw new Error("cannot find the end of brokerLinkHtml");
  const src = appJs.slice(start, end);

  const pack = langs[lang];
  const ctx = {
    S: { snap: { mt5: link === null ? {} : { link } } },
    I18N: {
      lang,
      t: (key) => {
        const [group, name] = key.split(".");
        const v = pack[group] && pack[group][name];
        if (v === undefined) throw new Error("missing string: " + key);
        return v;
      },
    },
    esc: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\nbrokerLinkHtml();", ctx);
  return vm.runInContext("brokerLinkHtml()", ctx);
}

const DIRECT = {
  route: "direct", can_trade: true, reason: "", login: 51234567,
  server: "ABroker-Live03", company: "A Broker Ltd", currency: "USD",
  leverage: 200, native_package: true,
};

check("a direct login names the account, the server and the broker", () => {
  const html = linkCard(DIRECT);
  for (const want of ["51234567", "ABroker-Live03", "A Broker Ltd", "1:200"]) {
    if (!html.includes(want)) throw new Error("missing from the card: " + want);
  }
  if (!html.includes(langs.en.settings.link_direct))
    throw new Error("the route is not named");
  return "account, server, broker, leverage";
});

check("the AurionBridge route is named as itself, not as 'MT5 connected'", () => {
  const html = linkCard({ ...DIRECT, route: "expert" });
  if (!html.includes(langs.en.settings.link_expert))
    throw new Error("the expert route is not named");
  if (html.includes(langs.en.settings.link_direct))
    throw new Error("it claims to be a direct login");
  return langs.en.settings.link_expert;
});

check("an investor password is shown as read-only, with what to do about it", () => {
  /* The fault this card exists for: the link is healthy, the dot is
     green, and every order is refused. */
  const html = linkCard({ ...DIRECT, can_trade: false, reason: "read_only" });
  if (!html.includes(langs.en.settings.link_read_only))
    throw new Error("the read-only reason is not stated");
  if (html.includes(langs.en.settings.link_can_trade))
    throw new Error("it still claims the login can trade");
  if (!/id="link-trade" data-state="down"/.test(html))
    throw new Error("the orders chip is not marked down");
  return "read_only";
});

check("a healthy link says so rather than leaving the question open", () => {
  const html = linkCard(DIRECT);
  if (!html.includes(langs.en.settings.link_can_trade))
    throw new Error("nothing says the login can place orders");
  if (!/id="link-trade" data-state="live"/.test(html))
    throw new Error("the orders chip is not marked live");
  return "can_trade";
});

check("a tester-only desk is told that, not told it is offline", () => {
  const html = linkCard({ route: "expert", can_trade: false, reason: "tester_only" });
  if (!html.includes(langs.en.settings.link_tester_only))
    throw new Error("the tester-only reason is not stated");
  return "tester_only";
});

check("nothing attached reads as nothing attached", () => {
  const html = linkCard(null);
  if (!html.includes(langs.en.settings.link_none)) throw new Error("the route is not named");
  if (!html.includes(langs.en.settings.link_offline)) throw new Error("the reason is not stated");
  /* And no empty rows: a label with a dash beside it reads as a figure
     that failed to load rather than as a question that has no answer
     yet. */
  if (html.includes(langs.en.settings.link_account))
    throw new Error("an empty account row is drawn");
  return "offline, no empty rows";
});

check("the card is actually on the MetaTrader 5 page", () => {
  /* Writing the card is not placing it. A helper nothing calls is a
     helper that passes every check about its output and ships a page
     that never shows it. */
  const at = appJs.indexOf('block("set-mt5"');
  if (at === -1) throw new Error("the MetaTrader 5 settings block is gone");
  const body = appJs.slice(at, at + 400);
  if (!/\$\{brokerLinkHtml\(\)\}/.test(body))
    throw new Error("the connection card is never rendered into the page");
  return "rendered in set-mt5";
});

check("the reason comes from the engine, never from a guess on the desk", () => {
  const start = appJs.indexOf("function brokerLinkHtml()");
  const src = appJs.slice(start, appJs.indexOf("\nfunction propStatusHtml", start));
  if (!/link\.reason === "read_only"/.test(src))
    throw new Error("the card does not read the engine's reason");
  if (/trade_allowed/.test(src))
    throw new Error("the card re-derives the verdict from the account instead of reading the engine's");
  return "link.reason";
});

check("a machine with no MetaTrader5 package is told the direct fields are a dead end", () => {
  const html = linkCard({ ...DIRECT, native_package: false });
  if (!html.includes(langs.en.settings.link_no_package))
    throw new Error("nothing says the direct login is unavailable here");
  /* And it is said only where it is true, or it is noise on every
     Windows desk, which is all of them. */
  if (linkCard(DIRECT).includes(langs.en.settings.link_no_package))
    throw new Error("the note is shown even where the package exists");
  return "said only when missing";
});

check("the card is repainted when the link changes, and not otherwise", () => {
  /* It is the one card on the settings page whose facts move without
     anyone clicking - a terminal is closed, an expert detached, a
     login swapped. Rebuilding it every poll would blow away a
     half-typed password beside it; never rebuilding it means it lies
     for as long as the page is open. */
  const at = appJs.indexOf('const linkCard = document.querySelector(".broker-link")');
  if (at === -1) throw new Error("nothing patches the card after render");
  const body = appJs.slice(at, at + 700);
  if (!/S\._linkKey !== key/.test(body))
    throw new Error("the card is rebuilt unconditionally");
  for (const field of ["route", "can_trade", "reason", "login", "server"]) {
    if (!new RegExp("lk\\." + field).test(body))
      throw new Error(field + " is not part of the repaint key, so a change to it would not show");
  }
  if (!/I18N\.lang/.test(body))
    throw new Error("switching language would leave the card in the old one");
  return "keyed repaint";
});

check("every string on the card exists in all three languages", () => {
  const needed = ["link_title", "link_route", "link_direct", "link_expert", "link_none",
    "link_account", "link_server", "link_company", "link_leverage", "link_trading",
    "link_can_trade", "link_read_only", "link_tester_only", "link_offline",
    "link_no_package", "mt5_password_hint"];
  const missing = [];
  for (const code of Object.keys(langs)) {
    for (const k of needed) if (!langs[code].settings[k]) missing.push(code + "." + k);
  }
  if (missing.length) throw new Error("missing: " + missing.join(", "));
  return needed.length + " strings x 3";
});

check("the password field explains investor against master", () => {
  /* Two passwords, one field, and the difference decides whether the
     robot can trade at all. Left unsaid, the trader picks one and
     finds out weeks later. */
  const hint = langs.en.settings.mt5_password_hint.toLowerCase();
  if (!hint.includes("investor") || !hint.includes("master"))
    throw new Error("the hint does not mention both passwords");
  if (!/mt5_password_hint/.test(appJs))
    throw new Error("the hint is never rendered");
  return "both named";
});

check("the demo shows the expert route and invents no broker login", () => {
  /* The demo must never look like it holds a real account's
     credentials. A demo cannot honestly show a direct login: that
     needs a real server and a real password. */
  const at = demoJs.indexOf("link: {");
  if (at === -1) throw new Error("the demo snapshot carries no link block, so the card would read 'offline'");
  const body = demoJs.slice(at, at + 420);
  if (!/route: "expert"/.test(body)) throw new Error("the demo claims a direct broker login");
  if (/password/i.test(body)) throw new Error("the demo link block mentions a password");
  return "expert, no credentials";
});

console.log(fails ? `\nbroker-link: ${fails} FAILED` : "\nbroker-link: all checks passed");
process.exit(fails ? 1 : 0);
