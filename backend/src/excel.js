"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { EXPORTS } = require("./paths");
const { t, pack } = require("./i18n");

function localeFor(lang) {
  return pack(lang).meta || { locale: "en-GB" };
}

function xml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="7">
    <font><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/></font>
    <font><b/><sz val="18"/><color rgb="FF10233F"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FF0B6B2E"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FF9B1B1B"/><name val="Calibri"/></font>
    <font><sz val="11"/><color rgb="FF334155"/><name val="Calibri"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3F5F8"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF163A6B"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD4EDDA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8D7DA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F4FC"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFC5CDD8"/></left>
      <right style="thin"><color rgb="FFC5CDD8"/></right>
      <top style="thin"><color rgb="FFC5CDD8"/></top>
      <bottom style="thin"><color rgb="FFC5CDD8"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="4" fontId="4" fillId="5" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="4" fontId="5" fillId="6" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"/>
    <xf numFmtId="4" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="4" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="6" fillId="7" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

const S = {
  base: 0,
  title: 1,
  label: 2,
  value: 3,
  header: 4,
  profitUp: 5,
  profitDown: 6,
  buy: 7,
  sell: 8,
  cell: 9,
  cellAlt: 10,
  num: 11,
  numAlt: 12,
  accent: 13,
};

function cellXml(ref, value, style) {
  const sAttr = style === undefined || style === null ? "" : ` s="${style}"`;
  const num = typeof value === "number" && Number.isFinite(value);
  if (num) return `<c r="${ref}"${sAttr} t="n"><v>${value}</v></c>`;
  if (value === null || value === undefined || value === "") {
    return `<c r="${ref}"${sAttr}/>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
}

function sheetXml(rows, opts) {
  opts = opts || {};
  const widths = opts.widths || [];
  const freeze = opts.freeze || 0;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheetPr><tabColor rgb="FFE8C07A"/></sheetPr>',
    '<sheetViews><sheetView workbookViewId="0" zoomScale="120" showGridLines="1">',
  ];
  if (freeze > 0) {
    parts.push(
      `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>`
    );
  }
  parts.push("</sheetView></sheetViews>");
  if (widths.length) {
    parts.push("<cols>");
    widths.forEach((w, i) => {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
    });
    parts.push("</cols>");
  }
  parts.push("<sheetData>");
  rows.forEach((row, i) => {
    const r = i + 1;
    const ht = i === 0 && opts.titleRow ? ' ht="28" customHeight="1"' : "";
    parts.push(`<row r="${r}"${ht}>`);
    row.forEach((cell, c) => {
      const ref = `${colName(c + 1)}${r}`;
      if (cell && typeof cell === "object" && !Array.isArray(cell) && ("v" in cell || "s" in cell)) {
        parts.push(cellXml(ref, cell.v, cell.s));
      } else {
        parts.push(cellXml(ref, cell, opts.defaultStyle));
      }
    });
    parts.push("</row>");
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function contentTypes(sheetCount) {
  const overrides = [];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides.join("")}
</Types>`;
}

function workbookXml(names) {
  const sheets = names
    .map((n, i) => `<sheet name="${xml(n).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets}</sheets>
</workbook>`;
}

function workbookRels(count) {
  const rels = [];
  for (let i = 1; i <= count; i++) {
    rels.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
    );
  }
  rels.push(
    `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sideStyle(side) {
  const s = String(side || "").toLowerCase();
  if (s === "buy") return S.buy;
  if (s === "sell") return S.sell;
  return S.cell;
}

function profitStyle(profit) {
  const n = Number(profit);
  if (n > 0) return S.profitUp;
  if (n < 0) return S.profitDown;
  return S.num;
}

async function exportHistory({ lang, trades, equity, account, metrics }) {
  fs.mkdirSync(EXPORTS, { recursive: true });
  const meta = localeFor(lang);
  const cover = [
    [{ v: t(lang, "brand.name"), s: S.title }, { v: t(lang, "brand.tagline"), s: S.accent }],
    [{ v: t(lang, "command.login"), s: S.label }, { v: account && account.login, s: S.value }],
    [{ v: t(lang, "command.server"), s: S.label }, { v: account && account.server, s: S.value }],
    [{ v: t(lang, "command.currency"), s: S.label }, { v: account && account.currency, s: S.value }],
    [{ v: t(lang, "command.balance"), s: S.label }, { v: num(account && account.balance), s: S.num }],
    [{ v: t(lang, "command.equity"), s: S.label }, { v: num(account && account.equity), s: S.num }],
    [{ v: t(lang, "history.net"), s: S.label }, { v: num(metrics && metrics.net), s: profitStyle(metrics && metrics.net) }],
    [{ v: t(lang, "history.winrate"), s: S.label }, { v: num(metrics && metrics.win_rate), s: S.accent }],
    [{ v: t(lang, "history.pf"), s: S.label }, { v: num(metrics && metrics.profit_factor), s: S.num }],
    [{ v: t(lang, "history.sharpe"), s: S.label }, { v: num(metrics && metrics.sharpe), s: S.num }],
    [{ v: t(lang, "history.rr"), s: S.label }, { v: num(metrics && metrics.avg_rr), s: S.num }],
  ];
  const tradeHead = [
    t(lang, "table.time"),
    t(lang, "table.ticket"),
    t(lang, "table.symbol"),
    t(lang, "table.side"),
    t(lang, "table.volume"),
    t(lang, "table.price"),
    t(lang, "table.sl"),
    t(lang, "table.tp"),
    t(lang, "table.profit"),
    t(lang, "table.strategy") !== "table.strategy" ? t(lang, "table.strategy") : "Strategy",
    t(lang, "table.comment"),
  ].map((h) => ({ v: h, s: S.header }));
  const tradeRows = [tradeHead];
  for (const trade of trades || []) {
    const alt = tradeRows.length % 2 === 0;
    const textS = alt ? S.cellAlt : S.cell;
    const numS = alt ? S.numAlt : S.num;
    const side = trade.side || trade.type || "";
    const profit = num(trade.profit);
    tradeRows.push([
      { v: trade.ts || trade.time || "", s: textS },
      { v: trade.ticket ?? "", s: textS },
      { v: trade.symbol ?? "", s: textS },
      { v: side, s: sideStyle(side) },
      { v: num(trade.volume), s: numS },
      { v: num(trade.price), s: numS },
      { v: num(trade.sl), s: numS },
      { v: num(trade.tp), s: numS },
      { v: profit, s: profitStyle(profit) },
      { v: trade.strategy || "", s: textS },
      { v: trade.comment || "", s: textS },
    ]);
  }
  const eqHead = [
    t(lang, "table.time"),
    t(lang, "command.balance"),
    t(lang, "command.equity"),
    t(lang, "command.profit"),
    t(lang, "command.drawdown"),
  ].map((h) => ({ v: h, s: S.header }));
  const eqRows = [eqHead];
  for (const point of equity || []) {
    const alt = eqRows.length % 2 === 0;
    const textS = alt ? S.cellAlt : S.cell;
    const numS = alt ? S.numAlt : S.num;
    const pl = num(point.profit);
    eqRows.push([
      { v: point.ts || "", s: textS },
      { v: num(point.balance), s: numS },
      { v: num(point.equity), s: numS },
      { v: pl, s: profitStyle(pl) },
      { v: num(point.drawdown), s: numS },
    ]);
  }
  const names = [
    t(lang, "history.title") || "History",
    t(lang, "command.equity") || "Equity",
    t(lang, "brand.name") || "AURION",
  ];
  const files = [
    { name: "[Content_Types].xml", data: contentTypes(3) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: workbookXml(names) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels(3) },
    { name: "xl/styles.xml", data: STYLES },
    {
      name: "xl/worksheets/sheet1.xml",
      data: sheetXml(tradeRows, { freeze: 1, widths: [22, 12, 14, 10, 12, 14, 12, 12, 14, 16, 28] }),
    },
    {
      name: "xl/worksheets/sheet2.xml",
      data: sheetXml(eqRows, { freeze: 1, widths: [22, 16, 16, 14, 14] }),
    },
    {
      name: "xl/worksheets/sheet3.xml",
      data: sheetXml(cover, { widths: [28, 40], titleRow: true }),
    },
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `aurion-history-${lang}-${stamp}.xlsx`;
  const dest = path.join(EXPORTS, filename);
  fs.writeFileSync(dest, zipStore(files));
  return { filename, path: dest, locale: meta.locale };
}

module.exports = { exportHistory };
