/**
 * History is the record of what finished.
 *
 * Reported: rows in the history table with no numbers in them. They
 * were real - they were the ENTRY half of a position that is still
 * open. The engine answered /v1/history with closed_only=False, so a
 * position appeared in history the moment it was opened, and the row
 * that arrived had no close time, no close price, no profit, no swap,
 * no commission and no net: nine of the seventeen columns blank.
 *
 * That row cannot be told apart from a broken one, it has no
 * counterpart in the broker's statement, and it sorts in among the
 * finished trades as if it were one - so every reconciliation starts
 * by identifying and skipping it. The open position is already on the
 * desk, in the positions dock, with a live P/L no history row could
 * have.
 *
 * One rule, "did this trade finish", implemented at three layers on
 * purpose: the engine (authoritative), the desk's historyRows() and
 * the backend's isFinishedTrade() for the Excel export. The two
 * downstream gates exist for a desk or a backend talking to an engine
 * that has not been updated yet, and they must agree with each other
 * exactly, or the spreadsheet and the screen will contain different
 * trades.
 *
 *     node tests/finished-trades.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let fails = 0;
const check = (name, fn) => {
  try {
    const note = fn();
    console.log("ok   " + name + (note ? "  (" + note + ")" : ""));
  } catch (e) {
    fails++;
    console.log("FAIL " + name + "\n       " + (e && e.message ? e.message : e));
  }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appJs = read("apps/web/js/app.js");

/* historyRows lifted out of app.js and run alone. Sliced by indexOf
   bounds, never by a line count. */
function deskFilter() {
  const start = appJs.indexOf("function historyRows(rows)");
  if (start === -1) throw new Error("historyRows is gone from app.js");
  const end = appJs.indexOf("\nfunction historyRowView", start);
  if (end === -1) throw new Error("cannot find the end of historyRows");
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(appJs.slice(start, end) + "\n;globalThis.__f = historyRows;", ctx);
  return ctx.__f;
}

const historyRows = deskFilter();
const { isFinishedTrade } = require(path.join(ROOT, "backend/src/excel.js"));

const ENTRY = { ticket: 11, symbol: "EURUSD", kind: "in", volume: 0.1, price: 1.1 };
const CLOSED = { ticket: 12, symbol: "EURUSD", kind: "out", volume: 0.1, price: 1.2, profit: 9.5 };
const LEGACY_CLOSED = { ticket: 13, symbol: "XAUUSD", volume: 0.1, profit: -4 };
const LEGACY_OPEN = { ticket: 14, symbol: "XAUUSD", volume: 0.1, profit: 0 };
const SCRATCH = { ticket: 15, symbol: "GBPUSD", kind: "out", volume: 0.1, profit: 0, swap: 0, commission: 0 };

// ── the desk table ────────────────────────────────────────────────────
check("the entry half of an open position is not a history row", () => {
  const out = historyRows([ENTRY, CLOSED]);
  if (out.length !== 1 || out[0].ticket !== 12) {
    throw new Error("got tickets " + out.map((r) => r.ticket).join(","));
  }
});

check("an 'entry' kind is dropped as well as an 'in' kind", () => {
  if (historyRows([{ ticket: 1, kind: "entry", profit: 0 }]).length !== 0) {
    throw new Error("an entry row survived");
  }
});

check("out, inout and close all count as finished", () => {
  const rows = ["out", "inout", "close"].map((kind, i) => ({ ticket: i, kind }));
  if (historyRows(rows).length !== 3) throw new Error("a finished trade was dropped");
});

check("a closed trade that netted exactly zero is still a trade", () => {
  // The kind says it closed. A scratch is a real outcome and belongs
  // in the record, so the money test must not be reached for it.
  if (historyRows([SCRATCH]).length !== 1) throw new Error("a break-even close vanished");
});

check("a legacy row with no kind is judged by whether it moved money", () => {
  const out = historyRows([LEGACY_CLOSED, LEGACY_OPEN]);
  if (out.length !== 1 || out[0].ticket !== 13) {
    throw new Error("got tickets " + out.map((r) => r.ticket).join(","));
  }
});

check("swap or commission alone is enough to call a legacy row finished", () => {
  const swapOnly = { ticket: 20, swap: -0.3 };
  const commOnly = { ticket: 21, commission: -7 };
  if (historyRows([swapOnly, commOnly]).length !== 2) {
    throw new Error("a row that moved money was dropped");
  }
});

check("a non-array is answered with an empty list, not a crash", () => {
  if (historyRows(undefined).length !== 0) throw new Error("undefined was not handled");
  if (historyRows(null).length !== 0) throw new Error("null was not handled");
});

// ── the Excel export ──────────────────────────────────────────────────
check("the backend exports the same rule by name", () => {
  if (typeof isFinishedTrade !== "function") throw new Error("excel.js does not export isFinishedTrade");
});

check("the export and the table agree on every sample row", () => {
  const sample = [ENTRY, CLOSED, LEGACY_CLOSED, LEGACY_OPEN, SCRATCH,
    { ticket: 30, kind: "in", profit: 5 }, { ticket: 31, swap: -2 }, { ticket: 32 }];
  const table = new Set(historyRows(sample).map((r) => r.ticket));
  const sheet = new Set(sample.filter(isFinishedTrade).map((r) => r.ticket));
  const differ = sample.map((r) => r.ticket).filter((t) => table.has(t) !== sheet.has(t));
  if (differ.length) {
    throw new Error("the table and the spreadsheet disagree about tickets " + differ.join(","));
  }
  return sheet.size + " of " + sample.length + " rows exported";
});

check("the export actually applies the filter", () => {
  const src = read("backend/src/excel.js");
  if (!/\.filter\(isFinishedTrade\)/.test(src)) {
    throw new Error("isFinishedTrade is defined but nothing calls it on the trade list");
  }
});

check("a bare value is not a trade", () => {
  for (const bad of [null, undefined, 0, "", "out"]) {
    if (isFinishedTrade(bad)) throw new Error("accepted " + JSON.stringify(bad));
  }
});

// ── the engine, which is the gate that matters ────────────────────────
check("/v1/history asks the store for closed trades only", () => {
  const src = read("engine/aurion/api/server.py");
  const at = src.indexOf('@app.get("/v1/history")');
  if (at === -1) throw new Error("the /v1/history route is gone");
  let body = src.slice(at, at + 3000);
  /* Strip the docstring first. It explains the old behaviour and names
     closed_only=False to do it, and a grep that reads the prose finds
     the bug it was warned about. */
  body = body.replace(/"""[\s\S]*?"""/g, "");
  if (!/closed_only=True/.test(body)) {
    throw new Error("the route no longer asks for closed trades only");
  }
  if (/closed_only=False/.test(body)) {
    throw new Error("the route is back to publishing open positions as history");
  }
});

check("the store still defaults to closed trades only", () => {
  const src = read("engine/aurion/runtime/store.py");
  if (!/def history\(self, limit: int = \d+, closed_only: bool = True\)/.test(src)) {
    throw new Error("Store.history no longer defaults to closed_only=True");
  }
});

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exitCode = fails ? 1 : 0;
