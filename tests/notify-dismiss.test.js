/**
 * Notifications: getting rid of them, and what they sound like.
 *
 * Two requests. Every in-app notification must be dismissable by a swipe
 * or a close button, on a phone and on a desk alike; ordinary
 * notifications must make a sound; and any sound must be replaceable by an
 * .ogg file placed in the source tree - apps/web/assets/sounds/<event>.ogg
 * - rather than uploaded from the desk.
 *
 * The interesting part of this file is not the new features, it is the
 * two defects the work uncovered, which are checked here as regressions:
 *
 *   - swiping a trade or signal card called dismissNote(), the *server*
 *     dismissal. Those cards are raised locally and are not in S.notes, so
 *     the request was for an id the engine has never heard of, and the
 *     repaint that followed rebuilt the stack from S.notes alone - wiping
 *     every other local card off the screen.
 *   - the same repaint ran on every poll of /api/notify. A routine poll
 *     with nothing new in it would therefore delete a trade alert that had
 *     arrived a second earlier.
 *
 * Swipes are driven as real pointer events rather than by calling the
 * handler, because the questions worth asking - does a flick count, does a
 * cancelled gesture leave the card stranded, can the close button still be
 * clicked - are all about the event sequence.
 *
 *     node tests/notify-dismiss.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "apps", "web");
const results = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(true); console.log("PASS  " + name); })
    .catch((err) => {
      results.push(false);
      console.log("FAIL  " + name + "\n      " + String(err && err.message).replace(/\n/g, "\n      "));
    });
}

let jsdom;
try { jsdom = require(require.resolve("jsdom")); } catch {
  console.log("SKIP  jsdom is not installed");
  process.exit(0);
}
const { JSDOM, VirtualConsole } = jsdom;

/* ------------------------------------------------------------- test doubles */

/** Records every sound the desk asks for, so "did it make a noise" is answerable. */
function makeAudio(played) {
  class FakeParam { constructor() { this.value = 0; } setValueAtTime() {} exponentialRampToValueAtTime() {} }
  return class FakeAudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: new FakeParam(), connect: (n) => n }; }
    createOscillator() {
      const osc = { type: "sine", frequency: { value: 0 }, connect: (n) => n, start() {}, stop() {} };
      played.push({ kind: "tone" });
      return osc;
    }
    createBufferSource() {
      const src = { buffer: null, connect: (n) => n, start: () => played.push({ kind: "file", buffer: src.buffer }) };
      return src;
    }
    /* Decoding is what proves a file is playable, so the double has to be
       able to refuse: anything not starting with "OggS" is rejected, the
       way a browser rejects a file that is not really Ogg. */
    decodeAudioData(buf) {
      const head = Buffer.from(new Uint8Array(buf).slice(0, 4)).toString("latin1");
      if (head !== "OggS") return Promise.reject(new Error("EncodingError"));
      return Promise.resolve({ duration: 1.25, _tag: "decoded" });
    }
  };
}

const OGG = Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(600)]);
const NOT_OGG = Buffer.concat([Buffer.from("ID3\u0003", "latin1"), Buffer.alloc(600)]);

/* ------------------------------------------------------------------- boot */

async function boot() {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const win = dom.window;
  const played = [];
  const posted = [];
  /* Which files this pretend build ships. The desk fetches
     assets/sounds/<slot>.ogg at boot, so shipping one is a matter of
     putting it in here. */
  const shipped = new Map();

  win.fetch = async (url, opt) => {
    const href = String(url);
    posted.push({ url: href, method: (opt && opt.method) || "GET" });
    /* The real packs, served from disk. A stub that answers every request
       with an empty object leaves I18N with nothing, every label renders
       as its own key, and the translation checks below would pass on a
       panel that is entirely untranslated. */
    const snd = /\/?assets\/sounds\/([a-z]+)\.ogg/.exec(href);
    if (snd) {
      const body = shipped.get(snd[1]);
      if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
    }
    const lang = /\/lang\/([a-z]{2})\.json/.exec(href);
    if (lang) {
      const body = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", lang[1] + ".json"), "utf8"));
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }), text: async () => "{}" };
  };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.URL.createObjectURL = () => "blob:stub";
  win.AudioContext = makeAudio(played);

  const bundle = ["js/themes.js", "js/skins.js", "js/i18n.js", "js/api.js", "js/calendar.js", "js/charts.js", "js/app.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n;\n");
  win.eval(bundle +
    "\n;window.__T = { S, toast, bindDismiss, paintNotifies, dismissNote, pushTradeCard, playSound," +
    " notifyPrefs, saveNotifyPrefs, loadSoundFiles, SOUND_FILES, SOUND_DIR," +
    " SOUND_SLOTS, NOTIFY_DEFAULTS, notifySoundCardHtml, icon, I18N };");
  await new Promise((r) => setTimeout(r, 60));
  return { win, doc: win.document, T: win.__T, played, posted, shipped };
}

