/**
 * The account's own profit and loss, drawn.
 *
 * The history page was a ledger and nothing else: four hundred rows of
 * numbers with no shape to them. A trader reading it cannot see whether
 * the account is grinding up or bleeding out, which days hurt, or which
 * symbol is paying for the others -- all of which is in the rows already
 * and none of which a table shows.
 *
 * Everything here is derived from closed trades the engine recorded. No
 * figure is modelled, smoothed or filled in: if there are no closes there
 * is no chart, and a gap in the ledger is a gap on the screen. That is the
 * point of drawing the ledger rather than a simulation of it.
 *
 * The charts are SVG sized in real pixels rather than a scaled viewBox,
 * because a viewBox scales its text too -- an 11px label becomes 6px on a
 * phone and 20px on a desktop. Measuring the container and drawing at that
 * size keeps labels legible at both ends, which is the whole reason the
 * desk has a mobile layout at all.
 */
(function (global) {
  "use strict";

  const esc = (s) => String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

  /* Two decimals for money, thousands separated, sign kept. The desk's own
     fmt() lives in app.js and this file loads before it, so it is repeated
     rather than reached for. */
  const money = (v) => {
    const n = Number(v) || 0;
    return (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  };
  const short = (v) => {
    const n = Number(v) || 0;
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
    if (a >= 100) return n.toFixed(0);
    return n.toFixed(a >= 10 ? 1 : 2);
  };

  const t = (key, fallback) => {
    try {
      if (global.I18N && typeof global.I18N.t === "function") {
        const s = global.I18N.t(key);
        if (s && s !== key) return s;
      }
    } catch (_) { /* i18n is optional here */ }
    return fallback;
  };

  /* ------------------------------------------------------------------ data */

  /** A row is a close if the engine tagged it one. Mirrors historyRowView. */
  function isClose(row) {
    return Boolean(String((row && (row.kind || row.entry)) || "").toLowerCase().match(/close|out/));
  }

  /**
   * Closed trades, oldest first, with the running total alongside.
   *
   * Net is preferred over profit because the account moves by
   * profit + swap + commission; MT5's Profit column is gross and will not
   * reconcile against the balance on its own.
   */
  function series(rows) {
    const closed = (Array.isArray(rows) ? rows : []).filter(isClose).map((row) => {
      const profit = num(row.profit);
      const swap = num(row.swap);
      const comm = num(row.commission);
      const net = row.net !== undefined && row.net !== null && row.net !== ""
        ? num(row.net) : profit + swap + comm;
      return {
        ts: String(row.ts || ""),
        day: String(row.ts || "").slice(0, 10),
        ticket: row.ticket,
        symbol: String(row.symbol || "—"),
        strategy: String(row.strategy || t("history.no_strategy", "manual")),
        side: String(row.side || ""),
        volume: num(row.volume),
        profit, swap, commission: comm, net,
      };
    });

    /* Oldest first so the curve reads left to right. The ledger arrives
       newest first and ties are common when several positions close on the
       same tick, so the ticket breaks them rather than leaving the order to
       the sort's stability. */
    closed.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : num(a.ticket) - num(b.ticket)));

    let cum = 0, peak = 0, maxDD = 0;
    for (const trade of closed) {
      cum += trade.net;
      trade.cum = cum;
      if (cum > peak) peak = cum;
      trade.dd = cum - peak;
      if (trade.dd < maxDD) maxDD = trade.dd;
    }

    const wins = closed.filter((x) => x.net > 0);
    const losses = closed.filter((x) => x.net < 0);
    const grossWin = wins.reduce((s, x) => s + x.net, 0);
    const grossLoss = Math.abs(losses.reduce((s, x) => s + x.net, 0));

    return {
      trades: closed,
      stats: {
        trades: closed.length,
        wins: wins.length,
        losses: losses.length,
        flat: closed.length - wins.length - losses.length,
        net: cum,
        winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
        grossWin, grossLoss,
        /* No denominator means no ratio. Printing a large number for "never
           lost" would be an invented figure. */
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        avgWin: wins.length ? grossWin / wins.length : 0,
        avgLoss: losses.length ? grossLoss / losses.length : 0,
        expectancy: closed.length ? cum / closed.length : 0,
        best: closed.length ? Math.max(...closed.map((x) => x.net)) : 0,
        worst: closed.length ? Math.min(...closed.map((x) => x.net)) : 0,
        maxDrawdown: maxDD,
        fees: closed.reduce((s, x) => s + x.swap + x.commission, 0),
      },
    };
  }

  function groupBy(trades, key) {
    const map = new Map();
    for (const trade of trades) {
      const k = trade[key] || "—";
      const row = map.get(k) || { key: k, net: 0, trades: 0, wins: 0 };
      row.net += trade.net;
      row.trades += 1;
      if (trade.net > 0) row.wins += 1;
      map.set(k, row);
    }
    return [...map.values()].sort((a, b) => b.net - a.net);
  }

  /* ----------------------------------------------------------------- modes */

  const MODES = [
    { id: "equity",   key: "pnl.m_equity",   fallback: "Equity curve" },
    { id: "trades",   key: "pnl.m_trades",   fallback: "Per trade" },
    { id: "daily",    key: "pnl.m_daily",    fallback: "Daily" },
    { id: "drawdown", key: "pnl.m_drawdown", fallback: "Drawdown" },
    { id: "donut",    key: "pnl.m_donut",    fallback: "Win / loss" },
    { id: "hist",     key: "pnl.m_hist",     fallback: "Distribution" },
    { id: "symbol",   key: "pnl.m_symbol",   fallback: "By symbol" },
    { id: "strategy", key: "pnl.m_strategy", fallback: "By strategy" },
  ];

  /* ---------------------------------------------------------------- drawing */

  const open = (w, h) =>
    `<svg class="pc-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="false">`;

  /** Horizontal rules plus their value labels, and the scale to use. */
  function vScale(lo, hi, top, bottom) {
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const pad = (hi - lo) * 0.1;
    hi += pad; lo -= pad;
    return (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  }

  function gridLines(lo, hi, y, left, right) {
    const out = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = lo + ((hi - lo) * i) / steps;
      const yy = Math.round(y(v)) + 0.5;
      out.push(`<line class="pc-grid" x1="${left}" y1="${yy}" x2="${right}" y2="${yy}"/>`);
      out.push(`<text class="pc-axis" x="${left - 6}" y="${yy + 4}" text-anchor="end">${esc(short(v))}</text>`);
    }
    return out.join("");
  }

  function emptyChart(w, h, msg) {
    return open(w, h) +
      `<text class="pc-empty" x="${w / 2}" y="${h / 2}" text-anchor="middle">${esc(msg)}</text></svg>`;
  }

  /** Cumulative realised P&L. */
  function drawEquity(data, w, h) {
    const trades = data.trades;
    if (trades.length < 1) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const L = 46, R = 12, T = 14, B = 26;
    const vals = trades.map((x) => x.cum).concat([0]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const y = vScale(lo, hi, T, h - B);
    const n = trades.length;
    const x = (i) => L + (n === 1 ? (w - L - R) / 2 : (i / (n - 1)) * (w - L - R));

    const pts = trades.map((tr, i) => `${x(i).toFixed(1)},${y(tr.cum).toFixed(1)}`);
    const up = data.stats.net >= 0;
    const area = `${L},${y(0).toFixed(1)} ${pts.join(" ")} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`;

    return open(w, h) +
      gridLines(lo, hi, y, L, w - R) +
      `<line class="pc-zero" x1="${L}" y1="${y(0).toFixed(1)}" x2="${w - R}" y2="${y(0).toFixed(1)}"/>` +
      `<polygon class="pc-area ${up ? "is-up" : "is-down"}" points="${area}"/>` +
      `<polyline class="pc-line ${up ? "is-up" : "is-down"}" points="${pts.join(" ")}"/>` +
      `<circle class="pc-dot ${up ? "is-up" : "is-down"}" cx="${x(n - 1).toFixed(1)}" cy="${y(trades[n - 1].cum).toFixed(1)}" r="3.5"/>` +
      `<text class="pc-axis" x="${L}" y="${h - 8}">${esc(trades[0].day)}</text>` +
      `<text class="pc-axis" x="${w - R}" y="${h - 8}" text-anchor="end">${esc(trades[n - 1].day)}</text>` +
      "</svg>";
  }

  /** One bar per closed trade, in the order they closed. */
  function drawTrades(data, w, h) {
    const trades = data.trades;
    if (!trades.length) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const L = 46, R = 12, T = 14, B = 26;
    const vals = trades.map((x) => x.net).concat([0]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const y = vScale(lo, hi, T, h - B);
    const zero = y(0);
    const span = w - L - R;
    const bw = Math.max(1, Math.min(18, (span / trades.length) * 0.72));

    const bars = trades.map((tr, i) => {
      const cx = L + (span / trades.length) * (i + 0.5);
      const yy = Math.min(zero, y(tr.net));
      const bh = Math.max(1, Math.abs(y(tr.net) - zero));
      return `<rect class="pc-bar ${tr.net >= 0 ? "is-up" : "is-down"}" x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1">` +
        `<title>${esc(tr.symbol)} · ${esc(tr.day)} · ${esc(money(tr.net))}</title></rect>`;
    }).join("");

    return open(w, h) + gridLines(lo, hi, y, L, w - R) +
      `<line class="pc-zero" x1="${L}" y1="${zero.toFixed(1)}" x2="${w - R}" y2="${zero.toFixed(1)}"/>` +
      bars +
      `<text class="pc-axis" x="${L}" y="${h - 8}">${esc(t("pnl.oldest", "oldest"))}</text>` +
      `<text class="pc-axis" x="${w - R}" y="${h - 8}" text-anchor="end">${esc(t("pnl.newest", "newest"))}</text>` +
      "</svg>";
  }

  /** Net per calendar day. */
  function drawDaily(data, w, h) {
    const days = groupBy(data.trades, "day").sort((a, b) => (a.key < b.key ? -1 : 1));
    if (!days.length) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const L = 46, R = 12, T = 14, B = 30;
    const vals = days.map((d) => d.net).concat([0]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const y = vScale(lo, hi, T, h - B);
    const zero = y(0);
    const span = w - L - R;
    const bw = Math.max(2, Math.min(26, (span / days.length) * 0.7));

    const bars = days.map((d, i) => {
      const cx = L + (span / days.length) * (i + 0.5);
      const yy = Math.min(zero, y(d.net));
      const bh = Math.max(1, Math.abs(y(d.net) - zero));
      return `<rect class="pc-bar ${d.net >= 0 ? "is-up" : "is-down"}" x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1">` +
        `<title>${esc(d.key)} · ${esc(money(d.net))} · ${d.trades}</title></rect>`;
    }).join("");

    return open(w, h) + gridLines(lo, hi, y, L, w - R) +
      `<line class="pc-zero" x1="${L}" y1="${zero.toFixed(1)}" x2="${w - R}" y2="${zero.toFixed(1)}"/>` +
      bars +
      `<text class="pc-axis" x="${L}" y="${h - 8}">${esc(days[0].key)}</text>` +
      `<text class="pc-axis" x="${w - R}" y="${h - 8}" text-anchor="end">${esc(days[days.length - 1].key)}</text>` +
      "</svg>";
  }

  /** How far below the high-water mark the account has been. */
  function drawDrawdown(data, w, h) {
    const trades = data.trades;
    if (!trades.length) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const L = 46, R = 12, T = 14, B = 26;
    const lo = Math.min(...trades.map((x) => x.dd), 0);
    const y = vScale(lo, 0, T, h - B);
    const n = trades.length;
    const x = (i) => L + (n === 1 ? (w - L - R) / 2 : (i / (n - 1)) * (w - L - R));
    const pts = trades.map((tr, i) => `${x(i).toFixed(1)},${y(tr.dd).toFixed(1)}`);
    const area = `${L},${y(0).toFixed(1)} ${pts.join(" ")} ${x(n - 1).toFixed(1)},${y(0).toFixed(1)}`;

    return open(w, h) + gridLines(lo, 0, y, L, w - R) +
      `<line class="pc-zero" x1="${L}" y1="${y(0).toFixed(1)}" x2="${w - R}" y2="${y(0).toFixed(1)}"/>` +
      `<polygon class="pc-area is-down" points="${area}"/>` +
      `<polyline class="pc-line is-down" points="${pts.join(" ")}"/>` +
      `<text class="pc-axis" x="${L}" y="${h - 8}">${esc(t("pnl.maxdd", "worst") + " " + money(data.stats.maxDrawdown))}</text>` +
      "</svg>";
  }

  /** Wins against losses, as a ring. */
  function drawDonut(data, w, h) {
    const s = data.stats;
    if (!s.trades) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const cx = w / 2, cy = h / 2 + 6;
    const r = Math.max(34, Math.min(cy - 18, 80));
    const thick = Math.max(14, r * 0.34);
    const parts = [
      { n: s.wins, cls: "is-up", label: t("pnl.wins", "Wins") },
      { n: s.losses, cls: "is-down", label: t("pnl.losses", "Losses") },
      { n: s.flat, cls: "is-flat", label: t("pnl.flat", "Break even") },
    ].filter((p) => p.n > 0);

    const total = parts.reduce((a, p) => a + p.n, 0) || 1;
    let angle = -Math.PI / 2;
    const arcs = parts.map((p) => {
      const sweep = (p.n / total) * Math.PI * 2;
      const end = angle + sweep;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      const large = sweep > Math.PI ? 1 : 0;
      /* A single slice covering the whole ring cannot be drawn as an arc --
         start and end land on the same point and the path collapses. */
      const d = parts.length === 1
        ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`
        : `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
      angle = end;
      return `<path class="pc-arc ${p.cls}" d="${d}" stroke-width="${thick.toFixed(1)}" fill="none">` +
        `<title>${esc(p.label)} · ${p.n}</title></path>`;
    }).join("");

    const legend = parts.map((p, i) => {
      const ly = 20 + i * 18;
      return `<rect class="pc-key ${p.cls}" x="12" y="${ly - 8}" width="10" height="10" rx="2"/>` +
        `<text class="pc-axis" x="28" y="${ly + 1}">${esc(p.label)} ${p.n}</text>`;
    }).join("");

    return open(w, h) + arcs + legend +
      `<text class="pc-big" x="${cx}" y="${cy + 2}" text-anchor="middle">${s.winRate.toFixed(1)}%</text>` +
      `<text class="pc-axis" x="${cx}" y="${cy + 20}" text-anchor="middle">${esc(t("history.winrate", "Win rate"))}</text>` +
      "</svg>";
  }

  /** How the individual results are spread. */
  function drawHist(data, w, h) {
    const nets = data.trades.map((x) => x.net);
    if (!nets.length) return emptyChart(w, h, t("pnl.empty", "No closed trades yet"));
    const L = 46, R = 12, T = 14, B = 30;
    let lo = Math.min(...nets), hi = Math.max(...nets);
    if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
    const bins = Math.max(4, Math.min(16, Math.ceil(Math.sqrt(nets.length))));
    const step = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of nets) counts[Math.min(bins - 1, Math.floor((v - lo) / step))] += 1;

    const top = Math.max(...counts) || 1;
    const y = (c) => (h - B) - (c / top) * (h - B - T);
    const span = w - L - R;
    const bw = (span / bins) * 0.86;

    const bars = counts.map((c, i) => {
      const from = lo + step * i, to = from + step;
      const cx = L + (span / bins) * (i + 0.5);
      const yy = y(c);
      return `<rect class="pc-bar ${to <= 0 ? "is-down" : from >= 0 ? "is-up" : "is-flat"}" x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, (h - B) - yy).toFixed(1)}" rx="1">` +
        `<title>${esc(short(from))} … ${esc(short(to))} · ${c}</title></rect>`;
    }).join("");

    const ticks = [];
    for (let i = 0; i <= 4; i++) {
      const c = Math.round((top * i) / 4);
      const yy = Math.round(y(c)) + 0.5;
      ticks.push(`<line class="pc-grid" x1="${L}" y1="${yy}" x2="${w - R}" y2="${yy}"/>`);
      ticks.push(`<text class="pc-axis" x="${L - 6}" y="${yy + 4}" text-anchor="end">${c}</text>`);
    }

    return open(w, h) + ticks.join("") + bars +
      `<text class="pc-axis" x="${L}" y="${h - 8}">${esc(short(lo))}</text>` +
      `<text class="pc-axis" x="${w - R}" y="${h - 8}" text-anchor="end">${esc(short(hi))}</text>` +
      "</svg>";
  }

  /** Net per symbol or per strategy, worst at the bottom. */
  function drawRanked(data, w, h, key, emptyMsg) {
    const rows = groupBy(data.trades, key);
    if (!rows.length) return emptyChart(w, h, emptyMsg);
    const show = rows.slice(0, 8);
    const L = 86, R = 52, T = 10;
    const rowH = Math.max(18, Math.min(34, (h - T - 8) / show.length));
    const span = w - L - R;
    const widest = Math.max(...show.map((r) => Math.abs(r.net)), 1);
    /* A zero line in the middle only when something is negative; all-positive
       data should use the full width rather than half of it. */
    const anyNeg = show.some((r) => r.net < 0);
    const zeroX = anyNeg ? L + span / 2 : L;
    const scale = anyNeg ? (span / 2) / widest : span / widest;

    const bars = show.map((r, i) => {
      const cy = T + rowH * i;
      const len = Math.max(1, Math.abs(r.net) * scale);
      const bx = r.net >= 0 ? zeroX : zeroX - len;
      const bh = rowH * 0.6;
      return `<text class="pc-axis pc-name" x="${L - 8}" y="${(cy + bh / 2 + 4).toFixed(1)}" text-anchor="end">${esc(r.key)}</text>` +
        `<rect class="pc-bar ${r.net >= 0 ? "is-up" : "is-down"}" x="${bx.toFixed(1)}" y="${cy.toFixed(1)}" width="${len.toFixed(1)}" height="${bh.toFixed(1)}" rx="2">` +
        `<title>${esc(r.key)} · ${esc(money(r.net))} · ${r.trades}</title></rect>` +
        `<text class="pc-axis pc-val ${r.net >= 0 ? "is-up" : "is-down"}" x="${w - R + 6}" y="${(cy + bh / 2 + 4).toFixed(1)}">${esc(money(r.net))}</text>`;
    }).join("");

    const zero = anyNeg
      ? `<line class="pc-zero" x1="${zeroX}" y1="${T}" x2="${zeroX}" y2="${(T + rowH * show.length).toFixed(1)}"/>` : "";
    return open(w, h) + zero + bars + "</svg>";
  }

  const DRAW = {
    equity: drawEquity,
    trades: drawTrades,
    daily: drawDaily,
    drawdown: drawDrawdown,
    donut: drawDonut,
    hist: drawHist,
    symbol: (d, w, h) => drawRanked(d, w, h, "symbol", t("pnl.empty", "No closed trades yet")),
    strategy: (d, w, h) => drawRanked(d, w, h, "strategy", t("pnl.empty", "No closed trades yet")),
  };

  function render(mode, data, width, height) {
    const draw = DRAW[mode] || DRAW.equity;
    const w = Math.max(260, Math.round(width || 640));
    const h = Math.max(170, Math.round(height || 240));
    return draw(data, w, h);
  }

  /** The figures printed above the chart. Every one is a sum of real rows. */
  function summary(stats) {
    const cell = (label, value, cls) =>
      `<div class="pc-stat"><span>${esc(label)}</span><b class="${cls || ""}">${esc(value)}</b></div>`;
    const sign = (v) => (v > 0 ? "t-up" : v < 0 ? "t-down" : "");
    return `<div class="pc-stats">
      ${cell(t("history.net", "Net"), money(stats.net), "mono " + sign(stats.net))}
      ${cell(t("history.trades", "Trades"), String(stats.trades), "mono")}
      ${cell(t("history.winrate", "Win rate"), stats.trades ? stats.winRate.toFixed(1) + "%" : "—", "mono")}
      ${cell(t("history.pf", "Profit factor"), stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2), "mono")}
      ${cell(t("pnl.best", "Best"), money(stats.best), "mono t-up")}
      ${cell(t("pnl.worst", "Worst"), money(stats.worst), "mono t-down")}
      ${cell(t("pnl.maxdd", "Max drawdown"), money(stats.maxDrawdown), "mono t-down")}
      ${cell(t("pnl.fees", "Swap + commission"), money(stats.fees), "mono " + sign(stats.fees))}
    </div>`;
  }

  global.PNL = { series, render, summary, modes: () => MODES.slice(), groupBy, isClose, money, MODES };
})(typeof window !== "undefined" ? window : globalThis);
