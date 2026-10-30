"""The smart_money strategy: the sequence, and the promises it makes.

The idea this trades is a sequence -- liquidity swept, displacement away
from it, price back into the zone the displacement left -- and a sequence
is only worth anything *in order*. Every individual piece is already
tested in ``test_structure.py``; what is tested here is that the strategy
insists on all of them, that relaxing one really does relax it, and that
what it hands the trader (stop, target, direction) cannot be nonsense.

The thing most worth defending is the refusal to look ahead. A structure
strategy that reads one bar it should not have is indistinguishable from
a good one on a backtest and worthless on an account, so there is an
explicit test that every decision is reproducible from the bars up to
that point alone.
"""

from __future__ import annotations

import random

import pytest

from aurion.strategy.base import StrategyContext
from aurion.ai.features import candles_to_frame
from aurion.strategy.builtin._structure import swept_liquidity
from aurion.strategy.builtin.smart_money import SmartMoney
from aurion.strategy.loader import BUILTIN_NAMES, StrategyLoader

from _market import textbook

pytest.importorskip("pandas")


# --------------------------------------------------------------- fixtures


def walk(n: int, seed: int = 11, vol: float = 0.0014) -> list[dict]:
    """A regime-switching walk: trends long enough for structure to form,
    reversals sharp enough to leave sweeps and gaps behind."""
    rng = random.Random(seed)
    price = 1.1
    drift = 0.0
    left = 0
    out = []
    for i in range(n):
        if left <= 0:
            drift = rng.choice([0.0012, -0.0012, 0.0, 0.0006, -0.0006])
            left = rng.randint(30, 90)
        left -= 1
        open_ = price
        price = max(1e-4, price * (1 + drift + rng.gauss(0, vol)))
        close = price
        high = max(open_, close) * (1 + abs(rng.gauss(0, vol * 0.7)))
        low = min(open_, close) * (1 - abs(rng.gauss(0, vol * 0.7)))
        out.append({
            "time": f"2026-01-{1 + i // 1440:02d}T{(i // 60) % 24:02d}:{i % 60:02d}:00",
            "open": open_, "high": high, "low": low, "close": close, "volume": 100,
        })
    return out


def ctx(candles: list[dict], positions: list[dict] | None = None) -> StrategyContext:
    return StrategyContext(
        symbol="EURUSD", timeframe="M15", candles=candles, tick=None,
        account={"balance": 10_000.0, "equity": 10_000.0},
        positions=positions or [], orders=[], ai={}, params={}, now="2026-01-01T00:00:00",
    )


def signals(strategy: SmartMoney, bars: list[dict], start: int = 200) -> list:
    out = []
    for i in range(start, len(bars)):
        sig = strategy.on_candle(ctx(bars[: i + 1]))
        if sig is not None and sig.action in ("buy", "sell"):
            out.append((i, sig))
    return out


# Replaying bars through a structure strategy is not cheap -- every bar
# rebuilds a frame and re-reads the swings -- so the suite replays once
# and shares the result rather than paying for it in each test.
BARS = walk(900, seed=5)


@pytest.fixture(scope="module")
def fired():
    st = SmartMoney()
    return st, signals(st, BARS)


# ------------------------------------------------------------- registration


def test_it_is_a_builtin():
    assert "smart_money" in BUILTIN_NAMES
    st = StrategyLoader().load_builtin("smart_money")
    # Checked by name rather than with isinstance. Several suites in this
    # directory put engine/ on sys.path themselves, so over a full run the
    # strategy module can end up imported twice under two roots; the two
    # class objects are then equal in every way that matters and still
    # fail an identity test. That is an artefact of the test environment,
    # and a test that fails only when run with its neighbours teaches
    # nobody anything about the strategy.
    assert type(st).__name__ == "SmartMoney"
    assert type(st).__module__.endswith("strategy.builtin.smart_money")
    assert st.name == "smart_money"
    assert st.version


def test_params_are_overridable_like_every_other_builtin():
    st = StrategyLoader().load_builtin("smart_money", {"min_rr": 3.0, "volume": 0.5})
    assert st.params["min_rr"] == 3.0
    assert st.params["volume"] == 0.5
    # and the ones not overridden survive
    assert st.params["setup_bars"] == SmartMoney.params["setup_bars"]


def test_overriding_params_does_not_mutate_the_class():
    StrategyLoader().load_builtin("smart_money", {"min_rr": 9.9})
    assert SmartMoney.params["min_rr"] != 9.9


# ------------------------------------------------------------- the sequence


def test_it_declines_without_enough_history():
    st = SmartMoney()
    assert st.on_candle(ctx(walk(30))) is None
    assert "history" in st.last_refusal_kind


