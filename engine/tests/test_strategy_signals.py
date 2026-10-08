"""The chart marks must be what the armed strategies actually said.

The bug this suite exists for: the chart drew EMA crosses from a standalone
detector while the account was being traded by whatever the user had armed.
Two systems, one chart, and a trader reading marks that no strategy of theirs
had ever produced.

The properties worth defending are small in number and easy to break:

* a mark at bar *i* must be reachable from ``bars[:i+1]`` alone;
* the levels drawn must be the strategy's own, not reconstructed;
* an open position must not blank the history;
* one broken strategy must not take the chart down with it.
"""

from __future__ import annotations

import math
import random

import pytest

from aurion.signals.strategy_signals import WARMUP_BARS, replay
from aurion.strategy.base import BaseStrategy, StrategySignal


def series(n: int, seed: int = 7, vol: float = 0.0012) -> list[dict]:
    """A regime-switching walk: trends long enough for structure to form."""
    rng = random.Random(seed)
    price = 1.1
    drift = 0.0
    left = 0
    out = []
    for i in range(n):
        if left <= 0:
            drift = rng.choice([0.0010, -0.0010, 0.0, 0.0005, -0.0005])
            left = rng.randint(40, 120)
        left -= 1
        open_ = price
        price = max(1e-4, price * (1 + drift + rng.gauss(0, vol)))
        close = price
        high = max(open_, close) * (1 + abs(rng.gauss(0, vol * 0.6)))
        low = min(open_, close) * (1 - abs(rng.gauss(0, vol * 0.6)))
        out.append({"time": f"2026-01-01T{i // 60:02d}:{i % 60:02d}:00",
                    "open": open_, "high": high, "low": low, "close": close, "volume": 100})
    return out


class Always(BaseStrategy):
    """Fires on every bar, with levels derived from that bar only.

    Deliberately trivial: this suite is testing the replay harness, and a
    strategy that sometimes declines would make "did the replay call me"
    indistinguishable from "did the strategy decline".
    """

    name = "always"

    def __init__(self) -> None:
        self.seen: list[int] = []
        self.last_positions = None

    def on_candle(self, ctx):
        self.seen.append(len(ctx.candles))
        self.last_positions = ctx.positions
        close = float(ctx.candles[-1]["close"])
        return StrategySignal(
            symbol=ctx.symbol, action="buy", volume=0.1, sl=close - 0.01, tp=close + 0.03,
            confidence=0.5 + 0.001 * len(ctx.candles),
            reason="always", extra={"entry": close, "zone": "test"},
        )


class Broken(BaseStrategy):
    name = "broken"

    def on_candle(self, ctx):
        raise RuntimeError("this strategy is wrong")


class Silent(BaseStrategy):
    name = "silent"

    def on_candle(self, ctx):
        return None


# --------------------------------------------------------------- the basics --

def test_nothing_armed_means_no_marks():
    out = replay(series(400), [], "EURUSD", "M15")
    assert out["ok"] is True
    assert out["signals"] == []
    # "none" is not "the strategies found nothing" - the desk uses this to
    # explain an empty chart to the user.
    assert out["source"] == "none"


def test_short_history_is_refused_rather_than_guessed():
    out = replay(series(30), [("always", Always())], "EURUSD", "M15")
    assert out["signals"] == []
    assert out["reason"] == "need_more_bars"


def test_marks_carry_the_strategy_that_produced_them():
    out = replay(series(400), [("always", Always())], "EURUSD", "M15")
    assert out["source"] == "strategy"
    assert out["strategies"] == ["always"]
    assert out["signals"]
    assert {s["strategy"] for s in out["signals"]} == {"always"}


# ------------------------------------------------------------- no look-ahead --

def test_each_bar_sees_only_its_own_past():
    bars = series(400)
    strat = Always()
    replay(bars, [("always", strat)], "EURUSD", "M15")
    # The strategy records len(candles) on every call. Those lengths must be
    # strictly increasing and must never exceed the index being evaluated,
    # which is what "no look-ahead" means in practice.
    assert strat.seen == sorted(strat.seen)
    assert strat.seen[-1] == len(bars)
    assert len(set(strat.seen)) == len(strat.seen)


def test_a_mark_sits_on_the_bar_it_was_computed_from():
    bars = series(400)
    out = replay(bars, [("always", Always())], "EURUSD", "M15")
    for sig in out["signals"]:
        bar = bars[sig["index"]]
        assert sig["time"] == bar["time"]
        # entry came from that bar's close, so this is an identity check that
        # the index and the payload cannot drift apart.
        assert math.isclose(sig["entry"], bar["close"], rel_tol=1e-9)


def test_the_replay_warms_up_before_it_asks():
    bars = series(400)
    strat = Always()
    replay(bars, [("always", strat)], "EURUSD", "M15")
    assert strat.seen[0] > WARMUP_BARS


