"""The engine has to be able to say which code it is running.

An update copies files over a live installation, and a Python process
keeps the modules it has already imported. A customer therefore ran an
updated installation that kept producing an error whose line no longer
existed in the source on their own disk, and nothing anywhere could tell
them -- the files were new, the engine was up, and both facts were true
while the behaviour was a build old.

BUILD_ID is the missing fact: a fingerprint of the source this process
imported, taken at import time, reported on /health and compared by the
desk against the same fingerprint of those files as they are now.

What these pin is the part the comparison depends on: the fingerprint
follows content, ignores bytecode, and refuses to guess.
"""

from __future__ import annotations

from pathlib import Path

from aurion import build_id


def _tree(root: Path) -> Path:
    pkg = root / "aurion"
    (pkg / "strategy").mkdir(parents=True)
    (pkg / "__init__.py").write_text("x = 1\n", encoding="utf-8")
    (pkg / "strategy" / "loader.py").write_text("def load():\n    return 1\n", encoding="utf-8")
    return root


def test_same_files_same_fingerprint(tmp_path: Path) -> None:
    a = _tree(tmp_path / "a")
    b = _tree(tmp_path / "b")
    assert build_id.compute(a) == build_id.compute(b) != ""


def test_a_changed_line_changes_it(tmp_path: Path) -> None:
    root = _tree(tmp_path / "a")
    before = build_id.compute(root)
    (root / "aurion" / "strategy" / "loader.py").write_text(
        "def load():\n    return 2\n", encoding="utf-8"
    )
    assert build_id.compute(root) != before


def test_a_copy_that_keeps_timestamps_is_still_caught(tmp_path: Path) -> None:
    """Content, not mtime.

    The failure this exists for was caused by trusting timestamps: a
    .pyc judged current against a source file newer than it. A
    fingerprint that read mtimes would inherit exactly that bug.
    """
    root = _tree(tmp_path / "a")
    target = root / "aurion" / "strategy" / "loader.py"
    before = build_id.compute(root)
    stat = target.stat()
    target.write_text("def load():\n    return 3\n", encoding="utf-8")
    import os

    os.utime(target, (stat.st_atime, stat.st_mtime))
    assert build_id.compute(root) != before


def test_bytecode_is_not_part_of_it(tmp_path: Path) -> None:
    root = _tree(tmp_path / "a")
    before = build_id.compute(root)
    cache = root / "aurion" / "strategy" / "__pycache__"
    cache.mkdir()
    (cache / "loader.cpython-312.pyc").write_bytes(b"anything at all")
    (cache / "stray.py").write_text("# bytecode dir, ignored whole\n", encoding="utf-8")
    assert build_id.compute(root) == before


def test_an_unreadable_tree_says_nothing_rather_than_guessing(tmp_path: Path) -> None:
    """Empty means "no statement", never "different".

    Everything downstream treats a blank fingerprint as unknown, because
    telling a working desk it is running stale code is worse than
    telling it nothing.
    """
    assert build_id.compute(tmp_path / "does-not-exist") == ""


def test_the_running_value_is_taken_once() -> None:
    """Read, never recomputed: a fresh reading would describe the disk.

    The whole point is to compare the process with the disk, so the
    process's own half has to be frozen at import.
    """
    assert isinstance(build_id.BUILD_ID, str)
    assert len(build_id.BUILD_ID) == 16
    assert build_id.report()["build_id"] == build_id.BUILD_ID
