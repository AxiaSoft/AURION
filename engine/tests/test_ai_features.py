"""The candle-structure features, and the two fragilities they exposed.

The matrix used to describe one bar at a time: its body, its wicks, where
it closed in its own range. A trader does not read a chart that way, and
neither should the model.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.ai import features as F
from aurion.ai.models import LiveModels

SEQUENCE = ["body_ratio", "body_rel", "wick_up_ratio", "wick_dn_ratio", "run_len",
            "engulf", "inside", "close_vs_prev", "gap_atr", "push3", "ch_pos"]


def walk(n=400, seed=11):
    rng = np.random.default_rng(seed)
    px = 100 * np.exp(np.cumsum(rng.normal(0, 1, n) * 0.0012))
    rows = []
    for i, c in enumerate(px):
        o = px[i - 1] if i else c
        rows.append({"time": f"2024.01.01 {i // 60 % 24:02d}:{i % 60:02d}:00",
                     "open": float(o), "high": float(max(o, c) * 1.0004),
                     "low": float(min(o, c) * 0.9996), "close": float(c),
                     "volume": float(100 + i % 7)})
    return rows


def test_the_candle_sequence_features_are_actually_present():
    frame = F.build_feature_frame(walk())
    assert not frame.empty
    for col in SEQUENCE:
        assert col in frame.columns, f"{col} missing from the frame"
        assert col in F.FEATURE_COLUMNS, f"{col} missing from FEATURE_COLUMNS"


def test_no_feature_reads_a_bar_that_has_not_happened_yet():
    """The one defect that makes every backtest a work of fiction.

    Build the frame on the whole series, then on the series truncated at
    bar k. Row k must be identical either way.
    """
    rows = walk(500, seed=4)
    full = F.build_feature_frame(rows)
    leaks = set()
    for k in (300, 380, 450):
        part = F.build_feature_frame(rows[:k + 1])
        if part.empty:
            continue
        match = full[full["time"] == part.iloc[-1]["time"]]
        if match.empty:
            continue
        a, b = match.iloc[-1], part.iloc[-1]
        for col in F.FEATURE_COLUMNS:
            if col not in full.columns or col not in part.columns:
                continue
            x, y = float(a[col]), float(b[col])
            if not (np.isclose(x, y, rtol=1e-9, atol=1e-12)
                    or (np.isnan(x) and np.isnan(y))):
                leaks.add(col)
    assert not leaks, f"these features read the future: {sorted(leaks)}"


def test_run_length_counts_consecutive_closes_and_is_capped():
    # A two-way series first, then an unbroken run of up closes at the end.
    # Two reasons it cannot be a pure rally: a constant return makes
    # ret_z's rolling std zero, and a series with no down bar at all makes
    # rsi14 undefined - either one drops every row before we see run_len.
    rng = np.random.default_rng(2)
    rows = []
    price = 100.0
    steps = list(rng.normal(0, 0.0015, 80)) + [abs(x) + 0.0006 for x in rng.normal(0, 0.001, 10)]
    for i, step in enumerate(steps):
        o = price
        price *= float(np.exp(step))
        rows.append({"time": i, "open": o, "high": max(o, price) * 1.0004,
                     "low": min(o, price) * 0.9996, "close": price,
                     "volume": float(100 + i % 5)})
    frame = F.build_feature_frame(rows)
    assert not frame.empty
    run = frame["run_len"].to_numpy()
    assert run[-1] == 6.0, "an unbroken rally should sit at the positive cap"
    assert run.max() <= 6.0 and run.min() >= -6.0


def test_an_inside_bar_is_recognised():
    rng = np.random.default_rng(6)
    rows = []
    price = 100.0
    for i in range(90):
        o = price
        price *= float(np.exp(rng.normal(0, 0.0015)))
        rows.append({"time": i, "open": o, "high": max(o, price) * 1.002,
                     "low": min(o, price) * 0.998, "close": price,
                     "volume": float(100 + i % 5)})
    # ...and one bar that sits entirely within the previous range.
    last = rows[-1]
    mid = (last["high"] + last["low"]) / 2
    span = (last["high"] - last["low"]) * 0.2
    rows.append({"time": 90, "open": mid, "high": mid + span,
                 "low": mid - span, "close": mid + span * 0.3, "volume": 100.0})
    frame = F.build_feature_frame(rows)
    assert float(frame.iloc[-1]["inside"]) == 1.0


def test_matrix_columns_describes_exactly_what_matrix_emits():
    """The fix for a bug that would never announce itself.

    matrix() drops any column the frame lacks, so addressing a feature by
    position can silently point at a different feature.
    """
    frame = F.build_feature_frame(walk())
    cols = F.matrix_columns(frame)
    assert len(cols) == F.matrix(frame).shape[1]
    assert cols == [c for c in F.FEATURE_COLUMNS if c in frame.columns]


def test_the_volatility_pair_is_chosen_by_name_not_by_counting():
    frame = F.build_feature_frame(walk())
    cols = F.matrix_columns(frame)
    X = F.matrix(frame)
    picked = LiveModels._volatility_columns(X, cols)
    assert picked.shape[1] == 2
    # It must be the real atr_pct column, wherever that now sits.
    assert np.allclose(picked[:, 0], X[:, cols.index("atr_pct")])

    # Now shuffle the feature order the way adding a column does, and
    # confirm it still follows the name rather than the old index 9.
    order = list(reversed(cols))
    shuffled = X[:, [cols.index(c) for c in order]]
    again = LiveModels._volatility_columns(shuffled, order)
    assert np.allclose(again[:, 0], X[:, cols.index("atr_pct")])


def test_without_column_names_it_still_fits_rather_than_refusing():
    """Older callers pass no names; the model must degrade, not crash."""
    X = np.random.default_rng(0).normal(size=(50, 24))
    assert LiveModels._volatility_columns(X, None).shape == (50, 2)
    assert LiveModels._volatility_columns(X, ["wrong", "length"]).shape == (50, 2)
