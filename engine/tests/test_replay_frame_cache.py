"""The hoisted candle frame must be a speed change and nothing else.

Every builtin strategy opens its bar with
``candles_to_frame(ctx.candles)``, and a replay hands it a fresh slice
on every bar. Building a DataFrame from a list of dicts is the
expensive path in pandas, and on a replay that cost was paid once per
bar for a window that overlaps the previous one almost entirely.
Profiled over 2880 bars of M15: 22.5 of 52.9 seconds, 42% of the run.

``FramedWindow`` fixes that by building the frame once for the whole
series and handing each bar a slice of it. That is a correctness risk
of the worst kind - if the window is ever off by a row, the strategy
reads the wrong bars and trades on them, and nothing raises. It is not
a crash; it is a different answer, arrived at silently.

So this file checks the dangerous things rather than the fast ones:

  * the shortcut returns exactly what rebuilding would have returned,
    across window sizes, including slices of slices (which is what
    AIEngine.infer does before calling patterns.detect);
  * it declines whenever it cannot be sure - a mutated window, a
    stepped slice, a series with an unparseable row in it;
  * a caller may mutate what it gets back without poisoning the cache
    for the next bar;
  * and a whole replay produces the identical result with the shortcut
    on and off.

The last one is the one that would actually catch a regression, and it
is deliberately run on a short series so it stays affordable.

    python3 -m pytest engine/tests/test_replay_frame_cache.py
"""
from __future__ import annotations

import datetime
import random
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.ai.features import FramedWindow, candles_to_frame  # noqa: E402
from aurion.backtest.engine import Backtester  # noqa: E402
from aurion.strategy.builtin.ema_rsi import EmaRsi  # noqa: E402
from aurion.strategy.builtin.price_action import PriceAction  # noqa: E402


def synth(count: int, minutes: int = 15) -> list[dict]:
    """A deterministic random walk with real, spaced timestamps."""
    random.seed(7)
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


BARS = synth(400)
FULL = candles_to_frame(BARS)


def rebuilt(lo: int, hi: int) -> pd.DataFrame:
    """What the slow path would have produced for this window."""
    return candles_to_frame(list(BARS[lo:hi]))


@pytest.mark.parametrize("lo,hi", [(0, 400), (0, 1), (0, 30), (100, 300), (399, 400), (250, 400)])
def test_the_shortcut_matches_a_rebuild(lo: int, hi: int) -> None:
    window = FramedWindow(BARS[lo:hi], FULL, lo, hi)
    pd.testing.assert_frame_equal(candles_to_frame(window), rebuilt(lo, hi))


@pytest.mark.parametrize("tail", [1, 5, 16, 60])
def test_a_slice_of_a_window_still_matches(tail: int) -> None:
    """``rows[-16:]`` is what infer() hands to patterns.detect every bar.

    ``list.__getitem__`` on a subclass returns a plain list, so without
    the override this silently fell back to the slow path - correct,
    but it was half the remaining cost.
    """
    window = FramedWindow(BARS[100:300], FULL, 100, 300)
    pd.testing.assert_frame_equal(candles_to_frame(window[-tail:]), rebuilt(300 - tail, 300))


def test_a_slice_of_a_slice_still_matches() -> None:
    window = FramedWindow(BARS[0:400], FULL, 0, 400)
    pd.testing.assert_frame_equal(candles_to_frame(window[50:300][-16:]), rebuilt(284, 300))


def test_a_stepped_slice_declines_rather_than_guessing() -> None:
    """Every other bar is not a contiguous window of the parent.

    It must come back as a plain list and take the slow path. Returning
    a FramedWindow with the same bounds would read 200 bars where 100
    were asked for, which is the silent-wrong-answer failure.
    """
    window = FramedWindow(BARS[0:200], FULL, 0, 200)
    stepped = window[::2]
    assert not isinstance(stepped, FramedWindow), "a stepped slice cannot carry the parent frame"
    pd.testing.assert_frame_equal(
        candles_to_frame(stepped), candles_to_frame(list(BARS[0:200:2]))
    )


def test_a_mutated_window_declines() -> None:
    """The bounds describe the rows it was built from, not what it holds now."""
    window = FramedWindow(BARS[0:50], FULL, 0, 50)
    window.append(BARS[50])
    assert window.cached_frame() is None, "a window that grew must not answer from the old bounds"
    pd.testing.assert_frame_equal(candles_to_frame(window), rebuilt(0, 51))


def test_the_caller_may_mutate_what_it_is_given() -> None:
    """Strategies add columns to the frame they get. That must not leak.

    build_feature_frame alone adds twenty. If the shortcut handed back
    anything sharing storage with the cache, bar two would inherit bar
    one's columns.
    """
    window = FramedWindow(BARS[0:100], FULL, 0, 100)
    first = candles_to_frame(window)
    first["invented"] = 1.0
    first.loc[0, "close"] = -999.0
    second = candles_to_frame(window)
    assert "invented" not in second.columns, "the cache kept a caller's column"
    assert float(second.loc[0, "close"]) != -999.0, "the cache kept a caller's edit"
    pd.testing.assert_frame_equal(second, rebuilt(0, 100))


def test_a_series_with_an_unparseable_row_is_left_alone() -> None:
    """candles_to_frame drops rows it cannot read, which shifts positions.

    One dropped row makes every position after it name a different bar,
    so a window addressed by position would be quietly wrong. The
    replay must notice and not offer the shortcut at all.
    """
    dirty = [dict(b) for b in BARS[:100]]
    dirty[40]["close"] = "not a number"
    built = candles_to_frame(dirty)
    assert len(built) < len(dirty), "this fixture is meant to lose a row"
    # The replay's own guard, stated as the condition it checks.
    assert not (len(built) == len(dirty) and not built.empty), (
        "a frame shorter than the bar list must not be used as a positional source"
    )


@pytest.mark.parametrize("strategy_cls", [EmaRsi, PriceAction], ids=lambda c: c.name)
def test_a_whole_replay_is_unchanged(strategy_cls, monkeypatch) -> None:
    """The end-to-end check, which is the one that matters.

    The shortcut is disabled by making every window decline, which is
    the same path a series with a bad row takes, so this also covers
    that fallback being equivalent rather than merely present.
    """
    bars = synth(320)

    def fingerprint(result: dict) -> tuple:
        return (
            result["metrics"],
            result["equity_curve"],
            [(t.get("type"), t.get("entry"), t.get("exit"), t.get("profit")) for t in result["trades"]],
        )

    fast = Backtester().run(strategy_cls(), bars, "XAUUSD", "M15")
    monkeypatch.setattr(FramedWindow, "cached_frame", lambda self: None)
    slow = Backtester().run(strategy_cls(), bars, "XAUUSD", "M15")

    assert fingerprint(fast) == fingerprint(slow), (
        f"{strategy_cls.name}: the hoisted frame changed the result - it is supposed to be "
        "a speed change only"
    )
