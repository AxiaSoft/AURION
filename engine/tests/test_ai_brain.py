"""The AI upgrades: triple-barrier labels and edge-calibrated confidence."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.ai.engine import _labels_from_frame  # noqa: E402
from aurion.ai.models import LiveModels  # noqa: E402


def _frame(closes: list[float], atr_pct: float = 0.01) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "open": closes,
            "high": [c * 1.0005 for c in closes],
            "low": [c * 0.9995 for c in closes],
            "close": closes,
            "atr_pct": [atr_pct] * len(closes),
        }
    )


def test_labels_follow_the_first_barrier_touched() -> None:
    # A straight ramp up: every early bar must be labelled bullish.
    closes = [100 * (1.01 ** i) for i in range(30)]
    y, sl = _labels_from_frame(_frame(closes), horizon=4)
    assert sl.stop == len(closes) - 4
    assert set(np.unique(y[:10])) == {1}
    # A straight ramp down labels bearish.
    closes = [100 * (0.99 ** i) for i in range(30)]
    y, _ = _labels_from_frame(_frame(closes), horizon=4)
    assert set(np.unique(y[:10])) == {-1}


def test_flat_market_is_labelled_neutral() -> None:
    closes = [100.0] * 30
    y, _ = _labels_from_frame(_frame(closes), horizon=4)
    assert set(np.unique(y)) == {0}


def test_short_series_is_not_labelled() -> None:
    y, sl = _labels_from_frame(_frame([100.0, 101.0, 102.0]), horizon=6)
    assert len(y) == 0
    assert sl == slice(0, 0)


def test_confidence_is_shrunk_when_there_is_no_edge(tmp_path: Path) -> None:
    models = LiveModels(tmp_path)
    rng = np.random.default_rng(3)
    # Pure noise: the model cannot have an edge, so it must not sound sure.
    X = rng.normal(size=(400, 8))
    y = rng.choice([-1, 0, 1], size=400)
    result = models.fit(X, y)
    assert result["ok"] is True
    assert models.edge <= 0.2
    out = models.infer(X[0])
    assert out["ready"] is True
    assert out["confidence"] <= 0.62


def test_a_learnable_pattern_raises_the_edge(tmp_path: Path) -> None:
    models = LiveModels(tmp_path)
    rng = np.random.default_rng(11)
    X = rng.normal(size=(600, 8))
    y = np.where(X[:, 0] > 0.3, 1, np.where(X[:, 0] < -0.3, -1, 0))
    models.fit(X, y)
    assert models.edge > 0.3
    assert models.metrics["accuracy_holdout"] > models.metrics["baseline_holdout"]
