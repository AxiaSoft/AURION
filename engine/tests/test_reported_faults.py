"""Faults reported from a live desk, each pinned so it cannot come back.

Three unrelated complaints with three unrelated causes:

  * "analysis unavailable" in the terminal - the live-analysis read
    referred to a variable that was assigned twenty lines further down,
    so every call raised NameError. It was swallowed by the method whose
    whole job is to keep a reporting read from breaking the snapshot,
    which is why it showed up as one quiet log line rather than a crash.

  * The open-trade cap said one and the robot opened two. The cap was
    measured against live MetaTrader positions only, so an order resting
    at a price and an entry still on the wire both counted as nothing.

  * The stop on a manual ticket was so tight it was hit immediately. The
    money cap was read against a full 1.00 lot whatever the ticket's
    actual size, making it a hundred times tighter than the trader's own
    setting on the 0.01-lot tickets they were sending.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.risk import (  # noqa: E402
    REFERENCE_LOT,
    SymbolSpec,
    money_at_risk,
    protective_stop,
)
from aurion.runtime.stops import ladder_milestones, ladder_target  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402


# --------------------------------------------------------------- analysis --


def _reporting_trader() -> Trader:
    """A trader with only what analysis() actually reads."""
    t = Trader.__new__(Trader)
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    t.book = {"price_action": {"enabled": True, "inst": None,
                               "live_action": "buy", "live_reason": "pin at support"}}

    class _AI:
        last = {"ready": True, "direction": "buy", "confidence": 0.7}
        by_symbol: dict = {}

    t.ai = _AI()
    t.min_ai_confidence = 0.55
    t.require_ai_agree = False
    t.auto_entry = False
    t.trade_gate = lambda: {"ready": True, "reasons": []}       # type: ignore[method-assign]
    t._own_pending_orders = lambda: []                          # type: ignore[method-assign]
    t.market_state = lambda: {"state": "open"}                  # type: ignore[method-assign]
    t._analysis_console = lambda a, b: []                       # type: ignore[method-assign]
    return t


def test_the_live_analysis_read_does_not_raise() -> None:
    """The exact failure behind 'analysis unavailable'."""
    out = _reporting_trader().analysis()
    assert out["symbol"] == "EURUSD"
    assert out["when"]


def test_a_planted_entry_is_reported_rather_than_looking_like_nothing() -> None:
    t = _reporting_trader()
    t._own_pending_orders = lambda: [{                           # type: ignore[method-assign]
        "ticket": 1, "symbol": "EURUSD", "type": "buy_limit",
        "price": 1.09, "sl": 1.08, "tp": 1.11, "volume": 0.1,
    }]
    out = t.analysis()
    assert len(out["resting"]) == 1
    assert "planted" in out["when"].lower()


def test_safe_analysis_still_catches_a_genuine_fault() -> None:
    """The guard stays - it just has nothing to hide any more."""
    t = _reporting_trader()
    t.analysis = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[method-assign]
    out = t._safe_analysis()
    assert out["fault"] is True


# ------------------------------------------------------------- trade caps --


def _capped_trader(cap: int = 1, floor: int = 1) -> Trader:
    t = Trader.__new__(Trader)
    t.max_open_trades = cap
    t.min_open_trades = floor
    t._entry_inflight = {}
    t.MAGIC = 908173

    class _Prop:
        enabled = False
        profile: dict = {}

    class _Bridge:
        positions: list = []
        orders: list = []

        @staticmethod
        def _sym_match(a, b):
            return a == b

    t.prop = _Prop()
    t.bridge = _Bridge()
    return t


class _Order:
    def __init__(self, symbol="EURUSD"):
        self.symbol = symbol

    def to_dict(self):
        return {"magic": 908173, "symbol": self.symbol,
                "type": "buy_limit", "price": 1.09}


class _Position:
    def __init__(self, symbol="EURUSD"):
        self.symbol = symbol


def test_one_signal_never_asks_for_more_tickets_than_the_cap() -> None:
    for cap in (1, 2, 3):
        t = _capped_trader(cap)
        assert t._entries_for_signal("EURUSD", 0.99) <= cap


def test_a_resting_order_holds_its_slot() -> None:
    """It will become a position without anyone asking again."""
    t = _capped_trader(1)
    t.bridge.orders = [_Order()]
    assert t.free_slots("EURUSD") == 0
    assert t._entries_for_signal("EURUSD", 0.99) == 0


def test_an_entry_still_on_the_wire_holds_its_slot() -> None:
    """The race that turned a cap of one into two trades."""
    t = _capped_trader(1)
    assert t._entries_for_signal("EURUSD", 0.9) == 1     # signal A is allowed
    t._hold_slot("EURUSD")                               # ...and is sent
    assert t._entries_for_signal("EURUSD", 0.9) == 0     # signal B must wait


def test_the_slot_is_given_back_when_a_send_fails() -> None:
    t = _capped_trader(1)
    t._hold_slot("EURUSD")
    t._release_slot("EURUSD")
    assert t.free_slots("EURUSD") == 1


def test_an_open_position_still_holds_its_slot() -> None:
    t = _capped_trader(1)
    t.bridge.positions = [_Position()]
    assert t.free_slots("EURUSD") == 0


def test_the_three_kinds_of_commitment_add_up() -> None:
    t = _capped_trader(5)
    t.bridge.positions = [_Position()]
    t.bridge.orders = [_Order()]
    t._hold_slot("EURUSD")
    assert t._committed_count("EURUSD") == 3
    assert t.free_slots("EURUSD") == 2


# ------------------------------------------------------- the money ceiling --


FX = SymbolSpec(symbol="TEST", tick_size=0.00001, tick_value=0.1, digits=5,
                volume_min=0.01, volume_step=0.01, volume_max=50.0)


def test_a_micro_lot_may_risk_the_whole_cap() -> None:
    """What the setting says on the tin, and did not do."""
    sl = protective_stop("buy", 1.10000, FX, 10.0, REFERENCE_LOT)
    assert money_at_risk("buy", 1.10000, sl, REFERENCE_LOT, FX) == pytest.approx(10.0)


def test_raising_the_lot_raises_the_risk_instead_of_tightening_the_stop() -> None:
    small = protective_stop("buy", 1.10000, FX, 10.0, 0.01)
    large = protective_stop("buy", 1.10000, FX, 10.0, 0.10)
    assert abs(small - large) <= FX.tick_size + 1e-9
    assert money_at_risk("buy", 1.10000, large, 0.10, FX) == pytest.approx(100.0, rel=1e-3)


# ------------------------------------------------------ the profit ladder --


def test_the_ladder_locks_the_entry_at_the_first_target() -> None:
    out = ladder_target("buy", 1.1000, 1.1300, 1.1100, steps=3)
    assert out is not None
    stop, rung = out
    assert rung == 1
    assert stop == pytest.approx(1.1000)        # break-even, no spread given


def test_each_further_target_drags_the_stop_up_behind_it() -> None:
    """The complaint: a winner that gives its profit back."""
    _, rung2 = ladder_target("buy", 1.1000, 1.1300, 1.1200, steps=3)    # type: ignore[misc]
    stop2, _ = ladder_target("buy", 1.1000, 1.1300, 1.1200, steps=3)    # type: ignore[misc]
    stop3, rung3 = ladder_target("buy", 1.1000, 1.1300, 1.1300, steps=3)  # type: ignore[misc]
    assert (rung2, rung3) == (2, 3)
    assert stop2 == pytest.approx(1.1100)       # locked at the first target
    assert stop3 == pytest.approx(1.1200)       # ...then at the second
    assert stop3 > stop2


def test_nothing_is_locked_before_the_first_target() -> None:
    assert ladder_target("buy", 1.1000, 1.1300, 1.1050, steps=3) is None


def test_the_ladder_works_the_same_way_short() -> None:
    stop, rung = ladder_target("sell", 1.1000, 1.0700, 1.0800, steps=3)  # type: ignore[misc]
    assert rung == 2
    assert stop == pytest.approx(1.0900)


def test_a_stop_is_never_asked_for_on_the_wrong_side_of_the_market() -> None:
    """A rung only just touched sits at the price; asking is a rejection."""
    assert ladder_target("buy", 1.1000, 1.1300, 1.1000, steps=3) is None
    for px in (1.1100, 1.1200, 1.1300):
        out = ladder_target("buy", 1.1000, 1.1300, px, steps=3)
        if out is not None:
            assert out[0] < px


def test_a_target_on_the_wrong_side_is_refused_rather_than_measured() -> None:
    assert ladder_target("buy", 1.1000, 1.0700, 1.1100, steps=3) is None
    assert ladder_target("sell", 1.1000, 1.1300, 1.0900, steps=3) is None


def test_the_rungs_are_evenly_spaced_to_the_target() -> None:
    assert ladder_milestones(1.0, 1.3, 3) == pytest.approx([1.1, 1.2, 1.3])
    assert ladder_milestones(1.0, 1.0, 3) == []
    assert ladder_milestones(1.0, 1.3, 0) == []
