"""The live analysis is pushed on the bus, not waited for by the poll.

The desk's Intelligence card reads snapshot["analysis"], and for a long
time the only thing that ever produced that was the ten-second
/api/snapshot poll. The panel labelled "live" therefore moved in visible
ten-second steps. These tests pin the push that replaced it:

  * it reaches the bus at all, under the "analysis" topic;
  * it does NOT fire on every tick when nothing changed;
  * it DOES fire when the reading actually changes;
  * the clock advancing on its own is not a change.

That last one is the subtle one. The payload carries timestamps and a
"in about 2m 1s" countdown, so a naive equality check is never equal and
the throttle degenerates into "publish constantly" - which also makes the
desk's "updated N seconds ago" stamp permanently read "just now".
"""

import asyncio

import pytest

from aurion.runtime.trader import Trader


TICK = {"symbol": "EURUSD", "bid": 1.1, "ask": 1.1001}


def _trader():
    t = Trader()
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    sent: list[dict] = []
    t.bus.subscribe("analysis", lambda topic, payload: sent.append(payload))
    return t, sent


def test_analysis_is_published_on_a_tick():
    async def go():
        t, sent = _trader()
        await t._route_bridge("tick", dict(TICK))
        return sent

    sent = asyncio.run(go())
    assert len(sent) == 1
    assert "action" in sent[0] and "ai" in sent[0]
    # The bus wraps a payload that has no top-level "type" as
    # {"type": topic, "data": payload}; the desk relies on msg.data.
    assert "type" not in sent[0]


def test_unchanged_state_does_not_republish_on_every_tick():
    async def go():
        t, sent = _trader()
        for _ in range(30):
            await t._route_bridge("tick", dict(TICK))
        return sent

    sent = asyncio.run(go())
    assert len(sent) == 1, f"30 ticks on identical state published {len(sent)} times"


def test_the_clock_alone_is_not_a_change():
    """Real elapsed time, no state change, must stay silent."""

    async def go():
        t, sent = _trader()
        await t._route_bridge("tick", dict(TICK))
        baseline = len(sent)
        for _ in range(4):
            await asyncio.sleep(0.8)  # longer than ANALYSIS_PUSH_SECONDS
            await t._route_bridge("tick", dict(TICK))
        return len(sent) - baseline

    assert asyncio.run(go()) == 0


def test_a_real_change_is_published():
    async def go():
        t, sent = _trader()
        await t._route_bridge("tick", dict(TICK))
        baseline = len(sent)
        t.auto_trade = not t.auto_trade
        await asyncio.sleep(Trader.ANALYSIS_PUSH_SECONDS + 0.1)
        await t._route_bridge("tick", dict(TICK))
        return len(sent) - baseline

    assert asyncio.run(go()) == 1


def test_force_bypasses_the_throttle():
    """The AI publish forces a push so the two cannot disagree on screen."""

    async def go():
        t, sent = _trader()
        await t._push_analysis()
        baseline = len(sent)
        await t._push_analysis(force=True)
        return len(sent) - baseline

    assert asyncio.run(go()) == 1


def test_signature_ignores_only_clock_fields():
    t = Trader()
    sig = t._analysis_signature
    base = {"reason": "x", "ts": "1", "next_eval": {"in_seconds": 9, "text": "9s"}}
    moved = {"reason": "x", "ts": "2", "next_eval": {"in_seconds": 8, "text": "8s"}}
    changed = {"reason": "y", "ts": "1", "next_eval": {"in_seconds": 9, "text": "9s"}}
    assert sig(base) == sig(moved), "a moving clock must not read as new analysis"
    assert sig(base) != sig(changed), "a changed reason must read as new analysis"


def test_signature_still_sees_nested_console_text():
    """Stripping must not be so eager that it hides real content.

    "text" is a generic key - the countdown uses it, but so does every
    console line. Dropping it everywhere would silence the journal.
    """
    t = Trader()
    a = {"console": [{"text": "waiting"}], "ts": "1"}
    b = {"console": [{"text": "entered long"}], "ts": "1"}
    assert t._analysis_signature(a) != t._analysis_signature(b)


def test_push_survives_a_broken_analysis():
    """A failure to build the analysis must never kill the tick route."""

    async def go():
        t, sent = _trader()
        t.analysis = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        await t._route_bridge("tick", dict(TICK))  # must not raise
        return sent

    asyncio.run(go())


@pytest.mark.parametrize("field", ["ts", "utc", "in_seconds", "next_eval"])
def test_every_declared_clock_field_is_actually_ignored(field):
    t = Trader()
    a = {"reason": "x", field: "a"}
    b = {"reason": "x", field: "b"}
    assert t._analysis_signature(a) == t._analysis_signature(b)
