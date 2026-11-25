"""The three ceilings the broker declares and nothing was reading.

Same shape of defect as the stop distance, three more times over. The
terminal knows the limit, the engine sizes a trade without reference to
it, and the broker refuses the order with a bare retcode. The trader is
left with a ticket that vanished and no sentence anywhere saying why.

  freeze_level   - within this distance of its stop or target a
                   position may not be modified or closed AT ALL. From
                   the desk that looks like the Close button not
                   working, so it gets pressed again.

  volume_limit   - the ceiling on TOTAL volume in a symbol, counting
                   every position and pending order. It is NOT
                   volume_max, which is the ceiling for a single
                   order. A book allowing 50 lots per order and 100 in
                   total will refuse a fourth 30-lot order that is
                   individually legal.

  margin         - every risk rule in risk.py is about what a trade can
                   LOSE. Not one of them asks whether the account can
                   AFFORD to hold it. margin_free was arriving from the
                   terminal, being stored, and being printed on the
                   desk, without ever being read before an order went.
"""

from __future__ import annotations

import pytest

from aurion.runtime.risk import SymbolSpec

GOLD = {
    "tick_size": 0.01, "tick_value": 1.0, "digits": 2, "point": 0.01,
    "volume_min": 0.01, "volume_step": 0.01, "volume_max": 50.0,
    "contract_size": 100, "currency": "USD",
}


def _spec(**over) -> SymbolSpec:
    return SymbolSpec.from_info({**GOLD, **over})


# --------------------------------------------------------------- freeze


def test_freeze_level_is_read_and_resolved_into_price():
    assert _spec(freeze_level=30).freeze_distance == pytest.approx(0.30)


def test_both_spellings_of_freeze():
    assert _spec(trade_freeze_level=12).freeze_level == 12
    assert _spec(freeze_level=12).freeze_level == 12


def test_no_freeze_zone_is_the_common_case():
    assert _spec().freeze_distance == 0.0
    assert _spec(freeze_level=0).freeze_distance == 0.0


def test_freeze_is_a_different_question_from_the_stop_floor():
    """One says where a stop may be placed, the other whether an order
    may be touched. They are frequently different numbers and reading
    one for the other would be wrong in both directions."""
    spec = _spec(stops_level=10, freeze_level=40)
    assert spec.min_stop_distance == pytest.approx(0.10)
    assert spec.freeze_distance == pytest.approx(0.40)


# --------------------------------------------------------- volume limit


def test_volume_limit_is_not_volume_max():
    """The exact case that was being refused: individually legal,
    collectively over the ceiling."""
    spec = _spec(volume_max=50.0, volume_limit=100.0)
    assert spec.volume_max == 50.0
    assert spec.volume_limit == 100.0
    # 80 already on, asking for 30: under volume_max, over the total.
    assert 30.0 <= spec.volume_max
    assert spec.room_under_volume_limit(80.0) == pytest.approx(20.0)


def test_a_book_with_no_aggregate_ceiling_has_infinite_room():
    """So callers can compare without special-casing the common book."""
    assert _spec().room_under_volume_limit(80.0) == float("inf")
    assert _spec(volume_limit=0).room_under_volume_limit(1e9) == float("inf")


def test_room_never_goes_negative():
    assert _spec(volume_limit=100.0).room_under_volume_limit(140.0) == 0.0


# --------------------------------------------------------------- margin


def test_margin_comes_from_the_terminals_own_answer():
    spec = _spec(margin_per_lot_buy=1000.0, margin_per_lot_sell=990.0)
    assert spec.margin_for("buy", 2) == pytest.approx(2000.0)
    assert spec.margin_for("sell", 2) == pytest.approx(1980.0)


def test_the_sides_are_allowed_to_differ():
    spec = _spec(margin_per_lot_buy=1000.0, margin_per_lot_sell=500.0)
    assert spec.margin_for("buy", 1) != spec.margin_for("sell", 1)


def test_a_missing_side_falls_back_to_the_other_before_giving_up():
    """One answer about this symbol beats none."""
    spec = _spec(margin_per_lot_buy=1000.0)
    assert spec.margin_for("sell", 1) == pytest.approx(1000.0)


