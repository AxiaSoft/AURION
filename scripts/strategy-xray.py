#!/usr/bin/env python3
"""Why did the book not signal?

The report that produced this tool was: "the strategies give no signal at
some of the important places on a symbol, and the robot gets left behind".
Both halves of that are unanswerable from the outside, because a strategy
that declines says nothing at all — it returns None, and ten different
refusals look identical from the desk.

This walks a candle series bar by bar, asks every builtin strategy, and
tallies what came back. With the refusal reasons wired in (see
``Refusals`` in each strategy) it prints WHICH condition is eating the
signals, per symbol profile, so tuning is arithmetic instead of taste.

    python3 scripts/strategy-xray.py
    python3 scripts/strategy-xray.py --bars 1500 --seed 7
    python3 scripts/strategy-xray.py --symbol XAUUSD --strategy king

The series are synthetic but not random walks: each profile is built out
of trending legs with pullbacks, ranges and shocks, in the price scale
and tick size of the real instrument, because a filter expressed in
price terms behaves differently on 1.08xxx than on 2400.xx — which is
exactly how a strategy ends up silent on one symbol and busy on another.
"""

from __future__ import annotations

import argparse
import math
import random
import zlib
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.strategy.base import StrategyContext  # noqa: E402
from aurion.strategy.builtin.atr_breakout import ATRBreakout  # noqa: E402
from aurion.strategy.builtin.ema_rsi import EmaRsi  # noqa: E402
from aurion.strategy.builtin.king import King  # noqa: E402
from aurion.strategy.builtin.price_action import PriceAction  # noqa: E402

# name -> (price, tick size, daily range as a fraction of price)
PROFILES = {
    "EURUSD": (1.0850, 0.00001, 0.006),
    "XAUUSD": (2380.0, 0.01, 0.012),
    "USDJPY": (156.40, 0.001, 0.005),
    "BTCUSD": (64000.0, 0.1, 0.030),
    "US30": (39000.0, 0.1, 0.010),
}

STRATEGIES = {
    "king": King,
    "atr_breakout": ATRBreakout,
    "ema_rsi": EmaRsi,
    "price_action": PriceAction,
}


def series(profile: str, bars: int, seed: int) -> list[dict]:
    """A market with legs, pullbacks, ranges and the odd shock."""
    price, tick, daily = PROFILES[profile]
    rng = random.Random(seed + zlib.crc32(profile.encode()) % 1000)

    # Per-bar volatility from the daily range, M15 => 96 bars a day.
    step = price * daily / math.sqrt(96)

    out: list[dict] = []
    t = 0
    mode = "range"
    mode_left = 0
    drift = 0.0

    for i in range(bars):
        if mode_left <= 0:
            mode = rng.choices(
                ["trend", "pullback", "range", "shock"],
                weights=[42, 20, 35, 3],
            )[0]
            mode_left = {
                "trend": rng.randint(18, 60),
                "pullback": rng.randint(5, 16),
                "range": rng.randint(20, 70),
                "shock": rng.randint(1, 3),
            }[mode]
            if mode == "trend":
                drift = rng.choice([1.0, -1.0]) * rng.uniform(0.25, 0.75)
            elif mode == "pullback":
                drift = -drift * rng.uniform(0.3, 0.6)
            elif mode == "range":
                drift = 0.0
            else:
                drift = rng.choice([1.0, -1.0]) * rng.uniform(2.5, 5.0)
        mode_left -= 1

        shock = step * (drift + rng.gauss(0, 0.8))
        open_ = price
        close = max(tick, price + shock)
        high = max(open_, close) + abs(rng.gauss(0, step * 0.4))
        low = min(open_, close) - abs(rng.gauss(0, step * 0.4))
        price = close

        def q(v: float) -> float:
            return round(round(v / tick) * tick, 8)

        out.append({
            "time": f"2026-01-01T00:{i % 60:02d}:00",
            "open": q(open_), "high": q(high), "low": q(low), "close": q(close),
            "tick_volume": rng.randint(50, 900),
            "spread": 2,
        })
        t += 1
    return out


def context(symbol: str, candles: list[dict]) -> StrategyContext:
    last = candles[-1]
    return StrategyContext(
        symbol=symbol,
        timeframe="M15",
        candles=candles,
        tick={"bid": last["close"], "ask": last["close"], "time": last["time"]},
        account={"balance": 10000.0, "equity": 10000.0, "margin_free": 9000.0},
        positions=[],
        orders=[],
        ai={},
        params={},
        now=last["time"],
    )


def outcome(data: list[dict], start: int, side: str, entry: float, sl: float, tp: float,
            horizon: int = 200) -> tuple[float, int] | None:
    """Walk the signal forward to its stop or its target, in R.

    Counting signals proves nothing: a filter can be loosened until the
    book fires every bar. What has to be shown is that the entries added
    are worth taking, so each one is settled against the levels it was
    issued with. A bar that touches both is scored as the loss, because
    that is the assumption that cannot flatter the result.
    """
    risk = abs(entry - sl)
    if risk <= 0:
        return None
    for n, row in enumerate(data[start:start + horizon], start=1):
        hi, lo = row["high"], row["low"]
        if side == "buy":
            if lo <= sl:
                return -1.0, n
            if hi >= tp:
                return (tp - entry) / risk, n
        else:
            if hi >= sl:
                return -1.0, n
            if lo <= tp:
                return (entry - tp) / risk, n
    return None                                   # still open at the end