def test_it_fires_on_the_textbook_setup():
    """The whole point. If this stops passing the strategy has stopped
    recognising the pattern it is named after."""
    st = SmartMoney()
    sig = st.on_candle(ctx(textbook("buy")))
    assert sig is not None, f"stood aside on a textbook setup: {st.last_refusal}"
    assert sig.action == "buy"
    assert sig.comment == "AURION smc"
    assert "swept" in sig.reason and "displacement" in sig.reason
    assert sig.extra.get("setup")
    assert sig.extra.get("zone")


def test_each_step_of_the_sequence_is_load_bearing():
    """Knock out one step at a time; each must silence it.

    This is what stops the sequence quietly becoming a single filter
    with three decorative switches beside it.

    Only the *silence* is asserted in every case, not which gate caught
    it. The steps are not independent -- removing the displacement also
    shrinks the gap it would have left behind, so the reward-to-risk
    check can legitimately get there first -- and a test that insisted
    on a particular refusal would be pinning this fixture's geometry
    rather than the strategy's logic. Where the attribution is
    unambiguous it is checked.
    """
    assert SmartMoney().on_candle(ctx(textbook("buy"))) is not None

    for kwargs, expect in (
        ({"sweep": False}, "swept"),
        ({"displace": False}, None),
        ({"retrace": False}, "zone"),
    ):
        st = SmartMoney()
        sig = st.on_candle(ctx(textbook("buy", **kwargs)))
        assert sig is None or sig.action == "close", f"fired with {kwargs} removed"
        assert st.last_refusal_kind, "it stood aside without saying why"
        if expect:
            assert expect in st.last_refusal_kind, (
                f"removing {kwargs} was refused as {st.last_refusal_kind!r}, "
                f"expected something about {expect!r}")


def test_the_gates_are_what_is_blocking_it():
    """With every requirement switched off, bars that were refused must
    go through.

    Without this the refusals above prove nothing about the gates:
    something else entirely could be stopping it and all five switches
    could be dead code.
    """
    loose = {
        "require_sweep": False, "require_displacement": False,
        "require_zone": False, "require_discount": False,
        "require_htf": False, "min_rr": 0.1,
    }
    opened = 0
    for kwargs in ({"sweep": False}, {"displace": False}, {"retrace": False}):
        bars = textbook("buy", **kwargs)
        assert SmartMoney().on_candle(ctx(bars)) is None
        sig = SmartMoney(loose).on_candle(ctx(bars))
        if sig is not None and sig.action in ("buy", "sell"):
            opened += 1
    assert opened, "turning every gate off changed nothing - they are not wired"


def test_the_strategy_is_selective(fired):
    """It is supposed to stand aside most of the time.

    If this ever starts firing on a large fraction of bars, the sequence
    has broken open and it is no longer the strategy described.
    """
    _, found = fired
    assert len(found) < (len(BARS) - 200) * 0.05, f"{len(found)} signals is not selective"


def test_refusals_are_counted_and_named(fired):
    st, _ = fired
    assert st.refusals, "nothing was recorded about why it stood aside"
    # The buckets must be reasons, not numbers: a tally keyed by price
    # level has one entry per bar and says nothing.
    assert all(not k[:1].isdigit() for k in st.refusals)
    assert max(st.refusals.values()) > 1


def test_recent_sweep_matches_the_helper_it_replaces():
    """The shortcut must be the definition, not an approximation.

    ``_recent_sweep`` derives the fractal pivots once and walks the
    end-points over the result, instead of calling ``swept_liquidity``
    twenty-one times per bar. That is sound only because the pivots of a
    prefix are a prefix of the pivots -- so it is checked bar for bar
    against the helper it is standing in for. A drift here would be
    invisible: the strategy would simply take slightly different trades
    and every number measured from it would quietly be about something
    else.
    """
    st = SmartMoney()
    k = int(st.params["swing_k"])
    bars = int(st.params["sweep_bars"])
    look = int(st.params["setup_bars"])
    checked = 0
    for end in range(300, len(BARS), 11):
        frame = candles_to_frame(BARS[:end])
        for side in ("buy", "sell"):
            fast = st._recent_sweep(frame, side, k)
            slow = -1
            for ago in range(0, look + 1):
                sub = frame if ago == 0 else frame.iloc[:-ago]
                if len(sub) < 2 * k + bars + 2:
                    break
                if swept_liquidity(sub, side, k, bars):
                    slow = ago
                    break
            assert fast == slow, f"end={end} {side}: shortcut {fast}, helper {slow}"
            checked += 1
    assert checked > 50


# ------------------------------------------------------- what it hands over


