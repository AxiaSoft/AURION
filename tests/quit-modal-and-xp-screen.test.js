/**
 * Pressing the X asks inside AURION, and the screen it stops behind
 * is not the one it starts behind.
 *
 * Asked for in these words:
 *   "when I press the app's X button for shutdown, don't bring a
 *    Windows modal - bring an AURION modal, inside the app"
 *   "and the shutdown page looks like the initial loading screen -
 *    design it like the Windows XP shutdown screen"
 *
 * The second one is not decoration. Pressing the X put the START-UP
 * splash back, unchanged: same mark, same sweeping bar, same wash. So
 * the picture that means "AURION is stopping" was pixel for pixel the
 * picture that means "AURION is starting", and a start-up screen that
 * will not go away reads as a product that has hung.
 *
 *     node tests/quit-modal-and-xp-screen.test.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const APP = read("apps", "web", "js", "app.js");
const CSS = read("apps", "web", "css", "app.css");
const WIN = read("installer", "window", "AppWindow.cs");
const SPLASH = read("installer", "window", "SplashPanel.cs");

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push(true);
    console.log("PASS  " + name + (note ? "  - " + note : ""));
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + name + "\n      " + e.message);
  }
}

/** Strip // and /* *​/ comments, so a rule is never confirmed by its own prose. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");
}

const WINC = code(WIN);
const SPLASHC = code(SPLASH);
const APPC = code(APP);

/** The body of one CSS rule, comments already gone. */
function rule(selector) {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = src.indexOf(selector + "{");
  if (at < 0) throw new Error(selector + " has no rule");
  return src.slice(at + selector.length + 1, src.indexOf("}", at));
}

/* ── 1. the X asks inside AURION ───────────────────────────────────── */

check("the X hands the question to the desk before reaching for a MessageBox", () => {
  const at = WINC.indexOf("private async void OnFormClosing");
  if (at < 0) throw new Error("OnFormClosing is gone");
  const body = WINC.slice(at, WINC.indexOf("\n    }", WINC.indexOf("AskToShutDown()", at)));
  const askDesk = body.indexOf("AskTheDeskToConfirmShutdown()");
  const askWin = body.indexOf("AskToShutDown()");
  if (askDesk < 0) throw new Error("the X never asks the desk");
  if (askWin < 0) throw new Error("the Win32 fallback was removed entirely");
  if (askDesk > askWin) throw new Error("the Windows box is still tried first");
  return "desk first, MessageBox second";
});

check("a desk that takes the question stops the close dead", () => {
  /* If the desk owns the question, this close must end here - the
     trader answers inside AURION, and "yes" comes back as the
     ordinary shutdown message. Carrying on would show both. */
  const at = WINC.indexOf("if (AskTheDeskToConfirmShutdown()) return;");
  if (at < 0) throw new Error("the host does not stand down when the desk takes it");
});

check("the host waits only for an acknowledgement, never for the answer", () => {
  /* The trader may take as long as they like. The host is only
     finding out whether the page is alive enough to ask at all. */
  if (!/DeskAskAckMs/.test(WINC)) throw new Error("there is no acknowledgement budget");
  const ms = Number(/DeskAskAckMs = (\d+)/.exec(WINC)[1]);
  if (!(ms > 0 && ms <= 5000)) throw new Error("the budget is " + ms + "ms, which is a hang");
  return ms + "ms to acknowledge";
});

check("a page that cannot answer still closes the window", () => {
  /* The fallback is the whole reason this is safe. A crashed page
     never acknowledges, the budget runs out, and the Win32 box
     appears - rather than a window that will not close. */
  const at = WINC.indexOf("private bool AskTheDeskToConfirmShutdown");
  const body = WINC.slice(at, WINC.indexOf("\n    }", WINC.indexOf("_deskAsking = false;\n        return _deskAskAcked;", at)));
  if (!/if \(core == null\) return false;/.test(body)) {
    throw new Error("a missing WebView is not handled, so the X would do nothing");
  }
  if (!/return _deskAskAcked;/.test(body)) {
    throw new Error("the host does not report whether the desk took the question");
  }
});

