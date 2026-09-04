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

  view() {
    if (!this.anchor) {
      const now = new Date();
      this.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
    }
    if (!this.selected) this.selected = this._dayKey(this.anchor);
    const t = (k, v) => I18N.t(k, v);
    const { cells, label } = this.cells(this.anchor);
    const companions = this.CALENDARS.filter((c) => c !== this.system);
    const header = `${this.monthName(this.anchor, this.system)} ${label.y}`;
    const wd = this._weekdayList("short");
    const fw = this.firstWeekday();
    const order = [];
    for (let i = 0; i < 7; i += 1) order.push(wd[(fw + i) % 7]);

    const sess = this.session || {};
    const weekend = sess.state === "weekend";

    return `
    <div class="cal-wrap">
      <div class="cal-bar card">
        <div class="cal-title">
          <div class="cal-h1">${esc(t("calendar.title"))}</div>
          <div class="cal-h2">${esc(t("calendar.hint"))}</div>
        </div>
        <div class="cal-controls">
          <div class="seg" id="cal-sys">
            ${this.CALENDARS.map(
              (c) =>
                `<button type="button" data-sys="${c}" class="${c === this.system ? "on" : ""}">${esc(
                  t(`calendar.${c}`),
                )}</button>`,
            ).join("")}
          </div>
          <div class="cal-nav">
            <button type="button" class="btn sm" id="cal-prev" title="${esc(t("calendar.prev"))}">‹</button>
            <button type="button" class="btn sm" id="cal-today">${esc(t("calendar.today"))}</button>
            <button type="button" class="btn sm" id="cal-next" title="${esc(t("calendar.next"))}">›</button>
          </div>
        </div>
      </div>

      <div class="cal-month-label card">
        <span class="cal-ml-main">${esc(header)}</span>
        <span class="cal-ml-sub">${companions
          .map((c) => `${esc(t(`calendar.${c}`))}: ${esc(this.monthName(this.anchor, c))}`)
          .join(" · ")}</span>
        <span class="cal-ml-count">${esc(t("calendar.month_events", { n: this._monthCount(cells) }))}</span>
      </div>

      <div class="cal-grid card" id="cal-grid">
        <div class="cal-head">
          ${order.map((d, i) => `<div class="cal-hd ${i >= 5 ? "wk" : ""}">${esc(d)}</div>`).join("")}
        </div>
        <div class="cal-body">
          ${cells
            .map((c) => this._cell(c, companions))
            .join("")}
        </div>
      </div>

      <div class="cal-side">
        <div class="card cal-day" id="cal-day">${this._dayPanel(this.selected)}</div>
        <div class="card cal-legend">
          <div class="cal-lg-h">${esc(t("calendar.legend"))}</div>
          ${["high", "medium", "low", "holiday"]
            .map(
              (lv) =>
                `<div class="cal-lg"><span class="dot i-${lv}"></span>${esc(t(`calendar.impact_${lv}`))}</div>`,
            )
            .join("")}
          <div class="cal-lg cal-lg-note">${esc(t("calendar.blackout_note", this.blackout))}</div>
          <div class="cal-lg cal-lg-src">${
            this.source
              ? esc(t("calendar.source_set"))
              : esc(t("calendar.source_missing"))
          }</div>
        </div>
        ${
          weekend
            ? `<div class="card cal-closed"><div class="cal-c-h">${esc(t("calendar.closed"))}</div><div class="cal-c-b">${esc(
                t("calendar.closed_note"),
              )}</div></div>`
            : ""
        }
      </div>
    </div>`;
  },

  _monthCount(cells) {
    let n = 0;
    for (const c of cells) if (c.inMonth) n += (this.byDay.get(this._dayKey(c.ms)) || []).length;
    return n;
  },

  _cell(c, companions) {
    const key = this._dayKey(c.ms);
    const evs = this.byDay.get(key) || [];
    const dow = new Date(c.ms).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const today = key === this._dayKey(Date.now());
    const cls = [
      "cal-cell",
      c.inMonth ? "" : "out",
      isWeekend ? "wk" : "",
      today ? "today" : "",
      key === this.selected ? "sel" : "",
      evs.length ? "has" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const dots = ["high", "medium", "low", "holiday"]
      .filter((lv) => evs.some((e) => e.level === lv))
      .map((lv) => `<span class="dot i-${lv}"></span>`)
      .join("");
    const subs = companions
      .map((sys) => `<span class="cal-sub">${this.parts(c.ms, sys).d}</span>`)
      .join("");
    return `<div class="${cls}" data-day="${key}" tabindex="0" role="button"
        aria-label="${esc(`${c.primary.d} ${this.monthName(c.ms, this.system)}`)}">
      <div class="cal-d">${c.primary.d}</div>
      <div class="cal-subs">${subs}</div>
      <div class="cal-dots">${dots}</div>
      ${isWeekend ? `<div class="cal-wk-tag">${esc(I18N.t("calendar.closed_short"))}</div>` : ""}
    </div>`;
  },

  _dayPanel(key) {
    const t = (k, v) => I18N.t(k, v);
    const evs = (this.byDay.get(key) || []).slice();
    const ms = this._fromDayKey(key);
    const title = Number.isFinite(ms)
      ? this.CALENDARS.map((sys) => {
          const p = this.parts(ms, sys);
          return `<span class="cal-dp-sys"><b>${esc(t(`calendar.${sys}`))}</b> ${esc(
            `${p.d} ${this.monthName(ms, sys)} ${p.y}`,
          )}</span>`;
        }).join("")
      : esc(key);
    const dow = Number.isFinite(ms) ? new Date(ms).getDay() : -1;
    const weekend = dow === 0 || dow === 6;
    return `
      <div class="cal-dp-h">${title}</div>
      ${weekend ? `<div class="cal-dp-wk">${esc(t("calendar.closed_note"))}</div>` : ""}
      ${
        evs.length
          ? `<div class="cal-evs">${evs.map((e) => this._ev(e)).join("")}</div>`
          : `<div class="cal-none">${esc(t("calendar.no_events"))}</div>`
      }`;
  },

  _ev(e) {
    const t = (k, v) => I18N.t(k, v);
    return `<div class="cal-ev i-${e.level}">
      <span class="cal-ev-time">${esc(e.time)}</span>
      <span class="cal-ev-body">
        <span class="cal-ev-t">${esc(e.title || t("calendar.untitled"))}</span>
        <span class="cal-ev-m">
          ${e.currency ? `<span class="cal-ev-ccy">${esc(e.currency)}</span>` : ""}
          <span class="cal-ev-imp">${esc(t(`calendar.impact_${e.level}`))}</span>
        </span>
      </span>
    </div>`;
  },

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
      ? evs
          .map(
            (e) =>
              `<div class="cal-tip-ev"><span class="dot i-${e.level}"></span><b>${esc(e.time)}</b> ${esc(
                e.currency,
              )} — ${esc(e.title || t("calendar.untitled"))}</div>`,
          )
          .join("")
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
    const grid = $$("#cal-grid");
    const day = $$("#cal-day");
    // Reuse one tooltip, parented to <body> so no transformed ancestor can
    // hijack its fixed positioning.
    let tip = document.getElementById("cal-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "cal-tip";
      tip.id = "cal-tip";
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    this.tip = tip;

    $$("#cal-sys")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sys]");
      if (!btn) return;
      this.system = btn.dataset.sys;
      localStorage.setItem("aurion.cal.system", this.system);
      this.rerender();
    });

    const shift = (months) => {
      const p = this.parts(this.anchor, this.system);
      const approx = { jalali: 30.4, hijri: 29.5, gregorian: 30.4 }[this.system] || 30.4;
      // Step by whole months in the primary calendar: land on its 1st, then move.
      let ms = this.anchor;
      for (let i = 0; i < Math.abs(months); i += 1) {
        const cur = this.parts(ms, this.system);
        let y = cur.y;
        let m = cur.m + Math.sign(months);
        if (m > 12) {
          m = 1;
          y += 1;
        } else if (m < 1) {
          m = 12;
          y -= 1;
        }
        // Find the first UTC day whose primary parts equal (y, m, 1).
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
      this.rerender();
    };

    $$("#cal-prev")?.addEventListener("click", () => shift(-1));
    $$("#cal-next")?.addEventListener("click", () => shift(1));
    $$("#cal-today")?.addEventListener("click", () => {
      const now = new Date();
      this.anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
      this.selected = this._dayKey(Date.now());
      this.rerender();
    });

    grid?.addEventListener("click", (e) => {
      const cell = e.target.closest(".cal-cell");
      if (!cell) return;
      this.selected = cell.dataset.day;
      if (day) day.innerHTML = this._dayPanel(this.selected);
      grid.querySelectorAll(".cal-cell.sel").forEach((el) => el.classList.remove("sel"));
      cell.classList.add("sel");
    });

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
      // Prefer below the cell; flip above only when it would overflow, and
      // never let it leave the viewport.
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8;
      tip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
    };
    const hideTip = () => {
      if (tip) tip.hidden = true;
    };
    grid?.addEventListener("mouseover", (e) => {
      const cell = e.target.closest(".cal-cell");
      if (cell) showTip(cell);
    });
    grid?.addEventListener("mouseout", (e) => {
      if (e.target.closest(".cal-cell")) hideTip();
    });
    grid?.addEventListener("focusin", (e) => {
      const cell = e.target.closest(".cal-cell");
      if (cell) showTip(cell);
    });
    grid?.addEventListener("focusout", hideTip);
    grid?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const cell = e.target.closest(".cal-cell");
        if (cell) {
          e.preventDefault();
          cell.click();
        }
      }
    });
  },
};