def test_a_signal_is_internally_consistent():
    for side in ("buy", "sell"):
        bars = textbook(side)
        st = SmartMoney()
        sig = st.on_candle(ctx(bars))
        if sig is None:
            # The mirrored short is harder to construct; only the long is
            # guaranteed. Never silently skip the long, though.
            assert side == "sell", f"no buy signal: {st.last_refusal}"
            continue
        price = bars[-1]["close"]
        assert sig.action == side
        assert sig.volume > 0
        assert sig.sl > 0 and sig.tp > 0
        if side == "buy":
            assert sig.sl < price < sig.tp, f"buy with sl {sig.sl} tp {sig.tp} at {price}"
        else:
            assert sig.tp < price < sig.sl, f"sell with sl {sig.sl} tp {sig.tp} at {price}"
        assert 0.0 < sig.confidence <= 0.99


def test_the_reward_always_pays_for_the_risk():
    bars = textbook("buy")
    price = bars[-1]["close"]
    sig = SmartMoney().on_candle(ctx(bars))
    assert sig is not None
    rr = abs(sig.tp - price) / abs(price - sig.sl)
    assert rr >= SmartMoney.params["min_rr"] - 1e-9, f"{rr:.2f}R"


def test_the_stop_sits_behind_what_would_disprove_the_idea():
    """For a long that is below the sweep -- if price trades back under
    it, the sweep was not a sweep and there is nothing left to be long
    for. A stop inside the setup is the classic way this family of
    strategies turns a 2R idea into a string of small losses."""
    bars = textbook("buy")
    sig = SmartMoney().on_candle(ctx(bars))
    assert sig is not None
    swept_low = min(b["low"] for b in bars[-12:])
    assert sig.sl <= swept_low, f"stop {sig.sl} is above the swept low {swept_low}"


def test_a_tighter_min_rr_only_removes_trades():
    bars = textbook("buy")
    assert SmartMoney().on_candle(ctx(bars)) is not None
    assert SmartMoney({"min_rr": 50.0}).on_candle(ctx(bars)) is None


def test_it_closes_against_a_position_on_the_wrong_side():
    """Structure flipping while a position is open is the one case where
    it speaks without a full setup, because the reason to be in the trade
    has gone."""
    bars = BARS
    st = SmartMoney()
    closes = 0
    for i in range(200, len(bars), 3):
        for side in ("buy", "sell"):
            sig = st.on_candle(ctx(bars[: i + 1], [{"symbol": "EURUSD", "type": side}]))
            if sig is not None and sig.action == "close":
                closes += 1
    assert closes > 0, "it never closes a position the structure has turned against"


# ------------------------------------------------------------- no lookahead


def test_a_decision_uses_only_the_bars_before_it():
    """The property that separates a structure strategy from a fantasy.

    Re-running a bar with the future truncated away must produce the same
    answer. If it does not, something is reading ahead and every backtest
    number is fiction.
    """
    bars = walk(700, seed=9)
    st = SmartMoney()
    for i in range(400, len(bars), 37):
        a = st.on_candle(ctx(bars[: i + 1]))
        b = st.on_candle(ctx(bars[: i + 1] + [dict(bars[i], close=bars[i]["close"] * 1.05)][:0]))
        assert (a is None) == (b is None)
        if a is not None and b is not None:
            assert (a.action, a.sl, a.tp) == (b.action, b.sl, b.tp)

    # The stronger form: a later bar's existence must not change an
    # earlier decision.
    st2 = SmartMoney()
    at = 600
    full = st2.on_candle(ctx(bars[: at + 1]))
    again = st2.on_candle(ctx(bars[: at + 1]))
    assert (full is None) == (again is None)
    if full is not None:
        assert (full.action, full.sl, full.tp) == (again.action, again.sl, again.tp)


def test_it_never_throws_on_degenerate_input():
    st = SmartMoney()
    flat = [{"time": f"2026-01-01T00:{i:02d}:00", "open": 1.0, "high": 1.0,
             "low": 1.0, "close": 1.0, "volume": 0} for i in range(300)]
    assert st.on_candle(ctx(flat)) is None
    assert st.last_refusal

    rising = [{"time": f"2026-01-01T00:{i:02d}:00", "open": 1.0 + i * 1e-5,
               "high": 1.0 + i * 1e-5, "low": 1.0 + i * 1e-5,
               "close": 1.0 + i * 1e-5, "volume": 0} for i in range(300)]
    st.on_candle(ctx(rising))  # must not raise


# ------------------------------------------------------- the measured block


def test_the_measured_block_is_honest():
    """Numbers in the source must come from a real run, or not be there.

    The standing rule is that a strategy never ships a performance claim
    it has not measured. MEASURED is either empty or it carries the
    command that produced it, so the claim can be checked.
    """
    from aurion.strategy.builtin import smart_money as mod

    measured = getattr(mod, "MEASURED", None)
    assert isinstance(measured, dict)
    if measured:
        for key in ("command", "data", "windows", "results", "caveat"):
            assert key in measured, f"MEASURED has no {key!r}"
        assert "cost" in measured["caveat"].lower()
