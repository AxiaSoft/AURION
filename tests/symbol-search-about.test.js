/**
 * Three changes asked for from the desk:
 *
 *   1. the markets dropdown and the EA chart workspace must let you
 *      search for an instrument instead of scrolling a native <select>;
 *   2. opening an EA chart from the grid must fill the screen there and
 *      then, and Back must return to the list rather than to a
 *      fullscreen desk with no way out;
 *   3. the About page was rebuilt.
 *
 * The searching and the About markup are rendered in jsdom and driven
 * through real events, because "typing filters the list" is a claim
 * about what happens when you type, not about what the source says. The
 * fullscreen ordering is checked against the source, since the one thing
 * that can go wrong there -- asking for fullscreen after the click has
 * finished, when the browser will refuse -- is a question of where the
 * call sits, and jsdom implements no Fullscreen API to observe.
 *
 *     node tests/symbol-search-about.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

const appJs = read("js/app.js");
const chartJs = read("js/chart-tools.js");
const appCss = read("css/app.css");
const chartCss = read("css/chart.css");

/* ======================================================================
   2. Fullscreen when a chart is opened from the grid
   ====================================================================== */

check("opening a chart asks for fullscreen inside the click, not after it", () => {
  /* requestFullscreen is gesture-bound. By the time openChartDesk has
     re-rendered the workspace the gesture is spent and the browser
     refuses, so the order of these two statements is the whole feature. */
  const h = /data-open-chart[\s\S]{0,2600}?openChartDesk\(/.exec(appJs);
  if (!h) throw new Error("could not find the grid's open handler");
  const body = h[0];
  const reqAt = body.indexOf("requestFullscreen");
  if (reqAt < 0) throw new Error("the grid handler never requests fullscreen");
  const openAt = body.lastIndexOf("openChartDesk(");
  if (reqAt > openAt) {
    throw new Error("requestFullscreen is called after openChartDesk, so the gesture is already gone");
  }
});

check("the request is awaited by nothing, so a refusal cannot block the open", () => {
  /* A browser that refuses must still open the chart. */
  const h = /data-open-chart[\s\S]{0,2600}?openChartDesk\([^;]*;/.exec(appJs)[0];
  if (/await\s+[^;]*requestFullscreen/.test(h)) {
    throw new Error("the handler awaits requestFullscreen; a refusal would stop the chart opening");
  }
  if (!/catch/.test(h)) throw new Error("a rejected requestFullscreen promise is not caught");
});

check("the grid open sets the flag the workspace reads on mount", () => {
  if (!/openChartDesk\([^)]*\{\s*fullscreen:\s*true\s*\}\)/.test(appJs)) {
    throw new Error("the grid does not pass { fullscreen: true }");
  }
  if (!/S\.chartFocusFull\s*=\s*Boolean\(opts/.test(appJs)) {
    throw new Error("openChartDesk does not record the request");
  }
});

check("the flag is consumed once, so a timeframe change does not re-force fullscreen", () => {
  /* Switching timeframe rebuilds the whole workspace. If the flag were
     left set, a trader who left fullscreen would be thrown back in. */
  const m = /if \(S\.chartFocusFull\) \{([\s\S]{0,400}?)\}/.exec(appJs);
  if (!m) throw new Error("nothing reads S.chartFocusFull on mount");
  if (!/S\.chartFocusFull\s*=\s*false/.test(m[1])) throw new Error("the flag is never cleared");
  if (!/setFullscreen\(true\)/.test(m[1])) throw new Error("the flag does not turn fullscreen on");
});

check("Back leaves fullscreen before it shows the chart list", () => {
  const back = /#tv-back[\s\S]{0,700}/.exec(chartJs)[0];
  const off = back.indexOf("setFullscreen(false)");
  const onBack = back.indexOf("onBack(");
  if (off < 0) throw new Error("the back button does not leave fullscreen");
  if (onBack < 0 || off > onBack) throw new Error("it returns to the list before leaving fullscreen");
});

check("closing the workspace by any route also leaves fullscreen", () => {
  /* The back button is not the only way out, and landing on the chart
     list still in fullscreen is the exact bug that was reported. */
  const fn = /function closeChartDesk\(\) \{[\s\S]*?\n\}/.exec(appJs)[0];
  if (!/setFullscreen\(false\)/.test(fn)) throw new Error("closeChartDesk does not leave fullscreen");
  if (!/S\.chartFocusFull\s*=\s*false/.test(fn)) throw new Error("closeChartDesk does not clear the flag");
  if (!/chart-full/.test(fn)) throw new Error("the desk's own fullscreen class is left behind");
});

/* ======================================================================
   1b. The chart workspace's symbol menu (source-level contract)
   ====================================================================== */

check("the workspace symbol caption is a real control, not a label", () => {
  if (!/<button[^>]*class="tv-sym"[^>]*data-menu="symbol"/.test(chartJs.replace(/\s+/g, " "))) {
    throw new Error(".tv-sym is not a button opening the symbol menu");
  }
  if (!/aria-haspopup/.test(/class="tv-sym[\s\S]{0,400}/.exec(chartJs)[0])) {
    throw new Error("the control does not announce that it opens a menu");
  }
});

check("the symbol menu has a search box and rows that can be picked", () => {
  const fn = /function menuSymbols\(query\) \{[\s\S]*?\n  \}/.exec(chartJs);
  if (!fn) throw new Error("menuSymbols is missing");
  const body = fn[0];
  if (!/tv-sym-q/.test(body)) throw new Error("no search input");
  if (!/data-pick-sym/.test(body)) throw new Error("rows cannot be picked");
  if (!/toUpperCase|toLowerCase/.test(body)) throw new Error("the filter is case-sensitive");
});

check("typing in the symbol search keeps the caret at the end", () => {
  /* The menu is re-rendered on every keystroke, which destroys the
     input. Re-focusing without restoring the selection makes the caret
     jump to the start and the next letter lands backwards. */
  const wire = /name === "symbol"[\s\S]{0,900}/.exec(chartJs);
  if (!wire) throw new Error("the symbol menu is never opened from the top bar");
  if (!/setSelectionRange/.test(wire[0])) {
    throw new Error("focus is restored without the caret position, so typing runs backwards");
  }
});

check("picking the symbol already shown does not reload the chart", () => {
  const d = /closest\("\[data-pick-sym\]"\)[\s\S]{0,600}?\n        \}/.exec(chartJs);
  if (!d) throw new Error("no click handler for a symbol row");
  const src = d[0];
  if (!/!==\s*ui\.ctx\.symbol/.test(src)) {
    throw new Error("the handler does not compare the pick against the current symbol");
  }
  if (!/onSymbol\(/.test(src)) throw new Error("the handler never tells the desk to switch");
});

check("the desk hands the workspace the symbols and a way to switch", () => {
  const bind = /AurionChartUI\.bind\(S\.chart, \{[\s\S]*?\n    \}\);/.exec(appJs);
  if (!bind) throw new Error("could not find the bind call");
  if (!/symbols:\s*liveSymbols\(\)/.test(bind[0])) throw new Error("ctx.symbols is not supplied");
  if (!/onSymbol:/.test(bind[0])) throw new Error("ctx.onSymbol is not supplied");
});

check("the symbol control is styled as a control in the chart stylesheet", () => {
  if (!/\.tv-sym\s*\{/.test(chartCss)) throw new Error("no .tv-sym rule");
  if (!/\.tv-sym-caret/.test(chartCss)) throw new Error("the caret has no rule");
  if (!/\.tv-sym:focus-visible/.test(chartCss)) throw new Error("the control has no keyboard focus ring");
});

/* ======================================================================
   Rendered checks
   ====================================================================== */

let jsdom = null;
try { jsdom = require(require.resolve("jsdom")); } catch { /* optional */ }

if (!jsdom) {
  console.log("SKIP  rendered checks (jsdom not installed)");
} else {
  const { JSDOM, VirtualConsole } = jsdom;
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";
  win.AudioContext = class { createGain() { return { connect() {}, gain: {} }; } };

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => read(f)).join("\n;\n");
  let T = null;
  try {
    win.eval(bundle + "\n;window.__T = { S, views, searchSymbols, symbolPickerHtml, bindInstrumentPicker, I18N };");
    T = win.__T;
  } catch (e) {
    console.log("FAIL  the desk bundle loads\n      " + e.message);
    results.push(false);
  }

  if (T) {
    const agents = [
      { symbol: "EURUSD", timeframe: "M15", alive: true, online: true, last_seen: Date.now() },
      { symbol: "EURJPY", timeframe: "H1", alive: true, online: true, last_seen: Date.now() },
      { symbol: "XAUUSD", timeframe: "H4", alive: true, online: true, last_seen: Date.now() },
      { symbol: "GBPJPY", timeframe: "M5", alive: true, online: true, last_seen: Date.now() },
      { symbol: "US500", timeframe: "M30", alive: true, online: true, last_seen: Date.now() },
    ];
    T.S.snap = {
      engine: "online",
      ticks: { EURUSD: { bid: 1.085, ask: 1.0851 }, XAUUSD: { bid: 2412.3, ask: 2412.7 } },
      agents,
      strategy: { manual_volume: 0.2, name: "trend" },
      positions: [],
      license: {},
    };
    T.S.symbol = "XAUUSD";
    T.S.timeframe = "H4";

    /* ---- 1a. the markets picker ------------------------------------- */

    check("every attached chart is offered when nothing is typed", () => {
      const got = T.searchSymbols("").map((r) => r.symbol);
      if (got.length !== 5) throw new Error("offered " + got.length + " of 5: " + got.join(","));
    });

    check("typing narrows the list to what matches", () => {
      const got = T.searchSymbols("jpy").map((r) => r.symbol);
      if (got.join(",") !== "EURJPY,GBPJPY") throw new Error("got " + got.join(",") + ", expected EURJPY,GBPJPY");
    });

    check("the search is case- and punctuation-insensitive", () => {
      const a = T.searchSymbols("xau").map((r) => r.symbol).join(",");
      const b = T.searchSymbols("XAU/USD").map((r) => r.symbol).join(",");
      if (a !== "XAUUSD" || b !== "XAUUSD") throw new Error(`"xau"=>${a}  "XAU/USD"=>${b}`);
    });

    check("a symbol that starts with what you typed is offered first", () => {
      /* Typing EUR must not bury EURUSD under something that merely
         contains the letters. */
      const got = T.searchSymbols("eur").map((r) => r.symbol);
      if (got[0] !== "EURUSD" && got[0] !== "EURJPY") throw new Error("first result was " + got[0]);
      if (!got.includes("EURUSD") || !got.includes("EURJPY")) throw new Error("missing a EUR pair: " + got.join(","));
    });

    check("searching for something not attached returns nothing, not everything", () => {
      const got = T.searchSymbols("ZZZZ");
      if (got.length !== 0) throw new Error("got " + got.length + " results for a nonsense query");
    });

    /* Drive the real widget. */
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const mount = () => {
      host.innerHTML = T.symbolPickerHtml("sym", T.S.symbol);
      return {
        btn: host.querySelector("#sym-btn"),
        pop: host.querySelector("#sym-pop"),
        q: host.querySelector("#sym-q"),
        list: host.querySelector("#sym-list"),
      };
    };
    const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    const type = (input, text) => {
      input.value = text;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    };
    const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));

    check("the markets control starts closed and opens when pressed", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      if (!w.pop.hidden) throw new Error("the list was showing before it was pressed");
      click(w.btn);
      if (w.pop.hidden) throw new Error("pressing the control did not open the list");
      if (w.btn.getAttribute("aria-expanded") !== "true") throw new Error("aria-expanded was not updated");
    });

    check("opening it lists every attached chart", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      click(w.btn);
      const rows = w.list.querySelectorAll("[data-sym]");
      if (rows.length !== 5) throw new Error(rows.length + " rows for 5 attached charts");
    });

    check("typing into the box filters the rows that are shown", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      click(w.btn);
      type(w.q, "jpy");
      const shown = [...w.list.querySelectorAll("[data-sym]")].map((r) => r.getAttribute("data-sym"));
      if (shown.join(",") !== "EURJPY,GBPJPY") throw new Error("showing " + shown.join(","));
    });

    check("a search with no match says so instead of showing an empty box", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      click(w.btn);
      type(w.q, "ZZZZ");
      if (!w.list.querySelector(".sympick-none")) throw new Error("no empty-state message");
      if (w.list.querySelectorAll("[data-sym]").length) throw new Error("rows were left behind");
    });

    check("clicking a row chooses that instrument", () => {
      const w = mount();
      let picked = null;
      T.bindInstrumentPicker("sym", (s) => { picked = s; });
      click(w.btn);
      type(w.q, "us5");
      click(w.list.querySelector("[data-sym]"));
      if (picked !== "US500") throw new Error("picked " + JSON.stringify(picked));
      if (!w.pop.hidden) throw new Error("the list stayed open after choosing");
    });

    check("the closed control then shows what was chosen", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      click(w.btn);
      type(w.q, "gbp");
      click(w.list.querySelector("[data-sym]"));
      const label = host.querySelector("#sym .sympick-cur").textContent.trim();
      if (label !== "GBPJPY") throw new Error("the control reads " + JSON.stringify(label));
    });

    check("it can be driven from the keyboard alone", () => {
      const w = mount();
      let picked = null;
      T.bindInstrumentPicker("sym", (s) => { picked = s; });
      click(w.btn);
      type(w.q, "jpy");            // EURJPY, GBPJPY
      key(w.q, "ArrowDown");
      key(w.q, "Enter");
      if (!picked) throw new Error("Enter chose nothing");
      if (!["EURJPY", "GBPJPY"].includes(picked)) throw new Error("picked " + picked);
    });

    check("the arrow keys wrap instead of sticking at the end", () => {
      const w = mount();
      let picked = null;
      T.bindInstrumentPicker("sym", (s) => { picked = s; });
      click(w.btn);
      type(w.q, "jpy");
      key(w.q, "ArrowUp"); key(w.q, "ArrowUp"); key(w.q, "ArrowUp");
      key(w.q, "Enter");
      if (!["EURJPY", "GBPJPY"].includes(picked)) throw new Error("picked " + JSON.stringify(picked));
    });

    check("Escape dismisses the list without choosing anything", () => {
      const w = mount();
      let picked = null;
      T.bindInstrumentPicker("sym", (s) => { picked = s; });
      click(w.btn);
      key(w.q, "Escape");
      if (!w.pop.hidden) throw new Error("Escape did not close the list");
      if (picked !== null) throw new Error("Escape chose " + picked);
    });

    check("clicking away closes the list", () => {
      const w = mount();
      T.bindInstrumentPicker("sym", () => {});
      click(w.btn);
      click(win.document.body);
      if (!w.pop.hidden) throw new Error("the list stayed open");
    });

    check("with no EA attached the control says so and cannot be opened", () => {
      const keep = T.S.snap.agents;
      T.S.snap.agents = [];
      try {
        host.innerHTML = T.symbolPickerHtml("sym", "");
        const btn = host.querySelector("#sym-btn");
        if (!btn.disabled) throw new Error("the control is still pressable with nothing to pick");
        if (!host.querySelector("#sym").classList.contains("is-empty")) throw new Error("the empty state is not marked");
      } finally {
        T.S.snap.agents = keep;
      }
    });

    check("the markets view renders the searchable control, not a <select>", () => {
      const html = T.views.markets();
      if (!html.includes('id="sym-q"')) throw new Error("no search box in the markets toolbar");
      if (/<select[^>]*id="sym"/.test(html)) throw new Error("the old <select> is still there");
    });

    check("every class the picker uses has a rule in the stylesheet", () => {
      const html = T.symbolPickerHtml("sym", "XAUUSD") + T.views.markets();
      const used = new Set();
      for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c.startsWith("sympick")) used.add(c);
      }
      used.add("sympick-row"); used.add("sympick-none"); used.add("sympick-n"); used.add("sympick-d");
      const missing = [...used].filter((c) => !appCss.includes("." + c));
      if (missing.length) throw new Error("no CSS for: " + missing.join(", "));
    });

    /* ---- 3. the About page ------------------------------------------- */

    const about = T.views.about();

    check("the About page renders", () => {
      if (about.includes("[object")) throw new Error("the view returned a Promise");
      if (!/class="cmd about"/.test(about)) throw new Error("the page has no root class to style");
    });

    check("it keeps everything the old page could do", () => {
      for (const id of ["about-update-status", "about-check-update", "about-copy-ver", "about-changelog"]) {
        if (!about.includes(`id="${id}"`)) throw new Error("#" + id + " was lost in the rewrite");
      }
    });

    check("the state of the desk is shown as tiles, not buried in a list", () => {
      const box = win.document.createElement("div");
      box.innerHTML = about;
      const tiles = box.querySelectorAll(".ab-stat");
      if (tiles.length < 6) throw new Error(tiles.length + " status tiles");
      for (const t of tiles) {
        if (!t.querySelector(".ab-stat-k") || !t.querySelector(".ab-stat-v")) {
          throw new Error("a tile is missing its label or its value");
        }
      }
    });

    check("a running engine reads as good and a stopped one as bad", () => {
      const render = () => {
        const box = win.document.createElement("div");
        box.innerHTML = T.views.about();
        return box.querySelector(".ab-stat");
      };
      T.S.snap.engine = "online";
      const up = render();
      T.S.snap.engine = "offline";
      const down = render();
      T.S.snap.engine = "online";
      if (!up.classList.contains("is-ok")) throw new Error("a running engine is not marked good");
      if (!down.classList.contains("is-bad")) throw new Error("a stopped engine is not marked bad");
      if (!up.querySelector(".dot.live")) throw new Error("no live dot when the engine is up");
      if (!down.querySelector(".dot.down")) throw new Error("no down dot when the engine is stopped");
    });

    check("something merely switched off is not painted as a fault", () => {
      /* Auto-trade off is a choice, not a failure. Painting it red would
         cry wolf and make a real fault easier to miss. */
      T.S.snap.strategy.auto_trade = false;
      const box = win.document.createElement("div");
      box.innerHTML = T.views.about();
      const tiles = [...box.querySelectorAll(".ab-stat")];
      const auto = tiles.find((t) => /auto/i.test(t.querySelector(".ab-stat-k").textContent));
      if (!auto) throw new Error("no auto-trade tile");
      if (auto.classList.contains("is-bad")) throw new Error("auto-trade off is painted as a fault");
      if (!auto.classList.contains("is-idle")) throw new Error("auto-trade off is not marked as idle");
    });

    check("an armed kill switch is painted as a fault, because it stops trading", () => {
      T.S.snap.kill_switch = true;
      const box = win.document.createElement("div");
      box.innerHTML = T.views.about();
      const tiles = [...box.querySelectorAll(".ab-stat")];
      const kill = tiles.find((t) => /kill/i.test(t.querySelector(".ab-stat-k").textContent));
      T.S.snap.kill_switch = false;
      if (!kill) throw new Error("no kill-switch tile");
      if (!kill.classList.contains("is-bad")) throw new Error("an armed kill switch is not flagged");
    });

    check("the number of attached charts is counted, not asserted", () => {
      const box = win.document.createElement("div");
      box.innerHTML = T.views.about();
      const tiles = [...box.querySelectorAll(".ab-stat")];
      const ch = tiles.find((t) => /chart/i.test(t.querySelector(".ab-stat-k").textContent));
      if (!ch) throw new Error("no EA chart tile");
      const n = ch.querySelector(".ab-stat-v").textContent.trim();
      if (n !== "5") throw new Error("reads " + JSON.stringify(n) + " with 5 agents attached");
    });

    check("the rewrite dropped the inline styles it used to be made of", () => {
      const inline = (about.match(/style="/g) || []).length;
      if (inline > 0) throw new Error(inline + " inline style attributes remain");
    });

    check("every class the About page uses has a rule in the stylesheet", () => {
      const used = new Set();
      for (const m of about.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (/^ab-/.test(c)) used.add(c);
      }
      if (used.size < 8) throw new Error("only " + used.size + " named classes; the page is still inline-styled");
      const missing = [...used].filter((c) => !appCss.includes("." + c));
      if (missing.length) throw new Error("no CSS for: " + missing.join(", "));
    });

    check("the About page is told what to do on a phone", () => {
      const sec = appCss.slice(appCss.indexOf(".about .ab-grid")).replace(/\s*\n\s*/g, "");
      if (!/@media\s*\(max-width:560px\)\{[\s\S]{0,500}?\.ab-/.test(sec)) {
        throw new Error("no narrow-screen rules for the About page");
      }
    });

    check("the two-column About layout collapses before it runs out of room", () => {
      /* A sticky 300px rail beside the detail is right on a desktop and
         wrong the moment the pair no longer fits; the rail has to stop
         being a rail rather than squeezing the content next to it. */
      const sec = appCss.slice(appCss.indexOf(".about .ab-grid")).replace(/\s*\n\s*/g, "");
      if (!/\.about \.ab-grid\{[^}]*grid-template-columns:minmax\(0,300px\)/.test(sec)) {
        throw new Error("the desktop layout is not two columns");
      }
      const m = /@media\s*\(max-width:900px\)\{([\s\S]{0,300}?)\}\}/.exec(sec);
      if (!m) throw new Error("the two-column layout never collapses");
      if (!/grid-template-columns:minmax\(0,1fr\)/.test(m[1])) throw new Error("it collapses to something other than one column");
      if (!/position:static/.test(m[1])) throw new Error("the rail is still sticky once stacked");
    });

    check("the version shown is the real one, not a hard-coded string", () => {
      T.S.version = "9.9.9";
      const html = T.views.about();
      T.S.version = null;
      if (!html.includes("v9.9.9")) throw new Error("the page does not show the version it was given");
    });
  }
}

/* ======================================================================
   Translations
   ====================================================================== */

check("every new string is translated in all three languages", () => {
  const want = { markets: ["search_sym", "no_sym_match"], about: ["glance", "engine", "ea_charts"] };
  const missing = [];
  for (const code of ["en", "fa", "ar"]) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", code + ".json"), "utf8"));
    for (const [sec, keys] of Object.entries(want)) {
      for (const k of keys) {
        if (!d[sec] || !d[sec][k]) missing.push(`${code}.${sec}.${k}`);
      }
    }
  }
  if (missing.length) throw new Error("missing: " + missing.join(", "));
});

check("the chart workspace's new strings are translated too", () => {
  const missing = [];
  for (const code of ["en", "fa", "ar"]) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", code + ".json"), "utf8"));
    for (const k of ["switch_symbol", "search_sym", "no_sym"]) {
      if (!d.chart || !d.chart[k]) missing.push(`${code}.chart.${k}`);
    }
  }
  if (missing.length) throw new Error("missing: " + missing.join(", "));
});

const passed = results.filter(Boolean).length;
console.log(`\nsymbol-search-about: ${passed} of ${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
