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
    """The score is a weighted vote, and these are the weights.

    The old arithmetic started at 0.5 and subtracted for what it did not
    know - which is how a fresh install ended up unable to clear its own
    0.55 floor and refused every entry in silence. The rule now is that a
    read with nothing to say does not vote. These assertions pin both
    halves of it, because either one failing brings the silence back.
    """
    body = _body()
    checks = {
        "ai weight": "weight = 0.6 + 0.6 * max(0.0, min(1.0, edge))",
        "ai agrees": "vote(weight, 0.5 + 0.5 * conf,",
        "ai against": "vote(weight, 0.5 - 0.5 * max(conf, 0.5),",
        "strategy confidence": "vote(1.0, float(signal_conf),",
        "higher timeframe agrees": "vote(1.0, 0.5 + 0.5 * max(0.2, strength),",
        "higher timeframe against": "vote(1.0, 0.5 - 0.5 * max(0.35, strength),",
        "trending regime": "vote(0.5, 0.75,",
        "ranging regime": "vote(0.5, 0.3,",
        "low efficiency": "vote(0.5, 0.25 if er < 0.18 else 0.6,",
    }
    for name, needle in checks.items():
        assert needle in body, f"{name}: expected `{needle}` in signal_quality()"
    assert "score = sum(w * v for w, v in votes) / total" in body, \
        "the score has to be the weighted mean of the reads that voted"
    assert "ai still learning (not counted)" in body, \
        "an unready model must cost the trade nothing"
    assert "score = floor" in body, \
        "with nothing to judge by, the score has to pass rather than fail"


def test_an_unready_model_cannot_silence_the_robot() -> None:
    """The exact fault reported from the desk: signals, and never an order."""
    import sys

    sys.path.insert(0, str(ROOT / "engine"))
    from aurion.runtime.trader import Trader

    t = Trader.__new__(Trader)
    t.min_signal_quality = 0.55
    t._higher_tf_bias = lambda symbol: ("neutral", 0.0)
    t._higher_timeframe = lambda: "M15"

    class _Models:
        metrics: dict = {}

    class _AI:
        last = {"ready": False, "confidence": 0.0, "direction": "neutral"}
        by_symbol: dict = {}
        models = _Models()

    t.ai = _AI()
    verdict = t.signal_quality("EURUSD", "buy", 0.72)
    assert verdict["score"] >= 0.55, "a confident strategy with a cold model must still pass"
    assert any("still learning" in r for r in verdict["reasons"])


def test_desk_publishes_those_weights() -> None:
    desk = DESK.read_text(encoding="utf-8")
    start = desk.index("function qualityHtml(")
    block = desk[start:start + 3000]
    for label, shown in [("slots.q_ai", "\u00d71.2"), ("slots.q_htf", "\u00d71.0"),
                         ("slots.q_strategy", "\u00d71.0"),
                         ("slots.q_regime", "\u00d70.5"), ("slots.q_chop", "\u00d70.5")]:
        assert label in block, f"{label} is not on the robot page"
        assert shown in block, f"{label} should be published as {shown}"


def test_the_desk_shows_why_the_last_signal_was_not_sent() -> None:
    """"Why is it not trading" has to be answerable from the screen."""
    desk = DESK.read_text(encoding="utf-8")
    assert "function blockHtml(" in desk
    assert "${blockHtml(st)}" in desk, "the panel has to be rendered, not just defined"
    src = TRADER.read_text(encoding="utf-8")
    assert "self.last_block = {" in src
    assert '"last_block": dict(getattr(self, "last_block", {}) or {})' in src, \
        "the refusal has to reach the snapshot or the desk cannot show it"
    # "low_quality" is no longer among them: the quality floor stopped
    # refusing entries (see test_the_score_sizes_rather_than_refuses
    # below for the measurement). Every refusal that remains still has
    # to leave a named record, or "why is it not trading" comes back.
    for code in ("spread", "slots_full", "ai_low", "ai_disagree", "license"):
        assert f'"{code}"' in src, f"{code} must go through the one recorder"


def test_the_score_sizes_rather_than_refuses() -> None:
    """The score used to do two jobs; it now does one of them.

    Named "the gate and the sizing are both driven by it" until the
    gate was taken out on request, and the gate half was measured
    before it went. A/B over a seeded synthetic market, 8 markets x 3
    built-ins, 2 837 priced trades, split on the strategy's own
    confidence against the 0.55 floor - which is what signal_quality
    returns on a fresh install, where the model is still learning and
    the slower chart has not voted:

        everything             n=2837  win 45.4%  PF 1.15  +0.0580R
        the floor allowed      n=2756  win 45.5%  PF 1.14  +0.0568R
        the floor refused      n=  81  win 43.2%  PF 1.33  +0.0990R

    2.9% of entries refused, and no evidence they deserved it.

    The sizing half measured the other way and is kept. Confidence
    predicts return across its range - six bands at -0.040R, -0.021R,
    -0.000R, +0.138R, +0.093R, +0.178R - and at the same average size
    the quality-weighted lot returned +156.4R against +135.8R flat.
    Costs are not modelled; see backtest/engine.py.
    """
    src = TRADER.read_text(encoding="utf-8")
    assert "if quality < float(getattr(self, \"min_signal_quality\"" not in src, \
        "the quality floor is refusing entries again - it was removed on request, " \
        "and the A/B is in the comment beside the spread guard"
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
    test_an_unready_model_cannot_silence_the_robot,
    test_desk_publishes_those_weights,
    test_the_desk_shows_why_the_last_signal_was_not_sent,
    test_the_score_sizes_rather_than_refuses,
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
