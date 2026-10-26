/* ===========================================================================
   AURION — the desk's own colour picker.

   Settings used <input type="color">, which hands the choice to the
   operating system. Three things were wrong with that on a trading desk:

     1. The OS dialog is a window in front of the app. It covers the very
        surface being recoloured, so the one thing a colour needs - seeing
        it behind a table of numbers - is the one thing it prevents.
     2. It is not the product. A native Windows colour dialog in the middle
        of a themed desk reads as a bug, not a feature.
     3. Its `input` event fires continuously while the mouse moves, and the
        old handler republished the entire theme stylesheet and repainted
        every chart on each one. That is where the lag came from.

   This is a popover inside the page: a saturation/value field, a hue rail,
   a hex box and the theme's own swatches. It reports two different things
   on purpose - `onInput` while dragging, which callers are expected to
   make cheap, and `onCommit` when the choice settles, for the expensive
   work. That split is what keeps the desk responsive while a colour is
   being chosen.

   =========================================================================== */
(function (global) {
  "use strict";

  var doc = global.document;
  var open = null;              /* the popover currently on screen */

  /* --------------------------------------------------------------- colour */

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function normHex(v) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || "").trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h.toLowerCase();
  }

  function hexToHsv(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
    return [h, mx ? d / mx : 0, mx];
  }

  function hsvToHex(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 1);
    v = clamp(v, 0, 1);
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    var out = 0;
    for (var i = 0; i < 3; i++) out = (out << 8) | Math.round((t[i] + m) * 255);
    return "#" + ("000000" + out.toString(16)).slice(-6);
  }

  /* ------------------------------------------------------------------ dom */

  function el(tag, cls, html) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function t(key, fallback) {
    try {
      if (global.I18N && global.I18N.t) {
        var s = global.I18N.t(key);
        if (s && s !== key) return s;
      }
    } catch (e) { /* fall through */ }
    return fallback;
  }

  /* Drag handling that works for mouse, pen and finger alike, and keeps
     tracking once the pointer leaves the element it started on. */
  function onDrag(node, handler) {
    function point(ev) {
      var r = node.getBoundingClientRect();
      handler(
        clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1),
        clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1),
        ev.type === "pointerup"
      );
    }
    node.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      try { node.setPointerCapture(ev.pointerId); } catch (e) { /* older engines */ }
      point(ev);
      function move(e2) { point(e2); }
      function up(e2) {
        point(e2);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      }
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", up);
    });
  }

  function close() {
    if (!open) return;
    var o = open;
    open = null;
    try { doc.removeEventListener("pointerdown", o.away, true); } catch (e) { /* */ }
    try { doc.removeEventListener("keydown", o.key, true); } catch (e) { /* */ }
    if (o.node && o.node.parentNode) o.node.parentNode.removeChild(o.node);
    if (typeof o.onClose === "function") o.onClose();
  }

  /**
   * Open the picker.
   *
   * opts.value      "#rrggbb" to start from
   * opts.anchor     element to sit beside
   * opts.title      heading
   * opts.swatches   array of "#rrggbb" offered as one-tap choices
   * opts.onInput    (hex) - fires continuously; keep it cheap
   * opts.onCommit   (hex) - fires when the choice settles
   */
  function show(opts) {
    opts = opts || {};
    close();

    var hex = normHex(opts.value) || "#3ee0c4";
    var hsv = hexToHsv(hex);

    var node = el("div", "cp-pop");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", opts.title || t("themes.pick_colour", "Pick a colour"));

    node.innerHTML =
      '<div class="cp-head"><b></b><button type="button" class="cp-x" aria-label="' +
        t("common.close", "Close") + '">\u00D7</button></div>' +
      '<div class="cp-sv"><i></i></div>' +
      '<div class="cp-hue"><i></i></div>' +
      '<div class="cp-foot">' +
        '<span class="cp-prev"></span>' +
        '<input class="cp-hex" spellcheck="false" maxlength="7" aria-label="' +
          t("themes.hex", "Hex value") + '" />' +
      '</div>' +
      '<div class="cp-swatches"></div>';

    node.querySelector(".cp-head b").textContent = opts.title || t("themes.pick_colour", "Pick a colour");

    var sv = node.querySelector(".cp-sv");
    var svDot = sv.querySelector("i");
    var hue = node.querySelector(".cp-hue");
    var hueDot = hue.querySelector("i");
    var prev = node.querySelector(".cp-prev");
    var hexIn = node.querySelector(".cp-hex");
    var swatchBox = node.querySelector(".cp-swatches");
    (opts.swatches || []).forEach(function (s) {
      var h = normHex(s);
      if (!h) return;
      var b = el("button", "cp-sw");
      b.type = "button";
      b.style.background = h;
      b.title = h;
      b.setAttribute("aria-label", h);
      b.addEventListener("click", function () { setHex(h, true); });
      swatchBox.appendChild(b);
    });

    /* One frame between a drag and a repaint. The pointer fires far faster
       than the screen refreshes, and the caller's onInput repaints the
       desk - without this the queue of work outruns the drag and the
       picker feels like it is lagging behind the finger. */
    var queued = null;
    var frame = 0;
    function report(commit) {
      var payload = current();
      if (commit) {
        if (frame) { global.cancelAnimationFrame(frame); frame = 0; queued = null; }
        if (opts.onCommit) opts.onCommit(payload);
        return;
      }
      queued = payload;
      if (frame) return;
      frame = global.requestAnimationFrame(function () {
        frame = 0;
        var p = queued;
        queued = null;
        if (p && opts.onInput) opts.onInput(p);
      });
    }

    function current() { return hsvToHex(hsv[0], hsv[1], hsv[2]); }

    function paint() {
      var now = current();
      sv.style.background =
        "linear-gradient(to top, #000, transparent), " +
        "linear-gradient(to right, #fff, " + hsvToHex(hsv[0], 1, 1) + ")";
      svDot.style.left = (hsv[1] * 100) + "%";
      svDot.style.top = ((1 - hsv[2]) * 100) + "%";
      svDot.style.background = now;
      hueDot.style.left = (hsv[0] / 360 * 100) + "%";
      hueDot.style.background = hsvToHex(hsv[0], 1, 1);
      if (doc.activeElement !== hexIn) hexIn.value = now;

      prev.style.background = now;
    }

    function setHex(h, commit) {
      var v = normHex(h);
      if (!v) return;
      hsv = hexToHsv(v);
      paint();
      report(Boolean(commit));
    }

    onDrag(sv, function (x, y, done) {
      hsv[1] = x;
      hsv[2] = 1 - y;
      paint();
      report(done);
    });
    onDrag(hue, function (x, _y, done) {
      hsv[0] = x * 360;
      paint();
      report(done);
    });

    hexIn.addEventListener("input", function () {
      var v = normHex(hexIn.value);
      if (!v) return;
      hsv = hexToHsv(v);
      paint();
      report(false);
    });
    hexIn.addEventListener("change", function () { report(true); });

    node.querySelector(".cp-x").addEventListener("click", close);

    /* Placed before measuring, so the rect below is the real one. */
    (doc.body || doc.documentElement).appendChild(node);
    paint();

    var a = opts.anchor && opts.anchor.getBoundingClientRect
      ? opts.anchor.getBoundingClientRect()
      : { left: 24, right: 24, top: 24, bottom: 24 };
    var w = node.offsetWidth || 248;
    var h = node.offsetHeight || 300;
    var vw = global.innerWidth || 1024;
    var vh = global.innerHeight || 768;
    /* Beside the swatch when there is room, flipped when there is not, and
       never off the edge - the settings panel scrolls, so the anchor can be
       anywhere on screen. */
    var left = clamp(a.left, 8, Math.max(8, vw - w - 8));
    var top = a.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, a.top - h - 8);
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";

    function away(ev) {
      if (node.contains(ev.target)) return;
      if (opts.anchor && opts.anchor.contains && opts.anchor.contains(ev.target)) return;
      close();
    }
    function key(ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); close(); }
    }
    doc.addEventListener("pointerdown", away, true);
    doc.addEventListener("keydown", key, true);

    open = { node: node, away: away, key: key, onClose: opts.onClose };
    hexIn.focus();
    return node;
  }

  global.AurionPicker = {
    open: show,
    close: close,
    normHex: normHex,
    hexToHsv: hexToHsv,
    hsvToHex: hsvToHex,
    isOpen: function () { return Boolean(open); },
  };
})(typeof window !== "undefined" ? window : this);
