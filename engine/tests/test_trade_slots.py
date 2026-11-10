"""The robot's "open between 1 and N trades" setting and the quality gate."""

from __future__ import annotations

import asyncio
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.runtime.trader import Trader  # noqa: E402
from aurion.strategy.base import StrategySignal  # noqa: E402


class _Bus:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    async def publish(self, kind, payload=None):
        self.events.append((kind, payload))


def _trader(open_positions: int = 0, symbol: str = "EURUSD") -> Trader:
    t = Trader.__new__(Trader)
    t.bus = _Bus()
    t.robot_log = deque(maxlen=50)
    t.min_open_trades = 1
    t.max_open_trades = 3
    t.smart_filters = True
    t.min_signal_quality = 0.55
    t.volume_mode = "auto"
    t.active_symbol = symbol
    t.active_timeframe = "M15"
    t.trade_style = "normal"
    t.prop = SimpleNamespace(enabled=False, profile={}, locked=False)
    positions = [SimpleNamespace(symbol=symbol) for _ in range(open_positions)]
    t.bridge = SimpleNamespace(
        positions=positions,
        _sym_match=lambda a, b: str(a).upper() == str(b).upper(),
        public_ticks=lambda: {symbol: {"bid": 1.1000, "ask": 1.1001}},
        candles_of=lambda *a, **k: [],
        active_agents=lambda: [],
    )
    t.store = SimpleNamespace(
        candles=lambda *a, **k: [],
        record_signal=lambda *a, **k: None,
    )
    t.ai = SimpleNamespace(by_symbol={}, last={}, models=SimpleNamespace(metrics={"edge": 0.5}))
    t.license = SimpleNamespace(allow_bot_entry=lambda: {"ok": True})
    t.require_ai_agree = False
    return t


def test_free_slots_follows_the_ceiling() -> None:
    t = _trader(open_positions=0)
    assert t.free_slots("EURUSD") == 3
    t = _trader(open_positions=3)
    assert t.free_slots("EURUSD") == 0


def test_entries_scale_between_min_and_max() -> None:
    t = _trader()
    t.min_open_trades = 1
    t.max_open_trades = 3
    assert t._entries_for_signal("EURUSD", 0.50) == 1  # weakest accepted setup
    assert t._entries_for_signal("EURUSD", 0.90) == 3  # strongest setup
    t.min_open_trades = 2
    assert t._entries_for_signal("EURUSD", 0.50) == 2


def test_entries_never_exceed_free_slots() -> None:
    t = _trader(open_positions=2)
    t.min_open_trades = 3
    t.max_open_trades = 3
    assert t._entries_for_signal("EURUSD", 0.99) == 1


def test_prop_ceiling_wins_when_it_is_tighter() -> None:
    t = _trader()
    t.prop = SimpleNamespace(enabled=True, profile={"max_open_trades": 1, "max_positions_per_symbol": 1}, locked=False)
    assert t._total_cap() == 1
    assert t._entries_for_signal("EURUSD", 0.99) == 1


def test_dispatch_opens_the_planned_number_of_tickets() -> None:
    t = _trader()
    t.min_open_trades = 2
    t.max_open_trades = 2
    sent: list[dict] = []

    async def _execute(request):
        sent.append(dict(request))
        t.bridge.positions.append(SimpleNamespace(symbol=request.get("symbol") or "EURUSD"))
        return {"ok": True}

    t.execute = _execute
    t.signal_quality = lambda symbol, side, conf=0.0: {"score": 0.8, "reasons": ["test"]}
    signal = StrategySignal("buy", "EURUSD", volume=0.10, confidence=0.8)
    asyncio.run(t._dispatch_signal(signal, "strategy:test"))
    assert len(sent) == 2
    assert all(s["symbol"] == "EURUSD" for s in sent)


def test_a_low_quality_signal_is_traded_smaller_rather_than_dropped() -> None:
    """This check used to assert the opposite, and it was right to.

    The quality floor refused anything scoring under min_signal_quality,
    and the reasoning was sound on its face: do not take setups the
    robot's own reads disagree with.

    It was removed on request - the smart filters were to stop blocking
    trades - and only after the request was measured. A/B over a seeded
    synthetic market, 8 markets x 3 built-ins, 2 837 priced trades,
    split on the strategy's own confidence against the 0.55 floor
    (which is exactly what signal_quality returns when the model is
    still learning and the slower chart is silent):

        everything             n=2837  PF 1.15  +0.0580R
        the floor allowed      n=2756  PF 1.14  +0.0568R
        the floor refused      n=  81  PF 1.33  +0.0990R

    The floor refused 2.9% of entries and they were no worse than the
    rest. The score itself does predict return across its range, so it
    still sets the lot and the ticket count - the same data gives
    +156.4R quality-sized against +135.8R flat at the same average
    size. What it no longer does is refuse.
    """
    t = _trader()
    sent: list[dict] = []

    async def _execute(request):
        sent.append(dict(request))
        return {"ok": True}

    t.execute = _execute
    t.signal_quality = lambda symbol, side, conf=0.0: {"score": 0.2, "reasons": ["ai against"]}
    asyncio.run(t._dispatch_signal(StrategySignal("buy", "EURUSD", volume=0.10), "strategy:test"))
    assert sent, "a weak signal is still a signal and must reach the broker"
    assert not any(item["code"] == "low_quality" for item in t.robot_log), \
        "the floor is refusing entries again"
    # Weak, so it goes out at the small end of the 60%-100% band.
    assert sent[0]["volume"] < 0.10, f"a weak setup was not sized down: {sent[0]['volume']}"
    assert sent[0]["volume"] >= 0.01


def test_quality_score_reacts_to_the_ai_read() -> None:
    t = _trader()
    t._higher_tf_bias = lambda symbol: ("bull", 1.0)
    t.ai.by_symbol = {
        "EURUSD": {"ready": True, "direction": "bull", "confidence": 0.9, "features": {}, "regime_obj": {"name": "trend"}}
    }
    good = t.signal_quality("EURUSD", "buy", 0.8)
    bad = t.signal_quality("EURUSD", "sell", 0.8)
    assert good["score"] > bad["score"]
    assert good["score"] >= 0.7
