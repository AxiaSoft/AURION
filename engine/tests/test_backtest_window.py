"""The replay window a strategy declares must not change its results.

AURION promises thirty days of history on every timeframe, and thirty
days of M1 is 43 200 bars. The replay used to hand the strategy every
bar from the start of the run on every bar of the run, and the builtins
turn ``ctx.candles`` straight into a DataFrame, so the cost grew with
the square of the length: 745 seconds for thirty days of M1 against 15
for the 2880 bars of M15. The promise was unreachable on exactly the
timeframes that needed it most.

The fix lets a strategy declare how far back it actually reads
(``BaseStrategy.history_window``), and the backtester hands over only
that much. That is a speed change masquerading as a behaviour change if
nobody checks, so this file checks: for every builtin that declares a
window, a replay with the window and a replay without it must produce
the same trades, the same profits and the same equity curve.

``smart_money`` deliberately declares none - its higher-timeframe bias
resamples the whole frame, and capping it really does change the answer
(14 trades against 11 over thirty days of M5). That is asserted too, so
that nobody "optimises" it later without noticing.

Run:
    python3 -m pytest engine/tests/test_backtest_window.py
"""
from __future__ import annotations

import datetime
import random

import pytest

from aurion.backtest import engine as bt_engine
from aurion.backtest.engine import Backtester
from aurion.strategy.builtin.atr_breakout import ATRBreakout
from aurion.strategy.builtin.ema_rsi import EmaRsi
from aurion.strategy.builtin.price_action import PriceAction
from aurion.strategy.builtin.smart_money import SmartMoney
from aurion.util.history import HISTORY_DAYS, bars_for_days

WINDOWED = [EmaRsi, PriceAction, ATRBreakout]


def synth(count: int, minutes: int) -> list[dict]:
    """A deterministic random walk with real, unique, spaced timestamps.

    The timestamps matter more than they look. The AI's feature frame is
    matched back to the bars by timestamp, so a series where every bar
    carries the same time silently falls back to the slow path and this
    test would then measure nothing.
    """
    random.seed(11)
    price = 2000.0
    start = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
    bars = []
    for i in range(count):
        opened = price
        price += random.gauss(0, 0.4)
        bars.append(
            {
                "time": (start + datetime.timedelta(minutes=i * minutes)).isoformat(),
                "open": opened,
                "high": max(opened, price) + 0.2,
                "low": min(opened, price) - 0.2,
                "close": price,
                "volume": 100,
            }
        )
    return bars


def fingerprint(result: dict) -> tuple:
    """Everything about a run that a trader could actually notice."""
    return (
        result["metrics"],
        result["equity_curve"],
        [(t.get("type"), t.get("entry"), t.get("exit"), t.get("profit")) for t in result["trades"]],
    )


def run_with(strategy_cls, bars: list[dict], timeframe: str, window: int) -> dict:
    """One replay, with `history_window` forced to `window`."""
    strategy = strategy_cls()
    strategy.history_window = window
    return Backtester().run(strategy, bars, "XAUUSD", timeframe)


@pytest.mark.parametrize("strategy_cls", WINDOWED, ids=lambda c: c.name)
def test_declared_window_does_not_change_the_result(strategy_cls) -> None:
    """The window is a speed change. Prove it is only a speed change.

    M15 rather than M1 because the point is the equality, not the clock,
    and 2880 bars is the real thirty-day window on that timeframe.
    """
    bars = synth(bars_for_days("M15"), 15)
    declared = int(strategy_cls.history_window)
    assert declared > 0, f"{strategy_cls.name} is expected to declare a window"
    assert declared < len(bars), "a window longer than the run would prove nothing"

    capped = run_with(strategy_cls, bars, "M15", declared)
    full = run_with(strategy_cls, bars, "M15", 0)

    assert fingerprint(capped) == fingerprint(full), (
        f"{strategy_cls.name}: the declared window of {declared} bars changes the result over "
        f"{HISTORY_DAYS} days of M15 - it is too short for what this strategy reads"
    )
    assert capped["metrics"].get("trades"), "a run with no trades at all cannot prove anything"


@pytest.mark.parametrize("strategy_cls", WINDOWED, ids=lambda c: c.name)
def test_the_window_is_longer_than_anything_the_strategy_asks_for(strategy_cls) -> None:
    """A window shorter than a declared lookback would be a silent bug."""
    longest = max(
        [0]
        + [
            int(v)
            for k, v in (strategy_cls.params or {}).items()
            if isinstance(v, (int, float))
            and any(w in k for w in ("period", "slow", "lookback", "bars", "window"))
        ]
    )
    assert strategy_cls.history_window >= longest * 4, (
        f"{strategy_cls.name} declares a {strategy_cls.history_window}-bar window but reads back "
        f"{longest} bars - too little headroom"
    )


def test_smart_money_keeps_the_whole_history() -> None:
    """It resamples the entire frame, so it must not declare a window.

    This is not a style rule. With a 1500-bar window over thirty days of
    M5 it produced 14 trades where the full history produced 11, because
    the higher-timeframe bias it computes depends on how far back the
    frame goes. The default of 0 is what keeps it correct.
    """
    assert SmartMoney.history_window == 0, (
        "smart_money's _htf_bias resamples the whole frame; a window changes its answers"
    )


def test_zero_means_the_whole_run() -> None:
    """The default must be the behaviour that existed before any of this."""
    from aurion.strategy.base import BaseStrategy

    assert BaseStrategy.history_window == 0


def test_a_nonsense_window_cannot_break_a_run() -> None:
    """An uploaded strategy may declare anything at all.

    A negative number, a string, a number larger than the run: none of
    them may raise, and none of them may hand the strategy more bars
    than exist.
    """
    bars = synth(600, 15)
    for junk in (-5, "lots", None, 10**9, 0.0):
        strategy = EmaRsi()
        strategy.history_window = junk  # type: ignore[assignment]
        result = Backtester().run(strategy, bars, "XAUUSD", "M15")
        assert result["ok"], f"history_window={junk!r} broke the run"


def test_the_window_actually_reaches_the_strategy() -> None:
    """Prove the plumbing, not just the outcome.

    The equality tests above would also pass if `history_window` were
    ignored entirely, which is the failure mode worth guarding: a
    refactor drops the slice and everything still looks green while the
    replay is quadratic again. So record what the strategy is really
    handed.
    """
    seen: list[int] = []

    class Counter(EmaRsi):
        history_window = 300

        def on_candle(self, ctx):
            seen.append(len(ctx.candles))
            return None

    bars = synth(900, 15)
    Backtester().run(Counter(), bars, "XAUUSD", "M15")
    assert seen, "on_candle was never called"
    assert max(seen) <= 300, f"the strategy saw {max(seen)} bars despite declaring 300"
    assert max(seen) == 300, "the window should be filled once there are enough bars"


def test_the_ceiling_is_above_the_thirty_day_window() -> None:
    """The safety ceiling must never be the thing that truncates M1."""
    assert bt_engine._WINDOW_CEILING > bars_for_days("M1")
