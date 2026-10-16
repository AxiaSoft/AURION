"""The money rule has to be wired into the things that send orders.

test_money_rules.py proves the arithmetic. This proves it is actually
reached: an order on its way out is capped and sized, an open position
that drifts outside the cap is pulled back inside it, and a symbol whose
contract the broker never described is reported rather than guessed at.

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
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 1.09000, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.09900)
    assert any(code == "stop_capped" for _, code, _ in t.logged)


def test_an_order_without_a_stop_is_given_one() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "sell", "symbol": "TEST", "volume": 0.10, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.10100)


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
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 1.00000}
    ))
    assert out["sl"] == pytest.approx(1.09900)


def test_prop_risk_budget_sizes_the_lot_down() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    # 1% of 10,000 = $100 of budget; a $10-per-lot stop pays for 10 lots.
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 1.0})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 25.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == pytest.approx(10.0)
    assert any(code == "sized_down" for _, code, _ in t.logged)


def test_a_budget_that_cannot_pay_for_the_minimum_lot_sends_nothing() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.0001})
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 1.0, "sl": 1.09900, "price": 1.10000}
    ))
    assert out["volume"] == 0.0
    assert any(code == "too_small" for _, code, _ in t.logged)


def test_without_a_spec_nothing_is_invented_and_it_is_said_once() -> None:
    bridge = FakeBridge(spec={})
    t = _trader(bridge)
    request = {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 1.00000, "price": 1.10000}
    out = run(t._apply_money_rules(dict(request)))
    assert out["sl"] == pytest.approx(1.00000)       # untouched
    run(t._apply_money_rules(dict(request)))
    assert sum(1 for _, code, _ in t.logged if code == "no_spec") == 1


def test_a_cap_of_zero_leaves_everything_alone() -> None:
    bridge = FakeBridge()
    t = _trader(bridge, cap=0.0)
    out = run(t._apply_money_rules(
        {"action": "market", "side": "buy", "symbol": "TEST", "volume": 0.10, "sl": 1.00000, "price": 1.10000}
    ))
    assert out["sl"] == pytest.approx(1.00000)


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
    bridge = FakeBridge(positions=[_pos(7, 1.09000)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent and bridge.sent[0]["action"] == "modify"
    assert bridge.sent[0]["sl"] == pytest.approx(1.09900)
    assert bridge.sent[0]["ticket"] == 7


def test_a_position_with_no_stop_at_all_gets_one() -> None:
    bridge = FakeBridge(positions=[_pos(8, 0.0, side="sell")])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent[0]["sl"] == pytest.approx(1.10100)


def test_the_same_modify_is_not_sent_on_every_tick() -> None:
    bridge = FakeBridge(positions=[_pos(9, 1.09000)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert len(bridge.sent) == 1


def test_a_position_already_inside_the_cap_is_left_alone() -> None:
    bridge = FakeBridge(positions=[_pos(10, 1.09950)])
    t = _trader(bridge)
    run(t._enforce_stop_cap({"symbol": "TEST"}))
    assert bridge.sent == []


def test_the_chart_marks_use_the_same_rule() -> None:
    bridge = FakeBridge()
    t = _trader(bridge)
    rule = t._chart_stop_cap("TEST")
    assert rule is not None
    assert rule("buy", 1.10000, 1.09000) == pytest.approx(1.09900)
    assert _trader(FakeBridge(spec={}))._chart_stop_cap("TEST") is None
