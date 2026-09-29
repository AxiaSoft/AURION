/* ===========================================================================
   AURION — the chart workspace
   ===========================================================================
   The interface around the canvas: the top bar, the drawing rail, the right
   dock and everything that opens out of them.

   Why it is its own file. The old chart toolbar was twenty-eight equal
   buttons in a row across the top of the desk, growing by one every time a
   tool was added, with the zoom, the magnet and the bin mixed in among the
   drawing tools. It could not be organised further in place - the shape of
   it was the problem. This file replaces that shape.

   The rules it is built on:

     1. Every tool comes from ONE table. The rail, the flyouts, the
        shortcuts, the tooltips and the object names are all generated from
        it, so a new tool is one row here and nothing else.
     2. Nothing appears that does not work. A tool is only in the table if
        the engine can draw it; there are no placeholder buttons anywhere in
        this interface.
     3. The chart is the page. Panels are overlays or collapsible columns,
        never a frame the chart has to fit inside.
   =========================================================================== */
(function (global) {
  "use strict";

  /* ============================================================== icons == */
  /* One visual language: 24×24, 1.6 stroke, no fills, no emoji anywhere. */

  const I = {
    cursor: "M5 3l14 8-6 1.6L10.5 20z",
    cross: "M12 3v18M3 12h18",
    dot: "M12 10.6a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8M12 3v4M12 17v4M3 12h4M17 12h4",
    eraser: "M4 16l7-7 5 5-4 4H6zM13 6l3-3 5 5-3 3",
    magnet: "M7 4v8a5 5 0 0010 0V4M7 4H4v8a8 8 0 0016 0V4h-3",
    trend: "M4 18L20 6",
    ray: "M4 18L20 6M15 6h5v5",
    extended: "M2 20L22 4",
    hline: "M3 12h18",
    hray: "M8 12h13M8 9v6",
    vline: "M12 3v18",
    crossline: "M3 14h18M10 3v18",
    priceline: "M3 12h12M16 8h5v8h-5z",
    dateline: "M12 3v18M8 3h8",
    arrow: "M5 19L19 5M13 5h6v6",
    infoline: "M4 18L20 6M11 3h4v4h-4z",
    parallel: "M4 16L14 6M9 20L19 10",
    channel: "M4 16L14 6M9 20L19 10M6.5 18L16.5 8",
    flatchannel: "M4 8h16M4 16h16M4 8v8",
    disjoint: "M3 14L10 7M13 17L21 9",
    regression: "M4 19L20 7M5 15l4-2 4 1 5-4M4 20h16",
    pitchfork: "M4 20L12 4L20 20M12 4v16",
    schiff: "M6 20L12 8L18 20M12 8V4",
    modschiff: "M6 20L12 10L18 20M12 10L9 4",
    fib: "M4 6h16M4 10h16M4 14h11M4 18h16",
    fibext: "M4 5h16M4 10h16M4 15h9M4 20h16M20 15h-4",
    fibchannel: "M3 10L21 4M3 15L21 9M3 20L21 14",
    fibtime: "M6 4v16M10 4v16M16 4v16",
    fibcircle: "M12 12a9 9 0 100 .01M12 12a5 5 0 100 .01M12 12a2 2 0 100 .01",
    fibarc: "M3 20a9 9 0 0118 0M7 20a5 5 0 0110 0",
    fibspiral: "M13 12a2 2 0 10-2 2 4 4 0 004-4 7 7 0 10-7 7",
    fibwedge: "M4 20L20 4M4 20L20 12M4 20h16",
    gannfan: "M4 20L20 4M4 20L20 10M4 20L20 16M4 20L14 4",
    gannbox: "M4 5h16v14H4zM4 12h16M12 5v14",
    gannsquare: "M4 5h16v14H4zM4 5l16 14M20 5L4 19",
    rect: "M4 6h16v12H4z",
    rotrect: "M3 14l8-8 10 4-8 8z",
    circle: "M12 3a9 9 0 100 18 9 9 0 000-18",
    ellipse: "M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6",
    triangle: "M12 4L21 19H3z",
    polyline: "M3 17l5-6 4 3 4-7 5 4",
    polygon: "M12 3l8 6-3 10H7L4 9z",
    arc: "M4 18a8 8 0 0116 0",
    curve: "M3 18c5 0 5-12 10-12s5 12 8 12",
    doublecurve: "M3 15c3 0 3-7 6-7s3 7 6 7 3-7 6-7",
    path: "M3 18c6 0 6-10 12-10h5M17 5l3 3-3 3",
    xabcd: "M3 18l4-9 4 6 4-9 6 12",
    abcd: "M3 17l5-8 5 6 8-10",
    headshoulders: "M3 18l3-4 3 2 3-8 3 8 3-2 3 4",
    elliott5: "M3 19l3-5 2 3 4-8 2 4 6-9",
    elliott3: "M4 18l5-8 4 5 7-9",
    threedrives: "M3 18l3-4 2 3 3-6 2 4 3-6 4 4",
    measure: "M5 19L19 5M8 19H5v-3M19 8V5h-3",
    pricerange: "M4 8h16M4 16h16M12 8v8M9 11l3-3 3 3M9 13l3 3 3-3",
    daterange: "M8 4v16M16 4v16M8 12h8M10 9l-2 3 2 3M14 9l2 3-2 3",
    long: "M4 16h16M4 16V9M7 12l-3-3-3 3M4 20h16",
    short: "M4 8h16M4 8v7M7 12l-3 3-3-3M4 4h16",
    text: "M5 6h14M12 6v13",
    note: "M4 5h16v10H9l-5 4z",
    callout: "M8 4h12v9H14l-3 4v-4H8z M8 13L3 20",
    label: "M3 8h12l5 4-5 4H3z",
    pricelabel: "M3 8h11l6 4-6 4H3zM6 12h5",
    flag: "M6 21V4M6 4h11l-2.5 4L17 12H6",
    emoji: "M12 3a9 9 0 100 18 9 9 0 000-18M9 10v.01M15 10v.01M8.5 14c1.8 2 5.2 2 7 0",
    brush: "M4 17c4-6 8 2 12-4 2-3 4-4 4-4",
    highlighter: "M5 18h5l9-9-4-4-9 9zM4 21h16",
    freearrow: "M3 17c5-8 9 2 14-8M14 5h4v4",
    zoomIn: "M11 5a6 6 0 100 12 6 6 0 000-12M20 20l-4.5-4.5M8 11h6M11 8v6",
    zoomOut: "M11 5a6 6 0 100 12 6 6 0 000-12M20 20l-4.5-4.5M8 11h6",
    fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    auto: "M4 18V6M4 18h16M8 15l3-5 3 3 4-7",
    undo: "M9 14L4 9l5-5M4 9h10a6 6 0 110 12h-2",
    redo: "M15 14l5-5-5-5M20 9H10a6 6 0 100 12h2",
    layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
    settings: "M12 9a3 3 0 100 6 3 3 0 000-6M4.5 12l-1.3-.8.9-3.3 1.5.2.9-1.6-.7-1.4 2.4-2.4 1.4.7 1.6-.9-.2-1.5h3.4l.2 1.5 1.6.9 1.4-.7 2.4 2.4-.7 1.4.9 1.6 1.5.2v3.4l-1.5.2-.9 1.6.7 1.4-2.4 2.4-1.4-.7-1.6.9-.2 1.5h-3.4l-.2-1.5-1.6-.9-1.4.7-2.4-2.4.7-1.4-.9-1.6-1.5-.2z",
    indicators: "M3 17l4-6 4 4 3-8 3 6 4-3",
    full: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    exit: "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5",
    close: "M6 6l12 12M18 6L6 18",
    eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5",
    eyeOff: "M4 4l16 16M10 6.3A8 8 0 0112 6c6.4 0 10 6 10 6a17 17 0 01-3.2 3.7M6.4 8.6A17 17 0 002 12s3.6 6 10 6a9 9 0 003.3-.6",
    lock: "M5 11h14v9H5zM8 11V7a4 4 0 118 0v4",
    unlock: "M5 11h14v9H5zM8 11V7a4 4 0 017.7-1.5",
    trash: "M5 7h14M9 7V5h6v2M8 7l1 13h6l1-13",
    chart: "M4 19V5M4 19h16M8 16V9M12 16v-4M16 16V6",
    clock: "M12 3a9 9 0 100 18 9 9 0 000-18M12 7v5l3 2",
    grid: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16",
    plus: "M12 5v14M5 12h14",
    search: "M11 4a7 7 0 100 14 7 7 0 000-14M20 20l-4-4",
    chevron: "M9 6l6 6-6 6",
    panel: "M4 5h16v14H4zM15 5v14",
    tick: "M5 12.5l4.5 4.5L19 7",
  };

  function svg(path, cls) {
    const body = String(path || "").split("|").map((d) => '<path d="' + d + '"/>').join("");
    return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  /* =========================================================== the table == */
  /*
     Every drawing tool the engine can render, in the group it belongs to.
     `key` is the single-press shortcut. Groups collapse into one rail button
     that remembers the last tool used from it - which is what stops a
     toolkit this size from becoming a wall.
  */

  const GROUPS = [
    {
      id: "cursor", label: "Cursors", icon: "cursor",
      tools: [
        { id: "cursor", label: "Cross cursor", icon: "cursor", key: "1", desc: "Select, move and pan" },
        { id: "crosshair", label: "Crosshair", icon: "cross", key: "2", mode: "crosshair:cross" },
        { id: "dotcursor", label: "Dot cursor", icon: "dot", mode: "crosshair:dot" },
        { id: "eraser", label: "Eraser", icon: "eraser", key: "3", desc: "Click an object to remove it" },
      ],
    },
    {
      id: "lines", label: "Lines", icon: "trend",
      tools: [
        { id: "trend", label: "Trend line", icon: "trend", key: "t" },
        { id: "ray", label: "Ray", icon: "ray" },
        { id: "extended", label: "Extended line", icon: "extended" },
        { id: "hline", label: "Horizontal line", icon: "hline", key: "h" },
        { id: "hray", label: "Horizontal ray", icon: "hray" },
        { id: "vline", label: "Vertical line", icon: "vline", key: "v" },
        { id: "crossline", label: "Cross line", icon: "crossline" },
        { id: "priceline", label: "Price line", icon: "priceline" },
        { id: "dateline", label: "Date line", icon: "dateline" },
        { id: "arrow", label: "Arrow", icon: "arrow", key: "a" },
        { id: "infoline", label: "Info line", icon: "infoline" },
      ],
    },
    {
      id: "channels", label: "Channels", icon: "channel",
      tools: [
        { id: "parallel", label: "Parallel channel", icon: "parallel" },
        { id: "channel", label: "Filled channel", icon: "channel" },
        { id: "flatchannel", label: "Flat top / bottom", icon: "flatchannel" },
        { id: "disjoint", label: "Disjoint channel", icon: "disjoint" },
        { id: "regression", label: "Regression channel", icon: "regression" },
        { id: "pitchfork", label: "Andrew's pitchfork", icon: "pitchfork", key: "p" },
        { id: "schiff", label: "Schiff pitchfork", icon: "schiff" },
        { id: "modschiff", label: "Modified Schiff", icon: "modschiff" },
      ],
    },
    {
      id: "fib", label: "Fibonacci", icon: "fib",
      tools: [
        { id: "fib", label: "Fib retracement", icon: "fib", key: "f" },
        { id: "fibext", label: "Fib extension", icon: "fibext" },
        { id: "fibchannel", label: "Fib channel", icon: "fibchannel" },
        { id: "fibtime", label: "Fib time zones", icon: "fibtime" },
        { id: "fibcircle", label: "Fib circles", icon: "fibcircle" },
        { id: "fibarc", label: "Fib speed arcs", icon: "fibarc" },
        { id: "fibspiral", label: "Fib spiral", icon: "fibspiral" },
        { id: "fibwedge", label: "Fib wedge", icon: "fibwedge" },
      ],
    },
    {
      id: "gann", label: "Gann", icon: "gannfan",
      tools: [
        { id: "gannfan", label: "Gann fan", icon: "gannfan" },
        { id: "gannbox", label: "Gann box", icon: "gannbox" },
        { id: "gannsquare", label: "Gann square", icon: "gannsquare" },
      ],
    },
    {
      id: "shapes", label: "Shapes", icon: "rect",
      tools: [
        { id: "rect", label: "Rectangle", icon: "rect", key: "r" },
        { id: "rotrect", label: "Rotated rectangle", icon: "rotrect" },
        { id: "circle", label: "Circle", icon: "circle" },
        { id: "ellipse", label: "Ellipse", icon: "ellipse" },
        { id: "triangle", label: "Triangle", icon: "triangle" },
        { id: "polyline", label: "Polyline", icon: "polyline" },
        { id: "polygon", label: "Polygon", icon: "polygon" },
        { id: "arc", label: "Arc", icon: "arc" },
        { id: "curve", label: "Curve", icon: "curve" },
        { id: "doublecurve", label: "Double curve", icon: "doublecurve" },
        { id: "path", label: "Path", icon: "path" },
      ],
    },
    {
      id: "patterns", label: "Patterns", icon: "xabcd",
      tools: [
        { id: "xabcd", label: "XABCD pattern", icon: "xabcd" },
        { id: "abcd", label: "ABCD pattern", icon: "abcd" },
        { id: "headshoulders", label: "Head & shoulders", icon: "headshoulders" },
        { id: "elliott5", label: "Elliott impulse (1-5)", icon: "elliott5" },
        { id: "elliott3", label: "Elliott correction (A-C)", icon: "elliott3" },
        { id: "threedrives", label: "Three drives", icon: "threedrives" },
        { id: "gartley", label: "Gartley", icon: "xabcd", ratios: true },
        { id: "butterfly", label: "Butterfly", icon: "xabcd", ratios: true },
        { id: "bat", label: "Bat", icon: "xabcd", ratios: true },
        { id: "crab", label: "Crab", icon: "xabcd", ratios: true },
        { id: "cypher", label: "Cypher", icon: "xabcd", ratios: true },
      ],
    },
    {
      id: "measure", label: "Measure & position", icon: "measure",
      tools: [
        { id: "measure", label: "Date & price range", icon: "measure", key: "m" },
        { id: "pricerange", label: "Price range", icon: "pricerange" },
        { id: "daterange", label: "Date range", icon: "daterange" },
        { id: "long", label: "Long position", icon: "long", key: "l" },
        { id: "short", label: "Short position", icon: "short", key: "s" },
      ],
    },
    {
      id: "annotate", label: "Annotations", icon: "text",
      tools: [
        { id: "text", label: "Text", icon: "text" },
        { id: "note", label: "Note", icon: "note" },
        { id: "callout", label: "Callout", icon: "callout" },
        { id: "label", label: "Label", icon: "label" },
        { id: "pricelabel", label: "Price label", icon: "pricelabel" },
        { id: "flag", label: "Flag", icon: "flag" },
        { id: "emoji", label: "Marker", icon: "emoji" },
      ],
    },
    {
      id: "brush", label: "Freehand", icon: "brush",
      tools: [
        { id: "brush", label: "Brush", icon: "brush", key: "b" },
        { id: "highlighter", label: "Highlighter", icon: "highlighter" },
        { id: "freearrow", label: "Freehand arrow", icon: "freearrow" },
      ],
    },
  ];

  const TOOL_BY_ID = {};
  GROUPS.forEach((g) => g.tools.forEach((t) => { TOOL_BY_ID[t.id] = Object.assign({ group: g.id }, t); }));

  /** Chart types the engine implements, in the order the menu shows them. */
  const CHART_TYPES = [
    { id: "candles", label: "Candles", icon: "chart" },
    { id: "hollow", label: "Hollow candles", icon: "chart" },
    { id: "bar", label: "Bars (OHLC)", icon: "chart" },
    { id: "line", label: "Line", icon: "trend" },
    { id: "area", label: "Area", icon: "trend" },
    { id: "baseline", label: "Baseline", icon: "trend" },
    { id: "heikin", label: "Heikin Ashi", icon: "chart" },
    { id: "renko", label: "Renko", icon: "grid" },
    { id: "linebreak", label: "Line break", icon: "grid" },
  ];

  /**
   * The timeframes the data source actually has.
   *
   * MetaTrader serves these nine and no others - there is no second, no
   * three-minute and no two-hour bar to ask for. Offering them would be a
   * control that cannot work, so they are not here.
   */
  const TIMEFRAMES = [
    { id: "M1", label: "1 minute", short: "1m", group: "minutes" },
    { id: "M5", label: "5 minutes", short: "5m", group: "minutes" },
    { id: "M15", label: "15 minutes", short: "15m", group: "minutes" },
    { id: "M30", label: "30 minutes", short: "30m", group: "minutes" },
    { id: "H1", label: "1 hour", short: "1h", group: "hours" },
    { id: "H4", label: "4 hours", short: "4h", group: "hours" },
    { id: "D1", label: "1 day", short: "1D", group: "days" },
    { id: "W1", label: "1 week", short: "1W", group: "days" },
    { id: "MN1", label: "1 month", short: "1M", group: "days" },
  ];

  const QUICK_TF = ["M5", "M15", "H1", "H4", "D1"];

  const INDICATOR_GROUPS = [
    { id: "ma", label: "Moving averages" },
    { id: "momentum", label: "Momentum & oscillators" },
    { id: "volatility", label: "Volatility" },
    { id: "volume", label: "Volume" },
  ];

  /** Human names for indicators, kept here so the maths file stays pure. */
  const INDICATOR_TEXT = {
    sma: ["Simple moving average", "The mean close over N bars."],
    ema: ["Exponential moving average", "Weighted towards the most recent bars."],
    wma: ["Weighted moving average", "Linear weights, newest bar heaviest."],
    bb: ["Bollinger Bands", "A moving average with standard-deviation bands."],
    donchian: ["Donchian channel", "The highest high and lowest low of N bars."],
    vwap: ["Anchored VWAP", "Volume-weighted average price from the first visible bar."],
    volume: ["Volume", "Traded volume per bar, with its own average."],
    rsi: ["Relative strength index", "Wilder's RSI. Above 70 stretched, below 30 stretched the other way."],
    macd: ["MACD", "Two moving averages, their difference and its signal line."],
    stoch: ["Stochastic", "Where the close sits inside the recent range."],
    atr: ["Average true range", "How far price travels in a bar, on average."],
  };

  /* =============================================================== state == */

  const LS_DOCK = "aurion.chart.dock";
  const LS_GROUP = "aurion.chart.lasttool";

  const ui = {
    chart: null,
    root: null,
    ctx: null,
    lastOfGroup: {},
    dockTab: "objects",
    dockOpen: true,
    menu: null,
    fullscreen: false,
  };

  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** i18n with a fallback: the chrome is translated, tool names are terms. */
  function tt(key, fallback) {
    try {
      const v = global.I18N ? global.I18N.t(key) : key;
      return v === key ? fallback : v;
    } catch (e) { return fallback; }
  }

  function read(k, fb) {
    try { const v = localStorage.getItem(k); return v === null ? fb : v; } catch (e) { return fb; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }

  function loadLastTools() {
    try { ui.lastOfGroup = JSON.parse(read(LS_GROUP, "{}")) || {}; } catch (e) { ui.lastOfGroup = {}; }
    GROUPS.forEach((g) => { if (!ui.lastOfGroup[g.id]) ui.lastOfGroup[g.id] = g.tools[0].id; });
  }

  /* ================================================================ html == */

  function railHtml() {
    const groups = GROUPS.map((g) => {
      const toolId = ui.lastOfGroup[g.id] || g.tools[0].id;
      const tool = TOOL_BY_ID[toolId] || g.tools[0];
      const many = g.tools.length > 1;
      return `<div class="tvr-group" data-group="${g.id}">
        <button type="button" class="tvr-btn" data-tool="${tool.id}"
                title="${esc(tool.label)}${tool.key ? " (" + tool.key.toUpperCase() + ")" : ""}"
                aria-label="${esc(tool.label)}">${svg(I[tool.icon])}</button>
        ${many ? `<button type="button" class="tvr-more" data-flyout="${g.id}"
                aria-label="${esc(g.label)}" aria-haspopup="true" aria-expanded="false"></button>` : ""}
      </div>`;
    }).join("");

    return `<nav class="tv-rail" id="tv-rail" aria-label="${esc(tt("chart.tools", "Drawing tools"))}">
      ${groups}
      <div class="tvr-sep"></div>
      <button type="button" class="tvr-btn" id="tv-magnet" title="${esc(tt("chart.magnet", "Magnet"))}"
              aria-pressed="false">${svg(I.magnet)}</button>
      <button type="button" class="tvr-btn" id="tv-lockall" title="${esc(tt("chart.lock_all", "Lock all drawings"))}"
              aria-pressed="false">${svg(I.lock)}</button>
      <button type="button" class="tvr-btn" id="tv-hideall" title="${esc(tt("chart.hide_all", "Hide all drawings"))}"
              aria-pressed="false">${svg(I.eye)}</button>
      <button type="button" class="tvr-btn danger" id="tv-clear" title="${esc(tt("chart.delete_all", "Remove all drawings"))}">${svg(I.trash)}</button>
    </nav>
    <div class="tv-flyout" id="tv-flyout" hidden></div>`;
  }

  function topHtml(o) {
    const tfs = QUICK_TF.map((id) => `<button type="button" class="tvt-seg${id === o.timeframe ? " on" : ""}"
        data-tf="${id}">${esc((TIMEFRAMES.find((t) => t.id === id) || {}).short || id)}</button>`).join("");
    return `<header class="tv-top">
      <button type="button" class="tv-icon" id="tv-back" title="${esc(tt("common.back", "Back"))}"
              aria-label="${esc(tt("common.back", "Back"))}">${svg(I.chevron, "flip")}</button>
      <div class="tv-sym"><b>${esc(o.symbol)}</b><span id="tv-tf-label">${esc(o.timeframe)}</span></div>
      <div class="tv-seg" role="group" aria-label="${esc(tt("markets.timeframe", "Timeframe"))}">${tfs}</div>
      <button type="button" class="tv-btn" data-menu="tf" aria-haspopup="true">${svg(I.clock)}<span class="tvb-label" id="tv-tf-more">${esc(tt("chart.more_tf", "More"))}</span></button>
      <span class="tv-div"></span>
      <button type="button" class="tv-btn" data-menu="type" aria-haspopup="true">${svg(I.chart)}<span class="tvb-label" id="tv-type-label">Candles</span></button>
      <button type="button" class="tv-btn" data-menu="indicators" aria-haspopup="true">${svg(I.indicators)}<span class="tvb-label">${esc(tt("chart.indicators", "Indicators"))}</span></button>
      <button type="button" class="tv-btn" data-menu="settings" aria-haspopup="true">${svg(I.settings)}<span class="tvb-label">${esc(tt("chart.settings", "Settings"))}</span></button>
      <span class="tv-spacer"></span>
      <button type="button" class="tv-icon" id="tv-undo" title="${esc(tt("draw.undo", "Undo"))} (Ctrl+Z)" disabled>${svg(I.undo)}</button>
      <button type="button" class="tv-icon" id="tv-redo" title="${esc(tt("chart.redo", "Redo"))} (Ctrl+Shift+Z)" disabled>${svg(I.redo)}</button>
      <span class="tv-div"></span>
      <button type="button" class="tv-icon" id="tv-dock-toggle" title="${esc(tt("chart.panel", "Side panel"))}" aria-pressed="true">${svg(I.panel)}</button>
      <button type="button" class="tv-icon" id="tv-full" title="${esc(tt("chart.fullscreen", "Fullscreen"))} (F)">${svg(I.full)}</button>
    </header>`;
  }

  function dockHtml(o) {
    return `<aside class="tv-dock" id="tv-dock" aria-label="${esc(tt("chart.panel", "Side panel"))}">
      <div class="tvd-tabs" role="tablist">
        <button type="button" role="tab" data-dock="objects" class="on">${esc(tt("chart.objects", "Objects"))}</button>
        <button type="button" role="tab" data-dock="props">${esc(tt("chart.properties", "Properties"))}</button>
        ${o.ticket ? `<button type="button" role="tab" data-dock="trade">${esc(tt("chart.trade", "Trade"))}</button>` : ""}
        <button type="button" class="tvd-close" id="tv-dock-close" aria-label="${esc(tt("common.close", "Close"))}">${svg(I.close)}</button>
      </div>
      <div class="tvd-body" id="tvd-objects" data-pane="objects"></div>
      <div class="tvd-body" id="tvd-props" data-pane="props" hidden></div>
      ${o.ticket ? `<div class="tvd-body" data-pane="trade" hidden>
        <div class="chart-levels" id="chart-levels"></div>
        ${o.ticket}</div>` : ""}
    </aside>`;
  }

  function html(o) {
    o = o || {};
    loadLastTools();
    ui.dockOpen = read(LS_DOCK, "1") === "1";
    return `<div class="tv${ui.dockOpen ? "" : " no-dock"}" id="tv">
      ${topHtml(o)}
      <div class="tv-body">
        ${railHtml()}
        <div class="tv-stage">
          <div class="chart-box" id="tv-chartbox">
            <canvas id="cv-desk"></canvas>
            <div class="tv-hint" id="tv-hint" hidden></div>
            <div class="tv-nav">
              <button type="button" class="tv-round" id="tv-zin" title="${esc(tt("draw.zoom_in", "Zoom in"))} (+)">${svg(I.zoomIn)}</button>
              <button type="button" class="tv-round" id="tv-zout" title="${esc(tt("draw.zoom_out", "Zoom out"))} (−)">${svg(I.zoomOut)}</button>
              <button type="button" class="tv-round" id="tv-auto" title="${esc(tt("chart.auto_scale", "Auto scale"))}">${svg(I.auto)}</button>
              <button type="button" class="tv-round" id="tv-fit" title="${esc(tt("draw.fit", "Reset view"))} (Home)">${svg(I.fit)}</button>
            </div>
          </div>
        </div>
        ${dockHtml(o)}
      </div>
      <footer class="tv-status">
        <span id="tv-status-tool">${esc(tt("chart.mode_navigate", "Navigate"))}</span>
        <span class="tv-div"></span>
        <span id="tv-status-hint" class="sub">${esc(tt("chart.hint_nav", "Scroll to zoom · drag to pan · right-drag moves the chart anywhere"))}</span>
        <span class="tv-spacer"></span>
        <span class="mono" id="tick-lbl"></span>
      </footer>
    </div>`;
  }

  global.AurionChartUI = {
    GROUPS, TOOL_BY_ID, CHART_TYPES, TIMEFRAMES, INDICATOR_GROUPS, INDICATOR_TEXT, ICONS: I,
    html, svg, esc, tt, state: ui,
  };
})(typeof window !== "undefined" ? window : this);


/* ===========================================================================
   The controller
   ===========================================================================
   Everything above is description; this is behaviour. It binds one mounted
   workspace to one chart engine and owns: the rail and its flyouts, the four
   top menus, the dock with the object manager and the properties panel, the
   navigation buttons, the keyboard map and fullscreen.

   It holds no copy of the chart's state. Every panel is rendered from the
   engine on demand and re-rendered when the engine says something changed,
   so the two can never drift apart - which is the failure mode of every
   hand-synchronised toolbar.
   =========================================================================== */
(function (global) {
  "use strict";

  const UI = global.AurionChartUI;
  if (!UI) return;

  const { GROUPS, TOOL_BY_ID, CHART_TYPES, TIMEFRAMES, INDICATOR_GROUPS, INDICATOR_TEXT, ICONS: I } = UI;
  const svg = UI.svg, esc = UI.esc, tt = UI.tt, ui = UI.state;

  const LS_DOCK = "aurion.chart.dock";
  const LS_GROUP = "aurion.chart.lasttool";

  function $(id) { return document.getElementById(id); }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }

  /* ============================================================== menus == */

  function closeMenu() {
    const m = $("tv-menu");
    if (m) m.remove();
    document.querySelectorAll('.tv-btn[aria-haspopup]').forEach((b) => b.setAttribute("aria-expanded", "false"));
    ui.menu = null;
  }

  function openMenu(anchor, name, body, cls) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "tv-menu " + (cls || "");
    el.id = "tv-menu";
    el.setAttribute("role", "dialog");
    el.innerHTML = body;
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    el.style.left = left + "px";
    el.style.top = (r.bottom + 6) + "px";
    // A menu taller than the room under its button is pinned to the viewport
    // instead of running off the bottom of a laptop screen.
    const h = el.offsetHeight;
    if (r.bottom + 6 + h > window.innerHeight - 8) {
      el.style.top = Math.max(8, window.innerHeight - h - 8) + "px";
    }
    anchor.setAttribute("aria-expanded", "true");
    ui.menu = name;
    requestAnimationFrame(() => el.classList.add("in"));
    return el;
  }

  function menuTimeframes() {
    const by = { minutes: [], hours: [], days: [] };
    TIMEFRAMES.forEach((t) => by[t.group].push(t));
    const section = (key, label) => `<div class="tvm-sec">${esc(label)}</div>` +
      by[key].map((t) => `<button type="button" class="tvm-row${t.id === ui.ctx.timeframe ? " on" : ""}" data-pick-tf="${t.id}">
        <span class="tvm-key">${esc(t.short)}</span><span>${esc(t.label)}</span>
        ${t.id === ui.ctx.timeframe ? svg(I.tick, "tvm-tick") : ""}</button>`).join("");
    return section("minutes", tt("chart.tf_minutes", "Minutes")) +
      section("hours", tt("chart.tf_hours", "Hours")) +
      section("days", tt("chart.tf_days", "Days and longer")) +
      `<p class="tvm-note">${esc(tt("chart.tf_note", "These are the intervals MetaTrader serves for this symbol."))}</p>`;
  }

  function menuTypes() {
    return CHART_TYPES.map((t) => `<button type="button" class="tvm-row${t.id === ui.chart.type ? " on" : ""}" data-pick-type="${t.id}">
      ${svg(I[t.icon], "tvm-ico")}<span>${esc(t.label)}</span>
      ${t.id === ui.chart.type ? svg(I.tick, "tvm-tick") : ""}</button>`).join("");
  }

  function menuIndicators(query) {
    const lib = global.AurionSeries;
    if (!lib) return "";
    const q = String(query || "").trim().toLowerCase();
    const active = ui.chart.indicators.map((ind) => {
      const def = lib.INDICATOR_BY_ID[ind.type] || {};
      const text = INDICATOR_TEXT[ind.type] || [ind.type, ""];
      const params = Object.keys(ind.params || {}).map((k) =>
        `<label class="tvi-param"><span>${esc(k)}</span>
          <input type="number" data-ind-param="${ind.id}" data-key="${esc(k)}" value="${esc(ind.params[k])}" min="1" step="1" /></label>`).join("");
      return `<div class="tvi-active" data-ind="${ind.id}">
        <div class="tvi-head">
          <b>${esc(text[0])}</b>
          <button type="button" class="tv-icon tiny" data-ind-vis="${ind.id}" aria-pressed="${ind.visible !== false}"
            title="${esc(tt("chart.visibility", "Show / hide"))}">${svg(ind.visible === false ? I.eyeOff : I.eye)}</button>
          <button type="button" class="tv-icon tiny danger" data-ind-del="${ind.id}"
            title="${esc(tt("common.delete", "Remove"))}">${svg(I.trash)}</button>
        </div>
        ${params ? `<div class="tvi-params">${params}</div>` : ""}
      </div>`;
    }).join("");

    const groups = INDICATOR_GROUPS.map((g) => {
      const rows = lib.INDICATORS.filter((d) => d.group === g.id).filter((d) => {
        if (!q) return true;
        const text = INDICATOR_TEXT[d.id] || [d.id, ""];
        return (d.id + " " + text[0] + " " + text[1]).toLowerCase().indexOf(q) >= 0;
      }).map((d) => {
        const text = INDICATOR_TEXT[d.id] || [d.id, ""];
        return `<button type="button" class="tvm-row wide" data-add-ind="${d.id}">
          <span class="tvm-ico mono">${esc(d.short)}</span>
          <span class="tvm-text"><b>${esc(text[0])}</b><small>${esc(text[1])}</small></span>
          ${svg(I.plus, "tvm-tick")}</button>`;
      }).join("");
      return rows ? `<div class="tvm-sec">${esc(g.label)}</div>${rows}` : "";
    }).join("");

    return `<div class="tvm-search">${svg(I.search)}
        <input class="ctrl" id="tv-ind-q" value="${esc(query || "")}" placeholder="${esc(tt("chart.search_ind", "Search indicators"))}" />
      </div>
      ${active ? `<div class="tvm-sec">${esc(tt("chart.on_chart", "On this chart"))}</div>${active}` : ""}
      ${groups || `<p class="tvm-note">${esc(tt("chart.no_ind", "Nothing matches that."))}</p>`}`;
  }

  function toggleRow(id, label, on, hint) {
    return `<button type="button" class="tvm-row" data-toggle="${id}" aria-pressed="${on}">
      <span class="tvm-text"><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ""}</span>
      <span class="tv-switch${on ? " on" : ""}"><i></i></span></button>`;
  }

  function menuSettings() {
    const c = ui.chart;
    return `<div class="tvm-sec">${esc(tt("chart.appearance", "Appearance"))}</div>
      ${toggleRow("grid", tt("chart.grid", "Grid"), c.grid)}
      ${toggleRow("sessions", tt("draw.sessions", "Market sessions"), c.sessions)}
      <div class="tvm-sec">${esc(tt("chart.crosshair", "Crosshair"))}</div>
      <div class="tvm-choice">
        ${["cross", "dot", "none"].map((m) => `<button type="button" data-cross="${m}" class="${c.crosshair === m ? "on" : ""}">${esc(tt("chart.cross_" + m, m))}</button>`).join("")}
      </div>
      <div class="tvm-sec">${esc(tt("chart.scales", "Price scale"))}</div>
      ${toggleRow("auto", tt("chart.auto_scale", "Auto scale"), c.scale.auto)}
      ${toggleRow("log", tt("chart.log_scale", "Logarithmic"), c.scale.log)}
      ${toggleRow("percent", tt("chart.percent_scale", "Percent"), c.scale.percent, tt("chart.percent_hint", "Axis labels relative to the first visible bar"))}
      ${toggleRow("invert", tt("chart.invert_scale", "Invert"), c.scale.invert)}
      <div class="tvm-sec">${esc(tt("chart.drawing", "Drawing"))}</div>
      <div class="tvm-choice">
        ${["off", "weak", "strong"].map((m) => `<button type="button" data-magnet="${m}" class="${c.magnet === m ? "on" : ""}">${esc(tt("chart.magnet_" + m, m))}</button>`).join("")}
      </div>
      ${toggleRow("snaptime", tt("chart.snap_time", "Snap to bar"), c.snapTime, tt("chart.snap_hint", "Anchors land on a bar, never between two"))}
      <div class="tvm-sec">${esc(tt("chart.trading", "Trading"))}</div>
      ${toggleRow("signals", tt("chart.signals", "Strategy signals"), c.showSignals)}`;
  }

  /* =============================================================== rail == */

  function markTool() {
    const c = ui.chart;
    const active = c.tool === "cursor" && c.crosshair === "dot" ? "dotcursor" : c.tool;
    document.querySelectorAll("#tv-rail [data-tool]").forEach((b) => {
      b.classList.toggle("on", b.dataset.tool === active);
    });
    const mag = $("tv-magnet");
    if (mag) {
      mag.classList.toggle("on", c.magnet !== "off");
      mag.setAttribute("aria-pressed", c.magnet !== "off" ? "true" : "false");
    }
    const tool = TOOL_BY_ID[active];
    const st = $("tv-status-tool");
    if (st) st.textContent = tool ? tool.label : tt("chart.mode_navigate", "Navigate");
    const hint = $("tv-status-hint");
    if (hint) {
      const need = global.SHAPE_POINTS ? global.SHAPE_POINTS[c.tool] : null;
      hint.textContent = c.tool === "cursor"
        ? tt("chart.hint_nav", "Scroll to zoom · drag to pan · right-drag moves the chart anywhere")
        : need === -1
          ? tt("chart.hint_free", "Press and drag to draw · Esc to cancel")
          : tt("chart.hint_points", "Click {n} points · Esc to cancel").replace("{n}", need || 2);
    }
  }

  function pickTool(id) {
    const c = ui.chart;
    const tool = TOOL_BY_ID[id];
    if (!tool) return;
    if (tool.mode) {
      const [what, value] = tool.mode.split(":");
      if (what === "crosshair") c.setCrosshair(value);
      c.setTool("cursor");
    } else {
      if (id !== "cursor" && id !== "eraser" && c.crosshair === "dot") c.setCrosshair("cross");
      c.setTool(id);
    }
    ui.lastOfGroup[tool.group] = id;
    write(LS_GROUP, JSON.stringify(ui.lastOfGroup));
    const groupBtn = document.querySelector('.tvr-group[data-group="' + tool.group + '"] .tvr-btn');
    if (groupBtn) {
      groupBtn.dataset.tool = id;
      groupBtn.innerHTML = svg(I[tool.icon]);
      groupBtn.title = tool.label + (tool.key ? " (" + tool.key.toUpperCase() + ")" : "");
      groupBtn.setAttribute("aria-label", tool.label);
    }
    closeFlyout();
    markTool();
  }

  function closeFlyout() {
    const fly = $("tv-flyout");
    if (!fly) return;
    fly.hidden = true;
    fly.classList.remove("in");
    document.querySelectorAll(".tvr-more").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }

  function openFlyout(groupId, anchor) {
    const fly = $("tv-flyout");
    const group = GROUPS.find((g) => g.id === groupId);
    if (!fly || !group) return;
    fly.innerHTML = `<div class="tvf-head">${esc(group.label)}</div>` +
      group.tools.map((t) => `<button type="button" class="tvf-row${ui.chart.tool === t.id ? " on" : ""}" data-tool="${t.id}">
        ${svg(I[t.icon])}<span>${esc(t.label)}</span>${t.key ? `<kbd>${esc(t.key.toUpperCase())}</kbd>` : ""}</button>`).join("");
    fly.hidden = false;
    const r = anchor.getBoundingClientRect();
    const box = document.querySelector(".tv-body").getBoundingClientRect();
    fly.style.top = Math.max(4, Math.min(r.top - box.top, box.height - fly.offsetHeight - 8)) + "px";
    anchor.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => fly.classList.add("in"));
  }

  /* =============================================================== dock == */

  function objectName(d) {
    if (d.name) return d.name;
    const tool = TOOL_BY_ID[d.kind];
    return tool ? tool.label : d.kind;
  }

  function renderObjects() {
    const host = $("tvd-objects");
    if (!host) return;
    const c = ui.chart;
    const items = c.drawings.slice().reverse();
    const anyHidden = c.drawings.some((d) => d.visible === false);
    const anyLocked = c.drawings.some((d) => d.locked);
    host.innerHTML = `
      <div class="tvd-bulk">
        <button type="button" class="tv-chip" data-bulk="${anyHidden ? "show" : "hide"}">
          ${svg(anyHidden ? I.eye : I.eyeOff)}<span>${esc(anyHidden ? tt("chart.show_all", "Show all") : tt("chart.hide_all", "Hide all"))}</span></button>
        <button type="button" class="tv-chip" data-bulk="${anyLocked ? "unlock" : "lock"}">
          ${svg(anyLocked ? I.unlock : I.lock)}<span>${esc(anyLocked ? tt("chart.unlock_all", "Unlock all") : tt("chart.lock_all", "Lock all"))}</span></button>
        <button type="button" class="tv-chip danger" data-bulk="delete">${svg(I.trash)}<span>${esc(tt("chart.delete_all", "Delete all"))}</span></button>
      </div>
      ${items.length ? `<ul class="tvd-list">${items.map((d) => `
        <li class="tvd-item${c.selected === d ? " on" : ""}${d.visible === false ? " off" : ""}" data-obj="${d.id}">
          <button type="button" class="tvd-pick" data-obj-pick="${d.id}">
            <span class="tvd-swatch" style="background:${esc(d.color || "#e8c07a")}"></span>
            <span class="tvd-name">${esc(objectName(d))}</span>
          </button>
          <button type="button" class="tv-icon tiny" data-obj-vis="${d.id}" aria-pressed="${d.visible !== false}"
            title="${esc(tt("chart.visibility", "Show / hide"))}">${svg(d.visible === false ? I.eyeOff : I.eye)}</button>
          <button type="button" class="tv-icon tiny" data-obj-lock="${d.id}" aria-pressed="${Boolean(d.locked)}"
            title="${esc(tt("chart.lock", "Lock"))}">${svg(d.locked ? I.lock : I.unlock)}</button>
          <button type="button" class="tv-icon tiny danger" data-obj-del="${d.id}"
            title="${esc(tt("common.delete", "Delete"))}">${svg(I.trash)}</button>
        </li>`).join("")}</ul>`
      : `<p class="tvd-empty">${esc(tt("chart.no_objects", "Nothing drawn yet. Pick a tool from the left."))}</p>`}`;
  }

  const FIELD = {
    color: (d) => `<label class="tvp-row"><span>${esc(tt("chart.color", "Colour"))}</span>
      <input type="color" data-prop="color" value="${esc(/^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#e8c07a")}" /></label>`,
    width: (d) => `<label class="tvp-row"><span>${esc(tt("chart.thickness", "Thickness"))}</span>
      <input type="range" min="1" max="6" step="0.5" data-prop="width" value="${esc(d.width || 1.4)}" /></label>`,
    style: (d) => `<div class="tvp-row"><span>${esc(tt("chart.line_style", "Line style"))}</span>
      <span class="tvp-choice">${["solid", "dashed", "dotted"].map((s) =>
        `<button type="button" data-prop-style="${s}" class="${(d.style || "solid") === s ? "on" : ""}">${esc(tt("chart.style_" + s, s))}</button>`).join("")}</span></div>`,
    opacity: (d) => `<label class="tvp-row"><span>${esc(tt("chart.opacity", "Opacity"))}</span>
      <input type="range" min="0.1" max="1" step="0.05" data-prop="opacity" value="${esc(d.opacity === undefined ? 1 : d.opacity)}" /></label>`,
    fill: (d) => `<label class="tvp-row"><span>${esc(tt("chart.fill", "Background fill"))}</span>
      <input type="checkbox" data-prop-bool="fill" ${d.fill !== false ? "checked" : ""} /></label>`,
    extend: (d) => `<div class="tvp-row"><span>${esc(tt("chart.extend", "Extend"))}</span>
      <span class="tvp-choice">
        <button type="button" data-prop-toggle="extendL" class="${d.extendL ? "on" : ""}">${esc(tt("chart.left", "Left"))}</button>
        <button type="button" data-prop-toggle="extendR" class="${d.extendR ? "on" : ""}">${esc(tt("chart.right", "Right"))}</button>
      </span></div>`,
    text: (d) => `<label class="tvp-row"><span>${esc(tt("chart.text", "Text"))}</span>
      <input class="ctrl" data-prop="text" value="${esc(d.text || "")}" /></label>`,
    font: (d) => `<label class="tvp-row"><span>${esc(tt("chart.font_size", "Font size"))}</span>
      <input type="range" min="9" max="28" step="1" data-prop-num="fontSize" value="${esc(d.fontSize || 13)}" /></label>
      <label class="tvp-row"><span>${esc(tt("chart.bold", "Bold"))}</span>
      <input type="checkbox" data-prop-bool="bold" ${d.bold ? "checked" : ""} /></label>`,
    rr: (d) => `<label class="tvp-row"><span>${esc(tt("chart.reward", "Reward multiple"))}</span>
      <input type="number" step="0.1" min="0.1" data-prop-num="rr" value="${esc(d.rr || 2)}" /></label>`,
    levels: (d) => {
      const chart = ui.chart;
      const levels = chart.fibLevels(d);
      return `<div class="tvp-sec">${esc(tt("chart.levels", "Levels"))}</div>
        <div class="tvp-levels">${levels.map((l, i) => `<label class="tvp-level">
          <input type="checkbox" data-level-vis="${i}" checked />
          <span class="mono">${esc(l.label)}</span>
          <input type="color" data-level-color="${i}" value="${esc(/^#[0-9a-f]{6}$/i.test(l.color) ? l.color : "#7c6cff")}" />
        </label>`).join("")}</div>
        <div class="tvp-row"><span>${esc(tt("chart.custom_level", "Add a level"))}</span>
          <span class="tvp-add"><input type="number" step="0.001" id="tvp-newlevel" placeholder="1.414" />
          <button type="button" class="tv-chip" id="tvp-addlevel">${svg(I.plus)}</button></span></div>`;
    },
    coords: (d) => {
      const rows = ["a", "b", "c", "d", "e"].filter((k) => d[k]).map((k) => `
        <label class="tvp-coord"><span class="mono">${k.toUpperCase()}</span>
          <input type="number" step="any" data-coord="${k}" value="${esc(Number(d[k].p).toFixed(5))}" /></label>`).join("");
      return rows ? `<div class="tvp-sec">${esc(tt("chart.coordinates", "Coordinates"))}</div><div class="tvp-coords">${rows}</div>` : "";
    },
  };

  /** Which properties a kind actually has. Nothing irrelevant is shown. */
  function fieldsFor(kind) {
    const base = ["color", "width", "style", "opacity"];
    if (/^(text|note|label|pricelabel|flag|emoji|callout)$/.test(kind)) {
      return ["color", "text", "font", "opacity"];
    }
    if (/^fib/.test(kind)) return base.concat(["fill", "levels"]);
    if (/^(long|short)$/.test(kind)) return ["color", "width", "opacity", "rr"];
    if (/^(rect|circle|ellipse|triangle|polygon|rotrect|channel|flatchannel|disjoint|parallel|gannbox|gannsquare|daterange|pricerange|pitchfork|schiff|modschiff)$/.test(kind)) {
      return base.concat(["fill"]);
    }
    if (/^(trend|ray|extended|infoline)$/.test(kind)) return base.concat(["extend"]);
    return base;
  }

  function renderProps() {
    const host = $("tvd-props");
    if (!host) return;
    const d = ui.chart.selected;
    if (!d) {
      host.innerHTML = `<p class="tvd-empty">${esc(tt("chart.no_selection", "Select an object on the chart, or in the Objects list, to edit it."))}</p>`;
      return;
    }
    const fields = fieldsFor(d.kind).map((f) => (FIELD[f] ? FIELD[f](d) : "")).join("");
    host.innerHTML = `
      <div class="tvp-head">
        <input class="ctrl tvp-name" data-prop="name" value="${esc(objectName(d))}" aria-label="${esc(tt("chart.rename", "Name"))}" />
        <button type="button" class="tv-icon tiny" data-obj-lock="${d.id}" aria-pressed="${Boolean(d.locked)}"
          title="${esc(tt("chart.lock", "Lock"))}">${svg(d.locked ? I.lock : I.unlock)}</button>
        <button type="button" class="tv-icon tiny danger" data-obj-del="${d.id}"
          title="${esc(tt("common.delete", "Delete"))}">${svg(I.trash)}</button>
      </div>
      <p class="tvp-kind">${esc((TOOL_BY_ID[d.kind] || {}).label || d.kind)}</p>
      ${fields}
      ${FIELD.coords(d)}`;
  }

  function refresh() {
    renderObjects();
    renderProps();
    const u = $("tv-undo"), r = $("tv-redo");
    if (u) u.disabled = !ui.chart.canUndo();
    if (r) r.disabled = !ui.chart.canRedo();
    if (ui.menu === "indicators") {
      const m = $("tv-menu");
      if (m) m.innerHTML = menuIndicators(($("tv-ind-q") || {}).value || "");
    }
  }

  function showDock(tab) {
    ui.dockTab = tab;
    document.querySelectorAll("[data-dock]").forEach((b) => b.classList.toggle("on", b.dataset.dock === tab));
    document.querySelectorAll(".tvd-body").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
    const tv = $("tv");
    if (tv && tv.classList.contains("no-dock")) toggleDock(true);
  }

  function toggleDock(open) {
    const tv = $("tv");
    if (!tv) return;
    const next = open === undefined ? tv.classList.contains("no-dock") : open;
    tv.classList.toggle("no-dock", !next);
    write(LS_DOCK, next ? "1" : "0");
    const b = $("tv-dock-toggle");
    if (b) b.setAttribute("aria-pressed", next ? "true" : "false");
    if (ui.chart) setTimeout(() => ui.chart.draw(), 210);
  }

  /* ========================================================= fullscreen == */

  function setFullscreen(on) {
    const tv = $("tv");
    if (!tv) return;
    ui.fullscreen = on;
    document.body.classList.toggle("chart-full", on);
    const btn = $("tv-full");
    if (btn) {
      btn.innerHTML = svg(on ? I.exit : I.full);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    try {
      if (on && !document.fullscreenElement && tv.requestFullscreen) tv.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) { /* the app-level fullscreen still applies */ }
    setTimeout(() => ui.chart && ui.chart.draw(), 120);
  }

  /* ========================================================== shortcuts == */

  const SHORTCUT = {};
  GROUPS.forEach((g) => g.tools.forEach((t) => { if (t.key) SHORTCUT[t.key] = t.id; }));

  function onKey(e) {
    if (!ui.chart || !$("tv")) return;
    const el = e.target;
    if (el && /^(input|textarea|select)$/i.test(el.tagName)) return;
    if (el && el.isContentEditable) return;
    const c = ui.chart;
    const meta = e.ctrlKey || e.metaKey;

    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) c.redo(); else c.undo();
      return;
    }
    if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); c.redo(); return; }
    if (meta) return;

    switch (e.key) {
      case "Escape":
        if (ui.menu) { closeMenu(); return; }
        closeFlyout();
        if (c.cancel()) { markTool(); return; }
        if (ui.fullscreen) setFullscreen(false);
        return;
      case "Delete": case "Backspace":
        if (c.deleteSelected()) e.preventDefault();
        return;
      case "+": case "=": e.preventDefault(); c.zoom(1); return;
      case "-": case "_": e.preventDefault(); c.zoom(-1); return;
      case "ArrowLeft": e.preventDefault(); c.pan(e.shiftKey ? 20 : 3); return;
      case "ArrowRight": e.preventDefault(); c.pan(e.shiftKey ? -20 : -3); return;
      case "Home": e.preventDefault(); c.fit(); return;
      case " ":
        // Held space is temporary navigation, the way every editor does it.
        if (!c._space) { c._space = true; c.canvas.style.cursor = "grab"; }
        e.preventDefault();
        return;
      default: break;
    }
    const k = e.key.toLowerCase();
    if (k === "f") { e.preventDefault(); setFullscreen(!ui.fullscreen); return; }
    if (SHORTCUT[k]) { e.preventDefault(); pickTool(SHORTCUT[k]); }
  }

  function onKeyUp(e) {
    if (e.key === " " && ui.chart) {
      ui.chart._space = false;
      ui.chart.canvas.style.cursor = ui.chart.cursorFor();
    }
  }

  /* ============================================================== bind == */

  function bind(chart, ctx) {
    ui.chart = chart;
    ui.ctx = ctx || {};
    ui.root = $("tv");
    if (!ui.root) return;

    chart.opts.onChange = () => refresh();
    chart.opts.onToolDone = () => {
      // One shape, then back to the cursor - the behaviour every charting
      // package has, and the one thing the old toolbar got wrong: it left
      // the tool armed and the next click drew another line by accident.
      if (chart.tool !== "cursor") pickTool("cursor");
    };
    chart.opts.onEdit = () => showDock("props");

    const typeLabel = $("tv-type-label");
    if (typeLabel) {
      const t = CHART_TYPES.find((x) => x.id === chart.type);
      typeLabel.textContent = t ? t.label : chart.type;
    }

    /* ---- rail ---------------------------------------------------------- */
    const rail = $("tv-rail");
    if (rail) rail.onclick = (e) => {
      const more = e.target.closest("[data-flyout]");
      if (more) {
        const open = more.getAttribute("aria-expanded") === "true";
        closeFlyout();
        if (!open) openFlyout(more.dataset.flyout, more);
        return;
      }
      const b = e.target.closest("[data-tool]");
      if (b) { pickTool(b.dataset.tool); return; }
      if (e.target.closest("#tv-magnet")) {
        const next = chart.magnet === "off" ? "weak" : chart.magnet === "weak" ? "strong" : "off";
        chart.setMagnet(next);
        markTool();
        if (ctx.toast) ctx.toast(tt("chart.magnet_" + next, "Magnet: " + next));
        return;
      }
      if (e.target.closest("#tv-lockall")) {
        const lock = !chart.drawings.every((d) => d.locked);
        chart.eachObject((d) => { d.locked = lock; });
        return;
      }
      if (e.target.closest("#tv-hideall")) {
        const hide = chart.drawings.some((d) => d.visible !== false);
        chart.eachObject((d) => { d.visible = !hide; });
        return;
      }
      if (e.target.closest("#tv-clear")) {
        if (!chart.drawings.length) return;
        const ask = ctx.confirm || ((q, go) => { if (window.confirm(q)) go(); });
        ask(tt("chart.confirm_clear", "Remove every drawing on this chart?"), () => chart.clearDrawings());
      }
    };

    const fly = $("tv-flyout");
    if (fly) fly.onclick = (e) => {
      const b = e.target.closest("[data-tool]");
      if (b) pickTool(b.dataset.tool);
    };

    /* ---- top bar ------------------------------------------------------- */
    const top = document.querySelector(".tv-top");
    if (top) top.onclick = (e) => {
      const tf = e.target.closest("[data-tf]");
      if (tf) { if (ctx.onTimeframe) ctx.onTimeframe(tf.dataset.tf); return; }
      const menu = e.target.closest("[data-menu]");
      if (menu) {
        const name = menu.dataset.menu;
        if (ui.menu === name) { closeMenu(); return; }
        if (name === "tf") openMenu(menu, name, menuTimeframes());
        if (name === "type") openMenu(menu, name, menuTypes());
        if (name === "indicators") {
          const el = openMenu(menu, name, menuIndicators(""), "wide");
          const q = el.querySelector("#tv-ind-q");
          if (q) { q.focus(); q.oninput = () => { el.innerHTML = menuIndicators(q.value); el.querySelector("#tv-ind-q").focus(); }; }
        }
        if (name === "settings") openMenu(menu, name, menuSettings());
        return;
      }
      if (e.target.closest("#tv-back")) { if (ctx.onBack) ctx.onBack(); return; }
      if (e.target.closest("#tv-undo")) { chart.undo(); return; }
      if (e.target.closest("#tv-redo")) { chart.redo(); return; }
      if (e.target.closest("#tv-dock-toggle")) { toggleDock(); return; }
      if (e.target.closest("#tv-full")) setFullscreen(!ui.fullscreen);
    };

    /* ---- menus (delegated on the body, they live outside #tv) ---------- */
    if (!global.__tvMenuBound) {
      global.__tvMenuBound = true;
      document.addEventListener("click", (e) => {
        const menu = $("tv-menu");
        if (!menu) return;
        if (!menu.contains(e.target) && !e.target.closest("[data-menu]")) { closeMenu(); return; }
        const c = ui.chart;
        if (!c) return;

        const tf = e.target.closest("[data-pick-tf]");
        if (tf) { closeMenu(); if (ui.ctx.onTimeframe) ui.ctx.onTimeframe(tf.dataset.pickTf); return; }

        const ty = e.target.closest("[data-pick-type]");
        if (ty) {
          c.setType(ty.dataset.pickType);
          const lbl = $("tv-type-label");
          const def = CHART_TYPES.find((x) => x.id === c.type);
          if (lbl && def) lbl.textContent = def.label;
          menu.innerHTML = menuTypes();
          return;
        }

        const add = e.target.closest("[data-add-ind]");
        if (add) { c.addIndicator(add.dataset.addInd); menu.innerHTML = menuIndicators(""); return; }
        const del = e.target.closest("[data-ind-del]");
        if (del) { c.removeIndicator(del.dataset.indDel); menu.innerHTML = menuIndicators(""); return; }
        const vis = e.target.closest("[data-ind-vis]");
        if (vis) {
          const ind = c.indicators.find((i) => i.id === vis.dataset.indVis);
          if (ind) c.updateIndicator(ind.id, { visible: ind.visible === false });
          menu.innerHTML = menuIndicators("");
          return;
        }

        const tg = e.target.closest("[data-toggle]");
        if (tg) {
          const on = tg.getAttribute("aria-pressed") === "true";
          const what = tg.dataset.toggle;
          if (what === "grid") c.setGrid(!on);
          if (what === "sessions" && ui.ctx.onSessions) ui.ctx.onSessions(!on);
          else if (what === "sessions") c.setSessions(!on);
          if (what === "auto") c.setAutoScale(!on);
          if (what === "log") c.setLogScale(!on);
          if (what === "percent") c.setPercentScale(!on);
          if (what === "invert") c.setInvertScale(!on);
          if (what === "snaptime") c.setSnapTime(!on);
          if (what === "signals") {
            // The desk owns this one: it is licence-gated and it fetches.
            if (ui.ctx.onSignals) ui.ctx.onSignals(!on);
            else c.setSignals(c.signals, !on);
          }
          menu.innerHTML = menuSettings();
          return;
        }
        const cross = e.target.closest("[data-cross]");
        if (cross) { c.setCrosshair(cross.dataset.cross); menu.innerHTML = menuSettings(); return; }
        const mag = e.target.closest("[data-magnet]");
        if (mag) { c.setMagnet(mag.dataset.magnet); markTool(); menu.innerHTML = menuSettings(); }
      });

      document.addEventListener("input", (e) => {
        const c = ui.chart;
        if (!c) return;
        const p = e.target.closest("[data-ind-param]");
        if (p) {
          const ind = c.indicators.find((i) => i.id === p.dataset.indParam);
          if (ind) c.updateIndicator(ind.id, { params: { [p.dataset.key]: Number(p.value) || 1 } });
        }
      });
      document.addEventListener("keydown", onKey);
      document.addEventListener("keyup", onKeyUp);
      document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement && ui.fullscreen) setFullscreen(false);
      });
    }

    /* ---- navigation ----------------------------------------------------- */
    const box = $("tv-chartbox");
    if (box) box.onclick = (e) => {
      if (e.target.closest("#tv-zin")) chart.zoom(1);
      else if (e.target.closest("#tv-zout")) chart.zoom(-1);
      else if (e.target.closest("#tv-auto")) chart.setAutoScale(true);
      else if (e.target.closest("#tv-fit")) chart.fit();
    };

    /* ---- dock ----------------------------------------------------------- */
    const dock = $("tv-dock");
    if (dock) {
      dock.onclick = (e) => {
        if (e.target.closest("#tv-dock-close")) { toggleDock(false); return; }
        const tab = e.target.closest("[data-dock]");
        if (tab) { showDock(tab.dataset.dock); return; }

        const pick = e.target.closest("[data-obj-pick]");
        if (pick) { chart.selectById(pick.dataset.objPick); showDock("props"); return; }
        const vis = e.target.closest("[data-obj-vis]");
        if (vis) {
          const d = chart.getObject(vis.dataset.objVis);
          if (d) chart.updateObject(d.id, { visible: d.visible === false });
          return;
        }
        const lock = e.target.closest("[data-obj-lock]");
        if (lock) {
          const d = chart.getObject(lock.dataset.objLock);
          if (d) chart.updateObject(d.id, { locked: !d.locked });
          return;
        }
        const del = e.target.closest("[data-obj-del]");
        if (del) { chart.removeObject(del.dataset.objDel); return; }

        const bulk = e.target.closest("[data-bulk]");
        if (bulk) {
          const what = bulk.dataset.bulk;
          if (what === "hide") chart.eachObject((d) => { d.visible = false; });
          if (what === "show") chart.eachObject((d) => { d.visible = true; });
          if (what === "lock") chart.eachObject((d) => { d.locked = true; });
          if (what === "unlock") chart.eachObject((d) => { d.locked = false; });
          if (what === "delete") {
            if (!chart.drawings.length) return;
            const ask = ctx.confirm || ((q, go) => { if (window.confirm(q)) go(); });
            ask(tt("chart.confirm_clear", "Remove every drawing on this chart?"), () => chart.clearDrawings());
          }
          return;
        }

        const style = e.target.closest("[data-prop-style]");
        if (style && chart.selected) { chart.updateObject(chart.selected.id, { style: style.dataset.propStyle }); return; }
        const tog = e.target.closest("[data-prop-toggle]");
        if (tog && chart.selected) {
          const k = tog.dataset.propToggle;
          chart.updateObject(chart.selected.id, { [k]: !chart.selected[k] });
          return;
        }
        if (e.target.closest("#tvp-addlevel") && chart.selected) {
          const v = Number(($("tvp-newlevel") || {}).value);
          if (!Number.isFinite(v)) return;
          const levels = chart.fibLevels(chart.selected).concat([{ value: v, label: (v * 100).toFixed(1) + "%", visible: true }]);
          levels.sort((a, b) => a.value - b.value);
          chart.updateObject(chart.selected.id, { levels });
        }
      };

      dock.oninput = (e) => {
        const d = chart.selected;
        const t = e.target;
        if (t.dataset.prop && d) {
          chart.updateObject(d.id, { [t.dataset.prop]: t.type === "range" ? Number(t.value) : t.value }, { quiet: true });
          if (t.dataset.prop === "name") renderObjects();
          return;
        }
        if (t.dataset.propNum && d) { chart.updateObject(d.id, { [t.dataset.propNum]: Number(t.value) }, { quiet: true }); return; }
        if (t.dataset.propBool && d) { chart.updateObject(d.id, { [t.dataset.propBool]: t.checked }, { quiet: true }); return; }
        if (t.dataset.coord && d) {
          const pt = d[t.dataset.coord];
          if (pt) { pt.p = Number(t.value); chart.persist(); chart.draw(); }
          return;
        }
        if (t.dataset.levelVis !== undefined && d) {
          const levels = chart.fibLevels(d);
          levels[Number(t.dataset.levelVis)].visible = t.checked;
          chart.updateObject(d.id, { levels }, { quiet: true });
          return;
        }
        if (t.dataset.levelColor !== undefined && d) {
          const levels = chart.fibLevels(d);
          levels[Number(t.dataset.levelColor)].color = t.value;
          chart.updateObject(d.id, { levels }, { quiet: true });
        }
      };
    }

    loadDockState();
    markTool();
    refresh();
  }

  function loadDockState() {
    const tv = $("tv");
    if (!tv) return;
    const open = !tv.classList.contains("no-dock");
    const b = $("tv-dock-toggle");
    if (b) b.setAttribute("aria-pressed", open ? "true" : "false");
    showDock(ui.dockTab || "objects");
    if (!open) tv.classList.add("no-dock");
  }

  Object.assign(UI, {
    bind, refresh, pickTool, setFullscreen, showDock, closeMenu, markTool,
    isFullscreen: () => ui.fullscreen,
  });
})(typeof window !== "undefined" ? window : this);