check("the acknowledgement is read before the shutdown message", () => {
  /* "shutdown" is a substring of "ask-shutdown-shown". Tested the
     other way round, acknowledging the modal would quit the
     application - the user would press the X and AURION would close
     without ever asking. */
  const ack = WINC.indexOf('ask-shutdown-shown');
  const quit = WINC.indexOf('raw.Contains("' + '\\' + '"shutdown' + '\\' + '"")');
  if (ack < 0) throw new Error("the host does not listen for the acknowledgement");
  if (quit < 0) throw new Error("the shutdown message is no longer handled");
  if (ack > quit) throw new Error("the acknowledgement would be read as a quit");
});

check("the desk answers the ask with its own modal, not a second one", () => {
  if (!/msg\.type === "ask-shutdown"/.test(APPC)) {
    throw new Error("the desk ignores the host's question");
  }
  if (!/quitAurion\(\{ asked: "window" \}\)/.test(APPC)) {
    throw new Error("the X does not run the same quit the power button runs");
  }
  /* One wording, one modal. A separate confirm for the X would be a
     second kind of quit with no way to tell which you used. */
  const body = APPC.slice(APPC.indexOf("async function quitAurion"));
  if (!/askConfirm\(\{/.test(body.slice(0, 1200))) {
    throw new Error("quitAurion no longer asks through the desk's own modal");
  }
});

check("the desk acknowledges only when the host was the one asking", () => {
  const body = APPC.slice(APPC.indexOf("async function quitAurion"));
  const head = body.slice(0, 1200);
  if (!/asked === "window"/.test(head)) {
    throw new Error("the desk does not distinguish the X from its own power button");
  }
  if (!/ask-shutdown-shown/.test(head)) throw new Error("the desk never acknowledges");
  if (head.indexOf("ask-shutdown-shown") > head.indexOf("askConfirm({")) {
    throw new Error("the acknowledgement is sent after the modal blocks, which is too late");
  }
});

check("saying no leaves the window open and says nothing", () => {
  /* The host cancelled the close before asking, so silence is the
     correct reply to "no" - and a message would have to be handled. */
  const body = APPC.slice(APPC.indexOf("async function quitAurion"));
  const head = body.slice(0, 1600);
  if (!/if \(!yes\) return;/.test(head)) throw new Error("a refusal does not stop the quit");
});

/* ── 2. the XP shutdown screen ─────────────────────────────────────── */

check("the native splash has a shutdown face of its own", () => {
  if (!/public bool ShuttingDown/.test(SPLASHC)) {
    throw new Error("SplashPanel still has only one face");
  }
  /* Anchored on the guard itself, not merely on the call: a call sat
     behind a constant false - or behind any other condition - would
     mean the start-up face is still what the trader sees. */
  if (!/if \(_shuttingDown\)\s*\{\s*PaintShutdown\(g, w, h\);\s*return;\s*\}/.test(SPLASHC)) {
    throw new Error("OnPaint does not hand off to the shutdown face when shutting down");
  }
});

check("...and the window turns it on when it stops, not the start-up one", () => {
  const at = WINC.indexOf("private void ShowStoppingScreen");
  const body = WINC.slice(at, WINC.indexOf("\n    }", at));
  if (!/_splash\.ShuttingDown = true;/.test(body)) {
    throw new Error("pressing the X still shows the start-up screen");
  }
  /* Indeterminate: nothing can know how long the engine takes to let
     go of MetaTrader, so a filling bar would be inventing a number.
     It used to be set to a flat 0.5f, which is a made-up half. */
  if (/_splash\.Progress = 0\.5f;/.test(body)) {
    throw new Error("the bar still claims to be half way through");
  }
  if (!/_splash\.Progress = -1f;/.test(body)) {
    throw new Error("the shutdown bar is not indeterminate");
  }
});

check("the two faces do not share a backdrop", () => {
  /* Sharing the wash would undo the whole point at a glance. */
  const at = SPLASHC.indexOf("private Bitmap BuildBackdrop");
  const body = SPLASHC.slice(at, SPLASHC.indexOf("\n    private", at + 10));
  const branch = body.indexOf("if (_shuttingDown)");
  const aurora = body.indexOf("Aurion.Shell.Aurora.Paint");
  if (branch < 0) throw new Error("the backdrop is the same for both faces");
  if (aurora > 0 && branch > aurora) throw new Error("the start-up wash is painted first anyway");
  if (!/return bmp;/.test(body.slice(branch, aurora > 0 ? aurora : undefined))) {
    throw new Error("the shutdown backdrop falls through into the start-up one");
  }
});

check("switching faces throws the cached backdrop away", () => {
  /* It is cached per size, not per face, so without this the first
     face painted would be the one shown for ever. */
  const at = SPLASHC.indexOf("public bool ShuttingDown");
  const body = SPLASHC.slice(at, SPLASHC.indexOf("\n    }\n", at));
  if (!/_backdrop\?\.Dispose\(\);/.test(body) || !/_backdrop = null;/.test(body)) {
    throw new Error("the stale backdrop survives the switch");
  }
  if (!/Invalidate\(\);/.test(body)) throw new Error("nothing repaints after the switch");
});

check("the XP marquee is blocks that travel, not a bar that fills", () => {
  /* XP never claimed to know how far through it was. Neither can
     this, so the shape has to be a marquee. */
  const at = SPLASHC.indexOf("private void PaintShutdown");
  const body = SPLASHC.slice(at, SPLASHC.indexOf("\n    private static GraphicsPath", at));
  if (!/for \(var i = 0; i < 3; i\+\+\)/.test(body)) {
    throw new Error("the marquee is not a train of separate blocks");
  }
  if (!/_sweep/.test(body)) throw new Error("the train does not move");
  if (!/g\.SetClip\(inner\);/.test(body)) {
    throw new Error("the blocks are not clipped, so they would spill out of the trough");
  }
  if (!/g\.Clip = clip;/.test(body)) throw new Error("the clip is never restored");
});

check("the desk's own shutdown veil is XP too, and is not themed", () => {
  const veil = rule(".shutdown-veil");
  /* A shutdown screen that changes colour with a setting nobody can
     reach at that moment is a worse idea than a fixed one - and XP's
     blue has no dark and light variant. */
  if (/var\(--s1\)|var\(--bg\)/.test(veil)) {
    throw new Error("the veil still paints itself from the theme");
  }
  if (!/#0a2259|#10387a|#050f33/i.test(veil)) throw new Error("the veil is not XP's field");
  if (/backdrop-filter/.test(veil)) {
    throw new Error("the glass is still on, which is the live-looking desk showing through");
  }
  const bar = rule(".shutdown-veil .sd-bar i");
  if (!/repeating-linear-gradient/.test(bar)) {
    throw new Error("the web marquee is a solid band, not XP's blocks");
  }
  if (!/#8fe06a/i.test(bar)) throw new Error("the blocks are not XP's progress green");
});

check("the veil still stands down when the product has actually stopped", () => {
  /* The one piece of behaviour the restyle must not lose: a bar that
     spins for ever over a stopped product is the hang it is meant to
     rule out. */
  if (!/\.shutdown-veil\.done \.sd-bar\{display:none\}/.test(CSS.replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " ")).replace(/\n/g, "\n"))) {
    if (!/\.shutdown-veil\.done \.sd-bar\s*\{\s*display:\s*none\s*\}/.test(CSS)) {
      throw new Error("the finished state no longer hides the marquee");
    }
  }
  if (!/@media \(prefers-reduced-motion:reduce\)/.test(CSS)) {
    throw new Error("the reduced-motion case was lost");
  }
});

console.log("");
const bad = results.filter((r) => !r).length;
console.log(`quit-modal-and-xp-screen: ${bad ? bad + " of " + results.length + " checks FAILED" : results.length + " checks passed"}`);
process.exit(bad ? 1 : 0);
