"""A replay should not get slower the longer it runs.

The desk's backtest was quadratic. Each bar the replay handed the AI
the whole history up to that point, and the AI built its feature frame
from whatever list it was given -- so the frame was rebuilt from the
first bar on every single bar. Profiled on 500 tested bars of real
EURUSD M15, 48 of 61 seconds went into that one call, and the cost grew
with the square of the window being tested.

infer() reads only the last row of that frame, and every feature in it
is causal: EMAs, backward rolling windows and shift(1), never a centred
window. So the frame can be built once for the whole series and the row
for each bar handed over as the replay reaches it.

What has to stay true is that this changes nothing but the time taken,
so these checks are about equivalence and about the mapping between a
bar and its row -- not about the clock. Timing assertions would be
flaky on a shared machine; instead the number of times the expensive
call happens is counted, which is the thing that actually changed.
"""

from __future__ import annotations

from typing import Any

import pytest

import aurion.ai.engine as ai_engine
import aurion.backtest.engine as bt_engine
from aurion.ai.engine import AIEngine
from aurion.ai.features import build_feature_frame
from aurion.backtest.engine import Backtester


def bars(n: int = 500, start: float = 1000.0) -> list[dict[str, Any]]:
    """A wandering series with real-looking, parseable timestamps.

    The stamps matter: rows are matched to bars by time, so a fixture
    with unusable stamps would test the fallback instead of the fix.
    """
    out = []
    px = start
    for i in range(n):
        px += ((i * 7919) % 23 - 11) * 0.35
        o = px
        c = px + ((i * 104729) % 17 - 8) * 0.22
        out.append({
            "time": f"2026-01-{1 + i // 1440:02d}T{(i // 60) % 24:02d}:{i % 60:02d}:00",
            "open": round(o, 5),
            "high": round(max(o, c) + 1.4, 5),
            "low": round(min(o, c) - 1.4, 5),
            "close": round(c, 5),
            "volume": 100 + (i % 50),
        })
    return out


class Cross:
    """Trades off a plain moving-average comparison, so it reacts to the
    AI state only through the context it is handed."""

    name = "cross"
    params: dict[str, Any] = {}

    def on_start(self, ctx) -> None:
        return None

    def on_candle(self, ctx):
        c = [float(x["close"]) for x in ctx.candles[-40:]]
        if len(c) < 40:
            return None
        fast = sum(c[-10:]) / 10
        slow = sum(c) / len(c)
        price = c[-1]
        pos = ctx.positions[0] if ctx.positions else None
        if fast > slow * 1.001 and not pos:
            return {"action": "buy", "volume": 0.2, "sl": price * 0.97, "tp": price * 1.05}
        if fast < slow * 0.999 and pos:
            return {"action": "close", "reason": "cross back"}
        return None


def fingerprint(res: dict[str, Any]) -> list[tuple]:
    return [
        (t["time"], t["type"], round(float(t["entry"]), 8), round(float(t["profit"]), 8),
         t["exit_reason"], round(float(t.get("risk") or 0), 8))
        for t in res["trades"]
    ]


def run(data, **kw):
    return Backtester().run(Cross(), data, "XAUUSD", "M15", 10_000.0, 100.0, 120, None, None, **kw)


# ------------------------------------------------ the frame is hoisted ---

def test_the_feature_frame_is_built_once_not_once_per_bar(monkeypatch):
    calls = {"n": 0}
    real = bt_engine.build_feature_frame

    def counted(rows):
        calls["n"] += 1
        return real(rows)

    monkeypatch.setattr(bt_engine, "build_feature_frame", counted)
    data = bars(500)
    res = run(data)
    assert res["ok"]
    # Once for the whole series. Not once per tested bar, which is what
    # made a long window cost so much more than a short one.
    assert calls["n"] == 1, f"the feature frame was rebuilt {calls['n']} times"


def test_the_ai_is_never_asked_to_rebuild_what_it_was_handed(monkeypatch):
    rebuilt = {"n": 0}
    real = ai_engine.build_feature_frame

    def counted(rows):
        rebuilt["n"] += 1
        return real(rows)

    monkeypatch.setattr(ai_engine, "build_feature_frame", counted)
    res = run(bars(500))
    assert res["ok"]
    assert rebuilt["n"] == 0, "the AI rebuilt the frame despite being given the row"


def test_the_pattern_detector_is_not_handed_the_whole_history(monkeypatch):
    seen: list[int] = []
    real = ai_engine.detect

    def counted(rows):
        seen.append(len(rows))
        return real(rows)

    monkeypatch.setattr(ai_engine, "detect", counted)
    run(bars(500))
    assert seen, "the detector was never called"
    # It reads three bars, and eight closes for its structure check.
    assert max(seen) <= AIEngine.PATTERN_BARS


