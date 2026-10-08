// Theme-aware canvas palette. Reads the desk CSS variables once per theme
// revision so canvas art (grid, panels, candles, levels, fibs) follows the
// light/dark theme. Safe to call in non-DOM environments (falls back to dark).
let __aurionChartTheme = null;
let __aurionChartThemeRev = -1;
function chartTheme() {
  const rev = (typeof window !== "undefined" && window.__aurionThemeRev) || 0;
  if (__aurionChartTheme && __aurionChartThemeRev === rev) return __aurionChartTheme;
  let css = null;
  try {
    css = (typeof window !== "undefined" && window.getComputedStyle && typeof document !== "undefined" && document.documentElement)
      ? window.getComputedStyle(document.documentElement) : null;
  } catch (e) { css = null; }
  const pick = (name, fb) => {
    try {
      const v = css && css.getPropertyValue(name);
      const t = v && String(v).trim();
      return t || fb;
    } catch (e) { return fb; }
  };
  const tri = (hex, fb) => {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || "").trim());
    if (!m) return fb;
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",");
  };
  // Candles read --candle-up / --candle-down, never the accent: the direction
  // of a bar has to mean the same thing in every theme the user can choose.
  const up = pick("--candle-up", "#26d07c");
  const down = pick("--candle-down", "#f4475b");
  const gold = pick("--gold", "#e8c07a");
  const violet = pick("--violet", "#7c6cff");
  const light = (typeof document !== "undefined" && document.documentElement && document.documentElement.dataset.theme) === "light";
  const T = {
    grid: pick("--chart-grid", "rgba(255,255,255,0.045)"),
    line: pick("--chart-line", "rgba(255,255,255,.14)"),
    panelLine: pick("--chart-panel-line", "rgba(255,255,255,.06)"),
    text: pick("--chart-text", "#e8edf7"),
    muted: pick("--chart-muted", "#8b93a7"),
    panel: pick("--chart-panel", "rgba(10,12,18,.9)"),
    up, down, gold, violet,
    upT: tri(up, "38,208,124"),
    downT: tri(down, "244,71,91"),
    goldT: tri(gold, "232,192,122"),
    violetT: tri(violet, "124,108,255"),
    fib: light ? "#3c4a63" : "#c9d0de",
    tag: light ? "#f0e4bd" : "#1a1408",
  };
  __aurionChartTheme = T;
  __aurionChartThemeRev = rev;
  return T;
}


/* ===========================================================================
   Market sessions
   ===========================================================================
   The four centres that set the tone of a trading day. Hours are UTC and do
   not move; the local clock does, which is exactly why they are stored this
   way and converted at the edge rather than guessed from the browser.

   Sydney is the one that wraps midnight, so every calculation below has to
   handle a session whose end hour is smaller than its start - the usual source
   of an overlay that quietly disappears for two hours a day.
   =========================================================================== */
const MARKET_SESSIONS = [
  { id: "sydney", label: "Sydney", open: 21, close: 6, tint: [124, 108, 255] },
  { id: "tokyo", label: "Tokyo", open: 0, close: 9, tint: [232, 192, 122] },
  { id: "london", label: "London", open: 7, close: 16, tint: [62, 224, 196] },
  { id: "newyork", label: "New York", open: 12, close: 21, tint: [255, 107, 138] },
];

/** Is this UTC hour inside the session? Handles the midnight wrap. */
function sessionCovers(session, utcHour) {
  const h = ((utcHour % 24) + 24) % 24;
  return session.open <= session.close
    ? h >= session.open && h < session.close
    : h >= session.open || h < session.close;
}

/** Which sessions are open at a moment - London and New York overlap daily. */
function sessionsAt(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return [];
  const h = date.getUTCHours() + date.getUTCMinutes() / 60;
  return MARKET_SESSIONS.filter((s) => sessionCovers(s, h));
}


/**
 * Which sessions open between one bar and the next.
 *
 * The open has to be marked on the candle where it actually happens, so this
 * compares two consecutive bar timestamps rather than asking "is it open now".
 * Two cases it has to survive: a gap in the data - a weekend, or a missing
 * hour - where a whole session may have opened between two bars, and the
 * midnight wrap, where the hour number goes down instead of up.
 */
function sessionOpensBetween(prev, next) {
  if (!(prev instanceof Date) || !(next instanceof Date)) return [];
  if (isNaN(prev.getTime()) || isNaN(next.getTime())) return [];
  const gapHours = (next.getTime() - prev.getTime()) / 3600000;
  if (gapHours <= 0) return [];
  // A gap of a day or more means every session opened in it; marking them all
  // on one candle would be noise, so the gap itself is left unmarked.
  if (gapHours >= 24) return [];

  return MARKET_SESSIONS.filter((s) => {
    const was = sessionCovers(s, prev.getUTCHours() + prev.getUTCMinutes() / 60);
    const now = sessionCovers(s, next.getUTCHours() + next.getUTCMinutes() / 60);
    if (!was && now) return true;
    // On a coarse timeframe a session can open and the bar still land inside
    // it later; walk the hours in between so a 4H candle still shows the open.
    if (gapHours > 1) {
      for (let h = 1; h < gapHours; h++) {
        const at = new Date(prev.getTime() + h * 3600000);
        const before = new Date(at.getTime() - 3600000);
        if (!sessionCovers(s, before.getUTCHours()) && sessionCovers(s, at.getUTCHours())) return true;
      }
    }
    return false;
  });
}


/* ===========================================================================
   The chart engine
   ===========================================================================
   A 2D-canvas terminal chart. There is no charting library underneath it -
   every candle, axis, indicator and drawing on the screen is painted here -
   which is why this file owns so much: the alternative is a dependency that
   cannot be themed with the desk's tokens or bundled into the installer.

   The parts, in the order they are declared:

     state        what is being shown, how, and what the user has drawn
     scales       price and time, including log, percent and manual scaling
     layout       one object per frame with every coordinate helper on it
     paint        series, indicators, drawings, axes, crosshair, legend
     hit-testing  what is under the pointer, and what can be grabbed
     interaction  pointer, wheel, touch; drawing versus navigating

   Two invariants worth keeping:

     1. `layout()` is the only place that knows how a price becomes a y, and
        a bar index becomes an x. Everything else asks it.
     2. A drawing is stored in *data* space - bar index and price - never in
        pixels, so it stays where the trader put it through every zoom, pan,
        timeframe change and window resize.
   =========================================================================== */

/** Points required before a drawing is finished. -1 means freehand. */
const SHAPE_POINTS = {
  hline: 1, hray: 1, vline: 1, crossline: 1, priceline: 1, dateline: 1,
  text: 1, note: 1, label: 1, pricelabel: 1, flag: 1, emoji: 1,
  trend: 2, ray: 2, extended: 2, arrow: 2, infoline: 2, callout: 2,
  rect: 2, circle: 2, ellipse: 2, measure: 2, pricerange: 2, daterange: 2,
  long: 2, short: 2, fib: 2, fibtime: 2, fibcircle: 2, fibarc: 2, fibspiral: 2,
  gannfan: 2, gannbox: 2, gannsquare: 2, regression: 2,
  parallel: 3, channel: 3, flatchannel: 3, pitchfork: 3, schiff: 3, modschiff: 3,
  triangle: 3, rotrect: 3, arc: 3, curve: 3, fibext: 3, fibchannel: 3, fibwedge: 3,
  disjoint: 4, doublecurve: 4, abcd: 4, elliott3: 4,
  xabcd: 5, gartley: 5, butterfly: 5, bat: 5, crab: 5, cypher: 5,
  elliott5: 6, headshoulders: 7, threedrives: 7,
  brush: -1, highlighter: -1, freearrow: -1, polyline: -1, polygon: -1, path: -1,
};

/** Point labels drawn on the pattern tools. */
const SHAPE_LABELS = {
  abcd: ["A", "B", "C", "D"],
  xabcd: ["X", "A", "B", "C", "D"],
  gartley: ["X", "A", "B", "C", "D"],
  butterfly: ["X", "A", "B", "C", "D"],
  bat: ["X", "A", "B", "C", "D"],
  crab: ["X", "A", "B", "C", "D"],
  cypher: ["X", "A", "B", "C", "D"],
  elliott5: ["0", "1", "2", "3", "4", "5"],
  elliott3: ["0", "A", "B", "C"],
  headshoulders: ["", "LS", "", "H", "", "RS", ""],
  threedrives: ["1", "A", "2", "B", "3", "C", "4"],
};

/** The harmonic ratios each named pattern is defined by, for the readout. */
const HARMONIC_RULES = {
  gartley: { AB: [0.618, 0.618], BC: [0.382, 0.886], CD: [1.13, 1.618], XD: [0.786, 0.786] },
  butterfly: { AB: [0.786, 0.786], BC: [0.382, 0.886], CD: [1.618, 2.24], XD: [1.27, 1.618] },
  bat: { AB: [0.382, 0.5], BC: [0.382, 0.886], CD: [1.618, 2.618], XD: [0.886, 0.886] },
  crab: { AB: [0.382, 0.618], BC: [0.382, 0.886], CD: [2.24, 3.618], XD: [1.618, 1.618] },
  cypher: { AB: [0.382, 0.618], BC: [1.13, 1.414], CD: [0.786, 0.786], XD: [0.786, 0.786] },
};

/** Shapes whose second anchor is only a width, not a price. */
const TIME_ONLY = { daterange: true, fibtime: true, vline: true, dateline: true };

const DASHES = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };

let __shapeSeq = 0;
function shapeId() {
  __shapeSeq += 1;
  return "d" + Date.now().toString(36) + "-" + __shapeSeq.toString(36);
}

class CandleChart {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts || {};
    this.bars = [];

    /* ---- what is shown ------------------------------------------------ */
    this.type = "candles";
    this.sessions = false;
    this.grid = true;
    this.crosshair = "cross";      // cross | dot | none
    this.tool = "cursor";
    this.magnet = "off";           // off | weak | strong
    this.snapTime = true;
    this.indicators = [];
    this.drawings = [];
    this.selected = null;

    /* ---- the view ------------------------------------------------------ */
    this.offset = 0;               // bars scrolled back from the newest
    this.span = 120;               // bars across the plot
    this.rightPad = 0;             // empty bars kept to the right of the last
    this.scale = { auto: true, log: false, percent: false, invert: false, lock: false, mn: null, mx: null };

    /* ---- transient ----------------------------------------------------- */
    this.hover = null;
    this.drag = null;
    this.draft = null;
    this.tick = null;
    this.levels = [];
    this.pending = { sl: 0, tp: 0 };
    this.dragLevel = null;
    this.signals = [];
    this._sigHits = [];
    this._sigHover = null;
    this._pinned = null;
    this.showSignals = true;
    this._moved = false;
    this._space = false;

    /* ---- history ------------------------------------------------------- */
    this.past = [];
    this.future = [];

    this.key = this.opts.key || "";
    this.analyze = Boolean(this.opts.analyze);
    if (this.key) {
      this.drawings = CandleChart.load(this.key).map((d) => this.hydrate(d));
      this.restoreState();
    }

