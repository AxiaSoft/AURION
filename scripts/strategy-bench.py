#!/usr/bin/env python3
"""Measure the built-in strategies against real market data.

Why this exists
---------------
A strategy's docstring that claims an edge it has not been measured to
have is worse than no docstring, because the next person believes it.
This script is what turns a claim into arithmetic, and it is the only
thing allowed to put numbers into a strategy's ``MEASURED`` block.

What it does
------------
Runs each strategy over several non-overlapping windows of several
instruments, and reports expectancy in R. It deliberately does NOT
report drawdown percent: with ``point_value`` fixed at 100_000 the
percentages are meaningless, and a meaningless number on a report is a
number somebody will quote.

Data
----
Tab-separated OHLCV, one file per instrument, header::

    Time    Open    High    Low     Close   Volume

Any source will do. These runs used the M15 files from
``TheSnowGuru/Stocks-Futures-Financial-Time-series-Tick-Bar-Data``
(``forex/<pair>/<PAIR>_M15.csv``, from 2015-09-03). **The data is never
committed** -- it is ~11 MB per instrument and it is not ours.

    python3 scripts/strategy-bench.py --data /tmp/mkt \
        --pairs EURUSD GBPUSD USDJPY AUDUSD USDCAD \
        --strategies ema_rsi atr_breakout price_action smart_money \
        --windows 6 --size 3000 --out /tmp/bench.json

What the numbers are worth
--------------------------
**Costs are not modelled.** No spread, no commission, no swap, no
slippage. Every expectancy below is therefore optimistic, and by more
than it looks: at M15 a typical spread is a meaningful fraction of a
0.02R edge. Treat a small positive expectancy here as "not obviously
broken", not as "profitable".
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))


def load_bars(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        head = fh.readline().strip().split("\t")
        want = {name.lower(): i for i, name in enumerate(head)}
        need = ("time", "open", "high", "low", "close")
        if not all(k in want for k in need):
            raise SystemExit(f"{path}: header is {head!r}, expected {need}")
        for line in fh:
            p = line.rstrip("\n").split("\t")
            if len(p) < 5:
                continue
            try:
                rows.append({
                    "time": p[want["time"]],
                    "open": float(p[want["open"]]),
                    "high": float(p[want["high"]]),
                    "low": float(p[want["low"]]),
                    "close": float(p[want["close"]]),
                    "volume": float(p[want["volume"]]) if "volume" in want else 0.0,
                })
            except ValueError:
                continue
    return rows


def windows(total: int, count: int, size: int) -> list[tuple[int, int]]:
    """Non-overlapping, evenly spread across the whole history.

    Evenly spread rather than "the last N" on purpose: the last two
    years of any instrument is one regime, and a strategy tuned on one
    regime is not a strategy.
    """
    if total < size * count:
        count = max(1, total // size)
    gap = (total - size * count) // max(1, count)
    out = []
    at = 0
    for _ in range(count):
        if at + size > total:
            break
        out.append((at, at + size))
        at += size + gap
    return out


def one_run(job: tuple) -> dict:
    name, params, pair, path, start, end = job
    from aurion.backtest.engine import Backtester
    from aurion.strategy.loader import StrategyLoader

    bars = load_bars(Path(path))[start:end]
    st = StrategyLoader().load_builtin(name, params or {})
    res = Backtester().run(st, bars, pair, "M15", 10_000.0, 100_000.0, 200,
                           None, None, "auto", 0.0, 1)
    trades = res.get("trades") or []
    detail = []
    for t in trades:
        risk = float(t.get("risk") or 0.0)
        profit = float(t.get("profit") or 0.0)
        detail.append({
            "t": t.get("time"),
            "xt": t.get("exit_time"),
            "side": t.get("type"),
            "r": (profit / risk) if risk else 0.0,
            "why": t.get("exit_reason") or "",
            "entry": t.get("entry"),
            "reason": t.get("reason") or "",
        })
    return {
        "strategy": name, "pair": pair, "start": start, "end": end,
        "trades": len(trades),
        "detail": detail,
        "refusals": dict(getattr(st, "refusals", {}) or {}),
    }


def summarize(rows: list[dict]) -> dict:
    rs = [d["r"] for row in rows for d in row["detail"]]
    n = len(rs)
    if not n:
        return {"trades": 0, "win": 0.0, "pf": 0.0, "avg_r": 0.0, "tot_r": 0.0,
                "windows": len(rows), "good_windows": 0}
    wins = [r for r in rs if r > 0]
    losses = [-r for r in rs if r < 0]
    gross_w, gross_l = sum(wins), sum(losses)
    good = sum(1 for row in rows if sum(d["r"] for d in row["detail"]) > 0)
    return {
        "trades": n,
        "win": len(wins) / n,
        "pf": (gross_w / gross_l) if gross_l else math.inf,
        "avg_r": sum(rs) / n,
        "tot_r": sum(rs),
        "windows": len(rows),
        "good_windows": good,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--pairs", nargs="+", required=True)
    ap.add_argument("--strategies", nargs="+", required=True)
    ap.add_argument("--params", default="{}",
                    help='JSON: {"smart_money": {"min_rr": 1.5}}')
    ap.add_argument("--windows", type=int, default=6)
    ap.add_argument("--size", type=int, default=3000)
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--label", default="")
    a = ap.parse_args()

    overrides = json.loads(a.params)
    jobs = []
    for pair in a.pairs:
        path = a.data / f"{pair}_M15.csv"
        if not path.exists():
            raise SystemExit(f"missing {path}")
        total = sum(1 for _ in path.open("r", encoding="utf-8", errors="replace")) - 1
        for start, end in windows(total, a.windows, a.size):
            for name in a.strategies:
                jobs.append((name, overrides.get(name, {}), pair, str(path), start, end))

    print(f"{len(jobs)} runs ({len(a.strategies)} strategies x {len(a.pairs)} pairs "
          f"x {a.windows} windows of {a.size} bars)", flush=True)

    results: list[dict] = []
    with ProcessPoolExecutor(max_workers=a.workers or None) as pool:
        for i, res in enumerate(pool.map(one_run, jobs), 1):
            results.append(res)
            if i % 10 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)}", flush=True)

    print()
    hdr = f"{'strategy':<16}{'trades':>8}{'win%':>8}{'PF':>7}{'avgR':>9}{'totR':>10}{'good':>8}"
    print(hdr)
    print("-" * len(hdr))
    table = {}
    for name in a.strategies:
        s = summarize([r for r in results if r["strategy"] == name])
        table[name] = s
        print(f"{name:<16}{s['trades']:>8}{s['win'] * 100:>7.1f}%{s['pf']:>7.2f}"
              f"{s['avg_r']:>+9.3f}{s['tot_r']:>+10.1f}"
              f"{s['good_windows']:>5}/{s['windows']}")
    allr = summarize(results)
    table["ALL"] = allr
    print("-" * len(hdr))
    print(f"{'ALL':<16}{allr['trades']:>8}{allr['win'] * 100:>7.1f}%{allr['pf']:>7.2f}"
          f"{allr['avg_r']:>+9.3f}{allr['tot_r']:>+10.1f}"
          f"{allr['good_windows']:>5}/{allr['windows']}")
    print("\ncosts are not modelled: no spread, commission, swap or slippage")

    if a.out:
        a.out.write_text(json.dumps(
            {"label": a.label, "pairs": a.pairs, "strategies": a.strategies,
             "windows": a.windows, "size": a.size, "params": overrides,
             "summary": table, "runs": results}, indent=1))
        print(f"wrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
