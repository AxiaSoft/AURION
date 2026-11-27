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
  /* Which attached instrument a date opens on the chart, when the desk
     has more than one. Empty means "whatever the desk is showing" -
     see calendarChartSymbol. Remembered across days, because a trader
     reads one instrument through a month. */
  chartSymbol: "",
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

  /* ---- the week, kept on disk ------------------------------------
   *
   * Reported: "every time I leave the calendar and come back it loads
   * again". It did - mount() awaited load() unconditionally, so two
   * requests went out and the grid stayed empty until they came back,
   * on every single visit, for a week of events that changes a few
   * times a day.
   *
   * So the week is written to localStorage, which is this machine's
   * disk, and that copy is what the page opens with. A refresh still
   * happens when the copy is older than REFRESH_MS, but it happens
   * BEHIND the painted grid and only re-renders if something actually
   * changed. And the first one of all is done at boot, before the
   * desk is on screen, which is what "load it before the app comes
   * up" asks for.
   */
  CACHE_KEY: "aurion.cal.week",
  REFRESH_MS: 20 * 60 * 1000,

  _readCache() {
    try {
      const raw = localStorage.getItem(this.CACHE_KEY);
      if (!raw) return null;
      const box = JSON.parse(raw);
      if (!box || !Array.isArray(box.events)) return null;
      return box;
    } catch (_) { return null; }
  },

  _writeCache() {
    try {
      localStorage.setItem(this.CACHE_KEY, JSON.stringify({
        at: Date.now(),
        source: this.source || "",
        feed: this.feed || null,
        blackout: this.blackout || null,
        session: this.session || null,
        events: this.events || [],
      }));
    } catch (_) { /* private mode, or a quota: the desk still works */ }
  },

  /** Put the stored week in place without a request. True if there was one. */
  _useCache() {
    const box = this._readCache();
    if (!box) return false;
    this.source = box.source || this.source || "";
    this.feed = box.feed || this.feed || null;
    if (box.blackout) this.blackout = box.blackout;
    if (box.session) this.session = box.session;
    this.events = box.events || [];
    this._cachedAt = Number(box.at) || 0;
    this._index();
    return true;
  },

  /** Is the copy on disk old enough to be worth replacing? */
  _stale() {
    return !this._cachedAt || (Date.now() - this._cachedAt) > this.REFRESH_MS;
  },

  /**
   * Fill the calendar before anything asks to see it.
   *
   * Called once from boot. It serves the stored week instantly and
   * only reaches the network when that week is old - so the ordinary
   * start-up costs nothing, and the unusual one is paid before the
   * desk is on screen rather than in front of a trader waiting for a
   * grid to appear.
   */
  async warm() {
    if (this._warmed) return;
    this._warmed = true;
    const had = this._useCache();
    if (!had || this._stale()) {
      try { await this.load(); } catch (_) { /* offline: the cache stands */ }
    }
  },

  /** Group the events by day. Pure: no request, no paint. */
  _index() {
    this.byDay = new Map();
    for (const ev of this.events) {
      const list = this.byDay.get(ev.day) || [];
      list.push(ev);
      this.byDay.set(ev.day, list);
    }
    for (const list of this.byDay.values()) list.sort((a, b) => a.ms - b.ms);
  },

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
    this._index();
    /* Only a week that was actually served is written down. An empty
       list from an offline desk must not replace a good copy on disk
       with nothing - that would turn one failed request into a
       calendar that is empty until the next successful one. */
    if (this.events.length) {
      this._cachedAt = Date.now();
      this._writeCache();
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

  /** Midnight at the start of that calendar day, local time. */
  _dayStart(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
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
          <!-- How much news this month, said beside the month's name.
               It was a chip on a strip of its own below the header,
               which is a second row of furniture for one number that
               belongs to the title it describes. -->
          <span class="cal-chip cal-count">
            <b>${esc(this._num(n))}</b> ${esc(t("calendar.month_events_short"))}</span>
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

      ${this._statusHtml()}

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

  /* The same cross the rest of the desk uses, drawn here because
     calendar.js has no access to app.js's icon(). Two lines rather
     than a glyph, for the reason the chevron above is drawn: a
     character would depend on whichever font the theme engine
     selected. */
  _cross() {
    return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
  },

  /** Anything about this month worth saying, or nothing at all.
   *
   * Two chips were dropped from here, for two different reasons.
   *
   * The count of the month's events moved up into the header: it
   * describes the month whose name is written there, and giving it a
   * strip of its own put a second row of furniture on the page for one
   * number.
   *
   * "Calendar source is active" was deleted outright. A chip that only
   * ever says a healthy default is healthy is noise on every desk that
   * is working, which is all of them - the source being MISSING is the
   * only state worth a line, and that one stays.
   *
   * When neither chip applies this renders nothing, rather than an
   * empty strip holding the space where a chip would have been.
   */
  _statusHtml() {
    const t = (k, v) => I18N.t(k, v);
    const bits = [];
    if ((this.session || {}).state === "weekend") {
      bits.push(`<span class="cal-chip is-closed">${esc(t("calendar.closed"))}</span>`);
    }
    if (!this.source) {
      bits.push(`<span class="cal-chip is-warn">${esc(t("calendar.source_missing"))}</span>`);
    }
    if (!bits.length) return "";
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

  _dayPanel(key, peek) {
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
      ${peek ? `<p class="cal-dp-peek">${esc(t("calendar.peek_hint"))}</p>` : ""}
      ${weekend && !evs.length ? `<p class="cal-dp-wk">${esc(t("calendar.closed_note"))}</p>` : ""}
      ${this._chartBtn(key, evs)}
      ${evs.length
        ? `<div class="cal-evs">${evs.map((e) => this._ev(e, weekend)).join("")}</div>`
        : `<p class="cal-none">${esc(t("calendar.no_events"))}</p>`}`;
  },

  /* "Show me that day on the chart."
   *
   * Reading a release and then going to find the candle it happened on
   * meant leaving the calendar, opening the chart, and dragging back
   * through however many months - which nobody does, so the two halves
   * of the same question were never actually put together. The button
   * takes the day the panel is showing straight to the EA chart for the
   * instrument that is already selected, loads whatever history is
   * needed to reach it, and marks the moment.
   *
   * Only offered when there is a chart to go to: without an expert
   * attached there is no candle to land on, and a button that explains
   * itself by failing is worse than no button. */
  _chartBtn(key, evs) {
    let ms = this._chartMoment(key, evs);
    if (!Number.isFinite(ms) || ms <= 0) return "";
    if (typeof calendarChartSymbol !== "function" || !calendarChartSymbol()) return "";

    /* A day that has not happened has no candles in it.
       The calendar lists releases weeks ahead - that is most of what it
       is for - so the offer appeared on dates the market has not traded
       yet, and pressing it could only ever end in "your terminal does
       not hold that date". The button is withdrawn and replaced by the
       reason, because a day that silently loses its button reads as a
       day the feature is broken on. */
    const now = Date.now();
    const start = this._dayStart(key);
    if (!Number.isFinite(start) || start > now) {
      return `<p class="cal-dp-wait">${esc(I18N.t("calendar.chart_not_yet"))}</p>`;
    }

    /* Today, before the release: the day exists but that hour does not,
       so land on the newest candle there is rather than ask for one
       from this afternoon. */
    const ahead = ms > now;
    if (ahead) ms = now;

    /* WHICH instrument's chart, when there is more than one.
     *
     * Asked for in these words: "in the calendar, let me choose the
     * symbol whose chart I want to see for that date, when several
     * symbols are attached to the desk."
     *
     * It used to pick for the trader - the focused chart, or the
     * selected symbol, or simply the first expert that happened to
     * connect - and on a desk with four instruments attached that is
     * a guess about the one question the person is asking. The
     * picker is only rendered when there IS a choice: one attached
     * symbol is not a decision, and a dropdown offering a single
     * option is furniture. */
    const live = (typeof liveSymbols === "function" ? liveSymbols() : []) || [];
    const sym = this.chartSymbol && live.some((a) => a.symbol === this.chartSymbol)
      ? this.chartSymbol
      : calendarChartSymbol();
    const picker = live.length > 1
      ? `<label class="field cal-chart-sym">
          <span>${esc(I18N.t("calendar.chart_symbol"))}</span>
          <select class="ctrl cal-chart-pick" aria-label="${esc(I18N.t("calendar.chart_symbol"))}">${
            live.map((a) =>
              `<option value="${esc(a.symbol)}"${a.symbol === sym ? " selected" : ""}>${esc(a.label || a.symbol)}</option>`
            ).join("")
          }</select>
        </label>`
      : "";
    return `${picker}<button type="button" class="btn ghost small cal-chart-go" data-day="${esc(key)}" data-at="${ms}" data-sym="${esc(sym)}">
      ${esc(I18N.t("calendar.see_chart", { symbol: sym }))}
    </button>` +
      (ahead ? `<p class="cal-dp-wait">${esc(I18N.t("calendar.chart_up_to_now"))}</p>` : "");
  },

  /* Which instant on that day the chart should open at.
   *
   * The loudest release, because that is the candle anybody reading a
   * news day is looking for; the first event otherwise; and midday on a
   * day with no releases at all, so a quiet day still answers the
   * question "what was the market doing then". */
  _chartMoment(key, evs) {
    const list = (evs && evs.length ? evs : (this.byDay.get(key) || []))
      .filter((e) => Number.isFinite(e.ms) && e.ms > 0);
    const loud = list.find((e) => e.level === "high") || list[0];
    if (loud) return loud.ms;
    const base = this._fromDayKey(key);
    return Number.isFinite(base) ? base : 0;
  },

  /* No "test the robot on this period" offer here any more.

     It was added so a trader reading a past month could replay the
     robot over it without typing dates. The backtest page has its own
     period picker now - today, this week, this month, the previous
     month, the quarter, or two dates - which is the same capability in
     the place a person goes to run a backtest, so the calendar's copy
     was a second way to do one thing and the user asked for it to go.

     Removed, not hidden: _backtestOffer(), _ranges(), the delegated
     .cal-bt-go handler, the .cal-bt styles and the calendar.bt_* keys
     are all gone with it. A dead branch nothing renders is worse than
     the button, because nothing keeps it honest. */

  /* One event row.
   *
   * `closed` says the market is shut on this event's own day. It used
   * to be stated once, as a sentence at the top of the panel, which
   * put it furthest from the thing it changes the meaning of: a
   * release at 13:30 on a Saturday is not something to trade and the
   * row for it looked exactly like one that is. Asked for directly -
   * put the "market closed" tag beside the event - so it rides on the
   * row, where it is read at the same moment as the time it applies
   * to.
   *
   * A bank holiday is a different fact and keeps its own level: it
   * shuts one currency's banks, not the market, and saying "closed"
   * there would be false. */
  _ev(e, closed) {
    const t = (k, v) => I18N.t(k, v);
    return `<article class="cal-ev i-${e.level}${closed ? " is-shut" : ""}">
      <span class="cal-ev-time">${esc(e.time)}</span>
      <span class="cal-ev-body">
        <span class="cal-ev-t">${esc(this.newsTitle(e.title))}</span>
        <span class="cal-ev-m">
          ${e.currency ? `<span class="cal-ev-ccy">${esc(e.currency)}</span>` : ""}
          <span class="cal-ev-imp">${esc(t(`calendar.impact_${e.level}`))}</span>
          ${closed ? `<span class="cal-chip is-closed cal-ev-shut">${esc(t("calendar.closed"))}</span>` : ""}
        </span>
      </span>
    </article>`;
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
      /* The copy on disk counts. The reminder used to keep its own idea
         of freshness and refetch the week every ten minutes whether or
         not one had just been downloaded for the calendar view, which
         is the same "it keeps loading" with no screen to show for it. */
      if (!this.events.length) this._useCache();
      const stale = this._stale()
        && (!this._remindFetched || Date.now() - this._remindFetched > 10 * 60 * 1000);
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

    /* Paint first, fetch second - and only if the week on disk is old.
     *
     * This used to await two requests before drawing anything, every
     * time the page was opened. Opening a page the trader has already
     * opened should cost nothing at all. */
    const had = this.events.length ? true : this._useCache();
    if (had) {
      root.innerHTML = this.view();
      this.bind(root);
      if (!this._stale()) return;
      const before = this._signature();
      try { await this.load(); } catch (_) { return; }
      if (!document.body.contains(root)) return;
      // Repainted only if the week actually moved: a re-render steals
      // the selection and closes an open day popover.
      if (this._signature() !== before) this.rerender();
      return;
    }

    await this.load();
    // The user may have navigated away while the fetch was in flight.
    if (!document.body.contains(root)) return;
    root.innerHTML = this.view();
    this.bind(root);
  },

  /** Cheap "has anything changed" stamp for the week on screen. */
  _signature() {
    return `${this.events.length}:${this.source || ""}:` +
      (this.events.length ? `${this.events[0].ms}-${this.events[this.events.length - 1].ms}` : "");
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

    /* Whatever a previous bind() left on document and window.
     *
     * bind() runs again on every month change, every calendar-system
     * change and every time the view is mounted, and the popover's
     * handlers are global - so they accumulated. Each stale copy keeps
     * its own closePop, and closePop removes whichever #cal-pop it can
     * find: after a single month change, a scroll anywhere on the page
     * took down a popover that belonged to the handler still in use.
     * Registered through on() below so there is exactly one set. */
    if (Array.isArray(this._off)) this._off.forEach((fn) => { try { fn(); } catch (_) { /* gone */ } });
    this._off = [];
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._off.push(() => target.removeEventListener(type, fn, opts));
    };
    /* The day panel. It no longer carries a backtest offer, but it is
       still what a clicked day fills. */
    const day = $$("#cal-day");

    this._bindRemind(root);

    /* Anything a previous build left parented to <body>.

       Two generations of this have existed - a pointer-following
       tooltip (#cal-tip) and a preview written into the news card -
       and a desk that was open across an update can be holding either.
       Sweeping the old node is one line and saves a stranded card
       floating over the new one. */
    this.tip = null;
    const hideTip = () => { document.getElementById("cal-tip")?.remove(); };
    hideTip();

    /* ------------------------------------------------------ selection */

    /* CSS.escape is not in every engine the desk runs on, and a bare `CSS`
       reference throws rather than reading undefined. Day keys are
       YYYY-MM-DD, so the fallback only has to refuse anything else. */
    const esckey = (k) => (typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(k)
      : String(k).replace(/[^0-9-]/g, ""));

    /* One handler for both copies of the day panel - the card beside
       the month and the popover beside the number - because they are
       the same markup rendered twice and a jump means the same thing
       from either. */
    const goChart = (e) => {
      const btn = e.target.closest && e.target.closest(".cal-chart-go");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof openCalendarMoment === "function") {
        /* The symbol the trader picked for this date, when the desk
           has more than one attached. Read off the panel at the
           moment of the press rather than from the render, so a
           choice made and then changed is honoured. */
        const pick = btn.parentElement
          && btn.parentElement.querySelector(".cal-chart-pick");
        const symbol = (pick && pick.value) || btn.dataset.sym || "";
        openCalendarMoment(btn.dataset.day, Number(btn.dataset.at), symbol);
      }
    };
    day?.addEventListener("click", goChart);

    /* Picking an instrument re-renders the offer, so the button names
       the chart it will actually open. The choice is remembered for
       the next day the trader looks at - they are reading one
       instrument through a month, not choosing again each time. */
    const pickChart = (e) => {
      const pick = e.target.closest && e.target.closest(".cal-chart-pick");
      if (!pick) return;
      this.chartSymbol = String(pick.value || "");
      const host = pick.closest(".cal-day") || pick.parentElement?.parentElement;
      const btn = host && host.querySelector(".cal-chart-go");
      if (btn) {
        btn.dataset.sym = this.chartSymbol;
        btn.textContent = I18N.t("calendar.see_chart", { symbol: this.chartSymbol });
      }
    };
    day?.addEventListener("change", pickChart);

    const select = (key) => {
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
      /* Deliberately no scrollIntoView here.

         It used to scroll the stacked day panel into view on a phone,
         from the time when that panel below the grid WAS the answer to
         a tap. It is not any more - the answer is the popover beside
         the number - and the two could not both happen:

           tap -> select() smooth-scrolls the page to the news card
               -> the scroll listener below fires, which exists because
                  the popover is position:fixed beside a cell that has
                  just moved
               -> closePop()

         so the card the tap was asking for was built and destroyed in
         the same gesture, and all the user saw was the page jumping to
         the news container. Reported exactly that way. The panel is
         still filled, for anyone who scrolls down to it; nothing drags
         the page there. */
    };

    /* ------------------------------------------------- the day popup */

    /* Asked for in these words: the window must open BESIDE the number
     * that was hovered or pressed, the news inside it must scroll, and
     * clicking outside must close it - and hovering must stop changing
     * the shared news card.
     *
     * The version before this one answered the last part by previewing
     * into the card beside the month. That removed the flicker but
     * also removed the thing being asked for: the reader's eye is on a
     * day in the middle of a grid and the answer appeared somewhere
     * else entirely, and on a phone it appeared below the fold. So the
     * preview is a popover again - anchored to the cell, not to the
     * pointer, so it does not slide around under the hand - and the
     * shared card is left alone unless a day is actually CHOSEN.
     *
     * Three ways in, because a desk is used with three hands:
     *   - hover, after a short delay, on a device that has a pointer
     *   - a press and hold, on a touch screen
     *   - a plain click or tap, which also pins it open
     * Hover-opened popovers follow the pointer away. A pinned one
     * stays until something outside it is clicked, or Escape.
     */
    const POP_OPEN_MS = 140;    /* hover before it opens - not instant */
    const POP_GRACE_MS = 260;   /* crossing the gap must not close it */
    const POP_HOLD_MS = 420;    /* a press that counts as press-and-hold */
    /* How long the mouse events a browser invents after a tap keep
       arriving. Anything in this window is the finger, not a pointer. */
    const TOUCH_ECHO_MS = 700;

    let popKey = "";
    let popPinned = false;
    let popCell = null;
    let openTimer = 0;
    let shutTimer = 0;
    let holdTimer = 0;
    let inPop = false;

    const clearTimers = () => {
      if (openTimer) { clearTimeout(openTimer); openTimer = 0; }
      if (shutTimer) { clearTimeout(shutTimer); shutTimer = 0; }
    };
    const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };

    const popNode = () => document.getElementById("cal-pop");

    const closePop = () => {
      clearTimers();
      clearHold();
      popKey = "";
      popPinned = false;
      inPop = false;
      if (popCell) popCell.classList.remove("is-peek");
      popCell = null;
      popNode()?.remove();
    };

    /* Beside the number, and inside the window.
     *
     * The inline side is tried first - that is what "beside" means -
     * and the block position is pinned to the cell's own top so the
     * popover reads as belonging to that row. Everything is clamped to
     * the viewport afterwards, because a cell in the last column or
     * the bottom week would otherwise put half the card off-screen. */
    const placePop = (node, cell) => {
      const r = cell.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const w = node.offsetWidth || 300;
      const h = node.offsetHeight || 260;
      const gap = 10;
      const rtl = document.documentElement.getAttribute("dir") === "rtl";
      /* The reading direction decides which side is tried first, so in
         Persian the card opens to the left of the day as the eye
         expects, and flips only when there is no room. */
      const first = rtl ? r.left - gap - w : r.right + gap;
      const other = rtl ? r.right + gap : r.left - gap - w;
      let left = first;
      if (left < 8 || left + w > vw - 8) left = other;
      if (left < 8 || left + w > vw - 8) {
        /* Neither side fits - a phone. Centre it on the cell and let
           the block clamp below push it clear. */
        left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
      }
      let top = r.top;
      if (top + h > vh - 8) top = vh - h - 8;
      if (top < 8) top = 8;
      node.style.left = Math.round(left) + "px";
      node.style.top = Math.round(top) + "px";
    };

    const openPop = (cell, pinned) => {
      if (!cell) return;
      const key = cell.dataset.day;
      if (!key) return;
      clearTimers();
      if (popKey === key) {
        if (pinned) popPinned = true;
        return;
      }
      popNode()?.remove();
      if (popCell) popCell.classList.remove("is-peek");
      const node = document.createElement("div");
      node.id = "cal-pop";
      node.className = "cal-pop card";
      node.setAttribute("role", "dialog");
      node.setAttribute("aria-label", I18N.t("calendar.title"));
      /* The scroller is a child, not the popover itself: the day's
         heading stays put while a long list of releases moves under
         it, which is what makes a busy day readable at all.
         
         The cross is a sibling of that scroller rather than part of
         _dayPanel, because _dayPanel is drawn twice: here, and in the
         card beside the month. That card is not dismissable - it is
         the page - so a close button belongs to this copy only. */
      node.innerHTML =
        '<button type="button" class="cal-pop-x" aria-label="'
        + esc(I18N.t("common.close")) + '" title="' + esc(I18N.t("common.close")) + '">'
        + this._cross() + "</button>"
        + '<div class="cal-pop-in">' + this._dayPanel(key) + "</div>";
      document.body.appendChild(node);
      popKey = key;
      popPinned = Boolean(pinned);
      popCell = cell;
      cell.classList.add("is-peek");
      placePop(node, cell);
      /* Measured once more after layout: the first measurement is taken
         before the browser has wrapped the event titles, so a tall card
         would otherwise hang off the bottom. */
      requestAnimationFrame(() => {
        const live = popNode();
        if (live && popCell) placePop(live, popCell);
      });
      node.addEventListener("click", goChart);
      /* The same instrument picker as the card beside the month - the
         popover draws the same panel, so it gets the same handler. */
      node.addEventListener("change", pickChart);
      /* ...and the same dropdown treatment, so a <select> inside a
         popover parented to <body> is the desk's own control rather
         than the system's list. See enhanceSelects. */
      try { if (typeof enhanceSelects === "function") enhanceSelects(node); } catch (_) { /* */ }
      /* The popover is appended to document.body, not to the grid, so
         this click cannot reach the day-select handler on #cal-pane -
         the cross cannot choose a day by accident today.
         
         The call to stopPropagation is kept anyway, and deliberately:
         goChart is bound to this same node, document-level handlers
         watch for clicks away, and "it is safe because of where the
         element happens to be mounted" is exactly the kind of
         reasoning that stops being true after a refactor nobody
         connects to this line. It costs nothing. */
      node.addEventListener("click", (e) => {
        if (!e.target.closest || !e.target.closest(".cal-pop-x")) return;
        e.preventDefault();
        e.stopPropagation();
        closePop();
      });
      node.addEventListener("mouseenter", () => { inPop = true; clearTimers(); });
      node.addEventListener("mouseleave", () => { inPop = false; shutSoon(); });
      node.addEventListener("wheel", clearTimers, { passive: true });
    };

    const shutSoon = () => {
      clearTimers();
      if (!popKey || popPinned) return;
      shutTimer = setTimeout(() => { shutTimer = 0; if (!inPop) closePop(); }, POP_GRACE_MS);
    };

    /* The popover belongs to the window, not to the grid, so it is
       closed by anything that moves the ground under it. */
    const onAway = (e) => {
      if (!popKey) return;
      if (e.target.closest && (e.target.closest("#cal-pop") || e.target.closest(".cal-cell"))) return;
      closePop();
    };
    const onKey = (e) => { if (e.key === "Escape" && popKey) closePop(); };

    /* The ground moved: follow it, do not give up.
     *
     * This used to close the popover on any scroll and on any resize,
     * because the card is position:fixed beside a cell and would
     * otherwise be left hanging next to nothing. That was too blunt in
     * both directions, and it is the whole of the reported fault -
     * "on the phone I tap a day, the window flashes up and vanishes,
     * and I have to tap again" (the same on a desktop).
     *
     * A scroll event is fired by any scrollable element, not only by
     * the page, and selecting a day REWRITES the day panel: its list
     * of releases is a scroller, its scrollTop snaps back to zero, and
     * that is a scroll event - arriving a few milliseconds after the
     * tap that opened the card. The second tap worked because the same
     * day was already selected, so nothing was rewritten and nothing
     * scrolled.
     *
     * So the question is no longer "did something scroll" but "where
     * is the cell now": the card is put back beside it, and it is only
     * closed once the cell itself has left the screen. Which also
     * fixes the phone's own resize - the URL bar sliding away is a
     * resize, and it was closing the card in the middle of reading. */
    const follow = () => {
      const node = popNode();
      if (!node || !popCell) return;
      if (!document.body.contains(popCell)) { closePop(); return; }
      const r = popCell.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) { closePop(); return; }
      placePop(node, popCell);
    };
    const onScroll = (e) => {
      if (!popKey) return;
      const t = e.target;
      /* Inside the card is the reader working through a busy day, and
         inside the day panel is the rewrite described above. Neither
         moves the cell. */
      if (t && t.closest && (t.closest("#cal-pop") || t.closest("#cal-day"))) return;
      follow();
    };
    on(document, "pointerdown", onAway, true);
    on(document, "keydown", onKey, true);
    on(window, "resize", follow);
    on(window, "scroll", onScroll, true);

    /* The desk calls unpin() on every view change, and a rerender
       replaces the grid under an open card. */
    this.unpin = () => { hideTip(); closePop(); };
    this.peek = "";

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
      /* A click does both: it chooses the day - which is what fills the
         card beside the month and what every other part of the page
         reads - and it pins the popover open beside the number, which
         is what was asked for. */
      select(el.dataset.day);
      openPop(el, true);
    });

    /* Hover and keyboard focus both preview. One delegated pair of
       listeners on the pane, so a re-render of the grid cannot leave a
       stale handler behind, and pointerleave on the pane - not on each
       cell - so crossing the gap between two days does not flicker the
       panel back and forth. */
    pane?.addEventListener("mouseover", (e) => {
      const el = e.target.closest(".cal-cell");
      if (!el || !pane.contains(el) || popPinned) return;
      /* A touch screen sends mouseover and mousemove of its own after
         every tap. Letting the hover path run on those means a finger
         competes with itself: the tap opens the card pinned and the
         synthetic hover immediately queues another open for the same
         cell. Ignored for as long as a tap can still be echoing. */
      if (Date.now() - touchedAt < TOUCH_ECHO_MS) return;
      if (el === popCell) { clearTimers(); return; }
      clearTimers();
      openTimer = setTimeout(() => { openTimer = 0; openPop(el, false); }, POP_OPEN_MS);
    });
    pane?.addEventListener("focusin", (e) => {
      const el = e.target.closest(".cal-cell");
      if (el && pane.contains(el) && !popPinned) openPop(el, false);
    });
    pane?.addEventListener("mouseleave", shutSoon);
    pane?.addEventListener("focusout", (e) => {
      if (!pane.contains(e.relatedTarget) && !popPinned) shutSoon();
    });

    /* Touch opens the card on the lift, not on the synthetic click.
     *
     * A tap used to rely on the click event the browser makes up
     * afterwards, which arrives up to 300ms later on some engines -
     * long enough to read as "nothing happened, tap again". The lift
     * does it directly; the click that follows finds the same day
     * already open and only re-pins it.
     *
     * Any movement is a scroll, not a tap, so the hold is cleared and
     * the lift does nothing.
     *
     * touchedAt is what keeps the synthetic mouse events that follow a
     * tap out of the hover path above. */
    let touchedAt = 0;
    let touchMoved = false;
    pane?.addEventListener("touchend", (e) => {
      const el = e.target.closest && e.target.closest(".cal-cell");
      touchedAt = Date.now();
      clearHold();
      if (!el || !pane.contains(el) || touchMoved) return;
      select(el.dataset.day);
      openPop(el, true);
    }, { passive: true });
    pane?.addEventListener("touchstart", (e) => {
      const el = e.target.closest(".cal-cell");
      touchedAt = Date.now();
      touchMoved = false;
      if (!el || !pane.contains(el)) return;
      clearHold();
      holdTimer = setTimeout(() => { holdTimer = 0; openPop(el, true); }, POP_HOLD_MS);
    }, { passive: true });
    pane?.addEventListener("touchmove", () => { touchMoved = true; clearHold(); }, { passive: true });
    pane?.addEventListener("touchcancel", () => { touchMoved = true; clearHold(); }, { passive: true });

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
      closePop();
      next.focus();
      select(next.dataset.day);
    });

    /* No scroll or MutationObserver handlers here any more: they existed
       only to keep a floating card glued to the cell under the pointer,
       and nothing floats now. */
  },
};