/* Pointer plumbing. jsdom has no PointerEvent and no pointer capture, so
   both are supplied - the code under test uses them on every gesture. */
function pointer(win, el, type, x, opts) {
  const e = new win.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 7, pointerType: (opts && opts.pointerType) || "touch", clientX: x, clientY: 40, button: 0 });
  el.dispatchEvent(e);
}
function enableCapture(el) {
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  if (!el.offsetWidth) Object.defineProperty(el, "offsetWidth", { value: 340, configurable: true });
}
/** A complete swipe, with a settable duration so a flick can be told from a drag. */
async function swipe(win, el, dx, opts) {
  opts = opts || {};
  enableCapture(el);
  pointer(win, el, "pointerdown", 200, opts);
  if (opts.slow) await new Promise((r) => setTimeout(r, 160));
  pointer(win, el, "pointermove", 200 + dx, opts);
  if (opts.cancel) { pointer(win, el, "pointercancel", 200 + dx, opts); return; }
  pointer(win, el, "pointerup", 200 + dx, opts);
  await new Promise((r) => setTimeout(r, 360));   // the fling transition
}

(async () => {
  const { win, doc, T, played, posted, shipped } = await boot();
  const stack = () => doc.getElementById("notify-stack");
  /* Messages are shown to the trader, so they are asserted as text. That
     only means anything with a pack loaded. */
  await T.I18N.load("en");

  /* ===================================================== dismissing things == */

  await check("an ordinary notification has a close button", () => {
    const el = T.toast("saved");
    const x = el.querySelector("[data-nx]");
    if (!x) throw new Error("no close button on a toast");
    if (!x.querySelector("svg")) throw new Error("the close button is not a real icon");
    if (/[x\u00d7\u2715\u2716]/.test(x.textContent || "")) throw new Error("still a typed glyph: " + x.textContent);
  });

  await check("the close button removes the notification", () => {
    const el = T.toast("saved");
    el.querySelector("[data-nx]").click();
    if (el.isConnected) throw new Error("the toast is still on screen");
  });

  await check("a notification can be swiped away with a finger", async () => {
    const el = T.toast("swipe me");
    await swipe(win, el, 160, { pointerType: "touch" });
    if (el.isConnected) throw new Error("still on screen after a 160px swipe");
  });

  await check("a notification can be swiped away with a mouse", async () => {
    /* "whether mobile or computer": the same gesture, driven by a mouse. */
    const el = T.toast("swipe me");
    await swipe(win, el, 160, { pointerType: "mouse" });
    if (el.isConnected) throw new Error("a mouse drag did not dismiss it");
  });

  await check("it can be swiped either way", async () => {
    const a = T.toast("left");
    await swipe(win, a, -160, { pointerType: "touch" });
    if (a.isConnected) throw new Error("a leftward swipe did nothing");
  });

  await check("a short flick counts, a short slow drag does not", async () => {
    const quick = T.toast("flick");
    await swipe(win, quick, 60, { pointerType: "touch" });
    if (quick.isConnected) throw new Error("a fast 60px flick was ignored");

    const nudge = T.toast("nudge");
    await swipe(win, nudge, 40, { pointerType: "touch", slow: true });
    if (!nudge.isConnected) throw new Error("a slow 40px nudge dismissed it");
    if (nudge.style.transform) throw new Error("the card was left displaced: " + nudge.style.transform);
  });

  await check("a cancelled gesture puts the card back", async () => {
    /* The browser takes the pointer away when it decides the gesture was a
       scroll. Without pointercancel the card stays where the finger left
       it - half off-screen and half transparent - for ever. */
    const el = T.toast("cancel me");
    await swipe(win, el, 120, { pointerType: "touch", cancel: true });
    if (!el.isConnected) throw new Error("a cancelled swipe dismissed it");
    if (el.style.transform || el.style.opacity) {
      throw new Error("left stranded at " + el.style.transform + " / " + el.style.opacity);
    }
  });

  await check("a drag that starts on a button is not a swipe", () => {
    /* Capturing the pointer on the close button would make it unclickable. */
    const el = T.toast("buttons");
    enableCapture(el);
    const x = el.querySelector("[data-nx]");
    pointer(win, x, "pointerdown", 300, { pointerType: "touch" });
    pointer(win, el, "pointermove", 180, { pointerType: "touch" });
    if (el.style.transform) throw new Error("the card followed a press on its own button");
    x.click();
    if (el.isConnected) throw new Error("the close button stopped working");
  });

  /* ------------------------- the two defects the work uncovered ----------- */

  await check("swiping a trade card does not ask the engine to dismiss it", async () => {
    T.S.notes = [];
    T.pushTradeCard({ kind: "entry", side: "buy", symbol: "EURUSD", volume: 0.2, price: 1.085, ticket: 991 });
    const card = stack().querySelector(".trade-card");
    if (!card) throw new Error("no trade card was raised");
    posted.length = 0;
    await swipe(win, card, 200, { pointerType: "touch" });
    if (card.isConnected) throw new Error("the card is still there");
    const dismissals = posted.filter((p) => /\/api\/notify\/.+\/dismiss/.test(p.url));
    if (dismissals.length) {
      throw new Error("asked the engine to dismiss a local card: " + dismissals[0].url);
    }
  });

  await check("dismissing one card leaves the others alone", async () => {
    T.S.notes = [];
    stack().innerHTML = "";
    T.pushTradeCard({ kind: "entry", side: "buy", symbol: "EURUSD", ticket: 1 });
    T.pushTradeCard({ kind: "entry", side: "sell", symbol: "XAUUSD", ticket: 2 });
    T.pushTradeCard({ kind: "exit", result: "profit", symbol: "GBPJPY", ticket: 3, profit: 12 });
    if (stack().children.length !== 3) throw new Error("expected 3 cards, got " + stack().children.length);
    await swipe(win, stack().children[1], 200, { pointerType: "touch" });
    const left = stack().children.length;
    if (left !== 2) throw new Error(`dismissing one card left ${left} of the other 2`);
  });

  await check("a routine notification poll does not wipe the trade cards", async () => {
    /* The reported shape of this: a trade alert arrives, and a second
       later it is gone, with nothing having happened. */
    T.S.notes = [];
    stack().innerHTML = "";
    T.pushTradeCard({ kind: "entry", side: "buy", symbol: "EURUSD", ticket: 7 });
    T.paintNotifies();                       // a poll that returned nothing new
    if (!stack().querySelector(".trade-card")) throw new Error("the trade card was deleted by the poll");
    if (stack().hidden) throw new Error("the stack was hidden while a card was still in it");
  });

  await check("engine notes and local cards live in the same stack", async () => {
    T.S.notes = [];
    stack().innerHTML = "";
    T.pushTradeCard({ kind: "entry", side: "buy", symbol: "EURUSD", ticket: 8 });
    T.S.notes = [{ id: "n1", title: "Engine", body: "restarted" }];
    T.paintNotifies();
    if (!stack().querySelector(".trade-card")) throw new Error("the local card went");
    if (!stack().querySelector('[data-note="server"]')) throw new Error("the engine note did not arrive");
    T.S.notes = [];
    T.paintNotifies();
    if (!stack().querySelector(".trade-card")) throw new Error("clearing engine notes took the local card with it");
    if (stack().querySelector('[data-note="server"]')) throw new Error("the engine note stayed");
  });

  await check("an engine note is dismissed on the engine too", async () => {
    T.S.notes = [{ id: "n2", title: "Engine", body: "note" }];
    stack().innerHTML = "";
    T.paintNotifies();
    const card = stack().querySelector('[data-note="server"]');
    posted.length = 0;
    await swipe(win, card, 200, { pointerType: "touch" });
    await new Promise((r) => setTimeout(r, 30));
    if (card.isConnected) throw new Error("the card stayed on screen");
    if (!posted.some((p) => p.url.includes("/api/notify/n2/dismiss"))) {
      throw new Error("the engine was never told");
    }
  });

  await check("a note dismissed while offline still goes away", async () => {
    /* The card has already slid off the screen by the time the request
       runs. Putting it back because the engine is unreachable is the wrong
       answer to "I dismissed that". */
    T.S.notes = [{ id: "n3", title: "Engine", body: "note" }];
    stack().innerHTML = "";
    T.paintNotifies();
    const card = stack().querySelector('[data-note="server"]');
    const realFetch = win.fetch;
    win.fetch = async () => { throw new Error("offline"); };
    await T.dismissNote("n3");
    win.fetch = realFetch;
    if (card.isConnected) throw new Error("the card came back when the request failed");
    if ((T.S.notes || []).some((n) => n.id === "n3")) throw new Error("it is still in the list");
  });

  /* ========================================================== sounds ====== */

  await check("an ordinary notification makes a sound", () => {
    T.saveNotifyPrefs({ notice: "soft", volume: 0.6 });
    played.length = 0;
    T.toast("something happened");
    if (!played.length) throw new Error("the toast was silent");
  });

  await check("a burst of notifications is not a burst of noise", async () => {
    /* Saving a form can raise three toasts in a row; three chimes on top
       of each other is a noise, not a notification.

       The wait is the rate-limit window from the *previous* check, which
       would otherwise silence this one and make it pass for the wrong
       reason. */
    await new Promise((r) => setTimeout(r, 1000));
    played.length = 0;
    T.toast("one"); T.toast("two"); T.toast("three");
    const tones = played.filter((p) => p.kind === "tone").length;
    if (tones === 0) throw new Error("none of them made a sound");
    if (tones > 1) throw new Error(tones + " tones for three toasts in the same moment");
  });

  await check("ordinary notifications can be silenced on their own", async () => {
    T.saveNotifyPrefs({ notice: "none" });
    await new Promise((r) => setTimeout(r, 1000));   // clear the rate limit
    played.length = 0;
    T.toast("quiet please");
    if (played.length) throw new Error("it played something after being set to Silent");
    T.saveNotifyPrefs({ notice: "soft" });
  });

  await check("the volume slider silences everything", async () => {
    T.saveNotifyPrefs({ volume: 0 });
    await new Promise((r) => setTimeout(r, 1000));
    played.length = 0;
    T.toast("muted");
    T.playSound("chime", undefined, "entry");
    if (played.length) throw new Error("sound came out at zero volume");
    T.saveNotifyPrefs({ volume: 0.6 });
  });

  /* --------------------- .ogg files shipped with the build ---------------- */

  await check("there is no way to upload a sound from the desk", () => {
    /* Removed by request: the sounds belong in the build, so that every
       installation of the product sounds the same. */
    const html = T.notifySoundCardHtml();
    if (/<input[^>]+type="file"/.test(html)) throw new Error("a file input is still in the panel");
    for (const gone of ["data-sndfile", "data-snddel", "snd-up", "snd-fname"]) {
      if (html.includes(gone)) throw new Error(gone + " is still rendered");
    }
    const appJs = fs.readFileSync(path.join(WEB, "js", "app.js"), "utf8");
    for (const gone of ["putCustomSound", "delCustomSound", "CUSTOM_SOUNDS", "indexedDB"]) {
      if (appJs.includes(gone)) throw new Error(gone + " is still in the source");
    }
  });

  await check("the desk looks for one file per event, named after it", () => {
    /* The contract the README documents. If these names drift, the files
       a customer drops in stop being found and nothing says why. */
    if (T.SOUND_DIR !== "assets/sounds/") throw new Error("the folder moved to " + T.SOUND_DIR);
    const want = ["entry", "profit", "loss", "notice"];
    const got = T.SOUND_SLOTS.slice().sort();
    if (got.join(",") !== want.slice().sort().join(",")) throw new Error("slots are " + got.join(","));
  });

  await check("the README documents exactly the names the code looks for", () => {
    /* Documentation that disagrees with the code is worse than none: the
       customer follows it, the sound never plays, and nothing explains it. */
    const readme = fs.readFileSync(path.join(WEB, "assets", "sounds", "README.md"), "utf8");
    for (const slot of T.SOUND_SLOTS) {
      if (!readme.includes("`" + slot + ".ogg`")) throw new Error(slot + ".ogg is not documented");
    }
    const named = [...readme.matchAll(/`([a-z]+)\.ogg`/g)].map((m) => m[1]);
    const stray = named.filter((n) => !T.SOUND_SLOTS.includes(n));
    if (stray.length) throw new Error("the README names files the desk never looks for: " + stray.join(", "));
  });

  await check("a slot with no file in the build keeps its built-in tone", async () => {
    shipped.clear();
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    if (T.SOUND_FILES.size) throw new Error("found files that were not shipped");
    win.localStorage.removeItem("aurion.notify");
    const prefs = T.notifyPrefs();
    if (prefs.entry !== T.NOTIFY_DEFAULTS.entry) throw new Error("entry defaulted to " + prefs.entry);
    played.length = 0;
    T.playSound(prefs.entry, 0.6, "entry");
    if (!played.filter((x) => x.kind === "tone").length) throw new Error("the slot went silent");
  });

  await check("a shipped file is found and used", async () => {
    shipped.set("entry", OGG);
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    if (!T.SOUND_FILES.has("entry")) throw new Error("entry.ogg was not picked up");
    played.length = 0;
    T.playSound("file", 0.6, "entry");
    await new Promise((r) => setTimeout(r, 40));
    const files = played.filter((p) => p.kind === "file");
    if (!files.length) throw new Error("it played a built-in tone instead of the file");
    if (!files[0].buffer || files[0].buffer._tag !== "decoded") throw new Error("the buffer was not the decoded file");
  });

  await check("a shipped file becomes that event's default", async () => {
    /* The point of shipping it. A sound nobody selects is a sound nobody
       hears. */
    win.localStorage.removeItem("aurion.notify");
    shipped.set("profit", OGG);
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    const prefs = T.notifyPrefs();
    if (prefs.profit !== "file") throw new Error("profit defaulted to " + prefs.profit);
    if (prefs.loss !== T.NOTIFY_DEFAULTS.loss) throw new Error("a slot with no file was changed too");
  });

  await check("a trader's own choice outranks the shipped file", async () => {
    win.localStorage.setItem("aurion.notify", JSON.stringify({ profit: "ding" }));
    const prefs = T.notifyPrefs();
    if (prefs.profit !== "ding") throw new Error("the shipped file overrode an explicit choice");
  });

  await check("a file that is not really Ogg falls back to the tone", async () => {
    /* A renamed .mp3, or a truncated copy. Decoding is what tells the
       difference, and the failure must not be silence - silence is
       indistinguishable from the notification no longer arriving. */
    shipped.clear();
    shipped.set("loss", NOT_OGG);
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    played.length = 0;
    T.playSound("file", 0.6, "loss");
    await new Promise((r) => setTimeout(r, 60));
    if (played.some((p) => p.kind === "file")) throw new Error("an undecodable file was played");
    if (T.SOUND_FILES.has("loss")) throw new Error("it was kept after failing to decode");
    played.length = 0;
    T.playSound("file", 0.6, "loss");
    await new Promise((r) => setTimeout(r, 30));
    if (!played.filter((x) => x.kind === "tone").length) throw new Error("the slot went silent instead");
  });

  await check("a 404 page is not mistaken for a sound", async () => {
    /* A dev server that answers every unknown path with index.html would
       otherwise register an HTML page as entry.ogg. */
    shipped.clear();
    shipped.set("notice", Buffer.from("<!doctype html><html></html>", "latin1"));
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    if (T.SOUND_FILES.has("notice")) throw new Error("an HTML page was accepted as a sound");
  });

  await check('"Sound file" is offered only when the build ships one', async () => {
    shipped.clear();
    shipped.set("notice", OGG);
    T.SOUND_FILES.clear();
    await T.loadSoundFiles();
    const html = T.notifySoundCardHtml();
    const lossRow = html.slice(html.indexOf('data-sndrow="loss"'), html.indexOf('data-sndrow="notice"'));
    if (lossRow.includes('value="file"')) throw new Error("a slot with no file offers one anyway");
    const noticeRow = html.slice(html.indexOf('data-sndrow="notice"'));
    if (!noticeRow.includes('value="file"')) throw new Error("a slot with a file does not offer it");
  });

  await check("the shipped sound can be previewed from the panel", () => {
    const html = T.notifySoundCardHtml();
    for (const slot of T.SOUND_SLOTS) {
      if (!html.includes(`data-sndtest="${slot}"`)) throw new Error("no preview button for " + slot);
    }
  });

  /* ------------------------------------------------------- the panel ------ */

  await check("the sound panel is translated in all three languages", async () => {
    const packs = ["en", "fa", "ar"].map((l) => JSON.parse(fs.readFileSync(path.join(ROOT, "lang", l + ".json"), "utf8")));
    const need = ["notice", "notice_hint", "snd_file", "custom_note", "dismiss"];
    const missing = [];
    packs.forEach((p, i) => {
      for (const k of need) if (!p.notify || !p.notify[k]) missing.push(["en", "fa", "ar"][i] + ".notify." + k);
    });
    if (missing.length) throw new Error("missing: " + missing.join(", "));
  });

  await check("the panel renders no raw i18n keys", async () => {
    await T.I18N.load("fa");
    const html = T.notifySoundCardHtml();
    const raw = html.match(/>\s*notify\.[a-z_]+\s*</g);
    if (raw) throw new Error("untranslated: " + raw.join(", "));
  });

  await check("every class the sound rows use has a rule in the stylesheet", () => {
    const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8");
    const html = T.notifySoundCardHtml();
    const missing = new Set();
    for (const m of html.matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (/^snd-/.test(c) && !css.includes("." + c)) missing.add(c);
      }
    }
    if (missing.size) throw new Error("no CSS for: " + [...missing].join(", "));
  });

  await check("the swipe layer claims only the horizontal axis", () => {
    /* touch-action is what decides whether the browser gives the gesture
       to the page or to the card. Without pan-y a swipeable toast eats a
       scroll that was meant for the page behind it. */
    const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8").replace(/\s*\n\s*/g, "");
    for (const sel of [".toast", ".notify-card"]) {
      const re = new RegExp(re_escape(sel) + "\\{[^}]*touch-action:pan-y");
      if (!re.test(css)) throw new Error("no touch-action:pan-y on " + sel);
    }
  });

  await check("the close button is big enough for a thumb", () => {
    const css = fs.readFileSync(path.join(WEB, "css", "app.css"), "utf8").replace(/\s*\n\s*/g, "");
    const at = css.search(/@media\s*\(pointer:coarse\)/);
    if (at < 0) throw new Error("no coarse-pointer block at all");
    const coarse = css.slice(at);
    const m = /\.n-x\{[^}]*width:(\d+)px/.exec(coarse);
    if (!m || Number(m[1]) < 32) throw new Error("the touch-size rule is missing or too small");
  });

  function re_escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const failed = results.filter((r) => !r).length;
  console.log(`\nnotify-dismiss: ${results.length - failed} of ${results.length} checks passed`);
  /* Explicit: booting the desk in jsdom starts its polling timers, and a
     suite that passes but never returns still breaks the build. */
  process.exit(failed ? 1 : 0);
})();
