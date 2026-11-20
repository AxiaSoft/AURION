"""One broken strategy must not take the whole strategy section down.

Reported: a strategy file with a fault in it stopped the section
working. It did, and the mechanism was in the engine, not the desk. A
strategy raising inside on_candle used to set safe_mode and RETURN out
of the closed-bar handler:

  * safe_mode stops the robot trading AT ALL - every strategy, every
    symbol - over a typo in one file;
  * the return abandoned the loop, so any strategy that had not been
    asked yet was never asked, on that bar or on any later one,
    because the next bar crashed in the same place;
  * the desk showed "safe mode" and named no file.

A fault now belongs to the strategy that caused it: that one is
switched off, named on the broken-files card with the exact error and
the line number out of the trader's own file, and the loop carries on.
"""

from __future__ import annotations

import asyncio
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.runtime.trader import Trader  # noqa: E402
from aurion.strategy.base import StrategySignal  # noqa: E402


class _Bus:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    async def publish(self, kind, payload=None):
        self.events.append((kind, payload))


class _Boom:
    """A strategy with a fault in it, raising from a file of its own."""

    name = "boom"

    def __init__(self, path: Path) -> None:
        self.path = path
        path.write_text(
            "class Boom:\n"
            "    def on_candle(self, ctx):\n"
            "        depth = 0\n"
            "        return 1 / depth\n",
            encoding="utf-8",
        )
        ns: dict = {}
        exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), ns)
        self._inner = ns["Boom"]()

    def on_candle(self, ctx):
        return self._inner.on_candle(ctx)

    def describe(self):
        return {"name": self.name}


class _Good:
    name = "good"

    def __init__(self) -> None:
        self.asked = 0

    def on_candle(self, ctx):
        self.asked += 1
        return StrategySignal("buy", "EURUSD", volume=0.10)

    def describe(self):
        return {"name": self.name}


def _trader(tmp: Path) -> Trader:
    t = Trader.__new__(Trader)
    t.bus = _Bus()
    t.robot_log = deque(maxlen=50)
    t.safe_mode = False
    t.strategy_faults = {}
    t.active_symbol = "EURUSD"
    t.strategy_meta = {}
    t.book = {
        "boom": {"inst": _Boom(tmp / "boom.py"), "enabled": True, "kind": "file",
                 "file": "boom.py", "path": str(tmp / "boom.py"),
                 "last_action": "idle", "last_reason": "", "last_ts": ""},
        "good": {"inst": _Good(), "enabled": True, "kind": "builtin",
                 "last_action": "idle", "last_reason": "", "last_ts": ""},
    }
    t.store = SimpleNamespace(record_signal=lambda row: None)
    t.last_signal = {}
    t._sync_book_meta = lambda: None
    t._note_symbol = staticmethod(lambda *a, **k: None)
    t._safe_dispatch = lambda signal, name: asyncio.sleep(0)
    return t


def _ctx() -> SimpleNamespace:
    return SimpleNamespace(symbol="EURUSD", timeframe="M15", candles=[], tick={},
                           account={}, positions=[], orders=[], ai={}, params={}, now=None)


def _run(t: Trader) -> None:
    asyncio.run(t._run_enabled_strategies(_ctx(), execute=False, blocked=["auto_trade"]))


def test_the_other_strategies_are_still_asked(tmp_path) -> None:
    t = _trader(tmp_path)
    _run(t)
    assert t.book["good"]["inst"].asked == 1, \
        "a crash in one strategy stopped the rest of the book being evaluated"


def test_the_desk_is_not_put_into_safe_mode(tmp_path) -> None:
    t = _trader(tmp_path)
    _run(t)
    assert t.safe_mode is False, "one broken file disarmed the whole desk"


def test_the_broken_strategy_switches_itself_off(tmp_path) -> None:
    t = _trader(tmp_path)
    _run(t)
    assert t.book["boom"]["enabled"] is False, \
        "it would raise again on every closed candle for the rest of the session"
    assert t.book["good"]["enabled"] is True, "the healthy strategy was switched off too"


def test_the_fault_names_the_file_and_the_line(tmp_path) -> None:
    t = _trader(tmp_path)
    _run(t)
    fault = t.strategy_faults.get("boom")
    assert fault, "the crash left no entry on the broken-files card"
    text = str(fault["error"])
    assert "boom.py" in text, f"the file is not named: {text}"
    assert "line 4" in text, f"the line is not named: {text}"
    assert "ZeroDivisionError" in text, f"the exception type is missing: {text}"
    assert fault["file"] == "boom.py"


def test_the_card_text_is_what_the_strategy_slot_says(tmp_path) -> None:
    """One sentence, not two: the card and the strategy row must agree."""
    t = _trader(tmp_path)
    _run(t)
    assert t.book["boom"]["last_action"] == "fault"
    assert t.book["boom"]["last_reason"] == t.strategy_faults["boom"]["error"]


def test_the_crash_is_journalled_as_an_error(tmp_path) -> None:
    t = _trader(tmp_path)
    _run(t)
    said = [i for i in t.robot_log if i["code"] == "strategy_fault"]
    assert said, "nothing reached the robot log"
    assert said[0]["level"] == "error"
    assert "boom.py" in said[0]["message"]


def test_a_fault_outside_the_users_file_still_reports_something() -> None:
    """No frame of the trader's own: the message must not come out empty."""
    try:
        raise ValueError("nothing to see")
    except ValueError as exc:
        text = Trader._strategy_fault_detail(exc)
    assert "ValueError" in text and "nothing to see" in text


def test_the_file_name_falls_back_to_the_strategy_name() -> None:
    assert Trader._strategy_file_of({}, "mine") == "mine.py"
    assert Trader._strategy_file_of({"path": "/a/b/mine.py"}, "x") == "mine.py"
    assert Trader._strategy_file_of({"file": "k.py"}, "x") == "k.py"


def test_the_desk_hears_about_it_without_a_refresh(tmp_path) -> None:
    """The card has to appear on its own.

    Every exit from _run_enabled_strategies publishes the strategy
    meta, so continuing past the crash still ends in a publish - but
    that is a property of the surrounding code, not of the crash
    branch, and an early return added later would quietly break it.
    """
    t = _trader(tmp_path)
    t._sync_book_meta = lambda: t.strategy_meta.update(
        {"faults": sorted((dict(v) for v in t.strategy_faults.values()),
                          key=lambda r: str(r.get("name") or ""))}
    )
    _run(t)
    sent = [p for kind, p in t.bus.events if kind == "strategy"]
    assert sent, "the strategy section was never repainted after the crash"
    faults = (sent[-1] or {}).get("faults") or []
    assert [f["name"] for f in faults] == ["boom"], \
        f"the broken file is not in what the desk was sent: {faults}"
