"""The built-in strategies still fire — and only with a sane ticket."""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.strategy.base import StrategyContext  # noqa: E402
from aurion.strategy.builtin._confluence import (  # noqa: E402
    entry_allowed,
    macd_bias,
    not_exhausted,
    risk_levels,
    trend_bias,
)
from aurion.strategy.builtin.atr_breakout import ATRBreakout  # noqa: E402
from aurion.strategy.builtin.ema_rsi import EmaRsi  # noqa: E402
from aurion.strategy.builtin.price_action import PriceAction  # noqa: E402
from aurion.strategy.builtin.king import King  # noqa: E402
from aurion.ai.features import candles_to_frame  # noqa: E402


def _market(seed: int = 7, bars: int = 600) -> list[dict]:
    rnd = random.Random(seed)
    rows: list[dict] = []
    price = 100.0
    for i in range(bars):
        drift = 0.0006 if (i // 100) % 2 == 0 else -0.0006
        price *= 1 + drift + rnd.gauss(0, 0.0022)
        high = price * (1 + abs(rnd.gauss(0, 0.0012)))
        low = price * (1 - abs(rnd.gauss(0, 0.0012)))
        open_ = low + (high - low) * rnd.random()
        rows.append(
            {
                "time": f"t{i}",
                "open": open_,
                "high": max(high, open_, price),
                "low": min(low, open_, price),
                "close": price,
                "volume": 100,
            }
        )
    return rows


def _ctx(candles: list[dict]) -> StrategyContext:
    return StrategyContext("EURUSD", "M15", candles, None, {}, [], [], {}, {}, "now")


def test_every_builtin_still_takes_trades() -> None:
    rows = _market()
    for cls in (EmaRsi, ATRBreakout, King, PriceAction):
        strategy = cls()
        entries = []
        for k in range(120, len(rows)):
            signal = strategy.on_candle(_ctx(rows[:k]))
            if signal and signal.action in {"buy", "sell"}:
                entries.append(signal)
        assert entries, f"{cls.__name__} never fired on 480 bars"
        for signal in entries:
            assert signal.sl and signal.tp, f"{cls.__name__} sent a naked ticket"
            price = float(rows[: len(rows)][-1]["close"])
            risk = abs(signal.tp - signal.sl)
            assert risk > 0 and price > 0
            assert 0.0 <= signal.confidence <= 1.0


def test_risk_levels_respect_the_minimum_reward_to_risk() -> None:
    sl, tp = risk_levels("buy", 100.0, 1.0, 1.0, 1.0, min_rr=2.0)
    assert round((tp - 100.0) / (100.0 - sl), 2) >= 2.0
    sl, tp = risk_levels("sell", 100.0, 1.0, 1.0, 1.0, min_rr=1.5)
    assert round((100.0 - tp) / (sl - 100.0), 2) >= 1.5


def test_no_levels_without_volatility() -> None:
    assert risk_levels("buy", 100.0, 0.0, 1.0, 2.0) == (0.0, 0.0)


def test_exhaustion_blocks_chasing() -> None:
    assert not_exhausted("buy", 60.0) is True
    assert not_exhausted("buy", 88.0) is False
    assert not_exhausted("sell", 12.0) is False


def test_trend_and_momentum_agree_on_a_clean_trend() -> None:
    rows = []
    price = 100.0
    for i in range(300):
        price *= 1.0012
        rows.append({"time": f"t{i}", "open": price * 0.999, "high": price * 1.001, "low": price * 0.998, "close": price, "volume": 10})
    frame = candles_to_frame(rows)
    assert trend_bias(frame)[0] == "bull"
    assert macd_bias(frame) == "bull"
    ok, _ = entry_allowed(frame, "sell", {"with_trend": True, "require_momentum": True}, {})
    assert ok is False
