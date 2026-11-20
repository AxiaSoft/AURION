/* ===========================================================================
   AURION — the desk's own date and time pickers.

   Asked for in the same breath as the colour picker before it: "don't
   make the backtest's date picker and prop's time picker browser ones -
   they should all belong to the app."

   The reasons are the same three, and they are worth writing down again
   because they are easy to argue away:

     1. <input type="date"> and <input type="time"> are drawn by the
        browser and the operating system, not by the product. A grey
        Chrome calendar in the middle of a themed desk reads as a seam,
        and on Windows it is not even the same calendar twice - Edge,
        Chrome and a WebView2 host each draw their own.
     2. They are not translated by us. The desk runs in Persian and
        Arabic; the native widget follows the OS locale, so a Persian
        desk got an English calendar starting on Sunday, with no way to
        correct it.
     3. Their bounds are advisory. `max` on a date input stops the
        spinner but not a typed date, and a WebView2 host will happily
        hand back 2031-02-30 - which is how a backtest came to be sent a
        range the engine could only answer "no bars in that period" to.

   So: a popover inside the page, in the desk's own type and colours,
   with the choices the caller allows and nothing else selectable.

   The value is always ISO - "YYYY-MM-DD" for a date, "HH:MM" for a time
   - and it is kept in a real <input> so every caller that reads
   `$("bt-from").value` keeps working unchanged. Choosing dispatches
   `input` and `change` on that input, so handlers written for the
   native field keep working too. What is REPLACED is only the widget a
   person touches.

   The displayed text is formatted in the desk's language against the
   Gregorian calendar explicitly (`-u-ca-gregory`). Without that, Intl
   in Persian returns Jalali month names for a Gregorian date, which is
   a different date wearing the right number.

   =========================================================================== */
