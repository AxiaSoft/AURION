"""The numbers the desk shows must be the numbers the engine uses.

The robot page now tells the trader how the setup-quality score is built -
how much the AI can move it, how much the slower chart can, and so on. That
is only honest while it matches signal_quality(). This test reads both and
fails if they drift apart, which is the one way that explanation can quietly
become a lie.

    python3 engine/tests/test_quality_weights.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRADER = ROOT / "engine" / "aurion" / "runtime" / "trader.py"
DESK = ROOT / "apps" / "web" / "js" / "app.js"


def _body() -> str:
    src = TRADER.read_text(encoding="utf-8")
    start = src.index("def signal_quality(")
    end = src.index("def _auto_limit_meta(", start)
    return src[start:end]


def test_engine_weights_are_what_we_think() -> None:
    body = _body()
    checks = {
        "ai agrees": "score += 0.30 * conf",
        "ai against": "score -= 0.30 * max(conf, 0.5)",
        "measured edge": "score += 0.10 * max(0.0, min(1.0, edge))",
        "strategy confidence": "score += 0.10 * max(0.0, min(1.0, float(signal_conf)))",
        "trending regime": "score += 0.05",
        "ranging regime": "score -= 0.08",
        "higher timeframe agrees": "score += 0.12 * strength",
        "higher timeframe against": "score -= 0.18 * max(0.35, strength)",
        "low efficiency": "score -= 0.10",
    }
    for name, needle in checks.items():
        assert needle in body, f"{name}: expected `{needle}` in signal_quality()"
    assert "score = 0.5" in body, "every entry has to start from the midpoint"


def test_desk_publishes_those_weights() -> None:
    desk = DESK.read_text(encoding="utf-8")
    start = desk.index("function qualityHtml(")
    end = desk.index("function switchRow(", 0) if "function switchRow(" in desk[:start] else len(desk)
    block = desk[start:start + 3000]
    for label, shown in [("slots.q_ai", "+30"), ("slots.q_htf", "±18"),
                         ("slots.q_strategy", "+10"), ("slots.q_edge", "+10"),
                         ("slots.q_regime", "±8"), ("slots.q_chop", "−10")]:
        assert label in block, f"{label} is not on the robot page"
        assert shown in block, f"{label} should be published as {shown}"


def test_the_gate_and_the_sizing_are_both_driven_by_it() -> None:
    src = TRADER.read_text(encoding="utf-8")
    assert "if quality < float(getattr(self, \"min_signal_quality\"" in src, \
        "the score must gate the entry"
    assert "factor = 0.6 + 0.4 * max(0.0, min(1.0, (quality - 0.5) / 0.4))" in src, \
        "a bare pass has to trade smaller - the desk says 60% to 100%"
    assert "strength = max(0.0, min(1.0, (float(quality) - 0.5) / 0.4))" in src, \
        "the score must also decide how many tickets"


def test_the_last_verdict_reaches_the_desk() -> None:
    src = TRADER.read_text(encoding="utf-8")
    assert "self.last_quality = {" in src
    assert '"last_quality": dict(getattr(self, "last_quality", {}) or {})' in src, \
        "the verdict has to be published in the snapshot or the desk cannot show it"


TESTS = [
    test_engine_weights_are_what_we_think,
    test_desk_publishes_those_weights,
    test_the_gate_and_the_sizing_are_both_driven_by_it,
    test_the_last_verdict_reaches_the_desk,
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
        except Exception as exc:  # a corrupt file must report, not traceback
            print("FAIL  " + fn.__name__ + " → " + type(exc).__name__ + ": " + str(exc))
            bad += 1
    print("\n%d failing." % bad if bad else "\nWhat the page says is what the engine does.")
    raise SystemExit(1 if bad else 0)
