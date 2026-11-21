"""Two engine faults: a robot that would not trade, and a period that was not the period.

ONE. "When every strategy is off, the robot should enter on its own."
An empty book was a dead desk: ``_run_enabled_strategies`` wrote "no
strategy enabled" and returned, so switching off the last strategy was
an off switch for the whole product rather than a choice about method.
The robot the backtest has always been able to run on its own -
``{"kind": "robot"}``, the model's own read of the bar with the live
confidence floor as its only setting - now stands in. It never competes
with a strategy: the moment one is enabled, that strategy is the
opinion.

TWO. "I set a date and I can see it backtesting some other date."
``_slice_bars`` prepends up to 400 bars of run-up before the chosen
start and reports how many in ``window["warmup"]``. The caller dropped
that number and passed a hard-coded 80 to the replay, so about 320
run-up bars were traded as if they were inside the requested period,
and ``data.first_bar`` was the first bar HANDED OVER rather than the
first bar traded. Both halves are checked below against the real
Backtester rather than against the source.

Run:
    python3 -m pytest engine/tests/test_solo_robot_and_period.py -q
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
    """An engine whose data and config live in a throwaway directory."""
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
    """A plain rising series. Nothing here is a market opinion."""
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


async def _drive(Trader, *, solo: bool):
    """Attach an EA, arm the robot, close a bar — with an EMPTY book."""
    trader = Trader()
    sent: list[dict] = []

    async def send_order(request):
        sent.append(dict(request))
        return {"ok": True, "deal": 4242, "price": float(request.get("price") or 1.1)}

    async def no_history(*_args, **_kwargs):
        return []

    trader.bridge.send_order = send_order
    trader.bridge._request_ea_history = no_history
    trader.bridge.on_event(trader._on_bridge)

    symbol, timeframe = "EURUSD", "M15"
    rows = _bars()
    await trader.bridge.ingest_http(
        {
            "type": "hello", "chart_id": "101", "symbol": symbol, "timeframe": 15,
            "timeframe_name": timeframe, "ea_name": "AurionBridge", "version": "1.20",
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

    trader.prop.enabled = False
    trader.auto_trade = True
    trader.kill_switch = False
    trader.safe_mode = False
    trader.require_ai_agree = False
    trader.solo_robot = solo
    # Nothing enabled. That is the whole point of this file.
    trader.book = {}
    # The robot's one input is the model's read of the bar. The model
    # itself is not under test here - whether the robot is ASKED is.
    trader._ai_for = lambda _symbol="": {
        "ready": True, "direction": "bull", "confidence": 0.82,
        "symbol": "EURUSD", "state": "trend",
    }

    last = rows[-1]
    await trader.bridge.ingest_http(
        {"type": "candle", "chart_id": "101", "symbol": symbol, "timeframe": 15,
         "timeframe_name": timeframe, "closed": True, **last}
    )
    await asyncio.sleep(0.2)
    return sent, list(trader.robot_log), trader


@pytest.fixture()
def engine():
    with tempfile.TemporaryDirectory() as tmp:
        yield _fresh_engine(Path(tmp))


# ------------------------------------------------- one: nobody but the robot


def test_an_empty_book_still_trades_when_the_robot_may_go_alone(engine):
    sent, journal, _ = asyncio.run(_drive(engine, solo=True))
    said = " | ".join(f"{row.get('code')}: {row.get('message')}" for row in journal[-10:])
    codes = [row.get("code") for row in journal]
    # The contract is that the robot is ASKED and its answer is
    # dispatched. Whether the broker then takes it is a different gate
    # - the weekend one, among others - and a test whose result
    # depends on the day it is run at is not a test.
    assert "no_strategy" not in codes, "the empty book is still a dead desk — " + said
    assert "dispatch" in codes, "the robot's signal never reached the broker path — " + said
    if sent:
        order = sent[0]
        assert str(order.get("symbol")) == "EURUSD"
        assert str(order.get("side") or order.get("action")) in {"buy", "market"}
        assert float(order.get("volume") or 0) > 0


def test_the_ticket_says_the_robot_sent_it(engine):
    """Not a strategy name a trader would go looking for in the list."""
    _, journal, trader = asyncio.run(_drive(engine, solo=True))
    said = " ".join(str(row.get("message") or "") for row in journal)
    assert "robot" in said.lower(), said[-400:]
    last = dict(getattr(trader, "last_signal", {}) or {})
    if last:
        assert "robot" in str(last.get("strategy") or last.get("source") or "")


def test_switching_solo_off_restores_the_old_silence(engine):
    """The trader can still have a desk that does nothing without a strategy."""
    sent, journal, _ = asyncio.run(_drive(engine, solo=False))
    assert not sent, "the robot traded with solo trading switched off"
    codes = [row.get("code") for row in journal]
    assert "no_strategy" in codes, codes[-8:]


def test_one_enabled_strategy_takes_the_decision_back(engine):
    """The robot stands down the moment anything else has an opinion."""
    Trader = engine
    trader = Trader()
    trader.solo_robot = True
    trader.book = {"ema_rsi": {"inst": object(), "enabled": True, "kind": "builtin"}}
    gate = trader.trade_gate()
    assert gate["strategies"] == ["ema_rsi"]
    assert gate["solo_robot"] is False


def test_the_gate_names_the_robot_instead_of_calling_the_desk_unarmed(engine):
    Trader = engine
    trader = Trader()
    trader.book = {}
    trader.solo_robot = True
    gate = trader.trade_gate()
    assert "no_strategy" not in gate["reasons"], gate["reasons"]
    assert gate["strategies"] == ["robot"]
    assert gate["solo_robot"] is True

    trader.solo_robot = False
    off = trader.trade_gate()
    assert "no_strategy" in off["reasons"]
    assert off["strategies"] == []


def test_the_robot_slot_is_built_once_and_uses_the_live_floor(engine):
    Trader = engine
    trader = Trader()
    trader.min_ai_confidence = 0.61
    first = trader._solo_robot_slot()
    assert first is not None
    assert float(first["inst"].params["min_confidence"]) == pytest.approx(0.61)
    assert trader._solo_robot_slot() is first, "the robot is rebuilt on every bar"

    trader.solo_robot = False
    assert trader._solo_robot_slot() is None


# --------------------------------------------- two: the period that was asked


def _ohlc(count: int, start_day: str = "2024-01-01"):
    """Daily bars, one per day, so a date range is countable by eye."""
    import datetime as dt

    day = dt.date.fromisoformat(start_day)
    rows = []
    price = 100.0
    for i in range(count):
        close = price + (1.0 if i % 3 else -0.5)
        rows.append({
            "time": (day + dt.timedelta(days=i)).isoformat() + "T00:00:00Z",
            "open": price, "high": max(price, close) + 0.5,
            "low": min(price, close) - 0.5, "close": close, "volume": 100,
        })
        price = close
    return rows


def test_the_slice_reports_how_much_of_what_it_returns_is_run_up():
    from aurion.runtime.trader import _slice_bars

    bars = _ohlc(400)
    window = _slice_bars(bars, "2024-06-01", "2024-06-30")
    assert window["from"] == "2024-06-01"
    assert window["to"] == "2024-06-30"
    assert window["warmup"] > 0, "the run-up is not reported, so it cannot be skipped"
    # The bars handed over are the run-up plus the month itself.
    assert len(window["bars"]) == window["warmup"] + 30


def test_the_replay_starts_on_the_day_the_trader_picked():
    """The actual bug: 320 run-up bars traded as if inside the period."""
    from aurion.backtest.engine import Backtester
    from aurion.runtime.trader import _slice_bars

    bars = _ohlc(400)
    window = _slice_bars(bars, "2024-06-01", "2024-06-30")
    warmup = int(window["warmup"])

    result = Backtester().run(
        _QuietStrategy(), window["bars"], "EURUSD", "D1", 10_000.0, warmup=warmup,
    )
    data = result.get("data") or {}
    assert str(data.get("first_bar") or "")[:10] == "2024-06-01", data
    # The run-up is disclosed rather than hidden or counted as tested.
    assert str(data.get("warmup_from") or "")[:10] < "2024-06-01", data


def test_a_period_at_the_very_start_of_history_still_runs():
    """Clamping, not refusing: there is no 400 bars of run-up to be had."""
    from aurion.backtest.engine import Backtester
    from aurion.runtime.trader import _slice_bars

    bars = _ohlc(60)
    window = _slice_bars(bars, "2024-01-01", "2024-01-31")
    assert int(window["warmup"]) == 0
    result = Backtester().run(
        _QuietStrategy(), window["bars"], "EURUSD", "D1", 10_000.0,
        warmup=min(80, max(1, len(window["bars"]) - 5)),
    )
    assert result.get("ok") is not False, result


def _quiet_strategy():
    """A strategy with no opinion, so the only thing the replay reports
    is WHICH bars it walked."""
    from aurion.strategy.base import BaseStrategy

    class _Quiet(BaseStrategy):
        name = "quiet"
        version = "1.0.0"
        warmup_bars = 0
        params: dict = {}

        def on_candle(self, ctx):
            return None

    return _Quiet({})


_QuietStrategy = _quiet_strategy