def test_margin_initial_is_the_last_resort_not_the_first():
    """It is 0 on most forex books, which is why OrderCalcMargin is asked."""
    spec = _spec(margin_initial=750.0, margin_per_lot_buy=1000.0)
    assert spec.margin_for("buy", 1) == pytest.approx(1000.0)
    assert _spec(margin_initial=750.0).margin_for("buy", 1) == pytest.approx(750.0)


def test_unknown_margin_is_zero_and_zero_means_unknown_not_free():
    """The caller must not pretend to have checked anything."""
    assert _spec().margin_for("buy", 10) == 0.0


def test_margin_is_linear_in_volume():
    spec = _spec(margin_per_lot_buy=1000.0)
    assert spec.margin_for("buy", 0.5) == pytest.approx(500.0)
    assert spec.margin_for("buy", 3) == pytest.approx(3000.0)
    assert spec.margin_for("buy", 0) == 0.0


# ------------------------------------------------------- wired, not just
# ------------------------------------------------------- defined


def test_the_trader_actually_consults_all_three():
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    assert "_apply_broker_ceilings" in src
    assert "room_under_volume_limit" in src, "the total-volume ceiling is not enforced"
    assert "margin_for" in src, "margin is still never checked before sending"
    assert "_frozen_reason" in src, "the freeze zone is not checked"
    # margin_free was being displayed and never read. It must now be read.
    assert "margin_free" in src, "free margin is still not consulted"


def test_the_close_and_modify_paths_are_both_guarded():
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader.execute)
    assert src.count("_frozen_reason") >= 2, (
        "a freeze guard on close alone leaves modify returning a bare retcode"
    )


def test_the_desk_is_told_each_ceiling_resolved():
    import inspect

    from aurion.runtime.trader import Trader

    src = inspect.getsource(Trader)
    at = src.index('"min_stop_distance": spec.min_stop_distance')
    window = src[at:at + 900]
    for key in ("freeze_distance", "volume_limit",
                "margin_per_lot_buy", "margin_per_lot_sell"):
        assert f'"{key}"' in window, f"the desk is not told {key}"
    assert '"freeze_level"' not in window, (
        "the desk was handed raw points and the unit question with them"
    )


def test_the_expert_sends_what_the_engine_now_reads():
    """A field read from a message nobody sends is read as 0 forever."""
    from pathlib import Path

    ea = Path(__file__).resolve().parents[1] / "ea" / "AurionBridge.mq5"
    src = ea.read_text(encoding="utf-8", errors="replace")
    for field in ("freeze_level", "volume_limit", "margin_initial",
                  "margin_per_lot_buy", "margin_per_lot_sell"):
        assert f'\\"{field}\\":' in src, f"the expert never sends {field}"
    assert "SYMBOL_TRADE_FREEZE_LEVEL" in src
    assert "SYMBOL_VOLUME_LIMIT" in src
    assert "OrderCalcMargin" in src, (
        "margin was read from SYMBOL_MARGIN_INITIAL, which is 0 on most forex books"
    )


# ───────────────────────────── the gate, exercised rather than grepped ──
#
# Everything above proves the numbers are right and the words are
# present. None of it proves an order is actually stopped, and a rule
# that is defined but not reached is the defect this whole slice is
# about. So the real method is borrowed onto a stand-in with just
# enough trader on it to run.

import asyncio
from types import SimpleNamespace


class _Pos(SimpleNamespace):
    pass


class _Trader:
    """Just enough of the trader to exercise _apply_broker_ceilings."""

    MAGIC = 908173

    def __init__(self, positions=(), orders=(), margin_free=1e9):
        self.bridge = SimpleNamespace(
            positions=list(positions),
            orders=list(orders),
            account=SimpleNamespace(margin_free=margin_free),
            _sym_match=lambda a, b: a == b,
        )
        self.last_money_block = {}
        self.journalled = []

    async def journal(self, level, code, text, extra=None):
        self.journalled.append((level, code, text))


def _gate(**kw):
    from aurion.runtime.trader import Trader

    t = _Trader(**kw)
    for name in ("_apply_broker_ceilings", "_held_volume",
                 "_free_margin", "_has_opposite_position"):
        setattr(t, name, getattr(Trader, name).__get__(t, _Trader))
    return t


def _run(t, spec, volume, side="buy", symbol="XAUUSD"):
    req = {"action": "market", "symbol": symbol, "side": side, "volume": volume}
    return asyncio.run(t._apply_broker_ceilings(req, symbol, side, spec))


