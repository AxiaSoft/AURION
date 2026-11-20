"""A file that will not load must say why, on the list as well.

loader.list() is what /v1/strategies answers with, and it used to carry
only {"loaded": false} for a file it could not import. On the desk that
is indistinguishable from a strategy the trader has deliberately left
switched off - so a bad upload looked like a lost upload, and the only
place the reason was ever shown was the response to the upload request
that caused it. Come back the next morning and the explanation is gone.

The sentence already exists: load_path turns every failure into one
StrategyValidationError a trader can act on. It is now kept.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from aurion.strategy.loader import StrategyLoader, StrategyValidationError  # noqa: E402

GOOD = """
from aurion.strategy.base import BaseStrategy, StrategySignal


class Fine(BaseStrategy):
    name = "fine"

    def on_candle(self, ctx):
        return None
"""

BROKEN = """
from aurion.strategy.base import BaseStrategy


class Broken(BaseStrategy):
    name = "broken"
    knobs = 1 / 0

    def on_candle(self, ctx):
        return None
"""


@pytest.fixture()
def loader(tmp_path, monkeypatch):
    ldr = StrategyLoader.__new__(StrategyLoader)
    ldr.dir = tmp_path
    ldr.vault = tmp_path / "vault"
    ldr.loaded = {}
    ldr.failures = {}
    return ldr


def _row(loader: StrategyLoader, stem: str) -> dict:
    rows = {r["file"]: r for r in loader.list()}
    return rows[f"{stem}.py"]


def test_a_broken_file_carries_its_error(loader, tmp_path) -> None:
    (tmp_path / "broken.py").write_text(BROKEN, encoding="utf-8")
    with pytest.raises(StrategyValidationError):
        loader.load_path(tmp_path / "broken.py")
    row = _row(loader, "broken")
    assert row["loaded"] is False
    assert "broken.py" in row["error"]
    assert "ZeroDivisionError" in row["error"]


def test_a_file_nobody_asked_for_is_not_an_error(loader, tmp_path) -> None:
    """Never loaded is not the same as cannot be loaded."""
    (tmp_path / "fine.py").write_text(GOOD, encoding="utf-8")
    assert _row(loader, "fine")["error"] == ""


def test_loading_successfully_clears_an_old_error(loader, tmp_path) -> None:
    path = tmp_path / "fixme.py"
    path.write_text(BROKEN, encoding="utf-8")
    with pytest.raises(StrategyValidationError):
        loader.load_path(path)
    assert _row(loader, "fixme")["error"]
    path.write_text(GOOD, encoding="utf-8")
    loader.load_path(path)
    assert _row(loader, "fixme")["error"] == "", \
        "the fixed file still shows yesterday's complaint"
    assert _row(loader, "fixme")["loaded"] is True


def test_every_row_has_the_key(loader, tmp_path) -> None:
    """The desk reads r.error unconditionally."""
    (tmp_path / "fine.py").write_text(GOOD, encoding="utf-8")
    (tmp_path / "broken.py").write_text(BROKEN, encoding="utf-8")
    assert all("error" in row for row in loader.list())
