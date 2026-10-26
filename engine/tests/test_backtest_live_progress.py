"""The backtest reports what it is finding, not just how far along it is.

The desk could only show a spinner and a percentage during a replay,
because a percentage was all that crossed the bus. The progress callback
now carries a snapshot of the run so the desk can draw it live.

These tests pin the snapshot's shape and - more importantly - that it is
measured off the run in progress rather than filled in, and that an older
two-argument reporter still works.
"""

from __future__ import annotations

import math
import random

import pytest

from aurion.backtest.engine import Backtester, _thin
from aurion.strategy.loader import StrategyLoader


def _bars(n: int = 500, seed: int = 4) -> list[dict]:
    """Synthetic *test input* - never presented as a result."""
    rnd = random.Random(seed)
    out = []
    price = 1.1000
    for i in range(n):
        o = price
        price *= math.exp(rnd.gauss(0, 0.0016))
        out.append({
            # One bar an hour, so the timestamps genuinely increase.
            "time": f"2026.{1 + (i // 24) // 28:02d}.{1 + (i // 24) % 28:02d} {i % 24:02d}:00:00",
            "open": o,
            "high": max(o, price) * 1.0008,
            "low": min(o, price) * 0.9992,
            "close": price,
            "volume": 100,
        })
    return out


# --------------------------------------------------------------- _thin

def test_thin_keeps_both_ends():
    series = list(range(1000))
    out = _thin(series, 240)
    assert len(out) == 240
    assert out[0] == 0.0
    assert out[-1] == 999.0          # the last point is the one being read


def test_thin_leaves_a_short_series_alone():
    assert _thin([1.0, 2.0, 3.0], 240) == [1.0, 2.0, 3.0]


def test_thin_is_monotonic_for_a_monotonic_series():
    out = _thin(list(range(777)), 120)
    assert out == sorted(out)


# ------------------------------------------------------- the snapshot

@pytest.fixture(scope="module")
def run_snapshots():
    seen: list[tuple[int, int, dict | None]] = []

    def report(done, total, live=None):
        seen.append((done, total, live))

    strategy = StrategyLoader().load_builtin("ema_rsi")
    result = Backtester().run(
        strategy, _bars(), "EURUSD", "M15", 10_000.0, 1.0, 80, None, report
    )
    return result, seen


def test_the_run_still_succeeds(run_snapshots):
    result, _ = run_snapshots
    assert result.get("ok") is True


def test_progress_carries_a_snapshot(run_snapshots):
    _, seen = run_snapshots
    live = [s[2] for s in seen if s[2] is not None]
    assert live, "no snapshot reached the reporter"
    assert len(live) >= 20, "a replay should report many times, not twice"


def test_snapshot_has_what_the_desk_draws(run_snapshots):
    _, seen = run_snapshots
    snap = [s[2] for s in seen if s[2]][len(seen) // 2]
    for key in ("equity", "peak", "equity_curve", "trades_so_far", "recent_trades", "at", "open_side"):
        assert key in snap, f"snapshot is missing {key}"
    assert isinstance(snap["equity_curve"], list)
    assert isinstance(snap["trades_so_far"], int)


def test_the_curve_grows_as_the_replay_proceeds(run_snapshots):
    _, seen = run_snapshots
    live = [s[2] for s in seen if s[2]]
    assert len(live[0]["equity_curve"]) < len(live[-1]["equity_curve"])


def test_the_curve_is_capped_so_it_cannot_grow_without_bound(run_snapshots):
    _, seen = run_snapshots
    for snap in (s[2] for s in seen if s[2]):
        assert len(snap["equity_curve"]) <= 240


def test_the_trade_tail_is_bounded(run_snapshots):
    _, seen = run_snapshots
    for snap in (s[2] for s in seen if s[2]):
        assert len(snap["recent_trades"]) <= 12
        assert snap["trades_so_far"] >= len(snap["recent_trades"])


def test_the_trade_count_never_goes_backwards(run_snapshots):
    _, seen = run_snapshots
    counts = [s[2]["trades_so_far"] for s in seen if s[2]]
    assert counts == sorted(counts)


def test_the_reported_bar_is_a_real_bar_time(run_snapshots):
    _, seen = run_snapshots
    bars = {b["time"] for b in _bars()}
    times = [s[2]["at"] for s in seen if s[2]]
    assert times, "no bar time reported"
    # Every timestamp shown to the trader must come off an actual bar,
    # never "now" and never a guess.
    assert all(t in bars for t in times)


def test_the_bar_advances(run_snapshots):
    _, seen = run_snapshots
    times = [s[2]["at"] for s in seen if s[2]]
    assert times == sorted(times)
    assert times[0] != times[-1]


def test_the_final_live_trade_count_matches_the_finished_result(run_snapshots):
    result, seen = run_snapshots
    live = [s[2] for s in seen if s[2]]
    # The last snapshot fires before the final bar is processed, so it may
    # trail by at most the trades opened in the remaining ~2% of bars.
    assert live[-1]["trades_so_far"] <= len(result.get("trades") or [])


def test_open_side_is_a_side_or_nothing(run_snapshots):
    _, seen = run_snapshots
    for snap in (s[2] for s in seen if s[2]):
        assert snap["open_side"] in (None, "buy", "sell")


# ------------------------------------------- the reporter is defensive

def test_a_two_argument_reporter_still_works():
    """An older reporter must not be broken by the wider callback."""
    calls: list[int] = []

    def legacy(done, total):
        calls.append(done)

    result = Backtester().run(
        StrategyLoader().load_builtin("ema_rsi"),
        _bars(), "EURUSD", "M15", 10_000.0, 1.0, 80, None, legacy,
    )
    assert result.get("ok") is True
    assert len(calls) >= 20


def test_a_broken_reporter_cannot_stop_the_run():
    def explode(*_args, **_kwargs):
        raise RuntimeError("reporter is down")

    result = Backtester().run(
        StrategyLoader().load_builtin("ema_rsi"),
        _bars(), "EURUSD", "M15", 10_000.0, 1.0, 80, None, explode,
    )
    assert result.get("ok") is True


def test_no_reporter_at_all_is_fine():
    result = Backtester().run(
        StrategyLoader().load_builtin("ema_rsi"),
        _bars(), "EURUSD", "M15", 10_000.0, 1.0, 80, None, None,
    )
    assert result.get("ok") is True
