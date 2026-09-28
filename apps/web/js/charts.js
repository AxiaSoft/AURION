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

class CandleChart {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts || {};
    this.bars = [];
    // Off by default: an overlay the trader did not ask for is clutter.
    this.sessions = false;
    // The drawing currently under the trader's hand, if any.
    this.selected = null;
    this.offset = 0;
    this.span = 80;
    this.hover = null;
    this.drag = null;
    this.tick = null;
    this.tool = "cursor";
    this.draft = null;
    this.drawings = [];
    this.levels = [];
    this.pending = { sl: 0, tp: 0 };
    this.dragLevel = null;
    this._moved = false;
    this.magnet = false;
    this.crosshair = true;
    this.key = this.opts.key || "";
    this.analyze = Boolean(this.opts.analyze);
    this.signals = [];
    this.showSignals = true;
    this._clicks = 0;
    if (this.key) this.drawings = CandleChart.load(this.key);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas.parentElement || canvas);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
    canvas.addEventListener("touchstart", (e) => this.onTouch(e), { passive: false });
    canvas.addEventListener("touchmove", (e) => this.onTouch(e), { passive: false });
    canvas.addEventListener("dblclick", () => this.fit());
  }
  static load(key) {
    try { return JSON.parse(localStorage.getItem("aurion.draw." + key) || "[]") || []; }
    catch { return []; }
  }
  persist() {
    if (!this.key) return;
    try { localStorage.setItem("aurion.draw." + this.key, JSON.stringify(this.drawings.slice(-200))); } catch { /* */ }
  }
  setTool(tool) {
    this.tool = tool || "cursor";
    this.draft = null;
    this._clicks = 0;
    this.canvas.style.cursor = this.tool === "cursor" ? "grab" : "crosshair";
    this.draw();
  }
  setMagnet(on) { this.magnet = Boolean(on); }
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
    this.draw();
  }
  zoom(dir) {
    this.span = Math.max(20, Math.min(this.bars.length || 20, this.span + (dir > 0 ? -10 : 10)));
    this.draw();
  }
  snapHit(hit) {
    if (!hit || !hit.valid || !this.magnet || !hit.L) return hit;
    const row = hit.L.rows[hit.i];
    if (!row) return hit;
    let best = hit.p;
    let bd = 12;
    for (const p of [row.o, row.h, row.l, row.c]) {
      const d = Math.abs(hit.L.yOf(p) - hit.y);
      if (d < bd) { bd = d; best = p; }
    }
    hit.p = best;
    return hit;
  }
  undo() { this.drawings.pop(); this.persist(); this.draw(); }
  clearDrawings() { this.drawings = []; this.persist(); this.draw(); }
  fit() {
    this.offset = 0;
    this.span = Math.min(160, Math.max(40, this.bars.length || 40));
    this.draw();
  }

  /**
   * Shade the hours each financial centre is open, behind the candles.
   *
   * Drawn per bar rather than as one rectangle per session: a chart can hold
   * several days, and a session that is painted once would only ever mark the
   * first of them. Bands are stacked with low alpha so the London/New York
   * overlap - the busiest window of the day - reads as the densest part of the
   * chart without any special case.
   */
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

  setSessions(on) {
    this.sessions = Boolean(on);
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
    if (!had) {
      this.offset = 0;
      this.span = Math.min(this.analyze ? 160 : 120, Math.max(30, this.bars.length || 30));
    } else {
      this.span = Math.max(20, Math.min(this.bars.length || prevSpan, prevSpan));
      this.offset = Math.max(0, Math.min(Math.max(0, this.bars.length - this.span), prevOff));
    }
    this.draw();
  }
  setTick(tick) { this.tick = tick; this.draw(); }
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
  all() { return this.bars.map((b) => this.norm(b)); }
  slice() {
    const all = this.all();
    const end = all.length - this.offset;
    const start = Math.max(0, end - this.span);
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
  size() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const axisW = this.analyze ? 92 : 84;
    return { w, h, padL: 14, padR: axisW, padT: 16, padB: 36, gapR: 18 };
  }
  layout() {
    const { w, h, padL, padR, padT, padB, gapR } = this.size();
    const { rows, start } = this.slice();
    if (!rows.length) return null;
    let mn = Math.min(...rows.map((r) => r.l)), mx = Math.max(...rows.map((r) => r.h));
    for (const lv of this.levels || []) {
      for (const k of ["sl", "tp", "price_open", "price_current"]) {
        const n = Number(lv[k]);
        if (n > 0) { mn = Math.min(mn, n); mx = Math.max(mx, n); }
      }
    }
    if (mn === mx) { mn -= 1; mx += 1; }
    const padPct = (mx - mn) * 0.04 || 0.5;
    mn -= padPct;
    mx += padPct;
    const span = mx - mn || 1;
    const plotW = Math.max(20, w - padL - padR - gapR);
    const bw = plotW / rows.length;
    return {
      w, h, padL, padR, padT, padB, gapR, rows, start, bw, mn, mx, span,
      plotL: padL,
      plotR: padL + plotW,
      plotT: padT,
      plotB: h - padB,
      xOf: (i) => padL + i * bw + bw / 2,
      yOf: (p) => padT + (1 - (p - mn) / span) * (h - padT - padB),
      iOf: (x) => Math.floor((x - padL) / bw),
      pOf: (y) => mx - ((y - padT) / (h - padT - padB)) * span,
    };
  }
  hit(e) {
    const L = this.layout();
    if (!L) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const i = L.iOf(x);
    const gi = L.start + i;
    const row = L.rows[i];
    return {
      L, x, y, i, gi,
      t: row ? row.t : "",
      p: L.pOf(y),
      valid: i >= 0 && i < L.rows.length,
    };
  }
  draw() {
    const L = this.layout();
    const ctx = this.ctx;
    const box = this.size();
    ctx.clearRect(0, 0, box.w, box.h);
    if (!L) return;
    ctx.font = "11px IBM Plex Mono, Vazirmatn, monospace";
    ctx.strokeStyle = chartTheme().grid;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const p = L.mx - (L.span * i) / 4;
      const yy = L.yOf(p);
      ctx.beginPath(); ctx.moveTo(L.plotL, yy); ctx.lineTo(L.plotR, yy); ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.plotL, L.plotT, L.plotR - L.plotL, L.plotB - L.plotT);
    ctx.clip();
    this.paintSessions(L);
    L.rows.forEach((r, i) => {
      const x = L.xOf(i);
      const up = r.c >= r.o;
      const col = up ? chartTheme().up : chartTheme().down;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, L.yOf(r.h));
      ctx.lineTo(x, L.yOf(r.l));
      ctx.stroke();
      const top = L.yOf(Math.max(r.o, r.c));
      const bot = L.yOf(Math.min(r.o, r.c));
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.92;
      ctx.fillRect(x - Math.max(1, L.bw * 0.32), top, Math.max(2, L.bw * 0.64), Math.max(1, bot - top));
      ctx.globalAlpha = 1;
    });
    this.drawings.forEach((d) => this.paintShape(L, d, false));
    if (this.draft) this.paintShape(L, this.draft, true);
    this.paintLevels(L);
    this.paintPending(L);
    this.paintSignals(L);
    if (this.tick && (this.tick.bid || this.tick.ask)) {
      const mid = ((+this.tick.bid || 0) + (+this.tick.ask || 0)) / 2;
      if (mid) {
        const yy = L.yOf(mid);
        ctx.strokeStyle = "rgba(" + chartTheme().goldT + ",.7)";
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(L.plotL, yy); ctx.lineTo(L.plotR, yy); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.hover && L.rows[this.hover.i]) {
      const r = L.rows[this.hover.i];
      const x = L.xOf(this.hover.i);
      ctx.strokeStyle = chartTheme().line;
      ctx.beginPath(); ctx.moveTo(x, L.plotT); ctx.lineTo(x, L.plotB); ctx.stroke();
      if (this.tool !== "cursor" || this.analyze) {
        const yy = this.hover.y != null ? this.hover.y : L.yOf(r.c);
        ctx.beginPath(); ctx.moveTo(L.plotL, yy); ctx.lineTo(L.plotR, yy); ctx.stroke();
      }
    }
    ctx.restore();
    ctx.fillStyle = chartTheme().panel;
    ctx.fillRect(L.w - L.padR, 0, L.padR, L.h);
    ctx.strokeStyle = chartTheme().panelLine;
    ctx.beginPath(); ctx.moveTo(L.w - L.padR, 0); ctx.lineTo(L.w - L.padR, L.h); ctx.stroke();
    ctx.fillStyle = chartTheme().muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i < 5; i++) {
      const p = L.mx - (L.span * i) / 4;
      const yy = Math.min(L.plotB - 2, Math.max(L.plotT + 2, L.yOf(p)));
      ctx.fillText(this.fmtPrice(p), L.w - 10, yy);
    }
    if (this.tick && (this.tick.bid || this.tick.ask)) {
      const mid = ((+this.tick.bid || 0) + (+this.tick.ask || 0)) / 2;
      if (mid) {
        const yy = Math.min(L.plotB - 2, Math.max(L.plotT + 2, L.yOf(mid)));
        ctx.fillStyle = chartTheme().tag;
        ctx.fillRect(L.w - L.padR + 4, yy - 9, L.padR - 8, 18);
        ctx.fillStyle = chartTheme().gold;
        ctx.fillText(this.fmtPrice(mid), L.w - 10, yy);
      }
    }
    this.paintLevelLabels(L);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    if (this.hover && L.rows[this.hover.i]) {
      const r = L.rows[this.hover.i];
      ctx.fillStyle = chartTheme().panel;
      ctx.fillRect(12, 10, 236, 78);
      ctx.fillStyle = chartTheme().text;
      ctx.fillText(r.t, 20, 26);
      ctx.fillStyle = r.c >= r.o ? chartTheme().up : chartTheme().down;
      ctx.fillText("O " + this.fmtPrice(r.o) + "  H " + this.fmtPrice(r.h), 20, 46);
      ctx.fillText("L " + this.fmtPrice(r.l) + "  C " + this.fmtPrice(r.c), 20, 64);
    }
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
    }
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
  xyOf(L, pt) {
    if (!pt) return null;
    let i = -1;
    if (pt.t) i = L.rows.findIndex((r) => r.t === pt.t);
    if (i < 0 && Number.isFinite(pt.gi)) i = pt.gi - L.start;
    if (i < 0 || i >= L.rows.length) {
      if (pt.kind === "hline" || pt.p != null) return { x: L.padL, y: L.yOf(pt.p), off: true, i };
      return null;
    }
    return { x: L.xOf(i), y: L.yOf(pt.p), i };
  }

  /* -----------------------------------------------------------------------
     Working with what you have already drawn.

     Until now a drawing was write-only: the only way to move a trend line one
     bar to the left was to clear the chart and draw it again. These three
     methods make an existing shape selectable, draggable and removable, which
     is most of what "interacting with the chart" means in practice.
     ----------------------------------------------------------------------- */

  /** The drawing nearest the pointer, within a forgiving radius. */
  shapeAt(L, x, y) {
    const near = 8;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      for (const key of ["a", "b", "c"]) {
        const pt = d[key] && this.xyOf(L, d[key]);
        if (pt && Math.hypot(pt.x - x, pt.y - y) <= near + 3) {
          return { shape: d, index: i, handle: key };
        }
      }
      const a = d.a && this.xyOf(L, d.a);
      const b = d.b && this.xyOf(L, d.b);
      if (a && b && this.nearSegment(x, y, a, b) <= near) return { shape: d, index: i, handle: null };
      // Horizontal lines have one anchor but span the plot.
      if (a && !b && (d.kind === "hline" || d.kind === "hray") && Math.abs(y - a.y) <= near) {
        return { shape: d, index: i, handle: null };
      }
      if (a && !b && d.kind === "vline" && Math.abs(x - a.x) <= near) {
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

  select(shape) {
    this.selected = shape || null;
    this.draw();
  }

  deleteSelected() {
    if (!this.selected) return false;
    const at = this.drawings.indexOf(this.selected);
    if (at >= 0) this.drawings.splice(at, 1);
    this.selected = null;
    this.saveDrawings && this.saveDrawings();
    this.draw();
    return true;
  }

  /** Move a whole shape, or just the handle that was grabbed. */
  moveSelected(from, to, handle) {
    const d = this.selected;
    if (!d || !from || !to) return;
    const dGi = (to.gi || 0) - (from.gi || 0);
    const dP = (to.p || 0) - (from.p || 0);
    const shift = (pt) => {
      if (!pt) return pt;
      pt.gi = (pt.gi || 0) + dGi;
      pt.p = (pt.p || 0) + dP;
      return pt;
    };
    if (handle && d[handle]) shift(d[handle]);
    else ["a", "b", "c"].forEach((k) => shift(d[k]));
    if (Array.isArray(d.pts)) d.pts.forEach(shift);
    this.draw();
  }

  paintShape(L, d, ghost) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = ghost ? 0.7 : 1;
    const chosen = !ghost && this.selected === d;
    if (chosen) {
      // Handles on the anchors, so it is obvious what can be grabbed.
      ["a", "b", "c"].forEach((k) => {
        const pt = d[k] && this.xyOf(L, d[k]);
        if (!pt) return;
        ctx.fillStyle = chartTheme().text;
        ctx.strokeStyle = chartTheme().panel;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      });
    }
    ctx.strokeStyle = d.color || chartTheme().gold;
    ctx.fillStyle = d.color || chartTheme().gold;
    ctx.lineWidth = 1.4;
    const a = this.xyOf(L, d.a);
    const b = this.xyOf(L, d.b || d.a);
    const kind = d.kind;
    if ((kind === "hline" || kind === "hray") && d.a) {
      const y = L.yOf(d.a.p);
      ctx.setLineDash(kind === "hray" ? [] : [6, 4]);
      ctx.beginPath();
      if (kind === "hray" && a) { ctx.moveTo(a.x, y); ctx.lineTo(L.plotR, y); }
      else { ctx.moveTo(L.plotL, y); ctx.lineTo(L.plotR, y); }
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (kind === "vline" && a) {
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, L.plotT); ctx.lineTo(a.x, L.plotB); ctx.stroke();
      ctx.setLineDash([]);
    } else if ((kind === "trend" || kind === "ray" || kind === "extended" || kind === "measure" || kind === "arrow" || kind === "infoline") && a && b) {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (kind === "ray" || kind === "extended") {
        const dx = b.x - a.x, dy = b.y - a.y;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + dx * 8, b.y + dy * 8); ctx.stroke();
        if (kind === "extended") {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x - dx * 8, a.y - dy * 8); ctx.stroke();
        }
      }
      if (kind === "arrow") {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
        ctx.stroke();
      }
      if (kind === "measure" || kind === "infoline" || kind === "pricerange") {
        const dp = (d.b.p - d.a.p);
        const bars = Math.abs((d.b.gi || 0) - (d.a.gi || 0));
        const pct = d.a.p ? (dp / d.a.p) * 100 : 0;
        const label = this.fmtPrice(dp) + "   " + pct.toFixed(2) + "%   " + bars + "b";
        const tw = Math.min(240, ctx.measureText(label).width + 16);
        let lx = (a.x + b.x) / 2 - tw / 2;
        let ly = (a.y + b.y) / 2 - 16;
        lx = Math.max(L.plotL + 4, Math.min(L.plotR - tw - 4, lx));
        ly = Math.max(L.plotT + 4, Math.min(L.plotB - 28, ly));
        ctx.fillStyle = chartTheme().panel;
        ctx.fillRect(lx, ly, tw, 26);
        ctx.fillStyle = dp >= 0 ? chartTheme().up : chartTheme().down;
        ctx.fillText(label, lx + 8, ly + 17);
      }
    } else if (kind === "daterange" && a && b) {
      const x = Math.min(a.x, b.x), w = Math.abs(b.x - a.x);
      ctx.fillStyle = "rgba(" + chartTheme().violetT + ",.12)";
      ctx.fillRect(x, L.plotT, w, L.plotB - L.plotT);
      ctx.strokeRect(x, L.plotT, w, L.plotB - L.plotT);
    } else if (kind === "pricerange" && a && b) {
      const y = Math.min(a.y, b.y), h = Math.abs(b.y - a.y);
      ctx.fillStyle = "rgba(" + chartTheme().upT + ",.1)";
      ctx.fillRect(L.plotL, y, L.plotR - L.plotL, h);
      ctx.strokeRect(L.plotL, y, L.plotR - L.plotL, h);
      // The measurement was written in a branch this kind never reaches, so a
      // price range drew a band and told you nothing about it.
      const dp = d.b.p - d.a.p;
      const pct = d.a.p ? (dp / d.a.p) * 100 : 0;
      const label = this.fmtPrice(Math.abs(dp)) + "   " + Math.abs(pct).toFixed(2) + "%";
      ctx.fillStyle = chartTheme().panel;
      const tw = ctx.measureText(label).width + 16;
      ctx.fillRect(L.plotL + 8, y + h / 2 - 13, tw, 26);
      ctx.fillStyle = dp >= 0 ? chartTheme().up : chartTheme().down;
      ctx.fillText(label, L.plotL + 16, y + h / 2 + 4);
    } else if (kind === "rect" && a && b) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      ctx.fillStyle = "rgba(" + chartTheme().violetT + ",.12)";
      ctx.fillRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if ((kind === "long" || kind === "short") && a && b) {
      // A position tool that only draws a box is a rectangle with a label on
      // it. What a trader needs from it is the trade: where the stop is, where
      // the target is, and whether the reward is worth the risk. Drag sets the
      // entry and the stop; the target is projected at 2R and both zones are
      // drawn to scale, so an unbalanced trade looks unbalanced.
      const long = kind === "long";
      const entry = d.a.p;
      const stop = d.b.p;
      const risk = Math.abs(entry - stop);
      const rr = Number(d.rr || 2);
      const target = long ? entry + risk * rr : entry - risk * rr;

      const x = Math.min(a.x, b.x);
      const w = Math.max(40, Math.abs(b.x - a.x));
      const yEntry = L.yOf(entry);
      const yStop = L.yOf(stop);
      const yTarget = L.yOf(target);

      ctx.fillStyle = "rgba(" + chartTheme().downT + ",.14)";
      ctx.fillRect(x, Math.min(yEntry, yStop), w, Math.abs(yStop - yEntry));
      ctx.fillStyle = "rgba(" + chartTheme().upT + ",.14)";
      ctx.fillRect(x, Math.min(yEntry, yTarget), w, Math.abs(yTarget - yEntry));

      ctx.setLineDash([4, 3]);
      [[yStop, chartTheme().down], [yTarget, chartTheme().up]].forEach(([yy, col]) => {
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.strokeStyle = chartTheme().text;
      ctx.beginPath(); ctx.moveTo(x, yEntry); ctx.lineTo(x + w, yEntry); ctx.stroke();

      const pct = entry ? (Math.abs(target - entry) / entry) * 100 : 0;
      const lines = [
        (long ? "LONG" : "SHORT") + "  " + rr.toFixed(1) + "R",
        "entry " + this.fmtPrice(entry),
        "stop  " + this.fmtPrice(stop) + "   -" + this.fmtPrice(risk),
        "target " + this.fmtPrice(target) + "   +" + pct.toFixed(2) + "%",
      ];
      const bw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
      const by = Math.min(yTarget, yStop) - 4;
      ctx.fillStyle = chartTheme().panel;
      ctx.fillRect(x, by - lines.length * 14 - 6, bw, lines.length * 14 + 8);
      lines.forEach((t, i) => {
        ctx.fillStyle = i === 0 ? (long ? chartTheme().up : chartTheme().down) : chartTheme().muted;
        ctx.fillText(t, x + 8, by - (lines.length - i) * 14 + 8);
      });
    } else if (kind === "circle" && a && b) {
      const rr = Math.max(4, Math.hypot(b.x - a.x, b.y - a.y));
      ctx.beginPath(); ctx.arc(a.x, a.y, rr, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === "ellipse" && a && b) {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(2, Math.abs(b.x - a.x) / 2), Math.max(2, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === "triangle" && a && b) {
      const c = this.xyOf(L, d.c);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      if (c) { ctx.lineTo(c.x, c.y); ctx.closePath(); }
      ctx.stroke();
    } else if ((kind === "parallel" || kind === "channel") && a && b) {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const c = this.xyOf(L, d.c);
      if (c) {
        const dx = b.x - a.x, dy = b.y - a.y;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + dx, c.y + dy); ctx.stroke();
        ctx.strokeStyle = "rgba(" + chartTheme().goldT + ",.35)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(c.x + dx, c.y + dy); ctx.stroke();
        if (kind === "channel") {
          ctx.fillStyle = "rgba(" + chartTheme().goldT + ",.08)";
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.lineTo(c.x + dx, c.y + dy); ctx.lineTo(c.x, c.y);
          ctx.closePath(); ctx.fill();
        }
      }
    } else if (kind === "pitchfork" && a && b) {
      const c = this.xyOf(L, d.c);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (c) {
        const mx = (b.x + c.x) / 2, my = (b.y + c.y) / 2;
        const dx = mx - a.x, dy = my - a.y;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + dx * 6, a.y + dy * 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + dx * 6, b.y + dy * 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + dx * 6, c.y + dy * 6); ctx.stroke();
      }
    } else if (kind === "gann" && a && b) {
      const ratios = [1, 2, 0.5, 3, 1 / 3];
      ratios.forEach((r, n) => {
        ctx.strokeStyle = n === 0 ? chartTheme().gold : "rgba(" + chartTheme().goldT + ",.55)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y + (b.y - a.y) * r); ctx.stroke();
      });
    } else if ((kind === "fib" || kind === "fibext") && a && b) {
      // Both fib tools used to stretch every level across the full plot width,
      // which made them indistinguishable from each other and from a price
      // range. A retracement belongs to the swing it was drawn on: the levels
      // span the two anchors and extend a little to the right, the way every
      // charting package draws them.
      const ext = kind === "fibext";
      const levels = ext
        ? [0, 0.618, 1, 1.272, 1.618, 2, 2.618]
        : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const key = ext ? [1.618, 2.618] : [0.5, 0.618];
      const hi = d.a.p, lo = d.b.p;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const tail = Math.min(L.plotR, x1 + (x1 - x0) * (ext ? 1.0 : 0.35));

      // Shade between neighbouring levels so the zones read at a glance.
      for (let i = 0; i < levels.length - 1; i++) {
        const yA = L.yOf(hi + (lo - hi) * levels[i]);
        const yB = L.yOf(hi + (lo - hi) * levels[i + 1]);
        ctx.fillStyle = i % 2
          ? "rgba(" + chartTheme().goldT + ",.05)"
          : "rgba(" + chartTheme().violetT + ",.05)";
        ctx.fillRect(x0, Math.min(yA, yB), tail - x0, Math.abs(yB - yA));
      }
      levels.forEach((lv) => {
        const p = hi + (lo - hi) * lv;
        const y = L.yOf(p);
        const strong = key.includes(lv);
        ctx.strokeStyle = strong ? chartTheme().up : "rgba(" + chartTheme().goldT + ",.7)";
        ctx.lineWidth = strong ? 1.6 : 1;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(tail, y); ctx.stroke();
        ctx.fillStyle = chartTheme().fib;
        ctx.fillText(lv.toFixed(3) + "  " + this.fmtPrice(p), x0 + 6, y - 3);
      });
      ctx.lineWidth = 1.4;
      // The swing itself, so the trader can see what the levels were taken from.
      ctx.strokeStyle = "rgba(" + chartTheme().goldT + ",.45)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (kind === "fibtime" && a && b) {
      const ratios = [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618];
      const span = (b.x - a.x) || 1;
      ratios.forEach((lv) => {
        const x = a.x + span * lv;
        ctx.strokeStyle = lv === 0.618 || lv === 1.618 ? chartTheme().up : "rgba(" + chartTheme().violetT + ",.7)";
        ctx.beginPath(); ctx.moveTo(x, L.plotT); ctx.lineTo(x, L.plotB); ctx.stroke();
        ctx.fillStyle = chartTheme().fib;
        ctx.fillText(lv.toFixed(3), x + 4, L.plotT + 12);
      });
    } else if (kind === "brush" && Array.isArray(d.pts)) {
      ctx.beginPath();
      d.pts.forEach((pt, i) => {
        const xy = this.xyOf(L, pt);
        if (!xy) return;
        if (i === 0) ctx.moveTo(xy.x, xy.y);
        else ctx.lineTo(xy.x, xy.y);
      });
      ctx.stroke();
    } else if ((kind === "text" || kind === "emoji") && a) {
      ctx.font = kind === "emoji" ? "18px sans-serif" : "13px Outfit, Vazirmatn, sans-serif";
      ctx.fillStyle = chartTheme().text;
      ctx.fillText(d.text || "", a.x + 6, a.y - 6);
    }
    ctx.restore();
  }
  onWheel(e) {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    this.span = Math.max(20, Math.min(this.bars.length || 20, this.span + dir * 6));
    this.draw();
  }
  needsThird(kind) {
    return kind === "parallel" || kind === "channel" || kind === "pitchfork" || kind === "triangle";
  }
  askText(kind, pt) {
    const finish = (txt) => {
      if (!txt) return;
      this.drawings.push({ kind, a: pt, text: txt, color: chartTheme().gold });
      this.persist();
      this.draw();
    };
    if (typeof this.opts.onText === "function") {
      this.opts.onText(kind === "emoji" ? "🙂" : "", finish);
      return;
    }
    const txt = window.prompt("", kind === "emoji" ? "📌" : "");
    finish(txt);
  }
  onDown(e) {
    this._moved = false;
    const hit = this.snapHit(this.hit(e));
    if (this.tool === "cursor" && hit && hit.L) {
      const kind = this.pendingHit(hit.L, hit.y);
      if (kind) {
        this.dragLevel = kind;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = "ns-resize";
        return;
      }
      if (this.pickPrice) {
        this._priceClick = hit.p;
        return;
      }
    }
    if (this.draft && this.draft._locked && hit && hit.valid) {
      this.draft.c = { t: hit.t, p: hit.p, gi: hit.gi };
      this.drawings.push(this.draft);
      this.draft = null;
      this.persist();
      this.draw();
      return;
    }
    if (this.draft && this.needsThird(this.draft.kind) && !this.draft._locked && hit && hit.valid) {
      this.draft.b = { t: hit.t, p: hit.p, gi: hit.gi };
      this.draft._locked = true;
      this.draw();
      return;
    }
    if (this.tool === "cursor") {
      this.drag = { x: e.clientX, off: this.offset };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (!hit) return;
    const pt = { t: hit.t, p: hit.p, gi: hit.gi };
    if (this.tool === "hline" || this.tool === "vline" || this.tool === "hray" || this.tool === "text" || this.tool === "emoji") {
      if (this.tool === "text" || this.tool === "emoji") {
        this.askText(this.tool, pt);
        return;
      }
      this.drawings.push({ kind: this.tool, a: pt, color: chartTheme().gold });
      this.persist();
      this.draw();
      return;
    }
    if (this.tool === "brush") {
      this.draft = { kind: "brush", pts: [pt], a: pt, b: pt, color: chartTheme().gold };
      return;
    }
    const color = (this.tool === "fib" || this.tool === "fibext" || this.tool === "fibtime") ? "#7c6cff"
      : (this.tool === "long" ? chartTheme().up : (this.tool === "short" ? chartTheme().down : chartTheme().gold));
    this.draft = { kind: this.tool, a: pt, b: pt, color };
  }
  onMove(e) {
    this._moved = true;
    const hit = this.hit(e);
    if (hit && hit.valid) this.hover = { i: hit.i, y: hit.y };
    else this.hover = null;
    if (this.dragLevel && hit && hit.L) {
      const p = hit.L.pOf(hit.y);
      this.pending = { ...(this.pending || {}), [this.dragLevel]: p };
      if (typeof this.opts.onPending === "function") this.opts.onPending({ ...this.pending, kind: this.dragLevel });
      this.draw();
      return;
    }
    if (this.draft && hit) {
      const pt = { t: hit.t, p: hit.p, gi: hit.gi };
      if (this.draft._locked) this.draft.c = pt;
      else if (this.draft.kind === "brush") {
        this.draft.pts = (this.draft.pts || []).concat([pt]).slice(-400);
        this.draft.b = pt;
      } else this.draft.b = pt;
    }
    if (this.drag && this.tool === "cursor") {
      const L = this.layout();
      if (L) {
        const dx = e.clientX - this.drag.x;
        const rtl = document.documentElement.dir === "rtl" ? -1 : 1;
        this.offset = Math.max(0, Math.min(Math.max(0, this.bars.length - this.span), this.drag.off + Math.round((-dx * rtl) / L.bw)));
      }
    }
    this.draw();
  }
  onUp(e) {
    if (this.dragLevel) {
      this.dragLevel = null;
      this.canvas.style.cursor = this.tool === "cursor" ? "grab" : "crosshair";
      this.draw();
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
    if (!this._moved && this.tool === "cursor" && typeof this.opts.onPrice === "function") {
      const hit = this.hit(e || { clientX: 0, clientY: 0 });
      if (hit && hit.valid) this.opts.onPrice(hit.p);
    }
    if (this.draft && this.needsThird(this.draft.kind)) {
      this.drag = null;
      this.draw();
      return;
    }
    if (this.draft) {
      if (this.draft.kind === "brush" || this.draft.b) {
        this.drawings.push(this.draft);
        this.persist();
      }
    }
    this.draft = null;
    this.drag = null;
    this.canvas.style.cursor = this.tool === "cursor" ? "grab" : "crosshair";
    this.draw();
  }
  onTouch(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (!this.pinch) this.pinch = { d, span: this.span };
      else {
        const k = this.pinch.d / d;
        this.span = Math.max(20, Math.min(this.bars.length || 20, Math.round(this.pinch.span * k)));
        this.draw();
      }
    } else this.pinch = null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MARKET_SESSIONS, sessionCovers, sessionsAt };
}
