/* ============================================================================
 * AURION — economic calendar with three simultaneous calendar systems.
 *
 * Every cell shows the day in the calendar the user picked as primary plus the
 * other two underneath, so Shamsi / Miladi / Qamari are always on screen at
 * once.  News events sit on the day they fall on, coloured by impact, and
 * hovering a day opens a detail panel (what the event is and at what time).
 *
 * Calendar conversion is delegated to Intl (persian / gregory / islamic),
 * which is what the rest of the desk already uses for date formatting, so the
 * three systems can never disagree with the language pack.
 * ========================================================================== */

const Calendar = {
  // Which calendar drives the grid; the other two are shown as companions.
  system: localStorage.getItem("aurion.cal.system") || "jalali",
  /* Month grid or agenda list.
   *
   * A seven-column month is a desktop shape. Measured on the old layout, a
   * 390px phone gave each cell a 30px content box, and into that went a
   * two-digit day, two companion dates (~30px), up to four 7px impact dots
   * (~37px) and an absolutely positioned "Closed" tag over the number. At
   * 320px the content box was 20px. The grid is kept - it is how people
   * think about a month - but a phone opens on the agenda, which answers
   * the question a trader actually has ("what is coming, and when") in a
   * shape that fits a narrow screen.
   *
   * Stored, so the choice survives a reload; the width only decides the
   * first time. */
  mode: localStorage.getItem("aurion.cal.mode") || "",
  anchor: null, // UTC ms of any day inside the displayed month
  events: [], // normalised news rows from GET /api/news
  byDay: new Map(), // "YYYY-MM-DD" -> [event, ...]
  source: "",
  blackout: { before: 15, after: 15 },
  selected: null, // "YYYY-MM-DD"
  session: null, // market session from GET /api/market/session
  tip: null,

  CALENDARS: ["jalali", "gregorian", "hijri"],
  CA_TAG: { jalali: "persian", gregorian: "gregory", hijri: "islamic-umalqura" },

  /* ---------------- intl helpers ---------------- */

  _loc() {
    return { en: "en-GB", fa: "fa-IR", ar: "ar-SA" }[I18N.lang] || "en-GB";
  },

  _fmt(system, opts) {
    // "-nu-latn" is load-bearing: under fa-IR / ar-SA Intl emits Persian and
    // Arabic-Indic digits (۱۴۰۵), and \d in a JS regex only matches ASCII, so
    // every parsed year/month/day came back as 0. Text output (month and
    // weekday names) is still localised; only the numerals are forced Latin.
    const tag = `${this._loc()}-u-ca-${this.CA_TAG[system] || "gregory"}-nu-latn`;
    // No timeZone option on purpose: the calendar has to follow the viewer's
    // own clock.  Pinning UTC made the whole grid a day behind east of
    // Greenwich (Tehran is UTC+3:30, so "today" was still yesterday).
    return new Intl.DateTimeFormat(tag, opts);
  },

  /** {y, m, d} of a UTC instant in the given calendar system. */
  parts(ms, system) {
    const f = this._fmt(system, { year: "numeric", month: "numeric", day: "numeric" });
    const out = { y: 0, m: 1, d: 1 };
    for (const p of f.formatToParts(new Date(ms))) {
      if (p.type === "year") out.y = parseInt(String(p.value).replace(/[^\d-]/g, ""), 10) || 0;
      else if (p.type === "month") out.m = parseInt(p.value, 10) || 1;
      else if (p.type === "day") out.d = parseInt(p.value, 10) || 1;
    }
    return out;
  },

  monthName(ms, system) {
    return this._fmt(system, { month: "long" }).format(new Date(ms));
  },

  weekdayNames() {
    // Long names for the header row, starting on the locale's first weekday.
    const names = this._fmt("gregorian", { weekday: "short" }).formatToParts
      ? this._weekdayList("short")
      : [];
    return names;
  },

  _weekdayList(width) {
    const f = this._fmt("gregorian", { weekday: width });
    const base = new Date(2024, 0, 7); // a Sunday, local
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      out.push(f.format(d));
    }
    return out; // index 0 === Sunday
  },

  firstWeekday() {
    try {
      const info = new Intl.Locale(this._loc()).getWeekInfo?.();
      if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7; // JS: Sun=0
    } catch (_) {
      /* older engines */
    }
    return I18N.lang === "en" ? 1 : 6; // fa/ar: Saturday leads the week
  },

  /* ---------------- data ---------------- */

  async load() {
    try {
      const res = await API.get("/api/news");
      const data = (res && res.data) || {};
      this.source = data.source || "";
      this.blackout = { before: data.blackout_before || 15, after: data.blackout_after || 15 };
      this.events = (data.events || []).map((row) => this._norm(row)).filter(Boolean);
    } catch (_) {
      this.events = [];
    }
    try {
      const res = await API.get("/api/market/session");
      this.session = (res && res.data) || null;
    } catch (_) {
      this.session = null;
    }
    this.byDay = new Map();
    for (const ev of this.events) {
      const list = this.byDay.get(ev.day) || [];
      list.push(ev);
      this.byDay.set(ev.day, list);
    }
    for (const list of this.byDay.values()) {
      list.sort((a, b) => a.ms - b.ms);
    }
  },

  _norm(row) {
    const raw = String(row.time || row.datetime || "").trim();
    if (!raw) return null;
    let ms = Date.parse(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
    if (!Number.isFinite(ms)) ms = NaN;
    // Bucket events by the viewer's local day: a 21:00Z release is the next
    // morning in Tehran and belongs on that day, not the UTC one.
    const day = Number.isFinite(ms) ? this._dayKey(ms) : raw.slice(0, 10);
    const impact = String(row.impact || row.importance || "low").toLowerCase();
    return {
      ms: Number.isFinite(ms) ? ms : 0,
      day,
      time: Number.isFinite(ms)
        ? new Intl.DateTimeFormat(this._loc(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ms))
        : raw,
      currency: String(row.currency || row.ccy || "").toUpperCase(),
      impact: ["high", "red", "3", "holiday", "medium", "orange", "2", "low", "green", "1"].includes(impact) ? impact : "low",
      level: ["high", "red", "3"].includes(impact) ? "high" : ["holiday"].includes(impact) ? "holiday" : ["medium", "orange", "2"].includes(impact) ? "medium" : "low",
      title: String(row.title || row.event || "").trim(),
    };
  },

  /* ---------------- grid ---------------- */

  _dayKey(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  /** Inverse of _dayKey: local noon on that calendar day. */
  _fromDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  },

  /** 42 UTC midnights covering the primary month that contains `anchor`. */
  cells(anchor) {
    const cur = new Date(anchor);
    cur.setHours(12, 0, 0, 0);
    while (this.parts(cur.getTime(), this.system).d !== 1) cur.setDate(cur.getDate() - 1);
    const start = cur.getTime();
    const first = this.parts(start, this.system);
    const lead = (new Date(start).getDay() - this.firstWeekday() + 7) % 7;
    const out = [];
    const step = new Date(start);
    step.setDate(step.getDate() - lead);
    for (let i = 0; i < 42; i += 1) {
      const ms = step.getTime();
      const p = this.parts(ms, this.system);
      out.push({ ms, inMonth: p.m === first.m && p.y === first.y, primary: p });
      step.setDate(step.getDate() + 1);
    }
    return { cells: out, label: first };
  },

  /* ---------------- render ---------------- */

  /** Month grid or agenda. Falls back to the screen's shape the first time. */
  effectiveMode() {
    if (this.mode === "month" || this.mode === "agenda") return this.mode;
    const narrow = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width:760px)").matches
      : false;
    return narrow ? "agenda" : "month";
  },

  view() {
    if (!this.anchor) {
      const now = new Date();
      this.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
    }
    if (!this.selected) this.selected = this._dayKey(this.anchor);
    const t = (k, v) => I18N.t(k, v);
    const { cells, label } = this.cells(this.anchor);
    const companions = this.CALENDARS.filter((c) => c !== this.system);
    const mode = this.effectiveMode();
    const n = this._monthCount(cells);

    return `
    <div class="cal" data-mode="${mode}">
      <header class="cal-top card">
        <div class="cal-top-l">
          <h3 class="cal-month">${esc(this.monthName(this.anchor, this.system))}
            <span class="cal-year">${esc(String(label.y))}</span></h3>
          <p class="cal-alt">${companions
            .map((c) => esc(this.monthName(this.anchor, c)))
            .join(" \u00B7 ")}</p>
        </div>

        <div class="cal-top-r">
          <div class="cal-nav">
            <button type="button" class="cal-arrow" id="cal-prev"
              aria-label="${esc(t("calendar.prev"))}">${this._chevron("start")}</button>
            <button type="button" class="cal-now" id="cal-today">${esc(t("calendar.today"))}</button>
            <button type="button" class="cal-arrow" id="cal-next"
              aria-label="${esc(t("calendar.next"))}">${this._chevron("end")}</button>
          </div>
          <div class="cal-segs">
            <div class="cal-seg" id="cal-mode" role="tablist" aria-label="${esc(t("calendar.view"))}">
              ${[["month", "calendar.view_month"], ["agenda", "calendar.view_agenda"]]
                .map(([m, k]) => `<button type="button" role="tab" data-mode="${m}"
                  aria-selected="${m === mode}" class="${m === mode ? "on" : ""}">${esc(t(k))}</button>`)
                .join("")}
            </div>
            <div class="cal-seg" id="cal-sys" role="tablist" aria-label="${esc(t("calendar.title"))}">
              ${this.CALENDARS.map((c) => `<button type="button" role="tab" data-sys="${c}"
                aria-selected="${c === this.system}" class="${c === this.system ? "on" : ""}">${esc(t(`calendar.${c}`))}</button>`)
                .join("")}
            </div>
          </div>
        </div>
      </header>

      ${this._statusHtml(n)}

      <div class="cal-main">
        <section class="cal-pane card" id="cal-pane">
          ${mode === "agenda" ? this._agenda(cells) : this._grid(cells, companions)}
        </section>
        <aside class="cal-aside">
          <div class="card cal-day" id="cal-day">${this._dayPanel(this.selected)}</div>
          <div class="card cal-legend">
            <h4>${esc(t("calendar.legend"))}</h4>
            <ul>
              ${["high", "medium", "low", "holiday"]
                .map((lv) => `<li><span class="dot i-${lv}"></span>${esc(t(`calendar.impact_${lv}`))}</li>`)
                .join("")}
            </ul>
            <p class="cal-fine">${esc(t("calendar.blackout_note", this.blackout))}</p>
          </div>
        </aside>
      </div>
    </div>`;
  },

  /* Drawn rather than typed: the arrows were the characters U+2039 and
     U+203A, which point the wrong way in a right-to-left layout and are
     missing from several of the fonts the theme engine can select. An
     inline path mirrors with the writing direction and always renders. */
  _chevron(side) {
    const d = side === "start" ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7";
    return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  },

  /** The one-line state of the month: how much news, and whether we trade. */
  _statusHtml(n) {
    const t = (k, v) => I18N.t(k, v);
    const weekend = (this.session || {}).state === "weekend";
    const bits = [`<span class="cal-chip"><b>${esc(String(n))}</b> ${esc(t("calendar.month_events_short"))}</span>`];
    if (weekend) bits.push(`<span class="cal-chip is-closed">${esc(t("calendar.closed"))}</span>`);
    bits.push(`<span class="cal-chip ${this.source ? "is-ok" : "is-warn"}">${
      esc(this.source ? t("calendar.source_set") : t("calendar.source_missing"))}</span>`);
    return `<div class="cal-status">${bits.join("")}</div>`;
  },

  _monthCount(cells) {
    let n = 0;
    for (const c of cells) if (c.inMonth) n += (this.byDay.get(this._dayKey(c.ms)) || []).length;
    return n;
  },

  /* ------------------------------------------------------------- month */

  _grid(cells, companions) {
    const wd = this._weekdayList("short");
    const fw = this.firstWeekday();
    const order = [];
    for (let i = 0; i < 7; i += 1) order.push({ name: wd[(fw + i) % 7], dow: (fw + i) % 7 });
    return `
      <div class="cal-grid" id="cal-grid">
        <div class="cal-head" aria-hidden="true">
          ${order.map((d) => `<span class="cal-hd${d.dow === 0 || d.dow === 6 ? " wk" : ""}">${esc(d.name)}</span>`).join("")}
        </div>
        <div class="cal-body" role="grid">
          ${cells.map((c) => this._cell(c, companions)).join("")}
        </div>
      </div>`;
  },

  _cell(c, companions) {
    const key = this._dayKey(c.ms);
    const evs = this.byDay.get(key) || [];
    const dow = new Date(c.ms).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const today = key === this._dayKey(Date.now());
    const cls = ["cal-cell"];
    if (!c.inMonth) cls.push("out");
    if (isWeekend) cls.push("wk");
    if (today) cls.push("today");
    if (key === this.selected) cls.push("sel");
    if (evs.length) cls.push("has");

    /* At most three, and ordered by what matters. A fourth dot did not fit
       in a phone cell, and "there is news here, some of it high impact" is
       the whole message - the day panel carries the detail. */
    const levels = ["high", "medium", "low", "holiday"].filter((lv) => evs.some((e) => e.level === lv));
    const dots = levels.slice(0, 3).map((lv) => `<i class="dot i-${lv}"></i>`).join("");
    const more = levels.length > 3 ? `<i class="cal-more"></i>` : "";

    /* Companion dates are desktop-only, hidden in CSS rather than dropped
       here, so the same markup serves both and a resize needs no re-render. */
    const subs = companions
      .map((sys) => `<span class="cal-sub" data-sys="${sys}">${this.parts(c.ms, sys).d}</span>`)
      .join("");

    const label = `${c.primary.d} ${this.monthName(c.ms, this.system)}` +
      (evs.length ? ` \u2014 ${I18N.t("calendar.day_events", { n: evs.length })}` : "");
    return `<button type="button" class="${cls.join(" ")}" data-day="${key}"
        role="gridcell" aria-selected="${key === this.selected}" aria-label="${esc(label)}">
      <span class="cal-d">${c.primary.d}</span>
      <span class="cal-subs">${subs}</span>
      <span class="cal-dots">${dots}${more}</span>
    </button>`;
  },

  /* ------------------------------------------------------------ agenda */

  /**
   * Today. Only today.
   *
   * The list used to be every day of the month that carried an event,
   * which on a busy month was forty sections and several screens of
   * scrolling - and the day a trader actually needs was somewhere in the
   * middle of it. The month grid is already the "what is coming" view and
   * it does that better than a list can. The list answers one question:
   * what is on today. Yesterday is over and tomorrow has its own cell.
   *
   * When the month being browsed is not the one today falls in there is
   * nothing to show, so it says so and points at the Today button in the
   * header rather than quietly rendering an empty box.
   */
  _agenda(cells) {
    const t = (k, v) => I18N.t(k, v);
    const todayKey = this._dayKey(Date.now());
    const days = cells
      .filter((c) => c.inMonth)
      .map((c) => ({ c, key: this._dayKey(c.ms), evs: this.byDay.get(this._dayKey(c.ms)) || [] }))
      .filter((d) => d.key === todayKey);
    const away = !days.length;
    if (away || !days[0].evs.length) {
      return `<div class="cal-agenda is-empty">
        <p class="cal-none">${esc(t(away ? "calendar.agenda_away" : "calendar.agenda_none"))}</p>
      </div>`;
    }
    return `<div class="cal-agenda" id="cal-agenda">
      ${days.map(({ c, key, evs }) => {
        const p = c.primary;
        const dow = this._weekdayList("short")[new Date(c.ms).getDay()];
        return `<section class="cal-ag-day${key === todayKey ? " today" : ""}${key === this.selected ? " sel" : ""}"
            data-day="${key}">
          <header class="cal-ag-h">
            <span class="cal-ag-n">${p.d}</span>
            <span class="cal-ag-t"><b>${esc(dow)}</b>
              <small>${esc(this.monthName(c.ms, this.system))}</small></span>
            <span class="cal-ag-c">${esc(t("calendar.day_events", { n: evs.length }))}</span>
          </header>
          <div class="cal-evs">${evs.map((e) => this._ev(e)).join("")}</div>
        </section>`;
      }).join("")}
    </div>`;
  },

  /* -------------------------------------------------------- day detail */

  _dayPanel(key) {
    const t = (k, v) => I18N.t(k, v);
    const evs = (this.byDay.get(key) || []).slice();
    const ms = this._fromDayKey(key);
    const ok = Number.isFinite(ms);
    const dow = ok ? new Date(ms).getDay() : -1;
    const weekend = dow === 0 || dow === 6;
    /* All three systems, always. This is the one place with room for them,
       which is why the grid cell no longer tries to carry them on a phone. */
    const head = ok
      ? `<h4 class="cal-dp-main">${esc(`${this.parts(ms, this.system).d} ${this.monthName(ms, this.system)} ${this.parts(ms, this.system).y}`)}</h4>
         <dl class="cal-dp-sys">
           ${this.CALENDARS.filter((s) => s !== this.system).map((sys) => {
             const p = this.parts(ms, sys);
             return `<div><dt>${esc(t(`calendar.${sys}`))}</dt><dd>${esc(`${p.d} ${this.monthName(ms, sys)} ${p.y}`)}</dd></div>`;
           }).join("")}
         </dl>`
      : `<h4 class="cal-dp-main">${esc(key)}</h4>`;
    return `${head}
      ${weekend ? `<p class="cal-dp-wk">${esc(t("calendar.closed_note"))}</p>` : ""}
      ${evs.length
        ? `<div class="cal-evs">${evs.map((e) => this._ev(e)).join("")}</div>`
        : `<p class="cal-none">${esc(t("calendar.no_events"))}</p>`}`;
  },

  _ev(e) {
    const t = (k, v) => I18N.t(k, v);
    return `<article class="cal-ev i-${e.level}">
      <span class="cal-ev-time">${esc(e.time)}</span>
      <span class="cal-ev-body">
        <span class="cal-ev-t">${esc(e.title || t("calendar.untitled"))}</span>
        <span class="cal-ev-m">
          ${e.currency ? `<span class="cal-ev-ccy">${esc(e.currency)}</span>` : ""}
          <span class="cal-ev-imp">${esc(t(`calendar.impact_${e.level}`))}</span>
        </span>
      </span>
    </article>`;
  },

  /* A quick peek for a mouse, on hover only. It is deliberately NOT shown
     on click any more: clicking already fills the day panel, so a pinned
     card put the same text on screen twice, floating over the grid it was
     describing. Touch devices never see it - they get the panel. */
  _tipFor(key, evs) {
    const t = (k, v) => I18N.t(k, v);
    const ms = this._fromDayKey(key);
    const lines = this.CALENDARS.map((sys) => {
      const p = this.parts(ms, sys);
      return `<div class="cal-tip-sys"><span>${esc(t(`calendar.${sys}`))}</span><b>${esc(
        `${p.d} ${this.monthName(ms, sys)}`,
      )}</b></div>`;
    }).join("");
    const body = evs.length
      ? evs.slice(0, 4).map((e) =>
          `<div class="cal-tip-ev"><span class="dot i-${e.level}"></span><b>${esc(e.time)}</b> ${esc(
            e.currency)} \u2014 ${esc(e.title || t("calendar.untitled"))}</div>`).join("") +
        (evs.length > 4 ? `<div class="cal-tip-none">${esc(t("calendar.day_events", { n: evs.length }))}</div>` : "")
      : `<div class="cal-tip-none">${esc(t("calendar.no_events"))}</div>`;
    return `<div class="cal-tip-h">${esc(t("calendar.day"))}</div>${lines}<div class="cal-tip-sep"></div>${body}`;
  },

  /* ---------------- wiring ---------------- */

  /** Fetch the data, then paint. Safe to call after the shell is on screen. */
  async mount(root) {
    if (!root) return;
    this.root = root;
    await this.load();
    // The user may have navigated away while the fetch was in flight.
    if (!document.body.contains(root)) return;
    root.innerHTML = this.view();
    this.bind(root);
  },

  /** Re-render in place (month change, calendar-system change) without a refetch. */
  rerender() {
    const root = this.root;
    if (!root || !document.body.contains(root)) return;
    root.innerHTML = this.view();
    this.bind(root);
  },

  bind(root) {
    const $$ = (s) => root.querySelector(s);
    const pane = $$("#cal-pane");
    const day = $$("#cal-day");

    /* ------------------------------------------------- the hover peek */
    /* One element, parented to <body> so no transformed ancestor can
       hijack its fixed positioning. Only ever created where a real mouse
       exists: on a touch screen it could be shown but never dismissed. */
    const fine = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(hover:hover) and (pointer:fine)").matches
      : true;
    let tip = document.getElementById("cal-tip");
    if (fine && !tip) {
      tip = document.createElement("div");
      tip.className = "cal-tip";
      tip.id = "cal-tip";
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    this.tip = fine ? tip : null;

    const hideTip = () => { if (tip) tip.hidden = true; };
    /* Kept on the instance: the desk calls it when the view changes, and
       the card lives on <body> so it would otherwise outlive the grid. */
    this.unpin = hideTip;

    const showTip = (cell) => {
      if (!tip) return;
      const key = cell.dataset.day;
      tip.innerHTML = this._tipFor(key, this.byDay.get(key) || []);
      tip.hidden = false;
      const r = cell.getBoundingClientRect();
      const w = Math.min(tip.offsetWidth || 260, window.innerWidth - 16);
      const h = tip.offsetHeight || 160;
      tip.style.maxWidth = `${window.innerWidth - 16}px`;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      tip.style.left = `${Math.max(8, left)}px`;
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
    };

    /* ------------------------------------------------------ selection */

    /* CSS.escape is not in every engine the desk runs on, and a bare `CSS`
       reference throws rather than reading undefined. Day keys are
       YYYY-MM-DD, so the fallback only has to refuse anything else. */
    const esckey = (k) => (typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(k)
      : String(k).replace(/[^0-9-]/g, ""));

    const select = (key, opts) => {
      if (!key) return;
      this.selected = key;
      if (day) day.innerHTML = this._dayPanel(key);
      root.querySelectorAll("[data-day].sel").forEach((el) => {
        el.classList.remove("sel");
        if (el.hasAttribute("aria-selected")) el.setAttribute("aria-selected", "false");
      });
      root.querySelectorAll(`[data-day="${esckey(key)}"]`)
        .forEach((el) => {
          el.classList.add("sel");
          if (el.hasAttribute("aria-selected")) el.setAttribute("aria-selected", "true");
        });
      /* On a phone the day panel is below the grid, so a tap that changed
         it off-screen looked like nothing happened. */
      if (opts && opts.reveal && day && typeof day.scrollIntoView === "function") {
        const stacked = window.matchMedia && window.matchMedia("(max-width:1100px)").matches;
        if (stacked) {
          try { day.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) { /* older engines */ }
        }
      }
    };

    /* ------------------------------------------------------- controls */

    $$("#cal-sys")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sys]");
      if (!btn) return;
      this.system = btn.dataset.sys;
      try { localStorage.setItem("aurion.cal.system", this.system); } catch (_) { /* private mode */ }
      this.rerender();
    });

    $$("#cal-mode")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      this.mode = btn.dataset.mode;
      try { localStorage.setItem("aurion.cal.mode", this.mode); } catch (_) { /* private mode */ }
      hideTip();
      this.rerender();
    });

    const shift = (months) => {
      const approx = { jalali: 30.4, hijri: 29.5, gregorian: 30.4 }[this.system] || 30.4;
      // Step by whole months in the primary calendar: land on its 1st, then move.
      let ms = this.anchor;
      for (let i = 0; i < Math.abs(months); i += 1) {
        const cur = this.parts(ms, this.system);
        let y = cur.y;
        let m = cur.m + Math.sign(months);
        if (m > 12) { m = 1; y += 1; } else if (m < 1) { m = 12; y -= 1; }
        // Find the first day whose primary parts equal (y, m, 1).
        const probeDate = new Date(ms);
        probeDate.setDate(probeDate.getDate() + Math.sign(months) * Math.round(approx));
        let probe = probeDate.getTime();
        for (let k = 0; k < 40; k += 1) {
          const q = this.parts(probe, this.system);
          if (q.y === y && q.m === m && q.d === 1) break;
          const pd = new Date(probe);
          pd.setDate(pd.getDate() + (q.y < y || (q.y === y && q.m < m) ? 1 : -1));
          probe = pd.getTime();
        }
        ms = probe;
      }
      this.anchor = ms;
      this.selected = this._dayKey(ms);
      hideTip();
      this.rerender();
    };

    $$("#cal-prev")?.addEventListener("click", () => shift(-1));
    $$("#cal-next")?.addEventListener("click", () => shift(1));
    $$("#cal-today")?.addEventListener("click", () => {
      const now = new Date();
      this.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
      this.selected = this._dayKey(Date.now());
      hideTip();
      this.rerender();
    });

    /* -------------------------------------------------------- the pane */

    /* One listener for both layouts: a grid cell and an agenda day both
       carry data-day, so selecting works the same in either. */
    pane?.addEventListener("click", (e) => {
      const el = e.target.closest("[data-day]");
      if (!el || !pane.contains(el)) return;
      select(el.dataset.day, { reveal: true });
    });

    /* The cells are real buttons now, so Enter and Space already activate
       them. Arrow keys are what a grid still has to add. */
    pane?.addEventListener("keydown", (e) => {
      const cell = e.target.closest(".cal-cell");
      if (!cell) return;
      const STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      let step = STEP[e.key];
      if (step === undefined) return;
      // Left and right follow the reading direction, not the screen.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          document.documentElement.getAttribute("dir") === "rtl") step = -step;
      e.preventDefault();
      const all = [...pane.querySelectorAll(".cal-cell")];
      const i = all.indexOf(cell);
      const next = all[i + step];
      if (!next) return;
      next.focus();
      select(next.dataset.day);
    });

    if (fine) {
      pane?.addEventListener("mouseover", (e) => {
        const cell = e.target.closest(".cal-cell");
        if (cell && pane.contains(cell)) showTip(cell);
      });
      pane?.addEventListener("mouseleave", hideTip);
      pane?.addEventListener("focusin", (e) => {
        const cell = e.target.closest(".cal-cell");
        if (cell) showTip(cell);
      });
      pane?.addEventListener("focusout", hideTip);
      // Scrolling moves the grid out from under a fixed-position card.
      window.addEventListener("scroll", hideTip, { passive: true, capture: true });
    }

    /* The card lives on <body>, so it has to remove itself if the pane it
       describes ever leaves the document. */
    if (typeof MutationObserver !== "undefined" && pane && tip) {
      const watcher = new MutationObserver(() => {
        if (!document.body.contains(pane)) {
          hideTip();
          watcher.disconnect();
        }
      });
      watcher.observe(document.body, { childList: true, subtree: true });
    }
  },
};