def walk(strategy_name: str, symbol: str, bars: int, seed: int, window: int = 300,
         overrides: dict | None = None):
    """Ask one strategy at every bar and tally what came back."""
    cls = STRATEGIES[strategy_name]
    strat = cls(dict(overrides or {}))
    data = series(symbol, bars, seed)

    signals = 0
    refusals: Counter[str] = Counter()
    sides: Counter[str] = Counter()
    results: list[float] = []
    kinds: Counter[str] = Counter()

    # One position at a time, like the account. Asking on every bar and
    # settling each answer separately counts the same move five times and
    # makes any statistic from it meaningless.
    busy_until = 0

    for i in range(window, len(data)):
        if i < busy_until:
            continue
        ctx = context(symbol, data[i - window:i])
        try:
            sig = strat.on_candle(ctx)
        except Exception as exc:                     # a fault is a finding
            refusals[f"EXCEPTION {type(exc).__name__}: {exc}"] += 1
            continue
        if sig is None:
            # Strategies that record their reason expose it here; the ones
            # that do not simply land in "unsaid", which is itself the
            # measurement that matters.
            reason = getattr(strat, "last_refusal_kind", "") \
                or getattr(strat, "last_refusal", "") or "unsaid"
            refusals[reason] += 1
        else:
            signals += 1
            sides[sig.action] += 1
            kinds[str((sig.extra or {}).get("entry_type") or "-")] += 1
            if sig.action in ("buy", "sell") and sig.sl and sig.tp:
                res = outcome(data, i, sig.action, data[i - 1]["close"], sig.sl, sig.tp)
                if res is not None:
                    r, held = res
                    results.append(r)
                    busy_until = i + held

    asked = len(data) - window
    wins = [r for r in results if r > 0]
    return {
        "asked": asked, "signals": signals, "sides": sides, "refusals": refusals,
        "settled": len(results), "kinds": kinds,
        "win_rate": (len(wins) / len(results)) if results else 0.0,
        "expectancy": (sum(results) / len(results)) if results else 0.0,
        "total_r": sum(results),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bars", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--symbol", default="")
    ap.add_argument("--strategy", default="")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--seeds", type=int, default=1, help="average over N consecutive seeds")
    ap.add_argument("--set", action="append", default=[],
                    help="override a parameter, e.g. --set min_pullback=0.35")
    ap.add_argument("--quiet", action="store_true", help="one line per strategy")
    args = ap.parse_args()

    symbols = [args.symbol] if args.symbol else list(PROFILES)
    names = [args.strategy] if args.strategy else list(STRATEGIES)

    overrides: dict = {}
    for item in args.set:
        key, _, raw = item.partition("=")
        try:
            overrides[key] = int(raw) if raw.isdigit() else float(raw)
        except ValueError:
            overrides[key] = {"true": True, "false": False}.get(raw.lower(), raw)

    seeds = [args.seed + n for n in range(max(1, args.seeds))]

    if args.quiet:
        for name in names:
            n = tot = wins = sigs = asked = 0
            for sd in seeds:
                for symbol in symbols:
                    r = walk(name, symbol, args.bars, sd, overrides=overrides)
                    n += r["settled"]; tot += r["total_r"]
                    wins += r["win_rate"] * r["settled"]
                    sigs += r["signals"]; asked += r["asked"]
            exp = tot / n if n else 0.0
            print(f"  {name:<14} {sigs:>5} signals  {n:>5} settled"
                  f"  win {(wins / n if n else 0):6.1%}  expectancy {exp:+.3f}R"
                  f"  total {tot:+8.1f}R   {overrides or ''}")
        return 0

    print()
    print("  AURION strategy x-ray")
    print("  ---------------------")
    print(f"  {args.bars} bars, seed {args.seed}, asked once per closed bar")
    print()

    for name in names:
        print(f"  {name}")
        total_asked = total_sig = 0
        merged: Counter[str] = Counter()
        settled_all: list[dict] = []
        for symbol in symbols:
            r = walk(name, symbol, args.bars, args.seed, overrides=overrides)
            total_asked += r["asked"]
            total_sig += r["signals"]
            merged.update(r["refusals"])
            rate = 100.0 * r["signals"] / max(1, r["asked"])
            shape = " ".join(f"{k}={v}" for k, v in sorted(r["sides"].items()))
            print(f"      {symbol:<8} {r['signals']:>4} signals in {r['asked']:>5} bars"
                  f"  ({rate:5.2f}%)  {shape}")
            if r["settled"]:
                print(f"               {r['settled']:>4} settled   win {r['win_rate']:5.1%}"
                      f"   expectancy {r['expectancy']:+.2f}R   total {r['total_r']:+.1f}R"
                      + ("   " + " ".join(f"{k}={v}" for k, v in sorted(r["kinds"].items()))
                         if len(r["kinds"]) > 1 else ""))
            settled_all.append(r)
        rate = 100.0 * total_sig / max(1, total_asked)
        print(f"      {'ALL':<8} {total_sig:>4} signals in {total_asked:>5} bars  ({rate:5.2f}%)")
        n = sum(r["settled"] for r in settled_all)
        if n:
            tot = sum(r["total_r"] for r in settled_all)
            w = sum(r["win_rate"] * r["settled"] for r in settled_all) / n
            print(f"               {n:>4} settled   win {w:5.1%}"
                  f"   expectancy {tot / n:+.2f}R   total {tot:+.1f}R")
        if merged:
            print("      refused because:")
            for reason, count in merged.most_common(args.top):
                share = 100.0 * count / max(1, total_asked)
                print(f"        {share:5.1f}%  {reason}")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