    /* A resize is answered on the next frame, never inside the callback.
       draw() resizes the canvas backing store, and a canvas that changes
       size while the observer is still delivering is exactly what makes the
       browser report "ResizeObserver loop completed with undelivered
       notifications" - a benign warning, but one the desk's boot trap was
       catching and turning into a fatal-looking error box. */
    this.ro = new ResizeObserver(() => this.scheduleDraw());
    this.ro.observe(canvas.parentElement || canvas);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => { this.hover = null; this._sigHover = null; this.draw(); });
    canvas.addEventListener("contextmenu", (e) => this.onContext(e));
    canvas.addEventListener("touchstart", (e) => this.onTouch(e), { passive: false });
    canvas.addEventListener("touchmove", (e) => this.onTouch(e), { passive: false });
    canvas.addEventListener("touchend", () => { this.pinch = null; });
    canvas.addEventListener("dblclick", (e) => this.onDouble(e));
  }

  /* ======================================================== persistence == */

  static load(key) {
    try { return JSON.parse(localStorage.getItem("aurion.draw." + key) || "[]") || []; }
    catch { return []; }
  }

  /** Older drawings predate ids and style fields; fill them in on the way in. */
  hydrate(d) {
    return Object.assign({
      id: shapeId(),
      width: 1.4,
      style: "solid",
      opacity: 1,
      fill: true,
      visible: true,
      locked: false,
      name: "",
    }, d);
  }

  persist() {
    if (!this.key) return;
    try {
      localStorage.setItem("aurion.draw." + this.key, JSON.stringify(this.drawings.slice(-400)));
    } catch { /* private mode must never break the chart */ }
  }

  /** The workspace: chart type, indicators, scale. Kept apart from drawings
      so clearing the chart does not throw the trader's indicators away. */
  saveState() {
    if (!this.key) return;
    try {
      localStorage.setItem("aurion.chart." + this.key, JSON.stringify({
        type: this.type,
        indicators: this.indicators.map((i) => ({ id: i.id, type: i.type, params: i.params, visible: i.visible, color: i.color })),
        scale: { log: this.scale.log, percent: this.scale.percent, invert: this.scale.invert, auto: this.scale.auto },
        grid: this.grid,
        crosshair: this.crosshair,
        magnet: this.magnet,
        sessions: this.sessions,
      }));
    } catch { /* not fatal */ }
  }

  restoreState() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem("aurion.chart." + this.key) || "null"); } catch { st = null; }
    if (!st || typeof st !== "object") return;
    if (st.type) this.type = st.type;
    if (typeof st.grid === "boolean") this.grid = st.grid;
    if (typeof st.sessions === "boolean") this.sessions = st.sessions;
    if (st.crosshair) this.crosshair = st.crosshair;
    if (st.magnet) this.magnet = st.magnet;
    if (st.scale) Object.assign(this.scale, st.scale, { mn: null, mx: null });
    if (Array.isArray(st.indicators)) {
      this.indicators = st.indicators
        .filter((i) => i && this.indicatorDef(i.type))
        .map((i) => ({
          id: i.id || shapeId(),
          type: i.type,
          params: Object.assign({}, this.indicatorDef(i.type).params, i.params || {}),
          visible: i.visible !== false,
          color: i.color || "",
        }));
    }
  }

  /* ============================================================ history == */

  /**
   * Undo is a snapshot stack rather than a list of inverse operations.
   *
   * A drawing is small and there are never many of them, so the honest,
   * unbreakable version costs a few kilobytes: every mutation pushes the
   * state that preceded it. Inverse operations would be cheaper and would
   * eventually get one of the fifty shape kinds wrong.
   */
  snapshot() {
    try {
      this.past.push(JSON.stringify(this.drawings));
      if (this.past.length > 80) this.past.shift();
      this.future.length = 0;
    } catch { /* a snapshot that cannot be taken must not block the edit */ }
  }

  restore(json) {
    try {
      const next = JSON.parse(json);
      this.drawings = Array.isArray(next) ? next.map((d) => this.hydrate(d)) : [];
      const keep = this.selected && this.drawings.find((d) => d.id === this.selected.id);
      this.selected = keep || null;
      this.persist();
      this.draw();
      this.changed();
    } catch { /* corrupt history entry: leave the chart as it is */ }
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(JSON.stringify(this.drawings));
    this.restore(this.past.pop());
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(JSON.stringify(this.drawings));
    this.restore(this.future.pop());
    return true;
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /** Tell the interface that the object list or selection moved. */
  changed() {
    if (typeof this.opts.onChange === "function") {
      try { this.opts.onChange(this); } catch { /* the chart is still fine */ }
    }
  }

  /* ========================================================= the objects == */

  addObject(obj) {
    this.snapshot();
    const d = this.hydrate(obj);
    this.drawings.push(d);
    this.persist();
    this.draw();
    this.changed();
    return d;
  }

  getObject(id) { return this.drawings.find((d) => d.id === id) || null; }

  updateObject(id, patch, opts) {
    const d = this.getObject(id);
    if (!d) return null;
    if (!(opts && opts.quiet)) this.snapshot();
    Object.assign(d, patch || {});
    this.persist();
    this.draw();
    if (!(opts && opts.quiet)) this.changed();
    return d;
  }

  /**
   * Remove a drawing.
   *
   * Takes the id or the object itself. Matching on the object matters: not
   * every shape carries an id (ones built in-memory and never persisted do
   * not), and `d.id === undefined` would happily match the first such shape
   * in the list rather than the one actually being deleted.
   */
  removeObject(id) {
    const at = (id && typeof id === "object")
      ? this.drawings.indexOf(id)
      : (id === undefined || id === null ? -1 : this.drawings.findIndex((d) => d.id === id));
    if (at < 0) return false;
    this.snapshot();
    const [gone] = this.drawings.splice(at, 1);
    if (this.selected === gone) this.selected = null;
    this.persist();
    this.draw();
    this.changed();
    return true;
  }

  eachObject(fn) {
    this.snapshot();
    this.drawings.forEach(fn);
    this.persist();
    this.draw();
    this.changed();
  }

  clearDrawings() {
    if (!this.drawings.length) return;
    this.snapshot();
    this.drawings = [];
    this.selected = null;
    this.persist();
    this.draw();
    this.changed();
  }

  select(shape) {
    this.selected = shape || null;
    this.draw();
    this.changed();
  }

  selectById(id) {
    this.select(this.getObject(id));
  }

  deleteSelected() {
    if (!this.selected) return false;
    // By reference, not by id — the selection is the shape, and it may not
    // have an id yet.
    return this.removeObject(this.selected);
  }

  /* ========================================================== indicators == */

  indicatorDef(type) {
    const lib = (typeof window !== "undefined" && window.AurionSeries) || null;
    return (lib && lib.INDICATOR_BY_ID[type]) || null;
  }

  addIndicator(type, params) {
    const def = this.indicatorDef(type);
    if (!def) return null;
    const ind = {
      id: shapeId(),
      type,
      params: Object.assign({}, def.params, params || {}),
      visible: true,
      color: "",
    };
    this.indicators.push(ind);
    this.saveState();
    this.draw();
    this.changed();
    return ind;
  }

  updateIndicator(id, patch) {
    const ind = this.indicators.find((i) => i.id === id);
    if (!ind) return null;
    if (patch && patch.params) {
      ind.params = Object.assign({}, ind.params, patch.params);
      delete patch.params;
    }
    Object.assign(ind, patch || {});
    this.saveState();
    this.draw();
    this.changed();
    return ind;
  }

  removeIndicator(id) {
    const at = this.indicators.findIndex((i) => i.id === id);
    if (at < 0) return false;
    this.indicators.splice(at, 1);
    this.saveState();
    this.draw();
    this.changed();
    return true;
  }

  /* =============================================================== state == */

  setTool(tool) {
    this.tool = tool || "cursor";
    this.draft = null;
    this.canvas.style.cursor = this.cursorFor();
    this.draw();
  }

  cursorFor() {
    if (this.tool === "cursor") return "default";
    if (this.tool === "pan") return "grab";
    if (this.tool === "eraser") return "cell";
    return "crosshair";
  }

  setCrosshair(mode) { this.crosshair = mode || "cross"; this.saveState(); this.draw(); }
  setGrid(on) { this.grid = Boolean(on); this.saveState(); this.draw(); }
  setMagnet(mode) {
    // The old interface had a magnet switch; a switch cannot say how strong.
    if (mode === true) mode = "weak";
    if (mode === false) mode = "off";
    this.magnet = mode || "off";
    this.saveState();
  }
  setSnapTime(on) { this.snapTime = Boolean(on); }

  setType(type) {
    const lib = (typeof window !== "undefined" && window.AurionSeries) || null;
    if (lib && !lib.SERIES_TYPES.some((t) => t.id === type)) return this.type;
    this.type = type;
    this._series = null;
    this.saveState();
    this.draw();
    return type;
  }

  setSessions(on) { this.sessions = Boolean(on); this.saveState(); this.draw(); }

  setLevels(positions) {
    this.levels = Array.isArray(positions) ? positions.filter(Boolean) : [];
    this.draw();
  }

  setPending(p) {
    p = p || {};
    this.pending = { sl: Number(p.sl || 0) || 0, tp: Number(p.tp || 0) || 0 };
    this.draw();
  }

  setSignals(signals, show) {
    this.signals = Array.isArray(signals) ? signals : [];
    this._sigHover = null;
    if (typeof show === "boolean") this.showSignals = show;
    this.draw();
  }

  setLastBar(b) {
    if (!b) return;
    if (!this.bars.length) { this.setBars([b]); return; }
    const t = String(b.time || b.ts || "");
    const last = this.bars[this.bars.length - 1];
    if (t && String(last.time || last.ts || "") === t) this.bars[this.bars.length - 1] = b;
    else this.bars.push(b);
    this._series = null;
    this.draw();
  }

  setBars(bars) {
    const had = this.bars.length > 0;
    const prevSpan = this.span;
    const prevOff = this.offset;
    const raw = Array.isArray(bars) ? bars.filter((b) => b && (b.close || b.c)) : [];
    const map = new Map();
    for (const b of raw) {
      const t = String(b.time || b.ts || "");
      if (!t) continue;
      map.set(t, b);
    }
    this.bars = [...map.values()].sort((a, b) => String(a.time || a.ts || "").localeCompare(String(b.time || b.ts || "")));
    this._series = null;
    if (!had) {
      this.offset = 0;
      this.span = Math.min(this.analyze ? 160 : 120, Math.max(30, this.bars.length || 30));
    } else {
      this.span = Math.max(8, Math.min(this.rows().length || prevSpan, prevSpan));
      this.offset = prevOff;
      this.clampOffset();
    }
    this.draw();
  }

  setTick(tick) { this.tick = tick; this.draw(); }

  /* ================================================================ data == */

  norm(b) {
    return {
      t: b.time || b.ts || "",
      o: +b.open || +b.o,
      h: +b.high || +b.h,
      l: +b.low || +b.l,
      c: +b.close || +b.c,
      v: +b.volume || +b.v || 0,
    };
  }

  /** The raw normalised bars, before the chart type has its say. */
  all() { return this.bars.map((b) => this.norm(b)); }

  /**
   * The rows the chart actually plots: the bars after the series transform,
   * memoised because Renko over a thousand bars is not free and the chart
   * repaints on every pointer move.
   */
  rows() {
    if (this._series && this._seriesType === this.type && this._seriesLen === this.bars.length) {
      return this._series;
    }
    const lib = (typeof window !== "undefined" && window.AurionSeries) || null;
    const def = lib && lib.SERIES_TYPES.find((t) => t.id === this.type);
    const base = this.all();
    this._series = def && def.transform ? def.transform(base) : base;
    if (!this._series.length) this._series = base;
    this._seriesType = this.type;
    this._seriesLen = this.bars.length;
    return this._series;
  }

  /**
   * The visible window.
   *
   * A negative offset means the chart has been pulled past the newest bar -
   * the empty margin on the right that every terminal lets you scroll into,
   * so the last candle does not have to live jammed against the price axis.
   * That margin is expressed as `rightPad`, which the layout counts as extra
   * cells, and it is the only reason offset is allowed below zero.
   */
  slice() {
    const all = this.rows();
    this.rightPad = Math.max(0, -this.offset);
    const end = all.length - Math.max(0, this.offset);
    const start = Math.max(0, end - this.span + this.rightPad);
    return { rows: all.slice(start, end), start, end };
  }

  fmtPrice(p) {
    const n = Number(p);
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1000) return n.toFixed(2);
    if (a >= 100) return n.toFixed(3);
    if (a >= 1) return n.toFixed(4);
    return n.toFixed(5);
  }

  /* ============================================================== layout == */

  size() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const axisW = w < 420 ? 62 : (this.analyze ? 92 : 78);
    return { w, h, padL: 10, padR: axisW, padT: 14, padB: 26, gapR: 10 };
  }

  /**
   * Everything the painters need, computed once per frame.
   *
   * The price axis is the interesting part. Auto scale fits the visible bars;
   * once the trader drags the axis it is pinned until they ask for auto back.
   * Log and percent are alternative mappings of the same range rather than
   * separate code paths, so every drawing follows the axis it was placed on.
   */
  layout() {
    const { w, h, padL, padR, padT, padB, gapR } = this.size();
    const { rows, start } = this.slice();
    if (!rows.length) return null;

    /* ---- sub-panes ---------------------------------------------------- */
    const subs = this.indicators.filter((i) => {
      const def = this.indicatorDef(i.type);
      return i.visible !== false && def && def.pane === "sub";
    });
    const usable = h - padT - padB;
    let paneShare = 0;
    subs.forEach((i) => { paneShare += (this.indicatorDef(i.type).height || 0.18); });
    paneShare = Math.min(0.62, paneShare);
    const panesH = subs.length ? Math.round(usable * paneShare) : 0;
    const gap = 6;
    const mainB = padT + usable - panesH - (subs.length ? gap : 0);

    /* ---- price range --------------------------------------------------- */
    let mn = Math.min(...rows.map((r) => r.l));
    let mx = Math.max(...rows.map((r) => r.h));
    for (const lv of this.levels || []) {
      for (const k of ["sl", "tp", "price_open", "price_current"]) {
        const n = Number(lv[k]);
        if (n > 0) { mn = Math.min(mn, n); mx = Math.max(mx, n); }
      }
    }
    for (const ind of this.indicators) {
      const def = this.indicatorDef(ind.type);
      if (!def || def.pane !== "main" || ind.visible === false) continue;
      const out = this.indicatorValues(ind, rows);
      for (const plot of def.plots) {
        for (const v of (out[plot.key] || [])) {
          if (v === null || !Number.isFinite(v)) continue;
          mn = Math.min(mn, v); mx = Math.max(mx, v);
        }
      }
    }
    if (mn === mx) { mn -= 1; mx += 1; }
    const auto = this.scale.auto || this.scale.mn === null;
    if (!auto) { mn = this.scale.mn; mx = this.scale.mx; }
    else {
      const pad = (mx - mn) * 0.06 || 0.5;
      mn -= pad; mx += pad;
    }

    const log = this.scale.log && mn > 0;
    const invert = this.scale.invert;
    const f = log ? Math.log : (x) => x;
    const fi = log ? Math.exp : (x) => x;
    const fmn = f(mn), fmx = f(mx);
    const fspan = (fmx - fmn) || 1;
    const plotH = mainB - padT;

    const plotW = Math.max(20, w - padL - padR - gapR);
    const cells = rows.length + this.rightPad;
    const bw = plotW / Math.max(1, cells);

    const yOf = (p) => {
      const v = (f(Math.max(log ? 1e-9 : -Infinity, p)) - fmn) / fspan;
      const k = invert ? v : 1 - v;
      return padT + k * plotH;
    };
    const pOf = (y) => {
      const k = (y - padT) / (plotH || 1);
      const v = invert ? k : 1 - k;
      return fi(fmn + v * fspan);
    };

    /* ---- pane geometry -------------------------------------------------- */
    const panes = [];
    if (subs.length) {
      const each = panesH / subs.length;
      subs.forEach((ind, n) => {
        const top = mainB + gap + n * each;
        const bot = top + each - 4;
        panes.push({ ind, def: this.indicatorDef(ind.type), top, bot });
      });
    }

    return {
      w, h, padL, padR, padT, padB, gapR, rows, start, bw, mn, mx,
      span: mx - mn, log, cells,
      plotL: padL,
      plotR: padL + plotW,
      plotT: padT,
      plotB: mainB,
      axisB: h - padB,
      panes,
      xOf: (i) => padL + i * bw + bw / 2,
      yOf,
      pOf,
      iOf: (x) => Math.floor((x - padL) / bw),
    };
  }

  /* ---- indicator values, memoised per frame ---------------------------- */
  indicatorValues(ind, rows) {
    const def = this.indicatorDef(ind.type);
    if (!def) return {};
    const stamp = ind.id + "|" + rows.length + "|" + (rows[0] && rows[0].t) + "|" +
      (rows[rows.length - 1] && rows[rows.length - 1].c) + "|" + JSON.stringify(ind.params);
    this._indCache = this._indCache || new Map();
    const hit = this._indCache.get(ind.id);
    if (hit && hit.stamp === stamp) return hit.out;
    let out = {};
    try { out = def.calc(rows, ind.params) || {}; } catch { out = {}; }
    this._indCache.set(ind.id, { stamp, out });
    return out;
  }
  paintSessions(L) {
    if (!this.sessions) return;
    const ctx = this.ctx;
    const rows = L.rows || [];
    if (rows.length < 2) return;

    ctx.save();
    for (let i = 0; i < rows.length; i++) {
      const stamp = rows[i].time || rows[i].ts;
      const at = stamp ? new Date(stamp) : null;
      if (!at || isNaN(at.getTime())) continue;
      const open = sessionsAt(at);
      if (!open.length) continue;

      const x = L.xOf(i) - L.bw / 2;
      for (const s of open) {
        ctx.fillStyle = `rgba(${s.tint[0]},${s.tint[1]},${s.tint[2]},0.06)`;
        ctx.fillRect(x, L.plotT, L.bw + 0.5, L.plotB - L.plotT);
      }
    }

    // The open itself, on the candle where it happens. The band says a session
    // is running; this says exactly when it started, which is the bar traders
    // actually mark up.
    ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
    for (let i = 1; i < rows.length; i++) {
      const prevAt = new Date(rows[i - 1].time || rows[i - 1].ts || 0);
      const at = new Date(rows[i].time || rows[i].ts || 0);
      const opens = sessionOpensBetween(prevAt, at);
      if (!opens.length) continue;

      const x = Math.round(L.xOf(i) - L.bw / 2) + 0.5;
      opens.forEach((s, n) => {
        const tint = `rgb(${s.tint[0]},${s.tint[1]},${s.tint[2]})`;
        ctx.strokeStyle = tint;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, L.plotT);
        ctx.lineTo(x, L.plotB);
        ctx.stroke();
        ctx.setLineDash([]);

        // A flag at the bottom, stacked when two centres open on one candle.
        const label = `${s.label} ${String(s.open).padStart(2, "0")}:00`;
        const tw = ctx.measureText(label).width + 10;
        const ly = L.plotB - 16 - n * 15;
        const lx = Math.min(x + 3, L.plotR - tw - 2);
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(lx, ly, tw, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#06070b";
        ctx.fillText(label, lx + 5, ly + 10);
      });
    }
    ctx.restore();

    // A legend, because a coloured band nobody can name is just tinting.
    ctx.save();
    ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
    ctx.textBaseline = "top";
    const nowOpen = sessionsAt(new Date()).map((s) => s.id);
    let lx = L.plotL + 8;
    for (const s of MARKET_SESSIONS) {
      const live = nowOpen.includes(s.id);
      ctx.fillStyle = `rgba(${s.tint[0]},${s.tint[1]},${s.tint[2]},${live ? 0.95 : 0.4})`;
      ctx.fillRect(lx, L.plotT + 7, 7, 7);
      ctx.fillStyle = live ? chartTheme().text : chartTheme().muted;
      ctx.fillText(s.label, lx + 11, L.plotT + 6);
      lx += ctx.measureText(s.label).width + 26;
    }
    ctx.restore();
  }


  /* =============================================================== paint == */

  /** Coalesce every redraw request in a frame into one paint. */
  scheduleDraw() {
    if (this._raf) return;
    const raf = (typeof requestAnimationFrame === "function")
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._raf = raf(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    // Re-entrancy guard. Painting can resize the canvas, which can notify an
    // observer, which can ask to paint again; without this the two chase
    // each other for a frame.
    if (this._painting) return;
    this._painting = true;
    try { this.paint(); } finally { this._painting = false; }
  }

  paint() {
    const ctx = this.ctx;
    const box = this.size();
    ctx.clearRect(0, 0, box.w, box.h);
    const L = this.layout();
    if (!L) return;
    this._L = L;
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    this.paintGrid(L);

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotL, L.plotT, L.plotR - L.plotL, L.plotB - L.plotT);
    ctx.clip();
    this.paintSessions(L);
    this.paintSeries(L);
    this.paintMainIndicators(L);
    this.drawings.forEach((d) => { if (d.visible !== false) this.paintShape(L, d, false); });
    if (this.draft) this.paintShape(L, this.draft, true);
    this.paintLevels(L);
    this.paintPending(L);
    this.paintSignals(L);
    this.paintLastPrice(L);
    ctx.restore();

    this.paintPanes(L);
    this.paintAxes(L);
    this.paintCrosshair(L);
    this.paintSignalCard(L);
    this.paintLegend(L);
    this.paintStretch(L);
  }

  paintGrid(L) {
    if (!this.grid) return;
    const ctx = this.ctx;
    const T = chartTheme();
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = L.plotT + ((L.plotB - L.plotT) * i) / 4;
      ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
    }
    // Vertical rules on a round number of bars rather than every bar: a grid
    // you cannot see through is not a grid.
    const step = Math.max(1, Math.round(L.rows.length / 8));
    for (let i = 0; i < L.rows.length; i += step) {
      const x = L.xOf(i);
      ctx.beginPath(); ctx.moveTo(x, L.plotT); ctx.lineTo(x, L.plotB); ctx.stroke();
    }
  }

  /**
   * The price series itself, in whichever geometry the chart type asks for.
   *
   * Candle bodies are drawn at a minimum of one pixel so a doji is still a
   * mark rather than nothing, and the body is skipped entirely below two
   * pixels of bar width - past that it is a solid block of colour and the
   * wick carries the information.
   */
  paintSeries(L) {
    const ctx = this.ctx;
    const T = chartTheme();
    const lib = (typeof window !== "undefined" && window.AurionSeries) || null;
    const def = lib && lib.SERIES_TYPES.find((t) => t.id === this.type);
    const geometry = (def && def.geometry) || "candle";
    const rows = L.rows;

    if (geometry === "line" || geometry === "area") {
      const base = this.type === "baseline"
        ? rows.reduce((a, r) => a + r.c, 0) / rows.length
        : null;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      rows.forEach((r, i) => {
        const x = L.xOf(i), y = L.yOf(r.c);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (this.type === "baseline") {
        // Two passes so the part above the baseline is green and the part
        // below is red, clipped rather than redrawn.
        const yb = L.yOf(base);
        [[L.plotT, yb, T.up, T.upT], [yb, L.plotB, T.down, T.downT]].forEach(([top, bot, col, tri]) => {
          ctx.save();
          ctx.beginPath(); ctx.rect(L.plotL, top, L.plotR - L.plotL, Math.max(0, bot - top)); ctx.clip();
          const g = ctx.createLinearGradient(0, top, 0, bot);
          g.addColorStop(0, "rgba(" + tri + ",.22)");
          g.addColorStop(1, "rgba(" + tri + ",0)");
          ctx.beginPath();
          rows.forEach((r, i) => {
            const x = L.xOf(i), y = L.yOf(r.c);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.lineTo(L.xOf(rows.length - 1), yb);
          ctx.lineTo(L.xOf(0), yb);
          ctx.closePath();
          ctx.fillStyle = g; ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = 1.6;
          ctx.beginPath();
          rows.forEach((r, i) => {
            const x = L.xOf(i), y = L.yOf(r.c);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
          ctx.restore();
        });
        ctx.strokeStyle = T.line;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(L.plotL, yb); ctx.lineTo(L.plotR, yb); ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      if (geometry === "area") {
        const g = ctx.createLinearGradient(0, L.plotT, 0, L.plotB);
        g.addColorStop(0, "rgba(" + T.upT + ",.26)");
        g.addColorStop(1, "rgba(" + T.upT + ",0)");
        ctx.lineTo(L.xOf(rows.length - 1), L.plotB);
        ctx.lineTo(L.xOf(0), L.plotB);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        rows.forEach((r, i) => {
          const x = L.xOf(i), y = L.yOf(r.c);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
      }
      ctx.strokeStyle = T.up;
      ctx.stroke();
      return;
    }

    const bodyW = Math.max(1, L.bw * 0.66);
    const thin = L.bw < 2.4;
    rows.forEach((r, i) => {
      const x = L.xOf(i);
      const up = r.c >= r.o;
      const col = up ? T.up : T.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.min(1.6, Math.max(1, L.bw * 0.12));

      if (geometry === "bar") {
        ctx.beginPath();
        ctx.moveTo(x, L.yOf(r.h)); ctx.lineTo(x, L.yOf(r.l));
        ctx.moveTo(x - bodyW / 2, L.yOf(r.o)); ctx.lineTo(x, L.yOf(r.o));
        ctx.moveTo(x, L.yOf(r.c)); ctx.lineTo(x + bodyW / 2, L.yOf(r.c));
        ctx.stroke();
        return;
      }

      ctx.beginPath();
      ctx.moveTo(x, L.yOf(r.h));
      ctx.lineTo(x, L.yOf(r.l));
      ctx.stroke();
      if (thin) return;
      const top = L.yOf(Math.max(r.o, r.c));
      const bot = L.yOf(Math.min(r.o, r.c));
      const h = Math.max(1, bot - top);
      if (this.type === "hollow" && up) {
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - bodyW / 2, top, bodyW, h);
      } else {
        ctx.globalAlpha = 0.94;
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);
        ctx.globalAlpha = 1;
      }
    });
  }

  /** Resolve an indicator plot colour name to a real one. */
  plotColor(name, ind) {
    const T = chartTheme();
    if (ind && ind.color) return ind.color;
    switch (name) {
      case "gold": return T.gold;
      case "violet": return T.violet;
      case "up": return T.up;
      case "down": return T.down;
      case "muted": return T.muted;
      case "accent": return T.violet;
      default: return T.gold;
    }
  }

  paintMainIndicators(L) {
    for (const ind of this.indicators) {
      const def = this.indicatorDef(ind.type);
      if (!def || def.pane !== "main" || ind.visible === false) continue;
      const out = this.indicatorValues(ind, L.rows);
      if (def.band && out[def.band[0]] && out[def.band[1]]) {
        this.paintBand(L, out[def.band[0]], out[def.band[1]], this.plotColor(def.plots[0].color, ind));
      }
      def.plots.forEach((plot) => {
        this.paintSeriesLine(L, out[plot.key], this.plotColor(plot.color, ind), plot.dash, L.yOf);
      });
    }
  }

  paintBand(L, upper, lower, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.beginPath();
    let started = false;
    upper.forEach((v, i) => {
      if (v === null) return;
      const x = L.xOf(i), y = L.yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    for (let i = lower.length - 1; i >= 0; i--) {
      if (lower[i] === null) continue;
      ctx.lineTo(L.xOf(i), L.yOf(lower[i]));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  paintSeriesLine(L, values, color, dash, yOf) {
    if (!values) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    if (dash) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { pen = false; return; }
      const x = L.xOf(i), y = yOf(v);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The indicator strips under the chart.
   *
   * Each gets its own price range - an RSI and a volume histogram share no
   * units - and its own right-hand scale so the numbers can be read without
   * hovering.
   */
  paintPanes(L) {
    const ctx = this.ctx;
    const T = chartTheme();
    for (const pane of L.panes) {
      const { ind, def, top, bot } = pane;
      const out = this.indicatorValues(ind, L.rows);
      let mn = Infinity, mx = -Infinity;
      if (def.range) { mn = def.range[0]; mx = def.range[1]; }
      else {
        def.plots.forEach((plot) => {
          (out[plot.key] || []).forEach((v) => {
            if (v === null || !Number.isFinite(v)) return;
            mn = Math.min(mn, v); mx = Math.max(mx, v);
          });
        });
        if (def.zero) mn = Math.min(mn, 0);
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) { mn = 0; mx = 1; }
        if (mn === mx) { mn -= 1; mx += 1; }
        const pad = (mx - mn) * 0.1;
        mn -= pad; mx += pad;
      }
      const span = (mx - mn) || 1;
      const yOf = (v) => bot - ((v - mn) / span) * (bot - top);
      pane.yOf = yOf; pane.mn = mn; pane.mx = mx;

      ctx.save();
      ctx.strokeStyle = T.panelLine;
      ctx.beginPath(); ctx.moveTo(L.plotL, top - 3); ctx.lineTo(L.plotR, top - 3); ctx.stroke();

      (def.guides || []).forEach((g) => {
        if (g < mn || g > mx) return;
        ctx.strokeStyle = T.grid;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(L.plotL, yOf(g)); ctx.lineTo(L.plotR, yOf(g)); ctx.stroke();
        ctx.setLineDash([]);
      });

      ctx.beginPath();
      ctx.rect(L.plotL, top - 3, L.plotR - L.plotL, bot - top + 3);
      ctx.clip();

      def.plots.forEach((plot) => {
        const values = out[plot.key];
        if (!values) return;
        if (plot.kind === "histogram") {
          const w = Math.max(1, L.bw * 0.6);
          values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) return;
            const x = L.xOf(i);
            const zero = yOf(Math.max(mn, Math.min(mx, 0)));
            const y = yOf(v);
            if (plot.color === "direction") {
              const r = L.rows[i];
              ctx.fillStyle = r && r.c >= r.o ? "rgba(" + T.upT + ",.5)" : "rgba(" + T.downT + ",.5)";
            } else if (plot.color === "signed") {
              ctx.fillStyle = v >= 0 ? "rgba(" + T.upT + ",.55)" : "rgba(" + T.downT + ",.55)";
            } else ctx.fillStyle = this.plotColor(plot.color, ind);
            ctx.fillRect(x - w / 2, Math.min(y, zero), w, Math.max(1, Math.abs(zero - y)));
          });
        } else {
          this.paintSeriesLine(L, values, this.plotColor(plot.color, ind), plot.dash, yOf);
        }
      });
      ctx.restore();

      // The pane's own name and last value, top-left, like every terminal.
      const last = def.plots.map((p) => {
        const arr = out[p.key] || [];
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] !== null && Number.isFinite(arr[i])) return arr[i];
        }
        return null;
      }).find((v) => v !== null);
      ctx.fillStyle = T.muted;
      ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
      const title = def.short + (ind.params.period ? " " + ind.params.period : "");
      ctx.fillText(title + (last === null || last === undefined ? "" : "  " + this.fmtPrice(last)), L.plotL + 6, top + 10);

      ctx.textAlign = "right";
      ctx.fillStyle = T.muted;
      ctx.fillText(this.fmtPrice(mx), L.w - 8, top + 8);
      ctx.fillText(this.fmtPrice(mn), L.w - 8, bot - 2);
      ctx.textAlign = "left";
      ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    }
  }

  /** The dotted line and tag for the live mid price. */
  paintLastPrice(L) {
    if (!this.tick || !(this.tick.bid || this.tick.ask)) return;
    const mid = ((+this.tick.bid || 0) + (+this.tick.ask || 0)) / 2;
    if (!mid) return;
    const ctx = this.ctx;
    const y = L.yOf(mid);
    ctx.strokeStyle = "rgba(" + chartTheme().goldT + ",.7)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Price axis on the right, time axis along the bottom. */
  paintAxes(L) {
    const ctx = this.ctx;
    const T = chartTheme();
    ctx.fillStyle = T.panel;
    ctx.fillRect(L.w - L.padR, 0, L.padR, L.h);
    ctx.strokeStyle = T.panelLine;
    ctx.beginPath(); ctx.moveTo(L.w - L.padR, 0); ctx.lineTo(L.w - L.padR, L.h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, L.axisB); ctx.lineTo(L.w, L.axisB); ctx.stroke();

    ctx.fillStyle = T.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const first = L.rows[0];
    for (let i = 0; i <= 4; i++) {
      const y = L.plotT + ((L.plotB - L.plotT) * i) / 4;
      const p = L.pOf(y);
      const text = this.scale.percent && first && first.c
        ? (((p - first.c) / first.c) * 100).toFixed(2) + "%"
        : this.fmtPrice(p);
      ctx.fillText(text, L.w - 8, Math.min(L.plotB - 2, Math.max(L.plotT + 2, y)));
    }

    if (this.tick && (this.tick.bid || this.tick.ask)) {
      const mid = ((+this.tick.bid || 0) + (+this.tick.ask || 0)) / 2;
      if (mid) {
        const y = Math.min(L.plotB - 2, Math.max(L.plotT + 2, L.yOf(mid)));
        ctx.fillStyle = T.tag;
        ctx.fillRect(L.w - L.padR + 3, y - 9, L.padR - 6, 18);
        ctx.fillStyle = T.gold;
        ctx.fillText(this.fmtPrice(mid), L.w - 8, y);
      }
    }
    this.paintLevelLabels(L);

    // Time axis: as many stamps as fit, never overlapping.
    ctx.textAlign = "center";
    ctx.fillStyle = T.muted;
    ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
    const room = Math.max(1, Math.floor((L.plotR - L.plotL) / 86));
    const step = Math.max(1, Math.ceil(L.rows.length / room));
    for (let i = 0; i < L.rows.length; i += step) {
      const r = L.rows[i];
      if (!r || !r.t) continue;
      const label = String(r.t).slice(5, 16).replace("T", " ");
      ctx.fillText(label, L.xOf(i), L.axisB + 14);
    }
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  /**
   * The crosshair, with a price tag on the axis and a time tag under it.
   *
   * It is drawn last and outside the plot clip so the tags sit on the axes
   * rather than being cut off by them.
   */
  paintCrosshair(L) {
    if (!this.hover || this.crosshair === "none") return;
    const ctx = this.ctx;
    const T = chartTheme();
    const i = this.hover.i;
    const x = L.xOf(i);
    const y = this.hover.y;
    if (this.crosshair === "dot") {
      ctx.fillStyle = T.text;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.save();
    ctx.strokeStyle = T.line;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, L.plotT); ctx.lineTo(x, L.axisB); ctx.stroke();
    if (y >= L.plotT && y <= L.plotB) {
      ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
      ctx.setLineDash([]);
      const p = L.pOf(y);
      const text = this.fmtPrice(p);
      const tw = ctx.measureText(text).width + 12;
      ctx.fillStyle = T.text;
      ctx.fillRect(L.w - L.padR + 3, y - 9, Math.min(L.padR - 6, tw), 18);
      ctx.fillStyle = T.panel;
      ctx.textBaseline = "middle";
      ctx.fillText(text, L.w - L.padR + 8, y);
      ctx.textBaseline = "alphabetic";
    }
    ctx.setLineDash([]);
    const row = L.rows[i];
    if (row && row.t) {
      const label = String(row.t).slice(5, 16).replace("T", " ");
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = T.text;
      ctx.fillRect(x - tw / 2, L.axisB + 2, tw, 16);
      ctx.fillStyle = T.panel;
      ctx.textAlign = "center";
      ctx.fillText(label, x, L.axisB + 14);
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  /**
   * The OHLC readout.
   *
   * It used to be a filled panel sitting on top of the candles in the corner
   * where the price action usually is. It is now a single line of text along
   * the top, the way a terminal does it, so it never covers anything.
   */
  paintLegend(L) {
    const ctx = this.ctx;
    const T = chartTheme();
    const r = (this.hover && L.rows[this.hover.i]) || L.rows[L.rows.length - 1];
    if (!r) return;
    const up = r.c >= r.o;
    const parts = [
      ["O", this.fmtPrice(r.o)], ["H", this.fmtPrice(r.h)],
      ["L", this.fmtPrice(r.l)], ["C", this.fmtPrice(r.c)],
    ];
    let x = L.plotL + 4;
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    ctx.textBaseline = "top";
    parts.forEach(([k, v]) => {
      ctx.fillStyle = T.muted;
      ctx.fillText(k, x, 2);
      x += ctx.measureText(k).width + 3;
      ctx.fillStyle = up ? T.up : T.down;
      ctx.fillText(v, x, 2);
      x += ctx.measureText(v).width + 10;
    });
    const dp = r.c - r.o;
    const pct = r.o ? (dp / r.o) * 100 : 0;
    ctx.fillStyle = up ? T.up : T.down;
    ctx.fillText((dp >= 0 ? "+" : "") + this.fmtPrice(dp) + "  (" + pct.toFixed(2) + "%)", x, 2);

    // Main-pane indicator names, so what is on the chart is always named.
    let ix = L.plotL + 4;
    let iy = 16;
    for (const ind of this.indicators) {
      const def = this.indicatorDef(ind.type);
      if (!def || def.pane !== "main") continue;
      const label = def.short + (ind.params.period ? " " + ind.params.period : "");
      ctx.fillStyle = ind.visible === false ? T.muted : this.plotColor(def.plots[0].color, ind);
      ctx.globalAlpha = ind.visible === false ? 0.5 : 1;
      ctx.fillText(label, ix, iy);
      ctx.globalAlpha = 1;
      ix += ctx.measureText(label).width + 10;
    }
    ctx.textBaseline = "alphabetic";
  }
  paintLevels(L) {
    const ctx = this.ctx;
    for (const pos of this.levels || []) {
      const sl = Number(pos.sl || 0);
      const tp = Number(pos.tp || 0);
      const open = Number(pos.price_open || 0);
      if (open) {
        const y = L.yOf(open);
        ctx.strokeStyle = "rgba(" + chartTheme().goldT + ",.55)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (sl) {
        const y = L.yOf(sl);
        ctx.strokeStyle = "rgba(" + chartTheme().downT + ",.95)";
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
        ctx.fillStyle = "rgba(" + chartTheme().downT + ",.16)";
        const yOpen = open ? L.yOf(open) : y;
        ctx.fillRect(L.plotL, Math.min(y, yOpen), L.plotR - L.plotL, Math.abs(yOpen - y));
      }
      if (tp) {
        const y = L.yOf(tp);
        ctx.strokeStyle = "rgba(" + chartTheme().upT + ",.95)";
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
        ctx.fillStyle = "rgba(" + chartTheme().upT + ",.12)";
        const yOpen = open ? L.yOf(open) : y;
        ctx.fillRect(L.plotL, Math.min(y, yOpen), L.plotR - L.plotL, Math.abs(yOpen - y));
      }
      ctx.lineWidth = 1.4;
    }
  }
  paintPending(L) {
    const ctx = this.ctx;
    const sl = Number(this.pending && this.pending.sl || 0);
    const tp = Number(this.pending && this.pending.tp || 0);
    const draw = (p, col, label) => {
      if (!p) return;
      const y = L.yOf(p);
      ctx.strokeStyle = col;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = chartTheme().panel;
      const text = label + " " + this.fmtPrice(p);
      ctx.fillRect(L.plotL + 6, y - 9, Math.min(150, ctx.measureText(text).width + 14), 18);
      ctx.fillStyle = col;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, L.plotL + 12, y);
    };
    draw(sl, chartTheme().down, "SL");
    draw(tp, chartTheme().up, "TP");
    ctx.lineWidth = 1.4;
  }
  paintSignals(L) {
    // Rebuilt every paint rather than cached: the markers move with every
    // pan, zoom and new bar, and a stale hit box is worse than none - it
    // puts the card on a signal the pointer is nowhere near.
    this._sigHits = [];
    if (!this.showSignals || !this.signals || !this.signals.length) return;
    const ctx = this.ctx;
    const rows = L.rows;
    // Build map time->index for fast lookup, but also use index if available
    const timeMap = new Map();
    for (let i = 0; i < rows.length; i++) {
      timeMap.set(rows[i].t, i);
    }
    for (const sig of this.signals) {
      let idx = -1;
      if (Number.isFinite(sig.index)) {
        // global index, convert to local slice
        const globalIdx = Number(sig.index);
        idx = globalIdx - L.start;
      }
      if (idx < 0 || idx >= rows.length) {
        if (sig.time && timeMap.has(sig.time)) {
          idx = timeMap.get(sig.time);
        } else continue;
      }
      const row = rows[idx];
      if (!row) continue;
      const x = L.xOf(idx);
      const price = Number(sig.price || row.c);
      const y = L.yOf(price);
      const isBuy = sig.type === "buy" || sig.side === "buy";
      const col = isBuy ? chartTheme().up : chartTheme().down;
      const bg = isBuy ? "rgba(" + chartTheme().upT + ",0.18)" : "rgba(" + chartTheme().downT + ",0.18)";
      // Triangle marker
      ctx.save();
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (isBuy) {
        // up triangle below candle
        const yy = L.yOf(row.l) + 14;
        ctx.moveTo(x, yy - 8);
        ctx.lineTo(x - 6, yy + 2);
        ctx.lineTo(x + 6, yy + 2);
        ctx.closePath();
        ctx.fill();
        // label BUY
        ctx.fillStyle = bg;
        ctx.fillRect(x - 18, yy + 6, 36, 14);
        ctx.fillStyle = col;
        ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
        ctx.textAlign = "center";
        ctx.fillText("BUY", x, yy + 16);
      } else {
        const yy = L.yOf(row.h) - 14;
        ctx.moveTo(x, yy + 8);
        ctx.lineTo(x - 6, yy - 2);
        ctx.lineTo(x + 6, yy - 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = bg;
        ctx.fillRect(x - 20, yy - 20, 40, 14);
        ctx.fillStyle = col;
        ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
        ctx.textAlign = "center";
        ctx.fillText("SELL", x, yy - 10);
      }
      // confidence dot
      const conf = Number(sig.confidence || 0);
      if (conf >= 0.7) {
        ctx.beginPath();
        ctx.arc(x, isBuy ? L.yOf(row.l) + 26 : L.yOf(row.h) - 26, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = chartTheme().gold;
        ctx.fill();
      }
      ctx.restore();

      // The marker's clickable / hoverable area. Deliberately larger than
      // the triangle: a 12px arrow is not a pointer target, and a trader
      // chasing one with the mouse while price moves is a trader not
      // reading the chart.
      const anchorY = isBuy ? L.yOf(row.l) + 14 : L.yOf(row.h) - 14;
      const box = {
        x: x - 22, y: isBuy ? anchorY - 10 : anchorY - 24,
        w: 44, h: 36, cx: x, cy: anchorY, sig,
      };
      this._sigHits.push(box);
      if (this._isPinned(sig)) {
        this._sigHover = box;
        // A ring around the pinned mark, so it still reads as "this one"
        // after the card is dismissed by the first mouse move.
        ctx.save();
        ctx.strokeStyle = chartTheme().gold;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(x, anchorY, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * Show a signal's card without the trader hovering it, and scroll the
   * window until the mark is actually on screen.
   *
   * This is what a clicked notification calls: landing on the chart with
   * the signal somewhere off the left edge, uncarded, would answer none of
   * the questions that made the trader click.
   */
  pinSignal(sig) {
    if (!sig) return;
    this._pinned = sig;
    const total = this.rows().length;
    const idx = Number(sig.index);
    if (Number.isFinite(idx) && total) {
      const { start, end } = this.slice();
      if (idx < start + 2 || idx >= end - 2) {
        // Park it a third of the way in from the right, so the bars that
        // followed the signal - whether it worked - are visible too.
        const target = Math.round(idx + this.span / 3);
        this.offset = Math.max(0, total - target);
        this.clampOffset();
      }
    }
    this.draw();
  }

  /** Does this hit box belong to the signal that was pinned? */
  _isPinned(sig) {
    const want = this._pinned;
    if (!want) return false;
    if (want === sig) return true;
    if (want.time && sig.time) return want.time === sig.time && want.type === sig.type;
    return Number.isFinite(want.index) && want.index === sig.index && want.type === sig.type;
  }

  /** The signal under the pointer, or null. Newest wins when they overlap. */
  signalAt(x, y) {
    const hits = this._sigHits || [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    }
    return null;
  }

  /**
   * The card that appears when the pointer rests on a signal.
   *
   * Everything a trader needs in order to act on the mark is here: which
   * strategy produced it, where it wanted in, where the stop and target
   * went, and what it risked to make that. Without this the arrow says
   * "buy" and nothing else, which is an instruction rather than a case.
   *
   * Drawn last, outside the plot clip, so it is never cut off by an axis.
   */
  paintSignalCard(L) {
    const hit = this._sigHover;
    if (!hit) return;
    const sig = hit.sig;
    const ctx = this.ctx;
    const T = chartTheme();
    const isBuy = sig.type === "buy" || sig.side === "buy";
    const accent = isBuy ? T.up : T.down;

    const num = (v) => (Number(v) ? this.fmtPrice(Number(v)) : "—");
    const rows = [
      [this.i18n("signal.entry", "Entry"), num(sig.entry || sig.price)],
      [this.i18n("signal.sl", "SL"), num(sig.sl)],
      [this.i18n("signal.tp", "TP"), num(sig.tp)],
    ];
    if (Number(sig.rr)) rows.push([this.i18n("signal.rr", "R:R"), Number(sig.rr).toFixed(2)]);
    if (Number(sig.confidence)) {
      rows.push([this.i18n("signal.confidence", "Confidence"), Math.round(Number(sig.confidence) * 100) + "%"]);
    }

    const title = (isBuy ? "BUY" : "SELL") + "  " + String(sig.strategy || "").toUpperCase();
    ctx.save();
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";

    // Wrap the reason to the card width instead of letting it run off the
    // edge. The reason is the whole point of the card for King, which says
    // which five confluences agreed.
    const maxW = 250;
    const reason = String(sig.reason || "");
    const lines = [];
    if (reason) {
      let line = "";
      for (const word of reason.split(/\s+/)) {
        const probe = line ? line + " " + word : word;
        if (ctx.measureText(probe).width > maxW - 20 && line) { lines.push(line); line = word; }
        else line = probe;
        if (lines.length >= 4) break;
      }
      if (line && lines.length < 4) lines.push(line);
    }

    const padX = 10, padY = 9, lh = 15;
    const w = maxW;
    const h = padY * 2 + 18 + rows.length * lh + (lines.length ? lines.length * 13 + 6 : 0);

    // Keep the card on the canvas whichever edge the signal is near.
    let cx = hit.cx + 16;
    let cy = hit.cy - h / 2;
    if (cx + w > L.plotR) cx = hit.cx - 16 - w;
    if (cx < L.plotL) cx = L.plotL + 4;
    cy = Math.max(L.plotT + 4, Math.min(cy, L.plotB - h - 4));

    ctx.fillStyle = T.panel;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(cx, cy, w, h, 7); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(cx, cy, w, h); ctx.strokeRect(cx, cy, w, h); }

    let y = cy + padY + 9;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = accent;
    ctx.font = "bold 11px IBM Plex Mono, Vazirmatn, monospace";
    ctx.fillText(title, cx + padX, y);
    y += 18;

    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    for (const [label, value] of rows) {
      ctx.fillStyle = T.muted;
      ctx.fillText(label, cx + padX, y);
      ctx.fillStyle = label === this.i18n("signal.sl", "SL") ? T.down
        : label === this.i18n("signal.tp", "TP") ? T.up : T.text;
      ctx.textAlign = "right";
      ctx.fillText(value, cx + w - padX, y);
      ctx.textAlign = "left";
      y += lh;
    }
    if (lines.length) {
      y += 4;
      ctx.fillStyle = T.muted;
      ctx.font = "10px IBM Plex Mono, Vazirmatn, monospace";
      for (const line of lines) { ctx.fillText(line, cx + padX, y); y += 13; }
    }
    ctx.restore();
  }

  /** Translate if the desk's dictionary is around; fall back to English. */
  i18n(key, fallback) {
    try {
      const t = window.I18N && window.I18N.t ? window.I18N.t(key) : key;
      return !t || t === key ? fallback : t;
    } catch (e) { return fallback; }
  }
  paintLevelLabels(L) {
    const ctx = this.ctx;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    for (const pos of this.levels || []) {
      const items = [
        [Number(pos.sl || 0), chartTheme().down, "SL"],
        [Number(pos.tp || 0), chartTheme().up, "TP"],
        [Number(pos.price_open || 0), chartTheme().gold, String(pos.type || "POS").toUpperCase()],
      ];
      for (const [p, col, label] of items) {
        if (!p) continue;
        const y = Math.min(L.plotB - 2, Math.max(L.plotT + 2, L.yOf(p)));
        const text = label + " " + this.fmtPrice(p);
        const tw = Math.min(160, ctx.measureText(text).width + 14);
        ctx.fillStyle = chartTheme().panel;
        ctx.fillRect(L.plotL + 6, y - 9, tw, 18);
        ctx.fillStyle = col;
        ctx.fillText(text, L.plotL + 12, y);
      }
    }
  }

  /* ============================================================= shapes == */

  /** The anchors of a drawing, in the order they were placed. */
  anchorKeys(d) {
    // A position is placed with two clicks - entry, then stop - but it has
    // three things a trader needs to move: the target is an anchor too, so
    // it can be dragged and typed rather than only derived from a multiple.
    if (d.kind === "long" || d.kind === "short") return d.c ? ["a", "b", "c"] : ["a", "b"];
    const n = SHAPE_POINTS[d.kind];
    if (n === -1) return [];
    return ["a", "b", "c", "d", "e", "f", "g"].slice(0, Math.max(1, n || 2));
  }

  anchorPoints(d) {
    if (SHAPE_POINTS[d.kind] === -1) return Array.isArray(d.pts) ? d.pts : [];
    return this.anchorKeys(d).map((k) => d[k]).filter(Boolean);
  }

  /** Apply an object's own styling to the context. Returns its colour. */
  styleFor(L, d, ghost) {
    const ctx = this.ctx;
    const T = chartTheme();
    const color = d.color || T.gold;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Number(d.width) || 1.4;
    ctx.globalAlpha = ghost ? 0.65 : (d.opacity === undefined ? 1 : Number(d.opacity));
    ctx.setLineDash(DASHES[d.style] || []);
    return color;
  }

  /** Semi-transparent version of a colour, for fills. */
  wash(color, alpha) {
    const T = chartTheme();
    const hex = /^#([0-9a-f]{6})$/i.exec(String(color || ""));
    if (hex) {
      const n = parseInt(hex[1], 16);
      return "rgba(" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",") + "," + alpha + ")";
    }
    return "rgba(" + T.goldT + "," + alpha + ")";
  }

  /** A small text tag with the chart's panel colour behind it. */
  tag(x, y, text, color, align) {
    const ctx = this.ctx;
    const T = chartTheme();
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    const w = ctx.measureText(text).width + 12;
    const left = align === "end" ? x - w : x;
    ctx.fillStyle = T.panel;
    ctx.fillRect(left, y - 9, w, 18);
    ctx.fillStyle = color || T.text;
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + 6, y);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  strokePath(points, opts) {
    const ctx = this.ctx;
    if (!points.length) return;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    if (opts && opts.close) ctx.closePath();
    if (opts && opts.fill) {
      const save = ctx.fillStyle;
      ctx.fillStyle = opts.fill;
      ctx.fill();
      ctx.fillStyle = save;
    }
    ctx.stroke();
  }

  arrowHead(a, b, size) {
    const ctx = this.ctx;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const s = size || 10;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - s * Math.cos(ang - 0.4), b.y - s * Math.sin(ang - 0.4));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - s * Math.cos(ang + 0.4), b.y - s * Math.sin(ang + 0.4));
    ctx.stroke();
  }

  /** Extend a segment to the plot edge in one or both directions. */
  extend(L, a, b, left, right) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const far = (L.plotR - L.plotL) + (L.plotB - L.plotT);
    const ux = (dx / len) * far, uy = (dy / len) * far;
    return {
      a: left ? { x: a.x - ux, y: a.y - uy } : a,
      b: right ? { x: b.x + ux, y: b.y + uy } : b,
    };
  }

  paintShape(L, d, ghost) {
    const ctx = this.ctx;
    const T = chartTheme();
    ctx.save();
    const color = this.styleFor(L, d, ghost);
    const kind = d.kind;
    const P = this.anchorPoints(d).map((pt) => this.xyOf(L, pt)).filter(Boolean);
    const a = P[0], b = P[1], c = P[2];

    /* ---- horizontals and verticals ------------------------------------ */
    if (kind === "hline" || kind === "hray" || kind === "priceline") {
      if (a) {
        const y = L.yOf(d.a.p);
        ctx.beginPath();
        ctx.moveTo(kind === "hray" ? a.x : L.plotL, y);
        ctx.lineTo(L.plotR, y);
        ctx.stroke();
        // Every price line now says what price it is. A horizontal line
        // with no number is a line the trader has to read off the axis by
        // eye, which is exactly the measurement they drew it to avoid.
        if (d.showPrice !== false) this.tag(L.plotR, y, this.fmtPrice(d.a.p), color, "end");
      }
    } else if (kind === "vline" || kind === "dateline") {
      if (a) {
        ctx.beginPath(); ctx.moveTo(a.x, L.plotT); ctx.lineTo(a.x, L.plotB); ctx.stroke();
        if (kind === "dateline" && d.a.t) this.tag(a.x, L.plotT + 10, String(d.a.t).slice(5, 16), color);
      }
    } else if (kind === "crossline") {
      if (a) {
        const y = L.yOf(d.a.p);
        ctx.beginPath();
        ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y);
        ctx.moveTo(a.x, L.plotT); ctx.lineTo(a.x, L.plotB);
        ctx.stroke();
        if (d.showPrice !== false) this.tag(L.plotR, y, this.fmtPrice(d.a.p), color, "end");
      }

    /* ---- straight lines ------------------------------------------------ */
    } else if (kind === "trend" || kind === "ray" || kind === "extended" ||
               kind === "arrow" || kind === "infoline" || kind === "measure") {
      if (a && b) {
        const seg = this.extend(L, a, b,
          kind === "extended" || d.extendL, kind === "ray" || kind === "extended" || d.extendR);
        this.strokePath([seg.a, seg.b]);
        if (kind === "arrow") this.arrowHead(a, b, 11);
        // A sloped line has a different price at every x, so the number
        // that means something is the one where it leaves the chart - the
        // level it is pointing at, which is why it was drawn.
        if (kind !== "measure" && kind !== "infoline" && d.showPrice !== false) {
          const far = seg.b.x >= seg.a.x ? seg.b : seg.a;
          const ex = Math.max(L.plotL + 8, Math.min(L.plotR, far.x));
          const t = (ex - seg.a.x) / ((seg.b.x - seg.a.x) || 1);
          const ey = Math.max(L.plotT + 9, Math.min(L.plotB - 9, seg.a.y + t * (seg.b.y - seg.a.y)));
          this.tag(ex, ey, this.fmtPrice(L.pOf(ey)), color, "end");
        }
        if (kind === "measure" || kind === "infoline") {
          const dp = d.b.p - d.a.p;
          const bars = Math.abs((d.b.gi || 0) - (d.a.gi || 0));
          const pct = d.a.p ? (dp / d.a.p) * 100 : 0;
          this.tag((a.x + b.x) / 2, (a.y + b.y) / 2 - 14,
            this.fmtPrice(dp) + "  " + pct.toFixed(2) + "%  " + bars + "b",
            dp >= 0 ? T.up : T.down);
        }
      }

    /* ---- channels ------------------------------------------------------ */
    } else if (kind === "parallel" || kind === "channel" || kind === "flatchannel" || kind === "disjoint") {
      if (a && b) {
        this.strokePath([a, b]);
        const third = kind === "disjoint" ? P[2] : c;
        if (third) {
          const dx = kind === "flatchannel" ? 0 : b.x - a.x;
          const dy = kind === "flatchannel" ? 0 : b.y - a.y;
          const c2 = kind === "disjoint" && P[3]
            ? P[3]
            : { x: third.x + (kind === "flatchannel" ? (b.x - a.x) : dx), y: third.y + dy };
          this.strokePath([third, c2]);
          if (d.fill !== false) {
            ctx.save();
            ctx.fillStyle = this.wash(color, 0.08);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            ctx.lineTo(c2.x, c2.y); ctx.lineTo(third.x, third.y);
            ctx.closePath(); ctx.fill();
            ctx.restore();
          }
          if (kind === "channel") {
            ctx.save();
            ctx.globalAlpha = 0.5;
            this.strokePath([{ x: (a.x + third.x) / 2, y: (a.y + third.y) / 2 },
              { x: (b.x + c2.x) / 2, y: (b.y + c2.y) / 2 }]);
            ctx.restore();
          }
        }
      }
    } else if (kind === "regression") {
      if (a && b) {
        // A real least-squares fit over the bars between the two anchors,
        // with one and two standard deviations either side.
        const i0 = Math.max(0, Math.min(d.a.gi, d.b.gi) - L.start);
        const i1 = Math.min(L.rows.length - 1, Math.max(d.a.gi, d.b.gi) - L.start);
        const fitRows = L.rows.slice(i0, i1 + 1);
        const lib = (typeof window !== "undefined" && window.AurionSeries) || null;
        const reg = lib && fitRows.length > 1 ? lib.regression(fitRows) : null;
        if (reg) {
          const y0 = L.yOf(reg.intercept);
          const y1 = L.yOf(reg.intercept + reg.slope * (fitRows.length - 1));
          const x0 = L.xOf(i0), x1 = L.xOf(i1);
          this.strokePath([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
          [1, 2].forEach((k) => {
            ctx.save();
            ctx.globalAlpha = (ctx.globalAlpha || 1) * (k === 1 ? 0.75 : 0.45);
            ctx.setLineDash([4, 4]);
            [1, -1].forEach((sgn) => {
              this.strokePath([
                { x: x0, y: L.yOf(reg.intercept + sgn * k * reg.sigma) },
                { x: x1, y: L.yOf(reg.intercept + reg.slope * (fitRows.length - 1) + sgn * k * reg.sigma) },
              ]);
            });
            ctx.restore();
          });
          this.tag(x1, y1 - 12, (reg.slope >= 0 ? "+" : "") + this.fmtPrice(reg.slope) + "/bar", color, "end");
        }
      }
    } else if (kind === "pitchfork" || kind === "schiff" || kind === "modschiff") {
      if (a && b && c) {
        // Schiff moves the handle's origin to the midpoint of A-B; the
        // modified version puts it halfway along the handle instead.
        let origin = a;
        if (kind === "schiff") origin = { x: a.x, y: (a.y + b.y) / 2 };
        if (kind === "modschiff") origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
        const dx = mid.x - origin.x, dy = mid.y - origin.y;
        const len = Math.hypot(dx, dy) || 1;
        const far = ((L.plotR - L.plotL) + (L.plotB - L.plotT)) / len;
        const proj = (p) => ({ x: p.x + dx * far, y: p.y + dy * far });
        this.strokePath([origin, mid]);
        [[origin, mid], [b, proj(b)], [c, proj(c)]].forEach(([s, e], i) => {
          ctx.save();
          if (i) ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.85;
          this.strokePath([s, i ? e : proj(origin)]);
          ctx.restore();
        });
        if (d.fill !== false) {
          ctx.save();
          ctx.fillStyle = this.wash(color, 0.06);
          ctx.beginPath();
          ctx.moveTo(b.x, b.y); ctx.lineTo(proj(b).x, proj(b).y);
          ctx.lineTo(proj(c).x, proj(c).y); ctx.lineTo(c.x, c.y);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }

    /* ---- fibonacci ----------------------------------------------------- */
    } else if (kind === "fib" || kind === "fibext" || kind === "fibchannel") {
      const levels = this.fibLevels(d);
      if (a && b) {
        const base = kind === "fibext" && c ? c : a;
        const from = kind === "fibext" && c ? d.c.p : d.a.p;
        const to = kind === "fibext" && c ? d.c.p + (d.b.p - d.a.p) : d.b.p;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const tail = Math.min(L.plotR, x1 + (x1 - x0) * 0.38);
        if (kind === "fibchannel" && c) {
          // Levels run parallel to the A-B line instead of flat.
          const dyc = c.y - a.y;
          levels.forEach((lv) => {
            const off = dyc * lv.value;
            ctx.save();
            ctx.strokeStyle = lv.color || color;
            ctx.globalAlpha = (ctx.globalAlpha || 1) * (lv.strong ? 1 : 0.75);
            this.strokePath([{ x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }]);
            ctx.restore();
            ctx.fillStyle = T.fib;
            ctx.fillText(lv.label, b.x + 4, b.y + off - 3);
          });
        } else {
          for (let i = 0; i < levels.length - 1 && d.fill !== false; i++) {
            const yA = L.yOf(from + (to - from) * levels[i].value);
            const yB = L.yOf(from + (to - from) * levels[i + 1].value);
            ctx.save();
            ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.5;
            ctx.fillStyle = this.wash(levels[i].color || color, i % 2 ? 0.05 : 0.09);
            ctx.fillRect(x0, Math.min(yA, yB), tail - x0, Math.abs(yB - yA));
            ctx.restore();
          }
          levels.forEach((lv) => {
            const p = from + (to - from) * lv.value;
            const y = L.yOf(p);
            ctx.save();
            ctx.strokeStyle = lv.color || color;
            ctx.lineWidth = lv.strong ? 1.7 : 1;
            this.strokePath([{ x: x0, y }, { x: tail, y }]);
            ctx.restore();
            ctx.fillStyle = T.fib;
            ctx.fillText(lv.label + "  " + this.fmtPrice(p), x0 + 6, y - 3);
          });
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.55;
          this.strokePath(kind === "fibext" && c ? [a, b, c] : [a, b]);
          ctx.restore();
        }
      }
    } else if (kind === "fibtime") {
      if (a && b) {
        const span = (b.x - a.x) || 1;
        this.fibLevels(d).forEach((lv) => {
          const x = a.x + span * lv.value;
          ctx.save();
          ctx.strokeStyle = lv.color || color;
          ctx.lineWidth = lv.strong ? 1.6 : 1;
          this.strokePath([{ x, y: L.plotT }, { x, y: L.plotB }]);
          ctx.restore();
          ctx.fillStyle = T.fib;
          ctx.fillText(lv.label, x + 4, L.plotT + 12);
        });
      }
    } else if (kind === "fibcircle" || kind === "fibarc" || kind === "fibspiral") {
      if (a && b) {
        const r = Math.hypot(b.x - a.x, b.y - a.y);
        if (kind === "fibspiral") {
          // A golden spiral out of quarter arcs, growing by phi each turn.
          const phi = 1.618033988749;
          ctx.beginPath();
          let rad = r / Math.pow(phi, 4);
          let cx = a.x, cy = a.y, ang = 0;
          for (let i = 0; i < 8; i++) {
            ctx.arc(cx, cy, rad, ang, ang + Math.PI / 2);
            const nx = cx + Math.cos(ang + Math.PI / 2) * rad;
            const ny = cy + Math.sin(ang + Math.PI / 2) * rad;
            const nr = rad * phi;
            cx = nx - Math.cos(ang + Math.PI / 2) * nr;
            cy = ny - Math.sin(ang + Math.PI / 2) * nr;
            rad = nr;
            ang += Math.PI / 2;
          }
          ctx.stroke();
        } else {
          this.fibLevels(d).forEach((lv) => {
            if (!lv.value) return;
            ctx.save();
            ctx.strokeStyle = lv.color || color;
            ctx.lineWidth = lv.strong ? 1.6 : 1;
            ctx.beginPath();
            if (kind === "fibarc") ctx.arc(a.x, a.y, r * lv.value, Math.PI, Math.PI * 2);
            else ctx.arc(a.x, a.y, r * lv.value, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = T.fib;
            ctx.fillText(lv.label, a.x + r * lv.value + 3, a.y - 3);
          });
        }
      }
    } else if (kind === "fibwedge") {
      if (a && b && c) {
        this.fibLevels(d).forEach((lv) => {
          ctx.save();
          ctx.strokeStyle = lv.color || color;
          this.strokePath([a, { x: b.x + (c.x - b.x) * lv.value, y: b.y + (c.y - b.y) * lv.value }]);
          ctx.restore();
        });
      }

    /* ---- gann ---------------------------------------------------------- */
    } else if (kind === "gannfan") {
      if (a && b) {
        const ratios = [[1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [1, 4], [4, 1], [1, 8], [8, 1]];
        const dx = b.x - a.x, dy = b.y - a.y;
        ratios.forEach(([rx, ry], i) => {
          ctx.save();
          ctx.globalAlpha = (ctx.globalAlpha || 1) * (rx === ry ? 1 : 0.6);
          ctx.lineWidth = rx === ry ? 1.7 : 1;
          const k = 6;
          this.strokePath([a, { x: a.x + dx * (rx / ry) * k, y: a.y + dy * k }]);
          ctx.restore();
          if (rx === ry) this.tag(a.x + dx, a.y + dy, "1×1", color);
        });
      }
    } else if (kind === "gannbox" || kind === "gannsquare") {
      if (a && b) {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const parts = kind === "gannsquare" ? [0.25, 0.5, 0.75] : [0.25, 0.382, 0.5, 0.618, 0.75];
        ctx.save();
        ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.55;
        parts.forEach((p) => {
          this.strokePath([{ x: x0 + (x1 - x0) * p, y: y0 }, { x: x0 + (x1 - x0) * p, y: y1 }]);
          this.strokePath([{ x: x0, y: y0 + (y1 - y0) * p }, { x: x1, y: y0 + (y1 - y0) * p }]);
        });
        if (kind === "gannsquare") {
          this.strokePath([{ x: x0, y: y1 }, { x: x1, y: y0 }]);
          this.strokePath([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
        }
        ctx.restore();
      }

    /* ---- geometry ------------------------------------------------------ */
    } else if (kind === "rect" || kind === "daterange" || kind === "pricerange") {
      if (a && b) {
        let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (kind === "daterange") { y = L.plotT; h = L.plotB - L.plotT; }
        if (kind === "pricerange") { x = L.plotL; w = L.plotR - L.plotL; }
        if (d.fill !== false) {
          ctx.save();
          ctx.fillStyle = this.wash(color, 0.12);
          ctx.fillRect(x, y, w, h);
          ctx.restore();
        }
        ctx.strokeRect(x, y, w, h);
        if (kind === "pricerange" || kind === "daterange") {
          const dp = d.b.p - d.a.p;
          const pct = d.a.p ? (dp / d.a.p) * 100 : 0;
          const bars = Math.abs((d.b.gi || 0) - (d.a.gi || 0));
          const text = kind === "pricerange"
            ? this.fmtPrice(Math.abs(dp)) + "  " + Math.abs(pct).toFixed(2) + "%"
            : bars + " bars";
          this.tag(x + 8, y + h / 2, text, dp >= 0 ? T.up : T.down);
        }
      }
    } else if (kind === "rotrect") {
      if (a && b) {
        const c3 = c || b;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const off = c ? ((c3.x - b.x) * nx + (c3.y - b.y) * ny) : 0;
        this.strokePath([
          a, b, { x: b.x + nx * off, y: b.y + ny * off }, { x: a.x + nx * off, y: a.y + ny * off },
        ], { close: true, fill: d.fill !== false ? this.wash(color, 0.1) : null });
      }
    } else if (kind === "circle") {
      if (a && b) {
        const r = Math.max(3, Math.hypot(b.x - a.x, b.y - a.y));
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        if (d.fill !== false) { ctx.save(); ctx.fillStyle = this.wash(color, 0.1); ctx.fill(); ctx.restore(); }
        ctx.stroke();
      }
    } else if (kind === "ellipse") {
      if (a && b) {
        ctx.beginPath();
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
          Math.max(2, Math.abs(b.x - a.x) / 2), Math.max(2, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
        if (d.fill !== false) { ctx.save(); ctx.fillStyle = this.wash(color, 0.1); ctx.fill(); ctx.restore(); }
        ctx.stroke();
      }
    } else if (kind === "triangle") {
      if (a && b) {
        this.strokePath(c ? [a, b, c] : [a, b],
          { close: Boolean(c), fill: c && d.fill !== false ? this.wash(color, 0.1) : null });
      }
    } else if (kind === "arc" || kind === "curve" || kind === "doublecurve") {
      if (a && b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        if (c) ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
        else ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (kind === "doublecurve" && P[3]) {
          ctx.beginPath();
          ctx.moveTo(b.x, b.y);
          ctx.quadraticCurveTo(P[3].x, P[3].y, P[3].x, P[3].y);
          ctx.stroke();
        }
      }
    } else if (kind === "polyline" || kind === "polygon" || kind === "path") {
      const pts = (d.pts || []).map((p) => this.xyOf(L, p)).filter(Boolean);
      if (pts.length > 1) {
        this.strokePath(pts, {
          close: kind === "polygon",
          fill: kind === "polygon" && d.fill !== false ? this.wash(color, 0.1) : null,
        });
        if (kind === "path") this.arrowHead(pts[pts.length - 2], pts[pts.length - 1], 10);
      }

    /* ---- positions and risk ------------------------------------------- */
    } else if (kind === "long" || kind === "short") {
      if (a && b) this.paintPosition(L, d, a, b, kind === "long");

    /* ---- patterns ------------------------------------------------------ */
    } else if (SHAPE_LABELS[kind]) {
      this.paintPattern(L, d, P, color);

    /* ---- annotation ---------------------------------------------------- */
    } else if (kind === "text" || kind === "emoji" || kind === "note" ||
               kind === "label" || kind === "pricelabel" || kind === "flag") {
      if (a) this.paintAnnotation(L, d, a, color);
    } else if (kind === "callout") {
      if (a && b) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        this.strokePath([a, b]);
        ctx.restore();
        this.paintAnnotation(L, d, b, color);
      }

    /* ---- freehand ------------------------------------------------------ */
    } else if (kind === "brush" || kind === "highlighter" || kind === "freearrow") {
      const pts = (d.pts || []).map((p) => this.xyOf(L, p)).filter(Boolean);
      if (pts.length > 1) {
        ctx.save();
        if (kind === "highlighter") {
          ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.3;
          ctx.lineWidth = Math.max(8, (Number(d.width) || 1.4) * 8);
          ctx.lineCap = "round";
        }
        ctx.lineJoin = "round";
        // Quadratic smoothing through the midpoints: a freehand line drawn
        // with a mouse is a staircase without it.
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
        ctx.restore();
        if (kind === "freearrow") this.arrowHead(pts[pts.length - 2], pts[pts.length - 1], 12);
      }
    }

    /* ---- the handles --------------------------------------------------- */
    if (!ghost && this.selected === d) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const pts = SHAPE_POINTS[kind] === -1 ? [] : P;
      pts.forEach((pt) => {
        ctx.fillStyle = d.locked ? T.muted : T.text;
        ctx.strokeStyle = T.panel;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      });
    }
    ctx.restore();
  }

  /** The level table for a fib tool: its own, or the default for its kind. */
  fibLevels(d) {
    const T = chartTheme();
    if (Array.isArray(d.levels) && d.levels.length) {
      return d.levels.filter((l) => l && l.visible !== false).map((l) => ({
        value: Number(l.value),
        label: l.label || (Number(l.value) * 100).toFixed(1) + "%",
        strong: Boolean(l.strong),
        color: l.color || "",
      }));
    }
    const sets = {
      fib: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
      fibext: [0, 0.618, 1, 1.272, 1.618, 2, 2.618],
      fibchannel: [0, 0.382, 0.5, 0.618, 1, 1.618],
      fibtime: [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618],
      fibcircle: [0.236, 0.382, 0.5, 0.618, 1],
      fibarc: [0.382, 0.5, 0.618, 1],
      fibwedge: [0.236, 0.382, 0.5, 0.618, 1],
    };
    const strong = { 0.5: 1, 0.618: 1, 1.618: 1 };
    return (sets[d.kind] || sets.fib).map((v) => ({
      value: v,
      label: (v * 100).toFixed(1).replace(/\.0$/, "") + "%",
      strong: Boolean(strong[v]),
      color: strong[v] ? T.up : "",
    }));
  }

  /**
   * A long or short position.
   *
   * Entry and stop come from the two anchors; the target is projected at the
   * object's own reward multiple. The zones are drawn to scale, so a trade
   * with a bad ratio looks bad before the numbers are read. The numbers
   * describe the drawing, not a forecast - nothing here is an outcome.
   */
  paintPosition(L, d, a, b, long) {
    const ctx = this.ctx;
    const T = chartTheme();
    const entry = d.a.p;
    const stop = d.b.p;
    const risk = Math.abs(entry - stop);
    const rr = Number(d.rr || 2);
    const target = d.c && Number.isFinite(d.c.p)
      ? Number(d.c.p)
      : (long ? entry + risk * rr : entry - risk * rr);
    const pts = [a, b].concat(d.c ? [this.xyOf(L, d.c)].filter(Boolean) : []);
    const x = Math.min(...pts.map((p) => p.x));
    const w = Math.max(56, Math.max(...pts.map((p) => p.x)) - x);
    const yEntry = L.yOf(entry), yStop = L.yOf(stop), yTarget = L.yOf(target);

    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(" + T.downT + ",.14)";
    ctx.fillRect(x, Math.min(yEntry, yStop), w, Math.abs(yStop - yEntry));
    ctx.fillStyle = "rgba(" + T.upT + ",.14)";
    ctx.fillRect(x, Math.min(yEntry, yTarget), w, Math.abs(yTarget - yEntry));

    ctx.setLineDash([4, 3]);
    [[yStop, T.down], [yTarget, T.up]].forEach(([yy, col]) => {
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = T.text;
    ctx.beginPath(); ctx.moveTo(x, yEntry); ctx.lineTo(x + w, yEntry); ctx.stroke();

    const reward = Math.abs(target - entry);
    const pctR = entry ? (risk / entry) * 100 : 0;
    const pctW = entry ? (reward / entry) * 100 : 0;
    const lines = [
      (long ? "LONG" : "SHORT") + "   " + (risk ? (reward / risk).toFixed(2) : "—") + " R",
      "entry  " + this.fmtPrice(entry),
      "stop   " + this.fmtPrice(stop) + "   −" + this.fmtPrice(risk) + "  " + pctR.toFixed(2) + "%",
      "target " + this.fmtPrice(target) + "   +" + this.fmtPrice(reward) + "  " + pctW.toFixed(2) + "%",
    ];
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    const bw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
    const bh = lines.length * 14 + 10;
    let by = Math.min(yTarget, yStop) - bh - 4;
    if (by < L.plotT) by = Math.max(yTarget, yStop) + 6;
    ctx.fillStyle = T.panel;
    ctx.fillRect(x, by, bw, bh);
    lines.forEach((t, i) => {
      ctx.fillStyle = i === 0 ? (long ? T.up : T.down) : T.muted;
      ctx.fillText(t, x + 8, by + 16 + i * 14);
    });
    ctx.restore();
  }

  /**
   * The pattern family: a labelled polyline with the leg ratios written on it.
   *
   * Every harmonic is the same drawing with different rules, so they are one
   * renderer. For the named ones the actual retracement of each leg is
   * measured and shown against the textbook range - the tool marks what the
   * trader drew, it does not claim the pattern is valid.
   */
  paintPattern(L, d, P, color) {
    const ctx = this.ctx;
    const T = chartTheme();
    const labels = SHAPE_LABELS[d.kind] || [];
    if (P.length < 2) return;
    this.strokePath(P, {
      close: false,
      fill: d.fill !== false && P.length > 3 ? this.wash(color, 0.06) : null,
    });
    if (d.fill !== false && P.length >= 4) {
      // Shade the triangles the eye is meant to compare.
      ctx.save();
      ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.5;
      ctx.fillStyle = this.wash(color, 0.08);
      for (let i = 0; i + 2 < P.length; i += 2) {
        ctx.beginPath();
        ctx.moveTo(P[i].x, P[i].y);
        ctx.lineTo(P[i + 1].x, P[i + 1].y);
        ctx.lineTo(P[i + 2].x, P[i + 2].y);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = "11px Outfit, Vazirmatn, sans-serif";
    P.forEach((pt, i) => {
      const text = (d.labels && d.labels[i]) || labels[i] || "";
      if (!text) return;
      const above = i === 0 || !P[i - 1] || pt.y <= P[i - 1].y;
      this.tag(pt.x - 9, pt.y + (above ? -14 : 16), text, color);
    });

    const rules = HARMONIC_RULES[d.kind];
    if (rules && P.length === 5) {
      const pts = this.anchorPoints(d);
      const leg = (i, j) => Math.abs(pts[j].p - pts[i].p);
      const ratios = [
        ["AB", leg(1, 2) / (leg(0, 1) || 1), rules.AB],
        ["BC", leg(2, 3) / (leg(1, 2) || 1), rules.BC],
        ["CD", leg(3, 4) / (leg(2, 3) || 1), rules.CD],
        ["XD", leg(0, 4) / (leg(0, 1) || 1), rules.XD],
      ];
      let y = Math.min(...P.map((p) => p.y)) - 8;
      const x = Math.max(...P.map((p) => p.x)) + 8;
      ratios.forEach(([name, got, want], i) => {
        const ok = got >= want[0] * 0.9 && got <= want[1] * 1.1;
        this.tag(x, y + i * 18, name + " " + got.toFixed(3), ok ? T.up : T.muted);
      });
    }
    ctx.restore();
  }

  /** Text, notes, labels, flags - everything that is words on the chart. */
  paintAnnotation(L, d, at, color) {
    const ctx = this.ctx;
    const T = chartTheme();
    const kind = d.kind;
    const text = kind === "pricelabel" ? this.fmtPrice(d.a.p) : (d.text || "");
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = d.opacity === undefined ? 1 : Number(d.opacity);
    const size = Number(d.fontSize) || (kind === "emoji" ? 18 : 13);
    const weight = d.bold ? "600 " : "";
    ctx.font = weight + size + "px " + (kind === "emoji" ? "sans-serif" : "Outfit, Vazirmatn, sans-serif");
    ctx.textBaseline = "middle";
    ctx.textAlign = d.align === "center" ? "center" : (d.align === "end" ? "right" : "left");

    if (kind === "flag") {
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(at.x, at.y); ctx.lineTo(at.x, at.y - 22); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(at.x, at.y - 22); ctx.lineTo(at.x + 16, at.y - 18); ctx.lineTo(at.x, at.y - 13);
      ctx.closePath(); ctx.fill();
      if (text) { ctx.fillStyle = T.text; ctx.fillText(text, at.x + 20, at.y - 18); }
      ctx.restore();
      return;
    }

    const w = ctx.measureText(text).width;
    if (kind === "note" || kind === "label" || kind === "pricelabel" || kind === "callout") {
      const padX = 8, padY = 5;
      const bx = at.x - (ctx.textAlign === "center" ? w / 2 : 0) - padX;
      const by = at.y - size / 2 - padY;
      ctx.fillStyle = d.background || this.wash(color, kind === "note" ? 0.16 : 0.9);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const r = 5, bw = w + padX * 2, bh = size + padY * 2;
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
      ctx.arcTo(bx, by + bh, bx, by, r);
      ctx.arcTo(bx, by, bx + bw, by, r);
      ctx.closePath();
      ctx.fill();
      if (kind === "note") ctx.stroke();
      ctx.fillStyle = kind === "note" ? T.text : (d.textColor || T.tag);
    } else {
      ctx.fillStyle = d.textColor || color;
    }
    ctx.fillText(text, at.x, at.y);
    ctx.restore();
  }

  /* ========================================================== hit-testing == */

  hit(e) {
    const L = this._L || this.layout();
    if (!L) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const i = Math.max(0, Math.min(L.rows.length - 1, L.iOf(x)));
    const row = L.rows[i];
    // gx is where the pointer really is, in bar units and unclamped: it can
    // sit between two bars, before the first or out in the empty margin past
    // the last. Everything that is drawn uses it; only the legend and the
    // crosshair use the snapped index.
    return {
      L, x, y, i, gi: L.start + i,
      gx: (x - L.padL) / (L.bw || 1) - 0.5 + L.start,
      t: row ? row.t : "",
      p: L.pOf(y),
      onPriceAxis: x > L.plotR,
      onTimeAxis: y > L.axisB - 6,
      valid: x >= L.plotL && x <= L.plotR && y >= L.plotT && y <= L.plotB,
    };
  }

  /**
   * Magnet.
   *
   * Weak pulls to the nearest of the bar's four prices only when the pointer
   * is already close to one; strong always takes the nearest. Time snapping
   * is separate and on by default, because a drawing that sits between two
   * bars is never what anybody meant.
   */
  snapHit(hit) {
    if (!hit || !hit.L) return hit;
    if (this.magnet === "off") return hit;
    const row = hit.L.rows[hit.i];
    if (!row) return hit;
    let best = hit.p, bd = this.magnet === "strong" ? Infinity : 14;
    for (const p of [row.o, row.h, row.l, row.c]) {
      const d = Math.abs(hit.L.yOf(p) - hit.y);
      if (d < bd) { bd = d; best = p; }
    }
    hit.p = best;
    return hit;
  }

  /** Tools that must never be pinned to a bar. */
  static get FREEHAND() { return { brush: 1, highlighter: 1, freearrow: 1, polyline: 1, path: 1, polygon: 1 }; }

  /**
   * A point in data space.
   *
   * `gx` is the honest position and is always kept. `t` is only recorded
   * when the anchor is meant to belong to a particular bar - and never for
   * the freehand tools, which is what used to flatten a brush stroke onto
   * the candles: every sample was being rewritten to the nearest bar's
   * timestamp, so a curve drawn between two candles, or out in the margin
   * past the last one, collapsed onto them.
   */
  point(hit, opts) {
    const free = (opts && opts.free) || CandleChart.FREEHAND[this.tool];
    return {
      t: this.snapTime && !free ? hit.t : "",
      p: hit.p,
      gi: hit.gi,
      gx: hit.gx,
    };
  }

  xyOf(L, pt) {
    if (!pt) return null;

    /* A point placed with a continuous coordinate keeps it. This is what
       lets a drawing live between two bars, above the highest high or out
       in the empty margin to the right of the newest candle - anywhere the
       trader put it, rather than on the nearest available bar. */
    if (Number.isFinite(pt.gx) && !pt.t) {
      const x = L.padL + (pt.gx - L.start + 0.5) * L.bw;
      const far = (L.plotR - L.plotL) * 3;
      if (x < L.plotL - far || x > L.plotR + far) {
        if (pt.p == null) return null;
        return { x: x < L.plotL ? L.plotL - 4 : L.plotR + 4, y: L.yOf(pt.p), off: true, i: -1 };
      }
      return { x, y: L.yOf(pt.p), i: Math.round(pt.gx - L.start) };
    }

    let i = -1;
    if (pt.t) i = L.rows.findIndex((r) => r.t === pt.t);
    if (i < 0 && Number.isFinite(pt.gx)) {
      const x = L.padL + (pt.gx - L.start + 0.5) * L.bw;
      return { x, y: L.yOf(pt.p), i: Math.round(pt.gx - L.start) };
    }
    if (i < 0 && Number.isFinite(pt.gi)) i = pt.gi - L.start;
    if (i < 0 || i >= L.cells) {
      // Off-screen anchors still position a line: clamp to the edge so a
      // trend line drawn last week does not vanish when it scrolls away.
      if (pt.p == null) return null;
      const x = i < 0 ? L.plotL - 4 : L.plotR + 4;
      return { x, y: L.yOf(pt.p), off: true, i };
    }
    return { x: L.xOf(i), y: L.yOf(pt.p), i };
  }

  shapeAt(L, x, y) {
    const near = 8;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.visible === false) continue;
      const pts = this.anchorPoints(d).map((p) => this.xyOf(L, p)).filter(Boolean);
      const keys = this.anchorKeys(d);
      for (let k = 0; k < pts.length; k++) {
        if (Math.hypot(pts[k].x - x, pts[k].y - y) <= near + 3) {
          return { shape: d, index: i, handle: d.locked ? null : keys[k] };
        }
      }
      const kind = d.kind;
      if (kind === "hline" || kind === "hray" || kind === "priceline") {
        if (pts[0] && Math.abs(y - pts[0].y) <= near) return { shape: d, index: i, handle: null };
        continue;
      }
      if (kind === "vline" || kind === "dateline") {
        if (pts[0] && Math.abs(x - pts[0].x) <= near) return { shape: d, index: i, handle: null };
        continue;
      }
      if (kind === "rect" || kind === "circle" || kind === "ellipse" ||
          kind === "long" || kind === "short" || kind === "gannbox" || kind === "gannsquare" ||
          kind === "daterange" || kind === "pricerange") {
        if (pts.length > 1) {
          const x0 = Math.min(pts[0].x, pts[1].x) - near, x1 = Math.max(pts[0].x, pts[1].x) + near;
          const y0 = Math.min(pts[0].y, pts[1].y) - near, y1 = Math.max(pts[0].y, pts[1].y) + near;
          const inX = kind === "pricerange" ? true : x >= x0 && x <= x1;
          const inY = kind === "daterange" ? true : y >= y0 && y <= y1;
          if (inX && inY) return { shape: d, index: i, handle: null };
        }
        continue;
      }
      const free = Array.isArray(d.pts) ? d.pts.map((p) => this.xyOf(L, p)).filter(Boolean) : [];
      const chain = free.length ? free : pts;
      for (let k = 0; k + 1 < chain.length; k++) {
        if (this.nearSegment(x, y, chain[k], chain[k + 1]) <= near) {
          return { shape: d, index: i, handle: null };
        }
      }
      if (chain.length === 1 && Math.hypot(chain[0].x - x, chain[0].y - y) <= near + 8) {
        return { shape: d, index: i, handle: null };
      }
    }
    return null;
  }

  nearSegment(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (!len) return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  pendingHit(L, y) {
    const sl = Number(this.pending && this.pending.sl || 0);
    const tp = Number(this.pending && this.pending.tp || 0);
    let best = null, bd = 10;
    for (const [k, p] of [["sl", sl], ["tp", tp]]) {
      if (!p) continue;
      const d = Math.abs(L.yOf(p) - y);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  moveSelected(from, to, handle) {
    const d = this.selected;
    if (!d || d.locked || !from || !to) return;
    const dGi = (to.gi || 0) - (from.gi || 0);
    const dP = (to.p || 0) - (from.p || 0);
    const dGx = (to.gx === undefined || from.gx === undefined) ? dGi : (to.gx - from.gx);
    const shift = (pt) => {
      if (!pt) return pt;
      pt.gi = (pt.gi || 0) + dGi;
      if (Number.isFinite(pt.gx)) pt.gx += dGx;
      pt.p = (pt.p || 0) + dP;
      pt.t = "";
      return pt;
    };
    // Dragging a position by its entry moves the trade; dragging the stop
    // or the target moves only that leg, which is how the ratio is set.
    if (handle === "a" && (d.kind === "long" || d.kind === "short")) {
      this.anchorKeys(d).forEach((k) => shift(d[k]));
    } else if (handle && d[handle]) shift(d[handle]);
    else {
      this.anchorKeys(d).forEach((k) => shift(d[k]));
      if (Array.isArray(d.pts)) d.pts.forEach(shift);
    }
    this.draw();
  }

  /* ========================================================== navigation == */

  maxOffset() { return Math.max(0, this.rows().length - Math.round(this.span * 0.2)); }

  /** How far past the newest bar the chart may be pulled. */
  minOffset() { return -Math.floor(this.span * 0.45); }

  /**
   * Zoom.
   *
   * Around the pointer, not the middle: zooming into a chart and finding the
   * candle you were looking at has moved is the single most common way a web
   * chart feels amateur. `at` is a bar index in the visible slice.
   */
  zoom(dir, at) {
    const total = this.rows().length;
    if (!total) return;
    const before = this.span;
    const factor = dir > 0 ? 0.82 : 1 / 0.82;
    this.span = Math.max(8, Math.min(Math.max(20, total + this.rightPad), Math.round(before * factor)));
    if (at !== undefined && at !== null && before) {
      // Keep the bar under the cursor in place by moving the window's end.
      const share = Math.max(0, Math.min(1, at / before));
      const delta = Math.round((this.span - before) * (1 - share));
      this.offset = this.offset + delta;
    }
    this.clampOffset();
    this.draw();
  }

  /**
   * Scroll the window by a number of bars.
   *
   * Positive goes back in time. The sign convention for *dragging* is the
   * one thing this file cannot get wrong: the chart is a sheet of paper
   * under the hand, so whatever the pointer does, the candles do. Drag
   * right and the candles go right, which means older bars come into view
   * and the offset grows. It used to be the opposite, and it was also
   * negated again for right-to-left layouts - which made the gesture
   * backwards in English and correct by accident in Persian. The canvas is
   * never mirrored, so direction does not depend on the language at all.
   */
  pan(bars) {
    this.offset += bars;
    this.clampOffset();
    this.draw();
  }

  clampOffset() {
    this.offset = Math.max(this.minOffset(), Math.min(this.maxOffset(), this.offset));
  }

  /**
   * Stretch or compress the price axis around one price.
   *
   * Around a chosen price rather than the middle of the window, so the
   * candle under the cursor stays under the cursor while the rest of the
   * chart grows or shrinks away from it. Done in log space when the axis is
   * logarithmic, or the anchor drifts on one of the two scales.
   */
  scaleAround(start, k) {
    this.scale.auto = false;
    const log = this.scale.log && start.mn > 0 && start.at > 0;
    const f = log ? Math.log : (x) => x;
    const fi = log ? Math.exp : (x) => x;
    const a = f(start.at);
    const lo = f(start.mn);
    const hi = f(start.mx);
    const mn = fi(a - (a - lo) * k);
    const mx = fi(a + (hi - a) * k);
    if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx - mn <= 0) return;
    this.scale.mn = mn;
    this.scale.mx = mx;
  }

  /**
   * The readout that appears while the scale is being stretched.
   *
   * Without it the gesture is invisible until the candles have already
   * moved, and a control the user cannot see engaging is a control they
   * will assume is not there. It fades on its own.
   */
  flashStretch(x, y, ratio) {
    this._stretch = { x, y, ratio, until: Date.now() + 900 };
    // Guarded: the engine is also run head-less by the tests, where there
    // is no timer. The readout is decoration and must never be the reason
    // a frame throws.
    if (typeof setTimeout !== "function") return;
    if (this._stretchTimer) clearTimeout(this._stretchTimer);
    this._stretchTimer = setTimeout(() => {
      this._stretch = null;
      this._stretchTimer = 0;
      this.draw();
    }, 950);
  }

  paintStretch(L) {
    const st = this._stretch;
    if (!st) return;
    const live = this.drag && this.drag.mode === "stretch";
    if (!live && Date.now() > st.until) return;
    const T = chartTheme();
    const ctx = this.ctx;
    const pct = Math.round((st.ratio || 1) * 100);
    const text = "\u2195 " + pct + "%";
    ctx.save();
    ctx.font = "12px IBM Plex Mono, Vazirmatn, monospace";
    const w = ctx.measureText(text).width + 20;
    const x = Math.max(L.plotL + 4, Math.min(L.plotR - w - 4, st.x + 14));
    const y = Math.max(L.plotT + 14, Math.min(L.plotB - 14, st.y));
    ctx.fillStyle = T.panel;
    ctx.strokeStyle = "rgb(" + T.goldT + " / .55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 9;
    ctx.moveTo(x + r, y - 13);
    ctx.arcTo(x + w, y - 13, x + w, y + 13, r);
    ctx.arcTo(x + w, y + 13, x, y + 13, r);
    ctx.arcTo(x, y + 13, x, y - 13, r);
    ctx.arcTo(x, y - 13, x + w, y - 13, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = T.gold;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 10, y);
    ctx.restore();
  }

  /** Stretch or compress the price axis around its middle. */
  scaleBy(k) {
    const L = this._L || this.layout();
    if (!L) return;
    const mid = (L.mn + L.mx) / 2;
    const half = ((L.mx - L.mn) / 2) * k;
    this.scale.auto = false;
    this.scale.mn = mid - half;
    this.scale.mx = mid + half;
    this.draw();
  }

  /**
   * Move the price window by a number of pixels.
   *
   * Used by the right-button drag. The arithmetic is done in whatever space
   * the axis is in - linear or logarithmic - so the chart follows the cursor
   * exactly on both, and inverted axes drag the right way round.
   */
  panPrice(start, dy) {
    const h = start.plotH || 1;
    const dir = this.scale.invert ? -1 : 1;
    this.scale.auto = false;
    if (this.scale.log && start.mn > 0) {
      const a = Math.log(start.mn), b = Math.log(start.mx);
      const k = ((b - a) / h) * dy * dir;
      this.scale.mn = Math.exp(a + k);
      this.scale.mx = Math.exp(b + k);
    } else {
      const k = ((start.mx - start.mn) / h) * dy * dir;
      this.scale.mn = start.mn + k;
      this.scale.mx = start.mx + k;
    }
  }

  shiftScale(dp) {
    const L = this._L || this.layout();
    if (!L) return;
    this.scale.auto = false;
    this.scale.mn = (this.scale.mn === null ? L.mn : this.scale.mn) + dp;
    this.scale.mx = (this.scale.mx === null ? L.mx : this.scale.mx) + dp;
    this.draw();
  }

  setAutoScale(on) {
    this.scale.auto = on !== false;
    if (this.scale.auto) { this.scale.mn = null; this.scale.mx = null; }
    this.saveState();
    this.draw();
  }

  setLogScale(on) { this.scale.log = Boolean(on); this.saveState(); this.draw(); }
  setPercentScale(on) { this.scale.percent = Boolean(on); this.saveState(); this.draw(); }
  setInvertScale(on) { this.scale.invert = Boolean(on); this.saveState(); this.draw(); }

  fit() {
    this.offset = 0;
    this.rightPad = 0;
    this.span = Math.min(160, Math.max(30, this.rows().length || 40));
    this.setAutoScale(true);
    this.draw();
  }

  resetView() { this.fit(); }

  /* ========================================================= interaction == */

  /**
   * The wheel.
   *
   *   wheel            zoom around the pointer
   *   shift + wheel    pan sideways
   *   ctrl/cmd wheel   zoom, for the trackpads that send pinch that way
   *
   * Over the price axis the wheel scales the price instead, which is what
   * every terminal does and what makes a chart feel unlocked.
   */
  onWheel(e) {
    e.preventDefault();
    const hit = this.hit(e);
    const dir = e.deltaY > 0 ? -1 : 1;
    if (hit && hit.onPriceAxis) { this.scaleBy(dir > 0 ? 0.9 : 1.1); return; }
    /* ctrl means "vertical" everywhere on this chart: with the right button
       it stretches by dragging, with the wheel it stretches by scrolling.
       Both are anchored on the price under the pointer. */
    if ((e.ctrlKey || e.metaKey) && hit) {
      const L = hit.L;
      this.scaleAround({ mn: L.mn, mx: L.mx, at: hit.p }, dir > 0 ? 0.88 : 1 / 0.88);
      this.flashStretch(hit.x, hit.y, (L.mx - L.mn) / Math.max(1e-12, this.scale.mx - this.scale.mn));
      this.draw();
      return;
    }
    if (e.shiftKey && !e.ctrlKey) {
      // Wheel down goes forward in time, the way scrolling down a document
      // goes forward through it.
      this.pan(Math.round((e.deltaY > 0 ? -1 : 1) * Math.max(1, this.span * 0.08)));
      return;
    }
    this.zoom(dir, hit ? hit.i : null);
  }

  onDouble(e) {
    const hit = this.hit(e);
    if (hit && hit.onPriceAxis) { this.setAutoScale(true); return; }
    if (this.tool === "cursor" && hit) {
      const found = this.shapeAt(hit.L, hit.x, hit.y);
      if (found) {
        this.select(found.shape);
        if (typeof this.opts.onEdit === "function") this.opts.onEdit(found.shape);
        return;
      }
    }
    this.fit();
  }

  /**
   * The browser's own menu is always refused on the canvas.
   *
   * The right button is a navigation control here, and which of mousedown or
   * mouseup fires this event depends on the platform - so deciding anything
   * in it would behave differently on Windows and on Linux. The decision is
   * made in onUp instead, where it is known whether the pointer moved.
   */
  onContext(e) {
    e.preventDefault();
  }

  /** How many points this tool still needs before the shape is finished. */
  needs(kind) {
    const n = SHAPE_POINTS[kind];
    return n === undefined ? 2 : n;
  }

  placed(d) {
    if (Array.isArray(d.pts)) return d.pts.length;
    return this.anchorKeys(d).filter((k) => d[k]).length;
  }

  askText(kind, pt, after) {
    const finish = (txt) => {
      if (!txt && kind !== "note") return;
      const obj = this.addObject({
        kind, a: pt, text: txt,
        color: chartTheme().gold,
      });
      if (typeof after === "function") after(obj);
    };
    if (typeof this.opts.onText === "function") {
      this.opts.onText(kind === "emoji" ? "📌" : "", finish);
      return;
    }
    finish(window.prompt("", kind === "emoji" ? "📌" : "") || "");
  }

  onDown(e) {
    this._moved = false;
    const raw = this.hit(e);
    if (!raw) return;
    const hit = this.snapHit(raw);

    /* ---- the right button: take the chart anywhere --------------------
       Before the axes and before any tool, because this is the gesture that
       has to work from inside whatever the trader is doing. Press and drag
       moves time and price together, so the chart goes wherever the hand
       goes - including past the newest bar, into the empty margin. */
    if (e.button === 2) {
      this._rightDrag = false;
      // Hold ctrl (or cmd) and the same button stretches the candles
      // instead of moving them - the price axis, adjusted from wherever the
      // pointer already is rather than by travelling to the edge of the
      // screen to grab the scale.
      const stretch = e.ctrlKey || e.metaKey;
      this.drag = {
        mode: stretch ? "stretch" : "free",
        x: e.clientX, y: e.clientY,
        off: this.offset,
        mn: raw.L.mn, mx: raw.L.mx,
        at: raw.p,
        plotH: raw.L.plotB - raw.L.plotT,
        bw: raw.L.bw,
      };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      this.canvas.style.cursor = stretch ? "ns-resize" : "grabbing";
      return;
    }

    /* ---- the axes are controls too ------------------------------------ */
    if (raw.onPriceAxis) {
      this.drag = { mode: "scale", y: e.clientY, mn: (this._L || {}).mn, mx: (this._L || {}).mx };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "ns-resize";
      return;
    }
    if (raw.onTimeAxis) {
      this.drag = { mode: "timescale", x: e.clientX, span: this.span };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "ew-resize";
      return;
    }

    /* ---- middle button or held space always pans ---------------------- */
    if (e.button === 1 || this._space || this.tool === "pan") {
      this.drag = { mode: "pan", x: e.clientX, off: this.offset };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;

    /* ---- a drawing in progress ---------------------------------------- */
    if (this.draft) {
      const need = this.needs(this.draft.kind);
      if (need === -1) return;
      const keys = this.anchorKeys(this.draft);
      const at = this.placed(this.draft);
      if (at < need) {
        this.draft[keys[at]] = this.point(hit);
        if (at + 1 >= need) this.commitDraft();
        else this.draw();
        return;
      }
    }

    /* ---- the cursor: select, drag, or set a level --------------------- */
    if (this.tool === "cursor" || this.tool === "eraser") {
      const kind = this.pendingHit(hit.L, hit.y);
      if (kind && this.tool === "cursor") {
        this.dragLevel = kind;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = "ns-resize";
        return;
      }
      const found = this.shapeAt(hit.L, hit.x, hit.y);
      if (this.tool === "eraser") {
        if (found) this.removeObject(found.shape);
        return;
      }
      if (found) {
        this.select(found.shape);
        if (!found.shape.locked) {
          this.snapshot();
          this.drag = { mode: "shape", from: this.point(hit), handle: found.handle };
          this.canvas.setPointerCapture(e.pointerId);
          this.canvas.style.cursor = "move";
        }
        return;
      }
      if (this.selected) this.select(null);
      if (this.pickPrice) { this._priceClick = hit.p; return; }
      this.drag = { mode: "pan", x: e.clientX, off: this.offset };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      return;
    }

    /* ---- an existing shape, while a tool is armed ----------------------
       Keeping the tool armed is only usable if the drawings already on the
       chart stay reachable. A click that lands on one selects and moves it
       instead of starting a new drawing; hold Alt to draw across a shape
       on purpose. Without this, "the tool stays on" would mean "nothing
       can ever be adjusted again". */
    if (!e.altKey && this.tool !== "pan") {
      const over = this.shapeAt(hit.L, hit.x, hit.y);
      if (over) {
        this.select(over.shape);
        if (!over.shape.locked) {
          this.snapshot();
          this.drag = { mode: "shape", from: this.point(hit), handle: over.handle };
          this.canvas.setPointerCapture(e.pointerId);
          this.canvas.style.cursor = "move";
        }
        return;
      }
      if (this.selected) this.select(null);
    }

    /* ---- starting a new drawing --------------------------------------- */
    const pt = this.point(hit);
    const need = this.needs(this.tool);
    if (this.tool === "text" || this.tool === "emoji" || this.tool === "note" ||
        this.tool === "label" || this.tool === "flag") {
      this.askText(this.tool, pt, () => { if (this.opts.onToolDone) this.opts.onToolDone(); });
      return;
    }
    if (need === 1) {
      const obj = this.addObject({ kind: this.tool, a: pt, color: this.colorFor(this.tool) });
      this.select(obj);
      if (this.opts.onToolDone) this.opts.onToolDone();
      return;
    }
    if (need === -1) {
      this.draft = { kind: this.tool, pts: [pt], a: pt, b: pt, color: this.colorFor(this.tool), width: this.tool === "highlighter" ? 2 : 1.4 };
      return;
    }
    this.draft = { kind: this.tool, a: pt, b: pt, color: this.colorFor(this.tool) };
  }

  colorFor(tool) {
    const T = chartTheme();
    if (tool === "long") return T.up;
    if (tool === "short") return T.down;
    if (tool.indexOf("fib") === 0) return T.violet;
    return T.gold;
  }

  commitDraft() {
    if (!this.draft) return;
    const d = this.draft;
    this.draft = null;
    if ((d.kind === "long" || d.kind === "short") && d.a && d.b && !d.c) {
      // The target starts at twice the risk, which is a starting point and
      // not a recommendation; from then on it is a handle like any other.
      const risk = Math.abs(d.a.p - d.b.p);
      const rr = Number(d.rr || 2);
      d.c = {
        t: "", p: d.kind === "long" ? d.a.p + risk * rr : d.a.p - risk * rr,
        gi: d.b.gi, gx: d.b.gx,
      };
    }
    const obj = this.addObject(d);
    this.select(obj);
    if (typeof this.opts.onToolDone === "function") this.opts.onToolDone();
  }

  onMove(e) {
    this._moved = true;
    const raw = this.hit(e);
    if (!raw) return;
    const hit = this.snapHit(raw);
    this.hover = raw.valid ? { i: raw.i, y: raw.y } : null;

    // Signal cards. Only repaint when the hovered signal actually changes,
    // or every mouse move across the chart would force a full redraw.
    const overSignal = raw.valid && !this.drag && !this.dragLevel ? this.signalAt(raw.x, raw.y) : null;
    const wasOver = this._sigHover;
    if (this._pinned && overSignal && !this._isPinned(overSignal.sig)) this._pinned = null;
    if ((overSignal && overSignal.sig) !== (wasOver && wasOver.sig)) {
      this._sigHover = overSignal;
      this.draw();
      return;
    }

    if (this.dragLevel) {
      const p = raw.L.pOf(raw.y);
      this.pending = Object.assign({}, this.pending, { [this.dragLevel]: p });
      if (typeof this.opts.onPending === "function") this.opts.onPending(Object.assign({}, this.pending, { kind: this.dragLevel }));
      this.draw();
      return;
    }

    if (this.drag) {
      if (this.drag.mode === "pan") {
        const L = this._L || this.layout();
        if (L) {
          const dx = e.clientX - this.drag.x;
          this.offset = this.drag.off + Math.round(dx / L.bw);
          this.clampOffset();
        }
      } else if (this.drag.mode === "free") {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._rightDrag = true;
        this.offset = this.drag.off + Math.round(dx / (this.drag.bw || 1));
        this.clampOffset();
        this.panPrice(this.drag, dy);
      } else if (this.drag.mode === "stretch") {
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dy) > 2) this._rightDrag = true;
        // Down compresses, up stretches - the same direction as dragging
        // the price axis itself, so the two gestures cannot disagree.
        const k = Math.max(0.12, Math.min(9, 1 + dy / 200));
        this.scaleAround(this.drag, k);
        this.flashStretch(raw.x, raw.y, 1 / k);
      } else if (this.drag.mode === "scale") {
        const dy = e.clientY - this.drag.y;
        const k = Math.max(0.2, 1 + dy / 220);
        const mid = (this.drag.mn + this.drag.mx) / 2;
        const half = ((this.drag.mx - this.drag.mn) / 2) * k;
        this.scale.auto = false;
        this.scale.mn = mid - half;
        this.scale.mx = mid + half;
      } else if (this.drag.mode === "timescale") {
        const dx = e.clientX - this.drag.x;
        this.span = Math.max(8, Math.min(Math.max(20, this.rows().length), Math.round(this.drag.span * (1 - dx / 300))));
        this.clampOffset();
      } else if (this.drag.mode === "shape") {
        const to = this.point(hit);
        this.moveSelected(this.drag.from, to, this.drag.handle);
        this.drag.from = to;
        return;
      }
      this.draw();
      return;
    }

    if (this.draft) {
      const pt = this.point(hit);
      if (Array.isArray(this.draft.pts) && this.needs(this.draft.kind) === -1) {
        this.draft.pts = this.draft.pts.concat([pt]).slice(-600);
        this.draft.b = pt;
      } else {
        const keys = this.anchorKeys(this.draft);
        const at = Math.max(1, this.placed(this.draft));
        this.draft[keys[Math.min(at, keys.length - 1)]] = pt;
      }
    }
    this.draw();
  }

  onUp(e) {
    if (this.drag && (this.drag.mode === "free" || this.drag.mode === "stretch")) {
      if (this.drag.mode === "stretch" && this._stretch) this._stretch.until = Date.now() + 700;
      this.drag = null;
      this.canvas.style.cursor = this.cursorFor();
      // A right *click* that never moved is not navigation; offer it to the
      // interface as a context menu instead. A right *drag* is swallowed.
      if (!this._rightDrag && typeof this.opts.onMenu === "function" && e) {
        const hit = this.hit(e);
        this.opts.onMenu({
          x: e.clientX, y: e.clientY,
          shape: hit ? (this.shapeAt(hit.L, hit.x, hit.y) || {}).shape || null : null,
          price: hit ? hit.p : null,
        });
      }
      this.draw();
      return;
    }
    if (this.dragLevel) {
      this.dragLevel = null;
      this.canvas.style.cursor = this.cursorFor();
      this.draw();
      return;
    }
    if (this.drag && this.drag.mode === "shape") {
      this.drag = null;
      this.canvas.style.cursor = this.cursorFor();
      this.persist();
      this.changed();
      return;
    }
    if (this.pickPrice && this._priceClick != null && typeof this.opts.onPrice === "function") {
      this.opts.onPrice(this._priceClick);
      this._priceClick = null;
      this.pickPrice = false;
      this.drag = null;
      this.draw();
      return;
    }
    if (!this._moved && this.tool === "cursor" && !this.selected && typeof this.opts.onPrice === "function") {
      const hit = this.hit(e || { clientX: 0, clientY: 0 });
      if (hit && hit.valid) this.opts.onPrice(hit.p);
    }
    if (this.draft) {
      const need = this.needs(this.draft.kind);
      if (need === -1) {
        if ((this.draft.pts || []).length > 1) this.commitDraft();
        else this.draft = null;
      } else if (this._moved && this.placed(this.draft) >= 2 && need === 2) {
        this.commitDraft();
      }
    }
    this.drag = null;
    this.canvas.style.cursor = this.cursorFor();
    this.draw();
  }

  /** Escape: drop the draft first, then the selection. */
  cancel() {
    if (this.draft) { this.draft = null; this.draw(); return true; }
    if (this.selected) { this.select(null); return true; }
    return false;
  }

  onTouch(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const d = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const mid = (t1.clientX + t2.clientX) / 2;
      if (!this.pinch) { this.pinch = { d, span: this.span, mid, off: this.offset }; return; }
      const k = this.pinch.d / (d || 1);
      this.span = Math.max(8, Math.min(Math.max(20, this.rows().length), Math.round(this.pinch.span * k)));
      const L = this._L || this.layout();
      if (L) {
        const dx = mid - this.pinch.mid;
        this.offset = this.pinch.off + Math.round(dx / L.bw);
        this.clampOffset();
      }
      this.draw();
    } else this.pinch = null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MARKET_SESSIONS, sessionCovers, sessionsAt, sessionOpensBetween,
    SHAPE_POINTS, SHAPE_LABELS, CandleChart,
  };
}