(function (global) {
  "use strict";

  var doc = global.document;
  var open = null;                 /* the popover currently on screen */

  /* ---------------------------------------------------------- utilities */

  function t(key, fallback) {
    try {
      if (global.I18N && global.I18N.t) {
        var s = global.I18N.t(key);
        if (s && s !== key) return s;
      }
    } catch (e) { /* fall through */ }
    return fallback;
  }

  function locale() {
    var lang = "en";
    try { lang = (global.I18N && global.I18N.lang) || "en"; } catch (e) { /* */ }
    /* Gregorian, stated. See the header: a bare "fa" locale formats into
       the Jalali calendar and would label 2026-03-21 as Farvardin 1. */
    return lang + "-u-ca-gregory";
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** "2026-10-05" -> {y,m,d}, or null. Rejects 2026-02-30 as well as junk. */
  function parseISO(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return null;
    var dt = new Date(y, mo - 1, d, 12);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y: y, m: mo, d: d };
  }

  function iso(y, m, d) {
    return String(y).padStart(4, "0") + "-" +
      String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function todayISO() {
    var n = new Date();
    return iso(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }

  /** "7:5", "07.00" and "0700" all mean 07:00. Null when it means nothing. */
  function parseTime(v) {
    var s = String(v === null || v === undefined ? "" : v).trim();
    var m = /^(\d{1,2})\s*[:.]?\s*(\d{2})$/.exec(s) || /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(s);
    if (!m) return null;
    var hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) return null;
    return { h: hh, m: mm };
  }

  function timeISO(h, m) {
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  /** ISO strings compare correctly as text, which is the whole point of ISO. */
  function withinDate(v, min, max) {
    if (!v) return false;
    if (min && v < min) return false;
    if (max && v > max) return false;
    return true;
  }

  /* ------------------------------------------------------------- fields */

  /**
   * The markup for a date field: a real input holding the ISO value and a
   * button that opens the desk's picker.
   *
   * opts.id     id of the value input - callers read and write this
   * opts.value  "YYYY-MM-DD" or ""
   * opts.min    earliest selectable day, ISO, optional
   * opts.max    latest selectable day, ISO, optional
   * opts.label  accessible name for the button
   */
  function dateField(opts) {
    opts = opts || {};
    var value = parseISO(opts.value) ? String(opts.value) : "";
    return '<span class="dt-field" data-dt-kind="date">' +
      '<input type="hidden" id="' + esc(opts.id) + '" value="' + esc(value) + '" />' +
      '<button type="button" class="ctrl dt-btn" data-dt-for="' + esc(opts.id) + '"' +
        ' data-dt-kind="date"' +
        ' data-dt-min="' + esc(opts.min || "") + '" data-dt-max="' + esc(opts.max || "") + '"' +
        ' aria-label="' + esc(opts.label || t("when.pick_date", "Pick a date")) + '">' +
        '<span class="dt-text">' + esc(value ? formatDate(value) : t("when.no_date", "Choose…")) + '</span>' +
        icon("date") +
      '</button></span>';
  }

  /** The same, for a time of day. `step` is in minutes (default 5). */
  function timeField(opts) {
    opts = opts || {};
    var parsed = parseTime(opts.value);
    var value = parsed ? timeISO(parsed.h, parsed.m) : "";
    return '<span class="dt-field" data-dt-kind="time">' +
      '<input type="hidden" id="' + esc(opts.id) + '" value="' + esc(value) + '" />' +
      '<button type="button" class="ctrl dt-btn" data-dt-for="' + esc(opts.id) + '"' +
        ' data-dt-kind="time" data-dt-step="' + esc(String(opts.step || 5)) + '"' +
        ' aria-label="' + esc(opts.label || t("when.pick_time", "Pick a time")) + '">' +
        '<span class="dt-text">' + esc(value || "--:--") + '</span>' +
        icon("time") +
      '</button></span>';
  }

  function icon(kind) {
    var d = kind === "time"
      ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
      : '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>';
    return '<svg class="dt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' + d + '</svg>';
  }

  /** "5 October 2026" in the desk's language, Gregorian. */
  function formatDate(value) {
    var p = parseISO(value);
    if (!p) return "";
    try {
      return new Intl.DateTimeFormat(locale(), {
        day: "numeric", month: "long", year: "numeric",
      }).format(new Date(p.y, p.m - 1, p.d, 12));
    } catch (e) {
      return value;
    }
  }

  /** Put a value into a field that is already on the page, and announce it. */
  function setValue(id, value) {
    var input = doc.getElementById(id);
    if (!input) return false;
    input.value = value;
    var btn = doc.querySelector('[data-dt-for="' + id + '"]');
    if (btn) {
      var text = btn.querySelector(".dt-text");
      if (text) {
        text.textContent = btn.dataset.dtKind === "time"
          ? (value || "--:--")
          : (value ? formatDate(value) : t("when.no_date", "Choose…"));
      }
    }
    /* The field is an <input>, so these are the events every caller
       already listens for. Choosing in our popover has to be
       indistinguishable from typing in the native one. */
    try {
      input.dispatchEvent(new global.Event("input", { bubbles: true }));
      input.dispatchEvent(new global.Event("change", { bubbles: true }));
    } catch (e) { /* older engines */ }
    return true;
  }

  /** Narrow what a field on the page will accept, after the fact. */
  function setBounds(id, min, max) {
    var btn = doc.querySelector('[data-dt-for="' + id + '"]');
    if (!btn) return;
    btn.dataset.dtMin = min || "";
    btn.dataset.dtMax = max || "";
  }

  /* ------------------------------------------------------------ popover */

  function el(tag, cls, html) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function close() {
    if (!open) return;
    var o = open;
    open = null;
    try { doc.removeEventListener("pointerdown", o.away, true); } catch (e) { /* */ }
    try { doc.removeEventListener("keydown", o.key, true); } catch (e) { /* */ }
    if (o.node && o.node.parentNode) o.node.parentNode.removeChild(o.node);
    if (o.anchor && o.anchor.focus) { try { o.anchor.focus(); } catch (e) { /* */ } }
  }

  function place(node, anchor) {
    var a = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: 24, right: 24, top: 24, bottom: 24 };
    var w = node.offsetWidth || 280;
    var h = node.offsetHeight || 320;
    var vw = global.innerWidth || 1024;
    var vh = global.innerHeight || 768;
    var left = Math.max(8, Math.min(a.left, vw - w - 8));
    var top = a.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, a.top - h - 8);
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
  }

  function mount(node, anchor) {
    (doc.body || doc.documentElement).appendChild(node);
    place(node, anchor);
    function away(ev) {
      if (node.contains(ev.target)) return;
      if (anchor && anchor.contains && anchor.contains(ev.target)) return;
      close();
    }
    function key(ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    }
    doc.addEventListener("pointerdown", away, true);
    doc.addEventListener("keydown", key, true);
    open = { node: node, away: away, key: key, anchor: anchor };
  }

  /* --------------------------------------------------------- date popup */

  function monthLabel(y, m) {
    try {
      return new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" })
        .format(new Date(y, m - 1, 1, 12));
    } catch (e) {
      return y + "-" + String(m).padStart(2, "0");
    }
  }

  function weekdayNames() {
    var out = [];
    try {
      var fmt = new Intl.DateTimeFormat(locale(), { weekday: "short" });
      /* 2024-01-01 was a Monday; the desk's week starts on Monday, which
         is the week the markets are written in. */
      for (var i = 0; i < 7; i += 1) out.push(fmt.format(new Date(2024, 0, 1 + i, 12)));
    } catch (e) {
      out = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    }
    return out;
  }

  function openDate(anchor, opts) {
    var min = opts.min || "";
    var max = opts.max || "";
    var start = parseISO(opts.value) || parseISO(max) || parseISO(todayISO());
    var view = { y: start.y, m: start.m };

    var node = el("div", "dt-pop dt-pop-date");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", t("when.pick_date", "Pick a date"));
    node.innerHTML =
      '<div class="dt-head">' +
        '<button type="button" class="dt-nav" data-dt-step="-1" aria-label="' +
          esc(t("calendar.prev", "Previous month")) + '">&#8249;</button>' +
        '<b class="dt-month"></b>' +
        '<button type="button" class="dt-nav" data-dt-step="1" aria-label="' +
          esc(t("calendar.next", "Next month")) + '">&#8250;</button>' +
      '</div>' +
      '<div class="dt-wd"></div>' +
      '<div class="dt-grid"></div>' +
      '<div class="dt-foot">' +
        '<button type="button" class="dt-quick" data-dt-today>' +
          esc(t("calendar.today", "Today")) + '</button>' +
      '</div>';

    var wd = node.querySelector(".dt-wd");
    weekdayNames().forEach(function (name) {
      wd.appendChild(el("span", "dt-wdn", esc(name)));
    });

    function paint() {
      node.querySelector(".dt-month").textContent = monthLabel(view.y, view.m);
      var grid = node.querySelector(".dt-grid");
      grid.innerHTML = "";
      var first = new Date(view.y, view.m - 1, 1, 12);
      /* getDay() calls Sunday 0; the grid starts on Monday. */
      var lead = (first.getDay() + 6) % 7;
      var days = new Date(view.y, view.m, 0).getDate();
      var i;
      for (i = 0; i < lead; i += 1) grid.appendChild(el("span", "dt-pad"));
      for (i = 1; i <= days; i += 1) {
        var key = iso(view.y, view.m, i);
        var b = el("button", "dt-day", String(i));
        b.type = "button";
        b.dataset.dtDay = key;
        if (key === opts.value) b.classList.add("on");
        if (key === todayISO()) b.classList.add("now");
        /* Out of bounds days are DISABLED, not merely discouraged. The
           native field's `max` only stops the spinner. */
        if (!withinDate(key, min, max)) b.disabled = true;
        grid.appendChild(b);
      }
      var back = node.querySelector('[data-dt-step="-1"]');
      var fwd = node.querySelector('[data-dt-step="1"]');
      /* A month with nothing selectable in it is not worth walking to. */
      back.disabled = Boolean(min) && iso(view.y, view.m, 1) <= min;
      fwd.disabled = Boolean(max) && iso(view.y, view.m, days) >= max;
      var today = node.querySelector("[data-dt-today]");
      if (today) today.disabled = !withinDate(todayISO(), min, max);
    }

    node.addEventListener("click", function (ev) {
      var nav = ev.target.closest("[data-dt-step]");
      if (nav && !nav.disabled) {
        var step = Number(nav.dataset.dtStep);
        var m = view.m + step;
        var y = view.y;
        if (m > 12) { m = 1; y += 1; } else if (m < 1) { m = 12; y -= 1; }
        view = { y: y, m: m };
        paint();
        return;
      }
      if (ev.target.closest("[data-dt-today]")) {
        opts.onPick(todayISO());
        close();
        return;
      }
      var day = ev.target.closest("[data-dt-day]");
      if (day && !day.disabled) {
        opts.onPick(day.dataset.dtDay);
        close();
      }
    });

    mount(node, anchor);
    paint();
    place(node, anchor);
    var focus = node.querySelector(".dt-day.on") || node.querySelector(".dt-day:not([disabled])");
    if (focus) { try { focus.focus(); } catch (e) { /* */ } }
    return node;
  }

  /* --------------------------------------------------------- time popup */

  function openTime(anchor, opts) {
    var step = Math.max(1, Math.min(30, Number(opts.step) || 5));
    var now = parseTime(opts.value) || { h: 0, m: 0 };
    var chosen = { h: now.h, m: Math.round(now.m / step) * step % 60 };

    var node = el("div", "dt-pop dt-pop-time");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", t("when.pick_time", "Pick a time"));
    node.innerHTML =
      '<div class="dt-head"><b class="dt-now"></b></div>' +
      '<div class="dt-cols">' +
        '<div class="dt-col" data-dt-part="h" role="listbox" aria-label="' +
          esc(t("when.hours", "Hours")) + '"></div>' +
        '<div class="dt-col" data-dt-part="m" role="listbox" aria-label="' +
          esc(t("when.minutes", "Minutes")) + '"></div>' +
      '</div>' +
      '<div class="dt-foot">' +
        '<button type="button" class="dt-quick" data-dt-ok>' +
          esc(t("when.set", "Set")) + '</button>' +
      '</div>';

    var cols = {
      h: node.querySelector('[data-dt-part="h"]'),
      m: node.querySelector('[data-dt-part="m"]'),
    };
    function fill() {
      cols.h.innerHTML = "";
      cols.m.innerHTML = "";
      var i;
      for (i = 0; i < 24; i += 1) {
        var hb = el("button", "dt-opt", String(i).padStart(2, "0"));
        hb.type = "button";
        hb.dataset.dtH = String(i);
        if (i === chosen.h) hb.classList.add("on");
        cols.h.appendChild(hb);
      }
      for (i = 0; i < 60; i += step) {
        var mb = el("button", "dt-opt", String(i).padStart(2, "0"));
        mb.type = "button";
        mb.dataset.dtM = String(i);
        if (i === chosen.m) mb.classList.add("on");
        cols.m.appendChild(mb);
      }
      node.querySelector(".dt-now").textContent = timeISO(chosen.h, chosen.m);
    }

    function reveal() {
      ["h", "m"].forEach(function (part) {
        var on = cols[part].querySelector(".on");
        if (on && typeof on.scrollIntoView === "function") {
          try { on.scrollIntoView({ block: "center" }); } catch (e) { /* */ }
        }
      });
    }

    node.addEventListener("click", function (ev) {
      var h = ev.target.closest("[data-dt-h]");
      var m = ev.target.closest("[data-dt-m]");
      if (h) { chosen.h = Number(h.dataset.dtH); fill(); return; }
      if (m) { chosen.m = Number(m.dataset.dtM); fill(); return; }
      if (ev.target.closest("[data-dt-ok]")) {
        opts.onPick(timeISO(chosen.h, chosen.m));
        close();
      }
    });

    mount(node, anchor);
    fill();
    place(node, anchor);
    reveal();
    return node;
  }

  /* --------------------------------------------------------------- bind */

  /**
   * One delegated listener for a whole view. Every field drawn by
   * dateField()/timeField() inside `root` opens its picker; a re-render
   * that replaces the markup cannot leave a dead handler behind,
   * because nothing is bound to the fields themselves.
   */
  function bind(root) {
    var host = root || doc;
    if (host.__dtBound) return;
    host.__dtBound = true;
    host.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".dt-btn[data-dt-for]") : null;
      if (!btn || !host.contains(btn)) return;
      ev.preventDefault();
      if (btn.disabled) return;
      var id = btn.dataset.dtFor;
      var input = doc.getElementById(id);
      var value = input ? String(input.value || "") : "";
      /* A second click on the same field closes it, the way every other
         popover on this desk behaves. */
      if (open && open.anchor === btn) { close(); return; }
      close();
      var pick = function (v) { setValue(id, v); };
      if (btn.dataset.dtKind === "time") {
        openTime(btn, { value: value, step: btn.dataset.dtStep, onPick: pick });
      } else {
        openDate(btn, {
          value: value,
          min: btn.dataset.dtMin || "",
          max: btn.dataset.dtMax || "",
          onPick: pick,
        });
      }
    });
  }

  global.AurionWhen = {
    dateField: dateField,
    timeField: timeField,
    bind: bind,
    close: close,
    setValue: setValue,
    setBounds: setBounds,
    formatDate: formatDate,
    parseISO: parseISO,
    parseTime: parseTime,
    todayISO: todayISO,
    isOpen: function () { return Boolean(open); },
  };
})(typeof window !== "undefined" ? window : this);
