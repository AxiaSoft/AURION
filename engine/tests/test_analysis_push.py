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


# --------------------------------------------------------------------
# The loop. Ticks are not a heartbeat.
#
# The push was first driven only from _route_bridge("tick"), and ticks
# come from exactly one place: an attached MT5 EA. So the "live"
# analysis was frozen whenever there was no EA, the market was shut, or
# the EA was not watching that symbol - and the card silently fell back
# to the ten-second snapshot poll. The loop is what makes the guarantee
# independent of anything feeding us.
# --------------------------------------------------------------------


def test_the_loop_publishes_a_change_with_no_ticks_at_all():
    async def go():
        t, sent = _trader()
        t._analysis_stop = asyncio.Event()
        task = asyncio.create_task(t._analysis_loop())
        await asyncio.sleep(0.6)                 # settle the first reading
        baseline = len(sent)
        t.auto_trade = not t.auto_trade          # never route a tick
        for _ in range(100):
            if len(sent) > baseline:
                break
            await asyncio.sleep(0.01)
        t._analysis_stop.set()
        task.cancel()
        try:
            await task
        except Exception:
            pass
        return len(sent) - baseline

    assert asyncio.run(go()) == 1


def test_the_loop_is_silent_while_nothing_changes():
    async def go():
        t, sent = _trader()
        t._analysis_stop = asyncio.Event()
        task = asyncio.create_task(t._analysis_loop())
        await asyncio.sleep(0.6)
        baseline = len(sent)
        await asyncio.sleep(1.5)                 # many loop turns
        t._analysis_stop.set()
        task.cancel()
        try:
            await task
        except Exception:
            pass
        return len(sent) - baseline

    assert asyncio.run(go()) == 0, "an idle engine must not stream the same card forever"


def test_the_cadence_is_under_a_second():
    """A trader asked for 'in the moment'. Keep it honest.

    One analysis is ~0.4ms of in-memory state, so there is no cost
    argument for letting this drift back up to seconds.
    """
    assert Trader.ANALYSIS_LOOP_SECONDS <= 0.5
    assert Trader.ANALYSIS_PUSH_SECONDS <= 0.5


def test_a_raising_push_does_not_kill_the_loop():
    """One bad reading must not silently end live updates for the session."""

    async def go():
        t, sent = _trader()
        boom = {"n": 0}

        async def bad(force=False):
            boom["n"] += 1
            raise RuntimeError("nope")

        t._push_analysis = bad
        t._analysis_stop = asyncio.Event()
        task = asyncio.create_task(t._analysis_loop())
        await asyncio.sleep(0.8)
        alive = not task.done()
        t._analysis_stop.set()
        task.cancel()
        try:
            await task
        except Exception:
            pass
        return alive, boom["n"]

    alive, calls = asyncio.run(go())
    assert alive, "the loop died on the first failure"
    assert calls > 1, "it stopped retrying"


def test_start_actually_wires_the_loop():
    """The loop is useless if nothing ever starts it.

    Checked against the source because reaching this through start()
    would need a broker bridge, a licence and a Telegram token.
    """
    import inspect

    src = inspect.getsource(Trader.start)
    assert "_analysis_loop" in src, "start() never launches the analysis loop"
    assert "create_task" in src


def test_stop_cancels_the_loop():
    """A task left running would keep a stopped engine alive."""
    import inspect

    src = inspect.getsource(Trader.stop)
    assert "_analysis_stop" in src and "_analysis_task" in src


# --------------------------------------------------------------------
# One analysis per watched chart.
#
# The desk puts the direction slider above the live analysis and steps
# both with the same arrows, so the engine has to describe every symbol
# the slider can land on - not just the active one.
# --------------------------------------------------------------------


class _Agent:
    def __init__(self, symbol):
        self.symbol = symbol


def _with_agents(t, symbols):
    t.bridge.public_agents = lambda: [_Agent(s) for s in symbols]


def test_every_watched_symbol_is_analysed():
    t, _ = _trader()
    _with_agents(t, ["EURUSD", "GBPUSD", "XAUUSD"])
    by = t._analysis_by_symbol()
    assert set(by) == {"EURUSD", "GBPUSD", "XAUUSD"}
    for sym, a in by.items():
        assert a["symbol"] == sym, "an analysis was filed under the wrong symbol"


def test_the_slider_can_never_land_on_an_unanalysed_symbol():
    """_watched_symbols must match what the desk's slider walks."""
    t, _ = _trader()
    _with_agents(t, ["GBPUSD", "XAUUSD"])
    t.active_symbol = "EURUSD"          # active but no chart attached
    syms = t._watched_symbols()
    assert "EURUSD" in syms, "the active symbol dropped out of the slider set"
    assert set(syms) == {"EURUSD", "GBPUSD", "XAUUSD"}


def test_duplicate_charts_are_collapsed():
    """Two charts on one symbol are one slide, so one analysis."""
    t, _ = _trader()
    _with_agents(t, ["EURUSD", "EURUSD", "GBPUSD"])
    assert t._watched_symbols().count("EURUSD") == 1


def test_the_symbol_count_is_capped():
    t, _ = _trader()
    _with_agents(t, [f"SYM{i}" for i in range(40)])
    assert len(t._watched_symbols()) == Trader.ANALYSIS_SYMBOL_CAP


def test_one_broken_symbol_does_not_lose_the_others():
    t, _ = _trader()
    _with_agents(t, ["EURUSD", "GBPUSD"])
    real = t.analysis

    def flaky(symbol="", strategy=""):
        if symbol == "EURUSD":
            raise RuntimeError("boom")
        return real(symbol, strategy)

    t.analysis = flaky
    by = t._analysis_by_symbol()
    assert "GBPUSD" in by and "EURUSD" not in by


def test_no_agents_still_describes_the_active_symbol():
    t, _ = _trader()
    _with_agents(t, [])
    by = t._analysis_by_symbol()
    assert set(by) == {"EURUSD"}


def test_the_push_carries_the_map():
    async def go():
        t, sent = _trader()
        _with_agents(t, ["EURUSD", "GBPUSD"])
        await t._push_analysis(force=True)
        return sent[-1]

    payload = asyncio.run(go())
    assert "by_symbol" in payload
    assert set(payload["by_symbol"]) == {"EURUSD", "GBPUSD"}
    # the top level is still the active symbol's own analysis
    assert payload["symbol"] == "EURUSD"


def test_a_change_on_a_watched_symbol_is_a_change():
    """A non-active symbol moving must still reach the desk.

    The signature is taken over the whole payload including the map, so
    a trader parked on slide 2 sees it update.
    """
    t, _ = _trader()
    _with_agents(t, ["EURUSD", "GBPUSD"])
    a = t._analysis_signature({"by_symbol": {"GBPUSD": {"reason": "x"}}})
    b = t._analysis_signature({"by_symbol": {"GBPUSD": {"reason": "y"}}})
    assert a != b
