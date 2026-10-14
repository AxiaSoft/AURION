"""A signal that is produced has to reach the broker, or say why not.

Two failures this covers, both of which look identical from the desk -
a strategy that never fires - and have completely different causes.

The first is a fault in the AI. The AI is documented everywhere as a
filter and never a source of signals, and execution.flatten_on_ai_fault
defaults to false for the same reason. Yet one exception out of the model
used to return out of the closed-bar handler before the strategy book was
evaluated at all, which switched the whole robot off and said only that
the AI had failed.

The second is softer and wasted more time: when a signal was seen and not
sent, the log said "auto-trade is not armed (or a gate is closed)". That
is five possibilities in one sentence - the switch, the kill switch, safe
mode, a prop lock, a tape that is not live - and each has a different
fix.

Neither needs MetaTrader, numpy or an event loop to test, so neither does
this file.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT))


def _slice(name: str) -> str:
    """One method's body, up to the next definition at the same level."""
    start = SOURCE.index(f"def {name}(")
    rest = SOURCE[start:]
    end = re.search(r"\n    (?:@|async def |def )", rest[1:])
    return rest[: end.start() + 1] if end else rest


# --------------------------------------------- the AI is only a filter --

def test_an_ai_fault_does_not_stop_the_strategies():
    body = _slice("_on_closed_candle")

    fault = body.index("ai_fault")
    run = body.index("_run_enabled_strategies")
    assert fault < run, "the AI fault handler must come before the book runs"

    # The handler must not return out of the function before the book.
    between = body[fault:run]
    assert "\n            return" not in between, (
        "an AI fault returns before the strategies are evaluated - "
        "one exception from the model switches the whole robot off"
    )


def test_the_ai_result_is_optional_from_there_on():
    """Everything that reads the AI state has to tolerate not having one."""
    body = _slice("_on_closed_candle")
    assert "state: dict[str, Any] | None = None" in body
    assert "if state:" in body

    # No unguarded state.get(...) after the try block.
    after = body[body.index("except Exception as exc:"):]
    guard = after.index("if state:")
    assert "state.get(" not in after[:guard], "state is read before it is checked"


# ------------------------------------------- say which gate is closed --

def test_every_gate_has_its_own_sentence():
    from aurion.runtime.gates import fire_blockers

    shut = fire_blockers(auto_trade=False, kill_switch=True, safe_mode=True,
                         prop_enabled=True, prop_locked=True, tape_mode="replay")
    joined = " | ".join(shut)
    for gate in ("auto-trade is off", "emergency switch", "safe mode",
                 "prop rules", "not live"):
        assert gate in joined, f"no distinct message for: {gate}"
    assert len(shut) == 5, shut


def test_the_blockers_reach_the_log():
    body = _slice("_run_enabled_strategies")
    assert "blocked" in body
    assert '", ".join(blocked)' in body, "the reasons are collected but never shown"
    assert "not_armed" in body


def test_nothing_is_reported_when_the_path_is_clear():
    from aurion.runtime.gates import fire_blockers

    clear = dict(auto_trade=True, kill_switch=False, safe_mode=False,
                 prop_enabled=False, prop_locked=False, tape_mode="live")
    assert fire_blockers(**clear) == []

    assert fire_blockers(**{**clear, "auto_trade": False}) == ["auto-trade is off"]
    assert fire_blockers(**{**clear, "kill_switch": True}) == ["the emergency switch is down"]

    # Prop only blocks when it is both on and locked.
    assert fire_blockers(**{**clear, "prop_enabled": True}) == []
    assert fire_blockers(**{**clear, "prop_enabled": True, "prop_locked": True}) != []

    # The tape's actual mode is quoted, so "not live" is actionable.
    replay = fire_blockers(**{**clear, "tape_mode": "replay"})
    assert len(replay) == 1 and "replay" in replay[0]


def test_all_the_shut_gates_are_reported_not_just_the_first():
    """Otherwise a trader is sent round the loop once per gate."""
    from aurion.runtime.gates import fire_blockers

    both = fire_blockers(auto_trade=False, kill_switch=True, safe_mode=False,
                         prop_enabled=False, prop_locked=False, tape_mode="live")
    assert len(both) == 2, both


def test_the_trader_delegates_rather_than_repeating_itself():
    body = _slice("fire_blockers")
    assert "gate_blockers(" in body, "the trader has its own copy of the rules"


# ------------------------------------- the settings are still honoured --

def test_entries_still_pass_through_every_configured_gate():
    """The point of this work is that the robot trades *to the settings*."""
    body = _slice("_dispatch_signal")
    for gate in ("require_ai_agree", "min_ai_confidence", "_robot_volume"):
        assert gate in body, f"dispatch no longer honours {gate}"

    book = _slice("_run_enabled_strategies")
    assert "free_slots" in book, "the open-trade ceiling is not enforced"
    assert "disagree" in book, "strategies disagreeing on side must not enter"


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        fn()
        passed += 1
        print(f"ok   {name}")
    print(f"\n{passed}/{passed} signal-to-order checks passed")
