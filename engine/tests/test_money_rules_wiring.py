"""The money rule has to be wired into the things that send orders.

test_money_rules.py proves the arithmetic. This proves it is actually
reached: an order on its way out is capped and sized, an open position
that drifts outside the cap is pulled back inside it, and a symbol whose
contract the broker never described is reported rather than guessed at.

The cap is a PER-TRADE number by default (MONEY_SCOPES in runtime/risk),
so on this contract a $10 cap is $10 whatever the lot: at 0.10 lots the
stop may sit 0.00999 away, at 0.01 lots it may sit 0.10000 away. The
numbers below are that. They used to be the per-0.01-lot reading, which
is what gave a 0.10-lot manual trade a $100 stop from a setting that
said 10 - the defect this file now pins the fix for. The older reading
is still available as scope="lot" and is exercised at the bottom.

The trader is built without running its constructor — it would want a
database, a licence and a terminal — and given exactly the three
collaborators these methods touch: a bridge, a journal and an account.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from aurion.runtime.trader import Trader


class FakeBridge:
    def __init__(self, spec: dict | None = None, positions=(), tick=None) -> None:
        self._spec = spec if spec is not None else {
            "trade_tick_size": 0.00001,
            "trade_tick_value": 0.1,     # $10 per 100 points per lot
            "digits": 5,
            "volume_min": 0.01,
            "volume_step": 0.01,
            "currency_profit": "USD",
        }
        self.positions = list(positions)
        self.ticks = {"TEST": tick} if tick else {}
        self.sent: list[dict] = []
        self.account = SimpleNamespace(to_dict=lambda: {"equity": 10_000, "currency": "USD"})

    def symbol_spec(self, symbol: str) -> dict:
        return dict(self._spec)

    async def send_order(self, request: dict) -> dict:
        self.sent.append(dict(request))
        return {"ok": True}


def _trader(bridge: FakeBridge, cap: float = 10.0) -> Trader:
    t = object.__new__(Trader)
    t.bridge = bridge
    t.max_loss_per_lot = cap
    t._spec_gap_said = set()
    t._cap_note = {}
    t.prop = SimpleNamespace(enabled=False, profile={})
    t.active_symbol = "TEST"
    t.logged: list[tuple] = []

    async def journal(level, code, message, extra=None):
        t.logged.append((level, code, message))

    t.journal = journal
    return t


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------- outgoing --

def test_an_outgoing_order_has_its_stop_capped() -> None:
    """A stop so wide that even the minimum lot cannot afford it.

    0.20 of price at the broker's 0.01 minimum is $200, twenty times the
    cap, so there is no size small enough to buy that stop. Only then
    does the rule move the stop, and it moves it to exactly the cap at
    the size being sent: $9.99 at 0.10 lots, one tick inside the ceiling
    because the distance is floored to whole ticks.
    """
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 0.90000, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.09001, abs=1e-5 + 1e-9)
    assert out["volume"] == pytest.approx(0.10)
    assert any(code == "stop_capped" for _, code, _ in t.logged)


def test_the_size_moves_before_the_stop_does() -> None:
    """The reported fault, from the other side.

    A stop the trader chose by looking at the chart is worth more than
    the lot they chose out of habit, and a cap that answers by yanking
    the stop towards the entry turns a planned trade into a coin flip in
    the spread. On this contract a 100-point stop costs $10 a lot, so
    2.00 lots risks $20; one lot risks the $10 the cap allows, over the
    very same stop.
    """
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 2.00, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.09900), "the stop was moved instead of the size"
    assert out["volume"] == pytest.approx(1.00)
    assert any(code == "sized_to_cap" for _, code, _ in t.logged)
    assert not any(code == "stop_capped" for _, code, _ in t.logged)


def test_a_ticket_already_inside_the_cap_keeps_its_own_size() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.05, "sl": 1.09900, "price": 1.10000}
    ))
    # 0.05 lots over 100 points is $5 - half the cap, and the rule is a
    # ceiling, not a target.
    assert out["volume"] == pytest.approx(0.05)
    assert out["sl"] == pytest.approx(1.09900)
    assert not any(code in {"sized_to_cap", "stop_capped"} for _, code, _ in t.logged)


def test_an_order_without_a_stop_is_given_one() -> None:
    """At the cap, at the size asked for: $10 on 0.10 lots is 0.00999."""
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "sell", "symbol": "TEST", "volume": 0.10, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.10999, abs=1e-5 + 1e-9)
    assert out["volume"] == pytest.approx(0.10), "a missing stop is not a reason to resize"


def test_a_tight_stop_is_not_touched() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 1.09950, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.09950)
    assert not any(code == "stop_capped" for _, code, _ in t.logged)


def test_the_entry_price_comes_from_the_tick_when_the_order_has_none() -> None:
    bridge = FakeBridge(tick=SimpleNamespace(bid=1.09998, ask=1.10000))
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 0.50000}
    ))
    # Entry read from the ask (1.10000); at 0.10 lots $10 is 0.00999.
    assert out["sl"] == pytest.approx(1.09001, abs=1e-5 + 1e-9)


def test_prop_risk_budget_sizes_the_lot_down() -> None:
    """Prop's percentage and the cap are both ceilings; the lower wins.

    1% of 10,000 is $100 of prop budget and a 100-point stop costs $10 a
    lot, so prop alone would allow 10 lots. The $10 cap allows one. The
    trade goes out at one, because a ceiling that can be stepped over by
    turning on another feature is not a ceiling.
    """
    bridge = FakeBridge()
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 1.0})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 25.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == pytest.approx(1.0)
    assert any(code == "sized_to_cap" for _, code, _ in t.logged)


def test_prop_still_binds_when_it_is_the_tighter_of_the_two() -> None:
    bridge = FakeBridge()
    t = _trader(bridge, cap=1000.0)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 1.0})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 25.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == pytest.approx(10.0)
    assert any(code == "sized_down" for _, code, _ in t.logged)


def test_a_budget_that_cannot_pay_for_the_minimum_lot_tightens_the_stop() -> None:
    """Reversed deliberately. This used to assert volume == 0.

    Refusing was the reported fault, not the fix. Two ceilings apply to
    an entry — the money cap and prop's risk-per-trade percentage — and
    when the cap is the binding one the stop is pulled in so the
    smallest lot fits. When the budget was the binding one the ticket
    was zeroed instead, and "volume after sizing is below the broker's
    minimum lot" came back on every order, by hand and from the robot,
    naming the one number the trader cannot change.

    Same fork, same answer now: send the broker's minimum with the stop
    inside the budget.
    """
    bridge = FakeBridge()
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.0001})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 1.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == pytest.approx(0.01)
    assert any(code == "sized_to_budget" for _, code, _ in t.logged)
    # $0.01 of budget at 0.01 lots buys ten ticks of stop on this contract.
    assert out["sl"] == pytest.approx(1.09990, abs=1e-9)
    assert not t.last_money_block


def test_the_rescue_stops_at_the_spread() -> None:
    """Tightening is only a rescue while the result is still a trade.

    A stop inside the spread is an instant exit wearing a stop's
    clothes, so below that the honest answer is still no — with both
    numbers and the setting to change, rather than a sentence about lot
    sizes.
    """
    bridge = FakeBridge(tick=SimpleNamespace(bid=1.09950, ask=1.10000))
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.0001})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 1.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == 0.0
    assert any(code == "too_small" for _, code, _ in t.logged)
    why = t.last_money_block.get("why", "")
    assert "0.01" in why, why
    assert "Prop" in why, "the trader is owed the setting that unblocks them"


def test_a_small_prop_account_can_still_trade() -> None:
    """The reported configuration, end to end.

    A $1,000 account on the default 0.40% profile has a $4 budget, which
    is under the $10 money cap. The cap sizes the ticket so it risks $10
    at the minimum lot; prop's $4 then cannot pay for that, and every
    order — manual and robot — was refused. Now the stop comes in to $4
    and the trade goes.
    """
    bridge = FakeBridge()
    bridge.account = SimpleNamespace(to_dict=lambda: {"equity": 1_000, "currency": "USD"})
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.40})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.01, "sl": 1.00000, "price": 1.10000}
    ))
    assert out["volume"] == pytest.approx(0.01)
    # $4 at 0.01 lots is 0.04 of price on this contract, less the one
    # tick the allowed distance is floored by so the budget stays a
    # ceiling rather than a target.
    assert out["sl"] == pytest.approx(1.06001, abs=1e-9)
    assert run_money_at_risk(t, out) == pytest.approx(4.0, abs=0.01)
    assert run_money_at_risk(t, out) <= 4.0


def run_money_at_risk(t, request) -> float:
    from aurion.runtime.risk import money_at_risk
    spec = t.symbol_spec(str(request.get("symbol") or ""))
    return money_at_risk("buy", 1.10000, float(request.get("sl") or 0),
                         float(request.get("volume") or 0), spec)


def test_a_lot_smaller_than_the_brokers_minimum_is_never_rounded_up() -> None:
    """The rescue sends the minimum; it must not send it to someone who
    asked for less than the minimum in the first place."""
    bridge = FakeBridge()
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.0001})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.005, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == 0.0


def test_without_a_spec_nothing_is_invented_and_it_is_said_once() -> None:
    bridge = FakeBridge(spec={})
    t = _trader(bridge)
    request = {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 0.50000, "price": 1.10000}
    out = run(t._apply_money_rules(dict(request)))
    assert out["sl"] == pytest.approx(0.50000)       # untouched
    run(t._apply_money_rules(dict(request)))
    assert sum(1 for _, code, _ in t.logged if code == "no_spec") == 1


def test_a_cap_of_zero_leaves_everything_alone() -> None:
    bridge = FakeBridge()
    t = _trader(bridge, cap=0.0)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 0.50000, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(0.50000)


def test_closing_an_order_is_not_a_money_decision() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules({"action": "close", "ticket": 1, "symbol": "TEST", "volume": 0.1}))
    assert "sl" not in out


# ------------------------------------------------------- open trades --

def _pos(ticket: int, sl: float, side: str = "buy"):
    return SimpleNamespace(
        ticket=ticket, symbol="TEST", type=side, price_open=1.10000, sl=sl, tp=1.12000, volume=0.1
    )


def test_an_open_position_outside_the_cap_is_pulled_back_in() -> None:
    """On an open trade the stop is the only lever there is.

    Sizing down is how an outgoing ticket is brought inside the cap, and
    it is not available here: the position exists, at the size it was
    filled at. So this path still moves the stop, to the cap at that
    size - 0.00999 on 0.10 lots.
    """
    bridge = FakeBridge(positions=[_pos(7, 0.90000)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent and bridge.sent[0]["action"] == "modify"
    assert bridge.sent[0]["sl"] == pytest.approx(1.09001, abs=1e-5 + 1e-9)
    assert bridge.sent[0]["ticket"] == 7


def test_a_position_with_no_stop_at_all_gets_one() -> None:
    bridge = FakeBridge(positions=[_pos(8, 0.0, side="sell")])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent[0]["sl"] == pytest.approx(1.10999, abs=1e-5 + 1e-9)


def test_the_same_modify_is_not_sent_on_every_tick() -> None:
    bridge = FakeBridge(positions=[_pos(9, 0.90000)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert len(bridge.sent) == 1


def test_a_position_already_inside_the_cap_is_left_alone() -> None:
    # 0.00050 of price on 0.10 lots is 50 cents, well under the cap.
    bridge = FakeBridge(positions=[_pos(10, 1.09950)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent == []


def test_the_chart_marks_use_the_same_rule() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    rule = t._chart_stop_cap("TEST")
    assert rule is not None
    assert rule("buy", 1.10000, 0.90000, 0.01) == pytest.approx(1.00000, abs=1e-5 + 1e-9)
    assert _trader(FakeBridge(spec={}))._chart_stop_cap("TEST") is None


# ------------------------------------------------- the desk's own copy --
#
# The desk prices its own tickets now - how many points a stop is and
# what it costs at the lot in the field - so it needs these numbers in
# the browser. The rule that matters is the same one risk.py states:
# a symbol that cannot be priced is left out, never guessed at.


class SpecBridge(FakeBridge):
    """A bridge that answers differently per symbol, like a real one."""

    def __init__(self, specs: dict[str, dict], positions=()) -> None:
        super().__init__(positions=positions)
        self._by_symbol = specs

    def symbol_spec(self, symbol: str) -> dict:
        return dict(self._by_symbol.get(str(symbol), {}))

    def known_symbols(self) -> list[str]:
        return list(self._by_symbol)


GOOD = {
    "trade_tick_size": 0.00001,
    "trade_tick_value": 0.1,
    "digits": 5,
    "volume_min": 0.01,
    "volume_step": 0.01,
    "trade_contract_size": 100_000,
    "currency_profit": "USD",
}


def test_the_desk_is_sent_the_numbers_it_needs_to_price_a_ticket() -> None:
    t = _trader(SpecBridge({"TEST": GOOD}))
    table = t._spec_table()
    assert "TEST" in table
    row = table["TEST"]
    assert row["tick_size"] == pytest.approx(0.00001)
    assert row["tick_value"] == pytest.approx(0.1)
    assert row["digits"] == 5
    assert row["currency"] == "USD"
    assert row["contract_size"] == pytest.approx(100_000)


def test_a_symbol_that_cannot_be_priced_is_left_out_rather_than_guessed() -> None:
    # No tick value: SymbolSpec.usable is False, and a desk that
    # received a zero here would quietly multiply every stop by it and
    # show $0.00 risk on a real position.
    broken = {k: v for k, v in GOOD.items() if k != "trade_tick_value"}
    t = _trader(SpecBridge({"TEST": GOOD, "ODD": broken}))
    table = t._spec_table()
    assert "TEST" in table
    assert "ODD" not in table


def test_the_table_covers_what_is_open_as_well_as_what_is_active() -> None:
    # A position on a symbol the desk is not looking at still has to be
    # priceable, or its row shows no money.
    held = SimpleNamespace(symbol="OTHER")
    t = _trader(SpecBridge({"TEST": GOOD, "OTHER": GOOD}, positions=[held]))
    assert {"TEST", "OTHER"} <= set(t._spec_table())


def test_the_money_state_says_which_lot_the_cap_is_quoted_against() -> None:
    # The desk used to print "per lot" beside a number the engine
    # measures against 0.01 of one - a hundredfold misreading of the
    # trader's own risk budget. The reference lot is sent so the card
    # can state it rather than assume it.
    from aurion.runtime.risk import REFERENCE_LOT

    t = _trader(SpecBridge({"TEST": GOOD}))
    state = t._money_state()
    assert state["reference_lot"] == REFERENCE_LOT
    assert state["priced"] is True
    assert "TEST" in state["specs"]


def test_a_bridge_that_cannot_list_symbols_does_not_break_the_snapshot() -> None:
    # known_symbols is newer than the bridge interface it sits on, and a
    # snapshot that raises takes the whole desk down with it.
    class OldBridge(FakeBridge):
        def known_symbols(self):  # pragma: no cover - raising is the point
            raise RuntimeError("older bridge")

    t = _trader(OldBridge())
    table = t._spec_table()
    assert "TEST" in table          # the active symbol still gets through


def test_the_bridge_lists_the_names_the_broker_uses() -> None:
    from aurion.mt5.bridge import MT5Bridge

    b = object.__new__(MT5Bridge)
    b._specs = {}
    b.remember_spec("EURUSD.m", dict(GOOD))
    assert b.known_symbols() == ["EURUSD.m"]
