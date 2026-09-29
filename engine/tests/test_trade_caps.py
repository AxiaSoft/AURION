"""The two "how many trades" numbers are two different rules.

`min_open_trades` is how many tickets ONE signal may open. `max_open_trades`
is the ceiling on everything the robot holds at once. The desk used to label
them "open at least" and "open at most", which reads as a single range and
is not what either of them does - so this pins the behaviour down.

    python3 engine/tests/test_trade_caps.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRADER = ROOT / "engine" / "aurion" / "runtime" / "trader.py"
DESK = ROOT / "apps" / "web" / "js" / "app.js"
LANG = ROOT / "lang"


def _src() -> str:
    return TRADER.read_text(encoding="utf-8")


def test_min_is_per_signal_not_a_floor_on_open_trades() -> None:
    src = _src()
    block = src[src.index("def _entries_for_signal("):src.index("def _higher_timeframe(")]
    assert 'getattr(self, "min_open_trades", 1)' in block, \
        "the minimum belongs to one signal's burst, not to the open book"
    assert "self.free_slots(symbol)" in block, \
        "a burst can never exceed the room left under the ceiling"


def test_max_is_the_ceiling_and_prop_can_lower_it() -> None:
    src = _src()
    block = src[src.index("def _total_cap("):src.index("def free_slots(")]
    assert 'getattr(self, "max_open_trades", 2)' in block
    assert "cap = min(cap," in block and "self.prop" in block, \
        "an armed prop profile has to be able to hold the ceiling lower"


def test_the_effective_caps_reach_the_desk() -> None:
    src = _src()
    for key in ('"cap_effective": self._total_cap()',
                '"cap_symbol": self._per_symbol_cap()',
                '"cap_by_prop"'):
        assert key in src, f"{key} must be published or the desk shows a wish, not the rule"


def test_the_desk_labels_say_which_is_which() -> None:
    desk = DESK.read_text(encoding="utf-8")
    block = desk[desk.index("function slotsHtml("):desk.index("function qualityHtml(")]
    for key in ("slots.min_label", "slots.min_hint", "slots.max_label",
                "slots.max_hint", "slots.example", "slots.state"):
        assert key in block, f"{key} is missing from the card"
    assert "cap_effective" in block, "the card has to show the effective ceiling"
    assert "slots.cap_prop" in block, "and say when the prop profile is the one setting it"


def test_every_language_explains_both() -> None:
    import json
    need = ["min_label", "min_hint", "max_label", "max_hint", "example", "state",
            "cap_prop", "cap_symbol", "help", "title"]
    for lang in ("en", "fa", "ar"):
        pack = json.loads((LANG / f"{lang}.json").read_text(encoding="utf-8"))
        slots = pack.get("slots") or {}
        missing = [k for k in need if not slots.get(k)]
        assert not missing, f"{lang} is missing {missing}"
        # The hints have to actually distinguish the two, not repeat the label.
        assert slots["min_hint"] != slots["max_hint"], f"{lang}: the two hints are the same"


TESTS = [
    test_min_is_per_signal_not_a_floor_on_open_trades,
    test_max_is_the_ceiling_and_prop_can_lower_it,
    test_the_effective_caps_reach_the_desk,
    test_the_desk_labels_say_which_is_which,
    test_every_language_explains_both,
]

if __name__ == "__main__":
    bad = 0
    for fn in TESTS:
        try:
            fn()
            print("  ok  " + fn.__name__)
        except AssertionError as exc:
            print("FAIL  " + fn.__name__ + " → " + str(exc))
            bad += 1
    print("\n%d failing." % bad if bad else "\nTwo rules, told apart.")
    raise SystemExit(1 if bad else 0)
