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
  /* The month grid, and only the month grid.
   *
   * There used to be a second "list" mode, and a view switch to reach it.
   * It existed because the seven-column grid did not survive a phone: at
   * 390px each cell had a 30px content box holding a two-digit day, two
   * companion dates and up to four impact dots. That is fixed - the
   * companion dates moved into the day panel and the cells are ~48px at
   * 390px now - so the list was answering a question the grid had stopped
   * asking badly, while costing a mode, a stored preference, a second
   * empty state and a whole parallel layout to keep in step.
   *
   * One shape, every width. */
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

  /* A number in the reader's own digits. The desk writes Persian and
     Arabic-Indic numerals everywhere else; "15 دقیقه قبل" with a Latin
     15 in it is half-translated, which reads worse than either. */
  _num(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    try { return new Intl.NumberFormat(this._loc(), { useGrouping: false }).format(v); }
    catch (_) { return String(v); }
  },

  /** A clock time in the reader's locale, from the instant itself. */
  _clock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    try { return new Intl.DateTimeFormat(this._loc(), { hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); }
    catch (_) { return ""; }
  },

  /**
   * "15 minutes" in whichever language, counted correctly.
   *
   * Arabic does not have one plural: 3-10 take دقائق and 11 upwards take
   * دقيقة, so "5 دقيقة" is wrong in exactly the place a lead time of five
   * minutes puts it. Intl knows the rule for every language the desk
   * speaks; the pack supplies whichever forms its language actually
   * needs and the rest fall back to the common one.
   */
  _mins(n) {
    const v = Math.max(1, Math.round(Number(n) || 0));
    let cat = "other";
    try { cat = new Intl.PluralRules(this._loc()).select(v); } catch (_) { cat = "other"; }
    const special = `calendar.remind_mins_${cat}`;
    const key = (I18N.has && I18N.has(special)) ? special : "calendar.remind_mins";
    return I18N.t(key, { n: this._num(v) });
  },

  /**
   * The name of an economic release, in the reader's language.
   *
   * The feed speaks English and only English - "Core CPI m/m", "Non-Farm
   * Employment Change" - so a Persian desk was announcing its reminders
   * in English regardless of how well the panel around them was
   * translated. The releases that matter are a short, stable list, so
   * they are named in the language packs and matched here.
   *
   * An event that is not on the list keeps the source's own words: a
   * wrong translation of a release you are about to trade is worse than
   * an untranslated one, and silence is not an option either.
   */
  NEWS_TERMS: [
    /* ADP first: its own release is called "ADP Non-Farm Employment
       Change", and matched against the payrolls pattern it came out
       announcing itself as the monthly US payrolls report, which is a
       different number published on a different day. */
    [/\badp\b/, "adp"],
    [/\bnon[- ]?farm|\bnfp\b/, "nfp"],
    [/\bunemployment (rate|claims)|\bjobless claims/, "jobless"],
    [/\bemployment change|\bjob (gains|growth)|\bpayrolls/, "employment"],
    [/\bcore (cpi|consumer price)/, "core_cpi"],
    [/\bcpi\b|\bconsumer price/, "cpi"],
    [/\bcore ppi|\bppi\b|\bproducer price/, "ppi"],
    [/\bgdp\b|\bgross domestic/, "gdp"],
    [/\b(interest )?rate (decision|statement)|\bmonetary policy (statement|decision)|\bbank rate/, "rate"],
    [/\bfomc (meeting )?minutes|\bmeeting minutes/, "minutes"],
    [/\bpress conference/, "presser"],
    [/\bspeaks\b|\bspeech\b|\btestifies|\btestimony/, "speech"],
    [/\bretail sales/, "retail"],
    [/\bmanufacturing pmi|\bism manufacturing/, "pmi_mfg"],
    [/\bservices pmi|\bism services|\bnon[- ]manufacturing pmi/, "pmi_svc"],
    [/\bpmi\b/, "pmi"],
    [/\bcrude oil inventories|\boil stocks/, "oil"],
    [/\btrade balance/, "trade"],
    [/\bconsumer (confidence|sentiment)/, "confidence"],
    [/\bdurable goods/, "durables"],
    [/\b(building permits|housing starts)/, "housing"],
    [/\bindustrial production/, "industrial"],
    [/\b(average )?(hourly )?(earnings|wages)/, "wages"],
    [/\bbank holiday|\bholiday\b/, "holiday"],
  ],
  NEWS_PERIODS: [[/\bm\/m\b|\bmonth[- ]over[- ]month\b/, "mm"], [/\by\/y\b|\byear[- ]over[- ]year\b/, "yy"], [/\bq\/q\b|\bquarter[- ]over[- ]quarter\b/, "qq"]],

  newsTitle(title) {
    const raw = String(title || "").trim();
    if (!raw) return I18N.t("calendar.untitled");
    if (I18N.lang === "en") return raw;
    const low = raw.toLowerCase();
    let name = "";
    for (const [re, slug] of this.NEWS_TERMS) {
      if (!re.test(low)) continue;
      const key = `news.${slug}`;
      if (I18N.has && !I18N.has(key)) break;
      name = I18N.t(key);
      break;
    }
    if (!name) return raw;
    for (const [re, slug] of this.NEWS_PERIODS) {
      if (re.test(low) && (!I18N.has || I18N.has(`news.${slug}`))) return `${name} (${I18N.t(`news.${slug}`)})`;
    }
    return name;
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
      /* Kept rather than discarded. The engine already reports whether
         the week it served came off the network or out of the cache and
         why a fetch failed; the desk threw all of it away, which is how
         a calendar that had not updated for a fortnight looked exactly
         like one that had. */
      this.feed = (data.feed && typeof data.feed === "object") ? data.feed : null;
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
    const n = this._monthCount(cells);

    return `
    <div class="cal">
      <header class="cal-top card">
        <div class="cal-top-l">
          <h3 class="cal-month">${esc(this.monthName(this.anchor, this.system))}
            <span class="cal-year">${esc(this._num(label.y))}</span></h3>
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
          ${this._grid(cells, companions)}
        </section>
        <aside class="cal-aside">
          <div class="card cal-day" id="cal-day">${this._dayPanel(this.selected)}</div>
          ${this._remindHtml()}
          <div class="card cal-legend">
            <h4>${esc(t("calendar.legend"))}</h4>
            <ul>
              ${["high", "medium", "low", "holiday"]
                .map((lv) => `<li><span class="dot i-${lv}"></span>${esc(t(`calendar.impact_${lv}`))}</li>`)
                .join("")}
            </ul>
            <p class="cal-fine">${esc(t("calendar.blackout_note", {
              before: this._num(this.blackout.before), after: this._num(this.blackout.after),
            }))}</p>
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
    const bits = [`<span class="cal-chip"><b>${esc(this._num(n))}</b> ${esc(t("calendar.month_events_short"))}</span>`];
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
      .map((sys) => `<span class="cal-sub" data-sys="${sys}">${this._num(this.parts(c.ms, sys).d)}</span>`)
      .join("");

    const label = `${this._num(c.primary.d)} ${this.monthName(c.ms, this.system)}` +
      (evs.length ? ` \u2014 ${I18N.t("calendar.day_events", { n: this._num(evs.length) })}` : "");
    return `<button type="button" class="${cls.join(" ")}" data-day="${key}"
        role="gridcell" aria-selected="${key === this.selected}" aria-label="${esc(label)}">
      <span class="cal-d">${this._num(c.primary.d)}</span>
      <span class="cal-subs">${subs}</span>
      <span class="cal-dots">${dots}${more}</span>
    </button>`;
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
      ? `<h4 class="cal-dp-main">${esc(`${this._num(this.parts(ms, this.system).d)} ${this.monthName(ms, this.system)} ${this._num(this.parts(ms, this.system).y)}`)}</h4>
         <dl class="cal-dp-sys">
           ${this.CALENDARS.filter((s) => s !== this.system).map((sys) => {
             const p = this.parts(ms, sys);
             return `<div><dt>${esc(t(`calendar.${sys}`))}</dt><dd>${esc(`${this._num(p.d)} ${this.monthName(ms, sys)} ${this._num(p.y)}`)}</dd></div>`;
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
        <span class="cal-ev-t">${esc(this.newsTitle(e.title))}</span>
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
            e.currency)} \u2014 ${esc(this.newsTitle(e.title))}</div>`).join("") +
        (evs.length > 4 ? `<div class="cal-tip-none">${esc(t("calendar.day_events", { n: this._num(evs.length) }))}</div>` : "")
      : `<div class="cal-tip-none">${esc(t("calendar.no_events"))}</div>`;
    return `<div class="cal-tip-h">${esc(t("calendar.day"))}</div>${lines}<div class="cal-tip-sep"></div>${body}`;
  },

  /** The reminder's one control panel: on, how early, how important. */
  _remindHtml() {
    const t = (k, v) => I18N.t(k, v);
    const p = this.remindPrefs();
    const sw = typeof switchHtml === "function"
      ? switchHtml({ id: "cal-remind", on: p.on, label: t("calendar.remind_title") })
      : `<button type="button" class="switch${p.on ? " on" : ""}" id="cal-remind"
          aria-pressed="${p.on}" aria-label="${esc(t("calendar.remind_title"))}"><i></i></button>`;
    const opt = (v, label, cur) => `<option value="${esc(String(v))}"${String(v) === String(cur) ? " selected" : ""}>${esc(label)}</option>`;
    return `
      <div class="card cal-remind${p.on ? " is-on" : ""}" id="cal-remind-card">
        <div class="cal-remind-head">
          <h4 id="cal-remind-label">${esc(t("calendar.remind_title"))}</h4>
          ${sw}
        </div>
        <p class="sub">${esc(t("calendar.remind_sub"))}</p>
        <div class="cal-remind-opts">
          <label class="cal-remind-opt">
            <span>${esc(t("calendar.remind_lead"))}</span>
            <select class="ctrl" id="cal-remind-lead" ${p.on ? "" : "disabled"}>
              ${this.LEADS.map((m) => opt(m, t("calendar.remind_lead_opt", { mins: this._mins(m) }), p.lead)).join("")}
            </select>
          </label>
          <label class="cal-remind-opt">
            <span>${esc(t("calendar.remind_level"))}</span>
            <select class="ctrl" id="cal-remind-level" ${p.on ? "" : "disabled"}>
              ${opt("high", t("calendar.remind_high"), p.level)}
              ${opt("medium", t("calendar.remind_medium"), p.level)}
              ${opt("all", t("calendar.remind_all"), p.level)}
            </select>
          </label>
        </div>
      </div>`;
  },

  /** Wire that panel. Called from bind(), so it survives every rerender. */
  _bindRemind(root) {
    const card = root.querySelector("#cal-remind-card");
    if (!card) return;
    const sw = card.querySelector("#cal-remind");
    const lead = card.querySelector("#cal-remind-lead");
    const level = card.querySelector("#cal-remind-level");
    const paint = (on) => {
      card.classList.toggle("is-on", on);
      if (sw) { sw.classList.toggle("on", on); sw.setAttribute("aria-pressed", String(on)); }
      if (lead) lead.disabled = !on;
      if (level) level.disabled = !on;
    };
    if (sw) sw.onclick = () => {
      const on = !this.remindPrefs().on;
      this.saveRemindPrefs({ on });
      paint(on);
      /* Off means the timer stops, not that the sound is suppressed. */
      if (on) this.startReminder(); else this.stopReminder();
      this._remindSay(I18N.t(on ? "calendar.remind_on" : "calendar.remind_off"));
    };
    if (lead) lead.onchange = () => this.saveRemindPrefs({ lead: Number(lead.value) });
    if (level) level.onchange = () => this.saveRemindPrefs({ level: level.value });
    /* The desk portals its own dropdowns; a native select inside a card
       would be the only one on screen that looks different. */
    try { if (typeof enhanceSelects === "function") enhanceSelects(card); } catch (_) { /* */ }
  },

  /* ---------------- the news reminder ----------------
   *
   * Asked for: something that tells you a release is coming, that can be
   * turned off, and that does nothing else.
   *
   * So that is all it is. It raises the desk's ordinary notification a
   * set number of minutes before an event on the calendar and stops
   * there - it never touches the robot, never closes anything, never
   * changes a setting. A reminder that could act on the market would be
   * a trading feature wearing a bell, and this one is not allowed to
   * become that.
   *
   * Off is a real off: the switch stops the timer, not just the sound.
   * The choice lives in this browser, like the other desk preferences,
   * because it is about who is sitting in front of the screen.
   */
  REMIND_KEY: "aurion.cal.remind",
  REMIND_SEEN_KEY: "aurion.cal.remind.seen",
  REMIND_DEFAULTS: { on: true, lead: 15, level: "high" },
  LEADS: [5, 15, 30, 60],
  LEVELS: ["high", "medium", "all"],

  remindPrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(this.REMIND_KEY) || "{}") || {}; } catch (_) { saved = {}; }
    const out = { ...this.REMIND_DEFAULTS, ...(typeof saved === "object" ? saved : {}) };
    out.on = out.on !== false;
    out.lead = this.LEADS.includes(Number(out.lead)) ? Number(out.lead) : this.REMIND_DEFAULTS.lead;
    out.level = this.LEVELS.includes(out.level) ? out.level : this.REMIND_DEFAULTS.level;
    return out;
  },

  saveRemindPrefs(patch) {
    const next = { ...this.remindPrefs(), ...(patch || {}) };
    try { localStorage.setItem(this.REMIND_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
    return next;
  },

  /** Does this event clear the bar the user set? */
  _remindWanted(ev, level) {
    if (!ev || ev.level === "holiday") return false;
    /* Everything means everything the source listed as news, including
       a row whose impact it did not grade - the one exception being a
       market holiday, which is a closed day, not a release. */
    if (level === "all") return true;
    if (level === "medium") return ev.level === "high" || ev.level === "medium";
    return ev.level === "high";
  },

  /* Announced events are remembered across reloads, or a desk left open
     over a release would re-announce it on every refresh. Keyed by the
     event itself rather than by an index, and pruned to the last two
     days so the list cannot grow without end. */
  _remindSeen() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.REMIND_SEEN_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch (_) { return {}; }
  },

  /**
   * Remember that this event has been announced.
   *
   * `atMs` is when it was announced, not when the release is due, and
   * it comes from the same clock the scan ran on. Both halves of that
   * sentence were wrong and the pair of them made the ledger unsound:
   * the stored value was the event's own timestamp, and the pruning
   * floor was read from Date.now() while the decision to announce was
   * made against the `now` handed to remindTick. Two clocks for one
   * question. Anything whose event time happened to sit outside the
   * two-day window of the other clock was deleted the instant it was
   * written, so it was announced again on the very next pass - a
   * release every thirty seconds until it had gone by.
   *
   * One clock, and it measures the right thing: the ledger is a record
   * of what this desk has already said, so it is dated by when it said
   * it.
   */
  _remindMark(id, atMs) {
    const seen = this._remindSeen();
    const now = Number.isFinite(atMs) ? atMs : Date.now();
    seen[id] = now;
    const floor = now - 2 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(seen)) if (!(Number(seen[k]) > floor)) delete seen[k];
    try { localStorage.setItem(this.REMIND_SEEN_KEY, JSON.stringify(seen)); } catch (_) { /* */ }
  },

  _evId(ev) {
    return [ev.day, ev.time, ev.currency, ev.title].join("|");
  },

  REMIND_WARNED_KEY: "aurion.cal.remind.warned",

  /**
   * Say so when there is nothing left to remind anyone about.
   *
   * The reminder reported as "it did not work" had two faults that
   * stopped it and one that hid them. This is the one that hid them:
   * the engine serves the last good week from cache when the feed
   * cannot be reached, which is the right call - a stale calendar
   * beats a blank one - but the desk dropped the cache flag, so a
   * calendar whose newest release was eight days in the past looked
   * identical to a live one. The reminder then sat there with nothing
   * in its window, correctly silent, and indistinguishable from
   * broken.
   *
   * Said at most once a day, because it is a condition rather than an
   * event and a toast every thirty seconds is its own fault.
   */
  _remindStale(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const events = this.events || [];
    if (!events.length) return false;
    const ahead = events.some((ev) => ev && Number.isFinite(ev.ms) && ev.ms > now);
    if (ahead) return false;
    let last = 0;
    try { last = Number(localStorage.getItem(this.REMIND_WARNED_KEY) || 0) || 0; } catch (_) { last = 0; }
    if (last && now - last < 24 * 60 * 60 * 1000 && now >= last) return false;
    try { localStorage.setItem(this.REMIND_WARNED_KEY, String(now)); } catch (_) { /* private mode */ }
    this._remindSay(I18N.t("calendar.remind_stale"));
    return true;
  },

  /** One pass over the loaded events. Pure read; announces at most a few. */
  remindTick(nowMs) {
    const prefs = this.remindPrefs();
    if (!prefs.on) return [];
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const until = now + prefs.lead * 60 * 1000;
    const seen = this._remindSeen();
    const due = [];
    for (const ev of this.events || []) {
      if (!ev || !Number.isFinite(ev.ms) || ev.ms <= 0) continue;
      if (ev.ms <= now || ev.ms > until) continue;
      if (!this._remindWanted(ev, prefs.level)) continue;
      const id = this._evId(ev);
      if (seen[id]) continue;
      due.push(ev);
    }
    /* Three at once is a notification; ten is a wall of toasts that
       hides the desk. A release window with more than three events
       announces the three nearest and says how many others there are. */
    const show = due.slice(0, 3);
    for (const ev of show) this._remindAnnounce(ev, now);
    for (const ev of due) this._remindMark(this._evId(ev), now);
    if (due.length > show.length) this._remindSay(I18N.t("calendar.remind_more", { n: this._num(due.length - show.length) }));
    return due;
  },

  _remindAnnounce(ev, now) {
    const mins = Math.max(1, Math.round((ev.ms - now) / 60000));
    /* Every part of this sentence is translated, including the name of
       the release and the digits in it. The currency code stays Latin
       on purpose - USD is the instrument's name, not a word. */
    const what = this.newsTitle(ev.title);
    const text = I18N.t("calendar.remind_toast", {
      what: (ev.currency ? ev.currency + " " : "") + what,
      mins: this._mins(mins),
      time: this._clock(ev.ms) || ev.time || "",
    });
    this._remindSay(text);
    /* The desktop host owns the Windows notification; told the same
       thing, flagged as news so it can never be mistaken for a signal. */
    try {
      const bridge = window.chrome && window.chrome.webview;
      if (bridge && typeof bridge.postMessage === "function") {
        bridge.postMessage(JSON.stringify({ type: "news", title: I18N.t("calendar.remind_title"), body: text }));
      }
    } catch (_) { /* no host: the in-desk toast is the whole reminder */ }
  },

  _remindSay(text) {
    try { if (typeof toast === "function") toast(text); } catch (_) { /* */ }
  },

  /**
   * Keep the reminder running while the desk is open.
   *
   * The calendar view loads the events when it is opened; this must work
   * when it never is, so it fetches them itself on a slow timer. Started
   * once from boot and idempotent.
   */
  startReminder() {
    if (this._remindTimer) return;
    const tick = async () => {
      const prefs = this.remindPrefs();
      if (!prefs.on) return;
      /* Only when the calendar is not on screen - the view keeps its own
         copy fresh, and a refetch underneath it would be wasted. */
      const stale = !this._remindFetched || Date.now() - this._remindFetched > 10 * 60 * 1000;
      if (stale && !(this.root && document.body.contains(this.root))) {
        this._remindFetched = Date.now();
        try { await this.load(); } catch (_) { /* offline: try again next pass */ }
      }
      const now = Date.now();
      /* Order matters: announce what is due first, and only complain
         about a stale calendar when nothing was. */
      if (!this.remindTick(now).length) this._remindStale(now);
    };
    this._remindTimer = setInterval(tick, 30000);
    setTimeout(tick, 4000);
  },

  stopReminder() {
    if (this._remindTimer) { clearInterval(this._remindTimer); this._remindTimer = 0; }
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

    this._bindRemind(root);

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

    /* Grid cells carry data-day; one delegated listener selects any
       of them. */
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