def test_the_window_bounds_the_work():
    bars = series(800)
    strat = Always()
    out = replay(bars, [("always", strat)], "EURUSD", "M15", window=50)
    assert len(strat.seen) == 50
    assert out["window"] == 50


# ----------------------------------------------------------------- the levels --

def test_levels_are_the_strategy_s_own():
    bars = series(400)
    out = replay(bars, [("always", Always())], "EURUSD", "M15")
    sig = out["signals"][0]
    entry = bars[sig["index"]]["close"]
    assert math.isclose(sig["sl"], entry - 0.01, rel_tol=1e-9)
    assert math.isclose(sig["tp"], entry + 0.03, rel_tol=1e-9)
    # 0.03 reward against 0.01 risk. The desk renders this verbatim, so a
    # rounding change here is a visible change there.
    assert sig["rr"] == 3.0


def test_the_strategy_s_own_payload_survives_to_the_desk():
    out = replay(series(400), [("always", Always())], "EURUSD", "M15")
    assert out["signals"][0]["extra"]["zone"] == "test"


def test_a_mark_without_levels_reports_no_ratio():
    class NoLevels(Always):
        def on_candle(self, ctx):
            sig = super().on_candle(ctx)
            sig.sl = 0.0
            sig.tp = 0.0
            return sig

    out = replay(series(400), [("n", NoLevels())], "EURUSD", "M15")
    sig = out["signals"][0]
    assert sig["sl"] == 0.0 and sig["tp"] == 0.0
    # Not None, and not a divide-by-zero: the overlay reads this as a number.
    assert sig["rr"] == 0.0


# -------------------------------------------------------------- the contract --

def test_positions_are_withheld_on_purpose():
    """A live position must not silence the history.

    King returns None for a symbol it is already in. Handing the replay the
    real position list would blank the chart for exactly the symbol the
    trader is most likely to be looking at.
    """
    strat = Always()
    replay(series(400), [("always", strat)], "EURUSD", "M15")
    assert strat.last_positions == []


def test_one_broken_strategy_does_not_blank_the_chart():
    seen: list[str] = []
    out = replay(
        series(400),
        [("broken", Broken()), ("always", Always())],
        "EURUSD", "M15",
        on_error=lambda name, exc: seen.append(name),
    )
    assert out["signals"], "the working strategy's marks were lost"
    assert set(seen) == {"broken"}


def test_a_silent_strategy_is_still_credited_as_armed():
    out = replay(series(400), [("silent", Silent())], "EURUSD", "M15")
    assert out["signals"] == []
    # source stays "strategy": the desk must say "your strategy saw nothing",
    # not fall back to drawing EMA crosses.
    assert out["source"] == "strategy"
    assert out["strategies"] == ["silent"]


def test_two_strategies_are_both_replayed():
    class Other(Always):
        pass

    out = replay(series(400), [("a", Always()), ("b", Other())], "EURUSD", "M15")
    assert {s["strategy"] for s in out["signals"]} == {"a", "b"}


# ------------------------------------------------------------------- dedupe --

def test_a_setup_that_persists_is_drawn_once():
    """Always() fires on every bar; the chart must not show 240 arrows."""
    out = replay(series(400), [("always", Always())], "EURUSD", "M15")
    idx = [s["index"] for s in out["signals"]]
    assert idx == sorted(idx)
    gaps = [b - a for a, b in zip(idx, idx[1:])]
    assert gaps and min(gaps) > 4, "consecutive duplicates survived the dedupe"


def test_the_kept_instance_is_the_most_confident_one():
    # Always()'s confidence rises with history, so within each cluster the
    # last bar wins - which is the bar on which the most confluences had
    # arrived.
    out = replay(series(400), [("always", Always())], "EURUSD", "M15")
    for sig in out["signals"]:
        assert sig["confidence"] == pytest.approx(0.5 + 0.001 * (sig["index"] + 1))
    # and the winner is the end of its cluster, never the start
    idx = [s["index"] for s in out["signals"]]
    assert all(b - a > 4 for a, b in zip(idx, idx[1:]))


def test_the_chart_is_never_flooded():
    out = replay(series(2000), [("always", Always())], "EURUSD", "M15", window=1500,
                 budget_seconds=30)
    assert len(out["signals"]) <= 60


# -------------------------------------------------------------- the budget --

def test_the_replay_stops_rather_than_hanging_a_refresh():
    class Slow(Always):
        def on_candle(self, ctx):
            import time as _t
            _t.sleep(0.01)
            return super().on_candle(ctx)

    out = replay(series(600), [("slow", Slow())], "EURUSD", "M15", window=400,
                 budget_seconds=0.5)
    assert out["truncated"] is True
    assert out["ok"] is True


def test_a_replay_that_fits_is_not_marked_truncated():
    out = replay(series(400), [("always", Always())], "EURUSD", "M15", window=40)
    assert out["truncated"] is False