def test_the_shortened_window_still_finds_the_same_pattern():
    """Capping the detector's input must be an optimisation, not a change.

    Bounding it at all is only safe while the window stays wider than
    the furthest thing the detector looks back at -- the eight closes of
    its higher-highs/lower-lows check. Asserting only that the window is
    small would be satisfied by a window too small to work, so the
    reading itself is compared against the uncapped one.
    """
    from aurion.ai.patterns import detect

    data = bars(400)
    checked = 0
    for end in range(60, len(data), 7):
        window = data[:end]
        full = detect(window)
        capped = detect(window[-AIEngine.PATTERN_BARS:])
        assert full == capped, (
            f"at bar {end} the capped detector reads {capped.get('name')} "
            f"where the full history reads {full.get('name')}"
        )
        checked += 1
        if full.get("name") not in ("", "none"):
            checked += 1000          # at least one real pattern was compared
    assert checked > 1000, "the fixture never produced a pattern to compare"


# ------------------------------------------------------ nothing changed ---

def test_the_hoist_changes_no_trade():
    data = bars(600)
    fast = run(data)
    slow_bt = Backtester()
    slow_bt._precompute_features = lambda b: None      # force the old path
    slow = slow_bt.run(Cross(), data, "XAUUSD", "M15", 10_000.0, 100.0, 120, None, None)
    assert fast["ok"] and slow["ok"]
    assert fingerprint(fast) == fingerprint(slow)
    assert fast["metrics"] == slow["metrics"]


def test_a_single_row_is_enough_for_the_ai():
    """infer() must give the same reading from one row as from the lot."""
    data = bars(400)
    frame = build_feature_frame(data)
    assert not frame.empty
    brain_a, brain_b = AIEngine(), AIEngine()
    whole = brain_a.infer(data, "XAUUSD", "M15")
    one = brain_b.infer(data, "XAUUSD", "M15", frame=frame.iloc[[-1]])
    for key in ("direction", "confidence", "regime", "hint", "pattern"):
        assert whole.get(key) == one.get(key), f"{key} differs when only the last row is given"


# -------------------------------------------- rows are matched by time ---

def test_a_bar_is_matched_to_its_own_feature_row():
    # build_feature_frame drops its indicator warmup and reindexes, so
    # row i is not bar i. Matching by position would hand the AI the
    # features of a different bar -- a mistake that would quietly make
    # every backtest look better than it is.
    data = bars(400)
    feats = Backtester()._precompute_features(data)
    assert feats is not None
    frame, _index = feats
    assert len(frame) < len(data), "this fixture no longer exercises the offset"
    for i in (200, 300, 399):
        row = Backtester()._feature_row(feats, i, data)
        assert row is not None
        assert str(row["time"].iloc[0]) == data[i]["time"]


def test_warmup_bars_have_no_row_and_say_so():
    data = bars(400)
    feats = Backtester()._precompute_features(data)
    assert Backtester()._feature_row(feats, 0, data) is None


@pytest.mark.parametrize("i", [-1, 10_000])
def test_an_out_of_range_bar_is_not_guessed_at(i):
    data = bars(200)
    feats = Backtester()._precompute_features(data)
    assert Backtester()._feature_row(feats, i, data) is None


# ----------------------------------------------- the fallback is intact ---

def test_duplicate_timestamps_fall_back_rather_than_mismatch():
    # Two bars with the same stamp cannot be told apart, so the mapping
    # has to refuse rather than pick one.
    data = bars(400)
    for d in data:
        d["time"] = "2026-01-01T00:00:00"
    assert Backtester()._precompute_features(data) is None


def test_bars_without_timestamps_fall_back():
    data = bars(400)
    for d in data:
        d.pop("time")
    assert Backtester()._precompute_features(data) is None


def test_the_fallback_still_produces_a_run():
    data = bars(400)
    for d in data:
        d["time"] = "2026-01-01T00:00:00"
    res = run(data)
    assert res["ok"], "a run with unusable stamps must still complete"


def test_too_little_history_to_build_features_is_not_fatal():
    assert Backtester()._precompute_features(bars(10)) is None
    assert Backtester()._precompute_features([]) is None


def test_a_broken_feature_build_does_not_stop_the_run(monkeypatch):
    def angry(rows):
        raise RuntimeError("pandas fell over")

    monkeypatch.setattr(bt_engine, "build_feature_frame", angry)
    res = run(bars(400))
    assert res["ok"], "the replay must survive the optimisation failing"
