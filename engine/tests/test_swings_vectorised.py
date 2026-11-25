"""Fractal pivots, found all at once, must find exactly what the loop found.

``swings()`` asks whether a bar's extreme beats its ``k`` neighbours on
each side. It used to ask that one bar at a time, taking the max and
the min of a five-element slice per bar - and numpy's per-call overhead
dwarfs the work on an array that small. Profiling smart_money over 2880
bars of M15 counted 13.3 million ufunc reductions and 41 of 61 seconds
inside this one function, which made it the most expensive thing in a
replay.

It now hands numpy the whole series twice instead, via a sliding
window. That is worth having twice over, because a replay runs in a
worker thread and a Python-level loop holds the GIL: the engine's own
heartbeat was being starved by it. Measured over a 2000-bar replay of
smart_money, event-loop lag fell from p95 5.3ms to p95 0.8ms, which is
the difference between a health check answering on time and the desk
deciding the engine has gone busy.

None of that is worth anything if the answer changed. A pivot is where
a strategy puts its stop, so an off-by-one here is a stop in the wrong
place, silently. This file pins the answer against the original loop,
which is reproduced below and is the definition being preserved.

    python3 -m pytest engine/tests/test_swings_vectorised.py
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.strategy.builtin._structure import Swing, swings  # noqa: E402


def reference(frame: pd.DataFrame, k: int = 2) -> list[Swing]:
    """The original per-bar loop, kept as the definition of correct.

    This is the code that was replaced, verbatim apart from its name.
    If the vectorised version and this one ever disagree, the
    vectorised one is wrong - that is the whole point of keeping it.
    """
    rows = len(frame)
    if rows < 2 * k + 1 or k < 1:
        return []
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    found: list[Swing] = []
    for i in range(k, rows - k):
        window_hi = highs[i - k : i + k + 1]
        window_lo = lows[i - k : i + k + 1]
        if highs[i] >= window_hi.max():
            found.append(Swing(i, float(highs[i]), "high"))
        if lows[i] <= window_lo.min():
            found.append(Swing(i, float(lows[i]), "low"))
    return found


def walk(count: int, seed: int = 3) -> pd.DataFrame:
    random.seed(seed)
    price = 2000.0
    rows = []
    for _ in range(count):
        opened = price
        price += random.gauss(0, 0.5)
        rows.append(
            {
                "open": opened,
                "high": max(opened, price) + random.random() * 0.3,
                "low": min(opened, price) - random.random() * 0.3,
                "close": price,
            }
        )
    return pd.DataFrame(rows)


@pytest.mark.parametrize("k", [1, 2, 3, 5, 9])
@pytest.mark.parametrize("rows", [0, 1, 2, 3, 5, 11, 50, 500, 2000])
def test_it_finds_what_the_loop_found(k: int, rows: int) -> None:
    frame = walk(rows)
    assert swings(frame, k) == reference(frame, k)


def test_the_degenerate_cases_match() -> None:
    """Too short, and k below one, were both early returns."""
    for k in (0, -1, 1):
        for rows in (0, 1, 2 * max(k, 1)):
            frame = walk(rows)
            assert swings(frame, k) == reference(frame, k), f"k={k} rows={rows}"


def test_a_flat_series_matches() -> None:
    """Every bar ties with its neighbours, so every eligible bar is both.

    The comparison is `>=`, not `>`, and a run of identical prices is
    where that choice shows. It also proves the two masks are applied
    to the same bar rather than to each other's.
    """
    frame = pd.DataFrame([{"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}] * 40)
    got = swings(frame, 2)
    assert got == reference(frame, 2)
    assert len(got) == 2 * (40 - 4), "every interior bar should be both a high and a low"


def test_a_bar_that_is_both_yields_the_high_first() -> None:
    """Order is part of the answer: callers take the last of a kind."""
    frame = pd.DataFrame([{"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0}] * 9)
    got = swings(frame, 2)
    assert [s.kind for s in got[:2]] == ["high", "low"]
    assert got == reference(frame, 2)


def test_nan_prices_do_not_change_the_answer() -> None:
    """A hole in the series must behave as it always did.

    Comparison against NaN is false either way, so neither the bar nor
    its neighbours can be pivots. Asserted rather than assumed, because
    a vectorised max propagates NaN across a whole window and a
    per-element one does not have to.
    """
    frame = walk(200)
    frame.loc[50, "high"] = np.nan
    frame.loc[120, "low"] = np.nan
    assert swings(frame, 2) == reference(frame, 2)


def test_the_last_k_bars_are_never_pivots() -> None:
    """An unconfirmed pivot is the thing that repaints."""
    frame = walk(100)
    for k in (1, 2, 4):
        found = swings(frame, k)
        assert all(s.index < 100 - k for s in found), f"k={k} returned an unconfirmed pivot"
        assert all(s.index >= k for s in found), f"k={k} returned a pivot with no left side"


def test_it_is_actually_vectorised() -> None:
    """Guard the optimisation itself, not only its result.

    Every assertion above passes against the slow loop too - they are
    written to. So if a later edit quietly restores the per-bar version
    the suite stays green and the GIL pressure comes back with it. The
    sliding window is the thing that made the difference, so its
    absence is what is checked.
    """
    source = (ROOT / "engine" / "aurion" / "strategy" / "builtin" / "_structure.py").read_text(
        encoding="utf-8"
    )
    body = source.split("def swings(", 1)[1].split("\ndef ", 1)[0]
    code = "\n".join(
        line for line in body.splitlines() if not line.strip().startswith("#")
    ).split('"""')
    code = code[2] if len(code) > 2 else body
    assert "sliding_window_view" in code, (
        "swings() is no longer vectorised; the per-bar loop starves the engine's event "
        "loop during a replay (p95 lag 0.8ms -> 5.3ms when it was last measured)"
    )
    assert "for i in range(k, rows - k)" not in code, "the per-bar loop is back"
