"""A strategy that declines has to say why.

A bare ``return None`` is the reason the desk could only ever report "no
setup on this bar", and that sentence is indistinguishable from a broken
strategy, a misconfigured symbol and a quiet market. Every exit that
refuses an entry now names the rule that refused it, so the desk, the
journal and scripts/strategy-xray.py can all count them.

These tests do not care *which* reason comes back. They care that one
always does, and that the tally buckets by rule rather than by the
number inside the sentence.
"""

from __future__ import annotations

import random

import pandas as pd

from aurion.strategy.base import BaseStrategy, StrategyContext
from aurion.strategy.builtin.atr_breakout import ATRBreakout
from aurion.strategy.builtin.ema_rsi import EmaRsi
from aurion.strategy.builtin.price_action import PriceAction

STRATEGIES = [EmaRsi, PriceAction, ATRBreakout]


def _candles(bars: int = 420, seed: int = 7) -> list[dict]:
    """A plain random walk — enough shape for every gate to get a turn."""
    rng = random.Random(seed)
    price = 1.1000
    out: list[dict] = []
    for i in range(bars):
        drift = 0.00004 * (1 if (i // 60) % 2 == 0 else -1)
        price = max(0.5, price + drift + rng.gauss(0, 0.0006))
        high = price + abs(rng.gauss(0, 0.0004))
        low = price - abs(rng.gauss(0, 0.0004))
        out.append(
            {
                "time": 1_700_000_000 + i * 900,
                "open": price,
                "high": high,
                "low": low,
                "close": price,
                "tick_volume": 100 + rng.randint(0, 50),
            }
        )
    return out


def _ctx(rows: list[dict]) -> StrategyContext:
    return StrategyContext(
        symbol="TEST",
        timeframe="M15",
        candles=rows,
        tick={"bid": rows[-1]["close"], "ask": rows[-1]["close"]},
        account={"balance": 10_000, "equity": 10_000},
        positions=[],
        orders=[],
        ai={},
        params={},
        now=pd.Timestamp.utcnow(),
    )


def test_every_builtin_names_its_refusal() -> None:
    rows = _candles()
    for cls in STRATEGIES:
        strat = cls({})
        said = 0
        silent = 0
        for end in range(300, len(rows)):
            signal = strat.on_candle(_ctx(rows[: end + 1]))
            if signal is not None:
                continue
            if strat.last_refusal:
                said += 1
            else:
                silent += 1
        assert said, f"{cls.__name__} never refused anything — the walk is too short"
        assert not silent, f"{cls.__name__} returned a nameless None {silent} times"


def test_the_tally_buckets_by_rule_not_by_number() -> None:
    """One rule firing at twenty price levels is one row, not twenty."""

    class Probe(BaseStrategy):
        name = "probe"

    probe = Probe({})
    for i in range(20):
        probe.decline("price is premium for a buy", f"{0.90 + i / 100:.2f}")
    report = probe.refusal_report()
    assert report == [("price is premium for a buy", 20)], report
    assert probe.last_refusal.endswith("(1.09)"), probe.last_refusal


def test_a_reason_with_the_number_inside_it_still_buckets() -> None:
    """Shared helpers return sentences like "RSI 80 is exhausted"."""

    class Probe(BaseStrategy):
        name = "probe"

    probe = Probe({})
    probe.decline("RSI 80 is exhausted")
    probe.decline("RSI 84 is exhausted")
    assert probe.refusal_report() == [("RSI # is exhausted", 2)], probe.refusal_report()


def test_accepting_clears_the_last_refusal() -> None:
    class Probe(BaseStrategy):
        name = "probe"

    probe = Probe({})
    probe.decline("not enough history", "40 bars")
    assert probe.last_refusal
    probe.accepted()
    assert probe.last_refusal == ""
    assert probe.last_refusal_kind == ""
