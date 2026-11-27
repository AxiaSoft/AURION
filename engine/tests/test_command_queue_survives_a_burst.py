"""Two commands issued back to back must both reach the expert.

Reported as "closing a position takes far too long". One cause was not
slowness at all - it was a lost command. Commands reach the expert
through a file that the engine wrote with ``write_bytes``, which
replaces what is already there. The expert reads that file on its timer,
so any two commands issued inside one poll window left only the second.
The first was dropped silently, and the engine then sat out its
twelve-second acknowledgement timeout waiting for a reply to a command
nobody still held.

That is the ordinary case, not a rare race: closing several positions
sends one command per ticket, back to back.

    /tmp/v/bin/python -m pytest engine/tests/test_command_queue_survives_a_burst.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.mt5.bridge import MT5Bridge  # noqa: E402


class Inbox:
    """Just enough bridge to exercise the command writer."""

    _write_cmd_file = MT5Bridge._write_cmd_file

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def _inbox_dirs(self) -> list[Path]:
        return [self.folder]


def test_a_burst_of_closes_is_not_reduced_to_the_last_one(tmp_path: Path) -> None:
    box = Inbox(tmp_path)
    for ticket in (101, 102, 103):
        box._write_cmd_file(7, {"type": "close", "ticket": ticket})

    blob = (tmp_path / "aurion_cmd_7.json").read_text(encoding="utf-8")
    rows = [json.loads(line) for line in blob.splitlines() if line.strip()]
    assert [r["ticket"] for r in rows] == [101, 102, 103], (
        "commands overwrote each other - the earlier closes never happened"
    )


def test_every_command_is_one_line(tmp_path: Path) -> None:
    """The expert splits on newlines; a command containing one would
    arrive as two unparseable halves."""
    box = Inbox(tmp_path)
    box._write_cmd_file(7, {"type": "close", "comment": "two\nlines"})
    blob = (tmp_path / "aurion_cmd_7.json").read_text(encoding="utf-8")
    assert len([ln for ln in blob.splitlines() if ln.strip()]) == 1
    assert json.loads(blob)["comment"] == "two\nlines"


def test_the_file_ends_with_a_newline(tmp_path: Path) -> None:
    """Otherwise the next append runs straight onto the previous line."""
    box = Inbox(tmp_path)
    box._write_cmd_file(7, {"type": "close", "ticket": 1})
    assert (tmp_path / "aurion_cmd_7.json").read_bytes().endswith(b"\n")


def test_each_chart_has_its_own_queue(tmp_path: Path) -> None:
    box = Inbox(tmp_path)
    box._write_cmd_file(7, {"type": "close", "ticket": 1})
    box._write_cmd_file(8, {"type": "close", "ticket": 2})
    assert json.loads((tmp_path / "aurion_cmd_7.json").read_text())["ticket"] == 1
    assert json.loads((tmp_path / "aurion_cmd_8.json").read_text())["ticket"] == 2


def test_an_unwritable_folder_does_not_raise(tmp_path: Path) -> None:
    """A failure here must never take down the trade path."""
    class Broken(Inbox):
        def _inbox_dirs(self):
            return [tmp_path / "nope" / "\0bad"]

    Broken(tmp_path)._write_cmd_file(7, {"type": "close"})