def test_the_order_over_the_total_ceiling_is_cut_not_sent_whole():
    """80 lots on, 30 asked, 100 allowed in total: 20 goes out."""
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=80.0, type="buy")])
    out = _run(t, _spec(volume_limit=100.0, volume_max=50.0), 30.0)
    assert out["volume"] == pytest.approx(20.0)
    assert any(c == "volume_limit" for _, c, _ in t.journalled)


def test_a_symbol_that_is_already_full_is_refused_with_a_sentence():
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=100.0, type="buy")])
    out = _run(t, _spec(volume_limit=100.0), 10.0)
    assert out["volume"] == 0.0
    assert "no room" in t.last_money_block["why"]


def test_pending_orders_count_towards_the_ceiling_too():
    """The broker counts them, so this must."""
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=60.0, type="buy")],
              orders=[{"symbol": "XAUUSD", "volume": 30.0, "magic": 908173}])
    out = _run(t, _spec(volume_limit=100.0), 30.0)
    assert out["volume"] == pytest.approx(10.0)


def test_another_symbol_does_not_fill_this_symbols_ceiling():
    t = _gate(positions=[_Pos(symbol="EURUSD", volume=90.0, type="buy")])
    out = _run(t, _spec(volume_limit=100.0), 30.0)
    assert out["volume"] == pytest.approx(30.0)


def test_a_book_with_no_ceiling_passes_untouched():
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=5000.0, type="buy")])
    out = _run(t, _spec(), 30.0)
    assert out["volume"] == pytest.approx(30.0)


def test_a_ticket_the_account_cannot_afford_is_sized_down():
    """2 lots need 2000, 500 is free: 0.5 lots goes out instead of
    'no money' coming back."""
    t = _gate(margin_free=500.0)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0)
    assert out["volume"] == pytest.approx(0.5)
    assert any(c == "margin_sized" for _, c, _ in t.journalled)


def test_when_even_the_minimum_lot_is_unaffordable_it_says_so_plainly():
    t = _gate(margin_free=1.0)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0)
    assert out["volume"] == 0.0
    why = t.last_money_block["why"]
    assert "not about the stop" in why, "a margin refusal must not read as a risk refusal"


def test_an_affordable_ticket_is_not_touched():
    t = _gate(margin_free=1e6)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0)
    assert out["volume"] == pytest.approx(2.0)
    assert not t.journalled


def test_unknown_margin_blocks_nothing():
    """0 means the terminal did not answer. It does not mean free, and
    it must not mean refused either."""
    t = _gate(margin_free=1.0)
    out = _run(t, _spec(), 2.0)
    assert out["volume"] == pytest.approx(2.0)


def test_an_unreported_account_blocks_nothing():
    t = _gate(margin_free=0.0)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0)
    assert out["volume"] == pytest.approx(2.0)


def test_a_hedge_is_left_alone():
    """On a hedging account the opposite trade may need almost no
    margin, and the per-lot figure cannot know that. Refusing a trade
    the broker would have taken is worse than the rejection this is
    preventing."""
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=2.0, type="sell")],
              margin_free=10.0)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0, side="buy")
    assert out["volume"] == pytest.approx(2.0)


def test_a_same_side_add_is_still_checked():
    """Adding to a position is not hedging it, so the relief above does
    not apply and the ticket is judged on its own cost."""
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=2.0, type="buy")],
              margin_free=10.0)
    out = _run(t, _spec(margin_per_lot_buy=1000.0), 2.0, side="buy")
    # 10 free against 1000 a lot buys 0.01, which is the broker's
    # minimum and genuinely affordable - so it is cut to that, not
    # refused. What matters is that 2 lots did not go out.
    assert out["volume"] == pytest.approx(0.01)
    assert any(c == "margin_sized" for _, c, _ in t.journalled)


def test_both_ceilings_apply_to_the_same_ticket():
    """Whichever bites hardest wins, and the volume cut by one is the
    volume the other then judges."""
    t = _gate(positions=[_Pos(symbol="XAUUSD", volume=80.0, type="buy")],
              margin_free=5000.0)
    out = _run(t, _spec(volume_limit=100.0, margin_per_lot_buy=1000.0), 30.0)
    # volume_limit cuts 30 -> 20; margin then cuts 20 -> 5.
    assert out["volume"] == pytest.approx(5.0)
