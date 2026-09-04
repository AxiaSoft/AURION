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
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/><circle cx="8.5" cy="14.5" r="1.2"/><circle cx="15.5" cy="14.5" r="1.2"/><circle cx="12" cy="17.5" r="1.2"/>',
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
function toast(msg) {
  const wrap = $("toasts");
  if (!wrap) return;
  while (wrap.children.length >= 2) wrap.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
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
      document.body.appendChild(host);
    }
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
  if (nav) nav.setAttribute("aria-hidden", isCompactNav() && !on ? "true" : "false");
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

function paintNavAcc() {
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
  nav.innerHTML = `<div class="nav-head"><div class="nav-logo"><img class="mark" src="/icons/mark.png?v=desk49" alt="AURION" /></div><div class="nav-brand"><b>AURION</b><span class="nav-tag">${tag}</span></div></div>` +
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

function gateKey() {
  const g = liveGate();
  return JSON.stringify({
    who: g.who || "nobody",
    ready: Boolean(g.ready),
    mt5: Boolean(g.mt5),
    auto: Boolean(g.auto_trade),
    st: g.strategies || [],
    kill: Boolean(g.kill),
    prop: Boolean(g.prop),
    locked: Boolean(g.prop_locked),
    ai: Boolean(g.ai_gate),
    reasons: g.reasons || [],
    style: g.style || "normal",
    lang: I18N.lang,
  });
}
function gateHtml() {
  const g = liveGate();
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
  return `<div class="card gate-card" id="trade-gate" data-gk="${esc(gateKey())}">
    <div class="auto-banner" style="margin:0 0 10px">
      <div>
        <h3 style="margin:0 0 4px">${I18N.t("gate.title")}</h3>
        <p class="sub">${I18N.t("gate.who")}: <b id="gate-who">${whoLabel}</b> · ${I18N.t("style.title")}: <span id="gate-style">${I18N.t("style." + (g.style || "normal"))}</span></p>
      </div>
      <span class="pill ${g.ready ? "on" : ""}" id="gate-armed">${g.ready ? I18N.t("gate.armed") : I18N.t("gate.idle")}</span>
    </div>
    <div class="gate-pills" id="gate-pills">${items.map(([id, ok, key]) => `<span class="pill ${ok ? "ok" : "no"}">${I18N.t(key)}${id==="st" && g.strategies?.length ? " · " + g.strategies.join(", ") : ""}</span>`).join("")}</div>
    <ul class="gate-why" id="gate-why">${why}</ul>
  </div>`;
}
function patchGate() {
  const cur = $("trade-gate");
  if (!cur) return;
  const key = gateKey();
  if (S._gatePainted === key) return;
  S._gatePainted = key;
  const who = $("gate-who");
  const style = $("gate-style");
  const armed = $("gate-armed");
  const pills = $("gate-pills");
  const why = $("gate-why");
  if (!who || !armed || !pills || !why) {
    const wrap = document.createElement("div");
    wrap.innerHTML = gateHtml();
    const next = wrap.firstElementChild;
    if (next) cur.replaceWith(next);
    return;
  }
  const g = liveGate();
  const reasons = g.reasons || [];
  who.textContent = I18N.t("gate.who_" + (g.who || "nobody"));
  if (style) style.textContent = I18N.t("style." + (g.style || "normal"));
  armed.textContent = g.ready ? I18N.t("gate.armed") : I18N.t("gate.idle");
  armed.classList.toggle("on", Boolean(g.ready));
  const items = [
    ["mt5", g.mt5, "gate.mt5"],
    ["auto", g.auto_trade, "gate.auto"],
    ["st", (g.strategies || []).length, "gate.strategies"],
    ["kill", !g.kill, "gate.kill_ok"],
    ["prop", !(g.prop && g.prop_locked), g.prop ? "gate.prop_ok" : "gate.prop_off"],
    ["ai", !reasons.includes("ai_low"), g.ai_gate ? "gate.ai_on" : "gate.ai_off"],
  ];
  pills.innerHTML = items.map(([id, ok, k]) => `<span class="pill ${ok ? "ok" : "no"}">${I18N.t(k)}${id==="st" && g.strategies?.length ? " · " + g.strategies.join(", ") : ""}</span>`).join("");
  why.innerHTML = reasons.length ? reasons.map((r) => `<li>${I18N.t("gate.r_" + r)}</li>`).join("") : `<li>${I18N.t("gate.ready")}</li>`;
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
    const ai = $("live-ai");
    if (ai) ai.innerHTML = aiBlock(S.snap?.ai);
  }
  if (v === "markets") {
    fillSymbolSelect("sym", S.symbol);
    const lbl = $("tick-lbl");
    if (lbl) lbl.textContent = tickLabel();
    const ticks = S.snap?.ticks || {};
    const symbols = liveSymbols().map((x) => x.symbol).filter((s) => ticks[s]);
    const box = $("live-ticks");
    if (box) {
      box.innerHTML = symbols.length
        ? `<div class="table-wrap"><table><thead><tr><th>${I18N.t("markets.symbol")}</th><th>${I18N.t("markets.bid")}</th><th>${I18N.t("markets.ask")}</th></tr></thead><tbody>${symbols.map((s)=>`<tr><td>${s}</td><td class="mono">${fmt(ticks[s].bid,5)}</td><td class="mono">${fmt(ticks[s].ask,5)}</td></tr>`).join("")}</tbody></table></div>`
        : emptyMini(I18N.t("status.waiting_ticks"));
    }
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
    const autoSub = $("st-auto")?.closest(".auto-banner")?.querySelector(".sub");
    if (autoSub) autoSub.textContent = I18N.t(autoOn ? "exec.auto_on" : "exec.auto_off");
    const propOn = pstat.enabled !== false;
    paintSwitch($("prop-enable"), propOn);
    const psub = $("prop-enable-sub");
    if (psub) psub.textContent = I18N.t(propOn ? "risk.prop_on" : "risk.prop_off");
    const lk = $("pr-lock");
    const uk = $("pr-unlock");
    if (lk) lk.disabled = !propOn;
    if (uk) uk.disabled = !propOn;
  }
  if (v === "charts" || v === "markets") applyChartLevels();
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
    if (act) {
      act.textContent = it.last_action || "idle";
      act.className = "mono " + (it.last_action === "buy" ? "up" : it.last_action === "sell" ? "down" : "");
    }
    if (ev && it.last_reason) ev.textContent = it.last_reason;
    if (on) on.textContent = it.enabled ? I18N.t("strategies.enable") : I18N.t("strategies.disable");
    if (sw) sw.classList.toggle("on", Boolean(it.enabled));
    if (wr) wr.textContent = fmt(it.win_rate || 0, 1) + "%";
    if (net) {
      net.textContent = fmt(it.net || 0);
      net.className = "mono " + clsPnl(it.net);
    }
    if (n) n.textContent = String(it.trades || 0);
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
  if (open) dr.innerHTML = hdrDrawerHtml();
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
    scalp_impulse: "strategies.scalp_about",
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
function chartTicketHtml() {
  const t = S.ticket || S.manual || {};
  const who = operatorName();
  return `<div class="chart-ticket" id="chart-ticket">
      <div class="ct-head">
        <h3>${I18N.t("exec.manual")}</h3>
        <p class="sub">${I18N.t("exec.chart_hint")} · ${esc(who)}</p>
      </div>
      <div class="ct-grid ct-grid-3">
        <label class="field"><span>${I18N.t("exec.volume")}</span>
          <input id="ct-vol" type="number" step="0.01" min="0.01" value="${esc(t.vol || "0.10")}" />
        </label>
        <label class="field"><span>${I18N.t("exec.sl")}</span>
          <input id="ct-sl" type="number" step="0.0001" value="${esc(t.sl || "")}" placeholder="${esc(I18N.t("exec.chart_click"))}" />
        </label>
        <label class="field"><span>${I18N.t("exec.tp")}</span>
          <input id="ct-tp" type="number" step="0.0001" value="${esc(t.tp || "")}" placeholder="${esc(I18N.t("exec.chart_click"))}" />
        </label>
      </div>
      <div class="row ct-actions">
        <button class="btn tiny ghost" type="button" id="ct-pick-sl">${I18N.t("exec.set_sl")}</button>
        <button class="btn tiny ghost" type="button" id="ct-pick-tp">${I18N.t("exec.set_tp")}</button>
        <button class="btn tiny ghost" type="button" id="ct-clear-sl">${I18N.t("exec.clear_sl")}</button>
        <button class="btn tiny ghost" type="button" id="ct-clear-tp">${I18N.t("exec.clear_tp")}</button>
        <span class="grow"></span>
        <button class="btn" type="button" id="ct-buy">${I18N.t("exec.buy")}</button>
        <button class="btn danger" type="button" id="ct-sell">${I18N.t("exec.sell")}</button>
      </div>
      <p class="sub" id="ct-msg"></p>
    </div>`;
}
function rememberTicket() {
  S.ticket = {
    strategy: "@" + operatorName(),
    vol: String($("ct-vol")?.value || "0.10"),
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
  ["ct-vol", "ct-sl", "ct-tp"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => { rememberTicket(); syncChartPending(); });
    el.addEventListener("input", () => { rememberTicket(); syncChartPending(); });
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
function strategyItems() {
  const st = S.snap?.strategy || {};
  const items = st.items && st.items.length ? st.items : [
    {name:"ema_rsi", enabled:false, last_action:"idle"},
    {name:"price_action", enabled:false, last_action:"idle"},
    {name:"atr_breakout", enabled:false, last_action:"idle"},
    {name:"scalp_impulse", enabled:false, last_action:"idle"},
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
    const act = it.last_action || "idle";
    const cls = act === "buy" ? "up" : act === "sell" ? "down" : "";
    const custom = (it.kind || "builtin") !== "builtin";
    return `<div class="card st-card" data-st-card="${esc(it.name)}">
      <div class="st-top">
        <div>
          <h3 style="margin:0">${esc(it.name)}</h3>
          <p class="sub">${custom ? I18N.t("strategies.custom_about") : stAbout(it.name)}</p>
        </div>
        <button type="button" class="switch ${it.enabled?"on":""}" data-st="${esc(it.name)}" aria-pressed="${it.enabled}"><i></i></button>
      </div>
      <div class="st-live">
        <span class="pill ${it.enabled?"on":""}" data-st-on="${esc(it.name)}">${it.enabled ? I18N.t("strategies.enable") : I18N.t("strategies.disable")}</span>
        <b class="mono ${cls}" data-st-act="${esc(it.name)}">${act}</b>
        <span class="pill ghost">${I18N.t(custom ? "strategies.custom" : "strategies.builtin_tag")}</span>
      </div>
      <div class="st-stats">
        <div><span>${I18N.t("strategies.winrate")}</span><b class="mono" data-st-wr="${esc(it.name)}">${fmt(it.win_rate || 0, 1)}%</b></div>
        <div><span>${I18N.t("strategies.net")}</span><b class="mono ${clsPnl(it.net)}" data-st-net="${esc(it.name)}">${fmt(it.net || 0)}</b></div>
        <div><span>${I18N.t("strategies.trades")}</span><b class="mono" data-st-n="${esc(it.name)}">${it.trades || 0}</b></div>
      </div>
      <p class="sub" data-st-eval="${esc(it.name)}">${it.last_reason || I18N.t("strategies.waiting")}</p>
      ${custom ? `<div class="row st-mng">
        <button type="button" class="btn tiny ghost" data-st-edit="${esc(it.name)}">${I18N.t("strategies.edit")}</button>
        <button type="button" class="btn tiny ghost st-del" data-st-del="${esc(it.name)}">${I18N.t("strategies.delete")}</button>
      </div>` : ""}
    </div>`;
  }).join("");
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
        <img src="/assets/axiasoft-logo.png?v=desk45" alt="Axiasoft" class="axiasoft-logo" />
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
  return `<div class="card">
      <div class="auto-banner" style="margin:0">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("strategies.auto")}</h3>
          <p class="sub">${st.auto_trade ? I18N.t("exec.auto_on") : I18N.t("exec.auto_off")}</p>
        </div>
        <button type="button" class="switch ${st.auto_trade?"on":""}" id="st-auto" aria-pressed="${Boolean(st.auto_trade)}"><i></i></button>
      </div>
      ${freeAuto}
    </div>
    <div class="card" id="set-style">
      <h3>${I18N.t("style.title")}</h3>
      <div class="tabs" id="style-tabs">
        <button type="button" data-style="normal" class="${style!=="scalping"?"on":""}">${I18N.t("style.normal")}</button>
        <button type="button" data-style="scalping" class="${style==="scalping"?"on":""}"${licFeat("scalping") ? "" : " disabled"}>${I18N.t("style.scalping")}</button>
      </div>
      <p class="sub">${style==="scalping" ? I18N.t("style.scalping_hint") : I18N.t("style.normal_hint")}</p>
      ${licFeat("scalping") ? "" : `<p class="sub lock-note">${I18N.t("lock.scalping")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`}
    </div>
    <div class="card">
      <h3>${I18N.t("strategies.ai_gate")}</h3>
      <p class="sub">${I18N.t("strategies.ai_gate_help")}</p>
      <label class="field" style="flex-direction:row;align-items:center;justify-content:space-between">
        <span>${I18N.t("strategies.ai_gate_switch")}</span>
        <button type="button" class="switch ${st.require_ai_agree!==false?"on":""}" id="st-ai"><i></i></button>
      </label>
      <div class="field"><span class="conf-head">${I18N.t("strategies.min_conf")}<b class="mono conf-pct" id="st-conf-pct">${Math.round((st.min_ai_confidence ?? 0.55) * 100)}%</b></span>
        <input id="st-conf" type="range" step="0.01" min="0.05" max="0.95" value="${st.min_ai_confidence ?? 0.55}" />
      </div>
      <p class="sub" id="ai-conf-why">${I18N.t("strategies.min_conf_help")}</p>
      <button class="btn block" id="st-ai-save" type="button">${I18N.t("common.save")}</button>
    </div>
    <div class="card">
      <h3>${I18N.t("strategies.lot_title")} ${!licFeat("volume_mode")?'<span class="pill no">PREMIUM</span>':''}</h3>
      <p class="sub">${I18N.t("strategies.lot_help")}</p>
      ${!licFeat("volume_mode")?`<p class="sub lock-note">${I18N.t("lock.volume_mode")||"Volume mode is premium"} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`:""}
      <div class="tabs" id="vol-tabs">
        <button type="button" data-vm="auto" class="${st.volume_mode !== "manual" ? "on" : ""}">${I18N.t("strategies.lot_auto")}</button>
        <button type="button" data-vm="manual" class="${st.volume_mode === "manual" ? "on" : ""}"${!licFeat("volume_mode")?" disabled":""}>${I18N.t("strategies.lot_manual")}</button>
      </div>
      <label class="field" id="vol-field" style="${st.volume_mode === "manual" ? "margin-top:10px" : "display:none"}"><span>${I18N.t("strategies.lot_value")}</span>
        <input id="st-vol" type="number" step="0.01" min="0.01" max="1000" value="${st.manual_volume ?? 0.10}" ${!licFeat("volume_mode") && st.volume_mode==="manual"?"":""} />
      </label>
      <p class="sub" id="vol-sub">${I18N.t(st.volume_mode === "manual" ? "strategies.lot_manual_sub" : "strategies.lot_auto_sub")}</p>
    </div>
    <div class="card">
      <div class="auto-banner" style="margin:0">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("strategies.news_trade")}</h3>
          <p class="sub" id="st-news-sub">${st.news_trade_locked ? I18N.t("strategies.news_locked") : I18N.t("strategies.news_help")}</p>
        </div>
        <button type="button" class="switch ${st.news_trade && newsPrem?"on":""}" id="st-news" ${st.news_trade_locked || !newsPrem?"disabled":""} aria-pressed="${Boolean(st.news_trade && newsPrem)}"><i></i></button>
      </div>
      ${newsPrem ? "" : `<p class="sub lock-note">${I18N.t("lock.news")} <a href="#" data-go-upgrade>${I18N.t("lic.upgrade_cta")}</a></p>`}
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
          <label class="field"><span>${I18N.t("risk.daily_loss")}</span><input id="pr-dday" type="number" step="0.1" value="${pr.max_daily_loss_pct||2}" /></label>
          <label class="field"><span>${I18N.t("risk.max_dd")}</span><input id="pr-mdd" type="number" step="0.1" value="${pr.max_drawdown_pct||5}" /></label>
          <label class="field"><span>${I18N.t("risk.daily_profit")}</span><input id="pr-dtp" type="number" step="0.1" value="${pr.max_daily_profit_pct||0}" /></label>
          <label class="field"><span>${I18N.t("risk.profit_target")}</span><input id="pr-pt" type="number" step="0.1" value="${pr.profit_target_pct||0}" /></label>
          <label class="field"><span>${I18N.t("risk.max_lot")}</span><input id="pr-lot" type="number" step="0.01" value="${pr.max_lot||0.5}" /></label>
          <label class="field"><span>${I18N.t("risk.max_lot_symbol")}</span><input id="pr-lotsym" type="number" step="0.01" value="${pr.max_lot_per_symbol||0}" /></label>
          <label class="field"><span>${I18N.t("risk.max_trades")}</span><input id="pr-n" type="number" value="${pr.max_open_trades||2}" /></label>
          <label class="field"><span>${I18N.t("risk.per_symbol")}</span><input id="pr-ps" type="number" value="${pr.max_positions_per_symbol||1}" /></label>
          <label class="field"><span>${I18N.t("risk.max_day_trades")}</span><input id="pr-dayn" type="number" value="${pr.max_trades_per_day||0}" /></label>
          <label class="field"><span>${I18N.t("risk.risk_pct")}</span><input id="pr-risk" type="number" step="0.1" value="${pr.max_risk_per_trade_pct||0.5}" /></label>
        </div>
        <h4 class="set-h">${I18N.t("risk.sec_time")}</h4>
        <div class="grid g-2">
          <label class="field"><span>${I18N.t("risk.min_hold")}</span><input id="pr-holdmin" type="number" step="0.1" value="${pr.min_hold_minutes||0}" /></label>
          <label class="field"><span>${I18N.t("risk.max_hold")}</span><input id="pr-maxhold" type="number" step="0.1" value="${pr.max_hold_hours||0}" /></label>
          <label class="field"><span>${I18N.t("risk.gap")}</span><input id="pr-gap" type="number" value="${pr.min_minutes_between_trades||0}" /></label>
          <label class="field"><span>${I18N.t("risk.consec")}</span><input id="pr-cl" type="number" value="${pr.max_consecutive_losses||0}" /></label>
          <label class="field"><span>${I18N.t("risk.hours_start")}</span><input id="pr-hs" value="${(pr.trading_hours&&pr.trading_hours.start)||"00:15"}" /></label>
          <label class="field"><span>${I18N.t("risk.hours_end")}</span><input id="pr-he" value="${(pr.trading_hours&&pr.trading_hours.end)||"23:45"}" /></label>
          <label class="field"><span>${I18N.t("risk.friday")}</span><input id="pr-fri" type="number" value="${pr.friday_close_utc_hour||21}" /></label>
          <label class="field"><span>${I18N.t("risk.news_before")}</span><input id="pr-nb" type="number" value="${pr.news_blackout_before||15}" /></label>
          <label class="field"><span>${I18N.t("risk.news_after")}</span><input id="pr-na" type="number" value="${pr.news_blackout_after||15}" /></label>
        </div>
        <h4 class="set-h">${I18N.t("risk.sec_filters")}</h4>
        <div class="field sym-field">
          <span>${I18N.t("risk.symbols")}</span>
          <div class="sym-pick" id="pr-syms-pick">
            <button type="button" class="btn sm sym-btn" id="pr-syms-btn" aria-haspopup="true" aria-expanded="false">
              <span id="pr-syms-label">${esc(I18N.t("risk.symbols_pick"))}</span>
              <span class="sym-caret">▾</span>
            </button>
            <input type="hidden" id="pr-syms" value="${esc(pr.allowed_symbols||"")}" />
            <div class="sym-panel" id="pr-syms-panel" hidden>
              <input class="fld sym-q" id="pr-syms-q" type="search" placeholder="${esc(I18N.t("risk.symbols_search"))}" />
              <div class="sym-acts">
                <button type="button" class="btn sm" id="pr-syms-all">${esc(I18N.t("risk.symbols_all"))}</button>
                <button type="button" class="btn sm" id="pr-syms-none">${esc(I18N.t("risk.symbols_none"))}</button>
              </div>
              <div class="sym-list" id="pr-syms-list" role="listbox" aria-multiselectable="true"></div>
              <div class="sym-foot" id="pr-syms-foot"></div>
            </div>
          </div>
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
          <a class="btn block ghost" href="/guide-install.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.install")}</a>
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
      <div class="grid g-2">
        <div class="card">
          <h3>${I18N.t("command.positions")}</h3>
          <div id="live-pos">${pos.length ? table(pos, ["symbol","type","volume","strategy","price_open","price_current","sl","tp","profit","profit_pct"], true) : emptyMini(I18N.t("status.no_positions"))}</div>
        </div>
        <div class="cmd-side">
          <div class="card">
            <h3>${I18N.t("account.type")}</h3>
            <p class="metric" id="cmd-acc-type">${accTypeLabel(acc.account_label || acc.account_type || "unknown")}</p>
            <p class="sub">${[acc.company, acc.server, acc.margin_mode, acc.leverage ? "1:"+acc.leverage : ""].filter(Boolean).join(" · ")}</p>
            <div class="kv" style="margin-top:12px">
              <span>${I18N.t("command.free_margin")}</span><b class="mono" data-metric="command.free_margin">${fmt(acc.margin_free)} ${acc.currency||""}</b>
              <span>${I18N.t("command.leverage")}</span><b class="mono" data-metric="command.leverage">${acc.leverage ? "1:"+acc.leverage : "—"}</b>
            </div>
          </div>
          <div class="card">
            <h3>${I18N.t("ai.title")}</h3>
            <div id="live-ai">${aiBlock(S.snap?.ai)}</div>
          </div>
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
    return `<div class="grid g-chart">
      <div class="card">
        <div class="row" style="margin-bottom:10px;gap:8px;flex-wrap:wrap">
          ${symbolSelectHtml("sym", S.symbol)}
          <select class="ctrl" id="tf">${["M1","M5","M15","M30","H1","H4","D1"].map((t)=>`<option ${t===S.timeframe?"selected":""}>${t}</option>`).join("")}</select>
          <span class="legend mono" id="tick-lbl">${tickLabel()}</span>
        </div>
        <div class="row" style="margin-bottom:8px;gap:6px">
          <button type="button" class="btn tiny ${S.signalsEnabled?"on":"ghost"}" id="sig-toggle-m">${S.signalsEnabled?"🔔 Signals ON":"🔕 Signals OFF"}</button>
          <button type="button" class="btn tiny ghost" id="sig-show-m" style="${S.signalsEnabled?"":"display:none"}">${S.showSignals?"👁️":"🚫"}</button>
          ${!licFeat("chart_signals")?`<span class="pill no" style="font-size:10px">PREMIUM</span>`:""}
        </div>
        <div class="chart-box"><canvas id="cv"></canvas>${!eaLive() || !S.candles.length ? emptyCard(I18N.t("markets.empty"), symbols.length ? I18N.t("markets.loading_tf") : I18N.t("exec.no_ea_symbol")) : ""}</div>
        ${eaLive() ? chartTicketHtml() : ""}
        <!-- Chart signals list removed per user request — signals only on chart canvas itself -->
      </div>
      <div class="card">
        <h3>${I18N.t("markets.title")}</h3>
        <div id="live-ticks">${symbols.length ? `<div class="table-wrap"><table><thead><tr><th>${I18N.t("markets.symbol")}</th><th>${I18N.t("markets.bid")}</th><th>${I18N.t("markets.ask")}</th></tr></thead><tbody>${symbols.map((s)=>`<tr><td>${s}</td><td class="mono">${fmt(ticks[s]?.bid,5)}</td><td class="mono">${fmt(ticks[s]?.ask,5)}</td></tr>`).join("")}</tbody></table></div>` : emptyMini(I18N.t("exec.no_ea_symbol"))}</div>
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
    return `<div class="grid g-2">
      <div class="card">${chartSliderHtml("ai", aiSlideInnerHtml)}</div>
      <div class="card">
        <h3>${I18N.t("ai.regime")} · ${I18N.t("ai.direction")} (per chart)</h3>
        <p class="metric" id="ai-regime">${regLabel(typeof rg === "string" ? {name: rg} : rg)}</p>
        <p class="sub">${esc((rg && typeof rg === "object" ? rg.reason : "") || "")}</p>
        <h3 style="margin-top:16px">${I18N.t("ai.pattern")}</h3>
        <p class="metric" id="ai-pattern" style="font-size:20px">${esc(typeof pat === "string" ? pat : (pat?.name || "—"))}</p>
        <p class="sub">${esc((pat && typeof pat === "object" ? pat.reason : "") || I18N.t("status.ai_idle"))}</p>
        <p class="sub" style="margin-top:8px">اسلایدر بالا جهت + رژیم را برای هر چارت جداگانه نشان می‌دهد — با دکمه‌های ‹ › بین چارت‌ها جابجا شوید.</p>
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
    return `<div class="card auto-banner">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("strategies.live")}</h3>
          <p class="sub">${st.auto_trade ? I18N.t("exec.auto_on") : I18N.t("exec.auto_off")} · ${I18N.t("style.title")}: ${I18N.t("style." + (st.trade_style||"normal"))}</p>
          <p class="sub" style="opacity:.85">${I18N.t("strategies.single_rule")}</p>
        </div>
        <span class="pill" id="st-live-sig">${sig ? `${sig.action||"—"} ${sig.symbol||""}` : I18N.t("strategies.waiting")}</span>
      </div>
      <div class="grid g-2" id="st-live-grid">${strategyLiveCards()}</div>
      ${strategyUploadCard()}`;
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
      const tools = [
        ["cursor", "draw.cursor", "M5 12h14"],
        ["trend", "draw.trend", "M4 18L10 10L14 14L20 6"],
        ["ray", "draw.ray", "M4 18L20 6M16 6h4v4"],
        ["extended", "draw.extended", "M2 20L22 4"],
        ["parallel", "draw.parallel", "M5 16L15 6M9 20L19 10"],
        ["channel", "draw.channel", "M4 16L14 6M8 20L18 10M6 18L16 8"],
        ["pitchfork", "draw.pitchfork", "M4 20L12 4L20 20M12 4v16"],
        ["triangle", "draw.triangle", "M12 4L20 18H4z"],
        ["circle", "draw.circle", "M12 4a8 8 0 100 16 8 8 0 000-16z"],
        ["ellipse", "draw.ellipse", "M12 6c5 0 8 3 8 6s-3 6-8 6-8-3-8-6 3-6 8-6z"],
        ["hline", "draw.hline", "M4 12h16"],
        ["hray", "draw.hray", "M8 12h12M8 9v6"],
        ["vline", "draw.vline", "M12 4v16"],
        ["rect", "draw.rect", "M6 7h12v10H6z"],
        ["long", "draw.long", "M7 17V7h10"],
        ["short", "draw.short", "M7 7v10h10"],
        ["fib", "draw.fib", "M4 7h16M4 12h16M4 17h16"],
        ["fibext", "draw.fibext", "M4 6h16M4 11h16M4 16h10"],
        ["fibtime", "draw.fibtime", "M7 4v16M12 4v16M17 4v16"],
        ["gann", "draw.gann", "M4 20L20 4M4 20L20 12M4 20L12 4"],
        ["measure", "draw.measure", "M5 19L19 5M8 19h-3v-3M19 8V5h-3"],
        ["pricerange", "draw.pricerange", "M4 8h16M4 16h16"],
        ["daterange", "draw.daterange", "M8 4v16M16 4v16"],
        ["arrow", "draw.arrow", "M5 19L19 5M14 5h5v5"],
        ["brush", "draw.brush", "M4 16c4-6 8 2 12-4 2-3 4-4 4-4"],
        ["infoline", "draw.infoline", "M4 18L20 6M12 4v4"],
        ["text", "draw.text", "M6 8h12M12 8v10"],
        ["emoji", "draw.emoji", "M12 8v.01M8 13c1.5 2 6.5 2 8 0"],
      ];
      const svgBtn = (id, key, d, extra = "") =>
        `<button type="button" data-tool="${id}" class="${id==="cursor"?"on":""}" title="${I18N.t(key)}" aria-label="${I18N.t(key)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${d.startsWith("<") ? d : `<path d="${d}"/>`}</svg></button>`;
      return `<div class="chart-work">
        <div class="chart-work-bar">
          <button type="button" class="btn tiny ghost" id="chart-back">${I18N.t("common.back")}</button>
          <h3>${f.symbol} · ${f.timeframe}</h3>
          <span class="legend mono" id="tick-lbl">${tickLabel()}</span>
          <div class="chart-signals-bar" style="display:flex;gap:6px;align-items:center;margin-inline:8px">
            <button type="button" class="btn tiny ${S.signalsEnabled?"on":"ghost"}" id="sig-toggle" title="Buy/Sell signals">${S.signalsEnabled?"🔔 Signals ON":"🔕 Signals OFF"}</button>
            <button type="button" class="btn tiny ghost" id="sig-show" style="${S.signalsEnabled?"":"display:none"}">${S.showSignals?"👁️":"🚫"}</button>
            ${!licFeat("chart_signals")?`<span class="pill no" style="font-size:10px">PREMIUM</span>`:""}
          </div>
          <div class="draw-frame" id="draw-frame">
            <button type="button" class="icon-btn draw-more" id="draw-more" title="${I18N.t("draw.tools")}" aria-label="${I18N.t("draw.tools")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
            <div class="draw-tools" id="draw-tools">
              ${tools.map(([id,k,d]) => svgBtn(id, k, d)).join("")}
              <button type="button" id="draw-magnet" title="${I18N.t("draw.magnet")}" aria-label="${I18N.t("draw.magnet")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 4v8a5 5 0 0010 0V4M7 4H4v8a8 8 0 0016 0V4h-3"/></svg></button>
              <button type="button" id="draw-zin" title="${I18N.t("draw.zoom_in")}" aria-label="${I18N.t("draw.zoom_in")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="6"/><path d="M21 21l-4-4M8 11h6M11 8v6"/></svg></button>
              <button type="button" id="draw-zout" title="${I18N.t("draw.zoom_out")}" aria-label="${I18N.t("draw.zoom_out")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="6"/><path d="M21 21l-4-4M8 11h6"/></svg></button>
              <button type="button" id="draw-fit" title="${I18N.t("draw.fit")}" aria-label="${I18N.t("draw.fit")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
              <button type="button" id="draw-undo" title="${I18N.t("draw.undo")}" aria-label="${I18N.t("draw.undo")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 110 12h-2"/></svg></button>
              <button type="button" id="draw-clear" title="${I18N.t("draw.clear")}" aria-label="${I18N.t("draw.clear")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12"/></svg></button>
            </div>
          </div>
        </div>
        <div class="chart-box"><canvas id="cv-desk"></canvas><div class="chart-levels" id="chart-levels"></div></div>
        ${chartTicketHtml()}
        <!-- chart signals list removed — only canvas overlay per user request -->
      </div>`;
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
      ${tester && !clickable ? `<p class="sub">${I18N.t("tape.showing_backtest")}</p>` : `<div class="chart-box" style="height:200px;margin-top:10px"><canvas data-mini="${a.symbol||""}" data-tf="${a.timeframe||""}"></canvas></div>
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
        <button class="btn tiny" id="term-restart" type="button" title="Immediate restart of system terminals">🔄 ${I18N.t("terminal.restart")||"Restart Terminals"}</button>
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
        <h3>🧪 ${I18N.t("history.backtest")}</h3>
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
        <div id="bt-result">${renderBacktestCard(bt)}</div>
      </div>
      <div class="card">
        <h3>📊 نتایج بک‌تست</h3>
        <p class="sub">نتایج آخرین بک‌تست در اینجا نمایش داده می‌شود</p>
        <div id="bt-extra"></div>
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
    const tabBtn = (id, label) => `<button type="button" data-jump="${id}" class="${tab===id?"on":""}">${label}</button>`;
    return `<div class="set-desk"><div class="set-jump tabs" id="set-jump">
        ${tabBtn("set-robot", I18N.t("settings.sec_robot"))}
        ${tabBtn("set-strats", I18N.t("nav.strategies"))}
        ${tabBtn("set-prop", I18N.t("risk.title"))}
        ${tabBtn("set-mt5", "MT5")}
        ${tabBtn("set-lang", I18N.t("settings.language"))}
        ${tabBtn("set-telegram", I18N.t("telegram.title"))}
        ${tabBtn("set-update", "آپدیت سیستم")}
        ${tabBtn("set-system", I18N.t("host.system"))}
      </div>
      <section class="set-block" id="set-robot"${tab==="set-robot"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("settings.sec_robot")}</h2>
        <div class="grid g-2">${robotPanelHtml()}</div>
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
        ${licFeat("prop") ? `${propStatusHtml()}<div class="card">${propFormHtml()}</div>` : lockedUpgradeCard("prop")}
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
          <p class="sub">AURION 1.0.0</p>
          <a class="btn block ghost" href="/guide-install.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.install")}</a>
          <a class="btn block ghost" href="/guide.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.open")}</a>
          <a class="btn block ghost" href="/guide-backtest.html?v=desk45" target="_blank" rel="noopener">${I18N.t("guide.backtest")}</a>
        </div>
      </section>
      <section class="set-block" id="set-telegram"${tab==="set-telegram"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("telegram.title")}</h2>
        ${licFeat("telegram") ? telegramPanelHtml() : lockedUpgradeCard("telegram")}
      </section>
      <section class="set-block" id="set-update" hidden>
        <h2 class="set-title">آپدیت سیستم</h2>
        <div class="card">
          <h3>تنظیمات آپدیت</h3>
          <label class="field" style="flex-direction:row;align-items:center;justify-content:space-between;margin-top:12px">
            <span>چک خودکار آپدیت</span>
            <button type="button" class="switch" id="upd-auto"><i></i></button>
          </label>
          <label class="field"><span>فاصله چک خودکار (ساعت)</span>
            <input id="upd-interval" type="number" min="1" max="168" value="6" />
          </label>
          <button class="btn block" id="upd-save" type="button">ذخیره تنظیمات</button>
          <p class="sub" id="upd-save-msg"></p>
        </div>
        <div class="card" style="margin-top:14px">
          <h3>وضعیت آپدیت</h3>
          <p class="sub" id="upd-last-check">آخرین چک: -</p>
          <div id="upd-status"></div>
          <div class="row" style="margin-top:10px;gap:8px">
            <button class="btn" id="upd-check" type="button">🔍 چک کردن آپدیت</button>
            <button class="btn ghost" id="upd-manifest" type="button">📋 نمایش فایل‌های محلی</button>
          </div>
          <div id="upd-result" style="margin-top:12px"></div>
        </div>
      </section>
      <section class="set-block" id="set-system"${tab==="set-system"?"":" hidden"}>
        <h2 class="set-title">${I18N.t("host.system")}</h2>
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
      </section></div>`;
  },
  about() {
    const ver = S.version || S.snap?.version || S._gateLic?.version || "1.0.0";
    const L = (S.snap && S.snap.license) || {};
    const buildDate = S.buildDate || new Date().toISOString().slice(0,10);
    return `<div class="cmd">
      <div class="card" style="text-align:center;padding:32px 24px">
        <div style="width:96px;height:96px;margin:0 auto 16px;border-radius:24px;overflow:hidden;background:#05070c;box-shadow:0 12px 32px rgba(0,0,0,.4)">
          <img src="/icons/mark.png?v=desk49" alt="AURION" style="width:100%;height:100%;object-fit:cover;transform:scale(1.08)" />
        </div>
        <h2 style="margin:0 0 6px;font-size:28px;letter-spacing:.12em">AURION</h2>
        <p class="sub" style="font-size:14px">نسخه <b class="mono" style="color:var(--cyan)">v${esc(ver)}</b> • بیلد ${esc(buildDate)}</p>
        <p class="sub" style="margin-top:12px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.8">AURION یک دسک ترید زنده MetaTrader 5 با هوش مصنوعی، مدیریت ریسک پراپ و استراتژی‌های قابل آپلود است. طراحی شده برای تریدرهای حرفه‌ای.</p>
        <div style="margin:20px auto 0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <span class="pill ok">MT5 Live</span>
          <span class="pill ok">AI ${L.premium? 'PRO' : 'Free'}</span>
          <span class="pill">Prop Guard</span>
          <span class="pill">v${esc(ver)}</span>
        </div>
      </div>
      <div class="grid g-2">
        <div class="card">
          <h3>🛠️ مشخصات سیستم</h3>
          <div class="kv">
            <span>نام سیستم</span><b>AURION</b>
            <span>نسخه</span><b class="mono">v${esc(ver)}</b>
            <span>حالت</span><b>${S.snap?.engine === 'online' ? 'آنلاین 🟢' : 'آفلاین 🔴'}</b>
            <span>MT5</span><b>${mt5Live() ? 'متصل 🟢' : 'قطع 🔴'}</b>
            <span>EA Charts</span><b class="mono">${liveAgents().length}</b>
            <span>استراتژی فعال</span><b>${esc(S.snap?.strategy?.name||'—')}</b>
            <span>اتو ترید</span><b>${S.snap?.strategy?.auto_trade ? 'روشن 🟢' : 'خاموش 🔴'}</b>
            <span>کیل سوئیچ</span><b>${S.snap?.kill_switch ? 'مسلح 🔴' : 'خاموش 🟢'}</b>
            <span>Prop</span><b>${S.snap?.prop?.enabled !== false ? 'فعال 🟢' : 'غیرفعال 🔴'}</b>
            <span>زبان</span><b>${I18N.lang.toUpperCase()}</b>
          </div>
        </div>
        <div class="card">
          <h3>🏢 سازنده</h3>
          <div style="display:flex;align-items:center;gap:14px;margin:12px 0">
            <img src="/assets/axiasoft-logo.png?v=desk49" alt="Axiasoft" style="width:56px;height:56px;object-fit:contain;background:transparent;border:none;border-radius:0" />
            <div>
              <b style="font-size:18px">Axiasoft</b><br>
              <span class="sub">توسعه‌دهنده AURION • 2024-${copyrightYear()}</span>
            </div>
          </div>
          <div class="kv" style="margin-top:12px">
            <span>محصول</span><b>AURION Live Desk</b>
            <span>لایسنس</span><b>${L.premium ? planLabel(L) : 'Freemium'}</b>
            <span>پشتیبانی</span><b>support@axiasoft</b>
            <span>آپدیت</span><b id="about-update-status">در حال بررسی...</b>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn tiny" id="about-check-update" type="button">🔄 چک آپدیت</button>
            <button class="btn tiny ghost" id="about-copy-ver" type="button">📋 کپی نسخه</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>📋 لاگ تغییرات</h3>
        <div id="about-changelog" class="sub" style="max-height:240px;overflow:auto;line-height:1.8">
          <p>در حال بارگذاری...</p>
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
  if (m.trading_allowed) {
    if (m.state !== "friday_close") return "";
    return `<div class="tape-banner is-closed">${esc(I18N.t("status.friday_close"))}</div>`;
  }
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
function aiBlock(ai) {
  if (!ai) return emptyMini(I18N.t("status.ai_idle"));
  const d = shownDir(ai);
  const hint = !ai.ready ? `<span class="badge-hint">${I18N.t("ai.untrained")}</span>` : "";
  const outlook = ai.outlook || {};
  return `<div class="kv">
    <span>${I18N.t("ai.direction")}</span><b>${dirLabel(d)}${hint}</b>
    <span>${I18N.t("ai.confidence")}</span><b class="mono">${fmt((ai.confidence||0)*100,1)}%</b>
    <span>${I18N.t("ai.regime")}</span><b>${regLabel(ai.regime)}</b>
    <span>${I18N.t("ai.pattern")}</span><b>${ai.pattern?.name || "—"}</b>
    <span>${I18N.t("ai.samples")}</span><b class="mono">${ai.samples || 0}${ai.need ? " / " + ai.need : ""}</b>
  </div><p class="sub">${esc(outlook.text || ai.reason || I18N.t("status.ai_idle"))}</p>`;
}
function posProfitPct(r) {
  if (r && r.profit_pct !== undefined && r.profit_pct !== null && r.profit_pct !== "") return Number(r.profit_pct);
  const o = Number(r && r.price_open), c = Number(r && r.price_current);
  if (!(o > 0) || !(c > 0)) return null;
  const raw = (c - o) / o * 100;
  return String(r.type || "").toLowerCase() === "sell" ? -raw : raw;
}
function table(rows, keys, closable) {
  const head = keys.map((k) => `<th>${I18N.t("table." + k) !== "table." + k ? I18N.t("table." + k) : k}</th>`).join("");
  const body = rows.map((r) => `<tr data-ticket="${r.ticket || ""}">${keys.map((k) => {
    const v = k === "profit_pct" ? posProfitPct(r) : r[k];
    const signed = k === "profit" || k === "profit_pct";
    const c = signed ? clsPnl(v) : "";
    let text;
    if (k === "profit_pct") text = (v === null || v === undefined || Number.isNaN(Number(v))) ? "—" : fmt(v, 2) + "%";
    else if (k === "strategy") text = strategyLabel(v);
    else if (k === "profit" || k === "volume" || k === "price_open" || k === "price_current") text = fmt(v, k === "volume" ? 2 : 5);
    else text = (v ?? "—");
    return `<td class="mono ${c}" data-k="${k}">${text}</td>`;
  }).join("")}${closable ? `<td><button class="btn tiny ghost" type="button" data-close="${r.ticket}">${I18N.t("exec.close")}</button></td>` : ""}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}${closable?"<th></th>":""}</tr></thead><tbody>${body}</tbody></table></div>`;
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
        let text;
        if (k === "profit_pct") text = (v === null || v === undefined || Number.isNaN(Number(v))) ? "—" : fmt(v, 2) + "%";
        else if (k === "strategy") text = strategyLabel(v);
        else if (k === "profit" || k === "volume" || k === "price_open" || k === "price_current") text = fmt(v, k === "volume" ? 2 : 5);
        else text = (v ?? "—");
        if (td.textContent !== text) td.textContent = text;
        if (k === "profit" || k === "profit_pct") {
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

function telegramPanelHtml() {
  const tg = (S.snap && S.snap.telegram) || {};
  const chats = Array.isArray(tg.chats) ? tg.chats : [];
  const on = Boolean(tg.enabled);
  const openOn = tg.notify_open !== false;
  const closeOn = tg.notify_close !== false;
  const lang = tg.language || I18N.lang || "fa";
  const chatHtml = chats.length
    ? `<div class="kv">${chats.map((c) => {
        const label = [c.name, c.username ? "@" + c.username : "", c.id].filter(Boolean).join(" · ");
        return `<span>${esc(label)}</span><button type="button" class="btn tiny ghost" data-tg-unlink="${esc(c.id)}">${I18N.t("telegram.unlink")}</button>`;
      }).join("")}</div>`
    : `<p class="sub">${I18N.t("telegram.no_chat")}</p>`;
  const status = tg.running ? I18N.t("telegram.running") : I18N.t("telegram.stopped");
  const err = tg.last_error ? `<p class="err">${esc(tg.last_error)}</p>` : "";
  const botName = tg.username ? `@${esc(tg.username)}` : "";
  return `<div class="card">
      <p class="sub">${I18N.t("telegram.hint")}</p>
      <div class="auto-banner" style="margin:12px 0">
        <div>
          <h3 style="margin:0 0 6px">${I18N.t("telegram.enable")}</h3>
          <p class="sub" id="tg-sub">${status}${botName ? " · " + botName : ""}</p>
        </div>
        <button type="button" class="switch ${on?"on":""}" id="tg-on" aria-pressed="${on}"><i></i></button>
      </div>
      <p class="sub">${esc(I18N.t("telegram.token_source_hint"))}</p>
      <label class="field"><span>${I18N.t("telegram.language")}</span>
        <select class="ctrl" id="tg-lang">
          <option value="fa" ${lang==="fa"?"selected":""}>فارسی</option>
          <option value="en" ${lang==="en"?"selected":""}>English</option>
          <option value="ar" ${lang==="ar"?"selected":""}>العربية</option>
        </select>
      </label>
      <div class="auto-banner" style="margin:8px 0">
        <div><h3 style="margin:0">${I18N.t("telegram.notify_open")}</h3></div>
        <button type="button" class="switch ${openOn?"on":""}" id="tg-open" aria-pressed="${openOn}"><i></i></button>
      </div>
      <div class="auto-banner" style="margin:8px 0">
        <div><h3 style="margin:0">${I18N.t("telegram.notify_close")}</h3></div>
        <button type="button" class="switch ${closeOn?"on":""}" id="tg-close" aria-pressed="${closeOn}"><i></i></button>
      </div>
      <button class="btn block" id="tg-save" type="button">${I18N.t("telegram.save")}</button>
      ${err}
      <p class="sub" id="tg-msg"></p>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>${I18N.t("telegram.pair")}</h3>
      <p class="sub">${I18N.t("telegram.pair_hint")}</p>
      <p class="metric mono" id="tg-code">${esc(S._tgCode || "—")}</p>
      <div class="row" style="margin-top:10px">
        <button class="btn" id="tg-pair" type="button">${I18N.t("telegram.pair_go")}</button>
        <button class="btn ghost" id="tg-test" type="button">${I18N.t("telegram.test")}</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>${I18N.t("telegram.chats")}</h3>
      ${chatHtml}
    </div>`;
}
function bindTelegramPanel() {
  const on = $("tg-on");
  if (on) on.onclick = () => paintSwitch(on, !on.classList.contains("on"));
  const op = $("tg-open");
  if (op) op.onclick = () => paintSwitch(op, !op.classList.contains("on"));
  const cl = $("tg-close");
  if (cl) cl.onclick = () => paintSwitch(cl, !cl.classList.contains("on"));
  const save = $("tg-save");
  if (save) save.onclick = async () => {
    // No bot_token here on purpose: the token is provisioned in the source.
    const r = await API.post("/api/telegram", {
      enabled: Boolean($("tg-on")?.classList.contains("on")),
      language: $("tg-lang")?.value || "fa",
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
    if (box) box.textContent = S._tgCode || "—";
    toast(I18N.t("telegram.code") + " " + S._tgCode);
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
      if(lastCheckEl) lastCheckEl.textContent = 'آخرین چک: '+(st.data.last_check||'-') + (st.data.update_available?' - آپدیت موجود!':' - به‌روز');
      if(statusEl){
        if(st.data.latest){
          statusEl.innerHTML = '<div class="kv"><span>نسخه جدید</span><b>'+esc(st.data.latest.version||'')+'</b><span>تاریخ</span><b>'+esc(st.data.latest.published_at||'')+'</b></div><p class="sub">'+esc(st.data.latest.changelog||'')+'</p><p class="sub">فایل‌های تغییر: '+(st.data.latest.files||[]).length+'</p>';
        } else {
          statusEl.innerHTML = '<p class="sub">آپدیتی یافت نشد</p>';
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
    const txt = r.ok ? 'ذخیره شد ✅' : (r.error||'خطا');
    if(saveMsg) saveMsg.textContent = txt;
    toast(txt);
  };
  if(autoEl) autoEl.onclick = () => paintSwitch(autoEl, !autoEl.classList.contains('on'));

  const checkBtn = document.getElementById('upd-check');
  if(checkBtn) checkBtn.onclick = async () => {
    if(resultEl) resultEl.innerHTML = '<p class="sub">در حال چک...</p>';
    const r = await API.post('/api/system/update/check', {});
    if(!r.ok){
      if(resultEl) resultEl.innerHTML = '<p class="err">خطا: '+esc(r.error||'')+'</p>';
      return;
    }
    if(!r.update_available){
      if(resultEl) resultEl.innerHTML = '<p class="ok">✅ سیستم به‌روز است - نسخه '+esc((r.latest&&r.latest.version)||'')+'</p>';
      if(lastCheckEl) lastCheckEl.textContent = 'آخرین چک: '+(r.last_check||new Date().toISOString())+' - به‌روز';
      return;
    }
    const upd = r.latest;
    if(resultEl){
      resultEl.innerHTML = '<div class="card" style="background:#111424"><h3>🆕 آپدیت موجود: '+esc(upd.version||'')+'</h3><p class="sub">'+esc(upd.changelog||'')+'</p><p class="sub">فایل‌ها: '+(upd.files||[]).length+' تغییر</p><div style="max-height:200px;overflow:auto;margin:8px 0">'+(upd.files||[]).map(f=>'<div class="file-item" style="display:flex;justify-content:space-between;background:#0a0c14;padding:6px;border-radius:4px;margin:3px 0"><span>'+esc(f.path)+'</span><span style="font-size:11px">'+(f.size||'')+' bytes</span></div>').join('')+'</div><button class="btn" id="upd-apply-btn" type="button">⬇️ دریافت و نصب آپدیت</button><p class="sub" style="margin-top:8px;color:#f6ad55">توجه: فایل‌ها جایگزین می‌شوند و بک‌آپ گرفته می‌شود</p></div>';
      const applyBtn = document.getElementById('upd-apply-btn');
      if(applyBtn) applyBtn.onclick = async () => {
        if(!confirm('آپدیت '+upd.version+' نصب شود؟ فایل‌های فعلی بک‌آپ گرفته می‌شود')) return;
        applyBtn.disabled = true;
        applyBtn.textContent = 'در حال نصب...';
        const ar = await API.post('/api/system/update/apply', { update_id: upd.id });
        if(ar.ok){
          resultEl.innerHTML = '<p class="ok">✅ آپدیت '+esc(ar.version||upd.version)+' نصب شد<br>فایل‌ها: '+(ar.applied||[]).length+'<br>بک‌آپ: '+esc(ar.backup_dir||'')+'</p><p class="sub">برای اعمال کامل، سیستم را ری‌استارت کنید</p><button class="btn" id="upd-restart" type="button">🔄 ری‌استارت سیستم</button>';
          const rb = document.getElementById('upd-restart');
          if(rb) rb.onclick = () => restartSystem();
        } else {
          resultEl.innerHTML = '<p class="err">خطا در نصب: '+esc(ar.error||'')+'</p>';
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
        resultEl.innerHTML = '<h4>فایل‌های محلی ('+(r.data.files||[]).length+')</h4><div style="max-height:300px;overflow:auto">'+(r.data.files||[]).slice(0,100).map(f=>'<div style="font-family:monospace;font-size:12px;padding:2px">'+esc(f.path)+' - '+esc(f.hash.slice(0,12))+'</div>').join('')+'</div><p class="sub">نسخه: '+esc(r.data.version||'')+'</p>';
      } else {
        resultEl.innerHTML = '<p class="err">خطا</p>';
      }
    }
  };
}

function showSetTab(id) {
  const allow = ["set-robot", "set-strats", "set-prop", "set-mt5", "set-lang", "set-telegram", "set-update", "set-system"];
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
        sigToggleM.textContent = S.signalsEnabled ? "🔔 Signals ON" : "🔕 Signals OFF";
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
        sigShowM.textContent = S.showSignals ? "👁️" : "🚫";
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
      tr.textContent = "⏳ Restarting...";
      try {
        const r = await API.post("/api/terminals/restart", {});
        toast(r.ok ? (I18N.t("terminal.restart_ok")||"Terminals restarted") : (r.error||I18N.t("errors.generic")));
      } catch (e) {
        toast(I18N.t("errors.generic"));
      } finally {
        tr.disabled = false;
        tr.textContent = "🔄 "+(I18N.t("terminal.restart")||"Restart Terminals");
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
      setBacktestBusy(true);
      S.backtest = { running: true, mode: "backtest", symbol, timeframe, strategy: name };
      headerState();
      try {
        const r = await API.post("/api/backtest", {
          symbol,
          timeframe,
          strategy: { kind: "builtin", name },
        });
        S.backtest = r && typeof r === "object" ? { ...r, running: false, mode: "backtest" } : { ok: false, error: "generic" };
        if (S.snap) S.snap.backtest = S.backtest;
        const box = $("bt-result");
        if (box) box.innerHTML = renderBacktestCard(S.backtest);
        if (!r.ok) toast(r.error || I18N.t("errors.generic"));
        else toast(I18N.t("history.backtest_done"));
      } catch (err) {
        S.backtest = { ok: false, running: false, mode: "backtest", error: err && err.message };
        toast(I18N.t("errors.generic"));
      } finally {
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
    bindTelegramPanel();
    bindSymbolPicker();
    bindUpdatePanel();
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
      if(el) el.textContent = r.ok ? (r.update_available ? 'آپدیت موجود: '+(r.latest?.version||'') : 'به‌روز ✅') : 'خطا: '+(r.error||'');
      const logEl = $("about-changelog");
      if(logEl && r.ok && r.latest){
        logEl.innerHTML = '<b>نسخه '+esc(r.latest.version||'')+'</b><br>'+esc(r.latest.changelog||'')+'<br><br>'+ (r.latest.files||[]).map(f=>'<div style="font-family:monospace;font-size:12px">'+esc(f.path)+'</div>').join('');
      }
    };
    const copy = $("about-copy-ver");
    if(copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(S.version||'1.0.0'); toast('کپی شد: v'+(S.version||'')); } catch {}
    };
    // auto check - async IIFE
    (async () => {
      try {
        const r = await API.get('/api/system/update/state');
        const el = $("about-update-status");
        if(el && r.ok && r.data){
          el.textContent = r.data.update_available ? 'آپدیت موجود: '+(r.data.latest?.version||'') : 'به‌روز ✅ - v'+(S.version||'1.0.0');
        }
        const logEl = $("about-changelog");
        if(logEl){
          if(r.ok && r.data && r.data.latest){
            logEl.innerHTML = '<b>نسخه '+esc(r.data.latest.version||'')+'</b><br>'+esc(r.data.latest.changelog||'')+'';
          } else {
            logEl.innerHTML = '<p>سیستم به‌روز است - v'+esc(S.version||'1.0.0')+'</p><p class="sub">AURION Live Desk - Axiasoft</p>';
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
      const r = await API.post("/api/strategies/toggle", { name, enabled: on });
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
      min_ai_confidence: +($("st-conf")?.value || 0.55),
    });
    if (!quiet) toast(r.ok ? I18N.t("common.save") : r.error);
    await refresh(false);
    return r;
  };
  const save = $("st-ai-save");
  if (save) save.onclick = () => saveAi(false);
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
    const commit = () => saveVol("manual", true);
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
    label.textContent = n
      ? I18N.t("risk.symbols_count", { n })
      : I18N.t("risk.symbols_all_allowed");
  }
  const hidden = $("pr-syms");
  if (hidden) hidden.value = Array.from(SYM_PICK.selected).sort().join(",");
}

async function bindSymbolPicker() {
  const wrap = $("pr-syms-pick");
  if (!wrap || wrap._bound) return;
  wrap._bound = true;
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

function renderBacktestCard(bt) {
  bt = bt || S.backtest || {};
  if (bt.running) return "";
  if (!bt || (!bt.ok && !bt.error && bt.mode !== "backtest")) return `<p class="sub">${I18N.t("history.backtest_empty")}</p>`;
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
    </div>`;
}
function setBacktestBusy(on) {
  const btn = $("h-bt");
  const load = $("bt-load");
  if (btn) {
    btn.disabled = Boolean(on) || !liveSymbols().length;
    btn.textContent = I18N.t(on ? "history.backtest_running" : "history.backtest_run");
  }
  if (load) load.classList.toggle("hidden", !on);
}
function historyRows(rows) {
  // Show all trades (entry + close) so executed trades appear immediately in history
  // P/L and SL/TP are now matched to MT5 via trader fix
  return Array.isArray(rows) ? rows : [];
}
async function loadHistory() {
  const box = $("h-body");
  if (!box) return;
  const r = await API.get("/api/history?limit=400");
  const rows = historyRows(r.data || []);
  if (!rows.length) { box.innerHTML = emptyMini(I18N.t("status.no_history")); return; }
  box.innerHTML = table(rows, ["ts","ticket","symbol","side","volume","price","sl","tp","profit","strategy","comment"]);
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
function applyChartLevels(force) {
  if (!force) {
    if (S._lvlTimer) return;
    S._lvlTimer = setTimeout(() => { S._lvlTimer = null; applyChartLevels(true); }, 140);
    return;
  }
  const symbol = (S.chartFocus && S.chartFocus.symbol) || S.symbol || "";
  const pos = (S.snap?.positions || []).filter((r) => r && (!symbol || r.symbol === symbol));
  if (S.chart && typeof S.chart.setLevels === "function") S.chart.setLevels(pos);
  syncChartPending();
  const box = $("chart-levels");
  if (!box) return;
  const sig = pos.map((r) => `${r.ticket}:${r.sl}:${r.tp}:${r.profit}`).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!pos.length) { box.innerHTML = ""; return; }
  box.innerHTML = pos.map((r) => `<div class="lvl-chip">
      <b>${esc(r.symbol || "")} ${esc(r.type || "")} ${fmt(r.volume, 2)}</b>
      <span class="sl">SL ${r.sl ? fmt(r.sl, 5) : "—"}</span>
      <span class="tp">TP ${r.tp ? fmt(r.tp, 5) : "—"}</span>
      <span class="sub">${esc(strategyLabel(r.strategy))}</span>
      <button class="btn tiny ghost" type="button" data-close="${r.ticket}">${I18N.t("exec.close")}</button>
    </div>`).join("");
  bindCloseButtons(box);
}
function bindChartDesk() {
  const back = $("chart-back");
  if (back) back.onclick = () => closeChartDesk();
  const sigToggle = $("sig-toggle");
  if (sigToggle) sigToggle.onclick = async () => {
    if (!licFeat("chart_signals")) { toast(I18N.t("lic.err_locked")); show("upgrade"); return; }
    S.signalsEnabled = !S.signalsEnabled;
    localStorage.setItem("aurion.signalsEnabled", S.signalsEnabled ? "1" : "0");
    sigToggle.textContent = S.signalsEnabled ? "🔔 Signals ON" : "🔕 Signals OFF";
    sigToggle.classList.toggle("on", S.signalsEnabled);
    sigToggle.classList.toggle("ghost", !S.signalsEnabled);
    const showBtn = $("sig-show");
    if (showBtn) showBtn.style.display = S.signalsEnabled ? "" : "none";
    if (S.signalsEnabled) await fetchChartSignals(S.chartFocus?.symbol, S.chartFocus?.timeframe);
    else { S.chartSignals = []; if (S.chart) S.chart.setSignals([], S.showSignals); }
  };
  const sigShow = $("sig-show");
  if (sigShow) sigShow.onclick = () => {
    S.showSignals = !S.showSignals;
    localStorage.setItem("aurion.showSignals", S.showSignals ? "1" : "0");
    sigShow.textContent = S.showSignals ? "👁️" : "🚫";
    if (S.chart) S.chart.setSignals(S.chartSignals, S.showSignals);
  };
  const cv = $("cv-desk");
  if (!cv || !S.chartFocus) return;
  const key = S.chartFocus.symbol + "." + S.chartFocus.timeframe;
  S.chart = new CandleChart(cv, {
    analyze: true,
    key,
    onPrice: onChartPrice,
    onPending: onChartPending,
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
  applyChartLevels(true);
  bindChartTicket();
  const tools = $("draw-tools");
  if (tools) tools.onclick = (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b || !S.chart) return;
    tools.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x === b));
    S.chart.setTool(b.dataset.tool);
  };
  const undo = $("draw-undo");
  if (undo) undo.onclick = () => S.chart && S.chart.undo();
  const clr = $("draw-clear");
  if (clr) clr.onclick = () => S.chart && S.chart.clearDrawings();
  const mag = $("draw-magnet");
  if (mag) mag.onclick = () => {
    if (!S.chart) return;
    S.chart.setMagnet(!S.chart.magnet);
    mag.classList.toggle("on", S.chart.magnet);
  };
  const zin = $("draw-zin"); if (zin) zin.onclick = () => S.chart && S.chart.zoom(1);
  const zout = $("draw-zout"); if (zout) zout.onclick = () => S.chart && S.chart.zoom(-1);
  const fit = $("draw-fit"); if (fit) fit.onclick = () => S.chart && S.chart.fit();
  const more = $("draw-more");
  const frame = $("draw-frame");
  if (more && frame) more.onclick = () => frame.classList.toggle("open");
  (async () => {
    try {
      await pickMarket(S.chartFocus.symbol, S.chartFocus.timeframe);
      if (S.chart && S.candles.length) S.chart.setBars(S.candles);
      const t = S.snap?.ticks?.[S.chartFocus.symbol];
      if (S.chart && t) S.chart.setTick(t);
      applyChartLevels();
      if (S.signalsEnabled) await fetchChartSignals(S.chartFocus.symbol, S.chartFocus.timeframe);
    } catch { /* empty workspace */ }
  })();
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
    S.snap.ai = msg.data && msg.data.direction !== undefined ? msg.data : (msg.data || msg);
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
    S.snap.last_signal = msg.data || msg;
    scheduleSync();
  }
  if (msg.type === "history") {
    if (S.view === "history") loadHistory();
  }
  if (msg.type === "backtest") {
    const d = msg.data && typeof msg.data === "object" ? msg.data : msg;
    S.backtest = d;
    S.snap = S.snap || {};
    S.snap.backtest = d;
    if (S.view === "history") {
      setBacktestBusy(Boolean(d.running));
      const box = $("bt-result");
      if (box && !d.running) box.innerHTML = renderBacktestCard(d);
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
  await I18N.load(lang);
  if (API.token) {
    const r = await API.post("/api/auth/language", { language: lang });
    if (r.ok && r.data && r.data.token) API.setToken(r.data.token);
  }
  I18N.apply();
  markLangPills();
  const langBtn = $("btn-lang");
  if (langBtn) langBtn.textContent = I18N.lang.toUpperCase();
  if (!$("desk").classList.contains("hidden")) {
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
function paintNotifies() {
  const stack = $("notify-stack");
  const dot = $("bell-dot");
  const notes = (S.notes || []).filter((n) => !n.dismissed);
  if (dot) dot.hidden = !notes.length;
  if (!stack) return;
  if (!notes.length) { stack.hidden = true; stack.innerHTML = ""; return; }
  stack.hidden = false;
  stack.innerHTML = notes.slice(0, 4).map((n) => `<article class="notify-card" data-nid="${esc(n.id)}">
    <button type="button" class="n-x" data-nx="${esc(n.id)}" aria-label="${I18N.t("notify.dismiss")}">×</button>
    <h4>${esc(n.title || "")}</h4><p>${esc(n.body || "")}</p>
  </article>`).join("");
  stack.querySelectorAll(".notify-card").forEach(bindSwipe);
  stack.querySelectorAll("[data-nx]").forEach((b) => {
    b.onclick = () => dismissNote(b.getAttribute("data-nx"));
  });
}
function bindSwipe(card) {
  let x0 = 0, dx = 0, on = false;
  card.onpointerdown = (e) => { on = true; x0 = e.clientX; card.setPointerCapture(e.pointerId); card.classList.add("swiping"); };
  card.onpointermove = (e) => {
    if (!on) return;
    dx = e.clientX - x0;
    card.style.transform = `translateX(${dx}px)`;
    card.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220));
  };
  card.onpointerup = () => {
    on = false;
    card.classList.remove("swiping");
    if (Math.abs(dx) > 88) dismissNote(card.getAttribute("data-nid"));
    else { card.style.transform = ""; card.style.opacity = ""; }
    dx = 0;
  };
}
async function dismissNote(id) {
  if (!id) return;
  await API.post("/api/notify/" + encodeURIComponent(id) + "/dismiss", {});
  S.notes = (S.notes || []).filter((n) => n.id !== id);
  paintNotifies();
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

async function fetchLicense() {
  try {
    const r = await API.get("/api/license");
    if (r && r.ok && r.data) return r.data;
  } catch { /* engine still booting */ }
  return null;
}

function paintGate() {
  const card = $("gate-card");
  if (!card) return;
  I18N.apply(card);
  markLangPills();
  const Lic = S._gateLic;
  const line = $("gate-state");
  if (line) {
    if (Lic && Lic.premium) line.textContent = I18N.t("keygate.state_prem");
    else if (Lic) line.textContent = I18N.t("keygate.state_free");
    else line.textContent = I18N.t("keygate.engine_wait");
  }
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
  // While the gate is up, keep re-checking (engine boot, key activated elsewhere).
  if (S._gateTimer) clearInterval(S._gateTimer);
  S._gateTimer = setInterval(async () => {
    if (!$("auth") || $("auth").classList.contains("hidden")) { clearInterval(S._gateTimer); S._gateTimer = null; return; }
    const next = await fetchLicense();
    if (next) { S._gateLic = next; paintGate(); }
  }, 5000);
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
    ? ["/assets/welcome/mobile.mp4", "/assets/welcome/mobile.webm", "/assets/welcome/intro-mobile.mp4"]
    : ["/assets/welcome/desktop.mp4", "/assets/welcome/desktop.webm", "/assets/welcome/intro-desktop.mp4"];
  return primary.concat(["/assets/welcome/intro.mp4", "/assets/welcome/intro.webm", "/assets/welcome/welcome.mp4"]);
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

async function boot() {
  bindChrome();
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
  // Product-key gate: premium machines skip the key screen entirely and land
  // on the desk; freemium/expired machines always meet the gate first.
  const lic = await fetchLicense();
  S._gateLic = lic;
  if (lic && lic.premium) {
    const welcome = playWelcome();
    const desk = licenseSessionEnter("auto", lic);
    await welcome;
    return desk;
  }
  await playWelcome();
  showGate(lic);
}

boot();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
