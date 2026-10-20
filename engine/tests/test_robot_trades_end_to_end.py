"""The whole path, once, for real: EA attaches -> bar closes -> order sent.

Everything else in this suite tests one link of the chain, most of it by
reading the source. That is why the chain could be broken for weeks and
every test stayed green: the spread gate - the last filter before an
entry is sized - called ``tick.get("bid")`` on a Tick dataclass, which
raises AttributeError, which is not in the exception list that method was
written to survive. The exception came out of _dispatch_signal, out of
_run_enabled_strategies, and landed in the closed-bar handler's "strategy
book crashed" branch. Every signal, on every bar, on every symbol. The
robot never traded, and the only clue was one log line with a Python type
name in it.

So this one is an integration test and makes no apology for it. It builds
the real Trader, with the real MT5 bridge, feeds it exactly the JSON an
attached AurionBridge posts - hello, account, history, tick, closed bar -
arms the robot, and asserts that something reaches send_order. Nothing is
stubbed except the socket to MetaTrader and the history request that
would otherwise wait eight seconds for a terminal that is not there.

If this fails, the robot does not trade. That is the entire contract.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


# --------------------------------------------------------------- fixtures --

def _fresh_engine(tmp: Path):
    """An engine whose data and config live in a throwaway directory.

    config.DATA_DIR is read at import time, so the modules have to go
    before the environment changes. conftest puts the environment back.
    """
    (tmp / "data").mkdir(parents=True, exist_ok=True)
    (tmp / "config").mkdir(parents=True, exist_ok=True)
    factory = ROOT.parent / "config" / "aurion.factory.json"
    if factory.exists():
        (tmp / "config" / "aurion.factory.json").write_bytes(factory.read_bytes())
    os.environ["AURION_DATA_DIR"] = str(tmp / "data")
    os.environ["AURION_CONFIG_DIR"] = str(tmp / "config")
    for name in [m for m in list(sys.modules) if m.startswith("aurion")]:
        del sys.modules[name]
    from aurion.runtime.trader import Trader

    return Trader


def _bars(count: int = 320, minutes: int = 15, start: float = 1.1000, step: float = 0.0002):
    """A plain rising series. The strategies are not under test here."""
    rows = []
    first = int(time.time()) // 60 * 60 - count * minutes * 60
    price = start
    for i in range(count):
        close = price + step
        rows.append(
            {
                "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(first + i * minutes * 60)),
                "open": round(price, 5),
                "high": round(max(price, close) + 0.0004, 5),
                "low": round(min(price, close) - 0.0004, 5),
                "close": round(close, 5),
                "volume": 500 + i,
            }
        )
        price = close
    return rows


class _AlwaysBuys:
    """A strategy with no opinion to form, so a hold can only be a gate."""

    name = "always"
    params: dict = {}

    def __init__(self):
        from aurion.strategy.base import StrategySignal

        self._Signal = StrategySignal

    def on_candle(self, ctx):
        price = float(ctx.candles[-1]["close"])
        return self._Signal(
            action="buy",
            symbol=ctx.symbol,
            volume=0.10,
            sl=round(price - 0.0030, 5),
            tp=round(price + 0.0060, 5),
            confidence=0.9,
            reason="integration test",
        )


async def _drive(Trader, strategy):
    """Attach an EA, arm the robot, close a bar. Returns (orders, journal)."""
    trader = Trader()
    sent: list[dict] = []

    async def send_order(request):
        sent.append(dict(request))
        return {"ok": True, "deal": 4242, "price": float(request.get("price") or 1.1)}

    async def no_history(*_args, **_kwargs):
        return []

    trader.bridge.send_order = send_order
    trader.bridge._request_ea_history = no_history   # no terminal to ask
    trader.bridge.on_event(trader._on_bridge)

    symbol, timeframe = "EURUSD", "M15"
    rows = _bars()
    await trader.bridge.ingest_http(
        {
            "type": "hello", "chart_id": "101", "symbol": symbol, "timeframe": 15,
            "timeframe_name": timeframe, "ea_name": "AurionBridge", "version": "1.18",
            "spec": {"tick_value": 1.0, "tick_size": 0.00001, "point": 0.00001, "digits": 5,
                     "volume_min": 0.01, "volume_step": 0.01, "contract_size": 100000},
        }
    )
    await trader.bridge.ingest_http(
        {"type": "account", "balance": 10000, "equity": 10000, "margin_free": 9000,
         "currency": "USD", "login": 1, "server": "Demo", "leverage": 100}
    )
    await trader.bridge.ingest_http(
        {"type": "candles", "chart_id": "101", "symbol": symbol, "timeframe": 15,
         "timeframe_name": timeframe, "bars": rows[:-1], "final": True}
    )
    await trader.bridge.ingest_http(
        {"type": "tick", "chart_id": "101", "symbol": symbol, "time": rows[-1]["time"],
         "bid": rows[-1]["close"], "ask": round(rows[-1]["close"] + 0.00010, 5)}
    )

    # Prop rules off, and deliberately so: the shipped challenge profile
    # only trades 07:00-20:00 UTC, and a test whose answer depends on the
    # hour it runs at is not a test. The prop book has its own file.
    trader.prop.enabled = False
    trader.auto_trade = True
    trader.kill_switch = False
    trader.safe_mode = False
    trader.require_ai_agree = False
    trader.book = {
        strategy.name: {"inst": strategy, "enabled": True, "kind": "builtin",
                        "last_action": "idle", "last_reason": "", "last_ts": ""}
    }

    last = rows[-1]
    await trader.bridge.ingest_http(
        {"type": "candle", "chart_id": "101", "symbol": symbol, "timeframe": 15,
         "timeframe_name": timeframe, "closed": True, **last}
    )
    # The entry path sleeps between tickets when it opens more than one.
    await asyncio.sleep(0.2)
    return sent, list(trader.robot_log), trader


@pytest.fixture()
def engine():
    with tempfile.TemporaryDirectory() as tmp:
        yield _fresh_engine(Path(tmp))


# ------------------------------------------------------------------ tests --

def test_a_signal_on_a_closed_bar_reaches_the_broker(engine):
    sent, journal, _ = asyncio.run(_drive(engine, _AlwaysBuys()))

    if not sent:
        said = " | ".join(f"{row.get('code')}: {row.get('message')}" for row in journal[-8:])
        pytest.fail("the robot produced a signal and sent nothing — " + said)

    order = sent[0]
    assert str(order.get("symbol")) == "EURUSD"
    assert str(order.get("side") or order.get("action")) in {"buy", "market"}
    assert float(order.get("volume") or 0) > 0


def test_nothing_in_the_entry_path_raised(engine):
    """A fault on the way to the broker is a silent robot, so name it."""
    _, journal, _ = asyncio.run(_drive(engine, _AlwaysBuys()))
    faults = [row for row in journal
              if row.get("code") in {"book_fault", "dispatch_fault", "event_fault", "strategy_fault"}]
    assert not faults, faults


def test_the_gates_are_all_open_when_an_ea_is_attached(engine):
    """The five blockers, read from a live engine rather than from source."""
    _, _, trader = asyncio.run(_drive(engine, _AlwaysBuys()))
    assert trader.bridge.tape_mode() == "live"
    assert [a.symbol for a in trader.bridge.active_agents()] == ["EURUSD"]
    assert trader.fire_blockers() == []


def test_the_spread_gate_reads_a_live_quote_whatever_shape_it_is_in(engine):
    """The exact defect that stopped every entry, pinned from both sides."""
    _, _, trader = asyncio.run(_drive(engine, _AlwaysBuys()))

    # A Tick dataclass, which is what the bridge actually stores.
    quote = trader.tick_of("EURUSD")
    assert quote.get("bid") and quote.get("ask")
    assert trader._spread_ok("EURUSD")[0] is True

    # A broker that renames the instrument.
    assert trader.tick_of("EURUSD.m").get("bid") == quote.get("bid")

    # A plain dict, which is what every test and the desk hand around.
    trader.bridge.ticks = {"EURUSD": {"symbol": "EURUSD", "bid": 1.1, "ask": 1.1001}}
    trader.bridge.public_ticks = lambda: trader.bridge.ticks
    assert trader.tick_of("EURUSD").get("ask") == 1.1001
    assert trader._spread_ok("EURUSD")[0] is True

    # And no quote at all is not evidence of a bad spread.
    trader.bridge.public_ticks = lambda: {}
    trader.bridge.ticks = {}
    assert trader.tick_of("EURUSD") == {}
    assert trader._spread_ok("EURUSD")[0] is True
