"""Tests for the danger guard (fast protective exit)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.danger import (  # noqa: E402
    atr,
    clamp_sensitivity,
    score_position,
    threshold_for,
)


def _bars(close: float = 1.1000, n: int = 20, drift: float = 0.0) -> list[dict]:
    out = []
    px = close
    for i in range(n):
        o = px
        c = px + drift
        out.append({"open": o, "high": max(o, c) + 0.0005, "low": min(o, c) - 0.0005, "close": c})
        px = c
    return out


def test_threshold_mapping() -> None:
    assert threshold_for(50) == 50.0
    assert threshold_for(90) < threshold_for(50) < threshold_for(10)
    assert 5.0 <= threshold_for(100) <= 95.0
    assert 5.0 <= threshold_for(1) <= 95.0
    assert clamp_sensitivity("abc") == 50
    assert clamp_sensitivity(999) == 100
    assert clamp_sensitivity(-5) == 1


def test_atr_needs_enough_bars() -> None:
    assert atr([]) == 0.0
    assert atr(_bars(n=5)) == 0.0
    assert atr(_bars()) > 0.0


def test_safe_trade_scores_zero() -> None:
    pos = {"type": "buy", "price_open": 1.1000, "price_current": 1.1050, "profit": 25.0, "sl": 1.0950}
    verdict = score_position(pos, candles=_bars(), ai={"ready": True, "direction": "bull", "confidence": 0.8}, balance=10000)
    assert verdict["score"] < threshold_for(50)


def test_big_adverse_move_trips_default_sensitivity() -> None:
    # ~2x ATR against a buy, AI flipped bearish, floating loss.
    pos = {"type": "buy", "price_open": 1.1000, "price_current": 1.0980, "profit": -120.0, "sl": 1.0950}
    verdict = score_position(
        pos,
        candles=_bars(drift=-0.0002),
        ai={"ready": True, "direction": "bear", "confidence": 0.8},
        balance=10000,
    )
    assert verdict["score"] >= threshold_for(50)
    assert verdict["reasons"]


def test_low_sensitivity_ignores_small_warning() -> None:
    pos = {"type": "buy", "price_open": 1.1000, "price_current": 1.0997, "profit": -8.0, "sl": 0}
    verdict = score_position(pos, candles=_bars(), ai={"ready": False}, balance=10000)
    assert verdict["score"] < threshold_for(10)


def test_sell_side_symmetry() -> None:
    buy = {"type": "buy", "price_open": 1.1000, "price_current": 1.0985, "profit": -50.0, "sl": 0}
    sell = {"type": "sell", "price_open": 1.1000, "price_current": 1.1015, "profit": -50.0, "sl": 0}
    bars = _bars()
    ai_bear = {"ready": True, "direction": "bear", "confidence": 0.7}
    ai_bull = {"ready": True, "direction": "bull", "confidence": 0.7}
    vb = score_position(buy, candles=bars, ai=ai_bear, balance=10000)
    vs = score_position(sell, candles=bars, ai=ai_bull, balance=10000)
    assert vb["score"] > 0 and vs["score"] > 0
    assert abs(vb["parts"]["ai"] - vs["parts"]["ai"]) < 0.01


def test_missing_inputs_never_crash_or_guess() -> None:
    verdict = score_position({}, candles=None, ai=None, balance=0)
    assert verdict["score"] == 0.0
    verdict = score_position({"type": "buy"}, candles=[], ai={}, balance=0)
    assert verdict["score"] == 0.0
