const S = {
  firstRun: false,
  user: null,
  snap: null,
  // Every launch and every refresh lands on the command center — the desk
  // never restores the settings tab as the opening view.
  view: "command",
  setTab: localStorage.getItem("aurion.setTab") || "set-robot",
  candles: [],
  symbol: "",
  timeframe: "M15",
  aiSlide: 0,
  olSlide: 0,
  gateSlide: 0,
  logs: [],
  robotLogs: [],
  chart: null,
  live: null,
  chartSignals: [],
  showSignals: localStorage.getItem("aurion.showSignals") !== "0",
  signalsEnabled: localStorage.getItem("aurion.signalsEnabled") === "1",
  signalsLoading: false,
};
if (S.view === "risk" || S.view === "execution" || S.view === "profile") S.view = "command";

const NAV = [
  ["command", "nav.command", icon("grid")],
  ["markets", "nav.markets", icon("pulse")],
  ["intelligence", "nav.intelligence", icon("spark")],
  ["calendar", "nav.calendar", icon("cal")],
  ["strategies", "nav.strategies", icon("code")],
  ["charts", "nav.charts", icon("layers")],
  ["terminal", "nav.terminal", icon("term")],
  ["backtest", "nav.backtest", icon("flask")],
  ["history", "nav.history", icon("book")],
  ["upgrade", "nav.upgrade", icon("key")],
  ["settings", "nav.settings", icon("gear")],
  ["about", "nav.about", icon("info")],
];

function icon(name) {
  const p = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    pulse: '<polyline points="3,14 8,14 10,6 14,18 16,10 21,10"/>',
    spark: '<path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8z"/>',
    code: '<polyline points="8,8 4,12 8,16"/><polyline points="16,8 20,12 16,16"/><line x1="13" y1="6" x2="11" y2="18"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    bolt: '<polygon points="13,2 4,14 11,14 11,22 20,10 13,10"/>',
    layers: '<polygon points="12,3 21,8 12,13 3,8"/><polyline points="3,13 12,18 21,13"/><polyline points="3,17 12,22 21,17"/>',
    term: '<polyline points="5,8 10,12 5,16"/><line x1="12" y1="17" x2="19" y2="17"/>',
    book: '<path d="M4 5h7a3 3 0 013 3v12H7a3 3 0 00-3 3z"/><path d="M20 5h-7a3 3 0 00-3 3v12h7a3 3 0 013 3z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 21 2"/><path d="m15 8 3 3"/><path d="m18 5 3 3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
    info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    flask: '<path d="M9 3h6"/><path d="M10 3v5a6 6 0 00-3 5.2V19a1 1 0 001 1h8a1 1 0 001-1v-5.8A6 6 0 0014 8V3"/>',
    user: '<circle cx="12" cy="8" r="3.2"/><path d="M5 19c1.4-3.2 3.8-5 7-5s5.6 1.8 7 5"/>',
    bell: '<path d="M18 16V11a6 6 0 10-12 0v5l-1.6 2.2a.6.6 0 00.5.95h14.2a.6.6 0 00.5-.95z"/><path d="M10 21.5a2.2 2.2 0 004 0"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/><circle cx="8.5" cy="14.5" r="1.2"/><circle cx="15.5" cy="14.5" r="1.2"/><circle cx="12" cy="17.5" r="1.2"/>',
    /* Added when the emoji were taken out of the interface. Same grammar as
       the rest: 24x24, stroked in currentColor, no fills, so they inherit
       whatever colour and size the control around them already uses. */
    bellOff: '<path d="M18 16V11a6 6 0 00-8.3-5.5"/><path d="M6.3 7.7A6 6 0 006 11v5l-1.6 2.2a.6.6 0 00.5.95h12.3"/><path d="M10 21.5a2.2 2.2 0 004 0"/><line x1="3" y1="3" x2="21" y2="21"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.6 6a9.8 9.8 0 011.4-.1c6 0 9.5 6.1 9.5 6.1a17 17 0 01-2.8 3.5"/><path d="M6.3 7.8A16.7 16.7 0 002.5 12S6 18.1 12 18.1a9.4 9.4 0 004-.85"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/><line x1="3" y1="3" x2="21" y2="21"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 11-2.6-6.1"/><polyline points="20.5,3.5 20.5,8 16,8"/>',
    chart: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="12" width="3.2" height="6" rx="1"/><rect x="11.4" y="8" width="3.2" height="10" rx="1"/><rect x="16.8" y="4.5" width="3.2" height="13.5" rx="1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><line x1="15.8" y1="15.8" x2="20.5" y2="20.5"/>',
    clipboard: '<rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 4.5v1H9z"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13.5" y2="15"/>',
    wrench: '<path d="M14.8 6.2a4.6 4.6 0 00-6 6L4 17l3 3 4.8-4.8a4.6 4.6 0 006-6l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    building: '<path d="M4 21V6a2 2 0 012-2h7a2 2 0 012 2v15"/><path d="M15 10h3a2 2 0 012 2v9"/><line x1="2.5" y1="21" x2="21.5" y2="21"/><path d="M8 8h3M8 12h3M8 16h3"/>',
    check: '<polyline points="4.5,12.5 9.5,17.5 19.5,6.5"/>',
    hourglass: '<path d="M7 3h10"/><path d="M7 21h10"/><path d="M7 3v3.2c0 1 .4 1.9 1.1 2.6L12 12l-3.9 3.2A3.6 3.6 0 007 17.8V21"/><path d="M17 3v3.2c0 1-.4 1.9-1.1 2.6L12 12l3.9 3.2c.7.7 1.1 1.6 1.1 2.6V21"/>',
    close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    chevron: '<polyline points="6,9.5 12,15.5 18,9.5"/>',
    heart: '<path d="M12 20s-7.5-4.4-7.5-9.4A4.1 4.1 0 0112 8.2a4.1 4.1 0 017.5 2.4c0 5-7.5 9.4-7.5 9.4z"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 018 0v2.7"/>',
    headset: '<path d="M4.5 14v-2a7.5 7.5 0 0115 0v2"/><rect x="2.8" y="13.5" width="4" height="6" rx="1.6"/><rect x="17.2" y="13.5" width="4" height="6" rx="1.6"/><path d="M19.2 19.5a3.4 3.4 0 01-3.4 2.3H13"/>',
    megaphone: '<path d="M4 10v4a1.6 1.6 0 001.6 1.6H7l3.6 3.2a.8.8 0 001.4-.6V5.8a.8.8 0 00-1.4-.6L7 8.4H5.6A1.6 1.6 0 004 10z"/><path d="M16.5 9a4 4 0 010 6"/><path d="M19 6.5a7.5 7.5 0 010 11"/>',
    phone: '<path d="M7.6 3.5h-3A1.6 1.6 0 003 5.2 16.4 16.4 0 0018.8 21a1.6 1.6 0 001.7-1.6v-3a1.1 1.1 0 00-.95-1.1l-3-.45a1.1 1.1 0 00-1 .4l-1.2 1.4a12.6 12.6 0 01-5.1-5.1l1.4-1.2a1.1 1.1 0 00.4-1l-.45-3a1.1 1.1 0 00-1.1-.95z"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><polyline points="3.6,6.8 12,13 20.4,6.8"/>',
    send: '<path d="M21 3.5L10.8 13.7"/><path d="M21 3.5l-6.6 17.3-3.6-7.1-7.1-3.6z"/>',
    star: '<polygon points="12,3.6 14.4,9 20.2,9.6 15.8,13.5 17.1,19.2 12,16.2 6.9,19.2 8.2,13.5 3.8,9.6 9.6,9"/>',
    minus: '<line x1="5.5" y1="12" x2="18.5" y2="12"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.4" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.6"/><line x1="2.4" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.6" y2="12"/><line x1="5.2" y1="5.2" x2="7" y2="7"/><line x1="17" y1="17" x2="18.8" y2="18.8"/><line x1="18.8" y1="5.2" x2="17" y2="7"/><line x1="7" y1="17" x2="5.2" y2="18.8"/>',
    moon: '<path d="M20.2 14.3A8.4 8.4 0 0 1 9.7 3.8a8.4 8.4 0 1 0 10.5 10.5z"/>',
    themeAuto: '<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/>',
    volume: '<path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.4 6.6a7.5 7.5 0 0 1 0 10.8"/>',
    volumeOff: '<path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/><line x1="16.5" y1="9.5" x2="21" y2="14.5"/><line x1="21" y1="9.5" x2="16.5" y2="14.5"/>',
    play: '<path d="M8 5.6 18 12 8 18.4z"/>',
    plus: '<line x1="12" y1="5.5" x2="12" y2="18.5"/><line x1="5.5" y1="12" x2="18.5" y2="12"/>',
    target: '<circle cx="12" cy="12" r="7.2"/><line x1="12" y1="1.8" x2="12" y2="5.2"/><line x1="12" y1="18.8" x2="12" y2="22.2"/><line x1="1.8" y1="12" x2="5.2" y2="12"/><line x1="18.8" y1="12" x2="22.2" y2="12"/><circle cx="12" cy="12" r="1.6"/>',
    download: '<path d="M12 3.5v11"/><polyline points="7.5,10 12,14.5 16.5,10"/><path d="M4.5 17.5v1.5a2 2 0 002 2h11a2 2 0 002-2v-1.5"/>',
    box: '<polygon points="12,3 20.5,7.5 12,12 3.5,7.5"/><polyline points="3.5,7.5 3.5,16.5 12,21 20.5,16.5 20.5,7.5"/><line x1="12" y1="12" x2="12" y2="21"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p[name] || ""}</svg>`;
}

function $(id) { return document.getElementById(id); }
function leaveDesk(msg) {
  if (S._leaving) return;
  S._leaving = true;
  try {
    if (S.live) {
      try { S.live.close(); } catch { /* */ }
      S.live = null;
    }
    if (S._poll) { clearInterval(S._poll); S._poll = null; }
    if (S._termPoll) { clearInterval(S._termPoll); S._termPoll = null; }
    if (S._syncTimer) { clearTimeout(S._syncTimer); S._syncTimer = null; }
    if (S._prefTimer) { clearTimeout(S._prefTimer); S._prefTimer = null; }
    if (S._paintTimer) { clearTimeout(S._paintTimer); S._paintTimer = null; }
    S._refreshing = false;
    S._refreshAgain = false;
    S._refreshWait = null;
    S._hardRefreshing = false;
    S.mountedView = null;
    API.setToken("");
    S.user = null;
    S.snap = null;
    S.notes = [];
    const desk = $("desk");
    const auth = $("auth");
    if (desk) {
      desk.classList.add("hidden");
      desk.classList.remove("menu-open");
    }
    if (auth) auth.classList.remove("hidden");
    setMenu(false);
    setShell("auth");
    document.body.classList.remove("menu-open", "modal-open");
    const scrim = $("nav-scrim");
    if (scrim) scrim.hidden = true;
    const stack = $("notify-stack");
    if (stack) { stack.hidden = true; stack.innerHTML = ""; }
    const veil = $("pay-veil");
    if (veil) { veil.classList.add("hidden"); veil.innerHTML = ""; }
    const reload = $("desk-reload");
    if (reload) reload.classList.add("hidden");
    const modal = $("desk-modal");
    if (modal) { modal.hidden = true; modal.classList.remove("open"); modal.innerHTML = ""; }
    paintGate();
    const err = $("gate-err");
    if (err) err.textContent = msg || "";
  } finally {
    setTimeout(() => { S._leaving = false; }, 80);
  }
}
async function logout() {
  try { await API.post("/api/auth/logout", {}); } catch { /* */ }
  leaveDesk(I18N.t("auth.signed_out"));
}
window.AURION_onAuthLost = () => {
  if (S._leaving) return;
  if ($("desk") && !$("desk").classList.contains("hidden")) {
    leaveDesk(I18N.t("auth.session_boot"));
  }
};
/**
 * Where a floating layer has to live right now.
 *
 * While an element is fullscreen the browser paints that element's subtree
 * and nothing else, so a modal parented to <body> is simply not on screen -
 * which is how deleting a drawing from a fullscreen chart turned into
 * "nothing happens until you leave fullscreen". Anything that floats asks
 * for its host instead of assuming <body>.
 */
function overlayHost() {
  const fs = document.fullscreenElement;
  if (fs && fs !== document.documentElement && fs !== document.body) return fs;
  return document.body;
}

/**
 * Dismiss one notification, on a mouse or a finger, by swipe or by button.
 *
 * Pointer events rather than touch events, so this is one implementation
 * for both: a mouse drag across a toast dismisses it exactly as a thumb
 * does, which is what "whether mobile or computer" asks for.
 *
 * Four things here are not obvious and each one was a way to get stuck:
 *
 *   - the threshold is a fraction of the card's own width, not a fixed
 *     88px. A notification is 380px on a desk and can be a third of that
 *     on a narrow phone, where 88px is most of the card.
 *   - a fast flick counts even if it is short. Requiring the full distance
 *     makes a deliberate, slow drag the only way to dismiss, which is the
 *     opposite of what a flick is for.
 *   - pointercancel is handled. The browser takes the pointer away when it
 *     decides the gesture is a scroll, and without this the card stays
 *     where the finger left it: half off-screen, half transparent, for
 *     ever.
 *   - a drag that starts on a button is not a swipe. The close button and
 *     the "open chart" button live inside the card, and capturing their
 *     pointer would mean they could never be clicked.
 */
function bindDismiss(el, onGone) {
  if (!el || el._dismissBound) return;
  el._dismissBound = true;

  const finish = () => {
    if (el._gone) return;
    el._gone = true;
    if (typeof onGone === "function") onGone(el);
    else el.remove();
  };

  /* Slide the card out the way it was thrown before removing it, so the
     list closing up reads as a consequence of the gesture. */
  const fling = (dir) => {
    el.classList.add("n-out");
    el.style.transform = `translateX(${dir * Math.max(240, el.offsetWidth)}px)`;
    el.style.opacity = "0";
    const done = () => finish();
    el.addEventListener("transitionend", done, { once: true });
    // A card in a hidden tab gets no transitionend, so it would never leave.
    setTimeout(done, 320);
  };

  const reset = () => {
    el.classList.remove("swiping");
    el.style.transform = "";
    el.style.opacity = "";
  };

  let id = null, x0 = 0, t0 = 0, dx = 0;

  el.addEventListener("pointerdown", (e) => {
    if (el._gone) return;
    if (e.button !== undefined && e.button !== 0) return;
    // Let the controls inside the card have their own clicks.
    if (e.target.closest("button, a, input, select, textarea")) return;
    id = e.pointerId; x0 = e.clientX; t0 = Date.now(); dx = 0;
    el.classList.add("swiping");
    try { el.setPointerCapture(id); } catch { /* synthetic pointer */ }
  });

  el.addEventListener("pointermove", (e) => {
    if (id === null || e.pointerId !== id) return;
    dx = e.clientX - x0;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.15, 1 - Math.abs(dx) / (el.offsetWidth || 320)));
  });

  const release = (e) => {
    if (id === null || (e && e.pointerId !== id)) return;
    try { el.releasePointerCapture(id); } catch { /* already gone */ }
    id = null;
    const width = el.offsetWidth || 320;
    const far = Math.abs(dx) > Math.max(56, width * 0.3);
    const fast = Math.abs(dx) > 28 && Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.45;
    if (far || fast) fling(dx < 0 ? -1 : 1);
    else reset();
    dx = 0;
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", () => { id = null; dx = 0; reset(); });

  const x = el.querySelector("[data-nx]");
  if (x) x.onclick = (e) => { e.stopPropagation(); finish(); };
  el._dismiss = finish;
}

/* Ordinary notifications arrive in bursts - saving a form can raise three
   in a row - and three chimes on top of each other is a noise, not a
   notification. One sound per window, the rest are seen and not heard. */
let _lastNoticeSound = 0;
function noticeSound() {
  const now = Date.now();
  if (now - _lastNoticeSound < 900) return;
  _lastNoticeSound = now;
  const p = notifyPrefs();
  playSound(p.notice, p.volume, "notice");
}

/**
 * The ordinary notification: a short message in the corner.
 *
 * It now has a close button and can be swiped away, because it used to do
 * neither - it sat there for 3.2 seconds whatever you did, and on a phone
 * it covered the controls underneath for all of them. It also makes a
 * sound, which it did not before.
 *
 * `opts.silent` exists for the places where a sound would be absurd: the
 * sound settings panel itself, which raises a toast to confirm the sound
 * you just picked.
 */
function toast(msg, opts) {
  const wrap = $("toasts");
  if (!wrap) return;
  opts = opts || {};
  const host = overlayHost();
  if (wrap.parentElement !== host) host.appendChild(wrap);
  while (wrap.children.length >= 2) wrap.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="toast-msg"></span>` +
    `<button type="button" class="n-x" data-nx="toast"
             aria-label="${esc(I18N.t("notify.dismiss"))}">${icon("close")}</button>`;
  // textContent, not innerHTML: a toast often carries a server message.
  el.querySelector(".toast-msg").textContent = msg;
  wrap.appendChild(el);
  const timer = setTimeout(() => { if (el._dismiss) el._dismiss(); else el.remove(); }, 3200);
  bindDismiss(el, () => { clearTimeout(timer); el.remove(); });
  if (!opts.silent) noticeSound();
  return el;
}
function modalOpen() {
  const host = $("desk-modal");
  return Boolean(host && !host.hidden);
}
function askConfirm(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    closeAllDropdowns();
    let host = $("desk-modal");
    if (!host) {
      host = document.createElement("div");
      host.id = "desk-modal";
      host.className = "modal";
      host.hidden = true;
    }
    const where = overlayHost();
    if (host.parentElement !== where) where.appendChild(host);
    const danger = Boolean(opts.danger);
    host.innerHTML = `<div class="modal-card${danger ? " is-danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h3 id="modal-title">${esc(opts.title || I18N.t("common.ok"))}</h3>
      <p class="modal-body">${esc(opts.body || "")}</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="modal-no">${esc(opts.cancel || I18N.t("common.cancel"))}</button>
        <button type="button" class="btn${danger ? " danger" : ""}" id="modal-yes">${esc(opts.ok || I18N.t("common.ok"))}</button>
      </div>
    </div>`;
    host.hidden = false;
    host.classList.add("open");
    document.body.classList.add("modal-open");
    const finish = (val) => {
      if (host._done) return;
      host._done = true;
      host.hidden = true;
      host.classList.remove("open");
      document.body.classList.remove("modal-open");
      host.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      resolve(Boolean(val));
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    document.addEventListener("keydown", onKey, true);
    host.onclick = (e) => { if (e.target === host) finish(false); };
    const no = $("modal-no");
    const yes = $("modal-yes");
    if (no) no.onclick = () => finish(false);
    if (yes) yes.onclick = () => finish(true);
    host._done = false;
    setTimeout(() => yes && yes.focus(), 20);
  });
}
/**
 * Which build of the desk is actually running.
 *
 * Every asset is cache-busted with a ?v= token, so when a change does not
 * appear there are three candidates - the browser kept the old file, a
 * service worker served it, or the desk being looked at is an installed
 * copy that git never touched - and no way to tell them apart by looking.
 * Printing the token the running app.js was loaded with settles it in one
 * glance: if this does not match the token in index.html, the page is old.
 */
function buildTag() {
  const tag = document.querySelector('script[src*="js/app.js?v="]');
  if (!tag) return "dev";
  return String(tag.src).split("v=").pop() || "dev";
}

function fmt(n, d = 2) {
  if (n === null || n === undefined || n === "" || Number.isNaN(Number(n))) return "—";
  try {
    return Number(n).toLocaleString(I18N.locale(), { maximumFractionDigits: d });
  } catch {
    return Number(n).toLocaleString("en-GB", { maximumFractionDigits: d });
  }
}
function markLangPills() {
  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-lang") === I18N.lang);
  });
}
const THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';
let __themeMorphT = null;
/* Cover the desk while a theme, appearance or language change is applied.
 *
 * `apply` may be synchronous (a theme swap) or return a promise (a language
 * change has to fetch and re-render). The veil stays up until that work is
 * finished, so the trader never sees a half-translated desk, and the card
 * on top of it says which of the three is happening.
 *
 * Returns a promise that settles when the veil has lifted. */
function morphTheme(apply, opts) {
  const o = opts || {};
  const root = document.documentElement;
  let veil = null;
  try { veil = document.getElementById("theme-veil"); } catch {}
  let reduce = false;
  try { reduce = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch {}

  const label = () => {
    const title = document.getElementById("theme-veil-title");
    const sub = document.getElementById("theme-veil-sub");
    if (title) title.textContent = o.title || I18N.t("ui.switch_theme");
    if (sub) sub.textContent = o.sub || I18N.t("ui.switch_wait");
  };

  if (!veil || !root) return Promise.resolve(apply());

  if (__themeMorphT) { clearTimeout(__themeMorphT); __themeMorphT = null; }
  label();

  /* Reduced motion keeps the cover and the message - they are information,
     not decoration - and simply drops the fades. */
  if (reduce) {
    veil.style.transition = "none";
    veil.style.opacity = "1";
    veil.classList.add("is-busy");
    return Promise.resolve()
      .then(apply)
      .then(() => {
        veil.style.opacity = "0";
        veil.classList.remove("is-busy");
      });
  }

  let before = "#06070b";
  try { before = getComputedStyle(root).getPropertyValue("--bg").trim() || before; } catch {}

  return new Promise((resolve) => {
    // Phase 1 — a soft cover over the desk as it stands.
    veil.style.transition = "none";
    veil.style.opacity = "0";
    void veil.offsetWidth;
    veil.style.transition = "opacity .18s ease-out";
    veil.style.opacity = "1";
    veil.classList.add("is-busy");

    // Phase 2 — do the work while covered. The .theming class is added HERE
    // (not during the cover) so element transitions run under the fade
    // instead of being hidden behind it — that's what makes it read as a
    // morph rather than a cut.
    __themeMorphT = setTimeout(() => {
      root.classList.add("theming");
      Promise.resolve()
        .then(apply)
        .catch((e) => { try { console.error(e); } catch {} })
        .then(() => {
          // The labels may have just changed language; restate them before
          // the card is seen on the way out.
          label();
          veil.style.transition = "opacity .55s cubic-bezier(.33,0,.2,1)";
          veil.style.opacity = "0";
          veil.classList.remove("is-busy");
          __themeMorphT = setTimeout(() => {
            root.classList.remove("theming");
            veil.style.transition = "";
            veil.style.backgroundColor = "";
            veil.style.opacity = "";
            __themeMorphT = null;
            resolve();
          }, 580);
        });
    }, 210);
  });
}

function setTheme(mode) {
  const m = mode === "light" ? "light" : mode === "dark" ? "dark" : "auto";
  if (m === themeMode() && resolveTheme(m) === currentTheme()) { paintThemeBtn(); markThemePills(); return; }
  morphTheme(() => setThemeNow(m), { title: I18N.t("ui.switch_mode") });
}
function setGlass(on) {
  return morphTheme(() => setGlassNow(on), { title: I18N.t("ui.switch_mode") });
}
function currentTheme() {
  return (document.documentElement && document.documentElement.dataset.theme) === "light" ? "light" : "dark";
}
function themeMode() {
  try {
    const m = localStorage.getItem("aurion.theme");
    return (m === "light" || m === "dark" || m === "auto") ? m : "auto";
  } catch { return "auto"; }
}
function systemTheme() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  } catch {}
  return "dark";
}
function resolveTheme(mode) {
  const m = mode === "light" ? "light" : mode === "dark" ? "dark" : "auto";
  return m === "auto" ? systemTheme() : m;
}
function bindSystemTheme() {
  if (S._sysThemeBound) return;
  S._sysThemeBound = true;
  let mq = null;
  try { mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null; } catch { mq = null; }
  if (!mq) return;
  const onChange = () => { if (themeMode() === "auto") setTheme("auto"); };
  try {
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else if (typeof mq.addListener === "function") mq.addListener(onChange);
  } catch {}
}
function paintThemeBtn() {
  const b = $("btn-theme");
  if (!b) return;
  const cur = currentTheme();
  const next = cur === "light" ? "dark" : "light";
  b.innerHTML = next === "light" ? THEME_ICON_SUN : THEME_ICON_MOON;
  try { b.title = I18N.t(next === "light" ? "settings.theme_light" : "settings.theme_dark"); } catch {}
}
function markThemePills() {
  const cur = themeMode();
  document.querySelectorAll("[data-themebtn]").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-themebtn") === cur);
  });
}
function setThemeNow(mode) {
  const m = mode === "light" ? "light" : mode === "dark" ? "dark" : "auto";
  const next = resolveTheme(m);
  if (document.documentElement) document.documentElement.dataset.theme = next;
  try { localStorage.setItem("aurion.theme", m); } catch {}
  try { window.__aurionThemeRev = (window.__aurionThemeRev | 0) + 1; } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "light" ? "#e9edf4" : "#06070b");
  paintThemeBtn();
  markThemePills();
  if (S.chart && S.candles && S.candles.length && typeof S.chart.setBars === "function") {
    try { S.chart.setBars(S.candles); } catch {}
  }
}
/* ===========================================================================
   Appearance — skin, accent, wallpaper, rendering tier.

   Every one of these is presentation only: AurionSkin owns the storage and the
   attributes on <html>, and nothing here touches desk state. Rendered as part
   of the Personal settings tab.
   =========================================================================== */
/* ---------------------------------------------------------------------------
   The themes gallery.

   A theme is a material, not a colour, and a material cannot be described in
   a dropdown. Every theme is therefore shown as a miniature of itself - rail,
   panel, button, chip - drawn in its own palette and its own morphism,
   whatever theme happens to be active while you are looking at the page. The
   miniatures are pure CSS (css/themes.css, [data-art]) so they cost nothing
   and cannot drift from the real thing by way of a second colour table here.

   AurionTheme owns the state, the storage and the attributes on <html>. This
   function only draws, and the morph the light/dark switch already uses is
   reused for the swap so a theme change reads the same way. */
const THEME_TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';

const THEME_LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V7a4 4 0 118 0v3.5"/></svg>';

/* One question, asked in three places: the gallery, the accent row and the
   upgrade screen all have to agree about what this desk is allowed to wear. */
function themesUnlocked() {
  return licFeat("themes");
}

function themeLocked(id) {
  return typeof AurionTheme !== "undefined" && AurionTheme.locked(id);
}

function themeCardHtml(theme, current, custom) {
  const on = theme.id === current;
  const locked = themeLocked(theme.id);
  const name = I18N.t("themes." + theme.id + "_name");
  const desc = I18N.t("themes." + theme.id + "_desc");
  // The custom card is the only one that shows what the user built rather
  // than what shipped: its accent and corner radius come from their knobs.
  let style = "";
  if (theme.id === "custom" && typeof AurionSkin !== "undefined") {
    const acc = AurionSkin.ACCENTS[custom.accent] || AurionSkin.ACCENTS.aurora;
    const rad = Math.max(2, Math.round(custom.radius * 0.45));
    style = ` style="--p-accent:${acc[0]};--p-accent2:${acc[2]};--p-radius:${rad}px"`;
  }
  // A locked card is shown, not hidden: the point of a premium theme is that
  // it can be seen. It stays in the radiogroup and stays reachable from the
  // keyboard - it just answers with the upgrade screen instead of a swap.
  return `<button type="button" class="theme-card${on ? " on" : ""}${locked ? " is-locked" : ""}" data-theme-pick="${theme.id}"
      role="radio" aria-checked="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}"
      ${locked ? `data-locked="1" aria-describedby="set-theme-lock" title="${esc(I18N.t("themes.locked_hint"))}"` : ""}>
      <span class="tc-art" data-art="${theme.id}"${style} aria-hidden="true">
        <span class="tc-rail"><i></i><i></i><i></i></span>
        <span class="tc-body">
          <span class="tc-panel"><i></i><i></i></span>
          <span class="tc-row"><span class="tc-btn"></span><span class="tc-pill"></span><span class="tc-dot"></span></span>
        </span>
      </span>
      <span class="tc-meta">
        <span class="tc-name">${esc(name)}</span>
        <span class="tc-desc">${esc(desc)}</span>
      </span>
      <span class="tc-check">${THEME_TICK}</span>
      ${locked ? `<span class="tc-lock" aria-hidden="true">${THEME_LOCK}</span>
      <span class="sr-only">${esc(I18N.t("themes.locked_hint"))}</span>` : ""}
    </button>`;
}

/* One slider, with its value shown as it moves. Every knob is the same shape,
   so the panel is a table and not seven hand-written blocks. */
function themeKnobHtml(key, label, value, suffix) {
  const lim = AurionTheme.LIMITS[key];
  const shown = key === "motion" && Number(value) === 0
    ? I18N.t("themes.motion_off") : value + (suffix || "");
  return `<label class="knob">
      <span class="knob-head"><span>${esc(label)}</span><b id="knob-v-${key}">${esc(shown)}</b></span>
      <input type="range" data-knob="${key}" min="${lim[0]}" max="${lim[1]}" step="${lim[2]}"
             value="${value}" aria-label="${esc(label)}" />
    </label>`;
}

function themesGalleryHtml() {
  if (typeof AurionTheme === "undefined") return "";
  const current = AurionTheme.effective();
  const custom = AurionTheme.getCustom();
  const cards = AurionTheme.THEMES.map((t) => themeCardHtml(t, current, custom)).join("");
  const unlocked = themesUnlocked();

  return `
      <div class="card" style="margin-top:14px">
        <p class="sub" style="margin:0 0 10px">${I18N.t("themes.hint")}</p>
        ${unlocked ? "" : `<div class="theme-locked-note" id="set-theme-lock">
          <span class="tl-ico" aria-hidden="true">${THEME_LOCK}</span>
          <span class="tl-text"><b>${I18N.t("themes.locked_title")}</b>
            <span class="sub">${I18N.t("themes.locked_note")}</span></span>
          <button type="button" class="btn tiny" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</button>
        </div>`}
        <div class="theme-grid" id="set-theme-grid" role="radiogroup" aria-label="${esc(I18N.t("themes.title"))}">${cards}</div>
        <p class="sub" style="margin:12px 0 0">${I18N.t("themes.recommended")}</p>
      </div>

      ${themeBuilderHtml()}`;
}

/* The builder used to be the "custom" theme's private panel: it was hidden
   unless that one card was selected, and its sliders wrote to a slot only
   that theme read. So a trader who liked Neumorphism but wanted less shadow
   had nowhere to go, and picking a background meant abandoning the theme
   they had chosen. The panel is now simply "the theme you are using": it is
   always shown, it edits whichever theme is active, and the edits are kept
   per theme so nothing is lost by switching away and back. */
function themeBuilderHtml() {
  const current = AurionTheme.effective();
  const k = AurionTheme.knobs();
  const unlocked = themesUnlocked();
  const picture = AurionTheme.getBgImage();
  const colours = AurionTheme.colours(current);
  const fx = AurionTheme.fx(current);

  /* The backdrop gallery is gone along with the backdrops it offered.
     What is behind the desk is now one of three honest things: the flat
     themed colour, one of the twenty photographs, or the trader's own
     picture - and the last two each have their own section below. */

  /* The twenty photographs AURION ships, offered to every theme.
     Each tile is the picture itself at thumbnail size, in the cut that
     matches the mode in force - so what you see on the tile is what lands
     on the desk. */
  const wallNow = AurionTheme.wall(current);
  const lightNow = document.documentElement.dataset.theme === "light";
  /* The cut is part of the picture's NAME - "Aurora Dark" - rather than a
     badge stamped across the artwork. A label printed over the thumbnail
     covers the very thing the tile exists to show, and the gallery is a
     list of pictures to pick from, so each one should simply say what it
     is. */
  const wallTile = (value, label, style, extra) =>
    `<button type="button" class="bg-tile wall-tile${value === wallNow ? " on" : ""}"
             data-wallpick="${esc(value)}" role="radio" aria-checked="${value === wallNow}"
             tabindex="${value === wallNow ? 0 : -1}" title="${esc(label)}">
       <span class="bgt-art wall-art${extra || ""}"${style}></span>
       <span class="bgt-name">${esc(label)}</span>
     </button>`;

  /* The "theme's own" tile must show the picture the THEME ships with, not
     whatever is on the page: once a choice has been made it overrides
     --theme-bg globally, so a tile painted from that variable would show the
     chosen picture and offer to switch you to it. */
  const ownWall = AurionTheme.themeWall(current);
  const ownStyle = ownWall
    ? ` style="background-image:url(&quot;${esc(AurionTheme.wallUrl(ownWall, lightNow))}&quot;)"`
    : "";

  /* Every scene, in both cuts.
     It used to show ten tiles and silently pick the cut that matched the
     desk's mode, which meant the night version of a picture simply could
     not be asked for on a light desk. Both are offered now, each labelled,
     and the first tile of each pair still follows the mode for anyone who
     wants that. */
  const darkLabel = I18N.t("themes.wall_cut_dark");
  const lightLabel = I18N.t("themes.wall_cut_light");
  /* The first tile hands the theme back its own picture. Themes like AURION
     and Custom ship none, and the tile was then simply empty - which reads
     as a picture that failed to load rather than as a theme that has none.
     It says which it is. */
  const wallTiles = [
    wallTile("",
      ownWall ? I18N.t("themes.wall_theme") : I18N.t("themes.wall_theme_none"),
      ownStyle, ownWall ? "" : " is-none"),
    wallTile("none", I18N.t("themes.wall_none"), "", " is-none"),
  ].concat(AurionTheme.WALLPAPERS.flatMap((w) => {
    const name = I18N.t("themes.wall_" + w);
    return [
      wallTile(`${w}@night`, `${name} ${darkLabel}`,
        ` style="background-image:url(&quot;${esc(AurionTheme.wallUrl(w + "@night", false))}&quot;)"`),
      wallTile(`${w}@day`, `${name} ${lightLabel}`,
        ` style="background-image:url(&quot;${esc(AurionTheme.wallUrl(w + "@day", true))}&quot;)"`),
    ];
  })).join("");

  const fxOptions = Object.keys(AurionTheme.FX)
    .map((f) => `<option value="${f}"${f === fx ? " selected" : ""}>${esc(I18N.t("themes.fx_" + f))}</option>`)
    .join("");

  const fontOptions = Object.keys(AurionTheme.FONTS)
    .map((f) => `<option value="${f}"${f === (colours.font || "theme") ? " selected" : ""}>${
      esc(I18N.t("themes.f_" + f))}</option>`)
    .join("");

  /* A colour row shows the colour in force, which is not the same as the
     colour chosen: with nothing chosen the swatch has to show what the theme
     is already using, or the trader is editing blind. */
  const colourRow = (key, label, hint) => {
    const chosen = colours[key] || "";
    const shown = chosen || themeColourNow(key);
    /* A button, not <input type="color">. The native control opens an
       operating-system window over the desk, which hides the surface being
       recoloured - and its input event fires faster than the page can
       repaint. Both are fixed by owning the picker. */
    return `<div class="col-row" data-colrow="${key}">
        <span class="col-text"><b>${esc(label)}</b><small>${esc(hint)}</small></span>
        <button type="button" class="col-swatch" data-colour="${key}"
                style="background:${esc(shown)}"
                aria-label="${esc(label)}" aria-haspopup="dialog"></button>
        <button type="button" class="btn tiny ghost col-clear" data-colclear="${key}"${
          chosen ? "" : " hidden"}>${esc(I18N.t("themes.c_clear"))}</button>
      </div>`;
  };

  return `
      <div class="card tc-custom" id="set-theme-custom" style="margin-top:14px"${unlocked ? "" : " hidden"}>
        <h3 style="margin:0 0 4px">${I18N.t("themes.builder_title")}</h3>
        <p class="sub" style="margin:0 0 2px">${I18N.t("themes.builder_hint")}</p>
        <p class="sub" id="knob-editing" style="margin:0">${
          esc(I18N.t("themes.editing", { name: themeName(current) }))}${
          AurionTheme.edited(current) ? ` \u00B7 <b>${esc(I18N.t("themes.edited_tag"))}</b>` : ""}</p>

        <div class="knob-grid">
          ${themeKnobHtml("surface", I18N.t("themes.surface"), k.surface, "%")}
          ${themeKnobHtml("border", I18N.t("themes.border"), k.border, "%")}
          ${themeKnobHtml("blur", I18N.t("themes.blur"), k.blur, "px")}
          ${themeKnobHtml("radius", I18N.t("themes.radius"), k.radius, "px")}
          ${themeKnobHtml("shadow", I18N.t("themes.shadow"), k.shadow, "%")}
          ${themeKnobHtml("motion", I18N.t("themes.motion"), k.motion, "%")}
        </div>

        <div class="tb-sec">
          <h4>${esc(I18N.t("themes.colours_title"))}</h4>
          <p class="sub">${esc(I18N.t("themes.colours_hint"))}</p>
          <div class="col-rows">
            ${colourRow("page", I18N.t("themes.c_page"), I18N.t("themes.c_page_hint"))}
            ${colourRow("panel", I18N.t("themes.c_panel"), I18N.t("themes.c_panel_hint"))}
            ${colourRow("ink", I18N.t("themes.c_ink"), I18N.t("themes.c_ink_hint"))}
          </div>

          <h4 class="cndl-h">${esc(I18N.t("themes.candles_title"))}</h4>
          <p class="sub">${esc(I18N.t("themes.candles_hint"))}</p>
          <!-- The preview is drawn in CSS from the same two variables the
               chart canvas reads, which is what makes it live: the picker's
               drag writes the variable straight onto <html> and these bars
               restyle on the same frame. A canvas would have had to be told
               to repaint, and there is no chart on the settings page to
               repaint anyway. -->
          <div class="cndl-prev" id="cndl-prev" aria-hidden="true">
            ${[
              ["up", 34, 62, 10], ["up", 22, 48, 14], ["down", 30, 44, 12],
              ["up", 18, 70, 8], ["down", 40, 36, 16], ["down", 26, 52, 11],
              ["up", 20, 58, 13], ["up", 30, 46, 9],
            ].map(([dir, top, body, wick]) =>
              `<i class="cndl is-${dir}" style="--t:${top}%;--h:${body}%;--w:${wick}%"></i>`).join("")}
          </div>
          <div class="col-rows">
            ${colourRow("candle_up", I18N.t("themes.c_candle_up"), I18N.t("themes.c_candle_up_hint"))}
            ${colourRow("candle_down", I18N.t("themes.c_candle_down"), I18N.t("themes.c_candle_down_hint"))}
          </div>
          <p class="sub warn" id="col-warn" hidden>${esc(I18N.t("themes.contrast_warn"))}</p>
          <label class="field" style="margin-top:14px">
            <span>${esc(I18N.t("themes.font_title"))}</span>
            <select class="ctrl" id="knob-font">${fontOptions}</select>
          </label>
        </div>

        <div class="tb-sec">
          <h4>${esc(I18N.t("themes.gallery_title"))}</h4>
          <p class="sub">${esc(I18N.t("themes.gallery_hint"))}</p>
          <label class="field" style="margin-top:12px">
            <span>${esc(I18N.t("themes.fx_title"))}</span>
            <select class="ctrl" id="knob-fx">${fxOptions}</select>
          </label>
        </div>

        <div class="tb-sec">
          <h4>${esc(I18N.t("themes.wall_title"))}</h4>
          <p class="sub">${esc(I18N.t("themes.wall_hint"))}</p>
          <div class="bg-tiles wall-tiles" id="knob-walls" role="radiogroup"
               aria-label="${esc(I18N.t("themes.wall_pick"))}">${wallTiles}</div>
          <div class="wall-warn" id="wall-warn" role="status" hidden></div>
        </div>

        <div class="tb-sec bgpic" id="set-bgpic">
          <h4>${esc(I18N.t("themes.bg_image"))}</h4>
          <p class="sub">${esc(I18N.t("themes.bg_hint"))}</p>
          <div class="bgpic-row">
            <div class="bgpic-thumb"${picture ? ` style="background-image:url(&quot;${esc(picture)}&quot;)"` : ""}
                 id="bgpic-thumb" aria-hidden="true"></div>
            <div class="bgpic-acts">
              <input type="file" id="bgpic-file" accept="image/*" hidden />
              <button type="button" class="btn tiny" id="bgpic-pick">${esc(I18N.t("themes.bg_image_pick"))}</button>
              <button type="button" class="btn ghost tiny" id="bgpic-clear"${picture ? "" : " hidden"}>${
                esc(I18N.t("themes.bg_image_clear"))}</button>
            </div>
          </div>
          <div id="bgpic-frame"${picture && k.bg === "photo" ? "" : " hidden"}>
            <p class="sub bgpic-framehint">${esc(I18N.t("themes.bg_crop_hint"))}</p>
            <!-- Drag the picture inside this box to choose what the desk
                 shows. The box has the shape of the desk, so what is framed
                 here is what lands behind the panels. -->
            <div class="bgpic-stage" id="bgpic-stage" tabindex="0"
                 role="application" aria-label="${esc(I18N.t("themes.bg_crop"))}">
              <div class="bgpic-img" id="bgpic-img"></div>
            </div>
            <div class="bgpic-fit" role="radiogroup" aria-label="${esc(I18N.t("themes.bg_fit"))}">
              <button type="button" class="btn tiny" data-bgfit="cover">${esc(I18N.t("themes.bg_fit_cover"))}</button>
              <button type="button" class="btn tiny" data-bgfit="contain">${esc(I18N.t("themes.bg_fit_contain"))}</button>
              <span class="grow"></span>
              <button type="button" class="btn tiny ghost" id="bgpic-recentre">${esc(I18N.t("themes.bg_recentre"))}</button>
            </div>
            <label class="knob">
              <span class="knob-head"><span>${esc(I18N.t("themes.bg_zoom"))}</span><b id="bgpic-zoom-v">${
                AurionTheme.getBgCrop().zoom}%</b></span>
              <input type="range" id="bgpic-zoom" min="100" max="300" step="5"
                     value="${AurionTheme.getBgCrop().zoom}" aria-label="${esc(I18N.t("themes.bg_zoom"))}" />
            </label>
            <label class="knob" id="bgpic-dim-wrap">
              <span class="knob-head"><span>${esc(I18N.t("themes.bg_dim"))}</span><b id="bgpic-dim-v">${
                AurionTheme.getBgDim()}%</b></span>
              <input type="range" id="bgpic-dim" min="0" max="90" step="5" value="${AurionTheme.getBgDim()}"
                     aria-label="${esc(I18N.t("themes.bg_dim"))}" />
            </label>
          </div>
          <p class="sub" style="margin:8px 0 0">${esc(I18N.t("themes.bg_image_hint"))}</p>
        </div>

        <button type="button" class="btn ghost tiny" id="knob-reset" style="margin-top:16px">${
          esc(I18N.t("themes.reset_this", { name: themeName(current) }))}</button>
      </div>`;
}

/* What the page is actually painting for one of the three editable colours,
   so an untouched swatch opens on the real colour rather than on black. */
/* The CSS variable each colour row is editing. The candle pair are read
   back the same way as the rest, so a row with nothing chosen still shows
   the colour the active theme is really drawing with. */
const COLOUR_VARS = {
  page: "--bg",
  ink: "--ink",
  panel: "--s5",
  candle_up: "--candle-up",
  candle_down: "--candle-down",
};

function themeColourNow(key) {
  const prop = COLOUR_VARS[key] || "--s5";
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    if (!raw) return key === "ink" ? "#e8edf7" : "#0b0d14";
    // --s5 is a bare "r g b" triplet, the others are already hex.
    if (/^\d/.test(raw)) {
      const n = raw.split(/[\s,]+/).map(Number);
      return "#" + n.slice(0, 3).map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
    }
    return raw.startsWith("#") ? raw : (key === "ink" ? "#e8edf7" : "#0b0d14");
  } catch {
    return key === "ink" ? "#e8edf7" : "#0b0d14";
  }
}

/* A theme's display name, with the id as the last resort so a theme added to
   the table before its strings are translated still reads as something. */
function themeName(id) {
  const key = "themes." + id + "_name";
  const out = I18N.t(key);
  return out === key ? id : out;
}

/* Marking in place rather than re-rendering: rebuilding the settings tab on
   every click loses the pressed state and the scroll position, which is the
   exact bug the accent row was fixed for. */
function markThemeCards() {
  if (typeof AurionTheme === "undefined") return;
  const current = AurionTheme.effective();
  document.querySelectorAll("[data-theme-pick]").forEach((b) => {
    const on = b.dataset.themePick === current;
    const locked = themeLocked(b.dataset.themePick);
    b.classList.toggle("on", on);
    b.classList.toggle("is-locked", locked);
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  const panel = $("set-theme-custom");
  if (panel) {
    panel.hidden = !themesUnlocked();
    /* The builder follows the selection, because it edits whatever is
       active: switching theme has to reload the sliders or they would be
       showing - and writing - the previous theme's numbers. */
    renderSettingsKnobs();
  }
  paintCustomPreview();
}

/* The custom miniature follows its own knobs live, so the card in the grid is
   always a picture of the theme the user currently has. */
function paintCustomPreview() {
  if (typeof AurionTheme === "undefined" || typeof AurionSkin === "undefined") return;
  const art = document.querySelector('.tc-art[data-art="custom"]');
  if (!art) return;
  const custom = AurionTheme.getCustom();
  /* "custom" is not a key in ACCENTS - it is a stored hex - so reading the
     table alone made the preview fall back to aurora and show the wrong
     colour for the one accent the trader chose by hand. */
  const acc = AurionSkin.getAccent() === "custom"
    ? AurionSkin.accentTriplet("custom")
    : (AurionSkin.ACCENTS[custom.accent] || AurionSkin.ACCENTS.aurora);
  art.style.setProperty("--p-accent", acc[0]);
  art.style.setProperty("--p-accent2", acc[2]);
  art.style.setProperty("--p-radius", Math.max(2, Math.round(custom.radius * 0.45)) + "px");
}

function pickTheme(id, opts) {
  if (typeof AurionTheme === "undefined") return;
  if (themeLocked(id)) {
    // Silent when the keyboard merely passed over the card; an upsell that
    // fires on an arrow key is an ambush, not an offer.
    if (opts && opts.quiet) return;
    toast(I18N.t("themes.locked_toast"));
    show("upgrade");
    return;
  }
  if (AurionTheme.effective() === id) return;
  // The same veil the light/dark switch uses. A theme swap changes far more
  // than a theme switch does, so it needs the cover more, not less.
  morphTheme(() => {
    AurionTheme.set(id);
    markThemeCards();
    markAppearancePills();
    repaintChartsForTheme();
  });
}

function bindThemesGallery() {
  if (typeof AurionTheme === "undefined") return;

  const grid = $("set-theme-grid");
  if (grid) {
    grid.onclick = (e) => {
      const b = e.target.closest("[data-theme-pick]");
      if (!b) return;
      pickTheme(b.dataset.themePick);
    };
    // A radiogroup that cannot be driven from the keyboard is a list of
    // buttons wearing a costume. Arrows move and choose; Home and End jump.
    grid.onkeydown = (e) => {
      const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
      if (keys.indexOf(e.key) === -1) return;
      const cards = Array.prototype.slice.call(grid.querySelectorAll("[data-theme-pick]"));
      if (!cards.length) return;
      const rtl = document.documentElement.dir === "rtl";
      const at = Math.max(0, cards.indexOf(document.activeElement.closest("[data-theme-pick]")));
      let next = at;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = cards.length - 1;
      else {
        const fwd = e.key === "ArrowDown" || (rtl ? e.key === "ArrowLeft" : e.key === "ArrowRight");
        next = (at + (fwd ? 1 : -1) + cards.length) % cards.length;
      }
      e.preventDefault();
      cards[next].focus();
      pickTheme(cards[next].dataset.themePick, { quiet: true });
    };
  }

  const panel = $("set-theme-custom");
  if (panel) {
    // Sliders write straight through: there is no save button anywhere in
    // settings, and a theme you have to confirm is a theme you cannot feel.
    panel.oninput = (e) => {
      const slider = e.target.closest("[data-knob]");
      if (!slider) return;
      const key = slider.dataset.knob;
      const value = Number(slider.value);
      AurionTheme.edit({ [key]: value });
      const out = $("knob-v-" + key);
      if (out) {
        const suffix = key === "blur" || key === "radius" ? "px" : "%";
        out.textContent = key === "motion" && value === 0
          ? I18N.t("themes.motion_off") : value + suffix;
      }
      if (key === "radius") paintCustomPreview();
      markThemeEdited();
    };
    const walls = $("knob-walls");
    if (walls) walls.onclick = (e) => {
      const b = e.target.closest("[data-wallpick]");
      if (!b) return;
      AurionTheme.edit({ wall: b.dataset.wallpick });
      markWallTiles();
      verifyWallpaper();
      markThemeEdited();
    };

    const fx = $("knob-fx");
    if (fx) fx.onchange = () => { AurionTheme.edit({ fx: fx.value }); markThemeEdited(); };

    const font = $("knob-font");
    if (font) font.onchange = () => { AurionTheme.edit({ font: font.value }); markThemeEdited(); };

    /* Colours repaint live while the picker is open, which is the only way
       to judge a colour: a swatch in a dialog tells you nothing about how
       the same colour reads behind a table of numbers.

       What changed is the COST of that live repaint. The old handler ran
       the full path on every pointer move - republish the whole theme
       stylesheet, re-derive every token, then redraw every chart on the
       page. A drag fires that far faster than the screen refreshes, so the
       work queued up behind the finger and the picker felt stuck.

       Now a drag does the cheap half only: the changed variable is written
       straight onto <html>, which the browser resolves without any
       stylesheet being rebuilt. The expensive half - persisting the choice
       and redrawing the charts - waits for the drag to settle. */
    panel.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-colour]");
      if (!sw) return;
      const key = sw.dataset.colour;
      const colours = AurionTheme.colours(AurionTheme.effective());
      const before = colours[key] || themeColourNow(key);

      AurionPicker.open({
        value: before,
        anchor: sw,
        title: I18N.t("themes.c_" + key),
        swatches: Object.keys(AurionSkin.ACCENTS).map((id) => AurionSkin.ACCENTS[id].hex)
          .filter(Boolean).slice(0, 12),
        onInput(hex) {
          /* Preview only - nothing is stored and no sheet is rebuilt. */
          previewColour(key, hex);
          sw.style.background = hex;
        },
        onCommit(hex) {
          AurionTheme.edit({ [key]: hex });
          sw.style.background = hex;
          const row = sw.closest("[data-colrow]");
          const clear = row && row.querySelector("[data-colclear]");
          if (clear) clear.hidden = false;
          warnOnContrast();
          markThemeEdited();
          repaintChartsForTheme();
        },
        onClose() {
          /* Whatever is stored is the truth; drop any preview on top. */
          clearColourPreview();
          AurionTheme.apply();
          repaintChartsForTheme();
        },
      });
    });

    panel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-colclear]");
      if (!b) return;
      AurionTheme.edit({ [b.dataset.colclear]: "" });
      renderSettingsKnobs();
      repaintChartsForTheme();
    });
    const reset = $("knob-reset");
    if (reset) reset.onclick = () => {
      const name = themeName(AurionTheme.effective());
      AurionTheme.reset();
      renderSettingsKnobs();
      toast(I18N.t("themes.reset_this_done", { name }));
    };
  }

  bindBackgroundPicture();
  bindCropStage();
}


/* ---------------------------------------------------------------------------
   Live colour preview.

   The point of previewing inside the app is to judge a colour against real
   content, so it has to be instant. Writing the derived variables as an
   INLINE style on <html> is what makes it instant: inline declarations beat
   every stylesheet without anything being rebuilt or re-parsed, so a drag
   costs one style recalculation instead of a full theme republish.

   Nothing here is stored. Whatever the trader settles on is written properly
   on commit, and clearColourPreview() takes the scaffolding back down.
   --------------------------------------------------------------------------- */
let previewVars = [];

function previewColour(key, hex) {
  /* Built on what is actually published, not on the edits alone. Every
     theme now ships a candle pair, so a preview that started from the
     edit list would have dropped the other half of the pair out of the
     declaration block for the duration of the drag. */
  const base = typeof AurionTheme.published === "function"
    ? AurionTheme.published(AurionTheme.effective())
    : AurionTheme.colours(AurionTheme.effective());
  const live = Object.assign({}, base, { [key]: hex });
  const css = AurionTheme.colourCss(live);
  clearColourPreview();
  const root = document.documentElement;
  css.split(";").forEach((decl) => {
    const i = decl.indexOf(":");
    if (i < 1) return;
    const name = decl.slice(0, i).trim();
    if (!name.startsWith("--")) return;
    root.style.setProperty(name, decl.slice(i + 1).trim());
    previewVars.push(name);
  });
}

function clearColourPreview() {
  const root = document.documentElement;
  previewVars.forEach((n) => root.style.removeProperty(n));
  previewVars = [];
}

/* ---------------------------------------------------------------------------
   Framing the trader's own picture.

   Dragging the picture is the whole interaction: the stage has the desk's
   own proportions, so what sits inside the frame is what ends up behind the
   panels. Zoom is a slider because a pinch gesture cannot be assumed on a
   desk machine, and the keyboard arrows do the same job for anyone not
   using a pointer.
   --------------------------------------------------------------------------- */
function syncCropStage() {
  const img = document.getElementById("bgpic-img");
  if (!img) return;
  const pic = AurionTheme.getBgImage();
  const c = AurionTheme.getBgCrop();
  img.style.backgroundImage = pic ? `url("${pic}")` : "none";
  img.style.backgroundSize = c.fit;
  img.style.backgroundPosition = `${c.x}% ${c.y}%`;
  img.style.transform = `scale(${c.zoom / 100})`;
  img.style.transformOrigin = `${c.x}% ${c.y}%`;
  const zoom = document.getElementById("bgpic-zoom");
  const zoomV = document.getElementById("bgpic-zoom-v");
  if (zoom) zoom.value = String(c.zoom);
  if (zoomV) zoomV.textContent = c.zoom + "%";
  document.querySelectorAll("[data-bgfit]").forEach((b) => {
    b.classList.toggle("on", b.dataset.bgfit === c.fit);
  });
}

function bindCropStage() {
  const stage = document.getElementById("bgpic-stage");
  if (!stage || stage.dataset.bound) return;
  stage.dataset.bound = "1";

  /* Dragging moves the focus point the OPPOSITE way to the pointer, because
     the trader is dragging the picture, not the window onto it - pulling the
     photo left has to reveal what is on its right. */
  let from = null;
  stage.addEventListener("pointerdown", (e) => {
    const c = AurionTheme.getBgCrop();
    from = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!from) return;
    const r = stage.getBoundingClientRect();
    const nx = from.cx - ((e.clientX - from.x) / Math.max(1, r.width)) * 100;
    const ny = from.cy - ((e.clientY - from.y) / Math.max(1, r.height)) * 100;
    AurionTheme.setBgCrop({ x: nx, y: ny }, { silent: true });
    syncCropStage();
  });
  const end = () => {
    if (!from) return;
    from = null;
    stage.classList.remove("dragging");
    AurionTheme.setBgCrop({});     /* one real apply when the drag settles */
    markThemeEdited();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);

  stage.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 2;
    const c = AurionTheme.getBgCrop();
    const map = {
      ArrowLeft: { x: c.x - step }, ArrowRight: { x: c.x + step },
      ArrowUp: { y: c.y - step }, ArrowDown: { y: c.y + step },
    };
    if (!map[e.key]) return;
    e.preventDefault();
    AurionTheme.setBgCrop(map[e.key]);
    syncCropStage();
    markThemeEdited();
  });

  const zoom = document.getElementById("bgpic-zoom");
  if (zoom) {
    zoom.addEventListener("input", () => {
      AurionTheme.setBgCrop({ zoom: Number(zoom.value) }, { silent: true });
      syncCropStage();
    });
    zoom.addEventListener("change", () => { AurionTheme.setBgCrop({}); markThemeEdited(); });
  }
  document.querySelectorAll("[data-bgfit]").forEach((b) => {
    b.addEventListener("click", () => {
      AurionTheme.setBgCrop({ fit: b.dataset.bgfit });
      syncCropStage();
      markThemeEdited();
    });
  });
  const re = document.getElementById("bgpic-recentre");
  if (re) re.addEventListener("click", () => {
    AurionTheme.resetBgCrop();
    syncCropStage();
    markThemeEdited();
  });
}

/* The trader's own background picture.

   It never leaves the machine: the file is read in the page, scaled down and
   kept in this browser's storage. Scaling is not cosmetic - a modern phone
   photo is several megabytes, and storage rejects that outright, so an
   unscaled picture would simply fail to stick. 1920px on the long edge is
   more than a desk background ever shows. */
const BG_MAX_EDGE = 1920;

function bindBackgroundPicture() {
  const file = $("bgpic-file");
  const pick = $("bgpic-pick");
  const clear = $("bgpic-clear");
  const dim = $("bgpic-dim");
  if (pick && file) pick.onclick = () => file.click();

  if (file) file.onchange = () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    shrinkImage(f, BG_MAX_EDGE).then((dataUrl) => {
      AurionTheme.setBgImage(dataUrl);
      // Choosing a picture means wanting to see it; selecting the backdrop
      // by hand afterwards would be a step with only one sensible answer.
      AurionTheme.edit({ bg: "photo" });
      renderSettingsKnobs();
      toast(I18N.t("themes.bg_image_set"));
    }).catch(() => toast(I18N.t("themes.bg_image_bad")));
  };

  if (clear) clear.onclick = () => {
    AurionTheme.setBgImage("");
    if (AurionTheme.knobs().bg === "photo") AurionTheme.edit({ bg: "flat" });
    renderSettingsKnobs();
  };

  if (dim) dim.oninput = () => {
    AurionTheme.setBgDim(Number(dim.value));
    const out = $("bgpic-dim-v");
    if (out) out.textContent = dim.value + "%";
  };
}

/** Read a picture file, scale its long edge down to max, return a data URL. */
function shrinkImage(fileObj, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("unreadable"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("not an image"));
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          // JPEG, not PNG: a photograph as PNG is several times larger and
          // storage is the binding limit here, not fidelity.
          resolve(cv.toDataURL("image/jpeg", 0.82));
        } catch (err) { reject(err); }
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(fileObj);
  });
}

/* Warn, do not forbid.

   A trader is allowed to make a choice we would not, but silently shipping
   an unreadable desk is a different thing: this says so and leaves the
   colour alone. The threshold is on perceived brightness rather than on a
   full contrast ratio, because the warning is about "can you read this at a
   glance", and the two colours being compared are a large text colour and
   the surface right behind it. */
function warnOnContrast() {
  const warn = $("col-warn");
  if (!warn || typeof AurionTheme === "undefined") return;
  const c = AurionTheme.colours(AurionTheme.effective());
  const hex = (v) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v || ""));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const luma = (x) => (0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]) / 255;
  const ink = hex(c.ink) || hex(themeColourNow("ink"));
  const panel = hex(c.panel) || hex(themeColourNow("panel"));
  warn.hidden = !(ink && panel && Math.abs(luma(ink) - luma(panel)) < 0.28);
}

/** Keep the "edited" tag beside the builder heading honest. */
function markThemeEdited() {
  const line = $("knob-editing");
  if (!line || typeof AurionTheme === "undefined") return;
  const current = AurionTheme.effective();
  line.innerHTML = esc(I18N.t("themes.editing", { name: themeName(current) }))
    + (AurionTheme.edited(current) ? ` \u00B7 <b>${esc(I18N.t("themes.edited_tag"))}</b>` : "");
}

/* After a reset the sliders are stale. Only their values are rewritten - the
   panel itself stays, so focus and scroll stay with it. */
/* Mark the selected wallpaper, and keep every tile showing the cut that
   matches the mode in force - a light desk must not advertise the night
   version of a picture it is about to load in daylight. */
/* Does the wallpaper the desk is currently asking for actually load?

   Every value in this chain can be correct while nothing appears on screen -
   the URL resolves, the variable is published, the rule wins the cascade,
   and the browser still gets a 404 or an HTML error page where it expected
   a JPEG. That failure is invisible by design: an unloadable
   background-image just paints nothing.

   So it is checked, and said out loud with the path that was tried. A
   trader who sees "this picture could not be loaded" can report something
   useful; a trader looking at an unchanged desk cannot. */
function verifyWallpaper() {
  const box = document.getElementById("wall-warn");
  if (!box || !window.AurionTheme) return;
  const current = AurionTheme.effective();
  const choice = AurionTheme.wall(current);
  const hide = () => { box.hidden = true; box.innerHTML = ""; };

  /* "" hands the theme its own picture and "none" asks for bare colour;
     neither is a URL this check can meaningfully test. */
  if (!choice || choice === "none") return hide();

  const light = document.documentElement.dataset.theme === "light";
  const rel = AurionTheme.wallUrl(choice, light);
  if (!rel) return hide();
  const url = AurionTheme.assetUrl ? AurionTheme.assetUrl(rel) : rel;

  const probe = new Image();
  probe.onload = hide;
  probe.onerror = () => {
    box.hidden = false;
    box.innerHTML =
      `<span>${esc(I18N.t("themes.wall_missing"))}</span>` +
      `<code>${esc(url)}</code>`;
  };
  probe.src = url;
}

function markWallTiles() {
  const walls = $("knob-walls");
  if (!walls || !window.AurionTheme) return;
  const current = AurionTheme.effective();
  const chosen = AurionTheme.wall(current);
  const light = document.documentElement.dataset.theme === "light";
  walls.querySelectorAll("[data-wallpick]").forEach((b) => {
    const value = b.dataset.wallpick;
    const on = value === chosen;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
    // "" is the theme's own picture, which is named after the theme itself.
    const name = value === "" ? AurionTheme.themeWall(current) : value;
    const url = AurionTheme.wallUrl(name, light);
    const art = b.querySelector(".wall-art");
    if (art && url) art.style.backgroundImage = `url("${url}")`;
    else if (art && value === "") art.style.backgroundImage = "";
  });
}

function renderSettingsKnobs() {
  if (typeof AurionTheme === "undefined") return;
  const k = AurionTheme.knobs();
  document.querySelectorAll("[data-knob]").forEach((slider) => {
    const key = slider.dataset.knob;
    if (k[key] === undefined) return;
    slider.value = k[key];
    const out = $("knob-v-" + key);
    if (out) {
      const suffix = key === "blur" || key === "radius" ? "px" : "%";
      out.textContent = key === "motion" && Number(k[key]) === 0
        ? I18N.t("themes.motion_off") : k[key] + suffix;
    }
  });

  markWallTiles();
  verifyWallpaper();

  const picture = AurionTheme.getBgImage();

  /* The trader's picture now has its own framing panel instead of a tile. */
  const frame = $("bgpic-frame");
  if (frame) {
    const onPhoto = Boolean(picture) && k.bg === "photo";
    frame.hidden = !onPhoto;
    if (onPhoto) syncCropStage();
  }
  const clearBtn = $("bgpic-clear");
  if (clearBtn) clearBtn.hidden = !picture;

  const colours = AurionTheme.colours(AurionTheme.effective());
  document.querySelectorAll("[data-colour]").forEach((sw) => {
    const key = sw.dataset.colour;
    sw.style.background = colours[key] || themeColourNow(key);
    const row = sw.closest("[data-colrow]");
    const clear = row && row.querySelector("[data-colclear]");
    if (clear) clear.hidden = !colours[key];
  });
  const font = $("knob-font");
  if (font) font.value = colours.font || "theme";
  const fx = $("knob-fx");
  if (fx) fx.value = AurionTheme.fx(AurionTheme.effective());
  warnOnContrast();

  const thumb = $("bgpic-thumb");
  if (thumb) thumb.style.backgroundImage = picture ? `url("${picture}")` : "";
  const clear = $("bgpic-clear");
  if (clear) clear.hidden = !picture;
  const dim = $("bgpic-dim");
  if (dim) dim.value = AurionTheme.getBgDim();
  const dimOut = $("bgpic-dim-v");
  if (dimOut) dimOut.textContent = AurionTheme.getBgDim() + "%";

  const reset = $("knob-reset");
  if (reset) reset.textContent = I18N.t("themes.reset_this", { name: themeName(AurionTheme.effective()) });
  markThemeEdited();
  paintCustomPreview();
}

function appearanceCardsHtml() {
  if (typeof AurionSkin === "undefined") return "";
  const perf = AurionSkin.getPerfMode();
  const accent = AurionSkin.getAccent();
  // Freemium wears the accent its theme was designed with. The row still shows
  // every colour - a locked door you cannot see is just a wall.
  const accentOpen = themesUnlocked();
  /* The trader's own accent sits at the end of the shipped ones. It is a
     flat colour: the gradient that briefly lived here has been removed by
     request. */
  const customAcc = AurionSkin.customAccent();
  const customSwatch = `
    <button type="button" class="accent-dot accent-custom${accent === "custom" ? " on" : ""}"
            data-accent-custom="1" aria-haspopup="dialog"
            aria-label="${esc(I18N.t("themes.accent_custom"))}"
            title="${esc(I18N.t("themes.accent_custom"))}"
            style="background:${esc(customAcc || "#3ee0c4")}"></button>`;

  const swatches = Object.keys(AurionSkin.ACCENTS).map((id) => {
    const c = AurionSkin.ACCENTS[id];
    return `<button type="button" class="accent-dot ${id === accent ? "on" : ""}" data-accent="${id}"
              title="${id}" aria-label="${id}" aria-pressed="${id === accent}"
              ${accentOpen ? "" : 'data-locked="1"'}
              style="background:linear-gradient(135deg, ${c[0]}, ${c[2]})"></button>`;
  }).join("") + (accentOpen ? customSwatch : "");

  return `
      <h3 class="set-h">${I18N.t("themes.title")}</h3>
      ${themesGalleryHtml()}

      <div class="card" style="margin-top:14px">
        <p class="sub" style="margin:0 0 6px">${I18N.t("settings.accent")}
          ${accentOpen ? "" : `<span class="pill no">${I18N.t("themes.premium_tag")}</span>`}</p>
        <div class="accent-row${accentOpen ? "" : " is-locked"}" id="set-accents">${swatches}</div>
        <p class="sub" style="margin:8px 0 0">${accentOpen ? I18N.t("settings.accent_hint")
          : `${I18N.t("settings.accent_locked")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a>`}</p>
      </div>

      <div class="card" style="margin-top:14px">
        <p class="sub" style="margin:0 0 6px">${I18N.t("settings.perf")}</p>
        <div class="lang-pills" id="set-perf">
          <button type="button" data-perfbtn="auto" class="${perf === "auto" ? "on" : ""}">${I18N.t("settings.perf_auto")}</button>
          <button type="button" data-perfbtn="rich" class="${perf === "rich" ? "on" : ""}">${I18N.t("settings.perf_rich")}</button>
          <button type="button" data-perfbtn="fast" class="${perf === "fast" ? "on" : ""}">${I18N.t("settings.perf_fast")}</button>
        </div>
        <p class="sub" style="margin:8px 0 0">${I18N.t("settings.perf_hint")}
          <b id="set-perf-now">${perfNowLabel()}</b></p>
      </div>`;
}

function perfNowLabel() {
  if (typeof AurionSkin === "undefined") return "";
  return AurionSkin.effectivePerf() === "fast"
    ? I18N.t("settings.perf_now_fast") : I18N.t("settings.perf_now_rich");
}

function markAppearancePills() {
  if (typeof AurionSkin === "undefined") return;
  const perf = AurionSkin.getPerfMode(), accent = AurionSkin.getAccent();
  document.querySelectorAll("[data-accent]").forEach((b) => {
    const on = b.dataset.accent === accent;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  /* The trader's own swatch is marked by data-accent-custom, not
     data-accent, so the loop above never touched it: picking a shipped
     accent left the custom dot still showing as selected until the whole
     settings page happened to be re-rendered, and two accents appeared
     to be in force at once. */
  document.querySelectorAll("[data-accent-custom]").forEach((b) => {
    const on = accent === "custom";
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const hex = AurionSkin.customAccent();
    if (hex) b.style.background = hex;
  });
  document.querySelectorAll("[data-perfbtn]").forEach((b) => b.classList.toggle("on", b.dataset.perfbtn === perf));
  const now = $("set-perf-now");
  if (now) now.textContent = perfNowLabel();
}

/* Put the trader's own colour in force and make every control that shows
   the accent agree with it. One place, because this now runs from three
   callers - the click that selects custom, every frame of the drag, and
   the commit - and they were drifting apart. */
function applyCustomAccent(hex, dot) {
  if (typeof AurionSkin === "undefined") return;
  const applied = AurionSkin.setCustomAccent(hex);
  if (!applied) return;
  if (dot) dot.style.background = applied;
  /* The accent belongs to the theme being edited, exactly as a shipped
     one does, or it is lost the next time that theme is applied. */
  if (typeof AurionTheme !== "undefined") {
    AurionTheme.edit({ accent: "custom" }, { silent: true });
  }
  markAppearancePills();
  paintCustomPreview();
}

function bindAppearance() {
  if (typeof AurionSkin === "undefined") return;

  const accents = $("set-accents");
  if (accents) accents.onclick = (e) => {
    const custom = e.target.closest("[data-accent-custom]");
    if (custom) {
      /* Pressing this dot selects the trader's own accent. It used to do
         nothing but open the picker, so coming back from a shipped accent
         took a click to open it, a drag to move off the colour that was
         already stored, and a drag back - three gestures to re-apply a
         colour the desk had remembered all along. Selecting it is now the
         click; the picker that follows is for changing it. */
      const startHex = AurionSkin.customAccent() || "#3ee0c4";
      applyCustomAccent(startHex, custom);
      AurionPicker.open({
        value: startHex,
        anchor: custom,
        title: I18N.t("themes.accent_custom"),
        swatches: Object.keys(AurionSkin.ACCENTS).map((id) => AurionSkin.ACCENTS[id][0]).slice(0, 12),
        onInput(hex) {
          /* The accent is a handful of variables, so the honest apply is
             cheap enough to run on every frame - and the dot has to move
             with the drag, not wait for it to end. */
          applyCustomAccent(hex, custom);
        },
        onCommit(hex) {
          applyCustomAccent(hex, custom);
          renderSettingsKnobs();
          repaintChartsForTheme();
        },
      });
      return;
    }

    const b = e.target.closest("[data-accent]");
    if (!b) return;
    /* A shipped accent and a custom one cannot both be in force. */
    AurionSkin.setCustomAccent("");
    if (b.dataset.locked) { toast(I18N.t("themes.locked_toast")); show("upgrade"); return; }
    AurionSkin.setAccent(b.dataset.accent);
    // Picking an accent is part of building the theme, whichever theme it
    // is, so it is remembered with the rest of that theme's knobs rather
    // than being reset the next time the theme is applied.
    if (typeof AurionTheme !== "undefined") {
      AurionTheme.edit({ accent: b.dataset.accent }, { silent: true });
    }
    markAppearancePills();
    paintCustomPreview();
    // The chart reads its colours once when it paints, so it has to be asked.
    repaintChartsForTheme();
  };

  bindThemesGallery();

  const perf = $("set-perf");
  if (perf) perf.onclick = (e) => {
    const b = e.target.closest("[data-perfbtn]"); if (!b) return;
    AurionSkin.setPerfMode(b.dataset.perfbtn);
    // Re-marking in place, not re-rendering: a full settings re-render was
    // rebuilding the tab and losing the pressed state until you navigated away.
    markAppearancePills();
  };
}

/* The chart canvases read their colours once, so an accent or skin change has
   to ask them to redraw - the same thing a theme switch already does. */
function repaintChartsForTheme() {
  if (S.chart && S.candles && S.candles.length && typeof S.chart.setBars === "function") {
    try { S.chart.setBars(S.candles); } catch {}
  }
}

/* Closes the pinned calendar day card, wherever we are. Safe to call when the
   calendar has never been opened. */
/* ===========================================================================
   Signal notifications
   ===========================================================================
   A signal is the one event a trader must not miss, and until now it only
   changed a number on a panel they might not be looking at. It now announces
   itself three ways, in order of how much attention it can command:

     1. in the desk, as a card that says what to do and can open the chart;
     2. on the Windows desktop, but only when the window cannot be seen -
        a toast for something already on screen is just noise;
     3. by raising the window when that toast is clicked.

   The host (installer/window) provides the second and third; if the desk is
   open in a plain browser instead, the first still works.
   =========================================================================== */

function signalLots(sig) {
  const v = Number(sig.volume || sig.lots || sig.lot || 0);
  return v > 0 ? v : null;
}

function signalPrice(sig, key) {
  const v = Number(sig[key] || 0);
  return v > 0 ? v : null;
}

/** The one-line summary used by the card, the toast and the log. */
function signalHeadline(sig) {
  const side = String(sig.action || sig.side || "").toLowerCase();
  const verb = side === "sell" ? I18N.t("signal.sell") : I18N.t("signal.buy");
  return `${verb} ${sig.symbol || ""}`.trim();
}

function signalDetail(sig) {
  const bits = [];
  const lots = signalLots(sig);
  // The entry comes first. It is the only number that is useless a minute
  // later, so burying it behind the lot size was the wrong order.
  const entry = signalPrice(sig, "entry") || signalPrice(sig, "price");
  const sl = signalPrice(sig, "sl");
  const tp = signalPrice(sig, "tp");
  if (entry) bits.push(`${I18N.t("signal.entry")} ${fmt(entry, 5)}`);
  if (sl) bits.push(`${I18N.t("signal.sl")} ${fmt(sl, 5)}`);
  if (tp) bits.push(`${I18N.t("signal.tp")} ${fmt(tp, 5)}`);
  if (lots) bits.push(`${I18N.t("signal.lots")} ${fmt(lots, 2)}`);
  if (sig.confidence) bits.push(`${I18N.t("signal.confidence")} ${Math.round(Number(sig.confidence) * 100)}%`);
  return bits.join(" · ");
}

/** "from king" — which strategy is responsible for this mark. */
function signalSource(sig) {
  const name = String(sig.strategy || (sig.extra && sig.extra.strategy) || "");
  return name ? `${I18N.t("signal.from_strategy")} ${strategyLabel(name)}` : "";
}

function announceSignal(sig) {
  if (!sig || typeof sig !== "object") return;
  const action = String(sig.action || sig.side || "").toLowerCase();
  if (!["buy", "sell", "market"].includes(action)) return;

  // The same signal can arrive twice - the bus republishes on reconnect - and
  // a duplicate toast for a trade you already saw is worse than none.
  const key = [sig.ts, sig.symbol, action, sig.volume, sig.sl, sig.tp].join("|");
  if (S._lastSignalKey === key) return;
  S._lastSignalKey = key;

  pushSignalCard(sig);
  if (documentHidden()) notifyHost(sig);
}

function documentHidden() {
  try {
    // The host tells us when its window is minimised; the Page Visibility API
    // does not fire for a minimised WebView2, only for a hidden tab.
    if (window.__aurionWindowHidden) return true;
    return document.visibilityState === "hidden";
  } catch (e) {
    return false;
  }
}

/** Hand the signal to the desktop host, which owns the Windows toast. */
function notifyHost(sig) {
  try {
    const bridge = window.chrome && window.chrome.webview;
    if (!bridge || typeof bridge.postMessage !== "function") return;
    bridge.postMessage(JSON.stringify({
      type: "signal",
      title: signalHeadline(sig),
      body: signalDetail(sig),
      symbol: sig.symbol || "",
      timeframe: sig.timeframe || S.timeframe || "",
      // Echoed back on click so the desk can pin the exact mark, not just
      // the symbol - the Windows toast is a round trip through the host.
      time: sig.time || sig.ts || "",
      side: String(sig.action || sig.side || "").toLowerCase(),
    }));
  } catch (e) {
    /* no host: the in-desk card is the whole notification */
  }
}

/* ---------------------------------------------------------------- sounds
 *
 * Entries and exits are the two moments a trader wants to hear about
 * while they are looking at something else. Everything else - a status
 * change, a reconnect, a saved setting - is silent and stays inside the
 * desk, because a robot that chimes at every heartbeat gets muted, and a
 * muted robot is one that cannot tell you it has just opened a trade.
 *
 * The tones are synthesized rather than shipped as audio files: no megabytes
 * in the installer, nothing to go missing, and a sound that works the same
 * whether the desk is served from the engine, from a folder or offline.
 */
const SOUNDS = {
  none:   null,
  chime:  { steps: [[880, 0.00, 0.12], [1320, 0.10, 0.18]], wave: "sine" },
  ding:   { steps: [[1568, 0.00, 0.22]], wave: "sine" },
  rise:   { steps: [[523, 0.00, 0.10], [659, 0.08, 0.10], [784, 0.16, 0.20]], wave: "triangle" },
  fall:   { steps: [[659, 0.00, 0.12], [523, 0.10, 0.12], [392, 0.20, 0.26]], wave: "triangle" },
  alert:  { steps: [[440, 0.00, 0.10], [440, 0.16, 0.10]], wave: "square" },
  soft:   { steps: [[330, 0.00, 0.26]], wave: "sine" },
};
const SOUND_NAMES = Object.keys(SOUNDS);

/* `notice` is the ordinary-notification slot: the toasts the desk raises for
   a saved setting, a reconnect, a refused action. It used to be silent by
   design, on the reasoning that a robot which chimes at every heartbeat
   gets muted. The user asked for it to be audible, so it is - but quietly
   (a single soft tone), rate-limited below so a burst of toasts cannot
   machine-gun, and settable to Silent like every other slot. */
const NOTIFY_DEFAULTS = { entry: "chime", profit: "rise", loss: "fall", notice: "soft", volume: 0.6, windows: true };

/* Every slot the trader can assign a sound to, and the built-in tone each
   one falls back to if a custom file is chosen and later goes missing. */
const SOUND_SLOTS = ["entry", "profit", "loss", "notice"];

/* A notification sound is a second or two. The cap is generous enough for
   any real chime and small enough that a trader cannot wire a whole track
   into the entry slot and then wonder why the desk is slow to start. */
const SOUND_MAX_BYTES = 2 * 1024 * 1024;

function notifyPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem("aurion.notify") || "{}");
    const saved = raw && typeof raw === "object" ? raw : {};
    const out = { ...NOTIFY_DEFAULTS, ...saved };
    /* A sound shipped with the build is what that event should sound like,
       so it is the default for its slot. An explicit choice by the trader
       always wins - this only fills in slots they have never touched. */
    for (const key of SOUND_SLOTS) {
      if (saved[key] === undefined && SOUND_FILES.has(key)) out[key] = "file";
    }
    for (const key of SOUND_SLOTS) {
      /* "custom" is a legal value only while a file is actually stored for
         the slot. If the file has gone - a cleared profile, a different
         machine - the slot falls back to its built-in tone rather than
         going silently dead, because a notification that stops making a
         noise is indistinguishable from one that stopped arriving. */
      if (out[key] === "file") {
        if (SOUND_FILES.has(key)) continue;
        out[key] = NOTIFY_DEFAULTS[key];
      }
      if (!SOUND_NAMES.includes(out[key])) out[key] = NOTIFY_DEFAULTS[key];
    }
    out.volume = Math.min(1, Math.max(0, Number(out.volume) || 0));
    out.windows = out.windows !== false;
    return out;
  } catch (e) {
    return { ...NOTIFY_DEFAULTS };
  }
}

function saveNotifyPrefs(patch) {
  const next = { ...notifyPrefs(), ...(patch || {}) };
  localStorage.setItem("aurion.notify", JSON.stringify(next));
  return next;
}

/* ------------------------------------------------- sound files in the build
 *
 * The built-in tones are synthesized, which is why they cost nothing and
 * cannot go missing. A product sound is a file, and it is shipped with the
 * build rather than uploaded from the desk: the person choosing the sounds
 * is the one assembling the installer, the choice should be the same on
 * every machine the product is installed on, and a per-machine upload
 * would mean every customer hears something different.
 *
 * Drop an Ogg Vorbis file into apps/web/assets/sounds/, named after the
 * event it belongs to:
 *
 *     entry.ogg     a position was opened
 *     profit.ogg    a position closed in profit
 *     loss.ogg      a position closed at a loss
 *     notice.ogg    an ordinary notification
 *
 * Nothing else is needed - no manifest to edit and no rebuild. A slot
 * whose file is present uses it by default; a slot whose file is absent
 * keeps its built-in tone, and either way the trader can still override
 * the choice in Settings. Files are fetched once at boot and decoded on
 * first use, so a burst of notifications does not re-read them.
 */
const SOUND_DIR = "assets/sounds/";
/** slot -> { url, bytes, buffer } for whatever shipped with this build. */
const SOUND_FILES = new Map();

/** The shared AudioContext, created on demand. */
function audioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  // One context for the life of the page. Browsers cap how many a page may
  // create, and a desk that runs for a week would hit it.
  if (!S._audio) S._audio = new Ctx();
  // Autoplay policy parks the context until the user has interacted;
  // resuming is a no-op once it is already running.
  if (S._audio.state === "suspended") S._audio.resume().catch(() => {});
  return S._audio;
}

function soundFileUrl(slot) {
  const rel = SOUND_DIR + slot + ".ogg";
  try {
    if (typeof AurionTheme !== "undefined" && AurionTheme.assetUrl) return AurionTheme.assetUrl(rel);
  } catch { /* fall through to the relative form */ }
  return rel;
}

/**
 * Find out which sounds this build actually ships.
 *
 * A missing file is the normal case, not an error: it simply means that
 * event keeps its built-in tone. Only the bytes are fetched here - the
 * decode happens on first play - so four absent files cost four 404s at
 * boot and nothing else.
 */
async function loadSoundFiles() {
  await Promise.all(SOUND_SLOTS.map(async (slot) => {
    const url = soundFileUrl(slot);
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res || !res.ok) return;
      const bytes = await res.arrayBuffer();
      // A dev server that answers 404s with index.html would otherwise
      // register an HTML page as a sound.
      if (!bytes || bytes.byteLength < 64) return;
      SOUND_FILES.set(slot, { url, bytes, buffer: null });
    } catch { /* not shipped in this build */ }
  }));
}

async function soundFileBuffer(slot) {
  const rec = SOUND_FILES.get(slot);
  if (!rec) return null;
  if (rec.buffer) return rec.buffer;
  const ctx = audioCtx();
  if (!ctx) return null;
  try {
    // decodeAudioData detaches what it is given, so it gets a copy and the
    // original bytes stay available for the next decode.
    rec.buffer = await ctx.decodeAudioData(rec.bytes.slice(0));
    return rec.buffer;
  } catch {
    /* Shipped but not playable - a file that is not really Ogg Vorbis, or
       a truncated copy. Drop it rather than retry on every notification,
       and let the slot fall back to its built-in tone. */
    SOUND_FILES.delete(slot);
    return null;
  }
}

function playSoundFile(slot, level) {
  soundFileBuffer(slot).then((buf) => {
    const ctx = audioCtx();
    if (!buf || !ctx) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    gain.gain.value = Math.max(0.0001, level);
    src.connect(gain).connect(ctx.destination);
    src.start();
  }).catch(() => { /* a sound is not worth an exception */ });
}

/** Play one named tone. Never throws: a sound is not worth an exception. */
function playSound(name, volume, slot) {
  const level = volume === undefined ? notifyPrefs().volume : Number(volume) || 0;
  if (level <= 0) return;
  if (name === "file") {
    if (slot && SOUND_FILES.has(slot)) { playSoundFile(slot, level); return; }
    // This build ships no file for the slot; fall through to its built-in
    // tone so the event is still audible.
    name = (slot && NOTIFY_DEFAULTS[slot]) || "chime";
  }
  const spec = SOUNDS[name];
  if (!spec) return;
  try {
    const ctx = audioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [freq, at, len] of spec.steps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.wave || "sine";
      osc.frequency.value = freq;
      // Shaped rather than switched: an instant start and stop on a pure
      // tone is a click, and a click is what makes a notification sound
      // cheap.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.28), now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + len + 0.02);
    }
  } catch (e) {
    /* no audio device, or a context the browser will not give us */
  }
}

/* ------------------------------------------------------------- trade news */

function tradeHeadline(t) {
  const side = String(t.side || "").toUpperCase();
  const sym = t.symbol || "";
  if (t.kind === "entry") return `${I18N.t("notify.entry")} · ${side} ${sym}`;
  const key = t.result === "profit" ? "notify.exit_profit" : t.result === "loss" ? "notify.exit_loss" : "notify.exit_flat";
  return `${I18N.t(key)} · ${sym}`;
}

function tradeDetail(t) {
  const bits = [];
  if (t.volume) bits.push(`${fmt(t.volume, 2)} ${I18N.t("notify.lots")}`);
  if (t.kind === "entry" && t.price) bits.push(`@ ${fmt(t.price, 5)}`);
  if (t.kind === "exit") bits.push(`${t.profit > 0 ? "+" : ""}${fmt(t.profit, 2)} ${esc(t.currency || "")}`.trim());
  if (t.strategy) bits.push(String(t.strategy));
  return bits.join(" · ");
}

/**
 * A trade opened or closed: say so out loud, on screen, and in Windows.
 *
 * Status changes deliberately do not come through here. They use toast(),
 * which is silent and never leaves the window - the user asked for the
 * difference and it is the right one: a notification that interrupts
 * should mean money has moved.
 */
function announceTrade(t) {
  if (!t || !t.kind) return;
  const prefs = notifyPrefs();
  const which = t.kind === "entry" ? "entry" : t.result === "loss" ? "loss" : "profit";
  if (t.kind === "exit" && t.result === "flat") {
    // A scratch is still an exit worth seeing, but it is not news.
    playSound(prefs.entry === "none" ? "none" : "soft", prefs.volume);
  } else {
    playSound(prefs[which], prefs.volume, which);
  }
  pushTradeCard(t);
  if (prefs.windows) notifyHostTrade(t);
}

function pushTradeCard(t) {
  const stack = $("notify-stack");
  if (!stack) return;
  stack.hidden = false;
  const id = "trade-" + (t.ticket || Date.now());
  const tone = t.kind === "entry" ? "is-entry" : t.result === "loss" ? "is-loss" : "is-profit";
  const card = document.createElement("article");
  card.className = "notify-card trade-card " + tone;
  card.setAttribute("data-nid", id);
  card.innerHTML =
    `<button type="button" class="n-x" data-nx="${esc(id)}" aria-label="${esc(I18N.t("notify.dismiss"))}">${icon("close")}</button>` +
    `<h4>${esc(tradeHeadline(t))}</h4>` +
    `<p class="sub">${esc(tradeDetail(t))}</p>`;
  stack.prepend(card);
  /* Local card: dismissing it is a removal, not a request. Routing it
     through the server dismissal is what used to clear the whole stack. */
  bindDismiss(card);
  while (stack.children.length > 4) stack.lastElementChild.remove();
  setTimeout(() => card.remove(), 12000);
}

/** The Windows toast, via the desktop host. Entries and exits only. */
function notifyHostTrade(t) {
  try {
    const bridge = window.chrome && window.chrome.webview;
    if (!bridge || typeof bridge.postMessage !== "function") return;
    bridge.postMessage(JSON.stringify({
      type: "trade",
      title: tradeHeadline(t),
      body: tradeDetail(t),
      symbol: t.symbol || "",
      timeframe: S.timeframe || "",
      level: t.kind === "exit" && t.result === "loss" ? "warning" : "info",
    }));
  } catch (e) {
    /* running in a plain browser: the on-screen card is the notification */
  }
}

function pushSignalCard(sig) {
  const stack = $("notify-stack");
  if (!stack) return;
  const side = String(sig.action || sig.side || "").toLowerCase();
  const id = "sig-" + (sig.ts || Date.now());
  const card = document.createElement("article");
  card.className = "notify-card signal-card " + (side === "sell" ? "is-sell" : "is-buy");
  card.setAttribute("data-nid", id);
  card.innerHTML =
    `<button type="button" class="n-x" data-nx="${esc(id)}" aria-label="${esc(I18N.t("notify.dismiss"))}">${icon("close")}</button>` +
    `<h4>${esc(signalHeadline(sig))}</h4>` +
    `<p class="sub">${esc(signalDetail(sig) || I18N.t("signal.no_levels"))}</p>` +
    (signalSource(sig) ? `<p class="sub dim">${esc(signalSource(sig))}</p>` : "") +
    `<button type="button" class="btn tiny" data-sig-open="${esc(sig.symbol || "")}"
             data-sig-tf="${esc(sig.timeframe || "")}">${esc(I18N.t("signal.open_ea_chart"))}</button>`;
  stack.prepend(card);
  bindDismiss(card);

  // Signals stack up during a busy session; keep the newest few.
  while (stack.children.length > 4) stack.lastElementChild.remove();

  card.querySelector("[data-sig-open]").onclick = () => {
    openSignalChart(sig.symbol, sig.timeframe, sig);
    card.remove();
  };
}

/**
 * Take the trader to the EA chart the signal is about.
 *
 * It used to open the Markets view, which is the symbol browser: the right
 * instrument, but a different chart from the one the EA is attached to, and
 * without the tools or the signal overlay. Clicking a notification should
 * land on the chart where the trade would be managed, with the signal that
 * sent you there already highlighted.
 */
function openSignalChart(symbol, timeframe, sig) {
  if (!symbol) { show("charts", { animate: true, closeMenu: true }); return; }
  // Remembered so bindChartDesk can pin the card once the signals for this
  // symbol have actually loaded - they are fetched asynchronously and are
  // not here yet at this point.
  S.pendingSignal = sig && typeof sig === "object" ? { ...sig, symbol } : null;
  // Landing on a chart with the overlay switched off would answer nothing,
  // so following a signal turns the signals back on.
  if (S.pendingSignal) {
    S.signalsEnabled = true;
    S.showSignals = true;
    localStorage.setItem("aurion.signalsEnabled", "1");
  }
  openChartDesk(symbol, timeframe || S.timeframe);
  if (S.pendingSignal) fetchChartSignals(symbol, timeframe || S.timeframe);
}

/**
 * Put the card for a just-arrived signal on screen without the trader
 * having to find the arrow and hover it.
 *
 * Matched on time first and index second, because the replayed history and
 * the live bus number their bars differently; the time is the only identity
 * both agree on.
 */
function pinPendingSignal() {
  const want = S.pendingSignal;
  if (!want || !S.chart || typeof S.chart.pinSignal !== "function") return;
  const list = S.chartSignals || [];
  if (!list.length) return;
  const side = String(want.action || want.side || "").toLowerCase();
  const match =
    list.find((s) => want.time && s.time === want.time && s.type === side) ||
    list.filter((s) => s.type === side).slice(-1)[0] ||
    list[list.length - 1];
  if (match) S.chart.pinSignal(match);
  S.pendingSignal = null;
}

/* The host posts back when its toast is clicked, and tells us whether the
   window can currently be seen. */
function bindHostBridge() {
  try {
    const bridge = window.chrome && window.chrome.webview;
    if (!bridge || typeof bridge.addEventListener !== "function") return;
    bridge.addEventListener("message", (e) => {
      let msg = e.data;
      if (typeof msg === "string") {
        try { msg = JSON.parse(msg); } catch (err) { return; }
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "visibility") window.__aurionWindowHidden = Boolean(msg.hidden);
      if (msg.type === "open-signal") openSignalChart(msg.symbol, msg.timeframe, msg.time || msg.side ? msg : null);
    });
  } catch (e) {
    /* running in a browser, not the desk window */
  }
}


function dismissCalendarCard() {
  const tip = document.getElementById("cal-tip");
  if (tip) {
    tip.hidden = true;
    tip.classList.remove("pinned");
  }
  document.querySelectorAll(".cal-cell.pinned").forEach((el) => el.classList.remove("pinned"));
  try { if (window.Calendar && typeof Calendar.unpin === "function") Calendar.unpin(); } catch {}
}

/**
 * True when the renderer has already decided there will be no blur.
 *
 * The fast tier - picked by the trader or detected on a machine that
 * cannot afford thirty blurred layers - strips every backdrop-filter.
 * The liquid-glass switch cannot put them back, so offering it as a live
 * control means flipping it does nothing and the desk looks broken.
 */
function glassForced() {
  try {
    return window.AurionSkin && AurionSkin.effectivePerf() === "fast";
  } catch { return false; }
}

function glassOn() {
  // A forced-off renderer is reported as off, so the switch and the
  // surfaces agree with what is actually on screen.
  if (glassForced()) return false;
  if (document.documentElement && document.documentElement.dataset.glass) {
    return document.documentElement.dataset.glass !== "off";
  }
  try { return localStorage.getItem("aurion.glass") !== "off"; } catch { return true; }
}
function paintGlassSwitch() {
  const sw = $("sw-glass");
  if (!sw) return;
  const on = glassOn();
  const forced = glassForced();
  sw.classList.toggle("on", on);
  sw.setAttribute("aria-pressed", on ? "true" : "false");
  sw.disabled = forced;
  sw.setAttribute("aria-disabled", forced ? "true" : "false");
}
function setGlassNow(on) {
  const next = on ? "on" : "off";
  if (document.documentElement) document.documentElement.dataset.glass = next;
  try { localStorage.setItem("aurion.glass", next); } catch {}
  paintGlassSwitch();
}
function clsPnl(n) { return Number(n) > 0 ? "up" : Number(n) < 0 ? "down" : ""; }
function mt5Live() {
  const mt = S.snap && S.snap.mt5;
  if (mt && mt.connected) return true;
  if (eaLive()) return true;
  return false;
}
function eaLive() {
  return liveAgents().length > 0;
}
function emptyCard(title, body) {
  return `<div class="empty"><div class="orb"></div><h4>${title}</h4><p>${body}</p></div>`;
}

function isCompactNav() {
  return window.matchMedia("(max-width: 1200px)").matches;
}

function setShell(mode) {
  const auth = mode === "auth";
  document.documentElement.classList.toggle("mode-auth", auth);
  document.documentElement.classList.toggle("mode-desk", !auth);
  document.body.classList.toggle("mode-auth", auth);
  document.body.classList.toggle("mode-desk", !auth);
  if (auth) setMenu(false);
}

function setMenu(open) {
  const desk = $("desk");
  const btn = $("btn-menu");
  const scrim = $("nav-scrim");
  const nav = $("nav");
  if (!desk) return;
  const on = Boolean(open) && isCompactNav();
  desk.classList.toggle("menu-open", on);
  document.body.classList.toggle("menu-open", on);
  if (btn) {
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    btn.setAttribute("aria-label", I18N.t("common.menu"));
  }
  if (scrim) scrim.hidden = !on;
  if (nav) {
    nav.setAttribute("aria-hidden", isCompactNav() && !on ? "true" : "false");
    // Open at the top. On a phone the rail keeps its scroll position while it
    // is off-screen, so the next tap on the menu would reveal it half-way down
    // a list the user never scrolled.
    if (on) nav.scrollTop = 0;
  }
}

function closeAllDropdowns() {
  document.querySelectorAll(".dd-wrap.open").forEach((w) => w.classList.remove("open"));
  document.querySelectorAll(".dd-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
  document.querySelectorAll("body > .dd-menu").forEach((m) => { m.hidden = true; });
}

function placeDropdownMenu(btn, menu) {
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rtl = document.documentElement.dir === "rtl";
  const width = Math.max(r.width, 168);
  menu.style.minWidth = width + "px";
  menu.style.maxWidth = Math.min(380, vw - 16) + "px";
  const spaceBelow = vh - r.bottom - 10;
  const spaceAbove = r.top - 10;
  if (spaceBelow < 148 && spaceAbove > spaceBelow) {
    menu.style.top = "auto";
    menu.style.bottom = (vh - r.top + 6) + "px";
    menu.style.maxHeight = Math.max(120, Math.min(280, spaceAbove)) + "px";
  } else {
    menu.style.bottom = "auto";
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.maxHeight = Math.max(120, Math.min(280, spaceBelow)) + "px";
  }
  if (rtl) {
    const right = Math.max(8, vw - r.right);
    menu.style.left = "auto";
    menu.style.right = right + "px";
  } else {
    const left = Math.min(r.left, vw - width - 8);
    menu.style.right = "auto";
    menu.style.left = Math.max(8, left) + "px";
  }
}

function enhanceSelects(root) {
  document.querySelectorAll("body > .dd-menu").forEach((m) => {
    if (!m._sel || !m._sel.isConnected) m.remove();
  });
  (root || document).querySelectorAll("select").forEach((sel) => {
    if (sel.closest(".dd-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "dd-wrap";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("dd-native");
    sel.tabIndex = -1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    menu._sel = sel;
    wrap.appendChild(btn);
    document.body.appendChild(menu);

    const paint = () => {
      const opts = [...sel.options];
      const cur = opts[sel.selectedIndex];
      const label = cur ? cur.text : "—";
      btn.innerHTML = `<span class="dd-label">${esc(label)}</span><span class="dd-caret" aria-hidden="true"></span>`;
      menu.innerHTML = opts.map((o, i) =>
        `<button type="button" class="dd-opt${o.selected ? " on" : ""}" role="option" data-i="${i}" ${o.disabled ? "disabled" : ""}>${esc(o.text)}</button>`
      ).join("") || `<button type="button" class="dd-opt" disabled>—</button>`;
    };
    const close = () => {
      wrap.classList.remove("open");
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      closeAllDropdowns();
      paint();
      wrap.classList.add("open");
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      placeDropdownMenu(btn, menu);
      const on = menu.querySelector(".dd-opt.on") || menu.querySelector(".dd-opt");
      if (on) on.focus();
    };
    paint();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wrap.classList.contains("open")) close();
      else open();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    menu.addEventListener("click", (e) => {
      const opt = e.target.closest(".dd-opt");
      if (!opt || opt.disabled) return;
      const i = +opt.dataset.i;
      if (!Number.isFinite(i)) return;
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      paint();
      close();
      btn.focus();
    });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll(".dd-opt:not([disabled])")];
      const idx = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
      if (e.key === "ArrowDown") { e.preventDefault(); (items[idx + 1] || items[0])?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); (items[idx - 1] || items[items.length - 1])?.focus(); }
      if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
      if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    });
    const mo = new MutationObserver(paint);
    mo.observe(sel, { childList: true, subtree: true, attributes: true });
  });
}

function bindChrome() {
  if (S._chromeBound) return;
  S._chromeBound = true;
  const btn = $("btn-menu");
  const scrim = $("nav-scrim");
  if (btn) {
    btn.onclick = () => {
      const open = !$("desk").classList.contains("menu-open");
      setMenu(open);
    };
  }
  if (scrim) scrim.onclick = () => setMenu(false);
  const themeBtn = $("btn-theme");
  if (themeBtn) themeBtn.onclick = () => setTheme(currentTheme() === "light" ? "dark" : "light");
  paintThemeBtn();
  bindSystemTheme();
  const hdrBtn = $("btn-hdr-drawer");
  if (hdrBtn) {
    hdrBtn.title = I18N.t("hdr.drawer");
    hdrBtn.onclick = () => toggleHdrDrawer();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalOpen()) return;
      closeAllDropdowns();
      setMenu(false);
      if (S.chartFocus && S.view === "charts") closeChartDesk();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".dd-wrap") && !e.target.closest(".dd-menu")) closeAllDropdowns();
    if (!e.target.closest("#hdr-drawer") && !e.target.closest("#btn-hdr-drawer")) toggleHdrDrawer(false);
  });
  window.addEventListener("resize", () => {
    closeAllDropdowns();
    if (!isCompactNav()) setMenu(false);
  });
  document.addEventListener("scroll", (e) => {
    if (e.target && e.target.closest && e.target.closest(".dd-menu")) return;
    closeAllDropdowns();
  }, true);
}

function copyrightYear() {
  const tag = I18N.lang === "fa" ? "fa-IR-u-ca-persian" : I18N.lang === "ar" ? "ar-SA-u-ca-islamic-umalqura" : "en-GB-u-ca-gregory";
  try {
    return new Intl.DateTimeFormat(tag, { year: "numeric" }).format(new Date());
  } catch {
    return String(new Date().getFullYear());
  }
}

function navAccountHtml() {
  const L = ((S.snap && S.snap.license) || S._gateLic || {});
  const premium = Boolean(L.premium);
  const label = premium ? planLabel(L) : I18N.t("lic.freemium");
  return `<span class="nav-acc ${premium ? "prem" : "free"}" id="nav-acc" title="${esc(I18N.t("nav.upgrade"))}">${esc(label)}</span>`;
}

/* The themes are premium, and the theme layer boots in <head> from a cached
   verdict because the licence only arrives with the first snapshot. This is
   where the engine's answer reaches it - on every sync and on every licence
   push, so activating a key restores the user's theme without a reload and a
   lapsed one drops the desk back to glass the same way. */
function syncThemeLicense() {
  if (typeof AurionTheme === "undefined") return;
  const L = ((S.snap && S.snap.license) || S._gateLic || {});
  // Unknown licence (no snapshot yet) is not an answer - leave the cache be.
  if (L.premium === undefined || L.premium === null) return;
  const changed = AurionTheme.setPaid(Boolean(L.premium));
  if (!changed) return;
  markThemeCards();
  markAppearancePills();
  repaintChartsForTheme();
  if (S.view === "settings") show("settings", { animate: false, closeMenu: false, nav: false });
}

function paintNavAcc() {
  syncThemeLicense();
  const chip = $("nav-acc");
  if (!chip) return;
  const L = ((S.snap && S.snap.license) || S._gateLic || {});
  chip.textContent = L.premium ? planLabel(L) : I18N.t("lic.freemium");
  chip.classList.toggle("prem", Boolean(L.premium));
  chip.classList.toggle("free", !L.premium);
  const year = $("nav-year");
  if (year) year.textContent = copyrightYear();
}

function renderNav() {
  const nav = $("nav");
  const tag = String(I18N.t("brand.tagline")).replace(/"/g, "&quot;");
  const ver = S.version || S.snap?.version || S._gateLic?.version || "1.0.0";
  nav.innerHTML = `<div class="nav-head"><div class="nav-logo"><img class="mark" src="icons/mark.png?v=desk49" alt="AURION" /></div><div class="nav-brand"><b>AURION</b><span class="nav-tag">${tag}</span></div></div>` +
    NAV.map(([id, key, svg]) => {
      const label = I18N.t(key);
      return `<button type="button" data-view="${id}" class="nav-tab ${S.view === id ? "on" : ""}" title="${label.replace(/"/g, "&quot;")}">${svg}<span>${label}</span></button>`;
    }).join("") +
    `<div class="spacer"></div>
    <div class="nav-foot" id="nav-foot">
      <button type="button" class="nav-acc-btn" id="nav-acc-btn">${navAccountHtml()}</button>
      <div class="nav-brandline nav-brandline-stacked">
        <span class="nav-copy">© <span id="nav-year">${copyrightYear()}</span> Axiasoft</span>
        <span id="nav-version" class="nav-ver">v${esc(ver)}</span>
      </div>
    </div>`;
  const accBtn = nav.querySelector("#nav-acc-btn");
  if (accBtn) accBtn.onclick = () => show("upgrade");
  nav.querySelectorAll("button[data-view]").forEach((b) => {
    b.onclick = () => {
      setMenu(false);
      if (S.mountedView === b.dataset.view && S.view === b.dataset.view) return;
      show(b.dataset.view);
    };
  });
  if (isCompactNav()) nav.setAttribute("aria-hidden", $("desk").classList.contains("menu-open") ? "false" : "true");
  else nav.setAttribute("aria-hidden", "false");
}

function markNav() {
  const nav = $("nav");
  if (!nav) return;
  nav.querySelectorAll("button[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === S.view);
  });
}

function defaultSymbol() {
  const items = liveSymbols();
  if (S.symbol && items.some((x) => x.symbol === S.symbol)) return S.symbol;
  if (items[0]) return items[0].symbol;
  return "";
}
function adoptEaNow() {
  const agents = liveAgents();
  if (!agents.length) return false;
  const hit = agents.find((a) => a.symbol === S.symbol);
  if (!hit) {
    S.symbol = agents[0].symbol;
    S.timeframe = agents[0].timeframe || S.timeframe || "M15";
  } else if (!S.timeframe && hit.timeframe) {
    S.timeframe = hit.timeframe;
  }
  return true;
}
function primeEaChart() {
  if (!adoptEaNow() || !S.symbol) return;
  const key = S.symbol + ":" + (S.timeframe || "");
  if (S._primedEa === key && S.candles.length) return;
  S._primedEa = key;
  pickMarket(S.symbol, S.timeframe || "M15");
}
function robotRows() {
  if (S.robotLogs && S.robotLogs.length) return S.robotLogs;
  const snap = (S.snap && S.snap.robot) || [];
  if (snap.length) return snap;
  return (S.logs || []).filter((l) => l.channel === "robot");
}
function renderRobotLogs(filter = "") {
  const q = String(filter || "").toLowerCase();
  const rows = robotRows().filter((l) => JSON.stringify(l).toLowerCase().includes(q)).slice(-400);
  if (!rows.length) return `<div class="l-info">${I18N.t("terminal.robot_empty")}</div>`;
  return rows.map((l) => {
    const msg = l.message || (l.lang_key && I18N.t(l.lang_key)) || "";
    return `<div class="l-${l.level || "info"}"><span class="ts">${l.ts || ""}</span>${esc(msg)}</div>`;
  }).join("");
}
function robotPanelBox() {
  return `<div class="card robot-card">
    <div class="auto-banner" style="margin:0 0 8px">
      <div>
        <h3 style="margin:0 0 4px">${I18N.t("terminal.robot")}</h3>
        <p class="sub">${I18N.t("terminal.robot_hint")}</p>
      </div>
      <button type="button" class="btn tiny ghost" id="robot-open">${I18N.t("nav.terminal")}</button>
    </div>
    <div class="term robot-term" id="robot-term">${renderRobotLogs()}</div>
  </div>`;
}
function allAgents() {
  const raw = S.snap && S.snap.agents;
  let list = [];
  if (Array.isArray(raw) && raw.length) list = raw.filter(Boolean);
  else if (raw && Array.isArray(raw.items) && raw.items.length) list = raw.items.filter(Boolean);
  else if (raw && Array.isArray(raw.data) && raw.data.length) list = raw.data.filter(Boolean);
  else if (raw && Array.isArray(raw.agents) && raw.agents.length) list = raw.agents.filter(Boolean);
  return list.filter((a) => {
    if (!a || !a.symbol) return false;
    const st = String(a.status || "online").toLowerCase();
    return st !== "offline" && st !== "removed";
  });
}
function isTesterAgent(a) {
  return Boolean(a && (a.tester || String(a.mode || "").toLowerCase() === "tester" || String(a.mode || "").toLowerCase() === "backtest"));
}
function liveAgents() {
  // Agents whose tape the desk is showing right now. With a live chart
  // attached that is always the live charts; with only a Strategy Tester
  // chart attached, the tester charts drive the desk (backtest watch mode).
  const mode = String((S.snap && S.snap.tape) || "");
  let out = [];
  if (mode === "tester") {
    out = allAgents().filter(isTesterAgent);
    if (!out.length) out = allAgents();
  } else {
    out = allAgents().filter((a) => !isTesterAgent(a));
  }
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    const key = String(a.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(a);
  }
  if (dedup.length) {
    S._agentCache = dedup;
    S._agentCacheAt = Date.now();
  } else {
    S._agentCache = [];
    S._agentCacheAt = 0;
  }
  return dedup;
}
function testerAgents() {
  // Attached tester charts that are NOT driving the desk (a live chart is on top).
  const driving = new Set(liveAgents().map((a) => String(a.chart_id || a.symbol)));
  const out = [];
  const seen = new Set();
  for (const a of allAgents()) {
    if (!isTesterAgent(a)) continue;
    const key = String(a.chart_id || a.symbol);
    if (driving.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function eaIngestLine() {
  const mt = (S.snap && S.snap.mt5) || {};
  const parts = [];
  if (mt.ea_last_hello) parts.push("hello " + mt.ea_last_hello);
  if (mt.ea_last_ingest) parts.push("ingest " + mt.ea_last_ingest);
  if (mt.ea_file_inbox) parts.push("file " + mt.ea_file_inbox);
  if (mt.ea_ingest_count) parts.push("n=" + mt.ea_ingest_count);
  if (mt.last_error) parts.push(String(mt.last_error));
  return parts.join(" · ");
}
function liveSymbols() {
  const out = [];
  const seen = new Set();
  for (const a of liveAgents()) {
    if (!a.symbol || seen.has(a.symbol)) continue;
    seen.add(a.symbol);
    out.push({
      symbol: a.symbol,
      timeframe: a.timeframe || "",
      label: a.timeframe ? `${a.symbol} · ${a.timeframe}` : a.symbol,
    });
  }
  return out;
}
function liveGate() {
  const g = { ...(S.snap?.gate || {}) };
  if (S.snap && S.snap.kill_switch !== undefined) g.kill = Boolean(S.snap.kill_switch);
  if (S.snap && S.snap.strategy && S.snap.strategy.auto_trade !== undefined) g.auto_trade = Boolean(S.snap.strategy.auto_trade);
  if (S.snap && S.snap.prop) {
    g.prop = S.snap.prop.enabled !== false;
    g.prop_locked = Boolean(S.snap.prop.locked);
  }
  if (mt5Live() || eaLive()) {
    g.mt5 = true;
    g.reasons = (g.reasons || []).filter((r) => r !== "mt5_down");
    if (!g.who || g.who === "nobody") g.who = g.ready ? "robot" : "manual";
  }
  if (!mt5Live() && !eaLive()) {
    g.mt5 = false;
    g.who = "nobody";
    if (!(g.reasons || []).includes("mt5_down")) g.reasons = ["mt5_down", ...(g.reasons || [])];
  }
  return g;
}
function pruneDeadSymbols() {
  const items = liveSymbols();
  const live = new Set(items.map((x) => x.symbol));
  const ticks = (S.snap && S.snap.ticks) || {};
  let changed = false;
  for (const k of Object.keys(ticks)) {
    if (!live.has(k)) {
      delete ticks[k];
      changed = true;
    }
  }
  if (S.symbol && live.size && !live.has(S.symbol)) {
    S.symbol = items[0].symbol;
    S.timeframe = items[0].timeframe || S.timeframe || "M15";
    S.candles = [];
    changed = true;
  }
  if (!live.size) {
    if (S.symbol || (S.candles && S.candles.length)) changed = true;
    S.symbol = "";
    S.candles = [];
  }
  if (S.chartFocus && (!live.size || !live.has(S.chartFocus.symbol))) {
    S.chartFocus = null;
    changed = true;
  }
  return changed;
}
function symbolSelectHtml(id, selected) {
  const items = liveSymbols();
  const cur = selected || S.symbol || "";
  if (!items.length) {
    return `<select class="ctrl" id="${id}" disabled><option value="">${esc(I18N.t("exec.no_ea_symbol"))}</option></select>`;
  }
  return `<select class="ctrl" id="${id}">${items.map((it) => `<option value="${esc(it.symbol)}" ${it.symbol === cur ? "selected" : ""}>${esc(it.label)}</option>`).join("")}</select>`;
}
function fillSymbolSelect(id, selected) {
  const sel = $(id);
  if (!sel || sel.tagName !== "SELECT") return;
  const items = liveSymbols();
  const want = selected || sel.value || S.symbol || "";
  const prev = [...sel.options].map((o) => o.value + "\t" + o.text).join("|");
  const next = items.length ? items.map((it) => it.symbol + "\t" + it.label).join("|") : "\t";
  if (prev === next) {
    sel.disabled = !items.length;
    return;
  }
  if (!items.length) {
    sel.innerHTML = `<option value="">${esc(I18N.t("exec.no_ea_symbol"))}</option>`;
    sel.disabled = true;
    sel.value = "";
    return;
  }
  sel.disabled = false;
  sel.innerHTML = items.map((it) => `<option value="${esc(it.symbol)}" ${it.symbol === want ? "selected" : ""}>${esc(it.label)}</option>`).join("");
  sel.value = items.some((it) => it.symbol === want) ? want : items[0].symbol;
}
function setManualTradeEnabled(on) {
  const buy = $("ex-buy");
  const sell = $("ex-sell");
  if (buy) buy.disabled = !on;
  if (sell) sell.disabled = !on;
  const hint = $("ex-ea-hint");
  if (hint) hint.textContent = on ? I18N.t("exec.pick_symbol") : I18N.t("exec.no_ea_symbol");
}
function viewMode() {
  const eaKey = liveAgents().map((a) => (a.chart_id || "") + ":" + a.symbol + ":" + (a.timeframe || "")).sort().join(",") || "none";
  if (S.view === "command") return "command:" + (eaLive() ? "ea" : "wait") + ":" + eaKey;
  if (S.view === "markets" || S.view === "execution") return S.view + ":" + eaKey;
  if (S.view === "intelligence") return "intelligence:" + eaKey;
  if (S.view === "charts") {
    if (S.chartFocus) return "charts-focus:" + S.chartFocus.symbol + ":" + S.chartFocus.timeframe;
    if (!eaLive()) return "charts-wait";
    return "charts-live:" + eaKey;
  }
  return S.view;
}

function gateSlides() {
  // Per-symbol "who trades" cards from the engine (one slide per live chart).
  // Falls back to the single global gate when the engine is old or offline.
  const raw = (S.snap && S.snap.gates) || [];
  if (Array.isArray(raw) && raw.length) {
    return raw.map((slide) => {
      const g = { ...(slide || {}) };
      if (mt5Live() || eaLive()) {
        g.mt5 = true;
        g.reasons = (g.reasons || []).filter((r) => r !== "mt5_down");
        if (!g.who || g.who === "nobody") g.who = g.ready ? "robot" : "manual";
      }
      if (!mt5Live() && !eaLive()) {
        g.mt5 = false;
        g.who = "nobody";
        if (!(g.reasons || []).includes("mt5_down")) g.reasons = ["mt5_down", ...(g.reasons || [])];
      }
      return g;
    });
  }
  const live = liveGate();
  const sym = S.symbol || "";
  const n = (S.snap?.positions || []).filter((x) => !sym || x.symbol === sym).length;
  return [{ ...live, symbol: sym, timeframe: sym ? (S.timeframe || "") : "", positions: n }];
}
function gateSlideInnerHtml(slide) {
  const g = slide || {};
  const reasons = g.reasons || [];
  const who = g.who || "nobody";
  const whoLabel = I18N.t("gate.who_" + who);
  const items = [
    ["mt5", g.mt5, "gate.mt5"],
    ["auto", g.auto_trade, "gate.auto"],
    ["st", (g.strategies || []).length, "gate.strategies"],
    ["kill", !g.kill, "gate.kill_ok"],
    ["prop", !(g.prop && g.prop_locked), g.prop ? "gate.prop_ok" : "gate.prop_off"],
    ["ai", !reasons.includes("ai_low"), g.ai_gate ? "gate.ai_on" : "gate.ai_off"],
  ];
  const why = reasons.length ? reasons.map((r) => `<li>${I18N.t("gate.r_" + r)}</li>`).join("") : `<li>${I18N.t("gate.ready")}</li>`;
  const title = g.symbol ? (g.timeframe ? g.symbol + " · " + g.timeframe : g.symbol) : "";
  return `<div class="auto-banner" style="margin:0 0 10px">
      <div>
        <h3 style="margin:0 0 4px">${I18N.t("gate.title")}${title ? `<span class="slide-sym mono">${esc(title)}</span>` : ""}</h3>
        <p class="sub">${I18N.t("gate.who")}: <b>${whoLabel}</b> · ${I18N.t("style.title")}: <span>${I18N.t("style." + (g.style || "normal"))}</span> · ${I18N.t("gate.open_n", { n: g.positions || 0 })}</p>
      </div>
      <span class="pill ${g.ready ? "on" : ""}">${g.ready ? I18N.t("gate.armed") : I18N.t("gate.idle")}</span>
    </div>
    <div class="gate-pills">${items.map(([id, ok, key]) => `<span class="pill ${ok ? "ok" : "no"}">${I18N.t(key)}${id==="st" && g.strategies?.length ? " · " + g.strategies.join(", ") : ""}</span>`).join("")}</div>
    <ul class="gate-why">${why}</ul>`;
}
function gateKey() {
  const slides = gateSlides();
  return JSON.stringify({
    i: S.gateSlide | 0,
    lang: I18N.lang,
    slides: slides.map((g) => ([
      g.symbol || "", g.timeframe || "", g.who || "nobody", Boolean(g.ready), Boolean(g.mt5),
      Boolean(g.auto_trade), (g.strategies || []).join(","), Boolean(g.kill), Boolean(g.prop),
      Boolean(g.prop_locked), Boolean(g.ai_gate), (g.reasons || []).join(","), g.style || "normal",
      g.positions || 0,
    ]).join("|")),
  });
}
function gateHtml() {
  const slides = gateSlides();
  if ((S.gateSlide | 0) >= slides.length) S.gateSlide = Math.max(0, slides.length - 1);
  const idx = S.gateSlide | 0;
  const inner = gateSlideInnerHtml(slides[idx] || slides[0] || {});
  if (slides.length < 2) {
    return `<div class="card gate-card" id="trade-gate" data-gk="${esc(gateKey())}">
      <div class="chart-stage" id="gate-slide-stage">${inner}</div>
    </div>`;
  }
  return `<div class="card gate-card" id="trade-gate" data-gk="${esc(gateKey())}">
    <div class="chart-slider gate-slider">
      <button type="button" class="btn tiny ghost chart-nav" id="gate-prev" title="${I18N.t("gate.prev_sym")}" aria-label="${I18N.t("gate.prev_sym")}">‹</button>
      <div class="chart-stage" id="gate-slide-stage">${inner}</div>
      <button type="button" class="btn tiny ghost chart-nav" id="gate-next" title="${I18N.t("gate.next_sym")}" aria-label="${I18N.t("gate.next_sym")}">›</button>
    </div>
    <div class="chart-dots" id="gate-dots">${slides.map((s, i) => `<button type="button" class="chart-dot ${i === idx ? "on" : ""}" data-i="${i}" title="${esc(s.timeframe ? s.symbol + " · " + s.timeframe : (s.symbol || ""))}" aria-label="${esc(s.symbol || "")}"></button>`).join("")}</div>
  </div>`;
}
function patchGate() {
  const cur = $("trade-gate");
  if (!cur) return;
  const key = gateKey();
  if (S._gatePainted === key) return;
  S._gatePainted = key;
  const multi = gateSlides().length > 1;
  if (multi !== Boolean($("gate-prev"))) {
    const wrap = document.createElement("div");
    wrap.innerHTML = gateHtml();
    const next = wrap.firstElementChild;
    if (next) {
      cur.replaceWith(next);
      bindGateSlider();
    }
    return;
  }
  paintGateSlider();
}
function paintGateSlider(animDir) {
  const stage = $("gate-slide-stage");
  if (!stage) return;
  const slides = gateSlides();
  if ((S.gateSlide | 0) >= slides.length) S.gateSlide = Math.max(0, slides.length - 1);
  stage.innerHTML = gateSlideInnerHtml(slides[S.gateSlide | 0] || slides[0] || {});
  if (animDir) {
    stage.classList.remove("sw-next", "sw-prev");
    void stage.offsetWidth;
    stage.classList.add(animDir > 0 ? "sw-next" : "sw-prev");
    setTimeout(() => stage.classList.remove("sw-next", "sw-prev"), 380);
  }
  document.querySelectorAll("#gate-dots .chart-dot").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === (S.gateSlide | 0)));
}
function stepGateSlider(delta, jumpTo) {
  const slides = gateSlides();
  if (slides.length < 2) return;
  const prev = S.gateSlide | 0;
  const n = slides.length;
  const want = typeof jumpTo === "number" ? jumpTo : prev + delta;
  S.gateSlide = ((want % n) + n) % n;
  const anim = typeof jumpTo === "number" ? (S.gateSlide > prev ? 1 : -1) : Math.sign(delta);
  S._gatePainted = gateKey();
  paintGateSlider(anim);
}
function bindGateSlider() {
  const prev = $("gate-prev");
  const next = $("gate-next");
  if (prev) prev.onclick = () => stepGateSlider(-1);
  if (next) next.onclick = () => stepGateSlider(1);
  $("gate-dots")?.querySelectorAll(".chart-dot").forEach((el) => { el.onclick = () => stepGateSlider(0, Number(el.dataset.i)); });
  const stage = $("gate-slide-stage");
  if (stage && !stage._swipeBound) {
    stage._swipeBound = true;
    let x0 = 0, y0 = 0, dx = 0, touching = false;
    stage.addEventListener("touchstart", (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      touching = true;
      dx = 0;
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      if (!touching || !e.touches[0]) return;
      dx = e.touches[0].clientX - x0;
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (!touching) return;
      touching = false;
      const dy = (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : y0) - y0;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) return;
      if (Math.abs(dx) < 42) return;
      const rtl = document.documentElement.dir === "rtl";
      const dir = dx < 0 ? 1 : -1;
      stepGateSlider(rtl ? -dir : dir);
    }, { passive: true });
  }
}

function kpi(key, value, suffix, signed) {
  return `<div class="kpi"><span>${I18N.t(key)}</span><b class="mono ${signed?clsPnl(value):""}" data-metric="${key}">${fmt(value)}${suffix ? " " + suffix : ""}</b></div>`;
}
function openChartDesk(symbol, timeframe) {
  if (!symbol) return;
  S.chartFocus = { symbol, timeframe: timeframe || S.timeframe || "M15" };
  S.symbol = symbol;
  S.timeframe = S.chartFocus.timeframe;
  show("charts", { animate: true, closeMenu: true });
}
function closeChartDesk() {
  S.chartFocus = null;
  show("charts", { animate: true, closeMenu: false });
}

function show(view, opts) {
  opts = opts || {};
  const stage = $("stage");
  if (!stage) return;
  const prev = S.mountedView;
  const changing = prev !== view;
  if (view === "profile" || view === "execution") view = "command";
  if (view === "settings" && changing && prev && prev !== "settings") S.setTab = "set-robot";
  // The calendar's day card is parented to <body> so no transformed ancestor
  // can break its fixed positioning - which also means leaving the calendar
  // does not take it with you. Dismiss it on every view change.
  if (changing) dismissCalendarCard();
  S.view = view;
  localStorage.setItem("aurion.view", view);
  if (changing) {
    try { stage.scrollTop = 0; } catch { /* */ }
  }
  if (API.token) {
    clearTimeout(S._prefTimer);
    S._prefTimer = setTimeout(() => {
      API.post("/api/profile/settings", { last_view: S.view, symbol: S.symbol || "", timeframe: S.timeframe || "M15" }).then((r) => {
        if (r && r.ok) S.prefs = { ...(S.prefs || {}), ...(r.data || {}) };
      }).catch(() => {});
    }, 900);
  }
  if (opts.closeMenu !== false && (changing || opts.forceMenu === true)) setMenu(false);

  const paint = () => {
    S._paintTimer = null;
    const title = $("page-title");
    if (title) title.textContent = I18N.t(NAV.find((n) => n[0] === view)?.[1] || "nav.command");
    if (opts.nav !== false) {
      if (changing || !$("nav")?.querySelector("button[data-view]")) renderNav();
      else markNav();
    }
    S.chart = null;
    document.querySelectorAll("body > .dd-menu").forEach((m) => m.remove());
    stage.innerHTML = views[view] ? views[view]() : "";
    I18N.apply(stage);
    bindView(view);
    enhanceSelects(stage);
    S.mountedView = view;
    S.viewMode = viewMode();
    if (view === "command" || view === "execution") S._gatePainted = gateKey();
    stage.classList.remove("is-leaving");
    if (changing && opts.animate !== false) {
      stage.classList.add("is-entering");
      if (S._enterTimer) clearTimeout(S._enterTimer);
      S._enterTimer = setTimeout(() => stage.classList.remove("is-entering"), 480);
    }
  };

  if (S._paintTimer) {
    clearTimeout(S._paintTimer);
    S._paintTimer = null;
  }

  const animateOut = changing && opts.animate !== false && stage.innerHTML.trim();
  if (!animateOut) {
    paint();
    return;
  }
  stage.classList.add("is-leaving");
  S._paintTimer = window.setTimeout(paint, 120);
}

function patchMetric(key, value, suffix, signed) {
  const el = document.querySelector(`[data-metric="${key}"]`);
  if (!el) return;
  const next = `${fmt(value)}${suffix ? " " + suffix : ""}`;
  if (el.textContent !== next) el.textContent = next;
  el.classList.toggle("up", Boolean(signed && Number(value) > 0));
  el.classList.toggle("down", Boolean(signed && Number(value) < 0));
}

function bindCloseButtons(root) {
  (root || document).querySelectorAll("[data-close]").forEach((b) => {
    b.onclick = async () => {
      await API.post("/api/order", { action: "close", ticket: +b.dataset.close });
      await refresh(false);
    };
  });
}

function eaStale() {
  const ea = (S.snap && S.snap.experts) || {};
  return Array.isArray(ea.stale) ? ea.stale : [];
}

function eaStaleLabel() {
  const ea = (S.snap && S.snap.experts) || {};
  return I18N.t("ea.stale_pill", { n: eaStale().length, v: String(ea.version || "") });
}

function patchLive() {
  const v = S.view;
  paintNavAcc();
  if (v === "command" || v === "execution") patchGate();
  if (v === "command") {
    const wiz = $("cmd-wizard");
    if (wiz) wiz.hidden = eaLive();
    const eaPill = $("wiz-ea");
    if (eaPill) eaPill.textContent = I18N.t("status.ea_attached", { n: liveAgents().length });
    const hint = $("cmd-wizard")?.querySelector(".hero-copy .sub");
    if (hint && !eaLive()) hint.textContent = I18N.t("status.ea_waiting");
    const ingest = $("wiz-ingest");
    if (ingest && !eaLive()) ingest.textContent = eaIngestLine() || I18N.t("status.ea_file_hint");
    const mt = $("wiz-mt5");
    if (mt) {
      mt.className = "pill pill-mt5";
      mt.innerHTML = `<i class="dot dot-mt5 ${mt5Live() ? "live" : "down"}"></i>${I18N.t(mt5Live() ? "status.mt5_live" : "status.mt5_down")}`;
    }
    const cmdMt = $("cmd-mt5");
    if (cmdMt) cmdMt.innerHTML = `<i class="dot dot-mt5 ${mt5Live() ? "live" : "down"}"></i><span>${I18N.t(mt5Live() ? "status.mt5_live" : "status.mt5_down")}</span>`;
    const cmdEa = $("cmd-ea");
    if (cmdEa) cmdEa.textContent = I18N.t("status.ea_attached", { n: liveAgents().length });
    // An expert older than the one this build ships is worth saying on the
    // front page, not only on a settings tab nobody opens twice a year.
    const eaVer = $("wiz-eaver");
    if (eaVer) {
      const stale = eaStale();
      eaVer.hidden = stale.length === 0;
      if (stale.length) eaVer.textContent = eaStaleLabel();
    }
    const strip = $("conn-strip");
    if (strip) {
      const eng = strip.querySelector(".pill-engine");
      if (eng) eng.innerHTML = `<i class="dot dot-engine ${S.snap ? "live" : "down"}"></i><span>${I18N.t(S.snap ? "status.engine_live" : "status.engine_down")}</span>`;
    }
  }
  if (v === "command" && mt5Live()) {
    const acc = S.snap?.mt5?.account || {};
    const prop = S.snap?.prop || {};
    patchMetric("command.balance", acc.balance, acc.currency);
    patchMetric("command.equity", acc.equity, acc.currency);
    patchMetric("command.profit", acc.profit, acc.currency, true);
    patchMetric("command.daily_pl", prop.daily_pl_pct, "%", true);
    patchMetric("command.drawdown", prop.drawdown_pct, "%");
    patchMetric("command.margin", acc.margin, acc.currency);
    patchMetric("command.free_margin", acc.margin_free, acc.currency);
    patchMetric("command.leverage", acc.leverage ? "1:" + acc.leverage : "—", "");
    const pos = S.snap?.positions || [];
    paintPositions("live-pos", pos, ["symbol","type","volume","strategy","price_open","price_current","sl","tp","profit","profit_pct"], true);
    applyChartLevels();
    paintChartSlider("ol", outlookSlideInnerHtml);
  }
  if (v === "markets") {
    fillSymbolSelect("sym", S.symbol);
    const lbl = $("tick-lbl");
    if (lbl) lbl.textContent = tickLabel();
    const ticks = S.snap?.ticks || {};
    const symbols = liveSymbols().map((x) => x.symbol).filter((s) => ticks[s]);
    const box = $("live-ticks");
    /* One template for the first paint and the refresh. They used to be
       two copies of the same markup and had already begun to disagree. */
    if (box) box.innerHTML = symbols.length ? watchlistHtml() : emptyMini(I18N.t("status.waiting_ticks"));
    const empty = document.querySelector(".chart-box .empty");
    if (empty && eaLive() && S.candles.length) empty.remove();
  }
  if (v === "intelligence") {
    // v54: per-chart intelligence — slider controls which chart's regime+features we show
    const ai = currentAiSlideState() || S.snap?.ai || {};
    paintChartSlider("ai", aiSlideInnerHtml);
    // regime may be string (legacy) or object (v54)
    const regimeEl = $("ai-regime");
    if (regimeEl) {
      const rg = ai.regime_obj || ai.regime;
      regimeEl.textContent = regLabel(typeof rg === "string" ? {name: rg} : rg);
    }
    const pattern = $("ai-pattern");
    if (pattern) {
      const pat = ai.pattern_obj || ai.pattern;
      pattern.textContent = typeof pat === "string" ? pat : (pat?.name || "—");
    }
    const samples = $("ai-samples");
    if (samples) samples.textContent = String(ai.samples || 0);
    const why = $("ai-why");
    if (why) {
      const cw = ai.confidence_why || {};
      why.textContent = cw.text || ai.reason || I18N.t("ai.conf_help");
    }
    // live features based on selected chart (ai_by_symbol)
    const featBox = $("ai-feat");
    if (featBox) {
      const feats = ai.features || {};
      const keys = Object.keys(feats);
      if (keys.length) {
        featBox.innerHTML = keys.slice(0,18).map((k)=>`<span>${esc(k)}</span><b class="mono">${fmt(feats[k],5)}</b>`).join("");
      } else {
        featBox.innerHTML = emptyMini(I18N.t("status.ai_idle"));
      }
    }
    const feed = $("ai-feed");
    if (feed) {
      const rows = (ai.activity || S.snap?.ai?.activity || []).slice(-16).reverse();
      feed.innerHTML = rows.length
        ? rows.map((row) => `<div class="row-line"><span class="ts">${esc(row.ts || "")}</span><span>${esc(row.text || "")}</span></div>`).join("")
        : emptyMini(I18N.t("status.ai_idle"));
    }
  }
  if (v === "execution") {
    fillSymbolSelect("ex-sym", defaultSymbol());
    setManualTradeEnabled(liveSymbols().length > 0);
    paintSwitch($("ex-auto"), Boolean(S.snap?.strategy?.auto_trade));
    const pos = S.snap?.positions || [];
    const orders = S.snap?.orders || [];
    paintPositions("live-exec-pos", pos, ["ticket","symbol","type","volume","strategy","price_open","sl","tp","profit","profit_pct"], true);
    const ob = $("live-exec-ord");
    if (ob) ob.innerHTML = orders.length ? table(orders, ["ticket","symbol","type","volume","price"]) : emptyMini(I18N.t("status.no_orders"));
  }
  if (v === "terminal" && (S.termTab || "live") === "live") {
    const term = $("term");
    if (term && document.activeElement !== $("log-q")) {
      term.innerHTML = renderLogs($("log-q")?.value || "");
    }
  }
  if (v === "settings") {
    const msg = $("s-msg");
    const mt = S.snap?.mt5 || {};
    if (msg && !typing()) {
      msg.textContent = mt.last_error || (mt.connected ? I18N.t("status.mt5_live") : I18N.t("status.mt5_down"));
    }
    const pstat = S.snap?.prop || {};
    const st = $("risk-state");
    if (st) {
      st.textContent = pstat.enabled === false ? I18N.t("risk.prop_off") : (pstat.locked ? I18N.t("status.safe_mode") : I18N.t("status.prop_ok"));
      st.className = "metric " + (pstat.locked ? "down" : "up");
    }
    const dpl = $("risk-dpl");
    if (dpl) {
      dpl.textContent = fmt(pstat.daily_pl_pct) + "%";
      dpl.className = "mono " + clsPnl(pstat.daily_pl_pct);
    }
    const dd = $("risk-dd");
    if (dd) dd.textContent = fmt(pstat.drawdown_pct) + "%";
    const autoOn = Boolean(S.snap?.strategy?.auto_trade);
    paintSwitch($("st-auto"), autoOn);
    const autoSub = $("st-auto-sub");
    if (autoSub) autoSub.textContent = I18N.t(autoOn ? "exec.auto_on" : "exec.auto_off");
    // How many robot trades are actually open is the one number on that card
    // that moves by itself, so it is patched rather than left at render time.
    const slotsNow = $("st-slots-now");
    if (slotsNow) {
      const stx = S.snap?.strategy || {};
      const cap = stx.cap_effective ?? stx.max_open_trades ?? 2;
      const openNow = stx.open_trades ?? 0;
      slotsNow.textContent = I18N.t("slots.state", { n: openNow, cap, free: Math.max(0, cap - openNow) });
      const dots = slotsNow.parentElement?.querySelector(".slot-dots");
      if (dots) {
        const want = Math.min(12, Math.max(cap, openNow));
        if (dots.children.length !== want) {
          dots.innerHTML = Array.from({ length: want }, () => "<i></i>").join("");
        }
        Array.prototype.forEach.call(dots.children, (el, i) => el.classList.toggle("on", i < openNow));
      }
    }
    const hero = $("st-auto")?.closest(".robot-hero");
    if (hero) hero.classList.toggle("is-on", autoOn);
    const propOn = pstat.enabled !== false;
    paintSwitch($("prop-enable"), propOn);
    const psub = $("prop-enable-sub");
    if (psub) psub.textContent = I18N.t(propOn ? "risk.prop_on" : "risk.prop_off");
    const rfLive = S.snap?.strategy?.risk_free || {};
    paintSwitch($("st-rf"), rfLive.enabled);
    const rfSteps = $("st-rf-steps");
    if (rfSteps && document.activeElement !== rfSteps) {
      rfSteps.value = rfLive.steps ?? 3;
      const n = $("st-rf-steps-n");
      if (n) n.textContent = String(rfSteps.value);
      const ladder = $("st-rf-ladder");
      if (ladder) ladder.innerHTML = rfLadderHtml(rfLive);
    }

    const dgLive = S.snap?.strategy?.danger_guard || {};
    paintSwitch($("st-danger"), dgLive.enabled);
    const dgSwLive = $("st-danger");
    if (dgSwLive) dgSwLive.disabled = propOn;
    const dgSensLive = $("st-danger-sens");
    if (dgSensLive) dgSensLive.disabled = propOn;
    const dgSub = $("st-danger-sub");
    if (dgSub) dgSub.textContent = I18N.t(propOn ? "strategies.danger_prop_note" : "strategies.danger_help");
    const lk = $("pr-lock");
    const uk = $("pr-unlock");
    if (lk) lk.disabled = !propOn;
    if (uk) uk.disabled = !propOn;
  }
  if (v === "charts" || v === "markets") { applyChartLevels(); paintTicketPrices(); }
  if ((v === "execution" || (v === "terminal" && S.termTab === "robot")) && $("robot-term")) {
    const box = $("robot-term");
    if (box && document.activeElement !== $("log-q")) box.innerHTML = renderRobotLogs($("log-q")?.value || "");
  }
  if (v === "terminal" && S.termTab === "robot") {
    const term = $("term");
    if (term && document.activeElement !== $("log-q")) term.innerHTML = renderRobotLogs($("log-q")?.value || "");
  }
  if (v === "strategies" || v === "settings" || v === "command" || v === "execution") {
    patchStrategyLive();
  }
}

/* A strategy card says "enabled" twice: with the switch at the top and with
   the state pill under it. They had drifted apart - the live patcher rewrote
   the pill's words and left its colour alone, so a strategy that had just
   been turned off still read "Disabled" in the green of an enabled one until
   something rebuilt the tab. Both markers are painted here, from one value,
   so they cannot disagree again. */
function paintStrategyEnabled(name, enabled) {
  const on = Boolean(enabled);
  const pill = document.querySelector('[data-st-on="' + name + '"]');
  if (pill) {
    pill.textContent = I18N.t(on ? "strategies.enable" : "strategies.disable");
    pill.classList.toggle("on", on);
  }
  const sw = document.querySelector('button.switch[data-st="' + name + '"]');
  if (sw) {
    sw.classList.toggle("on", on);
    // The pressed state is how a screen reader hears this switch at all.
    sw.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const card = document.querySelector('[data-st-card="' + name + '"]');
  if (card) card.classList.toggle("is-off", !on);
}

function patchStrategyLive() {
  const st = S.snap?.strategy || {};
  // A strategy was added/removed (upload, delete, first toggle): the static
  // patcher cannot create or drop cards, so rebuild the current view once.
  const grid = $("st-live-grid");
  if (grid) {
    const have = grid.querySelectorAll("[data-st-card]").length;
    const want = (st.items || []).length;
    if (want && have !== want) {
      show(S.view, { animate: false, closeMenu: false, nav: false });
      return;
    }
  }
  strategyItems().forEach((it) => {
    const act = $("[data-st-act=\"" + it.name + "\"]") || document.querySelector('[data-st-act="' + it.name + '"]');
    const ev = document.querySelector('[data-st-eval="' + it.name + '"]');
    const on = document.querySelector('[data-st-on="' + it.name + '"]');
    const sw = document.querySelector('button.switch[data-st="' + it.name + '"]');
    const wr = document.querySelector('[data-st-wr="' + it.name + '"]');
    const net = document.querySelector('[data-st-net="' + it.name + '"]');
    const n = document.querySelector('[data-st-n="' + it.name + '"]');
    const wl = document.querySelector('[data-st-wl="' + it.name + '"]');
    const pf = document.querySelector('[data-st-pf="' + it.name + '"]');
    const avg = document.querySelector('[data-st-avg="' + it.name + '"]');
    const state = stState(it);
    const dot = document.querySelector('[data-st-dot="' + it.name + '"]');
    if (act) {
      act.textContent = state.act || "idle";
      act.className = "mono " + stActClass(state.act);
    }
    if (dot) dot.classList.toggle("is-live", !!state.live);
    if (ev && state.why) {
      ev.textContent = state.why;
      // Hovering the line gives the running tally, so a desk that has been
      // quiet all session can be read at a glance: one rule doing all the
      // refusing is a setting to change, a spread of rules is just a slow market.
      const tally = refusalTally(it);
      if (tally) ev.setAttribute("title", tally); else ev.removeAttribute("title");
    }
    if (on || sw) paintStrategyEnabled(it.name, it.enabled);
    if (wr) wr.textContent = fmt(it.win_rate || 0, 1) + "%";
    if (net) {
      net.textContent = fmt(it.net || 0);
      net.className = "mono " + clsPnl(it.net);
    }
    if (n) n.textContent = String(it.trades || 0);
    // The second stats row was never patched at all, so the record, the
    // profit factor and the average sat at whatever they were when the tab
    // was last built.
    if (wl) wl.innerHTML = String(it.wins || 0) + '<i class="sep">/</i>' + String(it.losses || 0);
    if (pf) pf.textContent = it.profit_factor === null || it.profit_factor === undefined
      ? "—" : fmt(it.profit_factor, 2);
    if (avg) {
      avg.textContent = fmt(it.avg || 0);
      avg.className = "mono " + clsPnl(it.avg);
    }
  });
  const sig = S.snap?.last_signal;
  const pill = $("st-live-sig");
  if (pill && sig) pill.textContent = `${sig.action || "—"} ${sig.symbol || ""}`;
  const liveSig = $("live-signal");
  if (liveSig && sig) {
    const b = liveSig.querySelector("b");
    if (b) b.textContent = `${sig.action || "—"} ${sig.symbol || ""}`;
  }
}

function syncLive() {
  if ($("desk")?.classList.contains("hidden")) return;
  headerState();
  if (typing()) return;
  const mode = viewMode();
  if (S.mountedView === S.view && S.viewMode && S.viewMode !== mode && ["command", "charts", "markets", "execution"].includes(S.view)) {
    show(S.view, { animate: false, closeMenu: false, nav: false });
    return;
  }
  patchLive();
}

function scheduleSync() {
  if (S._syncTimer) return;
  S._syncTimer = setTimeout(() => {
    S._syncTimer = null;
    syncLive();
  }, 200);
}

function tapeMode() {
  const snap = S.snap || {};
  if (snap.tape) return String(snap.tape);
  if ((snap.backtest || {}).running) return "backtest";
  if (testerAgents().length && !liveAgents().length) return "tester";
  if (eaLive()) return "live";
  return "idle";
}
function headerState() {
  const eng = $("st-engine");
  const mtEl = $("st-mt5");
  if (!eng || !mtEl) return;
  const engLive = Boolean(S.snap);
  const mtLive = mt5Live();
  const acc = S.snap?.mt5?.account || {};
  const killed = Boolean(S.snap?.kill_switch);
  const eq = mtLive ? fmt(acc.equity) : "";
  const tape = tapeMode();
  const key = (engLive ? "1" : "0") + (mtLive ? "1" : "0") + eq + (killed ? "1" : "0") + I18N.lang + (acc.currency || "") + tape + String((S.backtest || {}).running || "") + String(Boolean(S.snap?.strategy?.auto_trade)) + String(acc.balance || "") + String(acc.profit || "");
  if (S._hdrKey === key) return;
  S._hdrKey = key;
  eng.dataset.state = engLive ? "live" : "down";
  eng.textContent = I18N.t(engLive ? "status.engine_live" : "status.engine_down");
  mtEl.dataset.state = mtLive ? "live" : "down";
  mtEl.textContent = I18N.t(mtLive ? "status.mt5_live" : "status.mt5_down");
  const tapeEl = $("st-tape");
  if (tapeEl) {
    const runningBt = Boolean((S.backtest || S.snap?.backtest || {}).running);
    const mode = runningBt ? "backtest" : tape;
    tapeEl.dataset.state = mode;
    tapeEl.textContent = I18N.t(mode === "tester" || mode === "backtest" ? "tape.backtest" : (mode === "live" ? "tape.live" : "tape.idle"));
  }
  // AI chip removed from header per user request — no st-ai here
  const eqEl = $("st-eq");
  if (eqEl) {
    eqEl.textContent = mtLive ? `${fmt(acc.equity)} ${acc.currency || ""}`.trim() : "";
    eqEl.hidden = !mtLive;
  }
  const kill = $("btn-kill");
  if (kill) {
    kill.textContent = I18N.t(killed ? "exec.unkill" : "exec.kill");
    kill.classList.toggle("kills", killed);
  }
  const langBtn = $("btn-lang");
  if (langBtn) langBtn.textContent = I18N.lang.toUpperCase();
  paintHdrDrawer();
}

// Mobile pull-down drawer: statuses + equity that the narrow header hides.
// AI chip removed per user request — only engine/mt5/tape/auto/kill remain.
function hdrDrawerHtml() {
  const snap = S.snap || {};
  const acc = snap.mt5?.account || {};
  const mtLive = mt5Live();
  const engLive = Boolean(S.snap);
  const tape = tapeMode();
  const runningBt = Boolean((S.backtest || snap.backtest || {}).running);
  const tapeModeNow = runningBt ? "backtest" : tape;
  const killed = Boolean(snap.kill_switch);
  const auto = Boolean(snap.strategy?.auto_trade);
  const chip = (state, label) => `<span class="st-chip" data-state="${state}">${esc(label)}</span>`;
  const chips = [
    chip(engLive ? "live" : "down", I18N.t(engLive ? "status.engine_live" : "status.engine_down")),
    chip(mtLive ? "live" : "down", I18N.t(mtLive ? "status.mt5_live" : "status.mt5_down")),
    chip(tapeModeNow, I18N.t(tapeModeNow === "tester" || tapeModeNow === "backtest" ? "tape.backtest" : (tapeModeNow === "live" ? "tape.live" : "tape.idle"))),
    chip(auto ? "live" : "down", I18N.t(auto ? "exec.auto_on" : "exec.auto_off")),
    chip(killed ? "down" : "live", I18N.t(killed ? "exec.unkill" : "exec.kill")),
  ];
  const kpi = (label, value) => `<div class="hdr-kpi"><span>${esc(label)}</span><b class="mono">${esc(value)}</b></div>`;
  const cur = acc.currency || "";
  const kpis = mtLive
    ? kpi(I18N.t("command.equity"), `${fmt(acc.equity)} ${cur}`.trim())
      + kpi(I18N.t("command.balance"), `${fmt(acc.balance)} ${cur}`.trim())
      + kpi(I18N.t("command.profit"), `${fmt(acc.profit)} ${cur}`.trim())
    : `<p class="sub" style="margin:0">${I18N.t("errors.no_mt5")}</p>`;
  return `<div class="hdr-chips">${chips.join("")}</div><div class="hdr-kpis">${kpis}</div>`;
}
function paintHdrDrawer() {
  const dr = $("hdr-drawer");
  if (dr && !dr.hidden) dr.innerHTML = hdrDrawerHtml();
}
function toggleHdrDrawer(force) {
  const dr = $("hdr-drawer");
  const btn = $("btn-hdr-drawer");
  if (!dr || !btn) return;
  const open = typeof force === "boolean" ? force : dr.hidden;
  dr.hidden = !open;
  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    dr.innerHTML = hdrDrawerHtml();
    // A drawer that reopens where it was last scrolled looks broken on a phone:
    // you tap the menu and land in the middle of a list you have never seen.
    dr.scrollTop = 0;
  }
}

function accTypeLabel(kind) {
  const key = "account." + kind;
  const tr = I18N.t(key);
  return tr === key ? kind : tr;
}

function stAbout(name) {
  const about = {
    ema_rsi: "strategies.ema_rsi_about",
    price_action: "strategies.price_action_about",
    atr_breakout: "strategies.atr_breakout_about",
  };
  return I18N.t(about[name] || "strategies.active");
}

function strategyStatsOf(name) {
  const key = String(name || "");
  const ledger = (S.snap && S.snap.strategy && S.snap.strategy.stats) || {};
  if (key && ledger[key]) return ledger[key];
  const it = strategyItems().find((x) => x.name === key);
  if (it) return { win_rate: it.win_rate, net: it.net, trades: it.trades };
  return { win_rate: 0, net: 0, trades: 0 };
}
function strategyLabel(name) {
  const key = String(name || "").trim();
  if (!key || key === "desk" || key === "manual") return I18N.t("strategies.none");
  if (key.startsWith("@")) return key.slice(1);
  return key;
}
function operatorName() {
  const u = S.user || {};
  return String(u.display_name || u.username || "AURION").trim() || "AURION";
}
function preferredStrategy() {
  if (S.ticket && S.ticket.strategy) return S.ticket.strategy;
  const picked = String($("ct-st")?.value || "").trim();
  if (picked) return picked;
  const on = strategyItems().filter((it) => it.enabled);
  if (on.length) return on[0].name;
  return "";
}
/**
 * The manual ticket, on the chart and in the EA chart's Trade panel.
 *
 * The old layout was a row of three identical number fields followed by
 * six ghost buttons of equal weight - set SL, set TP, clear SL, clear TP,
 * buy, sell - all the same size and colour. The two that send money
 * looked exactly like the four that do not, the pair of clear buttons
 * took as much room as the order itself, and on a phone the whole lot
 * wrapped into a block of near-identical pills.
 *
 * It is laid out by job now. Volume has steppers, because the lot is
 * nudged far more often than it is typed. Stop and target own a row each
 * with their two verbs - take it from the chart, clear it - as small
 * icon buttons rather than full-width text. Buy and sell are one pair at
 * the bottom, sized for a thumb, each showing the side of the spread it
 * would actually cross, so the price you are hitting is on the button you
 * press rather than somewhere else on the screen.
 *
 * Every id the existing wiring binds to is kept, so this is a change of
 * layout and not of behaviour.
 */
function chartTicketHtml() {
  const t = S.ticket || S.manual || {};
  const who = operatorName();
  const sym = (S.chartFocus && S.chartFocus.symbol) || S.symbol;
  const tick = (S.snap && S.snap.ticks && S.snap.ticks[sym]) || {};
  return `<div class="chart-ticket" id="chart-ticket">
      <div class="ct-head">
        <h3>${I18N.t("exec.manual")}</h3>
        <p class="sub">${I18N.t("exec.chart_hint")} · ${esc(who)}</p>
      </div>

      <div class="ct-row ct-vol">
        <span class="ct-lab">${I18N.t("exec.volume")}</span>
        <div class="ct-step">
          <button type="button" class="ct-pm" data-vol="-1" aria-label="-">${icon("minus")}</button>
          <input id="ct-vol" type="number" step="0.01" min="0.01" inputmode="decimal"
                 value="${esc(String(t.vol || ticketLot()))}" />
          <button type="button" class="ct-pm" data-vol="1" aria-label="+">${icon("plus")}</button>
        </div>
      </div>

      <div class="ct-levels">
        <div class="ct-row ct-lv">
          <span class="ct-lab sl">${I18N.t("exec.sl")}</span>
          <input id="ct-sl" type="number" step="0.0001" inputmode="decimal"
                 value="${esc(t.sl || "")}" placeholder="${esc(I18N.t("exec.chart_click"))}" />
          <button type="button" class="ct-ic" id="ct-pick-sl"
                  title="${esc(I18N.t("exec.set_sl"))}" aria-label="${esc(I18N.t("exec.set_sl"))}">${icon("target")}</button>
          <button type="button" class="ct-ic" id="ct-clear-sl"
                  title="${esc(I18N.t("exec.clear_sl"))}" aria-label="${esc(I18N.t("exec.clear_sl"))}">${icon("close")}</button>
        </div>
        <div class="ct-row ct-lv">
          <span class="ct-lab tp">${I18N.t("exec.tp")}</span>
          <input id="ct-tp" type="number" step="0.0001" inputmode="decimal"
                 value="${esc(t.tp || "")}" placeholder="${esc(I18N.t("exec.chart_click"))}" />
          <button type="button" class="ct-ic" id="ct-pick-tp"
                  title="${esc(I18N.t("exec.set_tp"))}" aria-label="${esc(I18N.t("exec.set_tp"))}">${icon("target")}</button>
          <button type="button" class="ct-ic" id="ct-clear-tp"
                  title="${esc(I18N.t("exec.clear_tp"))}" aria-label="${esc(I18N.t("exec.clear_tp"))}">${icon("close")}</button>
        </div>
      </div>

      <div class="ct-sides">
        <button class="ct-side sell" type="button" id="ct-sell">
          <span>${I18N.t("exec.sell")}</span>
          <b class="mono" id="ct-bid">${fmt(tick.bid, 5)}</b>
        </button>
        <button class="ct-side buy" type="button" id="ct-buy">
          <span>${I18N.t("exec.buy")}</span>
          <b class="mono" id="ct-ask">${fmt(tick.ask, 5)}</b>
        </button>
      </div>
      <p class="sub" id="ct-msg"></p>
    </div>`;
}

/**
 * Keep the two prices on the buy and sell buttons live.
 *
 * They are on the buttons so the trader can see what they are about to
 * cross without looking away, which only holds if they keep up with the
 * feed rather than freezing at whatever the price was when the panel was
 * built.
 */
function paintTicketPrices() {
  const sym = (S.chartFocus && S.chartFocus.symbol) || S.symbol;
  const tick = (S.snap && S.snap.ticks && S.snap.ticks[sym]) || null;
  const bid = $("ct-bid"), ask = $("ct-ask");
  if (bid) bid.textContent = tick ? fmt(tick.bid, 5) : "—";
  if (ask) ask.textContent = tick ? fmt(tick.ask, 5) : "—";
}

/**
 * The lot size, from the one place that owns it.
 *
 * There used to be two: Settings persisted `manual_volume` on the
 * engine, while the manual ticket and the EA chart each started from a
 * hard-coded 0.10 and remembered their own value in the page. Changing
 * the lot in Settings left the ticket on its old number, so "my lot is
 * 0.01" and "the ticket says 0.10" were both true at once.
 */
function deskLot() {
  const st = (S.snap && S.snap.strategy) || {};
  const v = Number(st.manual_volume);
  return v > 0 ? v : 0.10;
}

/** Lot the ticket should show: what the user last typed, else the setting. */
function ticketLot() {
  const typed = Number((S.ticket || {}).vol);
  return typed > 0 ? typed : deskLot();
}

/**
 * Push a lot change back to the engine so every panel agrees.
 *
 * Called from the ticket and the EA chart, which previously could only
 * change their own copy. Quiet and debounced: this fires on every edit
 * of a number field.
 */
let _lotSaveTimer = null;
function persistLot(value) {
  const v = Number(value);
  if (!(v > 0)) return;
  if (Math.abs(v - deskLot()) < 1e-9) return;
  clearTimeout(_lotSaveTimer);
  _lotSaveTimer = setTimeout(async () => {
    const r = await API.post("/api/auto", { manual_volume: v });
    if (r && r.ok) {
      // Keep the local snapshot honest straight away, so a re-render
      // before the next poll does not flash the old number back.
      if (S.snap && S.snap.strategy) S.snap.strategy.manual_volume = v;
      paintLotEverywhere(v);
    }
  }, 350);
}

/** Mirror one lot value into every lot input on the page. */
function paintLotEverywhere(v) {
  ["ct-vol", "st-vol"].forEach((id) => {
    const el = $(id);
    if (el && document.activeElement !== el && Number(el.value) !== Number(v)) {
      el.value = String(v);
    }
  });
}

/**
 * The protection ladder, written as targets rather than as a number.
 *
 * This panel used to show "0.20" - a percentage of the entry price -
 * which says nothing about when the stop actually moves. The rungs are
 * evenly spaced on the way to the trade's own target, so they can be
 * named: reaching TP1 locks the entry, TP2 locks TP1, and so on. Same
 * arithmetic as runtime/stops.py, just said out loud.
 */
function rfLadderHtml(rf) {
  const rungs = (rf && rf.rungs) || [];
  if (!rungs.length) return "";
  return rungs.map((r) => {
    const to = r.moves_to === "entry"
      ? I18N.t("strategies.rf_to_entry")
      : String(r.moves_to || "").toUpperCase();
    return `<div class="rf-rung">
      <b class="rf-rung-tag">${esc(String(r.label || "").toUpperCase())}</b>
      <span class="rf-rung-arrow" aria-hidden="true">&rarr;</span>
      <span class="rf-rung-to">${esc(to)}</span>
      <span class="sub rf-rung-at">${I18N.t("strategies.rf_rung_at", { pct: Math.round((r.fraction || 0) * 100) })}</span>
    </div>`;
  }).join("");
}

function rememberTicket() {
  S.ticket = {
    strategy: "@" + operatorName(),
    vol: String($("ct-vol")?.value || deskLot()),
    sl: String($("ct-sl")?.value || ""),
    tp: String($("ct-tp")?.value || ""),
  };
  S.manual = { ...(S.manual || {}), vol: S.ticket.vol, sl: S.ticket.sl, tp: S.ticket.tp };
}
function syncChartPending() {
  if (!S.chart || typeof S.chart.setPending !== "function") return;
  const sl = Number($("ct-sl")?.value || S.ticket?.sl || 0);
  const tp = Number($("ct-tp")?.value || S.ticket?.tp || 0);
  S.chart.setPending({ sl, tp });
}
function onChartPrice(p) {
  if (!Number.isFinite(Number(p))) return;
  if (!S._pickLevel) return;
  const px = Number(p);
  if (S._pickLevel === "sl" && $("ct-sl")) $("ct-sl").value = String(px);
  else if (S._pickLevel === "tp" && $("ct-tp")) $("ct-tp").value = String(px);
  S._pickLevel = null;
  document.querySelectorAll("#ct-pick-sl,#ct-pick-tp").forEach((b) => b.classList.remove("on"));
  rememberTicket();
  syncChartPending();
}
function onChartPending(p) {
  if (!p) return;
  if (p.kind === "sl" && $("ct-sl")) $("ct-sl").value = String(p.sl || "");
  if (p.kind === "tp" && $("ct-tp")) $("ct-tp").value = String(p.tp || "");
  rememberTicket();
}
async function sendDeskOrder(opts) {
  opts = opts || {};
  if (S._orderBusy) return { ok: false, error: "busy" };
  const symbol = String(opts.symbol || S.symbol || defaultSymbol() || "").trim();
  const allowed = liveSymbols().map((x) => x.symbol);
  const volume = Number(opts.volume || 0);
  const sl = Number(opts.sl || 0);
  const tp = Number(opts.tp || 0);
  const strategy = "@" + operatorName();
  const msg = opts.msgEl;
  if (!mt5Live()) {
    const err = I18N.t("errors.no_mt5");
    if (msg) msg.textContent = err;
    toast(err);
    return { ok: false, error: err };
  }
  if (!symbol || (allowed.length && !allowed.includes(symbol))) {
    const err = I18N.t(allowed.length ? "exec.need_symbol" : "exec.no_ea_symbol");
    if (msg) msg.textContent = err;
    toast(err);
    return { ok: false, error: err };
  }
  if (!(volume > 0)) {
    const err = I18N.t("exec.need_volume");
    if (msg) msg.textContent = err;
    toast(err);
    return { ok: false, error: err };
  }
  const body = { action: opts.side, side: opts.side, source: "desk", symbol, volume, strategy };
  if (strategy) body.comment = "AURION " + strategy;
  if (sl) body.sl = sl;
  if (tp) body.tp = tp;
  S._orderBusy = true;
  if (msg) msg.textContent = I18N.t("exec.sending");
  try {
    const r = await API.post("/api/order", body);
    const detail = r.error || r.detail || r.message || "";
    const text = r.ok
      ? (I18N.t("logs.order_sent") + (detail ? " — " + detail : ""))
      : (detail || I18N.t("logs.order_fail"));
    if (msg) msg.textContent = text;
    toast(text);
    pushRobotLocal(r.ok ? "info" : "error", text);
    await refresh(false);
    return r;
  } catch (err) {
    const text = err && err.message ? err.message : I18N.t("errors.generic");
    if (msg) msg.textContent = text;
    toast(text);
    return { ok: false, error: text };
  } finally {
    S._orderBusy = false;
  }
}
function bindChartTicket() {
  const host = $("chart-ticket");
  if (!host) return;
  paintTicketPrices();
  /* Steppers move the lot by one step of the input, so the control and the
     keyboard agree on what "one more" means. */
  host.querySelectorAll("[data-vol]").forEach((b) => {
    b.onclick = () => {
      const el = $("ct-vol");
      if (!el) return;
      const step = Number(el.step) || 0.01;
      const dir = Number(b.getAttribute("data-vol")) || 0;
      const next = Math.max(step, Math.round(((Number(el.value) || 0) + dir * step) / step) * step);
      el.value = String(Number(next.toFixed(6)));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
  });
  ["ct-vol", "ct-sl", "ct-tp"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const touched = () => {
      rememberTicket();
      syncChartPending();
      // A lot typed here is the lot everywhere, not just on this ticket.
      if (id === "ct-vol") persistLot(el.value);
    };
    el.addEventListener("change", touched);
    el.addEventListener("input", touched);
  });
  const arm = (kind) => {
    S._pickLevel = kind;
    if (S.chart) S.chart.pickPrice = true;
    const sl = $("ct-pick-sl");
    const tp = $("ct-pick-tp");
    if (sl) sl.classList.toggle("on", kind === "sl");
    if (tp) tp.classList.toggle("on", kind === "tp");
    toast(I18N.t(kind === "sl" ? "exec.pick_sl" : "exec.pick_tp"));
  };
  const psl = $("ct-pick-sl"); if (psl) psl.onclick = () => arm("sl");
  const ptp = $("ct-pick-tp"); if (ptp) ptp.onclick = () => arm("tp");
  const wipe = (kind) => {
    if (kind === "sl" && $("ct-sl")) $("ct-sl").value = "";
    if (kind === "tp" && $("ct-tp")) $("ct-tp").value = "";
    rememberTicket();
    syncChartPending();
  };
  const csl = $("ct-clear-sl"); if (csl) csl.onclick = () => wipe("sl");
  const ctp = $("ct-clear-tp"); if (ctp) ctp.onclick = () => wipe("tp");
  const fire = (side) => {
    rememberTicket();
    return sendDeskOrder({
      side,
      symbol: (S.chartFocus && S.chartFocus.symbol) || S.symbol,
      volume: Number($("ct-vol")?.value || 0),
      sl: Number($("ct-sl")?.value || 0),
      tp: Number($("ct-tp")?.value || 0),
      msgEl: $("ct-msg"),
    });
  };
  const buy = $("ct-buy"); if (buy) buy.onclick = () => fire("buy");
  const sell = $("ct-sell"); if (sell) sell.onclick = () => fire("sell");
  syncChartPending();
}
function stState(it) {
  // What the card should say *now*.
  //
  // The card used to show last_action, which only moves when a candle
  // closes and an order is attempted — so a working robot looked asleep
  // for fourteen minutes out of every fifteen, and "hold" was shown both
  // for "the strategy sees nothing" and for "the desk refused it".
  // The engine's watch pass fills live_action every couple of seconds;
  // a real decision (an order, or a refusal) outranks it for a minute,
  // because that is the thing the trader needs to read.
  const liveAt = Date.parse(it.live_ts || "") || 0;
  const lastAt = Date.parse(it.last_ts || "") || 0;
  const fresh = lastAt && Date.now() - lastAt < 60000 && lastAt + 1000 >= liveAt;
  if (fresh && it.last_action) {
    return { act: it.last_action, why: it.last_reason || "", live: false };
  }
  if (it.live_action) {
    return { act: it.live_action, why: it.live_reason || "", live: true };
  }
  return { act: it.last_action || "idle", why: it.last_reason || "", live: false };
}

function stActClass(act) {
  return act === "buy" ? "up" : act === "sell" ? "down" : act === "blocked" ? "warn" : "";
}

function strategyItems() {
  const st = S.snap?.strategy || {};
  const items = st.items && st.items.length ? st.items : [
    {name:"ema_rsi", enabled:false, last_action:"idle"},
    {name:"price_action", enabled:false, last_action:"idle"},
    {name:"atr_breakout", enabled:false, last_action:"idle"},
  ];
  return items;
}

function strategyUploadCard() {
  if (!licFeat("strategy_upload")) return lockedUpgradeCard("strategy_upload");
  return `<div class="card st-upload" id="st-upload">
      <div class="st-up-hero">
        <div>
          <h3>${I18N.t("strategies.upload")}</h3>
          <p class="sub">${I18N.t("strategies.file_hint")}</p>
        </div>
        <a class="btn tiny ghost" id="st-tpl" href="#">${I18N.t("strategies.template")}</a>
      </div>
      <label class="st-drop" id="st-drop" for="st-file-pick" tabindex="0" role="button"
             aria-label="${I18N.t("strategies.drop")}">
        <input type="file" id="st-file-pick" accept=".py,.txt" hidden />
        <span class="st-drop-ico" aria-hidden="true"></span>
        <b>${I18N.t("strategies.drop")}</b>
        <small>${I18N.t("strategies.browse")}</small>
        <small class="st-drop-name mono" id="st-drop-name"></small>
      </label>
      <input class="ctrl" id="st-file" placeholder="my_strategy.py" />
      <textarea id="st-src" class="ctrl st-src" placeholder="# Python strategy"></textarea>
      <div class="row" style="margin-top:10px;align-items:center;gap:8px">
        <button class="btn" id="st-up" type="button">${I18N.t("strategies.upload")}</button>
        <a class="btn tiny ghost" id="st-cancel" href="#" hidden>${I18N.t("strategies.cancel")}</a>
      </div>
      <p class="sub" id="st-up-msg"></p>
    </div>`;
}
function strategyLiveCards() {
  return strategyItems().map((it) => {
    const state = stState(it);
    const act = state.act || "idle";
    const cls = stActClass(act);
    const custom = (it.kind || "builtin") !== "builtin";
    return `<div class="card st-card${it.enabled ? "" : " is-off"}" data-st-card="${esc(it.name)}">
      <div class="st-top">
        <div>
          <h3 style="margin:0">${esc(it.name)}</h3>
          <p class="sub">${custom ? I18N.t("strategies.custom_about") : stAbout(it.name)}</p>
        </div>
        <button type="button" class="switch ${it.enabled?"on":""}" data-st="${esc(it.name)}" aria-pressed="${it.enabled}"><i></i></button>
      </div>
      <div class="st-live">
        <span class="pill ${it.enabled?"on":""}" data-st-on="${esc(it.name)}">${it.enabled ? I18N.t("strategies.enable") : I18N.t("strategies.disable")}</span>
        <b class="mono ${cls}" data-st-act="${esc(it.name)}">${esc(act)}</b>
        <i class="st-dot${state.live ? " is-live" : ""}" data-st-dot="${esc(it.name)}"
           title="${I18N.t("strategies.live_hint")}"></i>
        <span class="pill ghost">${I18N.t(custom ? "strategies.custom" : "strategies.builtin_tag")}</span>
      </div>
      <div class="st-stats">
        <div><span>${I18N.t("strategies.winrate")}</span><b class="mono" data-st-wr="${esc(it.name)}">${fmt(it.win_rate || 0, 1)}%</b></div>
        <div><span>${I18N.t("strategies.net")}</span><b class="mono ${clsPnl(it.net)}" data-st-net="${esc(it.name)}">${fmt(it.net || 0)}</b></div>
        <div><span>${I18N.t("strategies.trades")}</span><b class="mono" data-st-n="${esc(it.name)}">${it.trades || 0}</b></div>
      </div>
      <div class="st-stats st-stats-2">
        <div><span>${I18N.t("strategies.record")}</span>
          <b class="mono" data-st-wl="${esc(it.name)}">${it.wins || 0}<i class="sep">/</i>${it.losses || 0}</b></div>
        <div><span>${I18N.t("strategies.pf")}</span>
          <b class="mono" data-st-pf="${esc(it.name)}">${it.profit_factor === null || it.profit_factor === undefined ? "—" : fmt(it.profit_factor, 2)}</b></div>
        <div><span>${I18N.t("strategies.avg")}</span>
          <b class="mono ${clsPnl(it.avg)}" data-st-avg="${esc(it.name)}">${fmt(it.avg || 0)}</b></div>
      </div>
      <p class="sub" data-st-eval="${esc(it.name)}" title="${esc(refusalTally(it))}">${esc(state.why) || I18N.t("strategies.waiting")}</p>
      ${custom ? `<div class="row st-mng">
        <button type="button" class="btn tiny ghost" data-st-edit="${esc(it.name)}">${I18N.t("strategies.edit")}</button>
        <button type="button" class="btn tiny ghost st-del" data-st-del="${esc(it.name)}">${I18N.t("strategies.delete")}</button>
      </div>` : ""}
    </div>`;
  }).join("");
}

function refusalTally(it) {
  const rows = Array.isArray(it && it.refusals) ? it.refusals : [];
  if (!rows.length) return "";
  return rows.map(r => `${r.reason} × ${r.count}`).join("\n");
}

function strategyEditorEls() {
  return { file: $("st-file"), src: $("st-src"), up: $("st-up"), cancel: $("st-cancel"), msg: $("st-up-msg") };
}

function setStrategyEditMode(name, source, file) {
  S._stEdit = name || null;
  S._stEditSrc = name ? (typeof source === "string" ? source : $("st-src")?.value || "") : "";
  S._stEditFile = name ? (file || name + ".py") : "";
  restoreStrategyEditor(true);
}

function restoreStrategyEditor(refill) {
  const els = strategyEditorEls();
  if (!els.up) return;
  const name = S._stEdit;
  els.up.textContent = I18N.t(name ? "strategies.save_changes" : "strategies.upload");
  if (els.cancel) els.cancel.hidden = !name;
  if (els.file) {
    els.file.value = name ? (S._stEditFile || name + ".py") : "";
    els.file.disabled = Boolean(name);
  }
  if (els.src) {
    if (name && (refill || !els.src.value)) els.src.value = S._stEditSrc || "";
    if (!name) els.src.value = "";
  }
  if (els.msg) els.msg.textContent = name ? `${I18N.t("strategies.editing")}: ${name}` : "";
}

async function startStrategyEdit(name) {
  const r = await API.get("/api/strategies/source?name=" + encodeURIComponent(name));
  if (!r.ok) { toast(r.error || I18N.t("errors.generic")); return; }
  if (S.view !== "strategies") await show("strategies", { animate: false, closeMenu: false });
  setStrategyEditMode(r.name, r.source, r.file);
  $("st-src")?.focus();
  $("st-upload")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function deleteCustomStrategy(name) {
  const q = I18N.t("strategies.confirm_delete").replace("%s", name);
  if (!window.confirm(q)) return;
  const r = await API.post("/api/strategies/delete", { name });
  toast(r.ok ? I18N.t("strategies.deleted") : (r.error || I18N.t("errors.generic")));
  if (!r.ok) return;
  if (r.strategy) { S.snap = S.snap || {}; S.snap.strategy = r.strategy; }
  if (S._stEdit === name) S._stEdit = null;
  await refresh(false);
  show(S.view, { animate: false, closeMenu: false, nav: false });
}

async function strategyUploadOrSave() {
  const els = strategyEditorEls();
  const editing = S._stEdit;
  const msg = els.msg;
  const r = editing
    ? await API.post("/api/strategies/update", { name: editing, source: els.src?.value || "" })
    : await API.post("/api/strategies/upload", {
        filename: els.file?.value || "custom.py",
        source: els.src?.value || "",
        activate: true,
      });
  const text = r.ok
    ? I18N.t(editing ? "strategies.updated" : "strategies.loaded")
    : (r.error === "premium_required" ? I18N.t("lic.err_locked") : (r.error || I18N.t("strategies.invalid")));
  if (msg) msg.textContent = text;
  if (!licGateToast(r)) toast(text);
  if (r.ok && r.strategy) { S.snap = S.snap || {}; S.snap.strategy = r.strategy; }
  if (r.ok && editing) setStrategyEditMode(null);
  await refresh(false);
  if (S.view === "strategies" || S.view === "settings") show(S.view, { animate: false, closeMenu: false, nav: false });
}

function roleLabel(role) {
  const key = "users." + String(role || "");
  const tr = I18N.t(key);
  return tr === key ? role : tr;
}
function usersCardHtml() {
  const rows = S.users || [];
  const logs = S.access || [];
  const body = rows.length
    ? `<div class="table-wrap"><table><thead><tr>
        <th>${I18N.t("auth.user")}</th><th>${I18N.t("users.role")}</th><th></th>
      </tr></thead><tbody>${rows.map((u) => `<tr>
        <td>${esc(u.username)}${u.is_owner ? " · " + I18N.t("users.owner") : ""}</td>
        <td>${esc(roleLabel(u.role))}${u.disabled ? " · off" : ""}</td>
        <td>${u.is_owner || u.id === (S.user && S.user.id) ? "" : `<button type="button" class="btn tiny ghost" data-user-toggle="${esc(u.id)}" data-off="${u.disabled ? "0" : "1"}">${I18N.t(u.disabled ? "users.enable" : "users.disable")}</button>`}</td>
      </tr>`).join("")}</tbody></table></div>`
    : `<p class="sub">${I18N.t("users.empty")}</p>`;
  const logHtml = logs.length
    ? `<div class="term" style="height:180px">${logs.map((l) => `<div class="l-info"><span class="ts">${esc(l.ts || "")}</span>${esc(l.action || "")} ${esc(l.username || "")} ${esc(l.detail || "")}</div>`).join("")}</div>`
    : "";
  return `<div class="card">
      <p class="sub">${I18N.t("users.hint")}</p>
      ${body}
      <h3 style="margin-top:16px">${I18N.t("users.add")}</h3>
      <div class="grid g-2">
        <label class="field"><span>${I18N.t("auth.user")}</span><input id="u-name" autocomplete="off" /></label>
        <label class="field"><span>${I18N.t("auth.pass")}</span><input id="u-pass" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>${I18N.t("users.role")}</span>
          <select class="ctrl" id="u-role">
            <option value="trader">${I18N.t("users.trader")}</option>
            <option value="admin">${I18N.t("users.admin")}</option>
            <option value="viewer">${I18N.t("users.viewer")}</option>
          </select>
        </label>
      </div>
      <button class="btn block" id="u-add" type="button">${I18N.t("users.add")}</button>
      <p class="sub" id="u-msg"></p>
      <h3 style="margin-top:16px">${I18N.t("users.access")}</h3>
      ${logHtml}
    </div>`;
}
function licenseCardHtml() {
  const L = (S.snap && S.snap.license) || {};
  const trial = L.trial !== false && !L.paid && !L.developer;
  const remain = L.bot_remaining;
  return `<div class="card${trial ? " lic-banner" : ""}">
      <div class="axiasoft-slot" style="margin:0 0 12px;max-width:none">
        <img src="assets/axiasoft-logo.png?v=desk45" alt="Axiasoft" class="axiasoft-logo" />
        <span>${I18N.t("auth.licensed_by")}</span>
      </div>
      <div class="kv">
        <span>${I18N.t("license.plan")}</span><b>${esc(L.plan_label || L.plan || I18N.t("license.trial"))}</b>
        <span>${I18N.t("license.expires")}</span><b class="mono">${esc(L.expires || "—")}</b>
        <span>${I18N.t("license.remaining")}</span><b class="mono">${remain == null ? "—" : remain}</b>
      </div>
      <p class="sub" id="lic-msg">${L.paid || L.developer ? I18N.t("license.ok") : I18N.t("license.need")}</p>
      <label class="field"><span>${I18N.t("license.key")}</span>
        <input id="lic-key" autocomplete="off" placeholder="AXIA-M1-...." />
      </label>
      <button class="btn block" id="lic-go" type="button">${I18N.t("license.activate")}</button>
      <button class="btn ghost block" id="lic-upd" type="button">${I18N.t("license.check_updates")}</button>
      <p class="sub" id="lic-upd-msg"></p>
    </div>`;
}

/**
 * How many trades at once, explained as the two different things it is.
 *
 * The two fields were labelled "open at least" and "open at most", which
 * reads as one range and is not what either of them does. The first is how
 * many tickets ONE signal opens at minimum - a burst, on a single setup.
 * The second is a ceiling on everything the robot holds at once, across
 * every symbol. A trader could be forgiven for setting 1 and 2 and
 * expecting "between one and two trades a day".
 *
 * The prop profile also lowers the ceiling when it is armed, and the desk
 * was showing the trader's own number rather than the rule actually being
 * enforced.
 */
/**
 * How many trades the robot opens.
 *
 * Two fields side by side read as one range - "between 1 and 4 trades" -
 * and neither of them means that. Naming them better was not enough, so
 * they are now two numbered steps that cannot be read as a pair, and the
 * second half of the card is a worked example computed with the engine's
 * own arithmetic: for the numbers currently in the boxes, how many trades
 * a weak, a decent and an excellent signal would actually open.
 */
function slotsHtml(st) {
  const min = st.min_open_trades ?? 1;
  const max = st.max_open_trades ?? 2;
  const cap = st.cap_effective ?? max;
  const open = st.open_trades ?? 0;
  const free = Math.max(0, cap - open);
  const perSymbol = st.cap_symbol ?? cap;
  const byProp = Boolean(st.cap_by_prop);

  return `<div class="slot-step">
      <span class="slot-num">1</span>
      <div class="slot-body">
        <label class="field">
          <span>${I18N.t("slots.min_label")}</span>
          <input id="st-min-trades" type="number" step="1" min="1" max="20" value="${min}" />
        </label>
        <p class="sub">${I18N.t("slots.min_hint")}</p>
      </div>
    </div>

    <div class="slot-step">
      <span class="slot-num">2</span>
      <div class="slot-body">
        <label class="field">
          <span>${I18N.t("slots.max_label")}</span>
          <input id="st-max-trades" type="number" step="1" min="1" max="20" value="${max}" />
        </label>
        <p class="sub">${I18N.t("slots.max_hint")}</p>
        <div class="slot-state">
          <div class="slot-dots" aria-hidden="true">
            ${Array.from({ length: Math.min(12, Math.max(cap, open)) }, (_, i) =>
              `<i class="${i < open ? "on" : ""}"></i>`).join("")}
          </div>
          <span id="st-slots-now">${I18N.t("slots.state", { n: open, cap, free })}</span>
        </div>
        ${byProp ? `<p class="sub lock-note">${I18N.t("slots.cap_prop", { cap })}</p>` : ""}
        ${perSymbol < cap ? `<p class="sub">${I18N.t("slots.cap_symbol", { n: perSymbol })}</p>` : ""}
      </div>
    </div>

    <div class="slot-demo" id="st-slots-demo">${slotsDemoHtml(min, cap)}</div>`;
}

/**
 * What those two numbers mean, in trades.
 *
 * The same arithmetic the engine uses in _entries_for_signal(), run on the
 * numbers in the boxes right now: a signal's quality score is mapped from
 * the minimum up to the ceiling, so the trader can see the whole behaviour
 * of the setting at a glance instead of inferring it from a sentence.
 */
function slotsTickets(min, cap, quality) {
  const low = Math.max(1, min);
  const high = Math.max(low, cap);
  if (high <= low) return low;
  const strength = Math.max(0, Math.min(1, (quality - 0.5) / 0.4));
  return low + Math.round((high - low) * strength);
}

function slotsDemoHtml(min, cap) {
  const rows = [
    [0.55, "slots.demo_weak"],
    [0.70, "slots.demo_fair"],
    [0.90, "slots.demo_best"],
  ];
  return `<b>${I18N.t("slots.demo_title")}</b>
    <div class="slot-demo-rows">
      ${rows.map(([q, key]) => {
        const n = slotsTickets(min, cap, q);
        return `<span>${I18N.t(key, { pct: Math.round(q * 100) })}</span>
          <b class="mono">${I18N.t("slots.demo_n", { n })}</b>`;
      }).join("")}
    </div>
    <p class="sub">${I18N.t("slots.demo_note", { cap })}</p>`;
}

/**
 * The setup-quality control, explained where it is used.
 *
 * It used to be a slider, a percentage and one sentence naming six things
 * the user had no way to weigh - which told them nothing about what moving
 * it would do. Three things are said instead: what the number decides, what
 * the number is made of, and what the last signal actually scored.
 */
/**
 * The last time a signal was produced and did NOT become an order.
 *
 * This is the answer to "why is the robot not trading". It used to exist
 * only as one line in the journal, under six different kinds, so the
 * honest answer took scrolling and a guess. The engine now keeps the last
 * refusal; this shows it where the setting that caused it lives.
 */
function blockHtml(st) {
  const b = st.last_block || {};
  if (!b.why) return "";
  const what = [b.side, b.symbol].filter(Boolean).join(" ").toUpperCase();
  return `<div class="q-block">
      <div class="q-last-head">
        <span>${I18N.t("slots.block_title")}</span>
        <b class="mono">${esc(b.code || "")}</b>
      </div>
      <p class="sub">${esc([b.strategy, what].filter(Boolean).join(" · "))}</p>
      <p>${esc(b.why)}</p>
    </div>`;
}

function qualityHtml(st) {
  const v = st.min_signal_quality ?? 0.55;
  const pct = Math.round(v * 100);
  const last = st.last_quality || {};
  const hasLast = Number.isFinite(Number(last.score));

  /* The weights are the engine's, not a description of them: see
     signal_quality() in engine/aurion/runtime/trader.py. */
  const parts = [
    ["slots.q_ai", "×1.2"],
    ["slots.q_htf", "×1.0"],
    ["slots.q_strategy", "×1.0"],
    ["slots.q_regime", "×0.5"],
    ["slots.q_chop", "×0.5"],
  ];

  return `<div class="field">
      <span class="conf-head">${I18N.t("slots.quality")}
        <b class="mono conf-pct" id="st-quality-pct">${pct}%</b></span>
      <input id="st-quality" type="range" step="0.01" min="0.20" max="0.90" value="${v}" />
      <div class="scale-legend"><span>${I18N.t("slots.q_loose")}</span><span>${I18N.t("slots.q_tight")}</span></div>
    </div>
    <p class="sub" id="st-quality-note">${I18N.t("slots.q_now_" + (pct >= 70 ? "tight" : pct >= 45 ? "mid" : "loose"))}</p>

    <div class="q-does">
      <b>${I18N.t("slots.q_does")}</b>
      <ol>
        <li>${I18N.t("slots.q_does_1", { pct })}</li>
        <li>${I18N.t("slots.q_does_2")}</li>
        <li>${I18N.t("slots.q_does_3")}</li>
      </ol>
    </div>

    ${blockHtml(st)}
    ${hasLast ? `<div class="q-last ${last.passed ? "ok" : "no"}">
      <div class="q-last-head">
        <span>${I18N.t("slots.q_last")}</span>
        <b class="mono">${Math.round(Number(last.score) * 100)}%</b>
        <span class="pill ${last.passed ? "ok" : "no"}">${I18N.t(last.passed ? "slots.q_taken" : "slots.q_skipped")}</span>
      </div>
      <p class="sub">${esc([last.side, last.symbol].filter(Boolean).join(" ").toUpperCase())}
        ${(last.reasons || []).length ? "· " + esc(last.reasons.join(" · ")) : ""}</p>
    </div>` : `<p class="sub q-last-none">${I18N.t("slots.q_none")}</p>`}

    <details class="q-how">
      <summary>${I18N.t("slots.q_how")}</summary>
      <p class="sub">${I18N.t("slots.q_how_hint")}</p>
      <div class="q-table">
        ${parts.map(([key, w]) => `<span>${I18N.t(key)}</span><b class="mono">${w}</b>`).join("")}
      </div>
    </details>`;
}

/* One switch on its own row: a heading, a line of explanation and the
   control, always in that order and always the same height. The robot page
   used to build this shape four different ways with inline styles. */
function switchRow(o) {
  return `<div class="set-switch">
      <div class="set-switch-txt">
        <h3>${o.title}</h3>
        ${o.sub ? `<p class="sub"${o.subId ? ` id="${o.subId}"` : ""}>${o.sub}</p>` : ""}
      </div>
      <button type="button" class="switch ${o.on ? "on" : ""}" id="${o.id}"
        ${o.disabled ? "disabled" : ""} aria-pressed="${Boolean(o.on)}"><i></i></button>
    </div>`;
}

/**
 * The robot page.
 *
 * It was eight cards of wildly different heights in a two-column grid, and
 * a CSS grid makes every row as tall as its tallest card - which is where
 * the empty space came from. The master switch now spans the page on its
 * own, and the rest flow in columns that break wherever they like, so a
 * short card no longer reserves the height of a tall one beside it.
 */
function robotPanelHtml() {
  const st = S.snap?.strategy || {};
  const style = st.trade_style || S.snap?.trade_style || "normal";
  const L = (S.snap && S.snap.license) || S.license || {};
  const locTag = I18N.lang === "fa" ? "fa-IR-u-ca-persian" : I18N.lang === "ar" ? "ar-SA-u-ca-islamic-umalqura" : "en-GB-u-ca-gregory";
  let freeAuto = "";
  if (!L.premium) {
    if (L.bot_ok === false && L.bot_lock_until) {
      let t = L.bot_lock_until;
      try { t = new Date(L.bot_lock_until).toLocaleTimeString(locTag, { hour: "2-digit", minute: "2-digit" }); } catch (_) {}
      freeAuto = `<p class="sub lock-note">${I18N.t("lock.auto_wait", { t })} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`;
    } else {
      freeAuto = `<p class="sub lock-note">${I18N.t("lock.auto_left", {
        left: L.bot_remaining == null ? "—" : L.bot_remaining,
        limit: L.bot_limit == null ? "—" : L.bot_limit,
        h: L.bot_window_hours || 5,
      })} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`;
    }
  }
  const newsPrem = licFeat("news");
  const propOn = (S.snap?.prop || {}).enabled !== false;
  const dg = st.danger_guard || {};
  const rf = st.risk_free || {};
  const money = st.money || {};
  const auto = Boolean(st.auto_trade);

  return `<div class="card robot-hero${auto ? " is-on" : ""}">
      ${switchRow({
        id: "st-auto",
        title: I18N.t("strategies.auto"),
        sub: st.auto_trade ? I18N.t("exec.auto_on") : I18N.t("exec.auto_off"),
        subId: "st-auto-sub",
        on: auto,
      })}
      ${freeAuto}
    </div>

    <div class="robot-cols">
      <div class="card">
        <h3 class="card-h">${I18N.t("style.title")}</h3>
        <div class="tabs" id="style-tabs">
          <button type="button" data-style="normal" class="${style !== "scalping" ? "on" : ""}">${I18N.t("style.normal")}</button>
          <button type="button" data-style="scalping" class="${style === "scalping" ? "on" : ""}"${licFeat("scalping") ? "" : " disabled"}>${I18N.t("style.scalping")}</button>
        </div>
        <p class="sub">${style === "scalping" ? I18N.t("style.scalping_hint") : I18N.t("style.normal_hint")}</p>
        ${licFeat("scalping") ? "" : `<p class="sub lock-note">${I18N.t("lock.scalping")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`}
      </div>

      <div class="card" id="set-slots">
        <h3 class="card-h">${I18N.t("slots.title")}</h3>
        <p class="sub">${I18N.t("slots.help")}</p>
        ${slotsHtml(st)}
        <hr class="set-rule" />
        ${switchRow({ id: "st-smart", title: I18N.t("slots.smart"), sub: I18N.t("slots.smart_help"), on: st.smart_filters !== false })}
        <ul class="set-list">
          <li>${I18N.t("slots.filter_htf")}</li>
          <li>${I18N.t("slots.filter_spread")}</li>
          <li>${I18N.t("slots.filter_chop")}</li>
        </ul>
        <hr class="set-rule" />
        ${qualityHtml(st)}
      </div>

      <div class="card">
        ${switchRow({
          id: "st-news",
          title: I18N.t("strategies.news_trade"),
          sub: st.news_trade_locked ? I18N.t("strategies.news_locked") : I18N.t("strategies.news_help"),
          subId: "st-news-sub",
          on: st.news_trade && newsPrem,
          disabled: st.news_trade_locked || !newsPrem,
        })}
        ${newsPrem ? "" : `<p class="sub lock-note">${I18N.t("lock.news")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`}
      </div>

      <div class="card" id="set-autoentry">
        ${switchRow({
          id: "st-autoentry",
          title: I18N.t("autoentry.title"),
          sub: I18N.t("autoentry.help"),
          subId: "st-autoentry-sub",
          on: Boolean(st.auto_entry),
        })}
        <ul class="set-list">
          <li>${I18N.t("autoentry.point_pending")}</li>
          <li>${I18N.t("autoentry.point_levels")}</li>
          <li>${I18N.t("autoentry.point_expiry", { m: st.auto_entry_expiry ?? 120 })}</li>
        </ul>
        <p class="sub">${I18N.t("autoentry.tradeoff")}</p>
        ${st.auto_entry && st.pending_orders ? `<p class="sub">${I18N.t("autoentry.waiting", { n: st.pending_orders })}</p>` : ""}
      </div>

      <div class="card">
        <h3 class="card-h">${I18N.t("strategies.lot_title")}
          ${!licFeat("volume_mode") ? `<span class="pill no">${I18N.t("themes.premium_tag")}</span>` : ""}</h3>
        <p class="sub">${I18N.t("strategies.lot_help")}</p>
        ${!licFeat("volume_mode") ? `<p class="sub lock-note">${I18N.t("lock.volume_mode")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>` : ""}
        <div class="tabs" id="vol-tabs">
          <button type="button" data-vm="auto" class="${st.volume_mode !== "manual" ? "on" : ""}">${I18N.t("strategies.lot_auto")}</button>
          <button type="button" data-vm="manual" class="${st.volume_mode === "manual" ? "on" : ""}"${!licFeat("volume_mode") ? " disabled" : ""}>${I18N.t("strategies.lot_manual")}</button>
        </div>
        <label class="field" id="vol-field"${st.volume_mode === "manual" ? "" : " hidden"}><span>${I18N.t("strategies.lot_value")}</span>
          <input id="st-vol" type="number" step="0.01" min="0.01" max="1000" value="${st.manual_volume ?? 0.10}" />
        </label>
        <p class="sub" id="vol-sub">${I18N.t(st.volume_mode === "manual" ? "strategies.lot_manual_sub" : "strategies.lot_auto_sub")}</p>
      </div>

      <div class="card">
        <h3 class="card-h">${I18N.t("strategies.ai_gate")}</h3>
        <p class="sub">${I18N.t("strategies.ai_gate_help")}</p>
        <hr class="set-rule" />
        ${switchRow({ id: "st-ai", title: I18N.t("strategies.ai_gate_switch"), on: st.require_ai_agree !== false })}
        <div class="field" style="margin-top:10px"><span class="conf-head">${I18N.t("strategies.min_conf")}<b class="mono conf-pct" id="st-conf-pct">${Math.round((st.min_ai_confidence ?? 0.35) * 100)}%</b></span>
          <input id="st-conf" type="range" step="0.01" min="0.05" max="0.95" value="${st.min_ai_confidence ?? 0.35}" />
        </div>
        <p class="sub" id="ai-conf-why">${I18N.t("strategies.min_conf_help")}</p>
        ${aiCeilingWarning(st)}
      </div>

      <div class="card">
        ${switchRow({
          id: "st-rf",
          title: I18N.t("strategies.rf_title"),
          sub: I18N.t("strategies.rf_help"),
          subId: "st-rf-sub",
          on: rf.enabled,
        })}
        <div class="field" style="margin-top:10px">
          <span class="conf-head">${I18N.t("strategies.rf_steps")}<b class="mono conf-pct" id="st-rf-steps-n">${rf.steps ?? 3}</b></span>
          <input id="st-rf-steps" type="range" step="1" min="1" max="5" value="${rf.steps ?? 3}" />
        </div>
        <div id="st-rf-ladder" class="rf-ladder">${rfLadderHtml(rf)}</div>
        <p class="sub">${I18N.t("strategies.rf_ladder_help")}</p>
      </div>

      <div class="card" id="set-money">
        <h3 class="card-h">${I18N.t("money.title")}</h3>
        <p class="sub">${I18N.t("money.help")}</p>
        <hr class="set-rule" />
        <label class="field num-field">
          <span>${I18N.t("money.cap")}</span>
          <span class="num-wrap">
            <input id="st-money-cap" type="number" step="0.5" min="0" value="${Number(money.max_loss_per_lot ?? 10)}" />
            <b class="num-unit">${esc(money.currency || I18N.t("money.unit"))} / ${I18N.t("money.per_lot")}</b>
          </span>
        </label>
        <p class="sub" id="st-money-reach">${esc(moneyReach(money))}</p>
        <button class="btn tiny" id="st-money-save" type="button">${I18N.t("money.save")}</button>
        <p class="sub">${I18N.t("money.zero_off")}</p>
      </div>

      <div class="card">
        ${switchRow({
          id: "st-danger",
          title: I18N.t("strategies.danger_title"),
          sub: propOn ? I18N.t("strategies.danger_prop_note") : I18N.t("strategies.danger_help"),
          subId: "st-danger-sub",
          on: dg.enabled,
          disabled: propOn,
        })}
        <div class="field" style="margin-top:10px"><span class="conf-head">${I18N.t("strategies.danger_sens")}<b class="mono conf-pct" id="st-danger-pct">${dg.sensitivity ?? 50}%</b></span>
          <input id="st-danger-sens" type="range" step="1" min="1" max="100" value="${dg.sensitivity ?? 50}" ${propOn ? "disabled" : ""} />
        </div>
        <p class="sub">${I18N.t("strategies.danger_sens_help")}</p>
      </div>
    </div>
`;
}

/**
 * The AI cannot always reach the number the slider is set to.
 *
 * Its confidence is pulled back towards "no information" in proportion
 * to the edge the model has measured out of sample, so it has a
 * ceiling - about 53% before any edge has been measured. A minimum set
 * above that is not a strict filter; it is an off switch, and the log
 * line it produces ("AI confidence 0.31 is under the 0.55 you asked
 * for") reads like the market's fault rather than the slider's. So the
 * desk says it where the slider is, before the trader waits a week for
 * an entry that arithmetic has already refused.
 */
function aiCeilingWarning(st) {
  st = st || {};
  if (st.require_ai_agree === false) return "";
  const ceiling = Number((S.snap?.ai || {}).ceiling || 0);
  const want = Number(st.min_ai_confidence ?? 0.35);
  if (!(ceiling > 0) || ceiling >= want) return "";
  return `<p class="sub warn" id="ai-conf-ceiling">${I18N.t("strategies.min_conf_unreachable", {
    want: Math.round(want * 100),
    can: Math.round(ceiling * 100),
  })}</p>`;
}

/**
 * "At this cap, the widest stop on the live symbol is N points."
 *
 * A cap in money is the right unit to think in and the wrong one to
 * read a chart in, so the desk says both. Where the broker has not
 * reported a tick value the line says that instead of a number: a
 * made-up distance would be worse than an empty one.
 */
function moneyReach(money) {
  money = money || {};
  if (!Number(money.max_loss_per_lot)) return I18N.t("money.off");
  if (!money.priced) return I18N.t("money.unpriced");
  return I18N.t("money.reach", {
    s: money.symbol || "",
    p: money.max_stop_points == null ? "—" : money.max_stop_points,
    d: money.max_stop_distance == null ? "—" : money.max_stop_distance,
  });
}

/**
 * The desk clock.
 *
 * In System rather than in prop risk, because which hours a prop firm
 * allows is their rule and what time it is where you sit is not. Asking
 * the same question once per profile is how the answers start
 * disagreeing with each other.
 *
 * "Broker time" is the default and is not a question at all: MetaTrader
 * stamps every tick with its server's clock, so the offset is worked
 * out rather than asked for. It is the right default because prop
 * trading hours are quoted in broker time by the firms themselves.
 */
/**
 * The MetaTrader side of the install: which experts AURION ships, which
 * version each attached chart is actually running, and how to install them.
 *
 * AURION can update itself. The two .mq5 files inside MetaTrader cannot:
 * only the person at the terminal can recompile and re-attach them. So an
 * update used to leave the desk talking a newer protocol to an older
 * expert, silently, with everything still showing "connected". The card
 * puts both numbers side by side and says plainly when they differ.
 */
function expertsCardHtml() {
  const ea = (S.snap && S.snap.experts) || {};
  const ships = Array.isArray(ea.shipped) ? ea.shipped : [];
  const charts = Array.isArray(ea.charts) ? ea.charts : [];
  const stale = Array.isArray(ea.stale) ? ea.stale : [];
  const shipped = String(ea.version || "—");

  const warn = stale.length ? `<div class="ea-warn" id="ea-warn">
      <b>${I18N.t("ea.outdated_title")}</b>
      <p>${I18N.t("ea.outdated_body", { shipped: esc(shipped) })}</p>
      <ul>${stale.map((c) => `<li><span class="mono">${esc(c.symbol || "—")} ${esc(c.timeframe || "")}</span>
        — ${I18N.t("ea.running", { v: esc(c.version || "?") })}</li>`).join("")}</ul>
    </div>` : "";

  const rows = ships.map((x) => {
    const file = String(x.file || "");
    const bad = !x.available;
    return `<div class="ea-row${bad ? " is-missing" : ""}">
      <div class="ea-row-main">
        <b class="mono ea-row-file">${esc(file)}</b>
        <span class="pill ${x.required ? "" : "ghost"}">${I18N.t(x.required ? "ea.required" : "ea.optional")}</span>
        <p class="sub">${I18N.t("ea." + String(x.id || "bridge") + "_about")}</p>
      </div>
      <div class="ea-row-end">
        <b class="mono">v${esc(x.version || "—")}</b>
        <button type="button" class="btn tiny ghost" data-ea-save="${esc(String(x.id || ""))}"
          ${bad ? "disabled" : ""}>${I18N.t("ea.save_file")}</button>
      </div>
    </div>`;
  }).join("");

  const chartRows = charts.length
    ? charts.map((c) => {
        const cls = c.state === "ok" ? "ok" : c.state === "newer" ? "" : "no";
        const word = I18N.t("ea.state_" + (c.state === "ok" ? "ok" : c.state === "newer" ? "newer" : c.state === "unknown" ? "unknown" : "old"));
        return `<div class="ea-chart">
          <span class="mono">${esc(c.symbol || "—")} ${esc(c.timeframe || "")}</span>
          <span class="sub">${esc(c.ea_name || "AurionBridge")}${c.tester ? " · " + I18N.t("ea.tester") : ""}</span>
          <b class="mono">v${esc(c.version || "?")}</b>
          <span class="pill ${cls}">${word}</span>
        </div>`;
      }).join("")
    : `<p class="sub">${I18N.t("ea.no_charts")}</p>`;

  // If the installer already copied the files next to MetaTrader, say so:
  // it turns "go and find the folder" into "press F7".
  const inst = (ea.installed && ea.installed.folders && ea.installed.folders.length) ? ea.installed : null;
  const copied = inst ? `<p class="sub ea-copied">${I18N.t("ea.copied", {
    n: inst.folders.length,
    v: esc(String(inst.version || "")),
    at: esc(String(inst.at || "").replace("T", " ").slice(0, 16)),
  })}</p>` : "";

  const steps = [1, 2, 3, 4, 5, 6].map((n) => `<li>${I18N.t("ea.step" + n, {
    folder: esc(String(ea.folder || "MQL5/Experts/Aurion")),
    port: esc(String(ea.http_port_hint || 18765)),
    v: esc(shipped),
  })}</li>`).join("");

  return `<div class="card" id="ea-card">
      <h3>${I18N.t("ea.title")}</h3>
      <p class="sub">${I18N.t("ea.help", { v: esc(shipped) })}</p>
      ${warn}
      <div class="ea-list">${rows || `<p class="sub">${I18N.t("ea.none_shipped")}</p>`}</div>
      ${copied}
      <h4 class="ea-sub">${I18N.t("ea.attached")}</h4>
      <div class="ea-charts">${chartRows}</div>
      <details class="ea-guide">
        <summary>${I18N.t("ea.guide_title")}</summary>
        <ol>${steps}</ol>
        <p class="sub">${I18N.t("ea.guide_note")}</p>
      </details>
      <p class="sub ea-upd-note" id="ea-upd-note" hidden></p>
    </div>`;
}

function timezoneCardHtml() {
  const sys = S.snap?.strategy?.system || {};
  const current = String(sys.timezone || "UTC");
  const choices = Array.isArray(sys.choices) && sys.choices.length
    ? sys.choices
    : [{ group: "", id: "UTC", city: "UTC", offset: "+00:00" }];

  // The engine sends objects now: a city, the offset in force today and
  // the region to group under. A raw "Asia/Tehran" is a database key;
  // "Tehran (+03:30)" is where somebody lives.
  const label = (z) => {
    if (z.id === "broker") {
      return z.offset ? `${I18N.t("sys.tz_broker")} ${z.offset}` : I18N.t("sys.tz_broker");
    }
    if (z.id === "local") return I18N.t("sys.tz_local");
    return z.offset ? `${z.city} (${z.offset})` : z.city;
  };

  const groups = [];
  for (const z of choices) {
    const key = z.group || "";
    let bucket = groups.find((g) => g.key === key);
    if (!bucket) { bucket = { key, items: [] }; groups.push(bucket); }
    bucket.items.push(z);
  }

  const options = groups.map((g) => {
    const opts = g.items.map((z) =>
      `<option value="${esc(z.id)}"${z.id === current ? " selected" : ""}>${esc(label(z))}</option>`
    ).join("");
    return g.key ? `<optgroup label="${esc(g.key)}">${opts}</optgroup>` : opts;
  }).join("");

  const known = sys.broker_offset_minutes;
  const detail = current === "broker" && known === null
    ? I18N.t("sys.tz_broker_waiting")
    : I18N.t("sys.tz_now", { z: esc(sys.label || current) });

  return `<div class="card">
      <h3>${I18N.t("sys.tz_title")}</h3>
      <p class="sub">${I18N.t("sys.tz_help")}</p>
      <div class="field" style="margin-top:10px">
        <span>${I18N.t("sys.tz_title")}</span>
        <select id="sys-tz" class="ctrl">${options}</select>
      </div>
      <p class="sub" id="sys-tz-now">${detail}</p>
    </div>`;
}

function profileLabel(id) {
  const key = "risk.preset_" + id;
  const tr = I18N.t(key);
  return tr === key ? id : tr;
}
function profileAbout(pr) {
  const about = (pr && pr.about) || {};
  return about[I18N.lang] || about.en || "";
}
function propLocked(pr) {
  return Boolean(pr && (pr.locked === true || (pr.id && pr.id !== "custom")));
}

function propStatusHtml() {
  const p = S.snap?.prop || {};
  const pr = p.profile || {};
  const w = Math.min(100, Math.abs(p.drawdown_pct || 0) / (pr.max_drawdown_pct || 10) * 100);
  const on = p.enabled !== false;
  return `<div class="card" style="margin-bottom:14px">
      <div class="auto-banner" style="margin:0 0 12px">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("risk.prop_switch")}</h3>
          <p class="sub" id="prop-enable-sub">${on ? I18N.t("risk.prop_on") : I18N.t("risk.prop_off")}</p>
        </div>
        <button type="button" class="switch ${on?"on":""}" id="prop-enable" data-prop-enable aria-pressed="${on}"><i></i></button>
      </div>
      <p class="metric ${p.locked?"down":"up"}" id="risk-state">${!on ? I18N.t("risk.prop_off") : (p.locked ? I18N.t("status.safe_mode") : I18N.t("status.prop_ok"))}</p>
      <p class="sub" id="risk-lock">${p.lock_reason || ""}</p>
      <div class="kv" style="margin-top:12px">
        <span>${I18N.t("command.daily_pl")}</span><b class="mono ${clsPnl(p.daily_pl_pct)}" id="risk-dpl">${fmt(p.daily_pl_pct)}%</b>
        <span>${I18N.t("command.drawdown")}</span><b class="mono" id="risk-dd">${fmt(p.drawdown_pct)}%</b>
      </div>
      <div class="bar" style="margin-top:10px"><i style="--w:${w}%"></i></div>
      <div class="row" style="margin-top:12px">
        <button class="btn tiny danger" id="pr-lock" type="button"${on ? "" : " disabled"}>${I18N.t("risk.lock")}</button>
        <button class="btn tiny" id="pr-unlock" type="button"${on ? "" : " disabled"}>${I18N.t("risk.unlock")}</button>
      </div>
    </div>`;
}
/**
 * One numeric prop-rule field.
 *
 * Every number on this page needed a unit spelled out: "2" in a box labelled
 * "daily loss" could be two percent, two hundred dollars or two pips, and the
 * difference between those is an account. The unit is rendered inside the
 * field as a suffix rather than in the label, so it stays attached to the
 * value even when the label wraps.
 */
function propNum(id, labelKey, unitKey, value, opts) {
  opts = opts || {};
  const step = opts.step ? ` step="${opts.step}"` : "";
  const min = opts.min !== undefined ? ` min="${opts.min}"` : "";
  const max = opts.max !== undefined ? ` max="${opts.max}"` : "";
  const note = opts.zeroOff ? `<em class="unit-note">${I18N.t("risk.u_zero_off")}</em>` : "";
  // A long unit needs more room than a short one; the field declares which it
  // is instead of every field reserving space for the longest possible suffix.
  const wide = I18N.t(unitKey).length > 12 ? " wide-unit" : "";
  return `<label class="field num-field${wide}">
      <span>${I18N.t(labelKey)}${note}</span>
      <span class="num-wrap">
        <input id="${id}" type="number"${step}${min}${max} value="${value}" />
        <b class="num-unit">${I18N.t(unitKey)}</b>
      </span>
    </label>`;
}

/**
 * A prop trading hour, written in your clock and shown in the broker's.
 *
 * These used to be plain text boxes labelled "time", and the time they
 * meant was UTC with nothing saying so. A trader in Tehran typing 07:00
 * was setting 10:30 their own morning, which is how the conservative
 * profile came to look as though prop mode simply refused to trade.
 *
 * So the field is in the desk's chosen zone - the one in System
 * settings - and the line underneath says what that is for the broker,
 * because that is the clock the firm's rulebook is written in. The
 * conversion is arithmetic on an offset the engine publishes; doing it
 * with a second timezone implementation in the browser is how the two
 * end up disagreeing about the week the clocks change.
 */
function propTime(id, labelKey, value, placeholder) {
  const sys = S.snap?.strategy?.system || {};
  const zone = String(sys.label || sys.timezone || "UTC");

  // type="time" rather than a text box.
  //
  // The browser then draws hours and minutes as two spinnable fields in
  // the user's own locale, validates them, and refuses 25:70 - none of
  // which a free-text box did. It was previously possible to save "7pm"
  // or "07.00" and get a window that never opened, with nothing saying
  // why.
  return `<label class="field num-field">
      <span>${I18N.t(labelKey)} <b class="tz-tag">${esc(zone)}</b></span>
      <span class="num-wrap">
        <input id="${id}" type="time" step="60" value="${esc(normalTime(value, placeholder))}" />
      </span>
      <small class="sub prop-at-broker" data-for="${id}">${esc(brokerEcho(value))}</small>
    </label>`;
}

/** "7:5" and "07.00" both mean 07:00; type="time" wants it spelled out. */
function normalTime(value, fallback) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{1,2})\s*$/.exec(String(value ?? ""));
  if (!m) return fallback || "00:00";
  const hh = Math.min(23, +m[1]);
  const mm = Math.min(59, +m[2]);
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

/** "07:00 here = 06:30 broker", or an empty string when it cannot be said. */
function brokerEcho(text) {
  const sys = S.snap?.strategy?.system || {};
  const mine = sys.offset_minutes;
  const broker = sys.broker_offset_minutes;

  if (mine === null || mine === undefined) return "";
  if (broker === null || broker === undefined) {
    // Honest rather than converted against a zero it has not earned.
    return I18N.t("risk.hours_broker_unknown");
  }

  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(String(text || ""));
  if (!m) return "";
  const hh = +m[1], mm = +m[2];
  if (hh > 23 || mm > 59) return "";

  // Same instant, read on the broker's clock.
  let at = hh * 60 + mm - mine + broker;
  at = ((at % 1440) + 1440) % 1440;
  const out = String(Math.floor(at / 60)).padStart(2, "0") + ":" + String(at % 60).padStart(2, "0");
  return I18N.t("risk.hours_broker", { t: out });
}

function propText(id, labelKey, unitKey, value, placeholder) {
  const wide = I18N.t(unitKey).length > 12 ? " wide-unit" : "";
  return `<label class="field num-field${wide}">
      <span>${I18N.t(labelKey)}</span>
      <span class="num-wrap">
        <input id="${id}" value="${esc(value)}"${placeholder ? ` placeholder="${placeholder}"` : ""} />
        <b class="num-unit">${I18N.t(unitKey)}</b>
      </span>
    </label>`;
}

function propFormHtml() {
  const p = S.snap?.prop || {};
  const pr = p.profile || {};
  const locked = propLocked(pr);
  const dis = locked ? " disabled" : "";
  const ids = ["conservative", "ftmo_challenge", "fundingpips", "the5ers", "custom"];
  return `<label class="field"><span>${I18N.t("risk.preset")}</span>
          <select class="ctrl" id="pr-preset">
            ${ids.map((id)=>`<option value="${id}" ${pr.id===id?"selected":""}>${esc(profileLabel(id))}</option>`).join("")}
          </select>
        </label>
        <input type="hidden" id="pr-id" value="${esc(pr.id||"custom")}" />
        <p class="sub" id="pr-about">${esc(profileAbout(pr))}</p>
        ${locked ? `<p class="sub prop-lock-note">${I18N.t("risk.preset_locked")}</p>` : ""}
        <fieldset class="prop-fields${locked?" is-locked":""}"${locked?" disabled":""}>
        <h4 class="set-h">${I18N.t("risk.sec_limits")}</h4>
        <div class="grid g-2">
          ${propNum("pr-dday", "risk.daily_loss", "risk.u_pct_balance", pr.max_daily_loss_pct||2, {step:"0.1", min:0})}
          ${propNum("pr-mdd", "risk.max_dd", "risk.u_pct_balance", pr.max_drawdown_pct||5, {step:"0.1", min:0})}
          ${propNum("pr-dtp", "risk.daily_profit", "risk.u_pct_balance", pr.max_daily_profit_pct||0, {step:"0.1", min:0, zeroOff:true})}
          ${propNum("pr-pt", "risk.profit_target", "risk.u_pct_balance", pr.profit_target_pct||0, {step:"0.1", min:0, zeroOff:true})}
          ${propNum("pr-lot", "risk.max_lot", "risk.u_lots", pr.max_lot||0.5, {step:"0.01", min:0})}
          ${propNum("pr-lotsym", "risk.max_lot_symbol", "risk.u_lots", pr.max_lot_per_symbol||0, {step:"0.01", min:0, zeroOff:true})}
          ${propNum("pr-n", "risk.max_trades", "risk.u_trades", pr.max_open_trades||2, {min:0})}
          ${propNum("pr-ps", "risk.per_symbol", "risk.u_positions", pr.max_positions_per_symbol||1, {min:0})}
          ${propNum("pr-dayn", "risk.max_day_trades", "risk.u_per_day", pr.max_trades_per_day||0, {min:0, zeroOff:true})}
          ${propNum("pr-risk", "risk.risk_pct", "risk.u_pct_equity", pr.max_risk_per_trade_pct||0.5, {step:"0.1", min:0})}
        </div>
        <h4 class="set-h">${I18N.t("risk.sec_time")}</h4>
        <div class="grid g-2">
          ${propNum("pr-holdmin", "risk.min_hold", "risk.u_minutes", pr.min_hold_minutes||0, {step:"0.1", min:0, zeroOff:true})}
          ${propNum("pr-maxhold", "risk.max_hold", "risk.u_hours", pr.max_hold_hours||0, {step:"0.1", min:0, zeroOff:true})}
          ${propNum("pr-gap", "risk.gap", "risk.u_minutes", pr.min_minutes_between_trades||0, {min:0, zeroOff:true})}
          ${propNum("pr-cl", "risk.consec", "risk.u_trades", pr.max_consecutive_losses||0, {min:0, zeroOff:true})}
          ${propTime("pr-hs", "risk.hours_start", (pr.trading_hours&&pr.trading_hours.start)||"00:15", "00:15")}
          ${propTime("pr-he", "risk.hours_end", (pr.trading_hours&&pr.trading_hours.end)||"23:45", "23:45")}
          ${propNum("pr-fri", "risk.friday", "risk.u_utc_hour", pr.friday_close_utc_hour||21, {min:0, max:23})}
          ${propNum("pr-nb", "risk.news_before", "risk.u_minutes", pr.news_blackout_before||15, {min:0})}
          ${propNum("pr-na", "risk.news_after", "risk.u_minutes", pr.news_blackout_after||15, {min:0})}
        </div>
        <h4 class="set-h">${I18N.t("risk.sec_filters")}</h4>
        <div class="field sym-field">
          <span>${I18N.t("risk.symbols")}</span>
          <div class="sym-pick" id="pr-syms-pick">
            <button type="button" class="sym-btn" id="pr-syms-btn" aria-haspopup="true" aria-expanded="false">
              <span class="sym-chips" id="pr-syms-label">${esc(I18N.t("risk.symbols_pick"))}</span>
              <span class="sym-caret" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </span>
            </button>
            <input type="hidden" id="pr-syms" value="${esc(pr.allowed_symbols||"")}" />
            <div class="sym-panel" id="pr-syms-panel" hidden>
              <div class="sym-head">
                <input class="sym-q" id="pr-syms-q" type="search"
                       placeholder="${esc(I18N.t("risk.symbols_search"))}" />
              </div>
              <div class="sym-acts">
                <button type="button" class="btn tiny ghost" id="pr-syms-all">${esc(I18N.t("risk.symbols_all"))}</button>
                <button type="button" class="btn tiny ghost" id="pr-syms-none">${esc(I18N.t("risk.symbols_none"))}</button>
              </div>
              <div class="sym-list" id="pr-syms-list" role="listbox" aria-multiselectable="true"></div>
              <div class="sym-foot" id="pr-syms-foot"></div>
            </div>
          </div>
          <p class="sub">${I18N.t("risk.symbols_none_sel")}</p>
        </div>
        <label class="field"><span>${I18N.t("risk.violation")}</span>
          <select class="ctrl" id="pr-vio">
            <option value="lock" ${pr.on_violation==="lock"?"selected":""}>lock</option>
            <option value="flatten_and_lock" ${pr.on_violation!=="lock"?"selected":""}>flatten_and_lock</option>
          </select>
        </label>
        <div class="row" style="margin:8px 0 12px;flex-wrap:wrap">
          <label class="row" style="gap:8px"><input type="checkbox" id="pr-news" ${pr.news_filter?"checked":""}/> ${I18N.t("risk.news")}</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="pr-we" ${pr.allow_weekend?"checked":""}/> ${I18N.t("risk.weekend")}</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="pr-hold" ${pr.allow_hold_over_weekend?"checked":""}/> ${I18N.t("risk.hold_weekend")}</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="pr-hedge" ${pr.hedging_allowed!==false?"checked":""}${dis}/> ${I18N.t("risk.hedge")}</label>
        </div>
        </fieldset>
        ${locked ? "" : `<button class="btn block" id="pr-save" type="button">${I18N.t("risk.save")}</button>`}`;
}


/**
 * The prop guide, rendered under the prop form.
 *
 * Help that lives in another document is help nobody reads at the moment
 * they need it, which is while looking at the box. Each entry is tied to
 * a control by id, and tests/prop-guide.test.js refuses a control without
 * one — so a new setting cannot ship undocumented.
 */
function propGuideHtml() {
  const G = (typeof PROP_GUIDE !== "undefined") ? PROP_GUIDE : null;
  if (!G) return "";
  const lang = I18N.lang || "en";
  const sections = G.SECTIONS.map((sec, i) => `
      <details class="pg-sec" data-pg-sec="${esc(sec.id)}"${i === 0 ? " open" : ""}>
        <summary>${esc(G.pick(sec.title, lang))}</summary>
        <p class="sub pg-lede">${G.pick(sec.lede, lang)}</p>
        ${sec.rows.map((row) => `
          <div class="pg-row" data-pg-row="${esc(row.id)}"
               data-pg-find="${esc((G.pick(row.label, lang) + " " + G.pick(row, lang)).toLowerCase())}">
            <b class="pg-k">${esc(G.pick(row.label, lang))}</b>
            <p class="pg-v">${G.pick(row, lang)}</p>
          </div>`).join("")}
      </details>`).join("");
  return `<div class="card prop-guide" id="prop-guide">
      <h3>${I18N.t("risk.guide_title")}</h3>
      <p class="sub">${I18N.t("risk.guide_lede")}</p>
      <label class="field"><span>${I18N.t("risk.guide_search")}</span>
        <input id="prop-guide-q" type="search" placeholder="${esc(I18N.t("risk.guide_search_ph"))}" />
      </label>
      <p class="sub" id="prop-guide-empty" hidden>${I18N.t("risk.guide_empty")}</p>
      ${sections}
    </div>`;
}

/** Filter the guide as the box is typed in; empty query restores it. */
function bindPropGuide() {
  const q = document.getElementById("prop-guide-q");
  if (!q || q.dataset.bound) return;
  q.dataset.bound = "1";
  const empty = document.getElementById("prop-guide-empty");
  q.addEventListener("input", () => {
    const want = q.value.trim().toLowerCase();
    let hits = 0;
    document.querySelectorAll("#prop-guide .pg-sec").forEach((sec) => {
      let shown = 0;
      sec.querySelectorAll(".pg-row").forEach((row) => {
        const ok = !want || (row.dataset.pgFind || "").includes(want);
        row.hidden = !ok;
        if (ok) shown++;
      });
      sec.hidden = shown === 0;
      if (want && shown) sec.open = true;
      hits += shown;
    });
    if (empty) empty.hidden = hits !== 0;
  });
}

/* The robot's own account of itself: this symbol, this strategy, why it is
   not trading, when it will, and the lines it prints when it does. All of
   it existed already - in the gate's reason codes, the strategy's refusal,
   the AI read and the journal - but scattered across four screens, which
   left the trader to join them up. A robot doing nothing and a robot that
   is broken look identical until something says which one this is. */
/* Which sound marks which event. Three separate choices rather than one
   on/off switch, because "the robot just opened a trade" and "that trade
   closed down" are not the same news and a trader learns the difference
   by ear long before they look at the screen. Status changes are not
   listed here: they are silent by design. */
function notifySoundCardHtml() {
  const p = notifyPrefs();
  const muted = !(p.volume > 0);

  /* One row per event, not a column of identical dropdowns.
     The old panel was three <label><select> pairs stacked in a card, and the
     only way to tell which row was which was to read the text beside it. A
     row now carries the mark it is about - the same arrow the trade cards
     use for a buy, the same green and red as a closed trade - so the setting
     looks like the thing it controls. */
  const row = (key, tone, mark, label, hint) => {
    const value = p[key] || "none";
    const off = value === "none";
    const shipped = SOUND_FILES.has(key);
    return `<div class="snd-row${off ? " is-off" : ""}" data-sndrow="${key}">
      <span class="snd-mark t-${tone}" aria-hidden="true">${mark}</span>
      <span class="snd-text">
        <b>${esc(label)}</b>
        ${hint ? `<small>${esc(hint)}</small>` : ""}
      </span>
      <select class="ctrl snd-pick" data-snd="${key}" aria-label="${esc(label)}">${
        SOUND_NAMES.map((n) =>
          `<option value="${n}"${value === n ? " selected" : ""}>${esc(I18N.t("notify.snd_" + n))}</option>`
        ).join("")}${
        /* Offered only when this build actually ships a file for the
           slot, so the list can never name a sound that does not exist. */
        shipped ? `<option value="file"${value === "file" ? " selected" : ""}>${esc(I18N.t("notify.snd_file"))}</option>` : ""}</select>
      <button type="button" class="icon-btn snd-play" data-sndtest="${key}"
              title="${esc(I18N.t("notify.preview"))}"
              aria-label="${esc(I18N.t("notify.preview"))}"${off || muted ? " disabled" : ""}>${icon("play")}</button>
    </div>`;
  };

  return `<div class="snd-wrap" id="notify-card">
    <p class="sub snd-lead">${esc(I18N.t("notify.lead"))}</p>

    <div class="card snd-card">
      <div class="snd-head">
        <h3>${esc(I18N.t("notify.master_title"))}</h3>
        <span class="snd-vol-read" id="snd-vol-read">${muted ? esc(I18N.t("notify.muted")) : Math.round(p.volume * 100) + "%"}</span>
      </div>
      <p class="sub">${esc(I18N.t("notify.master_hint"))}</p>
      <div class="snd-vol">
        <button type="button" class="icon-btn snd-mute" id="snd-mute"
                aria-label="${esc(I18N.t("notify.muted"))}" aria-pressed="${muted}">${muted ? icon("volumeOff") : icon("volume")}</button>
        <input id="snd-vol" type="range" min="0" max="100" step="5" value="${Math.round(p.volume * 100)}"
               aria-label="${esc(I18N.t("notify.master_title"))}" />
      </div>
    </div>

    <div class="card snd-card">
      <div class="snd-head"><h3>${esc(I18N.t("notify.events_title"))}</h3></div>
      <p class="sub">${esc(I18N.t("notify.events_hint"))}</p>
      <div class="snd-rows">
        ${row("entry", "entry", icon("chart"), I18N.t("notify.entry"), I18N.t("notify.entry_hint"))}
        ${row("profit", "up", icon("check"), I18N.t("notify.exit_profit"), "")}
        ${row("loss", "down", icon("close"), I18N.t("notify.exit_loss"), "")}
        ${row("notice", "notice", icon("info"), I18N.t("notify.notice"), I18N.t("notify.notice_hint"))}
      </div>
      <p class="sub snd-note">${esc(I18N.t("notify.custom_note"))}</p>
    </div>

    <div class="card snd-card">
      <div class="snd-head"><h3>${esc(I18N.t("notify.delivery_title"))}</h3></div>
      <div class="snd-deliver">
        <div class="snd-text">
          <b>${esc(I18N.t("notify.windows"))}</b>
          <small>${esc(I18N.t("notify.windows_hint"))}</small>
        </div>
        <button type="button" class="switch ${p.windows ? "on" : ""}" id="sw-wintoast"
                aria-pressed="${p.windows}"><i></i></button>
      </div>
    </div>
  </div>`;
}

function bindNotifySounds(root) {
  const scope = root || document;

  /* The panel has three states that have to agree with each other: the
     master volume, whether a row is set to Silent, and whether its preview
     button can do anything. Keeping that in one place means a row cannot
     end up offering a preview that plays nothing. */
  const refresh = () => {
    const p = notifyPrefs();
    const muted = !(p.volume > 0);

    const read = scope.querySelector("#snd-vol-read");
    if (read) read.textContent = muted ? I18N.t("notify.muted") : Math.round(p.volume * 100) + "%";

    const mute = scope.querySelector("#snd-mute");
    if (mute) {
      mute.setAttribute("aria-pressed", String(muted));
      mute.innerHTML = muted ? icon("volumeOff") : icon("volume");
    }

    scope.querySelectorAll("[data-sndrow]").forEach((rowEl) => {
      const key = rowEl.dataset.sndrow;
      const off = (p[key] || "none") === "none";
      rowEl.classList.toggle("is-off", off);
      const play = rowEl.querySelector("[data-sndtest]");
      if (play) play.disabled = off || muted;
    });
  };

  scope.querySelectorAll("[data-snd]").forEach((sel) => {
    sel.onchange = () => {
      const slot = sel.dataset.snd;
      saveNotifyPrefs({ [slot]: sel.value });
      refresh();
      // Heard immediately: picking a sound from a list of names means
      // nothing until it makes a noise.
      playSound(sel.value, undefined, slot);
    };
  });

  scope.querySelectorAll("[data-sndtest]").forEach((btn) => {
    const slot = btn.dataset.sndtest;
    btn.onclick = () => playSound(notifyPrefs()[slot], undefined, slot);
  });

  const vol = scope.querySelector("#snd-vol");
  if (vol) {
    vol.oninput = () => { saveNotifyPrefs({ volume: Number(vol.value) / 100 }); refresh(); };
    vol.onchange = () => playSound(notifyPrefs().entry);
  }

  /* Mute remembers the level it muted from, so unmuting returns to where the
     trader had it rather than to an arbitrary default. */
  const mute = scope.querySelector("#snd-mute");
  if (mute) {
    mute.onclick = () => {
      const p = notifyPrefs();
      const now = p.volume > 0;
      const next = now ? 0 : (Number(mute.dataset.last) || 0.6);
      if (now) mute.dataset.last = String(p.volume);
      saveNotifyPrefs({ volume: next });
      if (vol) vol.value = String(Math.round(next * 100));
      refresh();
    };
  }

  const win = scope.querySelector("#sw-wintoast");
  if (win) {
    win.onclick = () => {
      const next = !notifyPrefs().windows;
      saveNotifyPrefs({ windows: next });
      win.classList.toggle("on", next);
      win.setAttribute("aria-pressed", String(next));
    };
  }

  refresh();
}

function analysisCardHtml() {
  const a = S.snap?.analysis;
  if (!a) return `<div class="card"><h3>${I18N.t("ai.an.title")}</h3><p class="sub">${I18N.t("ai.an.waiting")}</p></div>`;
  const blockers = a.blockers || [];
  const ready = !!a.ready && !!a.setup;
  const conf = Math.round((a.ai?.confidence || 0) * 100);
  const need = Math.round((a.ai?.min_confidence || 0) * 100);
  const line = (b) => `<li><b>${esc(b.text || b.code || "")}</b>${b.fix ? `<span class="sub"> — ${esc(b.fix)}</span>` : ""}</li>`;
  const lines = (a.console || []).slice(-40).reverse();
  return `<div class="card" id="an-card">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>
        <h3 style="margin:0 0 4px">${I18N.t("ai.an.title")}</h3>
        <p class="sub" style="margin:0">${I18N.t("ai.an.sub")}</p>
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span class="pill ghost">${I18N.t("ai.an.watching")}: <b class="mono">${esc(a.symbol || "—")} ${esc(a.timeframe || "")}</b></span>
        <span class="pill ${a.strategy_enabled ? "ok" : "ghost"}">${I18N.t("ai.an.with_strategy")}: <b>${esc(a.strategy || "—")}</b></span>
        <span class="pill ${a.ai?.gate ? (conf >= need ? "ok" : "no") : "ghost"}">${a.ai?.gate ? `${I18N.t("ai.an.ai_conf")}: ${conf}% / ${need}%` : I18N.t("ai.an.ai_gate_off")}</span>
      </div>
    </div>
    <p class="metric ${ready ? "up" : ""}" style="font-size:18px;margin:12px 0 2px">${ready ? I18N.t("ai.an.verdict_ready") : I18N.t("ai.an.verdict_blocked")}</p>
    <div class="grid g-2" style="margin-top:10px">
      <div>
        <h3 style="font-size:13px">${I18N.t("ai.an.why")}</h3>
        ${blockers.length
          ? `<ul class="an-why">${blockers.map(line).join("")}</ul>`
          : `<p class="sub">${I18N.t("ai.an.no_blockers")}</p>`}
        ${(a.refusals || []).length
          ? `<p class="sub" style="margin-top:8px">${I18N.t("ai.an.refusals")}: ${a.refusals.map((r) => `${esc(r.reason)} ×${r.count}`).join(" · ")}</p>`
          : ""}
      </div>
      <div>
        <h3 style="font-size:13px">${I18N.t("ai.an.when")}</h3>
        <p class="sub">${esc(a.when || "")}</p>
        ${(a.resting || []).length
          ? `<ul class="an-why">${a.resting.map((r) => `<li><b>${esc(String(r.type || "").replace(/_/g, " ").toUpperCase())} ${fmt(r.volume, 2)} @ ${fmt(r.price, 5)}</b>
               <span class="sub"> — SL ${r.sl ? fmt(r.sl, 5) : "—"} / TP ${r.tp ? fmt(r.tp, 5) : "—"}</span></li>`).join("")}</ul>`
          : ""}
        ${a.next_eval?.text ? `<p class="sub"><b>${I18N.t("ai.an.next_eval")}:</b> <span class="mono" id="an-next">${esc(a.next_eval.text)}</span></p>` : ""}
      </div>
    </div>
    <h3 style="font-size:13px;margin-top:14px">${I18N.t("ai.an.console")}</h3>
    <div class="ai-feed term" id="an-console">${lines.length
      ? lines.map((r) => `<div class="row-line ${esc(r.level || "info")}"><span class="ts">${esc(String(r.ts || "").slice(11, 19))}</span><span class="mono" style="opacity:.7">${esc(r.code || "")}</span><span>${esc(r.message || "")}</span></div>`).join("")
      : emptyMini(I18N.t("ai.an.console_empty"))}</div>
  </div>`;
}

const views = {
  command() {
    const acc = S.snap?.mt5?.account || {};
    const prop = S.snap?.prop || {};
    const pos = S.snap?.positions || [];
    const agents = liveAgents();
    const wizard = `<div class="hero" id="cmd-wizard" style="margin-bottom:14px"${agents.length ? " hidden" : ""}>
        <div class="hero-copy">
          <p class="kicker">${I18N.t("command.ready")}</p>
          <h3>${I18N.t("command.hero")}</h3>
          <p>${I18N.t("command.connect_hint")}</p>
          ${!agents.length ? `<p class="sub">${I18N.t("status.ea_waiting")}</p>` : ""}
          ${!agents.length ? `<p class="sub" id="wiz-ingest">${esc(eaIngestLine() || I18N.t("status.ea_file_hint"))}</p>` : ""}
          <div class="hero-chips">
            <span class="pill"><i class="dot ${S.snap ? "live" : "down"}"></i>${I18N.t(S.snap ? "status.engine_live" : "status.engine_down")}</span>
            <span class="pill" id="wiz-mt5"><i class="dot ${mt5Live() ? "live" : "down"}"></i>${I18N.t(mt5Live() ? "status.mt5_live" : "status.mt5_down")}</span>
            <span class="pill" id="wiz-ea">${I18N.t("status.ea_attached", { n: agents.length })}</span>
            <span class="pill warn" id="wiz-eaver"${eaStale().length ? "" : " hidden"}>${eaStaleLabel()}</span>
          </div>
        </div>
        <div class="card glass-rise">
          <h3>${I18N.t("wizard.title")}</h3>
          <div class="wizard">
            <div class="step"><b>1</b><div>${I18N.t("wizard.step1")}</div></div>
            <div class="step"><b>2</b><div>${I18N.t("wizard.step2")}</div></div>
            <div class="step"><b>3</b><div>${I18N.t("wizard.step3")}</div></div>
            <div class="step"><b>4</b><div>${I18N.t("wizard.step4")}</div></div>
          </div>
          <button class="btn block" id="go-settings" type="button">${I18N.t("wizard.verify")}</button>
        </div>
      </div>`;
    return `<div class="cmd">
      ${tapeBanner()}
      ${marketBanner()}
      ${chartSliderHtml("ol", outlookSlideInnerHtml)}
      ${gateHtml()}
      ${wizard}
      ${agents.length || testerAgents().length ? `<div class="card" id="ea-strip" style="margin:0"><h3 style="margin:0 0 8px">${I18N.t("nav.charts")}</h3><div class="hero-chips">${agents.map((a) => `<span class="pill is-live"><i class="dot live"></i>${esc(a.symbol)} · ${esc(a.timeframe || "")} · ${I18N.t(isTesterAgent(a) ? "tape.backtest" : "tape.live")}</span>`).join("")}${testerAgents().map((a) => `<span class="pill is-backtest">${esc(a.symbol)} · ${esc(a.timeframe || "")} · ${I18N.t("tape.backtest")}</span>`).join("")}</div></div>` : ""}
      <div class="cmd-strip">
        ${kpi("command.equity", acc.equity, acc.currency)}
        ${kpi("command.profit", acc.profit, acc.currency, true)}
        ${kpi("command.daily_pl", prop.daily_pl_pct, "%", true)}
        ${kpi("command.drawdown", prop.drawdown_pct, "%")}
        ${kpi("command.balance", acc.balance, acc.currency)}
        ${kpi("command.margin", acc.margin, acc.currency)}
      </div>
      <!-- Positions get the full width of the command centre.
           They used to share a two-column row with the account card and an
           AI summary, which left the close button squeezed against the edge
           of a horizontally scrolling table - the one control on this screen
           that is pressed in a hurry.

           The AI summary is gone rather than moved: it printed a single
           bias with no symbol next to it, so on a desk with four charts
           open it was not merely unhelpful, it was ambiguous in a direction
           a trader could act on. The per-chart version in the Intelligence
           view says which symbol it means, and that is where it belongs. -->
      <div class="card pos-card">
        <h3>${I18N.t("command.positions")}</h3>
        <div id="live-pos">${pos.length ? table(pos, ["symbol","type","volume","strategy","price_open","price_current","sl","tp","profit","profit_pct"], true) : emptyMini(I18N.t("status.no_positions"))}</div>
      </div>
      <div class="card">
        <h3>${I18N.t("account.type")}</h3>
        <p class="metric" id="cmd-acc-type">${accTypeLabel(acc.account_label || acc.account_type || "unknown")}</p>
        <p class="sub">${[acc.company, acc.server, acc.margin_mode, acc.leverage ? "1:"+acc.leverage : ""].filter(Boolean).join(" · ")}</p>
        <div class="kv" style="margin-top:12px">
          <span>${I18N.t("command.free_margin")}</span><b class="mono" data-metric="command.free_margin">${fmt(acc.margin_free)} ${acc.currency||""}</b>
          <span>${I18N.t("command.leverage")}</span><b class="mono" data-metric="command.leverage">${acc.leverage ? "1:"+acc.leverage : "—"}</b>
        </div>
      </div>
      <div class="card" id="live-st-wrap">
        <h3>${I18N.t("strategies.live")}</h3>
        <div class="grid g-2" id="live-st">${strategyLiveCards()}</div>
      </div>
    </div>`;
  },
  markets() {
    const ticks = S.snap?.ticks || {};
    const items = liveSymbols();
    const symbols = items.map((x) => x.symbol);
    const live = mt5Live();
    return `<div class="grid g-chart mk">
      <div class="card mk-chart">
        <!-- One toolbar instead of two stacked rows. The instrument controls
             and the signal switches used to sit on separate lines, which on
             a phone meant four rows of chrome above a chart that had barely
             any height left. -->
        <div class="mk-bar">
          <div class="mk-pick">
            ${symbolSelectHtml("sym", S.symbol)}
            <select class="ctrl" id="tf">${["M1","M5","M15","M30","H1","H4","D1"].map((t)=>`<option ${t===S.timeframe?"selected":""}>${t}</option>`).join("")}</select>
          </div>
          <span class="legend mono mk-tick" id="tick-lbl">${tickLabel()}</span>
          <div class="mk-sig">
            <button type="button" class="btn tiny ${S.signalsEnabled?"on":"ghost"}" id="sig-toggle-m">${S.signalsEnabled?icon("bell")+" Signals ON":icon("bellOff")+" Signals OFF"}</button>
            <button type="button" class="btn tiny ghost" id="sig-show-m" style="${S.signalsEnabled?"":"display:none"}">${S.showSignals?icon("eye"):icon("eyeOff")}</button>
            ${!licFeat("chart_signals")?`<span class="pill no" style="font-size:10px">PREMIUM</span>`:""}
          </div>
        </div>
        ${positionsStripHtml(S.symbol)}
        <div class="chart-box"><canvas id="cv"></canvas>${!eaLive() || !S.candles.length ? emptyCard(I18N.t("markets.empty"), symbols.length ? I18N.t("markets.loading_tf") : I18N.t("exec.no_ea_symbol")) : ""}</div>
        ${eaLive() ? chartTicketHtml() : ""}
        <!-- Chart signals list removed per user request — signals only on chart canvas itself -->
      </div>
      <div class="card mk-watch">
        <h3>${I18N.t("markets.title")}</h3>
        <div id="live-ticks">${symbols.length ? watchlistHtml() : emptyMini(I18N.t("exec.no_ea_symbol"))}</div>
      </div>
    </div>`;
  },
  intelligence() {
    // v54: merged slider — direction+regime per chart, features per selected chart
    const cur = currentAiSlideState() || S.snap?.ai || {};
    const feed = (cur.activity || S.snap?.ai?.activity || []).slice(-16).reverse();
    const rg = cur.regime_obj || cur.regime;
    const pat = cur.pattern_obj || cur.pattern;
    const feats = cur.features || {};
    return `${analysisCardHtml()}
    <div class="grid g-2">
      <div class="card">${chartSliderHtml("ai", aiSlideInnerHtml)}</div>
      <div class="card">
        <h3>${I18N.t("ai.regime")} · ${I18N.t("ai.direction")} (per chart)</h3>
        <p class="metric" id="ai-regime">${regLabel(typeof rg === "string" ? {name: rg} : rg)}</p>
        <p class="sub">${esc((rg && typeof rg === "object" ? rg.reason : "") || "")}</p>
        <h3 style="margin-top:16px">${I18N.t("ai.pattern")}</h3>
        <p class="metric" id="ai-pattern" style="font-size:20px">${esc(typeof pat === "string" ? pat : (pat?.name || "—"))}</p>
        <p class="sub">${esc((pat && typeof pat === "object" ? pat.reason : "") || I18N.t("status.ai_idle"))}</p>
        <p class="sub" style="margin-top:8px">${I18N.t("chart.regime_hint")}</p>
      </div>
      <div class="card">
        <h3>${I18N.t("ai.activity")}</h3>
        <div class="ai-feed term" id="ai-feed">${feed.length ? feed.map((row) => `<div class="row-line"><span class="ts">${esc(row.ts || "")}</span><span>${esc(row.text || "")}</span></div>`).join("") : emptyMini(I18N.t("status.ai_idle"))}</div>
      </div>
      <div class="card">
        <h3>${I18N.t("ai.features")} <span class="slide-sym mono" id="ai-feat-sym">${esc(cur.symbol || "")}</span></h3>
        <div class="kv" id="ai-feat">${Object.keys(feats).length ? Object.entries(feats).slice(0,18).map(([k,v])=>`<span>${esc(k)}</span><b class="mono">${fmt(v,5)}</b>`).join("") : emptyMini(I18N.t("status.ai_idle"))}</div>
        <p class="sub" id="ai-why">${esc((cur.confidence_why && cur.confidence_why.text) || cur.reason || I18N.t("ai.conf_help"))}</p>
        <div class="row" style="margin-top:14px">
          <button class="btn tiny ghost" id="btn-train" type="button">${I18N.t("ai.retrain")}</button>
          <span class="sub">${I18N.t("ai.auto_learn")} · ${I18N.t("ai.samples")}: <b class="mono" id="ai-samples">${cur.samples || 0}</b>${cur.need ? " / " + cur.need : ""}</span>
        </div>
      </div>
    </div>`;
  },
  calendar() {
    // The renderer assigns innerHTML synchronously, so an async view would
    // print "[object Promise]".  Ship the shell and let bindView fill it.
    return `<div class="cmd" id="cal-root"><div class="empty">${esc(I18N.t("telegram.loading"))}</div></div>`;
  },
  strategies() {
    const st = S.snap?.strategy || {};
    const sig = S.snap?.last_signal;
    /* Wrapped in .cmd like every other view. Without it the three blocks
       were loose in the page and leaned on sibling margins to space
       themselves, which is what left the banner sitting at a different
       distance from the cards than the cards sit from each other. */
    return `<div class="cmd">
      <div class="card auto-banner">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("strategies.live")}</h3>
          <p class="sub">${st.auto_trade ? I18N.t("exec.auto_on") : I18N.t("exec.auto_off")} · ${I18N.t("style.title")}: ${I18N.t("style." + (st.trade_style||"normal"))}</p>
          <p class="sub" style="opacity:.85">${I18N.t("strategies.single_rule")}</p>
        </div>
        <span class="pill" id="st-live-sig">${sig ? `${sig.action||"—"} ${sig.symbol||""}` : I18N.t("strategies.waiting")}</span>
      </div>
      <div class="grid g-2" id="st-live-grid">${strategyLiveCards()}</div>
      ${strategyUploadCard()}
    </div>`;
  },
  execution() {
    const pos = S.snap?.positions || [];
    const orders = S.snap?.orders || [];
    const st = S.snap?.strategy || {};
    const armed = Boolean(st.auto_trade);
    const sig = S.snap?.last_signal;
    return `<div class="cmd">${gateHtml()}<div class="grid g-2">
      <div class="card">
        <div class="auto-banner">
          <div>
            <h3 style="margin:0 0 6px">${I18N.t("exec.auto")}</h3>
            <p class="sub">${armed ? I18N.t("exec.auto_on") : I18N.t("exec.auto_off")}</p>
            <p class="sub">${I18N.t("exec.auto_hint")}</p>
          </div>
          <button type="button" class="switch ${armed?"on":""}" id="ex-auto"><i></i></button>
        </div>
        <div class="kv" id="live-signal">
          <span>${I18N.t("exec.last_signal")}</span><b>${sig ? `${sig.action||"—"} ${sig.symbol||""}` : "—"}</b>
          <span>${I18N.t("strategies.active")}</span><b>${st.name || I18N.t("strategies.none")}</b>
        </div>
        <button class="btn danger block" id="ex-flat" type="button" style="margin-top:14px">${I18N.t("exec.emergency")}</button>
        <div class="manual-box">
          <h3 style="margin:0 0 8px">${I18N.t("exec.manual")}</h3>
          <p class="sub">${I18N.t("exec.manual_hint")}</p>
          <div class="grid g-2">
            <label class="field"><span>${I18N.t("markets.symbol")}</span>${symbolSelectHtml("ex-sym", defaultSymbol())}</label>
            <label class="field"><span>${I18N.t("exec.volume")}</span><input id="ex-vol" type="number" step="0.01" min="0.01" value="0.10" /></label>
            <label class="field"><span>${I18N.t("exec.sl")}</span><input id="ex-sl" type="number" step="0.0001" value="" placeholder="0" /></label>
            <label class="field"><span>${I18N.t("exec.tp")}</span><input id="ex-tp" type="number" step="0.0001" value="" placeholder="0" /></label>
          </div>
          <p class="sub" id="ex-ea-hint">${liveSymbols().length ? I18N.t("exec.pick_symbol") : I18N.t("exec.no_ea_symbol")}</p>
          <div class="row" style="margin-top:8px">
            <button class="btn" id="ex-buy" type="button"${liveSymbols().length ? "" : " disabled"}>${I18N.t("exec.buy")}</button>
            <button class="btn danger" id="ex-sell" type="button"${liveSymbols().length ? "" : " disabled"}>${I18N.t("exec.sell")}</button>
          </div>
          <p class="sub" id="ex-msg"></p>
        </div>
        ${mt5Live()?"":`<p class="sub" style="margin-top:10px">${I18N.t("errors.no_mt5")}</p>`}
      </div>
      <div class="card">
        <h3>${I18N.t("command.positions")}</h3>
        <div id="live-exec-pos">${pos.length ? table(pos, ["ticket","symbol","type","volume","strategy","price_open","sl","tp","profit","profit_pct"], true) : emptyMini(I18N.t("status.no_positions"))}</div>
        <h3 style="margin-top:16px">${I18N.t("status.no_orders")}</h3>
        <div id="live-exec-ord">${orders.length ? table(orders, ["ticket","symbol","type","volume","price"]) : emptyMini(I18N.t("status.no_orders"))}</div>
      </div>
    </div>
    ${robotPanelBox()}</div>`;
  },
  charts() {
    if (S.chartFocus) {
      const f = S.chartFocus;
      // The workspace - top bar, drawing rail, chart, dock - is built by
      // js/chart-tools.js from its own tool table. The desk only tells it
      // what is being charted and hands it the order ticket to carry.
      if (typeof AurionChartUI === "undefined") {
        return `<div class="card">${emptyCard(I18N.t("errors.generic"), "chart-tools.js")}</div>`;
      }
      return AurionChartUI.html({
        symbol: f.symbol,
        timeframe: f.timeframe,
        ticket: chartTicketHtml(),
      });
    }
    const agents = liveAgents();
    const testers = testerAgents();
    const chartCard = (a, tester, clickable) => `<div class="card chart-card"${clickable ? " data-open-chart" : ""} data-sym="${a.symbol||""}" data-tf="${a.timeframe||""}">
      <h3>${a.symbol || "—"} · ${a.timeframe || ""} <span class="pill ${tester ? "is-backtest" : ""}" style="font-size:11px">${I18N.t(tester ? "tape.backtest" : "tape.live")}</span></h3>
      <p class="metric" style="font-size:18px">${a.ea_name || "AurionBridge"}</p>
      <div class="kv">
        <span>${I18N.t("charts.chart")}</span><b class="mono">${a.chart_id || "—"}</b>
        <span>${I18N.t("charts.signal")}</span><b>${a.last_signal?.direction || a.last_signal?.action || "—"}</b>
        <span>${I18N.t("charts.state")}</span><b>${a.status || "online"}</b>
      </div>
      ${tester && !clickable ? `<p class="sub">${I18N.t("tape.showing_backtest")}</p>` : `${positionsStripHtml(a.symbol)}
      <div class="chart-box" style="height:200px"><canvas data-mini="${a.symbol||""}" data-tf="${a.timeframe||""}"></canvas></div>
      <p class="sub">${I18N.t("charts.open_hint")}</p>`}
    </div>`;
    if (agents.length || testers.length) {
      return `${testers.length ? `<h3 style="margin:4px 0 8px">${I18N.t("tape.backtest")}</h3><div class="grid g-2">${testers.map((a) => chartCard(a, true, false)).join("")}</div>` : ""}
      ${agents.length ? `<div class="grid g-2">${agents.map((a) => chartCard(a, isTesterAgent(a), true)).join("")}</div>` : ""}`;
    }
    return `<div class="card">${emptyCard(I18N.t("status.no_eas"), I18N.t("wizard.step3") + " — " + I18N.t("charts.empty_hint"))}</div>`;
  },
  terminal() {
    return `<div class="card">
      <div class="tabs" id="term-tabs">
        <button type="button" data-term="live" class="on">${I18N.t("terminal.live")}</button>
        <button type="button" data-term="robot">${I18N.t("terminal.robot")}</button>
        <button type="button" data-term="engine">${I18N.t("terminal.engine")}</button>
        <button type="button" data-term="desk">${I18N.t("terminal.desk")}</button>
      </div>
      <p class="sub" id="term-hint">${I18N.t("terminal.hint")}</p>
      <div class="row" style="margin:10px 0;flex-wrap:wrap;gap:8px" id="term-live-tools">
        <input class="ctrl grow" id="log-q" data-i18n-ph="terminal.placeholder" placeholder="" style="flex:1;min-width:180px" />
        <button class="btn tiny ghost" id="log-clr" type="button">${I18N.t("terminal.clear")}</button>
        <button class="btn tiny" id="term-restart" type="button" title="Immediate restart of system terminals">${icon("refresh")} ${I18N.t("terminal.restart")||"Restart Terminals"}</button>
      </div>
      <div class="term" id="term">${renderLogs()}</div>
    </div>`;
  },
  backtest() {
    const bt = S.backtest || S.snap?.backtest || {};
    const items = liveSymbols();
    const stItems = strategyItems();
    const running = Boolean(bt.running);
    return `<div class="cmd">
      ${tapeBanner()}
      <div class="card" id="bt-card">
        <h3>${icon("flask")} ${I18N.t("history.backtest")}</h3>
        <p class="sub">${I18N.t("history.backtest_hint")}</p>
        <div class="ct-grid ct-grid-3">
          <label class="field"><span>${I18N.t("markets.symbol")}</span>${symbolSelectHtml("bt-sym", S.symbol)}</label>
          <label class="field"><span>${I18N.t("markets.timeframe")}</span>
            <select class="ctrl" id="bt-tf">${["M1","M5","M15","M30","H1","H4","D1"].map((t)=>`<option ${t===(S.timeframe||"M15")?"selected":""}>${t}</option>`).join("")}</select>
          </label>
          <label class="field"><span>${I18N.t("strategies.active")}</span>
            <select class="ctrl" id="bt-st">${stItems.map((it)=>`<option value="${esc(it.name)}">${esc(it.name)}</option>`).join("")}</select>
          </label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn" id="h-bt" type="button"${running || !items.length ? " disabled" : ""}>${running ? I18N.t("history.backtest_running") : I18N.t("history.backtest_run")}</button>
        </div>
        <div id="bt-load" class="bt-load${running ? "" : " hidden"}"><i></i><span>${I18N.t("history.backtest_wait")}</span></div>
      </div>
      <!-- One container for everything a run produces. The summary used to
           sit in the form card above and the curve down here, so a finished
           result was split across two cards with the form wedged between
           them. Running state, summary and detail now share this card. -->
      <div class="card" id="bt-extra-card">
        <h3>${icon("chart")} ${I18N.t("bt.results")}</h3>
        <p class="sub">${I18N.t("bt.results_hint")}</p>
        <div id="bt-live">${renderBacktestLive(bt)}</div>
        <div id="bt-result">${renderBacktestCard(bt)}</div>
        <div id="bt-extra">${renderBacktestExtra(bt)}</div>
      </div>
    </div>`;
  },
  history() {
    return `<div class="cmd">
      ${tapeBanner()}
      <div class="card">
        <div class="row" style="margin-bottom:12px;flex-wrap:wrap">
          <button class="btn tiny" id="h-exp" type="button">${I18N.t("history.export")}</button>
          <button class="btn tiny ghost" id="h-rst" type="button">${I18N.t("history.reset")}</button>
        </div>
        <h3>${I18N.t("history.live_ledger")}</h3>
        <div id="h-body">${emptyMini(I18N.t("status.no_history"))}</div>
      </div>
    </div>`;
  },
  upgrade() {
    const L = (S.snap && S.snap.license) || {};
    const premium = Boolean(L.premium);
    const days = L.days_left;
    const total = Number((L.plans && L.plans[L.plan] && L.plans[L.plan].days) || 0);
    const pct = premium && total ? Math.max(0, Math.min(100, Math.round((days || 0) / total * 100))) : 0;
    const feats = [
      ["prop", "upgrade.f_prop"],
      ["scalping", "upgrade.f_scalp"],
      ["strategy_upload", "upgrade.f_upload"],
      ["telegram", "upgrade.f_telegram"],
      ["news", "upgrade.f_news"],
      ["chart_signals", "upgrade.f_chart_signals"],
      ["volume_mode", "upgrade.f_volume"],
      ["themes", "upgrade.f_themes"],
    ];
    return `<div class="cmd">
      <div class="card up-hero ${premium ? "is-premium" : "is-free"}">
        <div>
          <p class="kicker">${I18N.t("upgrade.now")}</p>
          <h3 class="up-type">${premium ? esc(heroPlanLabel(L)) : I18N.t("lic.freemium")}</h3>
          <p class="sub">${premium ? I18N.t("upgrade.prem_note") : I18N.t("upgrade.free_note")}</p>
        </div>
        <span class="up-badge">${premium ? "PRO" : "FREE"}</span>
      </div>
      ${premium ? `<div class="card">
        <div class="kv">
          <span>${I18N.t("lic.plan")}</span><b>${esc(planLabel(L))}</b>
          <span>${I18N.t("lic.activated")}</span><b>${esc(licDate(L.activated))}</b>
          <span>${I18N.t("lic.expires")}</span><b>${esc(licDate(L.expires))}</b>
          <span>${I18N.t("upgrade.days")}</span><b class="mono">${days == null ? "—" : fmt(days, 0)}</b>
        </div>
        ${total ? `<div class="bar" style="margin-top:12px"><i style="--w:${pct}%"></i></div>` : ""}
      </div>` : ""}
      <div class="grid g-2">
        <div class="card">
          <h3>${I18N.t("upgrade.features")}</h3>
          <div class="kv up-feats">
            ${feats.map(([f, key]) => {
              const open = licFeat(f);
              return `<span>${I18N.t(key)}</span><b class="${open ? "up" : "down"}">${open ? I18N.t("upgrade.unlocked") : I18N.t("upgrade.locked")}</b>`;
            }).join("")}
          </div>
        </div>
        <div class="card">
          <h3>${I18N.t("upgrade.buy")}</h3>
          <p class="sub">${I18N.t("upgrade.store_hint")}</p>
          <button class="btn block" id="up-store" type="button"${L.store_url ? "" : " disabled"}>${I18N.t("keygate.buy")}</button>
          ${L.store_url ? "" : `<p class="err">${I18N.t("upgrade.store_unset")}</p>`}
          <h3 style="margin-top:18px">${I18N.t("upgrade.have_key")}</h3>
          <p class="sub">${I18N.t("upgrade.enter_hint")}</p>
          <label class="field"><span>${I18N.t("keygate.key")}</span>
            <input id="up-key" dir="ltr" spellcheck="false" autocomplete="off" placeholder="AXIA-M1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" />
          </label>
          <button class="btn block" id="up-go" type="button">${I18N.t("keygate.activate")}</button>
          <p class="err" id="up-err"></p>
          <p class="ok" id="up-result"></p>
        </div>
      </div>
    </div>`;
  },
  settings() {
    const mt = S.snap?.mt5 || {};
    const tab = S.setTab || "set-robot";
    const fa = (S.lang || I18N.lang || "fa") === "fa";
    const tabBtn = (id, label, ic, desc) => `<button type="button" data-jump="${id}" class="${tab===id?"on":""}">
        <span class="sj-ic">${icon(ic)}</span><span class="sj-txt"><b>${label}</b>${desc ? `<small>${desc}</small>` : ""}</span></button>`;
    const grp = (label) => `<div class="sj-grp">${label}</div>`;
    return `<div class="set-desk set-rail"><nav class="set-jump" id="set-jump" aria-label="settings">
        ${grp(I18N.t("rail.trading"))}
        ${tabBtn("set-robot", I18N.t("settings.sec_robot"), "bolt", I18N.t("rail.robot_hint"))}
        ${tabBtn("set-strats", I18N.t("nav.strategies"), "layers", I18N.t("rail.strats_hint"))}
        ${tabBtn("set-prop", I18N.t("risk.title"), "shield", I18N.t("rail.prop_hint"))}
        ${tabBtn("set-mt5", "MetaTrader 5", "term", I18N.t("rail.mt5_hint"))}
        ${grp(I18N.t("rail.personalize"))}
        ${tabBtn("set-lang", I18N.t("settings.language"), "book", I18N.t("rail.lang_hint"))}
        ${tabBtn("set-personal", I18N.t("settings.personal"), "user", I18N.t("rail.personal_hint"))}
        ${tabBtn("set-notify", I18N.t("notify.title"), "bell", I18N.t("rail.notify_hint"))}
        ${tabBtn("set-telegram", I18N.t("telegram.title"), "spark", I18N.t("rail.telegram_hint"))}
        ${grp(I18N.t("rail.system"))}
        ${tabBtn("set-update", I18N.t("upd.title"), "pulse", I18N.t("rail.update_hint"))}
        ${tabBtn("set-system", I18N.t("host.system"), "gear", I18N.t("rail.system_hint"))}
      </nav><div class="set-main">
      <section class="set-block" id="set-robot"${tab==="set-robot"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("settings.sec_robot")}</h2>
        ${robotPanelHtml()}
      </section>
      <section class="set-block" id="set-strats"${tab==="set-strats"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("strategies.live")}</h2>
        <p class="sub" style="margin:0 0 10px">${I18N.t("strategies.single_rule")}</p>
        <div class="grid g-2" id="st-live-grid">${strategyLiveCards()}</div>
        ${licFeat("strategy_upload") ? `<div class="card" style="margin-top:14px">
          <h3>${I18N.t("strategies.upload")}</h3>
          <textarea id="st-src" class="ctrl" style="min-height:120px;width:100%;resize:vertical" placeholder="# Python strategy"></textarea>
          <div class="row" style="margin-top:10px;align-items:center;gap:8px">
            <input class="ctrl" id="st-file" placeholder="my_strategy.py" />
            <button class="btn tiny" id="st-up" type="button">${I18N.t("strategies.upload")}</button>
            <a class="btn tiny ghost" id="st-tpl" href="#">${I18N.t("strategies.template")}</a>
            <a class="btn tiny ghost" id="st-cancel" href="#" hidden>${I18N.t("strategies.cancel")}</a>
          </div>
          <p class="sub" id="st-up-msg"></p>
        </div>` : `<div style="margin-top:14px">${lockedUpgradeCard("strategy_upload")}</div>`}
      </section>
      <section class="set-block" id="set-prop"${tab==="set-prop"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("risk.title")}</h2>
        ${licFeat("prop") ? `${propStatusHtml()}<div class="card">${propFormHtml()}</div>${propGuideHtml()}` : lockedUpgradeCard("prop")}
      </section>
      <section class="set-block" id="set-mt5"${tab==="set-mt5"?"":" hidden"}>
        <h2 class="set-title">MetaTrader 5</h2>
        <div class="card">
          <label class="field"><span data-i18n="settings.mt5_path"></span><input id="s-path" /></label>
          <label class="field"><span data-i18n="settings.mt5_login"></span><input id="s-login" type="number" /></label>
          <label class="field"><span data-i18n="settings.mt5_server"></span><input id="s-server" /></label>
          <label class="field"><span data-i18n="settings.mt5_password"></span><input id="s-pass" type="password" /></label>
          <p class="sub" data-i18n="settings.password_note"></p>
          <div class="row" style="margin-top:10px">
            <button class="btn" id="s-save" type="button">${I18N.t("settings.save")}</button>
            <button class="btn" id="s-con" type="button">${I18N.t("settings.connect")}</button>
            <button class="btn ghost" id="s-dis" type="button">${I18N.t("settings.disconnect")}</button>
          </div>
          <p class="sub" id="s-msg">${mt.last_error || (mt.connected ? I18N.t("status.mt5_live") : I18N.t("status.mt5_down"))}</p>
        </div>
      </section>
      <section class="set-block" id="set-lang"${tab==="set-lang"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("settings.language")}</h2>
        <div class="card">
          <div class="lang-pills" id="set-langs">
            <button type="button" data-lang="en">English</button>
            <button type="button" data-lang="fa">فارسی</button>
            <button type="button" data-lang="ar">العربية</button>
          </div>
          <p class="sub">AURION 1.0.0 · <span class="mono" id="build-tag">${esc(buildTag())}</span></p>
          <a class="btn block ghost" href="guide.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.open")}</a>
          <a class="btn block ghost" href="guide-backtest.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.backtest")}</a>
        </div>
      </section>
      <section class="set-block" id="set-personal"${tab==="set-personal"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("settings.personal")}</h2>
        <div class="card">
          <p class="sub" style="margin:0 0 6px">${I18N.t("settings.theme")}</p>
          <div class="lang-pills" id="set-themes">
            <button type="button" data-themebtn="auto">${icon("themeAuto")} ${I18N.t("settings.theme_auto")}</button>
            <button type="button" data-themebtn="dark">${icon("moon")} ${I18N.t("settings.theme_dark")}</button>
            <button type="button" data-themebtn="light">${icon("sun")} ${I18N.t("settings.theme_light")}</button>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:16px;align-items:flex-start">
            <div>
              <div style="font-weight:600">${I18N.t("settings.liquid_glass")}</div>
              <p class="sub" style="margin:2px 0 0">${I18N.t("settings.liquid_glass_hint")}</p>
              <p class="sub glass-forced-note" style="margin:4px 0 0">${I18N.t("settings.liquid_glass_forced")}</p>
            </div>
            <button type="button" class="switch ${glassOn()?"on":""}" id="sw-glass" aria-pressed="${glassOn()}"${glassForced() ? " disabled aria-disabled=\"true\"" : ""}><i></i></button>
          </div>
        </div>
        ${appearanceCardsHtml()}
      </section>
      <section class="set-block" id="set-notify"${tab==="set-notify"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("notify.title")}</h2>
        ${notifySoundCardHtml()}
      </section>
      <section class="set-block" id="set-telegram"${tab==="set-telegram"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("telegram.title")}</h2>
        ${licFeat("telegram") ? telegramPanelHtml() : lockedUpgradeCard("telegram")}
      </section>
      <section class="set-block" id="set-update" hidden>
        <h2 class="set-title">${I18N.t("upd.title")}</h2>
        <div class="card">
          <h3>${I18N.t("upd.settings")}</h3>
          <label class="field" style="flex-direction:row;align-items:center;justify-content:space-between;margin-top:12px">
            <span>${I18N.t("upd.auto")}</span>
            <button type="button" class="switch" id="upd-auto"><i></i></button>
          </label>
          <label class="field"><span>${I18N.t("upd.interval")}</span>
            <input id="upd-interval" type="number" min="1" max="168" value="6" />
          </label>
          <button class="btn block" id="upd-save" type="button">${I18N.t("upd.save")}</button>
          <p class="sub" id="upd-save-msg"></p>
        </div>
        <div class="card" style="margin-top:14px">
          <h3>${I18N.t("upd.status")}</h3>
          <p class="sub" id="upd-last-check">${I18N.t("upd.last_check")}: -</p>
          <div id="upd-status"></div>
          <div class="row" style="margin-top:10px;gap:8px">
            <button class="btn" id="upd-check" type="button">${icon("search")} ${I18N.t("upd.check")}</button>
            <button class="btn ghost" id="upd-manifest" type="button">${icon("clipboard")} ${I18N.t("upd.manifest")}</button>
          </div>
          <div id="upd-result" style="margin-top:12px"></div>
        </div>
      </section>
      <section class="set-block" id="set-system"${tab==="set-system"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("host.system")}</h2>
        ${expertsCardHtml()}
        ${timezoneCardHtml()}
        <div class="card">
          <h3>${I18N.t("host.restart")}</h3>
          <p class="sub">${I18N.t("host.restart_hint")}</p>
          <button class="btn block" id="sys-restart" type="button">${I18N.t("host.restart")}</button>
        </div>
        <div class="card danger-zone" id="danger-zone">
          <h3>${I18N.t("host.factory")}</h3>
          <p class="sub">${I18N.t("host.factory_hint")}</p>
          <label class="field"><span>${I18N.t("host.factory_type")}</span>
            <input id="factory-confirm" autocomplete="off" placeholder="FACTORY" />
          </label>
          <button class="btn danger block" id="sys-factory" type="button">${I18N.t("host.factory_go")}</button>
        </div>
      </section></div></div>`;
  },
  about() {
    const ver = S.version || S.snap?.version || S._gateLic?.version || "1.0.0";
    const L = (S.snap && S.snap.license) || {};
    const buildDate = S.buildDate || new Date().toISOString().slice(0,10);
    return `<div class="cmd">
      <div class="card" style="text-align:center;padding:32px 24px">
        <div style="width:96px;height:96px;margin:0 auto 16px;border-radius:24px;overflow:hidden;background:var(--deep);box-shadow:0 12px 32px rgba(0,0,0,.4)">
          <img src="icons/mark.png?v=desk49" alt="AURION" style="width:100%;height:100%;object-fit:cover;transform:scale(1.08)" />
        </div>
        <h2 style="margin:0 0 6px;font-size:28px;letter-spacing:.12em">AURION</h2>
        <p class="sub" style="font-size:14px">${I18N.t("about.version")} <b class="mono" style="color:var(--cyan)">v${esc(ver)}</b> • ${I18N.t("about.build")} ${esc(buildDate)}</p>
        <p class="sub" style="margin-top:12px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.8">${I18N.t("about.blurb")}</p>
        <div style="margin:20px auto 0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <span class="pill ok">MT5 Live</span>
          <span class="pill ok">AI ${L.premium? 'PRO' : 'Free'}</span>
          <span class="pill">Prop Guard</span>
          <span class="pill">v${esc(ver)}</span>
        </div>
      </div>
      <div class="grid g-2">
        <div class="card">
          <h3>${icon("wrench")} ${I18N.t("about.specs")}</h3>
          <div class="kv">
            <span>${I18N.t("about.sys_name")}</span><b>AURION</b>
            <span>${I18N.t("about.version")}</span><b class="mono">v${esc(ver)}</b>
            <span>${I18N.t("about.state")}</span><b>${S.snap?.engine === 'online' ? I18N.t("about.online") + ' <i class="dot live" aria-hidden="true"></i>' : I18N.t("about.offline") + ' <i class="dot down" aria-hidden="true"></i>'}</b>
            <span>MT5</span><b>${mt5Live() ? I18N.t("about.connected") + ' <i class="dot live" aria-hidden="true"></i>' : I18N.t("about.disconnected") + ' <i class="dot down" aria-hidden="true"></i>'}</b>
            <span>EA Charts</span><b class="mono">${liveAgents().length}</b>
            <span>${I18N.t("about.active_strategy")}</span><b>${esc(S.snap?.strategy?.name||'—')}</b>
            <span>${I18N.t("about.autotrade")}</span><b>${S.snap?.strategy?.auto_trade ? I18N.t("about.on") + ' <i class="dot live" aria-hidden="true"></i>' : I18N.t("about.off") + ' <i class="dot down" aria-hidden="true"></i>'}</b>
            <span>${I18N.t("about.kill")}</span><b>${S.snap?.kill_switch ? I18N.t("about.armed") + ' <i class="dot down" aria-hidden="true"></i>' : I18N.t("about.off") + ' <i class="dot live" aria-hidden="true"></i>'}</b>
            <span>Prop</span><b>${S.snap?.prop?.enabled !== false ? I18N.t("about.enabled") + ' <i class="dot live" aria-hidden="true"></i>' : I18N.t("about.disabled") + ' <i class="dot down" aria-hidden="true"></i>'}</b>
            <span>${I18N.t("about.language")}</span><b>${I18N.lang.toUpperCase()}</b>
          </div>
        </div>
        <div class="card">
          <h3>${icon("building")} ${I18N.t("about.maker")}</h3>
          <div style="display:flex;align-items:center;gap:14px;margin:12px 0">
            <img src="assets/axiasoft-logo.png?v=desk49" alt="Axiasoft" style="width:56px;height:56px;object-fit:contain;background:transparent;border:none;border-radius:0" />
            <div>
              <b style="font-size:18px">Axiasoft</b><br>
              <span class="sub">${I18N.t("about.developer_of")} • 2024-${copyrightYear()}</span>
            </div>
          </div>
          <div class="kv" style="margin-top:12px">
            <span>${I18N.t("about.product")}</span><b>AURION Live Desk</b>
            <span>${I18N.t("about.license")}</span><b>${L.premium ? planLabel(L) : 'Freemium'}</b>
            <span>${I18N.t("about.support")}</span><b>support@axiasoft</b>
            <span>${I18N.t("about.update")}</span><b id="about-update-status">${I18N.t("about.checking")}</b>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn tiny" id="about-check-update" type="button">${icon("refresh")} ${I18N.t("about.check")}</button>
            <button class="btn tiny ghost" id="about-copy-ver" type="button">${icon("clipboard")} ${I18N.t("about.copy_ver")}</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>${icon("clipboard")} ${I18N.t("about.changelog")}</h3>
        <div id="about-changelog" class="sub" style="max-height:240px;overflow:auto;line-height:1.8">
          <p>${I18N.t("upd.loading")}</p>
        </div>
      </div>
    </div>`;
  },
  profile() {
    const u = S.user || {};
    const L = (S.snap && S.snap.license) || {};
    const paid = Boolean(L.paid || L.developer);
    const initials = String(u.display_name || u.username || "A").replace(/[^A-Za-z0-9\u0600-\u06FF]/g, "").slice(0, 2).toUpperCase() || "A";
    const since = u.created ? String(u.created).slice(0, 10) : "—";
    const last = u.last_login ? String(u.last_login).replace("T", " ").slice(0, 16) : "—";
    const popular = "m6";
    const toman = (rial) => rial ? fmt(rial / 10, 0) : "—";
    const plans = (S.plans || []).map((p) => {
      const on = S._plan === p.id ? " on" : "";
      const pop = p.id === popular ? " popular" : "";
      const per = p.amount && p.days ? fmt((p.amount / 10) / (p.days / 30), 0) : "—";
      return `<button type="button" class="plan-card${on}${pop}" data-plan="${p.id}">
        ${p.id === popular ? `<span class="plan-tag">${I18N.t("profile.popular")}</span>` : ""}
        <h4>${esc(p.label)}</h4>
        <div class="plan-price"><b>${toman(p.amount)}</b><small>${I18N.lang === "en" ? "Toman" : I18N.t("profile.per_month")}</small></div>
        <p class="plan-per">${per} · ${I18N.t("profile.per_month")}</p>
        <ul>
          <li>${I18N.t("profile.feature_live")}</li>
          <li>${I18N.t("profile.feature_days", { n: p.days })}</li>
          <li>${I18N.t("profile.feature_renew")}</li>
        </ul>
      </button>`;
    }).join("");
    const pays = (S.pays || []).map((p) => `<div class="pay-row"><span>${esc(p.plan)} · ${esc(p.status)}</span><b class="mono">${p.amount ? fmt(p.amount / 10, 0) : "—"}</b></div>`).join("");
    const tz = u.timezone || "Asia/Tehran";
    const zones = ["Asia/Tehran", "UTC", "Europe/Berlin", "Europe/London", "Asia/Dubai", "America/New_York"];
    return `<div class="cmd">
      <div class="card">
        <div class="prof-hero">
          <div class="prof-ava">${esc(initials)}</div>
          <div>
            <h2 class="set-title" style="margin:0">${esc(u.display_name || u.username || I18N.t("profile.title"))}</h2>
            <p class="sub">@${esc(u.username || "")}</p>
            <div class="prof-meta">
              <span class="chip on">${esc(u.role || "trader")}</span>
              <span class="chip">${I18N.t("profile.member")} ${esc(since)}</span>
              <span class="chip">${I18N.t("profile.last_seen")} ${esc(last)}</span>
              <button type="button" class="chip" id="pf-copy">@${esc(u.username || "")} · ${I18N.t("profile.copy")}</button>
            </div>
          </div>
        </div>
        <div class="grid g-2" style="margin-top:16px">
          <label class="field"><span>${I18N.t("profile.name")}</span><input id="pf-name" value="${esc(u.display_name || "")}" placeholder="${esc(I18N.t("profile.name_ph"))}" /></label>
          <label class="field"><span>${I18N.t("profile.tz")}</span>
            <select class="ctrl" id="pf-tz">${zones.map((z) => `<option value="${z}" ${z === tz ? "selected" : ""}>${z}</option>`).join("")}</select>
          </label>
        </div>
        <div class="lang-pills" id="pf-langs" style="margin:8px 0 12px">
          <button type="button" data-lang="en">EN</button>
          <button type="button" data-lang="fa">فارسی</button>
          <button type="button" data-lang="ar">العربية</button>
        </div>
        <button class="btn" id="pf-save" type="button">${I18N.t("profile.save_profile")}</button>
      </div>
      <div class="grid g-2">
        <div class="card prof-sec">
          <h3>${I18N.t("profile.identity")}</h3>
          <p>${u.gmail ? esc(u.gmail) : I18N.t("profile.no_mail")} ${u.gmail ? `<span class="badge-ok">${I18N.t("profile.verified")}</span>` : ""}</p>
          <p style="margin-top:10px">${u.phone ? esc(u.phone) : I18N.t("profile.no_phone")} ${u.phone ? `<span class="badge-ok">${I18N.t("profile.verified")}</span>` : ""}</p>
        </div>
        <div class="card prof-sec">
          <h3>${I18N.t("profile.security")}</h3>
          <label class="field"><span>${I18N.t("profile.current")}</span><input id="pf-cur" type="password" autocomplete="current-password" /></label>
          <label class="field"><span>${I18N.t("profile.next")}</span><input id="pf-next" type="password" autocomplete="new-password" /></label>
          <label class="field"><span>${I18N.t("auth.pass2")}</span><input id="pf-next2" type="password" autocomplete="new-password" /></label>
          <button class="btn tiny" id="pf-pass" type="button">${I18N.t("profile.password")}</button>
          <h3 style="margin-top:16px">${I18N.t("profile.totp")}</h3>
          <p class="sub">${I18N.t(u.totp_enabled ? "profile.totp_on" : "profile.totp_off")}</p>
          ${u.totp_enabled
            ? `<div class="row"><input class="ctrl" id="pf-td" placeholder="000000" style="max-width:120px"/><button class="btn tiny danger" id="pf-toff" type="button">${I18N.t("profile.totp_disable")}</button></div>`
            : `<button class="btn tiny" id="pf-ton" type="button">${I18N.t("profile.totp_start")}</button>
               <p class="secret-box hidden" id="pf-tsec"></p>
               <div class="row hidden" id="pf-trow"><input class="ctrl" id="pf-tc" placeholder="000000" style="max-width:120px"/><button class="btn tiny" id="pf-tok" type="button">${I18N.t("profile.totp_confirm")}</button></div>`}
        </div>
      </div>
      <div class="card${paid ? "" : " lic-banner"}">
        <h3>${I18N.t("profile.plan")}</h3>
        <p class="metric">${esc(L.plan_label || L.plan || I18N.t("profile.trial"))}</p>
        <p class="sub">${paid && L.days_left != null ? I18N.t("profile.remaining", { n: L.days_left }) : I18N.t("profile.trial")}</p>
        <p class="sub">${L.expires || ""}</p>
        <h3 style="margin-top:14px">${I18N.t(paid ? "profile.renew" : "profile.choose")}</h3>
        <div class="plan-grid" id="plan-grid">${plans || `<p class="sub">${I18N.t("profile.gateway_off")}</p>`}</div>
        <button class="btn block" id="pf-pay" type="button">${I18N.t("profile.pay")}</button>
        <p class="sub" id="pf-pay-msg"></p>
        <h3 style="margin-top:16px">${I18N.t("profile.history")}</h3>
        <div id="pf-pays">${pays || `<p class="sub">${I18N.t("profile.pay_none")}</p>`}</div>
      </div>
    </div>`;
  },
};

function metric(key, value, suffix, signed) {
  return `<div class="card"><h3>${I18N.t(key)}</h3><p class="metric mono ${signed?clsPnl(value):""}" data-metric="${key}">${fmt(value)}${suffix ? " " + suffix : ""}</p></div>`;
}
function emptyMini(text) { return `<div class="empty" style="min-height:120px"><p>${text}</p></div>`; }

/**
 * The watchlist beside the chart.
 *
 * It used to be a three-column table of symbol, bid and ask, rendered from
 * two copies of the same template - one for the first paint and one for
 * the tick refresh - which had already drifted apart. It gave no sense of
 * which symbol the chart was showing, cost a round trip to the dropdown to
 * change it, and said nothing a trader actually watches for.
 *
 * Each symbol is now a row you can press to put it on the chart, the
 * current one is marked, and the spread is shown because that is the
 * number that decides whether a setup is worth taking. The arrow is the
 * direction of the last change in the bid, held in `tickMemo` between
 * refreshes - it is measured, not decorative, and a symbol that has not
 * moved since the previous tick gets no arrow at all.
 */
const tickMemo = new Map();

function watchRowsHtml() {
  const ticks = (S.snap && S.snap.ticks) || {};
  const items = liveSymbols().filter((x) => ticks[x.symbol]);
  if (!items.length) return "";
  return items.map((it) => {
    const t = ticks[it.symbol] || {};
    const bid = Number(t.bid), ask = Number(t.ask);
    const prev = tickMemo.get(it.symbol);
    let dir = "";
    if (Number.isFinite(bid) && Number.isFinite(prev)) {
      if (bid > prev) dir = "up";
      else if (bid < prev) dir = "down";
    }
    if (Number.isFinite(bid)) tickMemo.set(it.symbol, bid);
    const spread = (Number.isFinite(bid) && Number.isFinite(ask)) ? ask - bid : null;
    const on = it.symbol === S.symbol;
    return `<button type="button" class="wl-row${on ? " is-on" : ""}" data-wl="${esc(it.symbol)}"
        aria-current="${on ? "true" : "false"}">
      <span class="wl-id">
        <b>${esc(it.symbol)}</b>
        ${it.timeframe ? `<i class="wl-tf">${esc(it.timeframe)}</i>` : ""}
      </span>
      <span class="wl-quote">
        <b class="mono wl-bid ${dir}">${fmt(bid, 5)}</b>
        <b class="mono wl-ask">${fmt(ask, 5)}</b>
      </span>
      <span class="mono wl-sp">${spread === null ? "—" : fmt(spread, 5)}</span>
    </button>`;
  }).join("");
}

function watchlistHtml() {
  const rows = watchRowsHtml();
  if (!rows) return emptyMini(I18N.t("status.waiting_ticks"));
  return `<div class="wl">
    <div class="wl-head">
      <span>${I18N.t("markets.symbol")}</span>
      <span class="wl-quote"><i>${I18N.t("markets.bid")}</i><i>${I18N.t("markets.ask")}</i></span>
      <span>${I18N.t("markets.spread")}</span>
    </div>
    <div class="wl-list">${rows}</div>
  </div>`;
}
function shownDir(ai) {
  ai = ai || {};
  if (ai.ready) return ai.direction || "neutral";
  if (ai.display_direction && ai.display_direction !== "neutral") return ai.display_direction;
  if (ai.hint && ai.hint !== "neutral") return ai.hint;
  return ai.direction || "neutral";
}
function dirLabel(d) {
  if (d === "bull") return I18N.t("ai.bull");
  if (d === "bear") return I18N.t("ai.bear");
  return I18N.t("ai.neutral");
}

// --- Per-chart AI direction slider (manual left/right, never auto-advances) --
// With several EA charts attached the AI judges every chart independently; the
// engine ships one state per symbol (ai_by_symbol) so here we build one slide
// per live chart. v54: each slide now contains direction + regime_obj + features
// merged, and intelligence view features follow the selected chart.
function aiPerSymbol() {
  const out = {};
  const list = S.snap && S.snap.ai_by_symbol;
  (Array.isArray(list) ? list : []).forEach((st) => { if (st && st.symbol) out[String(st.symbol)] = st; });
  return out;
}
function aiSlides() {
  const agents = liveAgents();
  const global = (S.snap && S.snap.ai) || {};
  if (!agents.length) return [{ symbol: String(global.symbol || ""), timeframe: String(global.timeframe || ""), state: global }];
  const per = aiPerSymbol();
  return agents.map((a) => {
    const st = per[a.symbol] || (String(global.symbol || "") === a.symbol ? global : null);
    // Normalize enriched fields: by_symbol entries now carry regime_obj/pattern_obj/features
    // but older entries or global fallback may still use string regime.
    return {
      symbol: a.symbol,
      timeframe: a.timeframe || "",
      state: st,
    };
  });
}
function currentAiSlideState() {
  const slides = aiSlides();
  const idx = (S.aiSlide | 0) >= slides.length ? 0 : (S.aiSlide | 0);
  return (slides[idx] && slides[idx].state) || (S.snap && S.snap.ai) || {};
}
function currentOlSlideState() {
  const slides = aiSlides();
  const idx = (S.olSlide | 0) >= slides.length ? 0 : (S.olSlide | 0);
  return (slides[idx] && slides[idx].state) || (S.snap && S.snap.ai) || {};
}
function outlookSlideInnerHtml(slide) {
  const st = slide.state || null;
  const has = Boolean(st && (st.symbol || st.reason || st.ready));
  const d = has ? shownDir(st) : "neutral";
  const p = Math.round((has ? (st.outlook_strength != null ? st.outlook_strength : (st.confidence || 0)) : 0) * 100);
  const title = slide.symbol ? (slide.timeframe ? slide.symbol + " · " + slide.timeframe : slide.symbol) : "";
  const text = !has ? I18N.t("ai.no_chart_data") : (st.outlook_text || st.reason || I18N.t("status.ai_idle"));
  // v54: also show regime per-chart in outlook banner (merged)
  const regime = st && (st.regime_obj || st.regime);
  const regimeName = regime ? (typeof regime === "string" ? regime : (regime.name || "")) : "";
  const regimeLbl = regimeName ? `<span class="pill ghost" style="margin-inline-start:8px;font-size:10px">${esc(regLabel(regimeName && typeof regimeName === "string" ? {name:regimeName} : regime))}</span>` : "";
  return `<div class="outlook-banner dir-${d}">
    <div>
      <p class="kicker">${I18N.t("ai.outlook")}${title ? `<span class="slide-sym mono">${esc(title)}</span>` : ""}${regimeLbl}</p>
      <p class="metric ${d === "bull" ? "up" : d === "bear" ? "down" : ""}">${dirLabel(d)}</p>
      <p class="sub">${esc(text)}</p>
    </div>
    <b class="mono">${p}%</b>
  </div>`;
}
function sliderIndexKey(kind) { return kind === "ol" ? "olSlide" : "aiSlide"; }
// Generic per-chart slider (ai = direction hero, ol = command outlook).
// Manual only: prev/next buttons and dot jumps — deliberately NO timer.
function chartSliderHtml(kind, renderInner) {
  const slides = aiSlides();
  const prop = sliderIndexKey(kind);
  if ((S[prop] | 0) >= slides.length) S[prop] = Math.max(0, slides.length - 1);
  const idx = S[prop] | 0;
  const first = slides[0] || { symbol: "", timeframe: "", state: (S.snap && S.snap.ai) || {} };
  if (slides.length < 2) {
    return `<div class="chart-stage" id="${kind}-slide-stage">${renderInner(first)}</div>`;
  }
  return `<div class="chart-slider">
    <button type="button" class="btn tiny ghost chart-nav" id="${kind}-prev" title="${I18N.t("ai.prev_chart")}" aria-label="${I18N.t("ai.prev_chart")}">‹</button>
    <div class="chart-stage" id="${kind}-slide-stage">${renderInner(slides[idx] || first)}</div>
    <button type="button" class="btn tiny ghost chart-nav" id="${kind}-next" title="${I18N.t("ai.next_chart")}" aria-label="${I18N.t("ai.next_chart")}">›</button>
  </div>
  <div class="chart-dots" id="${kind}-dots">${slides.map((s, i) => `<button type="button" class="chart-dot ${i === idx ? "on" : ""}" data-i="${i}" title="${esc(s.timeframe ? s.symbol + " · " + s.timeframe : s.symbol)}" aria-label="${esc(s.symbol)}"></button>`).join("")}</div>`;
}
function paintChartSlider(kind, renderInner, animDir) {
  const stage = $(kind + "-slide-stage");
  if (!stage) return;
  const prop = sliderIndexKey(kind);
  const slides = aiSlides();
  if ((S[prop] | 0) >= slides.length) S[prop] = Math.max(0, slides.length - 1);
  stage.innerHTML = renderInner(slides[S[prop] | 0] || { symbol: "", timeframe: "", state: (S.snap && S.snap.ai) || {} });
  if (animDir) {
    stage.classList.remove("sw-next", "sw-prev");
    void stage.offsetWidth; // restart the transition animation
    stage.classList.add(animDir > 0 ? "sw-next" : "sw-prev");
    setTimeout(() => stage.classList.remove("sw-next", "sw-prev"), 380);
  }
  document.querySelectorAll("#" + kind + "-dots .chart-dot").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === (S[prop] | 0)));
}
function stepChartSlider(kind, delta, jumpTo, renderInner) {
  const slides = aiSlides();
  if (slides.length < 2) return;
  const prop = sliderIndexKey(kind);
  const prev = S[prop] | 0;
  const n = slides.length;
  const want = typeof jumpTo === "number" ? jumpTo : prev + delta;
  S[prop] = ((want % n) + n) % n;
  const anim = typeof jumpTo === "number" ? (S[prop] > prev ? 1 : -1) : Math.sign(delta);
  paintChartSlider(kind, renderInner, anim);
  // v54: when intelligence slider changes, immediately refresh per-chart features/regime display
  if (kind === "ai" && S.view === "intelligence") {
    try {
      const ai = currentAiSlideState() || {};
      const featBox = $("ai-feat");
      if (featBox) {
        const feats = ai.features || {};
        if (Object.keys(feats).length) {
          featBox.innerHTML = Object.entries(feats).slice(0,18).map(([k,v])=>`<span>${esc(k)}</span><b class="mono">${fmt(v,5)}</b>`).join("");
        }
      }
      const rgEl = $("ai-regime");
      if (rgEl) rgEl.textContent = regLabel(ai.regime_obj || ai.regime);
      const patEl = $("ai-pattern");
      if (patEl) {
        const pat = ai.pattern_obj || ai.pattern;
        patEl.textContent = typeof pat === "string" ? pat : (pat?.name || "—");
      }
      const symEl = $("ai-feat-sym");
      if (symEl) symEl.textContent = ai.symbol || "";
      const why = $("ai-why");
      if (why) why.textContent = (ai.confidence_why && ai.confidence_why.text) || ai.reason || I18N.t("ai.conf_help");
      const samp = $("ai-samples");
      if (samp) samp.textContent = String(ai.samples || 0);
    } catch {}
  }
}
function bindChartSlider(kind, renderInner) {
  const prev = $(kind + "-prev");
  const next = $(kind + "-next");
  if (prev) prev.onclick = () => stepChartSlider(kind, -1, undefined, renderInner);
  if (next) next.onclick = () => stepChartSlider(kind, 1, undefined, renderInner);
  $(kind + "-dots")?.querySelectorAll(".chart-dot").forEach((el) => { el.onclick = () => stepChartSlider(kind, 0, Number(el.dataset.i), renderInner); });
  // Touch swipe support — RTL aware: swipe left = next in LTR, prev in RTL
  const stage = $(kind + "-slide-stage");
  if (stage && !stage._swipeBound) {
    stage._swipeBound = true;
    let x0 = 0, y0 = 0, dx = 0, touching = false;
    stage.addEventListener("touchstart", (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      touching = true;
      dx = 0;
    }, {passive: true});
    stage.addEventListener("touchmove", (e) => {
      if (!touching || !e.touches[0]) return;
      dx = e.touches[0].clientX - x0;
    }, {passive: true});
    stage.addEventListener("touchend", (e) => {
      if (!touching) return;
      touching = false;
      const dy = (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : y0) - y0;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) return; // vertical scroll
      if (Math.abs(dx) < 42) return;
      const rtl = document.documentElement.dir === "rtl";
      const dir = dx < 0 ? 1 : -1;
      const step = rtl ? -dir : dir;
      stepChartSlider(kind, step, undefined, renderInner);
    }, {passive: true});
  }
}
function aiSlideInnerHtml(slide) {
  const st = slide.state || null;
  const has = Boolean(st && (st.symbol || st.reason || st.ready));
  const d = has ? shownDir(st) : "neutral";
  const p = Math.round(((has ? st.confidence : 0) || 0) * 100);
  const ready = Boolean(has && st.ready);
  const title = slide.symbol ? (slide.timeframe ? slide.symbol + " · " + slide.timeframe : slide.symbol) : I18N.t("ai.title");
  const reason = !has ? I18N.t("ai.no_chart_data") : (st.reason || I18N.t("status.ai_idle"));
  // v54 merged: direction + regime per chart separate
  const regime = st && (st.regime_obj || st.regime);
  const pattern = st && (st.pattern_obj || st.pattern);
  const regimeLabel = regime ? regLabel(typeof regime === "string" ? {name: regime} : regime) : "—";
  const patternLabel = pattern ? (typeof pattern === "string" ? pattern : (pattern.name || "—")) : "—";
  const outlookStrength = st ? (st.outlook_strength != null ? Math.round(st.outlook_strength*100) : p) : 0;
  const outlookTxt = st && st.outlook_text ? st.outlook_text : "";
  return `<div class="ai-hero">
    <div>
      <h3>${I18N.t("ai.direction")}<span class="slide-sym mono">${esc(title)}</span></h3>
      <p class="metric ${d === "bull" ? "up" : d === "bear" ? "down" : ""}" id="ai-dir">${dirLabel(d)}${ready ? "" : `<span class="badge-hint" id="ai-badge">${I18N.t("ai.untrained")}</span>`}</p>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin:6px 0">
        <span class="pill ${d === "bull" ? "ok" : d === "bear" ? "no" : "ghost"}" id="ai-dir-pill">${dirLabel(d)} · ${p}%</span>
        <span class="pill ghost" id="ai-regime-pill">${I18N.t("ai.regime")}: ${esc(regimeLabel)}</span>
        <span class="pill ghost" id="ai-pattern-pill">${I18N.t("ai.pattern")}: ${esc(patternLabel)}</span>
        ${outlookStrength ? `<span class="pill ghost">outlook ${outlookStrength}%</span>` : ""}
      </div>
      <p class="sub" id="ai-reason">${esc(reason)}</p>
      ${outlookTxt ? `<p class="sub" style="opacity:.8">${esc(outlookTxt)}</p>` : ""}
    </div>
    <div class="gauge" id="ai-gauge" style="--p:${p}"><b class="mono">${p}%</b></div>
  </div>`;
}
function regLabel(r) {
  if (!r) return "—";
  const n = typeof r === "string" ? r : (r.name || "");
  if (n === "trend_up") return I18N.t("ai.trend_up");
  if (n === "trend_down") return I18N.t("ai.trend_down");
  if (n === "range") return I18N.t("ai.range");
  if (n === "unknown" || !n) return "—";
  return n;
}
/* Market-session banner. Answers "why did nothing trade?" before the user has
 * to ask: on Saturday/Sunday the desk says the market is shut, not that the
 * robot is broken. */
function marketBanner() {
  const m = S.snap && S.snap.market;
  if (!m) return "";
  // A news freeze outranks everything else: "no trade right now" has a
  // different cause when a high-impact release is inside the blackout window.
  const news = m.news || {};
  if (news.active) {
    const what = String(news.event || "").replace(/^news blackout\s*/i, "");
    return `<div class="tape-banner is-news">${esc(I18N.t("status.news_blackout", { event: what || I18N.t("calendar.untitled") }))}</div>`;
  }
  if (m.trading_allowed) return "";
  // Past 17:00 New York on Friday the market simply is closed — there is no
  // separate "friday close" state to announce any more.
  return `<div class="tape-banner is-closed">${esc(
    I18N.t("status.market_weekend", { day: I18N.t(`calendar.weekday_${m.weekday_key}`) }),
  )}</div>`;
}

function tapeBanner() {
  const mode = tapeMode();
  const bt = S.backtest || S.snap?.backtest || {};
  if (bt.running) {
    return `<div class="tape-banner is-backtest" id="tape-banner">${I18N.t("tape.running")}</div>`;
  }
  // Backtest has its own tab now.  The banner belongs there - showing it on
  // the history tab was leftover from when backtest lived inside history.
  if (mode === "tester" || (bt.mode === "backtest" && bt.ok && S.view === "backtest")) {
    return `<div class="tape-banner is-backtest" id="tape-banner">${I18N.t("tape.showing_backtest")}</div>`;
  }
  if (mode === "live") return ""; // chart names live inside the outlook slider now — no banner needed
  return `<div class="tape-banner is-idle" id="tape-banner">${I18N.t("tape.waiting")}</div>`;
}
/* aiBlock() lived here. It rendered a single AI bias with no symbol
   attached, which on a multi-chart desk is a direction without a subject.
   The Intelligence view renders the same data per chart, labelled, so this
   one was deleted rather than relocated. */
function posProfitPct(r) {
  if (r && r.profit_pct !== undefined && r.profit_pct !== null && r.profit_pct !== "") return Number(r.profit_pct);
  const o = Number(r && r.price_open), c = Number(r && r.price_current);
  if (!(o > 0) || !(c > 0)) return null;
  const raw = (c - o) / o * 100;
  return String(r.type || "").toLowerCase() === "sell" ? -raw : raw;
}
/**
 * One cell's text, for both the initial render and the live patch.
 *
 * It lived twice - once in table() and once in paintPositions() - and the
 * two copies formatted a different set of columns, so a price rendered with
 * five decimals on load and with however many the engine sent on the first
 * tick after it. Shared now, because a number that changes shape when it
 * updates is read as a number that changed.
 */
const CELL_PRICE = ["price", "price_open", "price_current", "price_close", "sl", "tp"];
const CELL_MONEY = ["profit", "net", "swap", "commission", "fees"];
function cellText(k, v) {
  if (k === "profit_pct") {
    return (v === null || v === undefined || Number.isNaN(Number(v))) ? "—" : fmt(v, 2) + "%";
  }
  if (k === "strategy") return strategyLabel(v);
  if (v === "" || v === null || v === undefined) return "—";
  if (k === "volume") return fmt(v, 2);
  if (CELL_PRICE.includes(k)) return fmt(v, 5);
  if (CELL_MONEY.includes(k)) return fmt(v, 2);
  return String(v);
}
/** Columns where a minus sign means something and should be coloured. */
function cellSigned(k) {
  return k === "profit" || k === "profit_pct" || k === "net" ||
         k === "swap" || k === "commission";
}
function table(rows, keys, closable) {
  const head = keys.map((k) => `<th>${I18N.t("table." + k) !== "table." + k ? I18N.t("table." + k) : k}</th>`).join("");
  const body = rows.map((r) => `<tr data-ticket="${r.ticket || ""}">${keys.map((k) => {
    const v = k === "profit_pct" ? posProfitPct(r) : r[k];
    // Every money column is signed, not just profit. A swap of -4.10 shown
    // in the same colour as a profit of 4.10 is a column the eye skips.
    const c = cellSigned(k) ? clsPnl(v) : "";
    const text = cellText(k, v);
    return `<td class="mono ${c}" data-k="${k}">${text}</td>`;
  }).join("")}${closable ? `<td><button class="btn tiny ghost" type="button" data-close="${r.ticket}">${I18N.t("exec.close")}</button></td>` : ""}</tr>`).join("");
  // A colgroup, so the CSS can fix the column widths. Without declared
  // widths a fixed-layout table divides itself evenly, and with no fixed
  // layout at all the columns re-measure on every price tick and the row
  // shifts under the pointer.
  const cols = keys.map((k) => `<col class="c-${esc(k)}">`).join("") + (closable ? `<col class="c-close">` : "");
  return `<div class="table-wrap"><table><colgroup>${cols}</colgroup><thead><tr>${head}${closable?"<th></th>":""}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function paintPositions(boxId, rows, keys, closable) {
  const box = $(boxId);
  if (!box) return;
  if (!rows.length) {
    box.dataset.sig = "";
    box.innerHTML = emptyMini(I18N.t("status.no_positions"));
    return;
  }
  const sig = rows.map((r) => String(r.ticket || "") + ":" + String(r.strategy || "")).join(",");
  if (box.dataset.sig === sig && box.querySelector("table")) {
    rows.forEach((r) => {
      const tr = box.querySelector(`tr[data-ticket="${r.ticket}"]`);
      if (!tr) return;
      keys.forEach((k) => {
        const td = tr.querySelector(`[data-k="${k}"]`);
        if (!td) return;
        const v = k === "profit_pct" ? posProfitPct(r) : r[k];
        const text = cellText(k, v);
        if (td.textContent !== text) td.textContent = text;
        if (cellSigned(k)) {
          td.classList.toggle("up", Number(v) > 0);
          td.classList.toggle("down", Number(v) < 0);
        }
      });
    });
    return;
  }
  box.dataset.sig = sig;
  box.innerHTML = table(rows, keys, closable);
  if (closable) bindCloseButtons(box);
}
function tickLabel() {
  const t = S.snap?.ticks?.[S.symbol];
  if (!t) return "";
  return `${S.symbol}  ${fmt(t.bid,5)} / ${fmt(t.ask,5)}`;
}
async function fillHostTerm() {
  const box = $("term");
  if (!box) return;
  const tab = S.termTab || "live";
  if (tab === "live") {
    box.innerHTML = renderLogs($("log-q")?.value || "");
    return;
  }
  if (tab === "robot") {
    box.innerHTML = renderRobotLogs($("log-q")?.value || "");
    box.scrollTop = box.scrollHeight;
    return;
  }
  try {
    const r = await API.get("/api/host-logs");
    let text = (r && r.data && r.data[tab]) || "";
    if (tab === "engine" && !String(text).trim()) {
      const ring = await API.get("/api/logs?limit=400");
      const rows = ring.data || [];
      text = rows.map((l) => `${l.ts || ""} [${l.level || "info"}] ${l.message || ""}`).join("\n");
    }
    if (!String(text).trim()) {
      box.innerHTML = `<div class="l-info">${I18N.t("terminal.empty_host")}</div>`;
      return;
    }
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  } catch {
    box.innerHTML = `<div class="l-error">${I18N.t("errors.generic")}</div>`;
  }
}

function renderLogs(filter = "") {
  const q = filter.toLowerCase();
  return (S.logs || []).filter((l) => JSON.stringify(l).toLowerCase().includes(q)).slice(-400).map((l) => {
    const msg = l.message || (l.lang_key && I18N.t(l.lang_key)) || "";
    return `<div class="l-${l.level||"info"}"><span class="ts">${l.ts || ""}</span>${esc(msg)}</div>`;
  }).join("");
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

function pushRobotLocal(level, message) {
  const item = { ts: new Date().toISOString(), level, message, channel: "robot" };
  S.robotLogs = (S.robotLogs || []).concat(item).slice(-600);
  const box = $("robot-term") || (S.view === "terminal" && S.termTab === "robot" ? $("term") : null);
  if (box) {
    box.innerHTML = renderRobotLogs($("log-q")?.value || "");
    box.scrollTop = box.scrollHeight;
  }
}
async function restartSystem() {
  const ok = await askConfirm({
    title: I18N.t("host.restart"),
    body: I18N.t("host.restart_confirm"),
    ok: I18N.t("host.restart"),
    cancel: I18N.t("common.cancel"),
  });
  if (!ok) return;
  toast(I18N.t("host.restarting"));
  try {
    const r = await API.post("/api/host/restart", {});
    if (!r.ok) return toast(r.error || I18N.t("errors.generic"));
  } catch (err) {
    toast((err && err.message) || I18N.t("errors.generic"));
    return;
  }
  setTimeout(() => { location.href = "/?v=" + Date.now(); }, 3500);
}
async function factoryReset() {
  const typed = String($("factory-confirm")?.value || "").trim().toUpperCase();
  if (typed !== "FACTORY") {
    toast(I18N.t("host.factory_type"));
    return;
  }
  const ok = await askConfirm({
    title: I18N.t("host.factory"),
    body: I18N.t("host.factory_confirm"),
    ok: I18N.t("host.factory_go"),
    cancel: I18N.t("common.cancel"),
    danger: true,
  });
  if (!ok) return;
  toast(I18N.t("host.factory_going"));
  try {
    const r = await API.post("/api/host/factory-reset", { confirm: "FACTORY" });
    if (!r.ok) return toast(r.error || I18N.t("errors.generic"));
  } catch (err) {
    toast((err && err.message) || I18N.t("errors.generic"));
    return;
  }
  API.setToken("");
  setTimeout(() => { location.href = "/?factory=1&v=" + Date.now(); }, 4000);
}

/**
 * The Telegram page, as a customer sees it.
 *
 * Everything that belongs to whoever *operates* the bot has been taken out:
 * the on/off switch, the running state, the note about where the token comes
 * from, and the bot's message language. None of that is this user's to
 * decide - one desk cannot turn the service on for everybody, and a customer
 * should not be told how the credential is provisioned. It lives in the
 * separate admin panel, which already has its own tooling under admin/.
 *
 * What is left is the whole of the customer's side of it: the code they send
 * to the bot to attach their own Telegram account, the accounts currently
 * attached, and what those accounts are sent.
 */
function telegramPanelHtml() {
  const tg = (S.snap && S.snap.telegram) || {};
  const chats = Array.isArray(tg.chats) ? tg.chats : [];
  const openOn = tg.notify_open !== false;
  const closeOn = tg.notify_close !== false;
  const code = S._tgCode || "";
  const botName = tg.username ? "@" + tg.username : "";

  const chatHtml = chats.length
    ? `<ul class="tg-chats">${chats.map((c) => {
        const label = [c.name, c.username ? "@" + c.username : ""].filter(Boolean).join(" · ") || ("#" + c.id);
        return `<li><span class="tg-who"><b>${esc(label)}</b><small class="mono">${esc(c.id)}</small></span>
          <button type="button" class="btn tiny ghost" data-tg-unlink="${esc(c.id)}">${I18N.t("telegram.unlink")}</button></li>`;
      }).join("")}</ul>`
    : `<p class="sub">${I18N.t("telegram.no_chat")}</p>`;

  return `<div class="card tg-pair-card">
      <h3 class="card-h">${I18N.t("telegram.pair")}</h3>
      <p class="sub">${I18N.t("telegram.pair_hint")}${botName ? ` <b class="mono">${esc(botName)}</b>` : ""}</p>
      <div class="tg-code" data-empty="${code ? "0" : "1"}">
        <b class="mono" id="tg-code">${esc(code || "······")}</b>
        <button type="button" class="btn tiny ghost" id="tg-copy"${code ? "" : " disabled"}>${I18N.t("common.copy")}</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="tg-pair" type="button">${I18N.t("telegram.pair_go")}</button>
        <button class="btn ghost" id="tg-test" type="button"${chats.length ? "" : " disabled"}>${I18N.t("telegram.test")}</button>
      </div>
      <p class="sub" id="tg-msg"></p>
      ${tg.running === false ? `<p class="sub lock-note">${I18N.t("telegram.offline_note")}</p>` : ""}
    </div>

    <div class="card" style="margin-top:14px">
      <h3 class="card-h">${I18N.t("telegram.chats")}</h3>
      <p class="sub">${I18N.t("telegram.chats_hint")}</p>
      ${chatHtml}
    </div>

    <div class="card" style="margin-top:14px">
      <h3 class="card-h">${I18N.t("telegram.notify_title")}</h3>
      ${switchRow({ id: "tg-open", title: I18N.t("telegram.notify_open"), on: openOn })}
      <hr class="set-rule" />
      ${switchRow({ id: "tg-close", title: I18N.t("telegram.notify_close"), on: closeOn })}
      <button class="btn block" id="tg-save" type="button" style="margin-top:12px">${I18N.t("telegram.save")}</button>
    </div>`;
}

function bindTelegramPanel() {
  const op = $("tg-open");
  if (op) op.onclick = () => paintSwitch(op, !op.classList.contains("on"));
  const cl = $("tg-close");
  if (cl) cl.onclick = () => paintSwitch(cl, !cl.classList.contains("on"));
  const save = $("tg-save");
  if (save) save.onclick = async () => {
    /* Only this user's own preferences are sent. No token, because it is
       provisioned in the source; no enabled flag, because the service is
       not one desk's to switch off for everyone; and the language follows
       the desk rather than being a second place to choose it. */
    const r = await API.post("/api/telegram", {
      language: I18N.lang || "fa",
      notify_open: Boolean($("tg-open")?.classList.contains("on")),
      notify_close: Boolean($("tg-close")?.classList.contains("on")),
    });
    const msg = $("tg-msg");
    const text = r.ok ? I18N.t("telegram.saved") : (r.error || I18N.t("errors.generic"));
    if (msg) msg.textContent = text;
    toast(text);
    if (r.ok) {
      S.snap = S.snap || {};
      S.snap.telegram = r.telegram || (r.data && r.data.telegram) || r.data || S.snap.telegram;
      await reloadSettings();
    }
  };
  const pair = $("tg-pair");
  if (pair) pair.onclick = async () => {
    const r = await API.post("/api/telegram/pair", {});
    if (!r.ok) return toast(r.error || I18N.t("errors.generic"));
    S._tgCode = r.code || (r.data && r.data.code) || "";
    const box = $("tg-code");
    if (box) box.textContent = S._tgCode || "······";
    const wrap = box && box.closest(".tg-code");
    if (wrap) wrap.dataset.empty = S._tgCode ? "0" : "1";
    const copy = $("tg-copy");
    if (copy) copy.disabled = !S._tgCode;
    toast(I18N.t("telegram.code") + " " + S._tgCode);
  };
  const copyBtn = $("tg-copy");
  if (copyBtn) copyBtn.onclick = async () => {
    if (!S._tgCode) return;
    try { await navigator.clipboard.writeText(S._tgCode); } catch { /* no clipboard */ }
    copyBtn.textContent = I18N.t("common.copied");
    setTimeout(() => { copyBtn.textContent = I18N.t("common.copy"); }, 1600);
  };
  const test = $("tg-test");
  if (test) test.onclick = async () => {
    const r = await API.post("/api/telegram/test", {});
    if (!r.ok) {
      const err = r.error === "no_chat" ? I18N.t("telegram.need_chat") : (r.error === "disabled" ? I18N.t("telegram.stopped") : (r.error || I18N.t("errors.generic")));
      toast(err);
      return;
    }
    toast(I18N.t("telegram.test_ok"));
  };
  document.querySelectorAll("[data-tg-unlink]").forEach((b) => {
    b.onclick = async () => {
      const r = await API.post("/api/telegram/unlink", { chat_id: b.getAttribute("data-tg-unlink") });
      if (!r.ok) return toast(r.error || I18N.t("errors.generic"));
      await reloadSettings();
    };
  });
}

/**
 * The expert card's two jobs: hand over the file, and carry the warning
 * from the last update forward.
 *
 * Saving the .mq5 from here matters more than it looks. The alternative
 * instruction is "find the AURION folder on disk, then find engine/ea" -
 * which is where people give up, keep the old expert attached, and then
 * report that the desk is behaving strangely.
 */
async function bindExpertsCard() {
  document.querySelectorAll("[data-ea-save]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-ea-save") || "bridge";
      const r = await API.get("/api/experts/source?id=" + encodeURIComponent(id));
      if (!r.ok || !r.data || !r.data.source) return toast(I18N.t("ea.save_failed"));
      const blob = new Blob([r.data.source], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.data.file || "AurionBridge.mq5";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(I18N.t("ea.saved", { file: r.data.file || "" }));
    };
  });

  // Did the last update change the experts? If it did, say so here as
  // well as in the update panel - this is the card the user will be on
  // when they go to do something about it.
  const note = document.getElementById("ea-upd-note");
  if (!note) return;
  try {
    const st = await API.get("/api/system/update/state");
    const last = st && st.data && st.data.last_applied;
    if (last && last.ea_changed) {
      note.hidden = false;
      note.textContent = I18N.t("ea.changed_by_update", {
        v: String(last.version || ""),
        n: String((last.ea_files || []).length || 2),
      });
    }
  } catch {}
}

async function bindUpdatePanel(){
  const urlDisplay = document.getElementById('upd-url-display');
  const autoEl = document.getElementById('upd-auto');
  const intervalEl = document.getElementById('upd-interval');
  const saveMsg = document.getElementById('upd-save-msg');
  const lastCheckEl = document.getElementById('upd-last-check');
  const statusEl = document.getElementById('upd-status');
  const resultEl = document.getElementById('upd-result');
  // urlDisplay optional after removal
  try {
    const r = await API.get('/api/system/update/settings');
    if(r.ok && r.data){
      if(urlDisplay) urlDisplay.textContent = r.data.update_server_url || r.data.source_url || '—';
      if(autoEl) paintSwitch(autoEl, !!r.data.auto_check_enabled);
      if(intervalEl) intervalEl.value = r.data.auto_check_interval_hours || 6;
    }
    const st = await API.get('/api/system/update/state');
    if(st.ok && st.data){
      if(lastCheckEl) lastCheckEl.textContent = I18N.t('upd.last_check') + ': ' + (st.data.last_check||'-') + ' - ' + (st.data.update_available ? I18N.t('upd.available') : I18N.t('upd.uptodate'));
      if(statusEl){
        if(st.data.latest){
          statusEl.innerHTML = '<div class="kv"><span>'+I18N.t('upd.new_version')+'</span><b>'+esc(st.data.latest.version||'')+'</b><span>'+I18N.t('upd.date')+'</span><b>'+esc(st.data.latest.published_at||'')+'</b></div><p class="sub">'+esc(st.data.latest.changelog||'')+'</p><p class="sub">'+I18N.t('upd.files_changed')+': '+(st.data.latest.files||[]).length+'</p>';
        } else {
          statusEl.innerHTML = '<p class="sub">' + I18N.t('upd.none') + '</p>';
        }
      }
    }
  } catch {}

  const saveBtn = document.getElementById('upd-save');
  if(saveBtn) saveBtn.onclick = async () => {
    const body = {
      auto_check_enabled: autoEl ? autoEl.classList.contains('on') : false,
      auto_check_interval_hours: Number(intervalEl.value)||6,
    };
    const r = await API.post('/api/system/update/settings', body);
    const txt = r.ok ? I18N.t('upd.saved') : (r.error||I18N.t('upd.error'));
    /* The tick is an icon in the panel; the toast is plain text by nature,
       and its own wording already says the save succeeded. */
    if(saveMsg) saveMsg.innerHTML = (r.ok ? icon("check") + ' ' : '') + esc(txt);
    toast(txt);
  };
  if(autoEl) autoEl.onclick = () => paintSwitch(autoEl, !autoEl.classList.contains('on'));

  const checkBtn = document.getElementById('upd-check');
  if(checkBtn) checkBtn.onclick = async () => {
    if(resultEl) resultEl.innerHTML = '<p class="sub">' + I18N.t('upd.checking') + '</p>';
    const r = await API.post('/api/system/update/check', {});
    if(!r.ok){
      if(resultEl) resultEl.innerHTML = '<p class="err">' + I18N.t('upd.error') + ': '+esc(r.error||'')+'</p>';
      return;
    }
    if(!r.update_available){
      if(resultEl) resultEl.innerHTML = '<p class="ok">'+icon("check")+' '+I18N.t('upd.uptodate')+' - '+I18N.t('about.version')+' '+esc((r.latest&&r.latest.version)||'')+'</p>';
      if(lastCheckEl) lastCheckEl.textContent = I18N.t('upd.last_check')+': '+(r.last_check||new Date().toISOString())+' - '+I18N.t('upd.uptodate');
      return;
    }
    const upd = r.latest;
    if(resultEl){
      resultEl.innerHTML = '<div class="card" style="background:rgb(var(--s9))"><h3>'+icon("spark")+' '+I18N.t('upd.available')+': '+esc(upd.version||'')+'</h3><p class="sub">'+esc(upd.changelog||'')+'</p><p class="sub">'+I18N.t('upd.files_changed')+': '+(upd.files||[]).length+'</p><div style="max-height:200px;overflow:auto;margin:8px 0">'+(upd.files||[]).map(f=>'<div class="file-item" style="display:flex;justify-content:space-between;background:rgb(var(--s3));padding:6px;border-radius:4px;margin:3px 0"><span>'+esc(f.path)+'</span><span style="font-size:11px">'+(f.size||'')+' bytes</span></div>').join('')+'</div><button class="btn" id="upd-apply-btn" type="button">'+icon("download")+' '+I18N.t('upd.download_apply')+'</button><p class="sub" style="margin-top:8px;color:var(--gold)">'+I18N.t('upd.replace_note')+'</p></div>';
      const applyBtn = document.getElementById('upd-apply-btn');
      if(applyBtn) applyBtn.onclick = async () => {
        if(!confirm(I18N.t('upd.confirm').replace('%s', upd.version))) return;
        applyBtn.disabled = true;
        applyBtn.textContent = I18N.t('upd.installing');
        const ar = await API.post('/api/system/update/apply', { update_id: upd.id });
        if(ar.ok){
          // An update that replaced the MetaTrader experts is only half
          // applied: nothing out here can press F7 inside MetaEditor.
          const eaLine = ar.ea_changed
            ? '<p class="sub" style="color:var(--amber,#d8a657)">'
              + I18N.t('ea.changed_by_update', { v: String(ar.version||upd.version||''), n: String((ar.ea_files||[]).length||2) })
              + '</p>'
            : '';
          resultEl.innerHTML = '<p class="ok">'+icon("check")+' '+I18N.t('upd.installed').replace('%s', esc(ar.version||upd.version))+'<br>'+I18N.t('upd.files')+': '+(ar.applied||[]).length+'<br>'+I18N.t('upd.backup')+': '+esc(ar.backup_dir||'')+'</p>'+eaLine+'<p class="sub">'+I18N.t('upd.restart_hint')+'</p><button class="btn" id="upd-restart" type="button">'+icon("refresh")+' '+I18N.t('upd.restart')+'</button>';
          const rb = document.getElementById('upd-restart');
          if(rb) rb.onclick = () => restartSystem();
        } else {
          resultEl.innerHTML = '<p class="err">' + I18N.t('upd.install_failed') + ': '+esc(ar.error||'')+'</p>';
          applyBtn.disabled = false;
        }
      };
    }
  };

  const manifestBtn = document.getElementById('upd-manifest');
  if(manifestBtn) manifestBtn.onclick = async () => {
    const r = await API.get('/api/system/update/manifest');
    if(resultEl){
      if(r.ok){
        resultEl.innerHTML = '<h4>'+I18N.t('upd.local_files')+' ('+(r.data.files||[]).length+')</h4><div style="max-height:300px;overflow:auto">'+(r.data.files||[]).slice(0,100).map(f=>'<div style="font-family:monospace;font-size:12px;padding:2px">'+esc(f.path)+' - '+esc(f.hash.slice(0,12))+'</div>').join('')+'</div><p class="sub">'+I18N.t('about.version')+': '+esc(r.data.version||'')+'</p>';
      } else {
        resultEl.innerHTML = '<p class="err">' + I18N.t('upd.error') + '</p>';
      }
    }
  };
}

function showSetTab(id) {
  const allow = ["set-robot", "set-strats", "set-prop", "set-mt5", "set-lang", "set-personal",
                 "set-notify", "set-telegram", "set-update", "set-system"];
  const next = allow.includes(id) ? id : (allow.includes(S.setTab) ? S.setTab : "set-robot");
  S.setTab = next;
  try { localStorage.setItem("aurion.setTab", next); } catch { /* */ }
  document.querySelectorAll("#set-jump [data-jump]").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-jump") === S.setTab);
  });
  document.querySelectorAll(".set-block").forEach((el) => {
    el.hidden = el.id !== S.setTab;
  });
}
function bindView(view) {
  if (view === "command") {
    const b = $("go-settings"); if (b) b.onclick = () => show("settings");
    bindChartSlider("ol", outlookSlideInnerHtml);
    bindGateSlider();
    bindStrategyToggles();
    bindCloseButtons($("stage"));
    applyChartLevels();
  }
  if (view === "charts") {
    if (S.chartFocus) {
      bindChartDesk();
    } else {
      paintMiniCharts();
      $("stage")?.querySelectorAll("[data-open-chart]").forEach((el) => {
        el.onclick = () => openChartDesk(el.dataset.sym, el.dataset.tf);
      });
    }
  }
  if (view === "markets") {
    /* Delegated, because the watchlist is replaced wholesale on every tick
       refresh; a handler bound to the rows themselves would be thrown away
       with them a second later. */
    const wl = $("live-ticks");
    if (wl) wl.onclick = (ev) => {
      const row = ev.target.closest("[data-wl]");
      if (!row) return;
      const sym = row.getAttribute("data-wl");
      if (!sym || sym === S.symbol) return;
      const sel = $("sym");
      if (sel) sel.value = sym;
      pickMarket(sym, S.timeframe);
    };
    const cv = $("cv");
    if (cv) {
      S.chart = new CandleChart(cv, { onPrice: onChartPrice, onPending: onChartPending });
      if (S.candles.length && eaLive()) S.chart.setBars(S.candles);
      const t = S.snap?.ticks?.[S.symbol]; if (t) S.chart.setTick(t);
      applyChartLevels(true);
      bindChartTicket();
      if (S.chart && S.chartSignals.length) S.chart.setSignals(S.chartSignals, S.showSignals);
      const sigToggleM = $("sig-toggle-m");
      if (sigToggleM) sigToggleM.onclick = async () => {
        if (!licFeat("chart_signals")) { toast(I18N.t("lic.err_locked")); show("upgrade"); return; }
        S.signalsEnabled = !S.signalsEnabled;
        localStorage.setItem("aurion.signalsEnabled", S.signalsEnabled ? "1" : "0");
        sigToggleM.innerHTML = S.signalsEnabled
          ? icon("bell") + " Signals ON"
          : icon("bellOff") + " Signals OFF";
        sigToggleM.classList.toggle("on", S.signalsEnabled);
        sigToggleM.classList.toggle("ghost", !S.signalsEnabled);
        const showBtn = $("sig-show-m");
        if (showBtn) showBtn.style.display = S.signalsEnabled ? "" : "none";
        if (S.signalsEnabled) await fetchChartSignals(S.symbol, S.timeframe);
        else { S.chartSignals = []; if (S.chart) S.chart.setSignals([], S.showSignals); }
      };
      const sigShowM = $("sig-show-m");
      if (sigShowM) sigShowM.onclick = () => {
        S.showSignals = !S.showSignals;
        localStorage.setItem("aurion.showSignals", S.showSignals ? "1" : "0");
        sigShowM.innerHTML = S.showSignals ? icon("eye") : icon("eyeOff");
        if (S.chart) S.chart.setSignals(S.chartSignals, S.showSignals);
      };
    }
    if (eaLive() && defaultSymbol() && !S.candles.length) primeEaChart();
    const sym = $("sym"), tf = $("tf");
    if (sym) sym.onchange = () => pickMarket(sym.value, S.timeframe);
    if (tf) tf.onchange = () => pickMarket(S.symbol || sym.value, tf.value);
  }
  if (view === "calendar") {
    Calendar.mount($("cal-root"));
  }
  if (view === "intelligence") {
    // Per-chart AI slider — manual only, no timer anywhere.
    bindChartSlider("ai", aiSlideInnerHtml);
    const b = $("btn-train");
    if (b) b.onclick = async () => {
      if (!S.symbol || !liveSymbols().some((x) => x.symbol === S.symbol)) {
        toast(I18N.t("exec.no_ea_symbol"));
        return;
      }
      const r = await API.post("/api/ai/train", { symbol: S.symbol, timeframe: S.timeframe });
      toast(r.ok ? I18N.t("logs.retrain") : (r.error || I18N.t("errors.generic")));
      await refresh();
    };
  }
  if (view === "strategies") {
    bindStrategyToggles();
    bindStrategyUpload();
  }
  if (view === "execution") {
    bindGateSlider();
    const rememberManual = () => {
      S.manual = {
        symbol: String($("ex-sym")?.value || S.manual?.symbol || ""),
        vol: String($("ex-vol")?.value ?? S.manual?.vol ?? "0.10"),
        sl: String($("ex-sl")?.value ?? S.manual?.sl ?? ""),
        tp: String($("ex-tp")?.value ?? S.manual?.tp ?? ""),
      };
    };
    ["ex-vol", "ex-sl", "ex-tp", "ex-sym"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("change", rememberManual);
    });
    if (S.manual) {
      if ($("ex-vol") && S.manual.vol !== undefined) $("ex-vol").value = S.manual.vol;
      if ($("ex-sl") && S.manual.sl !== undefined) $("ex-sl").value = S.manual.sl;
      if ($("ex-tp") && S.manual.tp !== undefined) $("ex-tp").value = S.manual.tp;
    }
    const send = async (side) => {
      if (S._orderBusy) return;
      const buyBtn = $("ex-buy");
      const sellBtn = $("ex-sell");
      const msg = $("ex-msg");
      const symbol = String($("ex-sym")?.value || defaultSymbol() || "").trim();
      const allowed = liveSymbols().map((x) => x.symbol);
      const volume = Number($("ex-vol")?.value || 0);
      const sl = Number($("ex-sl")?.value || 0);
      const tp = Number($("ex-tp")?.value || 0);
      rememberManual();
      if (!mt5Live()) {
        const err = I18N.t("errors.no_mt5");
        if (msg) msg.textContent = err;
        toast(err);
        return;
      }
      if (!symbol || (allowed.length && !allowed.includes(symbol))) {
        const err = I18N.t(allowed.length ? "exec.need_symbol" : "exec.no_ea_symbol");
        if (msg) msg.textContent = err;
        toast(err);
        return;
      }
      if (!(volume > 0)) {
        const err = I18N.t("exec.need_volume");
        if (msg) msg.textContent = err;
        toast(err);
        return;
      }
      const strategy = preferredStrategy();
      const body = { action: side, side, source: "desk", symbol, volume, strategy };
      if (strategy) body.comment = "AURION " + strategy;
      if (sl) body.sl = sl;
      if (tp) body.tp = tp;
      S._orderBusy = true;
      if (buyBtn) buyBtn.disabled = true;
      if (sellBtn) sellBtn.disabled = true;
      if (msg) msg.textContent = I18N.t("exec.sending");
      try {
        const r = await API.post("/api/order", body);
        const detail = r.error || r.detail || r.message || "";
        const text = r.ok
          ? (I18N.t("logs.order_sent") + (detail ? " — " + detail : ""))
          : (detail || I18N.t("logs.order_fail"));
        if (msg) msg.textContent = text;
        toast(text);
        pushRobotLocal(r.ok ? "info" : "error", text);
      } catch (err) {
        const text = err && err.message ? err.message : I18N.t("errors.generic");
        if (msg) msg.textContent = text;
        toast(text);
      } finally {
        S._orderBusy = false;
        if (buyBtn) buyBtn.disabled = false;
        if (sellBtn) sellBtn.disabled = false;
      }
      await refresh(false);
      if (S.manual) {
        if ($("ex-vol")) $("ex-vol").value = S.manual.vol;
        if ($("ex-sl")) $("ex-sl").value = S.manual.sl;
        if ($("ex-tp")) $("ex-tp").value = S.manual.tp;
      }
    };
    const exSym = $("ex-sym");
    if (exSym) exSym.onchange = () => { if (exSym.value) S.symbol = exSym.value; };
    const buy = $("ex-buy"); if (buy) buy.onclick = () => send("buy");
    const sell = $("ex-sell"); if (sell) sell.onclick = () => send("sell");
    const ro = $("robot-open");
    if (ro) ro.onclick = () => { S.termTab = "robot"; show("terminal"); };
    const auto = $("ex-auto");
    if (auto) auto.onclick = async () => {
      if (auto.dataset.busy) return;
      auto.dataset.busy = "1";
      const on = !auto.classList.contains("on");
      paintSwitch(auto, on);
      try {
        const r = await API.post("/api/auto", { enabled: on });
        toast(r.ok ? I18N.t(on ? "exec.auto_on" : "exec.auto_off") : (r.error || I18N.t("errors.generic")));
        if (!r.ok) {
          paintSwitch(auto, !on);
          return;
        }
        S.snap = S.snap || {};
        if (r.strategy) S.snap.strategy = r.strategy;
        else S.snap.strategy = { ...(S.snap.strategy || {}), auto_trade: on };
        S.snap.auto_trade = r.auto_trade !== undefined ? r.auto_trade : on;
        await refresh(false);
        show("execution", { animate: false, closeMenu: false });
      } finally {
        delete auto.dataset.busy;
      }
    };
    const flat = $("ex-flat");
    if (flat) flat.onclick = async () => {
      const ok = await askConfirm({
        title: I18N.t("exec.emergency"),
        body: I18N.t("exec.confirm_flat"),
        ok: I18N.t("exec.close_all"),
        cancel: I18N.t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      const r = await API.post("/api/flatten", { reason: "emergency" });
      toast(r.ok ? I18N.t("exec.close_all") : r.error);
      await refresh();
    };
    bindCloseButtons($("stage"));
  }
  if (view === "terminal") {
    S.termTab = S.termTab || "live";
    const q = $("log-q");
    if (q) q.oninput = () => {
      if (S.termTab === "live") $("term").innerHTML = renderLogs(q.value);
      if (S.termTab === "robot") $("term").innerHTML = renderRobotLogs(q.value);
    };
    const clr = $("log-clr");
    if (clr) clr.onclick = () => { if (S.termTab === "robot") S.robotLogs = []; else S.logs = []; $("term").innerHTML = ""; };
    const tr = $("term-restart");
    if (tr) tr.onclick = async () => {
      const ok = await askConfirm({
        title: I18N.t("terminal.restart")||"Restart Terminals",
        body: I18N.t("terminal.restart_confirm")||"Immediate restart of system terminals? MT5 connection will be restarted.",
        ok: I18N.t("terminal.restart")||"Restart",
        cancel: I18N.t("common.cancel"),
        danger: false,
      });
      if (!ok) return;
      tr.disabled = true;
      tr.innerHTML = icon("hourglass") + " Restarting...";
      try {
        const r = await API.post("/api/terminals/restart", {});
        toast(r.ok ? (I18N.t("terminal.restart_ok")||"Terminals restarted") : (r.error||I18N.t("errors.generic")));
      } catch (e) {
        toast(I18N.t("errors.generic"));
      } finally {
        tr.disabled = false;
        tr.innerHTML = icon("refresh") + " " + esc(I18N.t("terminal.restart")||"Restart Terminals");
      }
    };
    const tabs = $("term-tabs");
    if (tabs) {
      tabs.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", b.dataset.term === S.termTab);
        b.onclick = () => {
          S.termTab = b.dataset.term;
          tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          const tools = $("term-live-tools");
          if (tools) tools.style.display = (S.termTab === "live" || S.termTab === "robot") ? "" : "none";
          fillHostTerm();
        };
      });
    }
    const tools = $("term-live-tools");
    if (tools) tools.style.display = (S.termTab === "live" || S.termTab === "robot") ? "" : "none";
    fillHostTerm();
    if (S._termPoll) clearInterval(S._termPoll);
    S._termPoll = setInterval(() => { if (S.view === "terminal") fillHostTerm(); }, 2500);
  }
  if (view === "backtest") {
    // The card is rendered as HTML; the curve needs a canvas that exists.
    const btNow = S.backtest || S.snap?.backtest || {};
    if (btNow.ok && Array.isArray(btNow.equity_curve) && btNow.equity_curve.length > 1) {
      requestAnimationFrame(() => drawEquityCurve(btNow.equity_curve.map(Number).filter((x) => Number.isFinite(x))));
    }
    const goBt = $("h-bt");
    if (goBt) goBt.onclick = async () => {
      if (S._btBusy) return;
      const symbol = String($("bt-sym")?.value || S.symbol || "").trim();
      const timeframe = String($("bt-tf")?.value || S.timeframe || "M15");
      const name = String($("bt-st")?.value || "ema_rsi");
      if (!symbol || !liveSymbols().some((x) => x.symbol === symbol)) {
        toast(I18N.t("exec.no_ea_symbol"));
        return;
      }
      S._btBusy = true;
      setBacktestBusy(true, 0);
      S.backtest = { running: true, mode: "backtest", symbol, timeframe, strategy: name, progress: 0 };
      // Put the live panel up and scroll to it immediately. The run is
      // watched in the same place the result will appear, so the trader
      // never has to hunt for either.
      paintBacktestResults(S.backtest, { reveal: true });
      headerState();
      try {
        // The engine accepts the run and answers at once; the result
        // arrives over the socket. Waiting on this request was the whole
        // bug: a replay longer than the proxy's 25 second patience came
        // back as "engine offline" after finishing perfectly.
        const r = await API.post("/api/backtest", {
          symbol,
          timeframe,
          strategy: { kind: "builtin", name },
        });
        if (!r || r.ok === false) {
          S.backtest = { ok: false, running: false, mode: "backtest", error: (r && r.error) || "generic" };
          if (S.snap) S.snap.backtest = S.backtest;
          paintBacktestResults(S.backtest);
          toast((r && r.error) || I18N.t("errors.generic"));
          S._btBusy = false;
          setBacktestBusy(false);
          headerState();
          return;
        }
        S.backtest = { ...r, running: true, mode: "backtest" };
        if (S.snap) S.snap.backtest = S.backtest;
        headerState();
        watchBacktest();
      } catch (err) {
        S.backtest = { ok: false, running: false, mode: "backtest", error: err && err.message };
        toast(I18N.t("errors.generic"));
        S._btBusy = false;
        setBacktestBusy(false);
        headerState();
      }
    };
  }
  if (view === "history") {
    loadHistory();
    $("h-exp").onclick = async () => {
      const btn = $("h-exp");
      if (btn) btn.disabled = true;
      try {
        const r = await API.post("/api/export/excel", { lang: I18N.lang });
        const name = r.ok ? r.data?.filename : "";
        if (!name) {
          toast(r.error || I18N.t("errors.generic"));
          return;
        }
        // Fetch the workbook as a blob: the /api/exports route is behind
        // auth.middleware, which only accepts an Authorization header.
        const d = await API.download("/api/exports/" + encodeURIComponent(name), name);
        if (!d.ok) {
          toast(d.error === "auth_required"
            ? I18N.t("errors.session_expired")
            : (d.error || I18N.t("errors.generic")));
        } else {
          toast(I18N.t("history.export_done", { name }));
        }
      } catch (err) {
        toast((err && err.message) || I18N.t("errors.generic"));
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    $("h-rst").onclick = async () => {
      const ok = await askConfirm({
        title: I18N.t("history.reset"),
        body: I18N.t("history.reset_confirm"),
        ok: I18N.t("history.reset"),
        cancel: I18N.t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      const r = await API.post("/api/history/reset", { days: 0 });
      const err = !r.ok
        ? (r.error === "engine_offline" ? I18N.t("errors.no_engine") : (r.error || r.detail || I18N.t("errors.generic")))
        : "";
      toast(r.ok ? I18N.t("logs.archived") : String(err));
      loadHistory();
    };
  }
  if (view === "settings") {
    bindRobotPanel();
    bindNotifySounds($("stage"));
    bindTelegramPanel();
    bindSymbolPicker();
    bindUpdatePanel();
    bindExpertsCard();
    bindStrategyToggles();
    bindPropForm();
    bindPropEnable();
    fillMt5Form();
    bindUsersPanel();
    const lk = $("pr-lock");
    if (lk) lk.onclick = async () => {
      if (lk.disabled || S.snap?.prop?.enabled === false) return;
      await API.post("/api/prop/lock", { reason: "manual" });
      await reloadSettings();
    };
    const uk = $("pr-unlock");
    if (uk) uk.onclick = async () => {
      if (uk.disabled || S.snap?.prop?.enabled === false) return;
      await API.post("/api/prop/unlock", {});
      await reloadSettings();
    };
    const rst = $("sys-restart"); if (rst) rst.onclick = () => restartSystem();
    const fac = $("sys-factory"); if (fac) fac.onclick = () => factoryReset();
    const licGo = $("lic-go");
    if (licGo) licGo.onclick = async () => {
      const key = String($("lic-key")?.value || "").trim();
      const r = await API.post("/api/license/activate", { key });
      const msg = $("lic-msg");
      if (r.ok) {
        toast(I18N.t("license.ok"));
        if (msg) msg.textContent = I18N.t("license.ok");
        await reloadSettings();
      } else {
        const err = r.error || "invalid_key";
        const text = I18N.t("license." + err);
        toast(text === "license." + err ? err : text);
        if (msg) msg.textContent = text === "license." + err ? err : text;
      }
    };
    const licUpd = $("lic-upd");
    if (licUpd) licUpd.onclick = async () => {
      const box = $("lic-upd-msg");
      const r = await API.get("/api/updates");
      if (!r.ok && r.error) {
        if (box) box.textContent = r.error;
        return;
      }
      const d = r.data || r;
      if (!d.configured) {
        if (box) box.textContent = I18N.t("license.up_to_date") + " (GitHub repo not set)";
        return;
      }
      if (d.newer) {
        if (box) box.textContent = I18N.t("license.newer") + (d.latest ? " — " + d.latest : "");
        if (d.url) window.open(d.url, "_blank", "noopener");
      } else if (box) box.textContent = I18N.t("license.up_to_date");
    };
    const jump = $("set-jump");
    if (jump) jump.onclick = (e) => {
      const b = e.target.closest("[data-jump]"); if (!b) return;
      showSetTab(b.dataset.jump);
    };
    showSetTab(S.setTab || "set-robot");
    const sav = $("s-save");
    if (sav) sav.onclick = () => saveAccountSettings(false);
    const con = $("s-con");
    if (con) con.onclick = async () => {
      await saveAccountSettings(true);
      const r = await API.post("/api/mt5/connect", {
        terminal_path: $("s-path").value, login: +$("s-login").value || 0,
        server: $("s-server").value, password: $("s-pass").value,
      });
      const text = r.ok
        ? (r.engine === "offline" ? I18N.t("settings.saved_offline") : I18N.t("status.mt5_live"))
        : (r.error || I18N.t("errors.no_mt5"));
      if ($("s-msg")) $("s-msg").textContent = text;
      toast(text);
      await refresh(false);
    };
    const ownLock = $("own-lock");
    if (ownLock) ownLock.onclick = async () => {
      const r = await API.post("/api/owner/lock", { gmail: $("own-gmail")?.value || "" });
      const msg = $("own-msg");
      if (!r.ok) {
        const text = authErrorText(r.error);
        if (msg) msg.textContent = text;
        return toast(text);
      }
      S.owner = r.data || S.owner;
      if (msg) msg.textContent = I18N.t("owner.locked");
      toast(I18N.t("owner.locked"));
    };
    const dbSave = $("db-save");
    if (dbSave) dbSave.onclick = async () => {
      const r = await API.post("/api/database", { url: $("db-url")?.value || "" });
      const msg = $("db-msg");
      if (!r.ok) {
        const text = authErrorText(r.error);
        if (msg) msg.textContent = text;
        return toast(text);
      }
      S.database = r.data || S.database;
      if (msg) msg.textContent = I18N.t("db.saved");
      toast(I18N.t("db.saved"));
    };
    const dis = $("s-dis");
    if (dis) dis.onclick = async () => { await API.post("/api/mt5/disconnect", {}); await refresh(false); };
    markLangPills();
    const langs = $("set-langs");
    if (langs) langs.onclick = async (e) => {
      const b = e.target.closest("[data-lang]"); if (!b) return;
      await setLang(b.dataset.lang);
    };
    markThemePills();
    const themes = $("set-themes");
    if (themes) themes.onclick = (e) => {
      const b = e.target.closest("[data-themebtn]"); if (!b) return;
      setTheme(b.dataset.themebtn);
    };
    paintGlassSwitch();
    const glass = $("sw-glass");
    if (glass) glass.onclick = () => { if (!glassForced()) setGlass(!glassOn()); };
    bindAppearance();
    markAppearancePills();
    markThemeCards();
    bindStrategyUpload();
    const tpl = $("st-tpl");
    if (tpl) tpl.onclick = async (e) => {
      e.preventDefault();
      const r = await API.get("/api/strategies/template");
      if (r.ok) {
        $("st-src").value = r.data;
        const blob = new Blob([r.data], { type: "text/x-python" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "aurion_strategy_template.py"; a.click();
      }
    };
    const up = $("st-up");
    if (up) up.onclick = () => strategyUploadOrSave();
  }
  if (view === "about") {
    const chk = $("about-check-update");
    if(chk) chk.onclick = async () => {
      const r = await API.post('/api/system/update/check', {});
      const el = $("about-update-status");
      if(el) el.innerHTML = r.ok
        ? (r.update_available
            ? esc(I18N.t('upd.available')+': '+(r.latest?.version||''))
            : icon("check") + ' ' + esc(I18N.t('upd.uptodate')))
        : esc(I18N.t('upd.error')+': '+(r.error||''));
      const logEl = $("about-changelog");
      if(logEl && r.ok && r.latest){
        logEl.innerHTML = '<b>'+I18N.t('about.version')+' '+esc(r.latest.version||'')+'</b><br>'+esc(r.latest.changelog||'')+'<br><br>'+ (r.latest.files||[]).map(f=>'<div style="font-family:monospace;font-size:12px">'+esc(f.path)+'</div>').join('');
      }
    };
    const copy = $("about-copy-ver");
    if(copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(S.version||'1.0.0'); toast(I18N.t('about.copied') + ': v'+(S.version||'')); } catch {}
    };
    // auto check - async IIFE
    (async () => {
      try {
        const r = await API.get('/api/system/update/state');
        const el = $("about-update-status");
        if(el && r.ok && r.data){
          el.innerHTML = r.data.update_available
            ? esc(I18N.t('upd.available')+': '+(r.data.latest?.version||''))
            : icon("check") + ' ' + esc(I18N.t('upd.uptodate')+' - v'+(S.version||'1.0.0'));
        }
        const logEl = $("about-changelog");
        if(logEl){
          if(r.ok && r.data && r.data.latest){
            logEl.innerHTML = '<b>'+I18N.t('about.version')+' '+esc(r.data.latest.version||'')+'</b><br>'+esc(r.data.latest.changelog||'')+'';
          } else {
            logEl.innerHTML = '<p>'+I18N.t('upd.uptodate')+' - v'+esc(S.version||'1.0.0')+'</p><p class="sub">AURION Live Desk - Axiasoft</p>';
          }
        }
      } catch {}
    })();
  }
  if (view === "upgrade") {
    const store = $("up-store");
    if (store) store.onclick = () => {
      const u = (S.snap && S.snap.license && S.snap.license.store_url) || "";
      if (u) window.open(u, "_blank", "noopener");
      else toast(I18N.t("upgrade.store_unset"));
    };
    const go = $("up-go");
    if (go) go.onclick = () => upgradeActivate();
    const keyIn = $("up-key");
    if (keyIn) keyIn.addEventListener("keydown", (e) => { if (e.key === "Enter") upgradeActivate(); });
  }
  bindUpgradeLinks($("stage"));
  if (view === "profile") bindProfile();
}

async function upgradeActivate() {
  const key = String($("up-key")?.value || "").trim();
  const err = $("up-err");
  const res = $("up-result");
  if (!key) { if (err) err.textContent = I18N.t("lic.need_key"); return; }
  const r = await API.post("/api/license/activate", { key });
  if (!r.ok) {
    if (err) err.textContent = licErrText(r.error, r);
    if (res) res.textContent = "";
    return;
  }
  const lic = r.license || {};
  if (err) err.textContent = "";
  if (res) {
    res.textContent = I18N.t("lic.activated") + " · " + planLabel(lic) +
      (lic.days_left != null ? " — " + I18N.t("upgrade.days") + ": " + fmt(lic.days_left, 0) : "");
  }
  toast(I18N.t("lic.activated"));
  await refresh(false);
  show("upgrade", { animate: false, closeMenu: false, nav: false });
}

function licGateToast(r) {
  if (r && r.error === "premium_required") {
    toast(I18N.t("lic.err_locked"));
    show("upgrade");
    return true;
  }
  return false;
}

function bindStrategyToggles() {
  document.querySelectorAll("button.switch[data-st]").forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.st;
      const on = !b.classList.contains("on");
      // Painted before the request goes out: the engine round trip is the
      // one moment a switch must not feel slow. If it is refused, the two
      // markers go back together.
      paintStrategyEnabled(name, on);
      const r = await API.post("/api/strategies/toggle", { name, enabled: on });
      if (!r.ok) paintStrategyEnabled(name, !on);
      toast(r.ok ? I18N.t(on ? "strategies.enable" : "strategies.disable") : (r.error || I18N.t("errors.generic")));
      if (r.ok && r.strategy) {
        S.snap = S.snap || {};
        S.snap.strategy = r.strategy;
      }
      await refresh(false);
      patchStrategyLive();
    };
  });
  document.querySelectorAll("[data-st-edit]").forEach((b) => {
    b.onclick = () => startStrategyEdit(b.dataset.stEdit);
  });
  document.querySelectorAll("[data-st-del]").forEach((b) => {
    b.onclick = () => deleteCustomStrategy(b.dataset.stDel);
  });
}

// ---------------------------------------------------------------------------
// Strategy file intake: drag & drop or click-to-browse.
//
// The drag listeners live on `document` and are installed once at boot.  Every
// view re-render replaces the drop-zone element, which used to take its
// listeners with it - that is why dropping a file stopped working after the
// first refresh.  Document-level handling also makes the whole Strategies tab
// a drop target and stops the browser from navigating to the dropped file.
// ---------------------------------------------------------------------------
const STRATEGY_FILE_RE = /\.(py|txt)$/i;

function strategyDropActive() {
  return S.view === "strategies" && Boolean($("st-drop")) && licFeat("strategy_upload");
}

function dragHasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types) return Array.prototype.indexOf.call(dt.types, "Files") !== -1;
  return Boolean(dt.files && dt.files.length);
}

async function takeStrategyFile(file) {
  if (!file) return;
  if (!STRATEGY_FILE_RE.test(file.name || "")) {
    toast(I18N.t("strategies.bad_type"));
    return;
  }
  const drop = $("st-drop");
  if (drop) drop.classList.add("has-file");
  if ($("st-file")) $("st-file").value = file.name || "custom.py";
  let text = "";
  try {
    text = await file.text();
  } catch {
    try { text = await new Response(file).text(); } catch { text = ""; }
  }
  if (!text) {
    toast(I18N.t("strategies.bad_read"));
    return;
  }
  if ($("st-src")) $("st-src").value = text;
  const hint = $("st-drop-name");
  if (hint) hint.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
  toast(I18N.t("strategies.file_ready", { name: file.name }));
}

function bindStrategyDropTarget() {
  if (document._stDropBound) return;
  document._stDropBound = true;
  let depth = 0;
  const mark = (on) => { const z = $("st-drop"); if (z) z.classList.toggle("over", on); };
  document.addEventListener("dragenter", (e) => {
    if (!strategyDropActive() || !dragHasFiles(e)) return;
    e.preventDefault();
    depth++;
    mark(true);
  });
  document.addEventListener("dragover", (e) => {
    if (!strategyDropActive() || !dragHasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch { /* older engines */ }
  });
  document.addEventListener("dragleave", () => {
    if (!strategyDropActive()) return;
    depth = Math.max(0, depth - 1);
    if (!depth) mark(false);
  });
  document.addEventListener("drop", (e) => {
    if (!strategyDropActive()) return;
    e.preventDefault();
    depth = 0;
    mark(false);
    takeStrategyFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
}

function bindStrategyUpload() {
  bindStrategyDropTarget();
  const pick = $("st-file-pick");
  if (pick && !pick._bound) {
    pick._bound = true;
    pick.addEventListener("change", () => takeStrategyFile(pick.files && pick.files[0]));
  }
  const tpl = $("st-tpl");
  if (tpl && !tpl._bound) {
    tpl._bound = true;
    tpl.onclick = async (e) => {
      e.preventDefault();
      const r = await API.get("/api/strategies/template");
      if (r.ok) {
        if ($("st-src")) $("st-src").value = r.data;
        const blob = new Blob([r.data], { type: "text/x-python" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "aurion_strategy_template.py"; a.click();
      }
    };
  }
  const up = $("st-up");
  if (up && !up._bound) {
    up._bound = true;
    up.onclick = () => strategyUploadOrSave();
  }
  const cancel = $("st-cancel");
  if (cancel && !cancel._bound) {
    cancel._bound = true;
    cancel.onclick = (e) => { e.preventDefault(); setStrategyEditMode(null); };
  }
  // A view re-render wipes the form — put the editing session back on screen.
  restoreStrategyEditor(true);
}
async function fillMt5Form() {
  const prefs = S.prefs || {};
  try {
    const r = await API.get("/api/config");
    const mt = (r && r.data && r.data.mt5) || {};
    const acc = (S.snap && S.snap.mt5 && S.snap.mt5.account) || {};
    if ($("s-path")) $("s-path").value = prefs.mt5_path || mt.terminal_path || "";
    if ($("s-login")) $("s-login").value = prefs.mt5_login || mt.login || acc.login || "";
    if ($("s-server")) $("s-server").value = prefs.mt5_server || mt.server || acc.server || "";
  } catch {
    if ($("s-path")) $("s-path").value = prefs.mt5_path || "";
    if ($("s-login")) $("s-login").value = prefs.mt5_login || "";
    if ($("s-server")) $("s-server").value = prefs.mt5_server || "";
  }
}
async function saveAccountSettings(quiet) {
  const body = {
    mt5_path: $("s-path")?.value || "",
    mt5_login: $("s-login")?.value || "",
    mt5_server: $("s-server")?.value || "",
    last_view: S.view,
    language: I18N.lang,
    symbol: S.symbol || "",
    timeframe: S.timeframe || "M15",
  };
  const r = await API.post("/api/profile/settings", body);
  if (r.ok) S.prefs = r.data || body;
  try {
    await API.post("/api/config", {
      mt5: {
        terminal_path: body.mt5_path,
        login: Number(body.mt5_login) || 0,
        server: body.mt5_server,
      },
    });
  } catch { /* engine overlay is best-effort */ }
  if (!quiet) {
    const text = r.ok ? I18N.t("settings.saved_account") : (r.error || I18N.t("errors.generic"));
    if ($("s-msg")) $("s-msg").textContent = text;
    toast(text);
  }
  return r;
}
async function loadAccountSettings() {
  try {
    const r = await API.get("/api/profile/settings");
    if (r && r.ok && r.data) {
      S.prefs = r.data;
      if (r.data.symbol) S.symbol = r.data.symbol;
      if (r.data.timeframe) S.timeframe = r.data.timeframe;
    }
  } catch { S.prefs = S.prefs || {}; }
  // Startup / refresh always opens the command center, not the settings tab.
  S.view = "command";
}

async function reloadSettings() {
  const stage = $("stage");
  const y = stage ? stage.scrollTop : 0;
  await refresh(false);
  if (S.view === "settings") {
    show("settings", { animate: false, closeMenu: false });
    requestAnimationFrame(() => {
      const again = $("stage");
      if (again) again.scrollTop = y;
    });
  }
}
function paintSwitch(el, on) {
  if (!el) return;
  el.classList.toggle("on", Boolean(on));
  el.setAttribute("aria-pressed", on ? "true" : "false");
}

function bindRobotPanel() {
  const auto = $("st-auto");
  if (auto) auto.onclick = async () => {
    if (auto.dataset.busy) return;
    auto.dataset.busy = "1";
    const on = !auto.classList.contains("on");
    paintSwitch(auto, on);
    const sub = auto.closest(".auto-banner")?.querySelector(".sub");
    if (sub) sub.textContent = I18N.t(on ? "exec.auto_on" : "exec.auto_off");
    try {
      const r = await API.post("/api/auto", { enabled: on });
      if (!r.ok) {
        paintSwitch(auto, !on);
        if (sub) sub.textContent = I18N.t(!on ? "exec.auto_on" : "exec.auto_off");
        toast(r.error || I18N.t("errors.generic"));
        return;
      }
      S.snap = S.snap || {};
      if (r.strategy) S.snap.strategy = r.strategy;
      else S.snap.strategy = { ...(S.snap.strategy || {}), auto_trade: on };
      S.snap.auto_trade = r.auto_trade !== undefined ? r.auto_trade : on;
      toast(I18N.t(on ? "exec.auto_on" : "exec.auto_off"));
      await reloadSettings();
    } finally {
      delete auto.dataset.busy;
    }
  };
  const ai = $("st-ai");
  if (ai) ai.onclick = () => ai.classList.toggle("on");
  const saveAi = async (quiet) => {
    const r = await API.post("/api/auto", {
      require_ai_agree: $("st-ai")?.classList.contains("on"),
      min_ai_confidence: +($("st-conf")?.value || 0.35),
    });
    if (!quiet) toast(r.ok ? I18N.t("common.save") : r.error);
    await refresh(false);
    return r;
  };
  // No save button: flipping the switch is the decision, so it persists
  // immediately - the same contract as every other switch on this page.
  const aiSwitch = $("st-ai");
  if (aiSwitch) aiSwitch.onclick = () => {
    aiSwitch.classList.toggle("on");
    aiSwitch.setAttribute("aria-pressed", aiSwitch.classList.contains("on") ? "true" : "false");
    saveAi(true);
  };
  // "Open between 1 and N trades": the ceiling the robot never crosses and
  // how many tickets a strong setup is allowed to take at once.
  const saveSlots = async (quiet) => {
    const lo = Math.max(1, Math.min(20, +($("st-min-trades")?.value || 1)));
    let hi = Math.max(1, Math.min(20, +($("st-max-trades")?.value || 2)));
    if (hi < lo) hi = lo;
    if ($("st-max-trades")) $("st-max-trades").value = hi;
    const r = await API.post("/api/auto", {
      min_open_trades: lo,
      max_open_trades: hi,
      smart_filters: $("st-smart")?.classList.contains("on"),
      min_signal_quality: +($("st-quality")?.value || 0.55),
    });
    if (!quiet) toast(r.ok ? I18N.t("common.save") : (r.error || I18N.t("errors.generic")));
    await refresh(false);
    return r;
  };
  // The worked example follows the fields as they are typed in, so the two
  // numbers stop being abstract before anything is saved.
  const slotExample = () => {
    const el = $("st-slots-demo");
    if (!el) return;
    const lo = Math.max(1, Math.min(20, +($("st-min-trades")?.value || 1)));
    const hi = Math.max(lo, Math.min(20, +($("st-max-trades")?.value || 2)));
    el.innerHTML = slotsDemoHtml(lo, hi);
  };
  ["st-min-trades", "st-max-trades"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", slotExample);
    el.addEventListener("change", () => saveSlots(true));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSlots(true); });
  });
  const smart = $("st-smart");
  if (smart) smart.onclick = () => {
    smart.classList.toggle("on");
    smart.setAttribute("aria-pressed", smart.classList.contains("on") ? "true" : "false");
    saveSlots(true);
  };
  const quality = $("st-quality");
  if (quality) {
    const qpct = $("st-quality-pct");
    const qnote = $("st-quality-note");
    const paint = () => {
      const pct = Math.round(+quality.value * 100);
      if (qpct) qpct.textContent = pct + "%";
      // The sentence under the slider changes with it, so the number means
      // something while it is being dragged rather than after it is saved.
      if (qnote) qnote.textContent = I18N.t("slots.q_now_" + (pct >= 70 ? "tight" : pct >= 45 ? "mid" : "loose"));
      const first = document.querySelector(".q-does ol li");
      if (first) first.textContent = I18N.t("slots.q_does_1", { pct });
    };
    quality.addEventListener("input", paint);
    quality.addEventListener("change", () => saveSlots(true));
  }
  const conf = $("st-conf");
  if (conf) {
    const pct = $("st-conf-pct");
    conf.addEventListener("input", () => { if (pct) pct.textContent = Math.round(+conf.value * 100) + "%"; });
    conf.addEventListener("change", () => saveAi(true));
    conf.addEventListener("keydown", (e) => { if (e.key === "Enter") saveAi(true); });
  }
  // Lot sizing mode: auto (per-strategy preset) vs manual (fixed user lot).
  const saveVol = async (mode, quiet) => {
    const body = { volume_mode: mode };
    if (mode === "manual") body.manual_volume = +($("st-vol")?.value || 0.10);
    const r = await API.post("/api/auto", body);
    if (!quiet) toast(r.ok ? I18N.t("common.save") : (r.error || I18N.t("errors.generic")));
    await refresh(false);
    if (S.view === "settings") show("settings", { animate: false, closeMenu: false });
    return r;
  };
  const volTabs = $("vol-tabs");
  if (volTabs) volTabs.onclick = (e) => {
    const b = e.target.closest("[data-vm]"); if (!b) return;
    saveVol(b.dataset.vm === "manual" ? "manual" : "auto", false);
  };
  const stVol = $("st-vol");
  if (stVol) {
    const commit = async () => {
      await saveVol("manual", true);
      // Same number on the ticket and the EA chart, immediately.
      paintLotEverywhere(Number(stVol.value) || deskLot());
    };
    stVol.addEventListener("change", commit);
    stVol.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); });
  }
  const news = $("st-news");
  if (news) news.onclick = async () => {
    if (news.disabled || news.dataset.busy) return;
    news.dataset.busy = "1";
    const on = !news.classList.contains("on");
    paintSwitch(news, on);
    try {
      const r = await API.post("/api/auto", { news_trade: on });
      if (!r.ok) {
        paintSwitch(news, !on);
        if (licGateToast(r)) return;
        toast(r.error || I18N.t("errors.generic"));
        return;
      }
      toast(I18N.t(on ? "strategies.news_on" : "strategies.news_off"));
      await reloadSettings();
    } finally {
      delete news.dataset.busy;
    }
  };
  // Auto entry point: rest the robot's order at a price with the stop and
  // target attached, instead of taking the market the second a candle shuts.
  const autoEntry = $("st-autoentry");
  if (autoEntry) autoEntry.onclick = async () => {
    if (autoEntry.disabled || autoEntry.dataset.busy) return;
    autoEntry.dataset.busy = "1";
    const on = !autoEntry.classList.contains("on");
    paintSwitch(autoEntry, on);
    try {
      const r = await API.post("/api/auto", { auto_entry: { enabled: on } });
      if (!r.ok) {
        paintSwitch(autoEntry, !on);
        if (licGateToast(r)) return;
        toast(r.error || I18N.t("errors.generic"));
        return;
      }
      toast(I18N.t(on ? "autoentry.on" : "autoentry.off"));
      await reloadSettings();
    } finally {
      delete autoEntry.dataset.busy;
    }
  };
  // The broker line follows the field as it is typed, or it is a
  // conversion of whatever was there when the page was drawn.
  for (const id of ["pr-hs", "pr-he"]) {
    const field = $(id);
    if (!field) continue;
    const echo = document.querySelector(`.prop-at-broker[data-for="${id}"]`);
    if (!echo) continue;
    field.addEventListener("input", () => { echo.textContent = brokerEcho(field.value); });
  }

  const moneySave = $("st-money-save");
  if (moneySave) moneySave.onclick = async () => {
    const field = $("st-money-cap");
    const r = await API.post("/api/money", { max_loss_per_lot: +(field?.value || 0) });
    if (!r.ok) { toast(r.error || I18N.t("errors.generic")); return; }
    const reach = $("st-money-reach");
    if (reach) reach.textContent = moneyReach(r.money || {});
    toast(I18N.t(Number(r.money?.max_loss_per_lot) ? "money.saved" : "money.saved_off"));
    await reloadSettings();
  };

  bindPropGuide();

  const tzSel = $("sys-tz");
  if (tzSel) tzSel.onchange = async () => {
    const r = await API.post("/api/timezone", { timezone: tzSel.value });
    if (!r.ok) { toast(r.error || I18N.t("errors.generic")); return; }
    const label = r.system?.label || tzSel.value;
    toast(I18N.t("sys.tz_set", { z: label }));
    await reloadSettings();
  };

  const rfSw = $("st-rf");
  if (rfSw) rfSw.onclick = async () => {
    if (rfSw.disabled || rfSw.dataset.busy) return;
    rfSw.dataset.busy = "1";
    const on = !rfSw.classList.contains("on");
    paintSwitch(rfSw, on);
    try {
      const r = await API.post("/api/risk_free", { enabled: on, ladder: on });
      if (!r.ok) {
        paintSwitch(rfSw, !on);
        toast(r.error || I18N.t("errors.generic"));
        return;
      }
      toast(I18N.t(on ? "strategies.rf_on" : "strategies.rf_off"));
      await reloadSettings();
    } finally {
      delete rfSw.dataset.busy;
    }
  };
  const rfSteps = $("st-rf-steps");
  if (rfSteps) {
    const n = $("st-rf-steps-n");
    rfSteps.addEventListener("input", () => {
      if (n) n.textContent = String(rfSteps.value);
      // Redraw the named rungs as the slider moves, so the trader is
      // choosing between "TP1, TP2, TP3" and not between 3 and 4.
      const ladder = $("st-rf-ladder");
      const steps = Math.max(1, Math.min(5, +rfSteps.value || 3));
      if (ladder) {
        ladder.innerHTML = rfLadderHtml({
          steps,
          rungs: Array.from({ length: steps }, (_, i) => ({
            step: i + 1,
            label: `TP${i + 1}`,
            moves_to: i === 0 ? "entry" : `TP${i}`,
            fraction: (i + 1) / steps,
          })),
        });
      }
    });
    rfSteps.addEventListener("change", async () => {
      const r = await API.post("/api/risk_free", { steps: +rfSteps.value });
      if (!r.ok) toast(r.error || I18N.t("errors.generic"));
      await refresh(false);
    });
  }

  const dgSw = $("st-danger");
  if (dgSw) dgSw.onclick = async () => {
    if (dgSw.disabled || dgSw.dataset.busy) return;
    dgSw.dataset.busy = "1";
    const on = !dgSw.classList.contains("on");
    paintSwitch(dgSw, on);
    try {
      const r = await API.post("/api/danger", { enabled: on });
      if (!r.ok) {
        paintSwitch(dgSw, !on);
        toast(r.error || I18N.t("errors.generic"));
        return;
      }
      toast(I18N.t(on ? "strategies.danger_on" : "strategies.danger_off"));
      await reloadSettings();
    } finally {
      delete dgSw.dataset.busy;
    }
  };
  const dgSens = $("st-danger-sens");
  if (dgSens) {
    const pct = $("st-danger-pct");
    dgSens.addEventListener("input", () => { if (pct) pct.textContent = dgSens.value + "%"; });
    dgSens.addEventListener("change", async () => {
      const r = await API.post("/api/danger", { sensitivity: +dgSens.value });
      if (!r.ok) toast(r.error || I18N.t("errors.generic"));
      await refresh(false);
    });
  }
  const tabs = $("style-tabs");
  if (tabs) tabs.onclick = async (e) => {
    const b = e.target.closest("[data-style]"); if (!b) return;
    if (b.disabled) { toast(I18N.t("lic.err_locked")); show("upgrade"); return; }
    const r = await API.post("/api/auto", { trade_style: b.dataset.style });
    if (licGateToast(r)) return;
    toast(r.ok ? I18N.t("style." + b.dataset.style) : (r.error || I18N.t("errors.generic")));
    await refresh(false);
    if (S.view === "settings") show("settings", { animate: false, closeMenu: false });
  };
}

async function loadUsers() {
  if (!S.user || !S.user.is_owner) return;
  try {
    const [u, a] = await Promise.all([API.get("/api/users"), API.get("/api/access?limit=80")]);
    S.users = (u && u.ok && u.data) || [];
    S.access = (a && a.ok && a.data) || [];
  } catch {
    S.users = S.users || [];
    S.access = S.access || [];
  }
}
function bindUsersPanel() {
  if (!S.user || !S.user.is_owner) return;
  if (!Array.isArray(S.users)) {
    loadUsers().then(() => {
      if (S.view === "settings") show("settings", { animate: false, closeMenu: false });
    });
  }
  const add = $("u-add");
  if (add) add.onclick = async () => {
    const username = String($("u-name")?.value || "").trim();
    const password = String($("u-pass")?.value || "");
    const role = String($("u-role")?.value || "trader");
    const msg = $("u-msg");
    const r = await API.post("/api/users", { username, password, role, language: I18N.lang });
    if (!r.ok) {
      const map = { identity: "auth.identity", weak_password: "auth.weak_password", need_fields: "auth.need_fields", forbidden: "errors.forbidden" };
      const text = I18N.t(map[r.error] || "errors.generic");
      if (msg) msg.textContent = text;
      toast(text);
      return;
    }
    if (msg) msg.textContent = I18N.t("users.created");
    toast(I18N.t("users.created"));
    await loadUsers();
    if (S.view === "settings") show("settings", { animate: false, closeMenu: false });
  };
  document.querySelectorAll("[data-user-toggle]").forEach((b) => {
    b.onclick = async () => {
      const id = b.getAttribute("data-user-toggle");
      const off = b.getAttribute("data-off") === "1";
      const r = await API.post(`/api/users/${encodeURIComponent(id)}/${off ? "disable" : "enable"}`, {});
      if (!r.ok) return toast(I18N.t(r.error === "self" ? "errors.self" : "errors.forbidden"));
      await loadUsers();
      if (S.view === "settings") show("settings", { animate: false, closeMenu: false });
    };
  });
}
function bindPropEnable() {
  const seen = new Set();
  const switches = [...document.querySelectorAll("[data-prop-enable], #prop-enable")].filter((el) => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });
  switches.forEach((sw) => {
    sw.onclick = async () => {
      if (sw.dataset.busy) return;
      switches.forEach((el) => { el.dataset.busy = "1"; });
      const on = !sw.classList.contains("on");
      switches.forEach((el) => paintSwitch(el, on));
      const sub = $("prop-enable-sub");
      if (sub) sub.textContent = I18N.t(on ? "risk.prop_on" : "risk.prop_off");
      const lk = $("pr-lock");
      const uk = $("pr-unlock");
      if (lk) lk.disabled = !on;
      if (uk) uk.disabled = !on;
      try {
        const r = await API.post("/api/prop/enable", { enabled: on });
        if (!r.ok) {
          switches.forEach((el) => paintSwitch(el, !on));
          if (sub) sub.textContent = I18N.t(!on ? "risk.prop_on" : "risk.prop_off");
          if (lk) lk.disabled = on;
          if (uk) uk.disabled = on;
          if (!licGateToast(r)) toast(r.error || I18N.t("errors.generic"));
          return;
        }
        S.snap = S.snap || {};
        S.snap.prop = { ...(S.snap.prop || {}), enabled: on, ...(r.prop || r.data || {}) };
        toast(I18N.t(on ? "risk.prop_on" : "risk.prop_off"));
        await reloadSettings();
      } finally {
        switches.forEach((el) => { delete el.dataset.busy; });
      }
    };
  });
}

function customPropPayload() {
  return {
    id: "custom",
    max_daily_loss_pct: +$("pr-dday").value, max_drawdown_pct: +$("pr-mdd").value,
    max_daily_profit_pct: +($("pr-dtp")?.value || 0),
    max_lot: +$("pr-lot").value, max_open_trades: +$("pr-n").value,
    max_positions_per_symbol: +($("pr-ps")?.value || 1),
    max_risk_per_trade_pct: +($("pr-risk")?.value || 0),
    max_consecutive_losses: +($("pr-cl")?.value || 0),
    min_minutes_between_trades: +($("pr-gap")?.value || 0),
    friday_close_utc_hour: +($("pr-fri")?.value || 21),
    trading_hours: { start: $("pr-hs")?.value || "00:15", end: $("pr-he")?.value || "23:45", weekdays: [0, 1, 2, 3, 4] },
    allowed_symbols: $("pr-syms")?.value || "",
    on_violation: $("pr-vio")?.value || "flatten_and_lock",
    news_filter: Boolean($("pr-news")?.checked),
    allow_weekend: Boolean($("pr-we")?.checked),
    allow_hold_over_weekend: Boolean($("pr-hold")?.checked),
    min_hold_minutes: +($("pr-holdmin")?.value || 0),
    max_hold_hours: +($("pr-maxhold")?.value || 0),
    max_trades_per_day: +($("pr-dayn")?.value || 0),
    max_lot_per_symbol: +($("pr-lotsym")?.value || 0),
    profit_target_pct: +($("pr-pt")?.value || 0),
    news_blackout_before: +($("pr-nb")?.value || 15),
    news_blackout_after: +($("pr-na")?.value || 15),
    hedging_allowed: Boolean($("pr-hedge")?.checked),
  };
}

/* ---------------------------------------------------------------------------
 * Allowed symbols — a selection list, never a free-text field.
 *
 * The engine's prop profile stores ``allowed_symbols`` as a comma-separated
 * string, so the picker writes back to the same hidden input the save path
 * already reads; only the way the user picks symbols changes.
 * ------------------------------------------------------------------------- */
const SYM_PICK = { all: [], source: "", selected: new Set(), open: false };

async function loadSymbolChoices() {
  if (SYM_PICK.all.length) return SYM_PICK.all;
  try {
    const r = await API.get("/api/symbols");
    const d = (r && r.data) || {};
    SYM_PICK.all = Array.isArray(d.symbols) ? d.symbols.map((x) => String(x).toUpperCase()) : [];
    SYM_PICK.source = d.source || "";
  } catch (_) {
    SYM_PICK.all = [];
  }
  return SYM_PICK.all;
}

function symPaintList(filter) {
  const list = $("pr-syms-list");
  if (!list) return;
  const q = String(filter || "").trim().toUpperCase();
  const rows = SYM_PICK.all.filter((s) => !q || s.includes(q));
  list.innerHTML = rows.length
    ? rows
        .map(
          (sym) =>
            `<label class="sym-row${SYM_PICK.selected.has(sym) ? " on" : ""}" data-sym="${esc(sym)}">` +
            `<input type="checkbox" value="${esc(sym)}"${SYM_PICK.selected.has(sym) ? " checked" : ""} />` +
            `<span>${esc(sym)}</span></label>`,
        )
        .join("")
    : `<div class="sym-empty">${esc(I18N.t("risk.symbols_empty"))}</div>`;
  symPaintFoot();
}

function symPaintFoot() {
  const foot = $("pr-syms-foot");
  const label = $("pr-syms-label");
  const n = SYM_PICK.selected.size;
  if (foot) foot.textContent = I18N.t("risk.symbols_count", { n });
  if (label) {
    // The chosen symbols are shown as chips on the control itself. A count
    // alone ("6 selected") forces the trader to open the panel to find out
    // which six, which is the question they actually have.
    if (!n) {
      label.innerHTML = `<em class="sym-none">${esc(I18N.t("risk.symbols_all_allowed"))}</em>`;
    } else {
      const picks = Array.from(SYM_PICK.selected).sort();
      const shown = picks.slice(0, 6);
      label.innerHTML = shown.map((sym) =>
        `<span class="sym-chip">${esc(sym)}<i data-unpick="${esc(sym)}" title="${esc(I18N.t("risk.symbols_clear"))}">&times;</i></span>`
      ).join("") + (picks.length > shown.length
        ? `<span class="sym-chip more">+${picks.length - shown.length}</span>` : "");
    }
  }
  const hidden = $("pr-syms");
  if (hidden) hidden.value = Array.from(SYM_PICK.selected).sort().join(",");
}

async function bindSymbolPicker() {
  const wrap = $("pr-syms-pick");
  if (!wrap || wrap._bound) return;
  wrap._bound = true;
  const label = $("pr-syms-label");
  if (label) label.onclick = (e) => {
    const x = e.target.closest("[data-unpick]");
    if (!x) return;
    // Do not let the click reach the button, or the panel opens as it closes.
    e.preventDefault();
    e.stopPropagation();
    SYM_PICK.selected.delete(x.getAttribute("data-unpick"));
    symPaintList($("pr-syms-q") ? $("pr-syms-q").value : "");
  };

  const btn = $("pr-syms-btn");
  const panel = $("pr-syms-panel");
  const list = $("pr-syms-list");
  const q = $("pr-syms-q");

  const seed = String($("pr-syms")?.value || "")
    .split(/[,;]/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  SYM_PICK.selected = new Set(seed);
  await loadSymbolChoices();
  // Keep symbols the profile already had even if the broker list lacks them.
  seed.forEach((x) => { if (!SYM_PICK.all.includes(x)) SYM_PICK.all.push(x); });
  SYM_PICK.all.sort();
  symPaintList("");
  symPaintFoot();

  const setOpen = (v) => {
    SYM_PICK.open = v;
    if (panel) panel.hidden = !v;
    if (btn) btn.setAttribute("aria-expanded", v ? "true" : "false");
    if (v && q) setTimeout(() => q.focus(), 0);
  };

  btn?.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!SYM_PICK.open); });
  document.addEventListener("click", (e) => {
    if (SYM_PICK.open && !wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && SYM_PICK.open) setOpen(false); });
  q?.addEventListener("input", () => symPaintList(q.value));
  q?.addEventListener("click", (e) => e.stopPropagation());
  panel?.addEventListener("click", (e) => e.stopPropagation());
  $("pr-syms-all")?.addEventListener("click", () => {
    SYM_PICK.selected = new Set(SYM_PICK.all);
    symPaintList(q?.value || "");
  });
  $("pr-syms-none")?.addEventListener("click", () => {
    SYM_PICK.selected = new Set();
    symPaintList(q?.value || "");
  });
  list?.addEventListener("change", (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const sym = String(box.value || "").toUpperCase();
    if (box.checked) SYM_PICK.selected.add(sym);
    else SYM_PICK.selected.delete(sym);
    const row = box.closest(".sym-row");
    if (row) row.classList.toggle("on", box.checked);
    symPaintFoot();
  });
}

function bindPropForm() {
  const preset = $("pr-preset");
  if (preset) {
    preset.onchange = async () => {
      const id = preset.value || "custom";
      if ($("pr-id")) $("pr-id").value = id;
      const r = await API.post("/api/prop", { profile: { id } });
      if (licGateToast(r)) return;
      toast(r.ok ? I18N.t("risk.preset_applied") : (r.error || I18N.t("errors.generic")));
      if (r.ok) {
        if (r.data) {
          S.snap = S.snap || {};
          S.snap.prop = { ...(S.snap.prop || {}), profile: r.data, ...(r.prop || {}) };
        }
        await reloadSettings();
      }
    };
  }
  const save = $("pr-save");
  if (!save) return;
  save.onclick = async () => {
    const r = await API.post("/api/prop", { profile: customPropPayload() });
    if (!licGateToast(r)) toast(r.ok ? I18N.t("common.save") : (r.error || I18N.t("errors.generic")));
    if (r.ok) await reloadSettings();
  };
}

/* ------------------------------------------------- backtest, while running
 *
 * A replay can run for minutes. Until now the only sign of life was a
 * spinner and a percentage, which tells the trader the engine has not
 * hung but nothing about what it is finding. The engine publishes a live
 * snapshot on every progress tick (backtest/engine.py passes equity, the
 * thinned curve, the trade count and the bar it has reached), so the run
 * is drawn as it happens: the symbol's own chart, the equity curve
 * forming, and the counters moving.
 */
function renderBacktestLive(bt) {
  bt = bt || S.backtest || {};
  if (!bt.running) return "";
  const live = (bt.live && typeof bt.live === "object") ? bt.live : {};
  const pct = Math.max(0, Math.min(99, Math.round(Number(bt.progress) || 0)));
  const symbol = String(bt.symbol || "");
  const tf = String(bt.timeframe || S.timeframe || "M15");
  const curve = Array.isArray(live.equity_curve)
    ? live.equity_curve.map(Number).filter((x) => Number.isFinite(x))
    : [];

  // Only state the engine actually reported. A run that has not yet sent
  // its first snapshot shows a dash, never a stand-in number.
  const eq = Number.isFinite(Number(live.equity)) ? fmt(Number(live.equity)) : "—";
  const done = Number.isFinite(Number(live.trades_so_far)) ? fmt(Number(live.trades_so_far), 0) : "—";
  const at = live.at ? esc(String(live.at)) : "—";
  const side = live.open_side ? esc(String(live.open_side)).toUpperCase() : "—";

  return `<div class="bt-live">
    <div class="tape-banner is-backtest" style="margin:0 0 10px">
      ${I18N.t("bt.live_running")} · ${esc(symbol)} ${esc(tf)} · ${esc(String(bt.strategy || ""))}
    </div>
    <div class="bt-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <i style="width:${pct}%"></i><b class="mono">${pct}%</b>
    </div>
    <div class="kv bt-kv">
      <span>${I18N.t("bt.live_equity")}</span><b class="mono">${eq}</b>
      <span>${I18N.t("bt.live_trades")}</span><b class="mono">${done}</b>
      <span>${I18N.t("bt.live_bar")}</span><b class="mono">${at}</b>
      <span>${I18N.t("bt.live_position")}</span><b class="mono">${side}</b>
    </div>
    <div class="bt-live-chart">
      <canvas data-mini="${esc(symbol)}" data-tf="${esc(tf)}" id="bt-live-chart"></canvas>
    </div>
    <p class="sub">${I18N.t("bt.live_chart_hint")}</p>
    ${curve.length > 1 ? `<div class="bt-curve"><canvas id="bt-curve"></canvas></div>
    <p class="sub">${I18N.t("bt.live_curve_hint")}</p>` : ""}
  </div>`;
}

/* Keep the live panel current without rebuilding it.
 *
 * Snapshots arrive about twice a second. Re-writing innerHTML on each one
 * would throw away the chart canvas and re-request the symbol's candles
 * at that same rate, so the markup is built once per run and only the
 * values that moved are written afterwards. The candle chart refreshes on
 * its own slower schedule - it is showing the live market, which does not
 * change meaningfully between ticks of a replay.
 */
function paintBacktestLive(box, bt, running) {
  if (!running) {
    if (box.innerHTML !== "") box.innerHTML = "";
    box.removeAttribute("data-run");
    S._btChartAt = 0;
    return;
  }
  const key = `${bt.symbol || ""}|${bt.timeframe || ""}|${bt.strategy || ""}`;
  const snap = (bt.live && typeof bt.live === "object") ? bt.live : {};
  const lc = Array.isArray(snap.equity_curve)
    ? snap.equity_curve.map(Number).filter((x) => Number.isFinite(x))
    : [];

  // Rebuild only when the run changes, or when the curve's canvas first
  // becomes needed (the first snapshot arrives after the panel is up).
  const fresh = box.getAttribute("data-run") !== key;
  const needsCurve = lc.length > 1 && !box.querySelector("#bt-curve");
  if (fresh || needsCurve) {
    box.innerHTML = renderBacktestLive(bt);
    box.setAttribute("data-run", key);
    if (fresh) S._btChartAt = 0;
  } else {
    const pct = Math.max(0, Math.min(99, Math.round(Number(bt.progress) || 0)));
    const bar = box.querySelector(".bt-prog i");
    const num = box.querySelector(".bt-prog b");
    const prog = box.querySelector(".bt-prog");
    if (bar) bar.style.width = pct + "%";
    if (num) num.textContent = pct + "%";
    if (prog) prog.setAttribute("aria-valuenow", String(pct));
    const cells = box.querySelectorAll(".bt-kv b");
    if (cells.length >= 4) {
      cells[0].textContent = Number.isFinite(Number(snap.equity)) ? fmt(Number(snap.equity)) : "—";
      cells[1].textContent = Number.isFinite(Number(snap.trades_so_far)) ? fmt(Number(snap.trades_so_far), 0) : "—";
      cells[2].textContent = snap.at ? String(snap.at) : "—";
      cells[3].textContent = snap.open_side ? String(snap.open_side).toUpperCase() : "—";
    }
  }

  if (lc.length > 1) requestAnimationFrame(() => drawEquityCurve(lc));

  // The symbol's real candles, fetched the way the watchlist thumbnails
  // are. Rate-limited: a replay publishes far faster than the market moves.
  const now = Date.now();
  if (bt.symbol && now - (S._btChartAt || 0) > 10000) {
    S._btChartAt = now;
    paintMiniCharts();
  }
}

function renderBacktestCard(bt) {
  bt = bt || S.backtest || {};
  if (bt.running) return "";
  // The empty state belongs to one element now that both halves of the
  // result share a card: renderBacktestExtra owns it. Saying it twice in
  // the same box read like a fault.
  if (!bt || (!bt.ok && !bt.error && bt.mode !== "backtest")) return "";
  if (!bt.ok) return `<p class="err">${esc(bt.error || I18N.t("errors.generic"))}</p>`;
  const m = bt.metrics || {};
  return `<div class="tape-banner is-backtest" style="margin:12px 0 10px">${I18N.t("tape.showing_backtest")} · ${esc(bt.symbol || "")} ${esc(bt.timeframe || "")} · ${esc(bt.strategy || "")}</div>
    <div class="kv">
      <span>${I18N.t("history.winrate")}</span><b>${fmt(m.win_rate)}%</b>
      <span>${I18N.t("history.pf")}</span><b>${fmt(m.profit_factor,2)}</b>
      <span>${I18N.t("history.sharpe")}</span><b>${fmt(m.sharpe,2)}</b>
      <span>${I18N.t("history.rr")}</span><b>${fmt(m.avg_rr,2)}</b>
      <span>${I18N.t("history.net")}</span><b class="${clsPnl(m.net)}">${fmt(m.net)}</b>
      <span>${I18N.t("history.trades")}</span><b>${fmt(m.trades || (bt.trades || []).length, 0)}</b>
    </div>
    ${btProvenance(bt)}`;
}

/**
 * Where the numbers above came from.
 *
 * The engine refuses to replay anything but real MT5 bars, but a refusal
 * in the source code is not something a trader can see. Printing the
 * first and last bar of the window that was actually replayed turns
 * "these are real" from a claim into something checkable against their
 * own terminal.
 */
function btProvenance(bt) {
  const d = (bt && bt.data) || {};
  if (!d.first_bar && !d.last_bar && !bt.bars) return "";
  const span = d.first_bar && d.last_bar
    ? `${esc(String(d.first_bar))} → ${esc(String(d.last_bar))}`
    : "—";
  return `<p class="sub bt-prov" style="margin-top:10px">
    ${I18N.t("bt.prov_source")} · <b class="mono">${esc(String(d.source || "mt5").toUpperCase())}</b>
    · ${I18N.t("bt.prov_window")} <b class="mono">${span}</b>
    · ${I18N.t("bt.prov_bars")} <b class="mono">${fmt(d.tested_bars || bt.bars || 0, 0)}</b>${d.warmup_bars ? ` (+${fmt(d.warmup_bars, 0)} ${I18N.t("bt.prov_warmup")})` : ""}
  </p>`;
}
/* ---------------------------------------------------------- backtest results
 *
 * The "Backtest results" card was an empty div. The engine has been
 * returning an equity curve and the trade list all along (backtest/engine.py
 * sends `equity_curve` and `trades`) and the desk threw both away, so a
 * finished run was six numbers in a box with no way to see HOW it got
 * there - a run that made its money in one lucky bar looked identical to a
 * steady one.
 *
 * Everything drawn here is measured output from the replay. Nothing is
 * modelled, smoothed or filled in. */
function renderBacktestExtra(bt) {
  bt = bt || S.backtest || {};
  if (bt.running) return "";
  if (!bt.ok) return `<p class="sub">${I18N.t("bt.empty")}</p>`;

  const curve = Array.isArray(bt.equity_curve) ? bt.equity_curve.map(Number).filter((x) => Number.isFinite(x)) : [];
  const trades = Array.isArray(bt.trades) ? bt.trades : [];
  const m = bt.metrics || {};

  let head = "";
  if (curve.length > 1) {
    const start = curve[0];
    const final = curve[curve.length - 1];
    let peak = curve[0];
    let dd = 0;
    for (const v of curve) { if (v > peak) peak = v; const d = peak - v; if (d > dd) dd = d; }
    head = `<div class="kv bt-kv">
      <span>${I18N.t("bt.start")}</span><b class="mono">${fmt(start)}</b>
      <span>${I18N.t("bt.final")}</span><b class="mono ${clsPnl(final - start)}">${fmt(final)}</b>
      <span>${I18N.t("bt.peak")}</span><b class="mono">${fmt(peak)}</b>
      <span>${I18N.t("bt.dd")}</span><b class="mono ${dd > 0 ? "down" : ""}">${fmt(dd)}</b>
    </div>
    <div class="bt-curve"><canvas id="bt-curve"></canvas></div>
    <p class="sub">${I18N.t("bt.curve_hint")}</p>`;
  }

  let table = `<p class="sub">${I18N.t("bt.no_trades")}</p>`;
  if (trades.length) {
    const total = Number(m.trades || trades.length);
    const rows = trades.slice().reverse().map((t) => {
      const side = String(t.type || "").toLowerCase();
      return `<tr>
        <td class="mono">${esc(btWhen(t.time))}</td>
        <td><span class="pill tiny ${side === "buy" ? "up" : "down"}">${esc(side.toUpperCase() || "—")}</span></td>
        <td class="mono">${fmt(t.entry, 5)}</td>
        <td class="mono">${fmt(t.exit, 5)}</td>
        <td class="mono ${clsPnl(t.profit)}">${fmt(t.profit)}</td>
        <td class="sub">${esc(String(t.exit_reason || "—"))}</td>
      </tr>`;
    }).join("");
    table = `<h4 class="bt-sub">${I18N.t("bt.trades_title")}</h4>
      <p class="sub">${esc(I18N.t("bt.showing", { n: trades.length, total }))}</p>
      <div class="table-wrap bt-trades">
        <table>
          <thead><tr>
            <th>${I18N.t("bt.t_when")}</th><th>${I18N.t("bt.t_side")}</th>
            <th>${I18N.t("bt.t_entry")}</th><th>${I18N.t("bt.t_exit")}</th>
            <th>${I18N.t("bt.t_pnl")}</th><th>${I18N.t("bt.t_why")}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }
  return head + table;
}

/** Bar times arrive as ISO strings or epoch seconds depending on the feed. */
function btWhen(v) {
  if (v == null || v === "") return "—";
  let d = null;
  if (typeof v === "number") d = new Date(v > 1e11 ? v : v * 1000);
  else d = new Date(String(v));
  if (!d || isNaN(d.getTime())) return String(v);
  try {
    return d.toLocaleString(I18N.locale(), { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/* Draw the equity curve on its canvas.
 *
 * Deliberately plain: one line, a zero-profit baseline, filled above and
 * below in profit/loss colour. Reading "did it climb or grind down" must
 * not require interpreting a legend. */
function drawEquityCurve(curve) {
  const cv = $("bt-curve");
  if (!cv || !Array.isArray(curve) || curve.length < 2) return;
  const box = cv.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(240, (box ? box.clientWidth : 0) || 240);
  const h = Math.max(140, (box ? box.clientHeight : 0) || 180);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  const g = cv.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  /* Custom properties are not guaranteed to come back resolved: an
     unregistered property whose value is `var(--candle-up)` can be handed
     back as that literal text. --ok and --bad are both aliases, so follow
     the chain a few links before giving up. */
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    let v = (css.getPropertyValue(name) || "").trim();
    for (let i = 0; i < 4 && /^var\(\s*--/.test(v); i++) {
      const ref = v.slice(v.indexOf("--")).split(/[,)]/)[0].trim();
      v = (css.getPropertyValue(ref) || "").trim();
    }
    return v && !/^var\(/.test(v) ? v : fallback;
  };
  // --ok / --bad are the desk's profit and loss colours; they follow the
  // active theme, so the curve is never the wrong green in a light skin.
  const up = pick("--ok", "#2fd48a");
  const down = pick("--bad", "#ff5f6d");
  const grid = pick("--line", "rgba(255,255,255,.08)");

  const base = curve[0];
  let lo = Math.min(...curve, base);
  let hi = Math.max(...curve, base);
  if (hi - lo < 1e-9) { hi = base + 1; lo = base - 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const padL = 8, padR = 8, padT = 10, padB = 10;
  const x = (i) => padL + (i / (curve.length - 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  // The starting-equity line: above it the run is in profit, below it is not.
  g.strokeStyle = grid;
  g.lineWidth = 1;
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(padL, y(base));
  g.lineTo(w - padR, y(base));
  g.stroke();
  g.setLineDash([]);

  const ended = curve[curve.length - 1] >= base;
  const colour = ended ? up : down;

  const fill = g.createLinearGradient(0, padT, 0, h - padB);
  // A var() can resolve to anything; only a plain hex can take an alpha
  // suffix. Anything else falls back to a flat global alpha below.
  const soft = /^#[0-9a-f]{6}$/i.test(colour) ? colour + "3a" : "";
  fill.addColorStop(0, soft || colour);
  fill.addColorStop(1, "transparent");
  g.beginPath();
  g.moveTo(x(0), y(curve[0]));
  for (let i = 1; i < curve.length; i++) g.lineTo(x(i), y(curve[i]));
  g.lineTo(x(curve.length - 1), y(base));
  g.lineTo(x(0), y(base));
  g.closePath();
  g.save();
  if (!soft) g.globalAlpha = 0.22;
  g.fillStyle = fill;
  g.fill();
  g.restore();

  g.beginPath();
  g.moveTo(x(0), y(curve[0]));
  for (let i = 1; i < curve.length; i++) g.lineTo(x(i), y(curve[i]));
  g.strokeStyle = colour;
  g.lineWidth = 2;
  g.lineJoin = "round";
  g.stroke();

  // Where it finished.
  g.beginPath();
  g.arc(x(curve.length - 1), y(curve[curve.length - 1]), 3.5, 0, Math.PI * 2);
  g.fillStyle = colour;
  g.fill();
}

/**
 * Put a finished run on screen: the summary in its own card, the curve and
 * the trade list in the results card, and - when the run has just finished -
 * bring the results into view. A replay can take minutes; the trader will
 * have scrolled away or be reading something else, and a result that lands
 * silently off-screen is a result they do not know they have.
 */
function paintBacktestResults(bt, opts) {
  bt = bt || S.backtest || {};
  const running = Boolean(bt.running);

  // The live panel and the finished result occupy the same card and are
  // never both meaningful, so each render clears the other. Without this
  // the running view stayed on screen underneath the result.
  const liveBox = $("bt-live");
  if (liveBox) paintBacktestLive(liveBox, bt, running);

  const box = $("bt-result");
  if (box) box.innerHTML = renderBacktestCard(bt);
  const extra = $("bt-extra");
  if (extra) {
    extra.innerHTML = renderBacktestExtra(bt);
    if (!running && bt.ok && Array.isArray(bt.equity_curve) && bt.equity_curve.length > 1) {
      requestAnimationFrame(() => drawEquityCurve(bt.equity_curve.map(Number).filter((x) => Number.isFinite(x))));
    }
  }
  if (opts && opts.reveal) {
    const target = $("bt-extra-card") || extra;
    if (target && target.scrollIntoView) {
      let smooth = true;
      try { smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* */ }
      try { target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" }); } catch (e) { target.scrollIntoView(); }
    }
    // A flash on the card so the eye lands on what just changed.
    const card = $("bt-extra-card");
    if (card) {
      card.classList.remove("is-fresh");
      void card.offsetWidth;
      card.classList.add("is-fresh");
    }
  }
}

function setBacktestBusy(on, progress) {
  const btn = $("h-bt");
  const load = $("bt-load");
  if (btn) {
    btn.disabled = Boolean(on) || !liveSymbols().length;
    btn.textContent = I18N.t(on ? "history.backtest_running" : "history.backtest_run");
  }
  if (load) load.classList.toggle("hidden", !on);
  const say = load ? load.querySelector("span") : null;
  if (say) {
    const pct = Number(progress);
    // A number that moves is the difference between "working" and "hung".
    say.textContent = on && pct > 0
      ? `${I18N.t("history.backtest_wait")} · ${Math.min(99, Math.round(pct))}%`
      : I18N.t("history.backtest_wait");
  }
}

/**
 * Follow a running backtest even if the socket drops.
 *
 * The result arrives over the socket, which is the fast path and the one
 * that carries progress. This is the slow one: it asks the engine for the
 * run's state every few seconds, so a reconnect in the middle of a replay
 * cannot leave the page spinning forever.
 */
function watchBacktest() {
  if (S._btPoll) clearInterval(S._btPoll);
  let misses = 0;
  S._btPoll = setInterval(async () => {
    if (!S._btBusy) { clearInterval(S._btPoll); S._btPoll = null; return; }
    let r = null;
    try {
      r = await API.get("/api/backtest");
    } catch {
      r = null;
    }
    const d = r && r.data ? r.data : null;
    if (!d) {
      misses += 1;
      if (misses >= 10) {        // ~50s with no answer at all
        clearInterval(S._btPoll); S._btPoll = null;
        S._btBusy = false;
        setBacktestBusy(false);
      }
      return;
    }
    misses = 0;
    S.backtest = d;
    if (S.snap) S.snap.backtest = d;
    if (d.running) {
      setBacktestBusy(true, d.progress);
      // Keep the live panel moving on the fallback path too, so a dropped
      // socket costs refresh rate and not the live view itself.
      if (S.view === "backtest") paintBacktestResults(d);
      return;
    }
    clearInterval(S._btPoll); S._btPoll = null;
    S._btBusy = false;
    setBacktestBusy(false);
    paintBacktestResults(d, { reveal: true });
    if (d.ok) toast(I18N.t("history.backtest_done"));
    headerState();
  }, 5000);
}
function historyRows(rows) {
  // Entries and closes both appear, so a trade shows up the moment it opens.
  return Array.isArray(rows) ? rows : [];
}

/**
 * Present a history row the way MetaTrader's own statement does.
 *
 * The columns are deliberately the terminal's columns, in the terminal's
 * order: open time, position, symbol, type, volume, open price, S/L, T/P,
 * close time, close price, commission, swap, profit. A trader checking the
 * desk against MT5 should be reading two copies of the same table, not
 * translating between two layouts and two conventions.
 *
 * Swap and commission are their own columns rather than one "fees", because
 * that is how the terminal reports them and because a single lumped figure
 * cannot be checked against anything. Net is the one column MT5 does not
 * have, and it is the one that explains the balance: MT5's Profit is gross,
 * and the account moves by profit + swap + commission.
 */
function historyRowView(row) {
  const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
  const profit = num(row.profit);
  const swap = num(row.swap);
  const comm = num(row.commission);
  const net = row.net !== undefined && row.net !== null ? num(row.net) : profit + swap + comm;
  const isClose = String(row.kind || row.entry || "").toLowerCase().match(/close|out/);
  return {
    ...row,
    // Both ends of the position, as the terminal lists them.
    ts_open: row.time_open || row.ts_open || "",
    price_close: isClose ? row.price : "",
    price_open: row.price_open || "",
    profit: isClose ? profit : "",
    swap: isClose && swap ? Number(swap.toFixed(2)) : "",
    commission: isClose && comm ? Number(comm.toFixed(2)) : "",
    net: isClose ? Number(net.toFixed(2)) : "",
    // A close recorded from the last floating price rather than from an MT5
    // deal is marked, instead of being presented as fact.
    source: row.source === "estimate" ? "≈" : "",
  };
}

async function loadHistory() {
  const box = $("h-body");
  if (!box) return;
  const r = await API.get("/api/history?limit=400");
  const rows = historyRows(r.data || []).map(historyRowView);
  if (!rows.length) { box.innerHTML = emptyMini(I18N.t("status.no_history")); return; }
  box.innerHTML = table(rows, ["ts_open","ts","ticket","symbol","side","volume",
                               "price_open","price_close","sl","tp",
                               "commission","swap","profit","net","source","strategy","comment"]);
}

async function hardRefresh() {
  if (S._hardRefreshing) return;
  S._hardRefreshing = true;
  const btn = $("btn-refresh");
  if (btn) btn.disabled = true;
  let veil = $("desk-reload");
  if (!veil) {
    veil = document.createElement("div");
    veil.id = "desk-reload";
    veil.className = "desk-reload";
    document.body.appendChild(veil);
  }
  veil.innerHTML = "<span>" + I18N.t("common.refresh") + "…</span>";
  veil.classList.remove("hidden");
  try {
    S.mountedView = null;
    await refresh(false);
    if (S.view === "markets" && S.symbol) await pickMarket(S.symbol, S.timeframe);
    if (S.view === "charts") {
      const a = await API.get("/api/agents");
      if (a && a.ok && S.snap) {
        S.snap.agents = a.data || [];
        S._agentCache = S.snap.agents;
      }
    }
    if (S.view === "history") await loadHistory();
    show(S.view, { animate: true, closeMenu: false });
  } finally {
    S._hardRefreshing = false;
    if (btn) btn.disabled = false;
    veil.classList.add("hidden");
  }
}
/* Market sessions are a per-trader preference, not per chart: someone who
   wants to see the London open wants it on every symbol they look at. */
function chartSessionsOn() {
  if (S.chartSessions !== undefined) return Boolean(S.chartSessions);
  try { S.chartSessions = localStorage.getItem("aurion.chart.sessions") === "on"; }
  catch (e) { S.chartSessions = false; }
  return S.chartSessions;
}

function setChartSessions(on) {
  S.chartSessions = Boolean(on);
  try { localStorage.setItem("aurion.chart.sessions", S.chartSessions ? "on" : "off"); } catch (e) { /* ignore */ }
  if (S.chart && typeof S.chart.setSessions === "function") S.chart.setSessions(S.chartSessions);
}

/* ===========================================================================
   Open positions beside a chart
   ===========================================================================
   What is open on this instrument belonged next to the chart of it, and was
   only ever reachable from a tab inside the drawing dock - so the one page a
   trader watches while a trade runs was the one page that did not say the
   trade existed.

   It is a strip in the normal flow, between the toolbar and the canvas. Not
   an overlay: an overlay either sits on the buttons or sits on the price,
   and both were ruled out. Being in the flow it also cannot be scrolled
   away from or hidden behind anything, and it holds its height when there
   is nothing open so the chart below it never jumps.
*/
function positionsFor(symbol) {
  return (S.snap?.positions || []).filter((r) => r && (!symbol || r.symbol === symbol));
}

function positionsSig(symbol) {
  return positionsFor(symbol)
    .map((r) => `${r.ticket}:${r.type}:${r.volume}:${r.price_open}:${r.profit}`).join("|");
}

function positionsStripBody(symbol) {
  const pos = positionsFor(symbol);
  return pos.length
    ? pos.map((r) => {
        const dir = String(r.type || "").toLowerCase().includes("sell") ? "sell" : "buy";
        const pl = Number(r.profit);
        return `<span class="pos-chip is-${dir}" title="${esc(strategyLabel(r.strategy))}">
          <b>${esc(String(r.type || dir).toUpperCase())}</b>
          <span class="mono">${fmt(r.volume, 2)}</span>
          <span class="mono pos-at">@ ${fmt(r.price_open, 5)}</span>
          <span class="mono pos-pl ${clsPnl(pl)}">${Number.isFinite(pl) ? (pl > 0 ? "+" : "") + fmt(pl, 2) : "—"}</span>
        </span>`;
      }).join("")
    : `<span class="pos-none">${esc(I18N.t("status.no_positions"))}</span>`;
}

function positionsStripHtml(symbol) {
  return `<div class="pos-strip" data-pos-strip="${esc(symbol || "")}" data-sig="${esc(positionsSig(symbol))}">
      <span class="pos-strip-h">${esc(I18N.t("command.positions"))}</span>
      <div class="pos-strip-list">${positionsStripBody(symbol)}</div>
    </div>`;
}

/* Repaint in place. The strip is rebuilt from the snapshot rather than
   re-rendering the view, because re-rendering a chart card would tear down
   the canvas the trader is looking at. Guarded by a signature so a snapshot
   that changed nothing about the open trades does not touch the DOM. */
function paintPositionStrips() {
  document.querySelectorAll("[data-pos-strip]").forEach((el) => {
    const sym = el.dataset.posStrip || "";
    const sig = positionsSig(sym);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const list = el.querySelector(".pos-strip-list");
    if (list) list.innerHTML = positionsStripBody(sym);
  });
}

function applyChartLevels(force) {
  if (!force) {
    if (S._lvlTimer) return;
    S._lvlTimer = setTimeout(() => { S._lvlTimer = null; applyChartLevels(true); }, 140);
    return;
  }
  const symbol = (S.chartFocus && S.chartFocus.symbol) || S.symbol || "";
  const pos = (S.snap?.positions || []).filter((r) => r && (!symbol || r.symbol === symbol));
  // Resting orders: the entry points the robot has planted and that have
  // not filled yet. The chart only ever drew open positions, so a robot
  // that had made its decision and was waiting at a price looked exactly
  // like a robot doing nothing.
  const ord = (S.snap?.orders || []).filter((r) => r && (!symbol || r.symbol === symbol));
  /* Same trigger as the chart's own levels: whatever moved the lines on the
     canvas has to move the strip above it, or the two disagree. */
  paintPositionStrips();
  if (S.chart && typeof S.chart.setLevels === "function") S.chart.setLevels(pos);
  if (S.chart && typeof S.chart.setOrders === "function") S.chart.setOrders(ord);
  syncChartPending();
  const box = $("chart-levels");
  if (!box) return;
  const sig = pos.map((r) => `${r.ticket}:${r.sl}:${r.tp}:${r.profit}`).join("|")
    + "#" + ord.map((r) => `${r.ticket}:${r.price}:${r.sl}:${r.tp}`).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!pos.length && !ord.length) { box.innerHTML = ""; return; }
  const posHtml = pos.map((r) => `<div class="lvl-chip">
      <b>${esc(r.symbol || "")} ${esc(r.type || "")} ${fmt(r.volume, 2)}</b>
      <span class="sl">SL ${r.sl ? fmt(r.sl, 5) : "—"}</span>
      <span class="tp">TP ${r.tp ? fmt(r.tp, 5) : "—"}</span>
      <span class="sub">${esc(strategyLabel(r.strategy))}</span>
      <button class="btn tiny ghost" type="button" data-close="${r.ticket}">${I18N.t("exec.close")}</button>
    </div>`).join("");
  const ordHtml = ord.map((r) => `<div class="lvl-chip is-resting">
      <b>${esc(String(r.type || "").replace(/_/g, " ").toUpperCase())} ${fmt(r.volume, 2)} @ ${fmt(r.price, 5)}</b>
      <span class="wait">${I18N.t("chart.order_waiting")}</span>
      <span class="sl">SL ${r.sl ? fmt(r.sl, 5) : "—"}</span>
      <span class="tp">TP ${r.tp ? fmt(r.tp, 5) : "—"}</span>
      <span class="sub">${esc(strategyLabel(r.strategy))}</span>
      <button class="btn tiny ghost" type="button" data-cancel="${r.ticket}">${I18N.t("chart.order_cancel")}</button>
    </div>`).join("");
  box.innerHTML = ordHtml + posHtml;
  bindCloseButtons(box);
  bindCancelButtons(box);
}

/** Cancel a resting order the robot planted but that has not filled. */
function bindCancelButtons(root) {
  (root || document).querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      const r = await API.post("/api/order", { action: "cancel", ticket: +btn.dataset.cancel });
      if (!r || !r.ok) { btn.disabled = false; toast((r && r.error) || I18N.t("errors.generic")); return; }
      toast(I18N.t("chart.order_cancelled"));
      await refresh(false);
    };
  });
}
function bindChartDesk() {
  const cv = $("cv-desk");
  if (!cv || !S.chartFocus) return;
  const key = S.chartFocus.symbol + "." + S.chartFocus.timeframe;

  S.chart = new CandleChart(cv, {
    analyze: true,
    key,
    onPrice: onChartPrice,
    onPending: onChartPending,
    // Text is asked for in place, over the chart, rather than with a
    // browser prompt that steals the window.
    onText: (seed, done) => {
      let pop = $("chart-text-pop");
      if (!pop) {
        pop = document.createElement("div");
        pop.id = "chart-text-pop";
        pop.className = "chart-text-pop";
        cv.parentElement.appendChild(pop);
      }
      pop.innerHTML = `<input class="ctrl" id="chart-text-in" value="${esc(seed || "")}" /><button class="btn tiny" type="button" id="chart-text-ok">OK</button>`;
      pop.hidden = false;
      const inp = $("chart-text-in");
      const go = () => { const v = String(inp?.value || "").trim(); pop.hidden = true; done(v); };
      $("chart-text-ok").onclick = go;
      if (inp) { inp.focus(); inp.onkeydown = (ev) => { if (ev.key === "Enter") go(); }; }
    },
  });
  S.chart.setTool("cursor");
  S.chart.setSessions(chartSessionsOn());
  S.chart.setSignals(S.chartSignals || [], S.showSignals);
  // Arriving here from a notification: if the marks for this symbol are
  // already loaded, pin straight away rather than waiting for the next poll.
  if (S.pendingSignal && S.pendingSignal.symbol === S.chartFocus.symbol) pinPendingSignal();
  applyChartLevels(true);
  bindChartTicket();

  if (typeof AurionChartUI !== "undefined") {
    AurionChartUI.bind(S.chart, {
      symbol: S.chartFocus.symbol,
      timeframe: S.chartFocus.timeframe,
      toast,
      // Destructive actions go through the desk's own dialog rather than
      // the browser's, which the installer window styles differently.
      confirm: (question, go) => {
        askConfirm({ title: I18N.t("chart.delete_all"), body: question, danger: true })
          .then((yes) => { if (yes) go(); });
      },
      onBack: () => closeChartDesk(),
      onSessions: (on) => setChartSessions(on),
      // Strategy signals are premium and they come from the engine, so the
      // switch in the chart's settings menu is answered here rather than in
      // the interface layer.
      onSignals: async (on) => {
        if (on && !licFeat("chart_signals")) {
          toast(I18N.t("lic.err_locked"));
          show("upgrade");
          return;
        }
        S.signalsEnabled = on;
        S.showSignals = on;
        try {
          localStorage.setItem("aurion.signalsEnabled", on ? "1" : "0");
          localStorage.setItem("aurion.showSignals", on ? "1" : "0");
        } catch { /* ignore */ }
        if (!on) {
          S.chartSignals = [];
          if (S.chart) S.chart.setSignals([], false);
          return;
        }
        await fetchChartSignals(S.chartFocus?.symbol, S.chartFocus?.timeframe);
      },
      onTimeframe: (tf) => switchChartTimeframe(tf),
    });
  }

  (async () => {
    try {
      await pickMarket(S.chartFocus.symbol, S.chartFocus.timeframe);
      if (S.chart && S.candles.length) S.chart.setBars(S.candles);
      const t = S.snap?.ticks?.[S.chartFocus.symbol];
      if (S.chart && t) S.chart.setTick(t);
      applyChartLevels();
      if (S.signalsEnabled && licFeat("chart_signals")) {
        await fetchChartSignals(S.chartFocus.symbol, S.chartFocus.timeframe);
      }
    } catch { /* empty workspace */ }
  })();
}

/* Changing the interval keeps the workspace: same drawings, same indicators,
   same tool - only the bars underneath are replaced. */
async function switchChartTimeframe(tf) {
  if (!S.chartFocus || S.chartFocus.timeframe === tf) return;
  S.chartFocus = { ...S.chartFocus, timeframe: tf };
  S.timeframe = tf;
  await show("charts", { animate: false, closeMenu: false, nav: false });
}

async function paintMiniCharts() {
  const nodes = document.querySelectorAll("canvas[data-mini]");
  for (const cv of nodes) {
    const symbol = cv.getAttribute("data-mini");
    const tf = cv.getAttribute("data-tf") || S.timeframe || "M15";
    if (!symbol) continue;
    try {
      const c = await API.get(`/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(tf)}&count=240`);
      const bars = c.data || [];
      if (!bars.length) continue;
      const chart = new CandleChart(cv);
      chart.setBars(bars);
      const t = S.snap?.ticks?.[symbol];
      if (t) chart.setTick(t);
    } catch { /* keep empty box */ }
  }
}

async function fetchChartSignals(symbol, timeframe) {
  symbol = symbol || S.symbol || (S.chartFocus && S.chartFocus.symbol) || "";
  timeframe = timeframe || S.timeframe || "M15";
  if (!symbol) return;
  if (!S.signalsEnabled) {
    S.chartSignals = [];
    if (S.chart && typeof S.chart.setSignals === "function") S.chart.setSignals([], S.showSignals);
    return;
  }
  if (!licFeat("chart_signals")) {
    S.chartSignals = [];
    return;
  }
  S.signalsLoading = true;
  try {
    const r = await API.get(`/api/chart/signals?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=800&strict=true`);
    if (r && r.ok && r.signals) {
      S.chartSignals = r.signals;
    } else if (r && r.data && r.data.signals) {
      S.chartSignals = r.data.signals;
    } else if (r && r.ok === false && r.error === "premium_required") {
      S.chartSignals = [];
      // keep enabled flag but show upgrade toast once
      if (!S._signalsToast) {
        toast(I18N.t("lic.err_locked"));
        S._signalsToast = true;
        setTimeout(() => S._signalsToast = false, 5000);
      }
    } else {
      S.chartSignals = [];
    }
    if (S.chart && typeof S.chart.setSignals === "function") S.chart.setSignals(S.chartSignals, S.showSignals);
    // A notification that was clicked before the marks existed is honoured
    // here, now that they do.
    if (S.pendingSignal && S.pendingSignal.symbol === symbol) pinPendingSignal();
    // per user request: no bottom list — signals only on canvas (CandleChart overlay)

  } catch (e) {
    S.chartSignals = [];
  } finally {
    S.signalsLoading = false;
  }
}

async function pickMarket(symbol, timeframe) {
  if (!symbol) return;
  if (!liveSymbols().some((x) => x.symbol === symbol)) {
    S.candles = [];
    return;
  }
  S.symbol = symbol; S.timeframe = timeframe;
  if (S.view === "markets") {
    const box = document.querySelector(".chart-box");
    if (box && !box.querySelector(".empty")) {
      box.insertAdjacentHTML("beforeend", emptyCard(I18N.t("markets.empty"), I18N.t("markets.loading_tf")));
    } else {
      const empty = box && box.querySelector(".empty p");
      if (empty) empty.textContent = I18N.t("markets.loading_tf");
    }
  }
  const r = await API.post("/api/market", { symbol, timeframe });
  if (r && r.ok && typeof r.bars === "number") {
    const c = await API.get(`/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=800`);
    S.candles = c.data || [];
  } else if (Array.isArray(r?.data)) S.candles = r.data;
  if (S.view === "markets") {
    const lbl = $("tick-lbl");
    if (lbl) lbl.textContent = tickLabel();
    if (S.chart) S.chart.setBars(S.candles);
    if (S.chart && S.signalsEnabled) fetchChartSignals(symbol, timeframe);
    const empty = document.querySelector(".chart-box .empty");
    if (empty && S.candles.length) empty.remove();
    else if (!S.candles.length && $("cv") && !$("cv").parentElement.querySelector(".empty")) {
      $("cv").parentElement.insertAdjacentHTML("beforeend", emptyCard(I18N.t("markets.empty"), I18N.t("status.waiting_ticks")));
    }
  }
  if (S.view === "charts" && S.chartFocus && S.chartFocus.symbol === symbol) {
    if (S.chart && S.signalsEnabled) fetchChartSignals(symbol, timeframe);
  }
}

function typing() {
  const el = document.activeElement;
  return el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

async function refresh(rebuild = false) {
  if (S._refreshing) {
    S._refreshAgain = true;
    if (rebuild) S._refreshRebuild = true;
    return S._refreshWait || Promise.resolve();
  }
  S._refreshing = true;
  let settle;
  S._refreshWait = new Promise((resolve) => { settle = resolve; });
  try {
    do {
      S._refreshAgain = false;
      const wantRebuild = rebuild || S._refreshRebuild;
      S._refreshRebuild = false;
      rebuild = false;
      const r = await API.get("/api/snapshot");
      if (r && r.ok) {
        S.snap = r.data;
        if (Array.isArray(S.snap.robot) && S.snap.robot.length) {
          S.robotLogs = S.snap.robot.slice();
        }
        S.snap.agents = Array.isArray(S.snap.agents) ? S.snap.agents : [];
        S._agentCache = S.snap.agents.slice();
        S._agentCacheAt = S.snap.agents.length ? Date.now() : 0;
        if (!S.snap.agents.length) S.snap.ticks = {};
        pruneDeadSymbols();
        if (!S.symbol) {
          S.symbol = defaultSymbol();
          const ag = liveAgents().find((a) => a.symbol === S.symbol);
          S.timeframe = (ag && ag.timeframe) || S.snap.active_timeframe || S.timeframe;
        }
      } else S.snap = S.snap || null;
      headerState();
      if (wantRebuild && !S.mountedView) show(S.view, { animate: false });
      else syncLive();
    } while (S._refreshAgain);
  } finally {
    S._refreshing = false;
    S._refreshWait = null;
    if (settle) settle();
  }
}

function onLive(msg) {
  if (!msg) return;
  if (msg.type === "hello" && msg.data) {
    S.snap = { ...(S.snap || {}), ...msg.data };
    if (Array.isArray(S.snap.agents) && S.snap.agents.length) {
      S._agentCache = S.snap.agents;
      S._agentCacheAt = Date.now();
    }
    if (Array.isArray(S.snap.robot) && S.snap.robot.length) S.robotLogs = S.snap.robot.slice();
    pruneDeadSymbols();
    scheduleSync();
    if (liveAgents().length) primeEaChart();
  }
  if (msg.type === "tick") {
    const t = msg.data || msg;
    if (t.symbol) {
      S.snap = S.snap || {};
      S.snap.ticks = S.snap.ticks || {};
      S.snap.ticks[t.symbol] = t;
      if (S.chart && (t.symbol === S.symbol || (S.chartFocus && t.symbol === S.chartFocus.symbol))) {
        S.chart.setTick(t);
        const lbl = $("tick-lbl"); if (lbl) lbl.textContent = tickLabel();
      }
    }
  }
  if (msg.type === "candle") {
    const c = msg.data || msg;
    if (c.symbol === S.symbol && (!S.timeframe || c.timeframe === S.timeframe)) {
      const i = S.candles.findIndex((b) => b && b.time === c.time);
      if (i >= 0) S.candles[i] = c;
      else {
        S.candles.push(c);
        S.candles.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
      }
      if (S.chart) {
        if (typeof S.chart.setLastBar === "function") S.chart.setLastBar(c);
        else S.chart.setBars(S.candles);
      }
    }
  }
  if (msg.type === "candles") {
    const d = msg.data || msg;
    if ((d.symbol === S.symbol || !S.symbol) && (d.timeframe === S.timeframe || !d.timeframe || !S.timeframe)) {
      if (d.symbol) S.symbol = d.symbol;
      if (d.timeframe) S.timeframe = d.timeframe;
      S.candles = d.bars || [];
      if (S.chart) S.chart.setBars(S.candles);
    }
  }
  if (msg.type === "account") {
    S.snap = S.snap || {};
    S.snap.mt5 = S.snap.mt5 || {};
    const incoming = msg.data && msg.data.login !== undefined ? msg.data : (msg.data || msg);
    const prev = S.snap.mt5.account || {};
    S.snap.mt5.account = { ...prev, ...incoming };
    if (!S.snap.mt5.account.leverage && prev.leverage) S.snap.mt5.account.leverage = prev.leverage;
    scheduleSync();
  }
  if (msg.type === "positions" && S.snap) {
    const raw = (msg.data && msg.data.items) || msg.items || msg.data || [];
    S.snap.positions = Array.isArray(raw) ? raw : [];
    scheduleSync();
  }
  if (msg.type === "ai" && S.snap) {
    const state = msg.data && msg.data.direction !== undefined ? msg.data : (msg.data || msg);
    S.snap.ai = state;

    /* Keep the per-chart list in step with the live read.
     *
     * The Intelligence panel does not read S.snap.ai when a chart is
     * attached - it reads S.snap.ai_by_symbol, which only a full snapshot
     * fetch ever filled in. So every live inference landed in a field the
     * panel was not looking at, and the analysis sat there unchanged until
     * something forced a reload. That is the "I have to refresh the app to
     * see it" fault: the data was arriving the whole time. */
    const sym = state && state.symbol ? String(state.symbol) : "";
    if (sym) {
      const list = Array.isArray(S.snap.ai_by_symbol) ? S.snap.ai_by_symbol.slice() : [];
      const at = list.findIndex((x) => x && String(x.symbol) === sym);
      if (at >= 0) list[at] = state; else list.push(state);
      S.snap.ai_by_symbol = list.slice(-12);
    }
    scheduleSync();
  }
  if (msg.type === "agents") {
    S.snap = S.snap || {};
    const raw = msg.data || msg;
    const items = Array.isArray(raw) ? raw : (raw.items || raw.data || raw.agents || []);
    S.snap.agents = Array.isArray(items) ? items : [];
    S._agentCache = S.snap.agents.slice();
    S._agentCacheAt = S.snap.agents.length ? Date.now() : 0;
    if (!S.snap.agents.length) S.snap.ticks = {};
    pruneDeadSymbols();
    S.snap.mt5 = S.snap.mt5 || {};
    S.snap.mt5.ea_charts = liveAgents().length;
    if (S.snap.mt5.ea_charts) S.snap.mt5.connected = true;
    scheduleSync();
    primeEaChart();
  }
  if (msg.type === "ticks") {
    const raw = msg.data || msg;
    const map = (raw && typeof raw === "object" && !Array.isArray(raw) && raw.items && typeof raw.items === "object" && !Array.isArray(raw.items))
      ? raw.items
      : raw;
    S.snap = S.snap || {};
    if (map && typeof map === "object" && !Array.isArray(map)) S.snap.ticks = map;
    pruneDeadSymbols();
    scheduleSync();
  }
  if (msg.type === "robot") {
    const item = msg.data || msg;
    S.robotLogs = (S.robotLogs || []).concat(item).slice(-600);
    if (S.view === "execution" && $("robot-term")) {
      $("robot-term").innerHTML = renderRobotLogs();
      $("robot-term").scrollTop = $("robot-term").scrollHeight;
    }
    if (S.view === "terminal" && S.termTab === "robot" && $("term")) {
      $("term").innerHTML = renderRobotLogs($("log-q")?.value || "");
      $("term").scrollTop = $("term").scrollHeight;
    }
  }
  if (msg.type === "order_result") {
    const r = msg.data || msg;
    const text = r.ok
      ? (I18N.t("logs.order_sent") + (r.detail ? " — " + r.detail : ""))
      : (r.error || r.detail || I18N.t("logs.order_fail"));
    pushRobotLocal(r.ok ? "info" : "error", text);
    if ($("ex-msg")) $("ex-msg").textContent = text;
  }
  if (msg.type === "log") {
    S.logs.push(msg.data || msg);
    if (S.logs.length > 800) S.logs = S.logs.slice(-600);
    if (S.view === "terminal" && (S.termTab || "live") === "live" && $("term")) $("term").innerHTML = renderLogs($("log-q")?.value || "");
  }
  if (msg.type === "status" && S.snap) {
    const d = msg.data || msg;
    S.snap.mt5 = { ...(S.snap.mt5 || {}), ...d };
    if (d.tape) S.snap.tape = d.tape;
    if ("kill_switch" in d) S.snap.kill_switch = d.kill_switch;
    if ("safe_mode" in d) S.snap.safe_mode = d.safe_mode;
    scheduleSync();
  }
  if (msg.type === "signal") {
    S.snap = S.snap || {};
    const sig = msg.data || msg;
    S.snap.last_signal = sig;
    announceSignal(sig);
    scheduleSync();
  }
  if (msg.type === "trade") {
    announceTrade(msg.data || msg);
  }
  if (msg.type === "history") {
    if (S.view === "history") loadHistory();
  }
  if (msg.type === "backtest") {
    const d = msg.data && typeof msg.data === "object" ? msg.data : msg;
    S.backtest = d;
    S.snap = S.snap || {};
    S.snap.backtest = d;
    // The backtest has its own tab. This said "history", which is where it
    // used to live, so the finished result never reached the screen it was
    // run from - the page just sat on its spinner.
    if (S.view === "backtest" || S.view === "history") {
      setBacktestBusy(Boolean(d.running), d.progress);
      // This is the fast path, and it used to refresh only #bt-result:
      // the curve and trade table below it kept the previous run's
      // numbers, and nothing scrolled, so a result the trader had
      // scrolled away from landed off-screen. Paint the whole card and
      // reveal it on completion, exactly as the polling fallback does.
      paintBacktestResults(d, { reveal: !d.running });
      if (!d.running) {
        S._btBusy = false;
        toast(I18N.t(d.ok ? "history.backtest_done" : "errors.generic"));
      }
    }
    headerState();
  }
  if (msg.type === "deals") {
    /* broker deal dumps are ignored — AURION ledger is source of truth */
  }
  if (msg.type === "strategy") {
    S.snap = S.snap || {};
    S.snap.strategy = msg.data && msg.data.items ? msg.data : { ...(S.snap.strategy || {}), ...(msg.data || {}) };
    scheduleSync();
  }
  if (msg.type === "prop" && S.snap) {
    S.snap.prop = { ...(S.snap.prop || {}), ...(msg.data || msg) };
    scheduleSync();
  }
  if (msg.type === "license") {
    S.snap = S.snap || {};
    S.snap.license = msg.data && msg.data.plan ? msg.data : { ...(S.snap.license || {}), ...(msg.data || {}) };
    S._gateLic = S.snap.license;
    paintNavAcc();
    if (S.view === "upgrade") show("upgrade", { animate: false, closeMenu: false, nav: false });
    scheduleSync();
  }
}

async function setLang(lang) {
  if (lang === I18N.lang) return;
  return morphTheme(async () => {
    await I18N.load(lang);
    repaintForLanguage();

    /* Telling the engine is housekeeping, not something the trader waits
       for. It used to be awaited before a single label was redrawn, which
       put a network round trip in front of every language change and is
       most of why switching felt slow. */
    if (API.token) {
      API.post("/api/auth/language", { language: lang })
        .then((r) => { if (r && r.ok && r.data && r.data.token) API.setToken(r.data.token); })
        .catch(() => { /* the desk is already in the new language */ });
    }
  }, { title: I18N.t("ui.switch_lang") });
}

/** Redraw everything that holds text, in whatever language is now in force. */
function repaintForLanguage() {
  I18N.apply();
  markLangPills();
  paintThemeBtn();
  const langBtn = $("btn-lang");
  if (langBtn) langBtn.textContent = I18N.lang.toUpperCase();
  const desk = $("desk");
  if (desk && !desk.classList.contains("hidden")) {
    headerState();
    S.mountedView = null;
    show(S.view, { animate: false });
  } else {
    paintGate();
  }
}


async function loadPlans() {
  try {
    const r = await API.get("/api/billing/plans");
    S.plans = (r && r.ok && r.data && r.data.plans) || [];
    S.billing = r && r.data;
  } catch { S.plans = S.plans || []; }
}
async function loadNotifies() {
  try {
    const r = await API.get("/api/notify");
    S.notes = (r && r.ok && r.data) || [];
  } catch { S.notes = []; }
  paintNotifies();
}
/**
 * Paint the notifications that came from the engine.
 *
 * It repaints only its own cards. It used to rebuild the whole stack from
 * S.notes, which quietly destroyed every trade and signal card sitting
 * there - those are raised locally and are not in S.notes, so a routine
 * poll with nothing new in it would clear the screen of the trade alert
 * that had just arrived. Server cards are marked, and nothing else in the
 * stack is touched.
 */
function paintNotifies() {
  const stack = $("notify-stack");
  const dot = $("bell-dot");
  const notes = (S.notes || []).filter((n) => !n.dismissed);
  if (dot) dot.hidden = !notes.length;
  if (!stack) return;

  stack.querySelectorAll('[data-note="server"]').forEach((el) => el.remove());
  for (const n of notes.slice(0, 4)) {
    const card = document.createElement("article");
    card.className = "notify-card";
    card.setAttribute("data-note", "server");
    card.setAttribute("data-nid", String(n.id));
    card.innerHTML =
      `<button type="button" class="n-x" data-nx="${esc(n.id)}"
               aria-label="${esc(I18N.t("notify.dismiss"))}">${icon("close")}</button>` +
      `<h4>${esc(n.title || "")}</h4><p>${esc(n.body || "")}</p>`;
    stack.appendChild(card);
    bindDismiss(card, () => dismissNote(n.id));
  }
  // Hidden only when there is genuinely nothing left, server or local.
  stack.hidden = stack.children.length === 0;
}
async function dismissNote(id) {
  if (!id) return;
  /* Drop it locally first and never let the request decide. The card has
     already slid off the screen by the time this runs; if the engine is
     unreachable, putting it back would be the wrong answer to "I dismissed
     that". It will not return unless the engine still has it on the next
     poll, which is the correct behaviour for a note that was never
     actually dismissed. */
  S.notes = (S.notes || []).filter((n) => n.id !== id);
  /* Matched by reading the attribute rather than by building a selector
     from it: note ids come from the engine, and CSS.escape is not
     available in every runtime the desk has to survive (older WebViews
     among them). A scan over at most four cards costs nothing. */
  const wanted = String(id);
  document.querySelectorAll('[data-note="server"]').forEach((el) => {
    if (el.getAttribute("data-nid") === wanted) el.remove();
  });
  const stack = $("notify-stack");
  if (stack) stack.hidden = stack.children.length === 0;
  const dot = $("bell-dot");
  if (dot) dot.hidden = !(S.notes || []).filter((n) => !n.dismissed).length;
  try { await API.post("/api/notify/" + encodeURIComponent(id) + "/dismiss", {}); } catch { /* offline */ }
}
function showPayResult(ok, extra) {
  const veil = $("pay-veil");
  if (!veil) return;
  veil.classList.remove("hidden");
  veil.innerHTML = `<div class="card pay-card">
    <h2>${I18N.t(ok ? "profile.success" : "profile.fail")}</h2>
    <p>${I18N.t(ok ? "profile.success_body" : "profile.fail_body")}</p>
    ${extra ? `<p class="keybox">${esc(extra)}</p>` : ""}
    <p class="sub">${I18N.t("profile.support")}: support@axiasoft</p>
    <button class="btn block" id="pay-close" type="button">${I18N.t("common.ok")}</button>
  </div>`;
  $("pay-close").onclick = () => veil.classList.add("hidden");
}
function bindProfile() {
  if (!Array.isArray(S.plans)) loadPlans().then(() => { if (S.view === "profile") show("profile", { animate: false, closeMenu: false }); });
  if (!Array.isArray(S.pays)) {
    API.get("/api/billing/history").then((r) => {
      S.pays = (r && r.ok && r.data) || [];
      if (S.view === "profile") show("profile", { animate: false, closeMenu: false });
    }).catch(() => { S.pays = []; });
  }
  markLangPills();
  const langs = $("pf-langs");
  if (langs) langs.onclick = async (e) => {
    const b = e.target.closest("[data-lang]");
    if (b) await setLang(b.dataset.lang);
  };
  const copy = $("pf-copy");
  if (copy) copy.onclick = async () => {
    const name = S.user && S.user.username ? S.user.username : "";
    try { await navigator.clipboard.writeText(name); } catch { /* */ }
    toast(I18N.t("profile.copied"));
  };
  const save = $("pf-save");
  if (save) save.onclick = async () => {
    const r = await API.post("/api/profile", { display_name: $("pf-name")?.value || "", timezone: $("pf-tz")?.value || "" });
    if (r.ok) { S.user = r.data; toast(I18N.t("common.save")); }
    else toast(I18N.t("errors.generic"));
  };
  const pw = $("pf-pass");
  if (pw) pw.onclick = async () => {
    const next = String($("pf-next")?.value || "");
    const next2 = String($("pf-next2")?.value || "");
    if (next !== next2) return toast(I18N.t("auth.pass_mismatch"));
    const r = await API.post("/api/profile/password", { current: $("pf-cur")?.value, next });
    toast(r.ok ? I18N.t("profile.pw_ok") : I18N.t(r.error === "weak_password" ? "auth.weak_password" : "auth.invalid"));
    if (r.ok) { if ($("pf-cur")) $("pf-cur").value = ""; if ($("pf-next")) $("pf-next").value = ""; if ($("pf-next2")) $("pf-next2").value = ""; }
  };
  const ton = $("pf-ton");
  if (ton) ton.onclick = async () => {
    const r = await API.post("/api/profile/totp/start", {});
    if (!r.ok) return toast(I18N.t("errors.generic"));
    const box = $("pf-tsec");
    if (box) {
      box.textContent = r.secret || "";
      box.classList.remove("hidden");
    }
    $("pf-trow")?.classList.remove("hidden");
  };
  const tok = $("pf-tok");
  if (tok) tok.onclick = async () => {
    const r = await API.post("/api/profile/totp/confirm", { code: $("pf-tc")?.value });
    if (!r.ok) return toast(I18N.t("auth.otp"));
    S.user = r.user || r.data;
    toast(I18N.t("profile.totp_on"));
    show("profile", { animate: false, closeMenu: false });
  };
  const toff = $("pf-toff");
  if (toff) toff.onclick = async () => {
    const r = await API.post("/api/profile/totp/disable", { code: $("pf-td")?.value });
    if (!r.ok) return toast(I18N.t("auth.otp"));
    S.user = r.user || r.data;
    show("profile", { animate: false, closeMenu: false });
  };
  document.querySelectorAll("[data-plan]").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("[data-plan]").forEach((x) => x.classList.toggle("on", x === b));
      S._plan = b.getAttribute("data-plan");
    };
  });
  const pay = $("pf-pay");
  if (pay) pay.onclick = async () => {
    const msg = $("pf-pay-msg");
    const r = await API.post("/api/billing/checkout", { plan: S._plan || "" });
    if (!r.ok) {
      const map = { verify_first: "profile.verify_first", gateway_unconfigured: "profile.gateway_off", plan: "profile.choose", amount_unset: "profile.gateway_off" };
      const text = I18N.t(map[r.error] || "errors.generic");
      if (msg) msg.textContent = text;
      toast(text);
      return;
    }
    if (r.data && r.data.url) location.href = r.data.url;
  };
}

// ---------------------------------------------------------------------------
// Product-key gate. The license key IS the login: premium keys walk straight
// in, everyone else can continue in free mode. All enforcement is server-side;
// this screen is just the front door.
// ---------------------------------------------------------------------------
function licFeat(name) {
  const f = ((S.snap && S.snap.license) || S.license || {}).features || {};
  return f[name] !== false;
}
function planLabel(L) {
  L = L || {};
  const m = Number(L.months || 0);
  if (L.premium && m > 0) return I18N.t("lic.plan_months", { n: m });
  if (L.premium) return I18N.t("lic.premium");
  return I18N.t("lic.freemium");
}
function heroPlanLabel(L) {
  // Hero line above the upgrade card: avoid a duplicated "Premium · Premium"
  // when the plan itself has no month detail to add.
  const pl = planLabel(L);
  const prem = I18N.t("lic.premium");
  return pl && pl !== prem ? `${prem} · ${pl}` : prem;
}
function licDate(iso) {
  if (!iso) return "—";
  try {
    const tag = I18N.lang === "fa" ? "fa-IR-u-ca-persian" : I18N.lang === "ar" ? "ar-SA-u-ca-islamic-umalqura" : "en-GB-u-ca-gregory";
    return new Intl.DateTimeFormat(tag, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}
function licErrText(code, r) {
  const map = {
    invalid_key: "lic.err_invalid",
    key_used: "lic.err_used",
    unknown_key: "lic.err_unknown",
    machine_mismatch: "lic.err_machine",
    key_revoked: "lic.err_revoked",
    key_replaced: "lic.err_replaced",
    internet_required: "lic.err_net",
    activation_failed: "lic.err_generic",
    engine_offline: "lic.err_engine",
    too_many_requests: "lic.err_rate",
    key_required: "lic.err_required",
  };
  let text = I18N.t(map[code] || "errors.generic");
  if (r && r.recover && code !== "internet_required") text += " · " + I18N.t("lic.recover_hint");
  return text;
}

/**
 * Ask the engine (through the desk) what licence this machine holds.
 *
 * Returns the licence on success. On failure it records *why* on S._gateErr
 * so the gate can say something more useful than "waiting" forever — the
 * engine takes a few seconds to import numpy and sklearn, but it can also be
 * simply not running, and those two look identical from here.
 */
async function fetchLicense() {
  try {
    const r = await API.get("/api/license");
    if (r && r.ok && r.data) { S._gateErr = ""; return r.data; }
    S._gateErr = (r && (r.detail || r.error)) || "engine_offline";
  } catch (e) {
    S._gateErr = (e && e.message) || "network";
  }
  return null;
}

function paintGate() {
  const card = $("gate-card");
  if (!card) return;
  I18N.apply(card);
  markLangPills();

  /* A machine without a key still needs to be told the update worked -
     otherwise the key screen after an update looks like the update broke
     something. */
  const upd = S._updated;
  let note = card.querySelector(".gate-updated");
  if (upd && upd.updated) {
    if (!note) {
      note = document.createElement("p");
      note.className = "ok gate-updated";
      card.insertBefore(note, card.firstChild.nextSibling);
    }
    note.textContent = I18N.t("upd.updated_gate", { v: S.version || "" });
  } else if (note) {
    note.remove();
  }
  const Lic = S._gateLic;
  const line = $("gate-state");
  // The engine needs a few seconds to boot. Past that, waiting silently is a
  // dead end: say it is offline, show what the desk actually got back, and
  // offer a retry instead of an ellipsis that never resolves.
  const stalled = !Lic && (S._gateTries || 0) >= 4;
  if (line) {
    if (Lic && Lic.premium) line.textContent = I18N.t("keygate.state_prem");
    else if (Lic) line.textContent = I18N.t("keygate.state_free");
    else line.textContent = I18N.t(stalled ? "keygate.engine_down" : "keygate.engine_wait");
  }
  const detail = $("gate-detail");
  if (detail) {
    detail.hidden = !stalled;
    detail.textContent = stalled ? `${I18N.t("keygate.engine_hint")} · ${S._gateErr || "engine_offline"}` : "";
  }
  const retry = $("gate-retry");
  if (retry) retry.hidden = !stalled;
  const buy = $("gate-buy");
  const store = (Lic && Lic.store_url) || "";
  if (buy) {
    buy.classList.toggle("hidden", !store);
    if (store) buy.onclick = () => window.open(store, "_blank", "noopener");
  }
}

function showGate(lic) {
  S._gateLic = lic || S._gateLic || null;
  const auth = $("auth");
  if (auth) auth.classList.remove("hidden");
  $( "desk" )?.classList.add("hidden");
  setShell("auth");
  paintGate();
  bindGate();
  // While the gate is up, keep re-checking (engine boot, key activated
  // elsewhere). Poll every second to begin with -- the common case is an
  // engine that is simply still importing numpy, and five seconds of dead
  // screen for that is needless -- then back off once it is clearly not
  // coming, so a dead engine is not hammered forever.
  if (S._gateTimer) clearInterval(S._gateTimer);
  S._gateTries = S._gateLic ? 0 : (S._gateTries || 0);
  const poll = async () => {
    const auth = $("auth");
    if (!auth || auth.classList.contains("hidden")) { clearInterval(S._gateTimer); S._gateTimer = null; return; }
    const next = await fetchLicense();
    if (next) {
      S._gateLic = next;
      S._gateTries = 0;
    } else {
      S._gateTries = (S._gateTries || 0) + 1;
      // 1s while it might still be booting, 5s once it plainly is not.
      if (S._gateTries === 4) {
        clearInterval(S._gateTimer);
        S._gateTimer = setInterval(poll, 5000);
      }
    }
    paintGate();
  };
  S._gateTimer = setInterval(poll, 1000);
}

function bindGate() {
  if (S._gateBound) return;
  S._gateBound = true;
  const langs = $("auth-langs");
  if (langs) langs.onclick = (e) => {
    const b = e.target.closest("[data-lang]");
    if (b) setLang(b.dataset.lang);
  };
  const go = $("gate-go");
  if (go) go.onclick = () => gateActivate();
  const key = $("gate-key");
  if (key) key.addEventListener("keydown", (e) => { if (e.key === "Enter") gateActivate(); });
  const free = $("gate-free");
  if (free) free.onclick = () => licenseSessionEnter("freemium");
  const retry = $("gate-retry");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    S._gateTries = 0;
    paintGate();
    const lic = await fetchLicense();
    if (lic) S._gateLic = lic; else S._gateTries = 4;
    retry.disabled = false;
    paintGate();
  };
}

async function gateActivate() {
  const err = $("gate-err");
  const btn = $("gate-go");
  const key = String($("gate-key")?.value || "").trim();
  if (!key) { if (err) err.textContent = I18N.t("lic.need_key"); return; }
  if (btn) btn.disabled = true;
  if (err) err.textContent = "";
  try {
    const r = await API.post("/api/license/activate", { key });
    if (!r.ok) {
      if (err) err.textContent = licErrText(r.error, r);
      return;
    }
    const lic = r.license || r.data || {};
    toast(I18N.t("lic.activated") + " · " + planLabel(lic));
    await licenseSessionEnter("auto", lic);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function licenseSessionEnter(mode, lic) {
  const err = $("gate-err");
  const r = await API.post("/api/auth/license-session", { mode });
  if (!r.ok) {
    const text = r.error === "engine_offline" ? I18N.t("lic.err_engine") : licErrText(r.error, r);
    if (err && !$("auth").classList.contains("hidden")) err.textContent = text;
    else toast(text);
    return;
  }
  API.setToken(r.data.token);
  S.user = r.data.user;
  S.license = r.license || lic || null;
  if (S._gateTimer) { clearInterval(S._gateTimer); S._gateTimer = null; }
  await enterDesk();
}

function lockedUpgradeCard(feat) {
  return `<div class="card st-upload locked-feature">
    <div class="lock-ico">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 118 0v3"/>
      </svg>
    </div>
    <h3>${I18N.t("lock." + feat + "_title")}</h3>
    <p class="sub">${I18N.t("lock." + feat)}</p>
    <button class="btn block" data-go-upgrade type="button">${I18N.t("lic.upgrade_cta")}</button>
  </div>`;
}

function bindUpgradeLinks(root) {
  (root || document).querySelectorAll("[data-go-upgrade]").forEach((b) => {
    b.onclick = () => show("upgrade");
  });
}

function authErrorText(code) {
  const map = {
    invalid: "auth.invalid",
    identity: "auth.identity",
    weak_password: "auth.weak_password",
    otp: "auth.otp",
    owner_gmail: "errors.owner_gmail",
    already_initialized: "errors.generic",
    already_registered: "auth.already",
    pass_mismatch: "auth.pass_mismatch",
    mx: "auth.mx",
    phone_prefix: "auth.phone_prefix",
    rate: "auth.rate",
    first_run: "auth.first_run_need",
    need_fields: "auth.need_fields",
    username: "auth.username",
    need_channel: "auth.need_channel",
    already_registered: "auth.already",
  };
  return I18N.t(map[code] || "errors.generic");
}
async function enterDesk() {
  S._leaving = false;
  if (S._gateTimer) { clearInterval(S._gateTimer); S._gateTimer = null; }
  $("auth").classList.add("hidden");
  $("desk").classList.remove("hidden");
  setShell("desk");
  await loadAccountSettings();
  bindChrome();
  bindHostBridge();
  setMenu(false);
  $("btn-lang").onclick = async () => {
    const order = ["en", "fa", "ar"];
    await setLang(order[(order.indexOf(I18N.lang) + 1) % 3]);
  };
  $("btn-kill").onclick = async () => {
    const armed = !S.snap?.kill_switch;
    await API.post("/api/kill", { armed });
    await refresh(false);
  };
  const flatHdr = $("btn-flat");
  if (flatHdr) flatHdr.onclick = async () => {
    const ok = await askConfirm({
      title: I18N.t("exec.close_all"),
      body: I18N.t("exec.confirm_flat"),
      ok: I18N.t("exec.close_all"),
      cancel: I18N.t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    const r = await API.post("/api/flatten", { reason: "header" });
    toast(r.ok ? I18N.t("exec.close_all") : (r.error || I18N.t("errors.generic")));
    await refresh(false);
  };
  const rf = $("btn-refresh");
  if (rf) rf.onclick = () => hardRefresh();
  const rs = $("btn-restart");
  if (rs) rs.onclick = () => restartSystem();
  const lo = $("btn-logout");
  if (lo) lo.onclick = () => logout();
  loadPlans();
  const q = new URLSearchParams(location.search);
  if (q.get("paid") === "ok") showPayResult(true);
  if (q.get("paid") === "fail") showPayResult(false);
  S.live = new LiveSocket(onLive);
  S.live.connect();
  const logs = await API.get("/api/logs?limit=200");
  S.logs = logs.data || [];
  await refresh(true);
  if (!S._poll) {
    S._poll = setInterval(() => { if (!typing()) refresh(false); }, 12000);
  }
}

function welcomeIsMobile() {
  return window.matchMedia("(max-width: 820px)").matches;
}
function welcomeSrcList() {
  const mobile = welcomeIsMobile();
  const primary = mobile
    ? ["assets/welcome/mobile.mp4", "assets/welcome/mobile.webm", "assets/welcome/intro-mobile.mp4"]
    : ["assets/welcome/desktop.mp4", "assets/welcome/desktop.webm", "assets/welcome/intro-desktop.mp4"];
  return primary.concat(["assets/welcome/intro.mp4", "assets/welcome/intro.webm", "assets/welcome/welcome.mp4"]);
}
async function playWelcome() {
  const wrap = $("welcome");
  if (!wrap) return;
  const vid = $("welcome-vid");
  const skip = $("welcome-skip");
  const soundBtn = $("welcome-sound");
  let settled = false;
  let safety = 0;
  return new Promise((resolve) => {
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      try {
        if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
      } catch { /* */ }
      wrap.classList.add("out");
      setTimeout(() => {
        wrap.hidden = true;
        wrap.classList.remove("out");
        resolve();
      }, 700);
    };
    if (skip) {
      skip.textContent = I18N.t("welcome.skip");
      skip.onclick = done;
    }
    const unmute = () => {
      if (!vid) return;
      vid.muted = false;
      vid.volume = 1;
      const p = vid.play();
      if (p && p.catch) p.catch(() => {});
      wrap.classList.remove("is-muted");
      if (soundBtn) soundBtn.hidden = true;
    };
    if (soundBtn) {
      soundBtn.setAttribute("aria-label", I18N.t("welcome.sound"));
      soundBtn.onclick = (e) => { e.stopPropagation(); unmute(); };
    }
    wrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest("#welcome-skip")) return;
      unmute();
    });
    if (!vid) { wrap.hidden = true; resolve(); return; }
    const sources = welcomeSrcList();
    let i = 0;
    const armSafety = () => {
      const ms = Math.min(((vid.duration && isFinite(vid.duration) ? vid.duration : 12) * 1000) + 900, 120000);
      clearTimeout(safety);
      safety = setTimeout(done, ms);
    };
    const tryPlay = () => {
      if (settled) return;
      if (i >= sources.length) { wrap.hidden = true; resolve(); return; }
      const src = sources[i++];
      vid.onerror = () => tryPlay();
      vid.onended = done;
      vid.onloadedmetadata = () => armSafety();
      vid.playsInline = true;
      vid.setAttribute("playsinline", "");
      vid.setAttribute("webkit-playsinline", "");
      vid.preload = "auto";
      vid.controls = false;
      vid.volume = 1;
      vid.muted = false;
      vid.src = src;
      vid.load();
      const go = vid.play();
      if (go && go.then) {
        go.then(() => {
          wrap.classList.remove("is-muted");
          if (soundBtn) soundBtn.hidden = true;
          armSafety();
        }).catch(() => {
          vid.muted = true;
          const again = vid.play();
          if (again && again.then) {
            again.then(() => {
              wrap.classList.add("is-muted");
              if (soundBtn) soundBtn.hidden = false;
              armSafety();
            }).catch(() => tryPlay());
          } else tryPlay();
        });
      }
    };
    tryPlay();
    safety = setTimeout(done, 120000);
  });
}

/* ---------------------------------------------------------------- update --
   Did AURION just update, and what should the trader see because of it?

   Three separate things were wrong here.

   The key screen appeared after every update even for a premium machine.
   That was not a licence fault: fetchLicense() gives up after a single
   failed call, and immediately after an update the engine is still
   restarting, so the one call fails, boot reads "no licence" and falls
   through to the gate. The gate's own poll then succeeds a second later and
   prints "premium active" underneath the key box - which is exactly the
   contradiction that was reported, and why "continue free" let the trader
   straight in with premium working.

   Second, nothing ever said the update had worked.

   Third, a first install must not claim to be an update. We only know an
   update happened if we have seen a DIFFERENT version on this machine
   before; with nothing recorded, this is a fresh install and stays silent. */
const LS_SEEN_VERSION = "aurion.seenVersion";

function updateCheck(version) {
  if (!version) return { updated: false, from: "" };
  let seen = "";
  try { seen = localStorage.getItem(LS_SEEN_VERSION) || ""; } catch (e) { /* */ }
  try { localStorage.setItem(LS_SEEN_VERSION, version); } catch (e) { /* */ }
  // No record at all = first run on this machine, not an update.
  return { updated: Boolean(seen) && seen !== version, from: seen };
}

/** Ask for the licence more than once; the engine may still be starting. */
async function fetchLicenseSettled(tries, waitMs) {
  const n = tries || 6;
  const wait = waitMs || 700;
  for (let i = 0; i < n; i++) {
    const lic = await fetchLicense();
    if (lic) return lic;
    S._gateTries = (S._gateTries || 0) + 1;
    if (i < n - 1) await new Promise((r) => setTimeout(r, wait));
  }
  return null;
}

/** "The update worked" - shown to a premium machine, which has no gate. */
function showUpdateWelcome(version, from) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "upd-welcome";
    host.innerHTML = `
      <div class="auth-card upd-card" role="dialog" aria-modal="true" aria-labelledby="upd-w-title">
        <div class="upd-mark" aria-hidden="true">${icon("spark")}</div>
        <h2 id="upd-w-title">${esc(I18N.t("upd.updated_title"))}</h2>
        <p class="lede">${esc(I18N.t("upd.updated_body", { v: version }))}</p>
        ${from ? `<p class="sub mono">${esc(I18N.t("upd.updated_from", { old: from }))}</p>` : ""}
        <button class="btn block" type="button" id="upd-w-go">${esc(I18N.t("upd.updated_cta"))}</button>
      </div>`;
    document.body.appendChild(host);
    requestAnimationFrame(() => host.classList.add("is-in"));
    const go = () => {
      host.classList.remove("is-in");
      setTimeout(() => { host.remove(); resolve(); }, 220);
    };
    host.querySelector("#upd-w-go").onclick = go;
    host.querySelector("#upd-w-go").focus();
    // Enter works too; this screen has exactly one thing to do.
    host.onkeydown = (e) => { if (e.key === "Enter" || e.key === "Escape") go(); };
  });
}

async function boot() {
  bindChrome();

  /* Find out which notification sounds this build ships. Deliberately not
     awaited: a slow fetch must not hold up the desk, and until it resolves
     the slots fall back to their built-in tones. */
  loadSoundFiles().catch(() => { /* built-in tones are the fallback */ });

  // A canvas does not reflow. Redraw the equity curve when the box it lives
  // in changes size, or a phone rotation leaves it stretched.
  let btResizeT = null;
  window.addEventListener("resize", () => {
    if (!$("bt-curve")) return;
    if (btResizeT) clearTimeout(btResizeT);
    btResizeT = setTimeout(() => {
      const bt = S.backtest || S.snap?.backtest || {};
      if (bt.ok && Array.isArray(bt.equity_curve)) {
        drawEquityCurve(bt.equity_curve.map(Number).filter((x) => Number.isFinite(x)));
      }
    }, 150);
  });


  /* A cached language pack paints instantly and the fresh one lands a moment
     later. On the rare occasion the words actually changed - a new build
     with new strings - redraw rather than leave the trader on yesterday's
     labels until they navigate. */
  window.addEventListener("aurion:i18n", () => {
    try { repaintForLanguage(); } catch (e) { /* not worth breaking the desk */ }
  });

  bindStrategyDropTarget();
  await I18N.load(I18N.lang);
  I18N.apply();
  markLangPills();
  if (S.view === "profile" || S.view === "execution") S.view = "command";
  try {
    const meta = await API.get('/api/meta');
    if(meta && meta.ok && meta.data){
      S.version = meta.data.version || '1.0.0';
      S.buildDate = meta.data.build_date || new Date().toISOString().slice(0,10);
    }
  } catch {}
  const upd = updateCheck(S.version);
  S._updated = upd;

  // Product-key gate: premium machines skip the key screen entirely and land
  // on the desk; freemium/expired machines always meet the gate first.
  //
  // The licence lookup runs alongside the welcome clip rather than before
  // it, so the retries that stop a still-starting engine from being read as
  // "no licence" cost no extra waiting.
  const welcome = playWelcome();
  const lic = await fetchLicenseSettled();
  S._gateLic = lic;
  await welcome;

  if (lic && lic.premium) {
    if (upd.updated) await showUpdateWelcome(S.version, upd.from);
    return licenseSessionEnter("auto", lic);
  }
  showGate(lic);
}

boot();
// Say which build this is before anything else can go wrong, so "the
// change is not there" can be answered without guessing.
try { console.info("AURION desk build", buildTag()); } catch (e) { /* no DOM yet */ }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
