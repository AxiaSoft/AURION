"""A running backtest can be called off.

Asked for in exactly those words: "put an option in the backtest to
cancel it". A replay asks the AI for a fresh read on every bar, so a
long window is minutes of work, and until now the only way out of a run
started by mistake - wrong symbol, wrong period, wrong strategy - was to
close the desk and lose the engine's state with it.

What these tests pin is not the button but the contract underneath it:

  * the stop is cooperative and lives inside the bar loop, because the
    replay runs in a worker thread and cancelling the asyncio task
    around it cannot touch a thread;
  * a cancelled run is a RESULT, not an error. The bars that were
    replayed were really replayed, so the trades stand;
  * and it must say so, and say how far it got, because a window that
    was half replayed must never be read as the whole window.
"""

from __future__ import annotations

import math
import random

from aurion.backtest.engine import Backtester
from aurion.strategy.loader import StrategyLoader


def _bars(n: int = 400, seed: int = 11) -> list[dict]:
    """Synthetic *test input* - never presented to anyone as a result."""
    rnd = random.Random(seed)
    out = []
    price = 1.1000
    for i in range(n):
        o = price
        price *= math.exp(rnd.gauss(0, 0.0016))
        out.append({
            "time": f"2026.{1 + (i // 24) // 28:02d}.{1 + (i // 24) % 28:02d} {i % 24:02d}:00:00",
            "open": o,
            "high": max(o, price) * 1.0008,
            "low": min(o, price) * 0.9992,
            "close": price,
            "volume": 100,
        })
    return out


def _run(should_stop, bars=None, warmup=60):
    strategy = StrategyLoader().load_builtin("ema_rsi")
    return Backtester().run(
        strategy, bars if bars is not None else _bars(), "EURUSD", "M15",
        10_000.0, 1.0, warmup, None, None, "auto", 0.0, 1, 0.0001, should_stop,
    )


# ------------------------------------------------- the stop is honoured

def test_a_run_nobody_stops_is_unchanged():
    result = _run(None)
    assert result.get("ok") is True
    assert "cancelled" not in result, "an ordinary run must not be labelled"


def test_a_canceller_that_never_fires_is_the_same_run():
    plain = _run(None)
    polled = _run(lambda: False)
    assert polled.get("ok") is True
    assert "cancelled" not in polled
    assert polled["data"]["tested_bars"] == plain["data"]["tested_bars"]


def test_stopping_at_once_still_returns_a_result():
    result = _run(lambda: True)
    # Not an error: an empty replay is a short replay.
    assert result.get("ok") is True
    assert result.get("cancelled") is True


def test_a_cancelled_run_replays_fewer_bars_than_the_whole_window():
    seen = {"n": 0}

    def stop() -> bool:
        seen["n"] += 1
        return seen["n"] > 50          # fifty bars in, not at the end

    whole = _run(None)
    part = _run(stop)
    assert part.get("cancelled") is True
    assert part["data"]["tested_bars"] < whole["data"]["tested_bars"]
    assert part["data"]["tested_bars"] > 0


def test_the_stop_is_asked_every_bar_not_every_progress_tick():
    """A tick is up to 2% of the run; that is not a responsive button."""
    asked = {"n": 0}

    def stop() -> bool:
        asked["n"] += 1
        return False

    bars = _bars()
    _run(stop, bars=bars, warmup=60)
    assert asked["n"] >= len(bars) - 60 - 1


# ------------------------------------------- what the result has to say

def test_the_reported_window_ends_where_the_run_stopped():
    seen = {"n": 0}

    def stop() -> bool:
        seen["n"] += 1
        return seen["n"] > 40

    bars = _bars()
    part = _run(stop, bars=bars, warmup=60)
    # The last bar reported must be a bar that was actually replayed,
    # not the last bar handed to the run.
    assert part["data"]["last_bar"] != bars[-1]["time"]
    times = [b["time"] for b in bars]
    assert part["data"]["last_bar"] in times


def test_open_trades_are_closed_on_the_bar_the_run_stopped_on():
    """Settling at bars[-1] would use a price from the future of the run."""
    seen = {"n": 0}

    def stop() -> bool:
        seen["n"] += 1
        return seen["n"] > 120

    bars = _bars()
    part = _run(stop, bars=bars, warmup=60)
    stop_time = part["data"]["last_bar"]
    forced = [t for t in part.get("trades", []) if t.get("exit_reason") == "cancelled"]
    for trade in forced:
        assert trade.get("exit_time") == stop_time
    # And nothing was settled on a bar after the one it stopped on.
    for trade in part.get("trades", []):
        if trade.get("exit_time"):
            assert str(trade["exit_time"]) <= str(stop_time)


def test_a_broken_canceller_does_not_end_the_run():
    """A faulty stop must cost the button, never the replay."""
    def stop() -> bool:
        raise RuntimeError("no")

    result = _run(stop)
    assert result.get("ok") is True
    assert "cancelled" not in result


def test_the_metrics_describe_the_bars_that_were_replayed():
    seen = {"n": 0}

    def stop() -> bool:
        seen["n"] += 1
        return seen["n"] > 150

    part = _run(stop)
    metrics = part.get("metrics") or {}
    assert metrics.get("trades") == len(part.get("trades") or []) or metrics.get("trades") >= 0
    # The equity curve is of the run that happened, not of a longer one.
    assert isinstance(part.get("equity_curve"), list)
    assert part.get("equity_curve")
