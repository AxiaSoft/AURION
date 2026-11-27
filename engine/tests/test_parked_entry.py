"""An entry that is planted must still be there when price arrives.

The complaint this file exists for, in the trader's words: the entry
point the robot plants never becomes a trade - the candle goes past it
and it may never be touched.

The cause was not the confirmation rule, which is right: a level that
price walks straight through is not a trade. The cause was that an
unconfirmed plan was thrown away. The only way back was for the strategy
to fire again, and by then the market had moved, so the next plan was
measured back from a NEW market price - the level kept retreating ahead
of price, and no order ever reached the broker.

So these tests are about memory, not about arithmetic: the plan survives
at its own price, is asked again on later candles, and is acted on the
moment the market agrees.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.auto_entry import DEFAULT_MAX_DRIFT  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402


def bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


class FakeTrader:
    """Only the parts of the Trader the parked-entry watch actually uses.

    Borrowing the real methods off the class keeps the test honest - it is
    the shipping code that runs, not a re-description of it.
    """

    # staticmethod(): reading it off the class unwraps it, and a bare
    # function here would be rebound as an instance method.
    _park_key = staticmethod(Trader._park_key)
    _park_entry = Trader._park_entry
    _unpark_entry = Trader._unpark_entry
    parked_entries = Trader.parked_entries
    watch_parked_entries = Trader.watch_parked_entries

    def __init__(self, candles, tick, confirm="normal", expiry=120):
        self._parked_entries: dict[str, dict[str, Any]] = {}
        self.auto_entry = True
        self.auto_entry_confirm = confirm
        self.auto_entry_expiry = expiry
        self._candles = candles
        self._tick = tick
        self.sent: list[dict[str, Any]] = []
        self.notes: list[tuple[str, str]] = []
        self.blocks: list[tuple[str, str]] = []
        self.auto_entry_max_drift = DEFAULT_MAX_DRIFT

    def _confirm_candles(self, symbol, count=6):
        return self._candles

    def tick_of(self, symbol):
        return self._tick

    async def journal(self, level, kind, text, data=None):
        self.notes.append((kind, text))

    async def _blocked(self, source, payload, code, why, extra=None):
        self.blocks.append((code, why))

    async def execute(self, request):
        self.sent.append(dict(request))
        return {"ok": True, "order": 1}


def park(bot, price=9.5, side="buy", order_type="buy_limit", sl=9.0, tp=11.0):
    bot._park_entry(
        "EURUSD", side,
        {"symbol": "EURUSD", "side": side, "volume": 0.1, "action": "market"},
        {"price": price, "order_type": order_type, "sl": sl, "tp": tp},
        {"confirmed": False, "reason": "price has not reached the entry yet"},
    )


def test_an_unconfirmed_plan_is_remembered_not_discarded():
    bot = FakeTrader([bar(10.0, 10.2, 9.9, 10.1)], {"bid": 10.0, "ask": 10.0})
    park(bot)
    assert len(bot.parked_entries()) == 1
    waiting = bot.parked_entries()[0]
    assert waiting["price"] == 9.5
    assert waiting["side"] == "buy"
    # Nothing is sent while the market has not spoken.
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert bot.sent == []
    # ...and it is still waiting afterwards, at the same price.
    assert bot.parked_entries()[0]["price"] == 9.5


def test_the_order_rests_at_its_original_price_once_confirmed():
    """The point of the fix: the price does not chase the market."""
    bot = FakeTrader([bar(10.0, 10.2, 9.9, 10.1)], {"bid": 10.0, "ask": 10.0})
    park(bot)
    asyncio.run(bot.watch_parked_entries())
    # Price comes down, touches 9.5 and is rejected hard.
    bot._candles = [bar(9.8, 9.9, 9.4, 9.88)]
    assert asyncio.run(bot.watch_parked_entries()) == 1
    sent = bot.sent[-1]
    assert sent["action"] == "pending"
    assert sent["price"] == 9.5, "the entry moved with the market - the original bug"
    assert sent["order_type"] == "buy_limit"
    assert sent["sl"] == 9.0 and sent["tp"] == 11.0
    # And it is no longer waiting: one plan is one trade.
    assert bot.parked_entries() == []


def test_a_level_already_passed_is_taken_at_market_not_rested():
    """A buy limit above the market is the order a broker refuses.

    If the confirmation only arrives after price has gone through the
    level, resting the order there is not a trade - it is a rejection.
    The level did its job, so the trade is taken.
    """
    # Level 9.5, stop 9.0: half a point of risk. At 9.40 a fifth of it
    # has gone, which is still the trade that was planned.
    bot = FakeTrader([bar(9.8, 9.9, 9.4, 9.88)], {"bid": 9.40, "ask": 9.40})
    park(bot)
    assert asyncio.run(bot.watch_parked_entries()) == 1
    sent = bot.sent[-1]
    assert sent["action"] == "market"
    assert sent.get("auto_entry_taken") is True
    assert "price" not in sent


def test_a_level_price_has_run_far_past_is_not_taken_at_any_price():
    """Reported as "the entry is applied too late and price has gone past".

    It had, and the robot bought there anyway: the confirmation arrived
    late, the level was behind the market, and the trade went on at
    market with the ORIGINAL stop still attached. Less reward, a nearer
    stop, and a quick exit - which freed the slot and fed the re-entry
    loop reported alongside this.

    Past the budget the honest answer is that the opportunity was missed,
    said out loud rather than papered over with a worse trade.
    """
    # Same plan, but price is now at 9.30: 40% of the stop distance gone.
    bot = FakeTrader([bar(9.8, 9.9, 9.4, 9.88)], {"bid": 9.30, "ask": 9.30})
    park(bot)
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert bot.sent == [], "a trade nobody planned was sent anyway"
    assert bot.blocks and bot.blocks[-1][0] == "entry_missed"
    assert "no longer the trade that was planned" in bot.blocks[-1][1]
    # And it is not left parked to fire again a tick later.
    assert bot.parked_entries() == []


def test_the_drift_budget_is_the_traders_to_widen():
    """A trader who would rather chase than miss can say so."""
    bot = FakeTrader([bar(9.8, 9.9, 9.4, 9.88)], {"bid": 9.30, "ask": 9.30})
    bot.auto_entry_max_drift = 1.0
    park(bot)
    assert asyncio.run(bot.watch_parked_entries()) == 1
    assert bot.sent[-1]["action"] == "market"


def test_a_plan_that_is_never_confirmed_does_not_wait_for_ever():
    bot = FakeTrader([bar(10.0, 10.2, 9.9, 10.1)], {"bid": 10.0, "ask": 10.0}, expiry=60)
    park(bot)
    # Back-date it past the shelf life the trader set.
    for item in bot._parked_entries.values():
        item["since"] = time.time() - 61 * 60
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert bot.parked_entries() == []
    assert any(kind == "auto_entry_expired" for kind, _ in bot.notes)


def test_a_repeating_strategy_cannot_keep_its_own_entry_alive_for_ever():
    """Re-planting resets the price, never the clock."""
    bot = FakeTrader([bar(10.0, 10.2, 9.9, 10.1)], {"bid": 10.0, "ask": 10.0}, expiry=60)
    park(bot, price=9.5)
    born = bot._parked_entries[bot._park_key("EURUSD", "buy")]["since"]
    bot._parked_entries[bot._park_key("EURUSD", "buy")]["since"] = born - 61 * 60
    park(bot, price=9.6)
    key = bot._park_key("EURUSD", "buy")
    assert bot._parked_entries[key]["plan"]["price"] == 9.6
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert bot.parked_entries() == [], "the shelf life was reset by a repeat signal"


def test_turning_the_setting_off_abandons_what_was_waiting():
    bot = FakeTrader([bar(9.8, 9.9, 9.4, 9.88)], {"bid": 10.0, "ask": 10.0})
    park(bot)
    bot.auto_entry = False
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert bot.sent == []
    assert bot.parked_entries() == []


def test_the_sell_side_is_the_mirror_image():
    bot = FakeTrader([bar(10.0, 10.1, 9.9, 10.0)], {"bid": 10.0, "ask": 10.0})
    park(bot, price=10.5, side="sell", order_type="sell_limit", sl=11.0, tp=9.0)
    assert asyncio.run(bot.watch_parked_entries()) == 0
    # Rallies into 10.5, sellers reject it.
    bot._candles = [bar(10.2, 10.6, 10.1, 10.12)]
    assert asyncio.run(bot.watch_parked_entries()) == 1
    assert bot.sent[-1]["action"] == "pending"
    assert bot.sent[-1]["price"] == 10.5


def test_a_refusal_is_said_out_loud_and_not_retried_silently():
    bot = FakeTrader([bar(9.8, 9.9, 9.4, 9.88)], {"bid": 10.0, "ask": 10.0})

    async def refuse(request):
        bot.sent.append(dict(request))
        return {"ok": False, "error": "no money"}

    bot.execute = refuse
    park(bot)
    assert asyncio.run(bot.watch_parked_entries()) == 0
    assert any(kind == "auto_entry_refused" for kind, _ in bot.notes)
    assert bot.parked_entries() == []


def test_nothing_waiting_is_a_cheap_no_op():
    bot = FakeTrader([], None)
    assert asyncio.run(bot.watch_parked_entries()) == 0
