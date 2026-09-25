"""Regression checks for the operational bugfix pass."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.ai.features import build_feature_frame
from aurion.mt5.bridge import MT5Bridge
from aurion.mt5.types import Position
from aurion.prop.rules import PropEngine
from aurion.strategy.loader import StrategyLoader


def test_ea_frame_types() -> None:
    assert MT5Bridge._ea_frame_type({"action": "close"}) == "close"
    assert MT5Bridge._ea_frame_type({"action": "buy"}) == "order"
    assert MT5Bridge._ea_frame_type({"action": "market", "side": "sell"}) == "order"
    assert MT5Bridge._ea_frame_type({"action": "modify"}) == "modify"
    assert MT5Bridge._ea_frame_type({"action": "flatten"}) == "flatten"


def test_native_close_without_volume() -> None:
    bridge = MT5Bridge()
    bridge.positions = [
        Position(
            ticket=42,
            symbol="EURUSD",
            type="buy",
            volume=0.1,
            price_open=1.1,
            price_current=1.1,
            sl=0,
            tp=0,
            profit=0,
            swap=0,
            time="",
            magic=1,
            comment="",
        )
    ]
    # Without MT5 package this still validates the pre-check path.
    try:
        built = bridge._to_native_request({"action": "close", "ticket": 42})
    except ModuleNotFoundError:
        return
    assert built.get("error") != "symbol and volume are required"


def test_prop_does_not_reflatten() -> None:
    prop = PropEngine()
    account = {"equity": 9000, "balance": 10000}
    prop.day_start_equity = 10000
    prop.high_water = 10000
    prop.day_stamp = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%d")
    first = prop.evaluate_account(account, [])
    assert first["ok"] is False
    assert "flatten" in (first.get("action") or "") or first.get("action") == "lock"
    second = prop.evaluate_account(account, [])
    assert second.get("action") == "none"


def test_features_survive_flat_volume_and_mt5_time() -> None:
    rows = []
    price = 1.1000
    for i in range(80):
        price += 0.0002 if i % 3 else -0.0001
        rows.append(
            {
                "time": f"2026.08.18 {10 + i // 60:02d}:{i % 60:02d}:00",
                "open": price,
                "high": price + 0.0004,
                "low": price - 0.0003,
                "close": price + 0.0001,
                "volume": 100,
            }
        )
    frame = build_feature_frame(rows)
    assert len(frame) > 20, f"feature frame collapsed to {len(frame)} rows"


def test_loader_build_isolated() -> None:
    loader = StrategyLoader()
    inst = loader.build({"kind": "builtin", "name": "ema_rsi", "params": {"volume": 0.2}})
    assert inst.name == "ema_rsi"
    assert inst.params["volume"] == 0.2


def test_forming_candle_is_not_closed() -> None:
    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader._last_bar_time = {}
    trader.active_timeframe = "M15"
    assert trader._is_closed_bar({"closed": False, "symbol": "EURUSD", "time": "t0"}) is False
    assert trader._is_closed_bar({"closed": True, "symbol": "EURUSD", "time": "t0"}) is True
    assert trader._is_closed_bar({"symbol": "XAUUSD", "timeframe": "M15", "time": "a"}) is False
    assert trader._is_closed_bar({"symbol": "XAUUSD", "timeframe": "M15", "time": "b"}) is True


def test_pull_candles_refuses_market_watch() -> None:
    import asyncio

    bridge = MT5Bridge()
    assert bridge.is_ea_symbol("EURUSD") is False
    rows = asyncio.run(bridge.pull_candles("EURUSD", "M15"))
    assert rows == []


def test_tick_without_hello_creates_visible_agent() -> None:
    import asyncio

    bridge = MT5Bridge()

    async def run() -> None:
        await bridge._on_ea_message(None, {
            "type": "tick",
            "chart_id": 42,
            "symbol": "XAUUSD",
            "bid": 2300.1,
            "ask": 2300.3,
            "time": "2026-08-19T10:00:00",
        })

    asyncio.run(run())
    agents = bridge.online_agents()
    assert any(a.symbol == "XAUUSD" for a in agents)
    assert "XAUUSD" in bridge.public_ticks()


def test_nul_terminated_hello_ingests() -> None:
    import asyncio
    from aurion.mt5.protocol import parse_ea_json

    raw = b'{"type":"hello","chart_id":"132580123456789012","symbol":"XAUUSD","timeframe_name":"M15","timeframe":15}\x00junk'
    obj = parse_ea_json(raw)
    assert isinstance(obj, dict)
    assert obj["symbol"] == "XAUUSD"
    assert obj["chart_id"] == "132580123456789012"

    bridge = MT5Bridge()

    async def run() -> None:
        result = await bridge.ingest_http(raw)
        assert result.get("ok") is True

    asyncio.run(run())
    agents = bridge.online_agents()
    assert any(a.symbol == "XAUUSD" for a in agents)
    assert bridge._cid("132580123456789012") == 132580123456789012
    assert bridge._cid("nope") == 0


def test_candle_upsert_dedupes_and_sorts() -> None:
    from aurion.mt5.types import Candle

    bridge = MT5Bridge()
    a = Candle("XAUUSD", "M15", "2026-08-19T10:00:00", 0, 1, 2, 0.5, 1.5, 10)
    b = Candle("XAUUSD", "M15", "2026-08-19T10:15:00", 0, 1.5, 2.5, 1.4, 2.0, 10)
    a2 = Candle("XAUUSD", "M15", "2026-08-19T10:00:00", 0, 1, 2.2, 0.5, 1.8, 12)
    bridge._put_candle(b)
    bridge._put_candle(a)
    bridge._put_candle(a2)
    rows = list(bridge.candles[("XAUUSD", "M15")])
    assert [c.time for c in rows] == ["2026-08-19T10:00:00", "2026-08-19T10:15:00"]
    assert rows[0].close == 1.8


def test_desk_order_skips_per_symbol_cap() -> None:
    from aurion.prop.rules import PropEngine

    prop = PropEngine()
    prop.set_profile({"id": "conservative"})
    prop.profile["trading_hours"] = {"start": "00:00", "end": "23:59", "weekdays": [0, 1, 2, 3, 4, 5, 6]}
    prop.profile["allow_weekend"] = True
    account = {"equity": 10000, "balance": 10000}
    positions = [{"symbol": "XAUUSD", "type": "buy", "volume": 0.1, "ticket": 1}]
    blocked = prop.allow_order({"action": "buy", "symbol": "XAUUSD", "volume": 0.1, "source": "robot"}, account, positions)
    assert blocked.get("ok") is False
    allowed = prop.allow_order({"action": "buy", "symbol": "XAUUSD", "volume": 0.1, "source": "desk"}, account, positions)
    assert allowed.get("ok") is True


def test_position_profit_pct() -> None:
    from aurion.mt5.types import Position

    buy = Position(1, "XAUUSD", "buy", 0.1, 2000, 2020, 0, 0, 10, 0, "", 1, "")
    sell = Position(2, "XAUUSD", "sell", 0.1, 2000, 1980, 0, 0, 10, 0, "", 1, "")
    assert abs(buy.to_dict()["profit_pct"] - 1.0) < 1e-9
    assert abs(sell.to_dict()["profit_pct"] - 1.0) < 1e-9


def test_file_inbox_blob_creates_agent() -> None:
    import asyncio

    bridge = MT5Bridge()
    blob = (
        b'{"type":"hello","chart_id":"7","symbol":"XAUUSD","timeframe_name":"M5"}\n'
        b'{"type":"tick","chart_id":"7","symbol":"XAUUSD","bid":2401.2,"ask":2401.4,"time":"2026-08-19T12:00:00"}\n'
    )

    async def run() -> None:
        n = await bridge._ingest_raw_blob(blob)
        assert n == 2

    asyncio.run(run())
    assert any(a.symbol == "XAUUSD" for a in bridge.public_agents())
    assert "XAUUSD" in bridge.public_ticks()


def test_position_matches_broker_suffix() -> None:
    from aurion.strategy.base import StrategyContext

    ctx = StrategyContext(
        symbol="EURUSD",
        timeframe="M15",
        candles=[],
        tick=None,
        account={},
        positions=[{"symbol": "EURUSDm", "type": "buy", "volume": 0.1}],
        orders=[],
        ai={},
        params={},
        now="",
    )
    pos = ctx.position()
    assert pos is not None
    assert pos["symbol"] == "EURUSDm"


def test_locked_presets_are_distinct_and_sealed() -> None:
    from aurion.prop.profiles import LOCKED_IDS, get_profile
    from aurion.prop.rules import PropEngine

    sigs = set()
    for name in LOCKED_IDS:
        pr = get_profile(name)
        assert pr["locked"] is True
        sigs.add((pr["max_daily_loss_pct"], pr["max_drawdown_pct"], pr["max_lot"], pr["max_open_trades"], pr["news_filter"], pr["hedging_allowed"]))
    assert len(sigs) == len(LOCKED_IDS)
    engine = PropEngine()
    applied = engine.set_profile({"id": "ftmo_challenge", "max_lot": 99})
    assert applied["id"] == "ftmo_challenge"
    assert applied["max_lot"] == 2.0
    assert applied["locked"] is True


def test_parse_strategy_tag() -> None:
    from aurion.runtime.store import parse_strategy_tag

    assert parse_strategy_tag("AURION ema_rsi") == "ema_rsi"
    assert parse_strategy_tag("AURION price_action") == "price_action"
    assert parse_strategy_tag("AURION atr_breakout") == "atr_breakout"
    assert parse_strategy_tag("AURION scalp_impulse") == "scalp_impulse"
    assert parse_strategy_tag("AURION desk") == ""
    assert parse_strategy_tag("AURION close") == ""
    assert parse_strategy_tag("") == ""
    assert parse_strategy_tag("AURION my_flow") == "my_flow"


def test_strategy_stats_and_close_dedupe() -> None:
    import tempfile
    from pathlib import Path

    from aurion.runtime.store import Store

    tmp = Path(tempfile.mkdtemp()) / "ledger.db"
    store = Store(tmp)
    first = store.record_trade(
        {
            "ticket": 77,
            "symbol": "XAUUSD",
            "side": "buy",
            "profit": 12.5,
            "comment": "AURION ema_rsi",
            "kind": "close",
            "entry": "out",
        }
    )
    second = store.record_trade(
        {
            "ticket": 77,
            "symbol": "XAUUSD",
            "side": "buy",
            "profit": 12.5,
            "comment": "AURION ema_rsi",
            "kind": "close",
            "entry": "out",
        }
    )
    store.record_trade(
        {
            "ticket": 78,
            "symbol": "XAUUSD",
            "side": "sell",
            "profit": -4,
            "comment": "AURION ema_rsi",
            "kind": "close",
            "entry": "out",
        }
    )
    store.record_trade(
        {
            "ticket": 79,
            "symbol": "XAUUSD",
            "side": "buy",
            "profit": 0,
            "comment": "AURION ema_rsi",
            "kind": "entry",
            "entry": "in",
        }
    )
    assert first is True
    assert second is False
    stats = store.strategy_stats(["ema_rsi", "desk"])
    assert stats["ema_rsi"]["trades"] == 2
    assert stats["ema_rsi"]["wins"] == 1
    assert stats["ema_rsi"]["losses"] == 1
    assert abs(stats["ema_rsi"]["net"] - 8.5) < 1e-9
    assert abs(stats["ema_rsi"]["win_rate"] - 50.0) < 1e-9
    hist = store.history()
    assert any(r.get("strategy") == "ema_rsi" for r in hist)
    store.close()


def test_persist_state_roundtrip() -> None:
    from aurion.config import STATE_PATH, load, merge

    before = load()
    prev_auto = bool((before.get("runtime") or {}).get("auto_trade"))
    prev_style = str((before.get("runtime") or {}).get("trade_style") or "normal")
    try:
        merge({"runtime": {"auto_trade": True, "trade_style": "scalping"}})
        assert STATE_PATH.exists()
        again = load(force=True)
        assert again["runtime"]["auto_trade"] is True
        assert again["runtime"]["trade_style"] == "scalping"
    finally:
        merge({"runtime": {"auto_trade": prev_auto, "trade_style": prev_style}})


def test_features_include_macd_and_hour() -> None:
    from aurion.ai.features import FEATURE_COLUMNS, build_feature_frame

    assert "macd" in FEATURE_COLUMNS
    assert "hour_sin" in FEATURE_COLUMNS
    rows = []
    price = 1.1000
    for i in range(90):
        price += 0.0002 if i % 3 else -0.0001
        rows.append(
            {
                "time": f"2026.08.18 {10 + i // 60:02d}:{i % 60:02d}:00",
                "open": price,
                "high": price + 0.0004,
                "low": price - 0.0003,
                "close": price + 0.0001,
                "volume": 100,
            }
        )
    frame = build_feature_frame(rows)
    assert "macd" in frame.columns
    assert "hour_sin" in frame.columns
    assert len(frame) > 20


def test_sync_position_book_writes_history() -> None:
    import asyncio
    import tempfile
    from collections import deque
    from pathlib import Path

    from aurion.runtime.store import Store
    from aurion.runtime.trader import Trader

    tmp = Path(tempfile.mkdtemp()) / "book.db"
    trader = Trader.__new__(Trader)
    trader.store = Store(tmp)
    trader._known_pos = {
        11: {
            "ticket": 11,
            "symbol": "EURUSD",
            "type": "buy",
            "volume": 0.2,
            "profit": 3.5,
            "comment": "AURION price_action",
            "strategy": "price_action",
            "price_current": 1.1,
        }
    }
    trader._pending_tag = []
    trader._closed_tickets = set()
    trader.book = {}
    trader.strategy = None
    trader.auto_trade = False
    trader.robot_log = deque(maxlen=10)
    trader.prop = type("P", (), {"note_closed_trade": lambda self, x: None})()

    async def dummy(*_a, **_k):
        return None

    trader.journal = dummy
    trader.bus = type("B", (), {"publish": dummy})()
    trader.strategy_meta = {}
    trader._sync_book_meta = lambda: None
    asyncio.run(trader._sync_position_book([]))
    hist = trader.store.history()
    assert any(int(r.get("ticket") or 0) == 11 for r in hist)
    assert any(r.get("strategy") == "price_action" for r in hist)
    trader.store.close()



def test_deals_are_not_written_to_store() -> None:
    import asyncio
    import tempfile
    from collections import deque
    from pathlib import Path

    from aurion.runtime.store import Store
    from aurion.runtime.trader import Trader

    tmp = Path(tempfile.mkdtemp()) / "nodeals.db"
    trader = Trader.__new__(Trader)
    trader.store = Store(tmp)
    trader._known_pos = {}
    trader._closed_tickets = set()
    trader.book = {}
    trader.strategy_meta = {}
    trader.robot_log = deque(maxlen=10)

    published = []

    async def pub(*args, **kwargs):
        published.append(args[0] if args else kwargs.get("kind"))

    class B:
        async def publish(self, kind, payload=None):
            published.append(kind)
    trader.bus = B()
    trader._sync_book_meta = lambda: None
    asyncio.run(
        trader._on_bridge(
            "deals",
            {
                "items": [
                    {
                        "ticket": 9001,
                        "position_id": 9001,
                        "symbol": "XAUUSD",
                        "type": "buy",
                        "entry": "out",
                        "profit": 42.0,
                        "comment": "manual broker",
                    }
                ]
            },
        )
    )
    hist = trader.store.history()
    assert not any(int(r.get("ticket") or 0) == 9001 for r in hist)
    assert "deals" in published
    trader.store.close()


def test_ea_has_send_deals_v117() -> None:
    src = (ROOT / "engine" / "ea" / "AurionBridge.mq5").read_text(encoding="utf-8")
    assert "#property version   \"1.17\"" in src
    assert "void SendDeals()" in src
    assert "HistoryDealGetTicket" in src
    assert "HistorySelect" in src
    assert src.count("SendDeals();") >= 2
    assert "InpHeartbeatMs" in src
    # Heartbeat must not flood deals every second.
    beat = src.split("if(now - g_last_beat")[1].split("}", 1)[0]
    assert "SendDeals" not in beat
    assert "Extract(line, \"comment\")" in src
    # v1.17: instant position push on trade transactions…
    assert "void OnTradeTransaction(" in src
    # …and every message type carries the tester tag so the engine can keep
    # the backtest tape apart from the live chart.
    for sender in ("SendPositions", "SendOrders", "SendDeals", "SendAccount"):
        fn = src.split(f"void {sender}()", 1)[1]
        assert "TapeTag()" in fn, f"{sender} must tag its tape"


def test_tape_separation_live_and_tester() -> None:
    """Live chart and Strategy Tester chart must never share desk state."""
    import asyncio

    bridge = MT5Bridge()

    async def run() -> None:
        live_hello = {
            "type": "hello", "chart_id": "101", "symbol": "XAUUSD",
            "timeframe_name": "M15", "timeframe": 15, "tester": False,
        }
        tester_hello = {
            "type": "hello", "chart_id": "202", "symbol": "XAUUSD",
            "timeframe_name": "M15", "timeframe": 15, "tester": True,
        }
        await bridge.ingest_http(live_hello)
        assert bridge.tape_mode() == "live"
        await bridge.ingest_http(tester_hello)
        # Live stays active even though a tester chart joined.
        assert bridge.active_tape() == "live"
        # Tester prices must not overwrite the live tick.
        await bridge.ingest_http({"type": "tick", "chart_id": "101", "symbol": "XAUUSD",
                                  "bid": 2400.0, "ask": 2400.5, "tester": False,
                                  "time": "2026-08-23T10:00:00"})
        await bridge.ingest_http({"type": "tick", "chart_id": "202", "symbol": "XAUUSD",
                                  "bid": 1111.0, "ask": 1111.5, "tester": True,
                                  "time": "2026-08-23T10:00:01"})
        assert bridge.ticks["XAUUSD"].bid == 2400.0
        assert bridge._tape_store("tester")["ticks"]["XAUUSD"].bid == 1111.0
        # Tester positions must not leak into the live book.
        await bridge.ingest_http({"type": "positions", "chart_id": "202", "tester": True, "items": [
            {"ticket": 9001, "symbol": "XAUUSD", "type": "buy", "volume": 0.1,
             "price_open": 1111.0, "price_current": 1112.0, "profit": 1.0},
        ]})
        await bridge.ingest_http({"type": "positions", "chart_id": "101", "tester": False, "items": [
            {"ticket": 42, "symbol": "XAUUSD", "type": "sell", "volume": 0.2,
             "price_open": 2401.0, "price_current": 2400.0, "profit": 2.0},
        ]})
        assert [p.ticket for p in bridge.positions] == [42]
        assert [p.ticket for p in bridge._tape_store("tester")["positions"]] == [9001]
        # Live chart leaves: the tester tape becomes the active view.
        await bridge.ingest_http({"type": "bye", "chart_id": "101", "symbol": "XAUUSD", "reason": "remove"})
        assert bridge.active_tape() == "tester"
        assert bridge.tape_mode() == "tester"
        assert [p.ticket for p in bridge.positions] == [9001]
        assert bridge.ticks["XAUUSD"].bid == 1111.0

    asyncio.run(run())


def test_single_active_strategy_toggle() -> None:
    """Enabling one strategy must disarm every other strategy."""
    import asyncio
    from collections import deque

    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader.book = {}
    trader.strategy = None
    trader.strategy_meta = {}
    trader.auto_trade = False
    trader.require_ai_agree = True
    trader.min_ai_confidence = 0.55
    trader.trade_style = "normal"
    trader.news_trade = False
    trader.prop = type("P", (), {"enabled": False})()
    trader.store = type("S", (), {"strategy_stats": staticmethod(lambda names=None: {})})()
    trader.robot_log = deque(maxlen=10)
    trader.loader = StrategyLoader()

    persisted = []

    class _Bus:
        async def publish(self, kind, payload=None):
            pass

    trader.bus = _Bus()
    trader._persist_runtime = lambda: persisted.append(True)

    async def run() -> None:
        await trader.toggle_strategy("ema_rsi", True)
        await trader.toggle_strategy("price_action", True)
        on = [k for k, v in trader.book.items() if v.get("enabled")]
        assert on == ["price_action"], on
        await trader.toggle_strategy("price_action", False)
        assert not [k for k, v in trader.book.items() if v.get("enabled")]

    asyncio.run(run())



def test_telegram_status_open_close_text() -> None:
    from aurion.telegram.bot import format_close, format_open, format_status, is_masked_token, mask_token

    snap = {
        "engine": "online",
        "kill_switch": False,
        "auto_trade": False,
        "mt5": {"connected": True, "account": {"login": 1001, "server": "Broker", "balance": 10000, "equity": 10040, "profit": 40, "currency": "USD"}},
        "agents": [{"symbol": "XAUUSD"}],
        "positions": [{"ticket": 55, "symbol": "XAUUSD", "type": "buy", "volume": 0.1, "profit": 12.5, "strategy": "@Ali"}],
        "strategy": {"auto_trade": False},
    }
    fa = format_status(snap, "fa")
    assert "XAUUSD" in fa
    assert "1001" in fa
    assert "+12.50" in fa
    opened = format_open({"ticket": 55, "symbol": "XAUUSD", "type": "buy", "volume": 0.1, "price_open": 2650.2, "sl": 2640, "strategy": "ema_rsi"}, "fa")
    assert "XAUUSD" in opened
    assert "55" in opened
    closed = format_close({"ticket": 55, "symbol": "XAUUSD", "type": "buy", "volume": 0.1, "profit": -8.25, "strategy": "ema_rsi"}, "en", "USD")
    assert "Position closed" in closed
    assert "-8.25" in closed
    assert "loss" in closed
    assert mask_token("1234567890:ABCDEFGHijklmnop") != "1234567890:ABCDEFGHijklmnop"
    assert is_masked_token("123456…mnop") is True
    assert is_masked_token("1234567890:ABCDEFGHijklmnop") is False


def test_telegram_pairing_and_readonly() -> None:
    import time

    from aurion.telegram.bot import TelegramBot

    bot = TelegramBot()
    bot._pair_code = "482193"
    bot._pair_until = time.time() + 60
    saved: dict = {}
    bot._save = lambda patch: saved.update(patch)
    assert bot._try_pair(777, "/start 482193", {"first_name": "Sara", "username": "s"}) is True
    assert saved["chats"][0]["id"] == 777
    assert saved["chats"][0]["name"] == "Sara"
    bot._pair_code = "000111"
    bot._pair_until = time.time() + 60
    assert bot._try_pair(888, "/status", {}) is False


def test_telegram_skips_bootstrap_then_notifies() -> None:
    import asyncio
    import tempfile
    from collections import deque
    from pathlib import Path

    from aurion.runtime.store import Store
    from aurion.runtime.trader import Trader

    tmp = Path(tempfile.mkdtemp()) / "tg.db"
    trader = Trader.__new__(Trader)
    trader.store = Store(tmp)
    trader._known_pos = {}
    trader._pending_tag = []
    trader._closed_tickets = set()
    trader._pos_bootstrapped = False
    trader.book = {}
    trader.strategy = None
    trader.auto_trade = False
    trader.robot_log = deque(maxlen=10)
    trader.prop = type("P", (), {"note_closed_trade": lambda self, x: None})()
    notes: list[tuple] = []

    class Tg:
        async def notify_open(self, pos):
            notes.append(("open", int(pos.get("ticket") or 0)))

        async def notify_close(self, pos):
            notes.append(("close", int(pos.get("ticket") or 0), float(pos.get("profit") or 0)))

    trader.telegram = Tg()

    async def dummy(*_a, **_k):
        return None

    trader.journal = dummy
    trader.bus = type("B", (), {"publish": dummy})()
    trader.strategy_meta = {}
    trader._sync_book_meta = lambda: None

    first = {"ticket": 11, "symbol": "EURUSD", "type": "buy", "volume": 0.2, "profit": 1.5, "comment": "AURION"}
    asyncio.run(trader._sync_position_book([first]))
    assert notes == []
    assert trader._pos_bootstrapped is True
    second = {**first, "ticket": 12, "profit": 0}
    asyncio.run(trader._sync_position_book([first, second]))
    assert ("open", 12) in notes
    asyncio.run(trader._sync_position_book([second]))
    assert any(n[0] == "close" and n[1] == 11 for n in notes)
    hist = trader.store.history()
    assert any(int(r.get("ticket") or 0) == 11 for r in hist)
    trader.store.close()



def test_backtest_does_not_disable_ema_rsi() -> None:
    import asyncio
    from collections import deque

    from aurion.runtime.trader import Trader
    from aurion.strategy.loader import StrategyLoader

    trader = Trader.__new__(Trader)
    trader.loader = StrategyLoader()
    inst = trader.loader.load_builtin("ema_rsi", {})
    inst.on_start = lambda ctx: None
    inst.on_stop = lambda ctx: None
    trader.book = {
        "ema_rsi": {"inst": inst, "enabled": True, "kind": "builtin", "last_action": "idle", "last_reason": "", "last_ts": ""},
        "price_action": {"inst": trader.loader.load_builtin("price_action", {}), "enabled": False, "kind": "builtin", "last_action": "idle", "last_reason": "", "last_ts": ""},
    }
    trader.strategy = inst
    trader.auto_trade = True
    trader.require_ai_agree = True
    trader.min_ai_confidence = 0.55
    trader.trade_style = "normal"
    trader.news_trade = False
    trader.prop = type("P", (), {"enabled": False, "locked": False, "metrics": lambda self, a: {}})()
    trader.robot_log = deque(maxlen=10)
    trader.active_symbol = "XAUUSD"
    trader.active_timeframe = "M15"
    trader.store = type("S", (), {"strategy_stats": lambda self, names=None: {}, "candles": lambda self, *a, **k: []})()
    trader._persist_runtime = lambda: None
    trader._ctx = lambda *a, **k: type("C", (), {})()
    published = []

    class B:
        async def publish(self, kind, payload=None):
            published.append(kind)

    trader.bus = B()
    trader._sync_book_meta()
    assert trader.book["ema_rsi"]["enabled"] is True

    async def dummy_pull(*_a, **_k):
        return []

    trader.bridge = type("Br", (), {
        "candles_of": lambda self, *a, **k: [],
        "pull_candles": dummy_pull,
        "account": type("A", (), {"equity": 10000, "to_dict": lambda self: {}})(),
    })()
    # Isolated instance: applying a spec without enabled must keep the live flag.
    asyncio.run(trader.apply_strategy({"kind": "builtin", "name": "ema_rsi", "params": {"volume": 0.2}}))
    assert trader.book["ema_rsi"]["enabled"] is True
    # Explicit disable is still allowed.
    asyncio.run(trader.apply_strategy({"kind": "builtin", "name": "ema_rsi", "enabled": False}))
    assert trader.book["ema_rsi"]["enabled"] is False


def test_strategy_stats_go_to_cards_not_comment() -> None:
    import tempfile
    from pathlib import Path

    from aurion.runtime.store import Store

    tmp = Path(tempfile.mkdtemp()) / "stats.db"
    store = Store(tmp)
    store.record_trade({"ticket": 1, "symbol": "XAUUSD", "side": "buy", "profit": 10, "comment": "AURION ema_rsi", "kind": "close", "entry": "out"})
    store.record_trade({"ticket": 2, "symbol": "XAUUSD", "side": "sell", "profit": -4, "comment": "AURION MyFlow.py", "strategy": "MyFlow.py", "kind": "close", "entry": "out"})
    stats = store.strategy_stats(["ema_rsi", "myflow"])
    assert stats["ema_rsi"]["trades"] == 1
    assert abs(stats["ema_rsi"]["net"] - 10) < 1e-9
    assert stats["myflow"]["trades"] == 1
    hist = store.history()
    ema = next(r for r in hist if r.get("strategy") == "ema_rsi" or "ema_rsi" in str(r.get("comment")))
    assert "win_rate" not in str(ema.get("strategy") or "")
    store.close()

def test_public_agents_ignore_orphan_ticks() -> None:
    from aurion.mt5.types import Tick

    bridge = MT5Bridge()
    bridge.ticks["EURUSD"] = Tick(symbol="EURUSD", time="2026-08-21T10:00:00", bid=1.1, ask=1.2)
    assert bridge.public_agents() == []
    assert bridge.public_ticks() == {}


def test_stale_agents_need_fresh_heartbeat() -> None:
    from aurion.mt5.types import ChartAgent

    bridge = MT5Bridge()
    agent = ChartAgent(chart_id=9, symbol="EURUSD", timeframe="M15", ea_name="AurionBridge", version="1.16")
    bridge.agents[9] = agent
    assert bridge.online_agents() == []
    assert bridge.is_ea_symbol("EURUSD") is False
    assert bridge.tape_mode() == "idle"
    bridge._agent_beat[9] = 1.0
    assert bridge.online_agents() == []
    bridge._agent_beat[9] = __import__("time").time()
    assert any(a.symbol == "EURUSD" for a in bridge.online_agents())
    assert bridge.tape_mode() == "live"
    agent.params = {"tester": True, "mode": "tester"}
    assert bridge.tape_mode() == "tester"
    assert bridge.online_agents(include_tester=False) == []


def test_pull_candles_ignores_cache_without_live_ea() -> None:
    import asyncio

    from aurion.mt5.types import Candle

    bridge = MT5Bridge()
    bridge._put_candle(Candle("XAUUSD", "M15", "2026-08-19T10:00:00", 0, 1, 2, 0.5, 1.5, 10))
    assert asyncio.run(bridge.pull_candles("XAUUSD", "M15")) == []
    assert bridge.is_ea_symbol("XAUUSD") is False


def test_file_inbox_skips_stale_backlog() -> None:
    import asyncio
    import os
    import tempfile
    import time
    from pathlib import Path

    bridge = MT5Bridge()
    tmp = Path(tempfile.mkdtemp()) / "aurion_in_99.jsonl"
    tmp.write_bytes(
        b'{"type":"hello","chart_id":"99","symbol":"EURUSD","timeframe_name":"M15"}\n'
        b'{"type":"tick","chart_id":"99","symbol":"EURUSD","bid":1.1,"ask":1.2,"time":"2026-08-19T10:00:00"}\n'
    )
    os.utime(tmp, (time.time() - 120, time.time() - 120))
    n = asyncio.run(bridge._consume_inbox_file(tmp))
    assert n == 0
    assert bridge.online_agents() == []
    assert bridge._file_off[str(tmp)] == tmp.stat().st_size


def test_telegram_remote_settings() -> None:
    from aurion.telegram.bot import TelegramBot

    calls: list[tuple] = []

    class Dummy:
        def set_auto(self, body):
            calls.append(("auto", dict(body)))
            return {"ok": True}

        def set_kill(self, armed):
            calls.append(("kill", bool(armed)))
            return {"ok": True, "kill_switch": bool(armed)}

        def snapshot(self):
            return {"engine": "online", "kill_switch": False, "auto_trade": True, "tape": "live", "ai": {}}

    bot = TelegramBot(Dummy())
    assert bot._apply_desk("auto", "off")
    assert bot._apply_desk("kill", "on")
    assert bot._apply_desk("style", "scalping")
    assert ("auto", {"enabled": False}) in calls
    assert ("kill", True) in calls
    assert any(c[0] == "auto" and c[1].get("trade_style") == "scalping" for c in calls)
    kb = bot._desk_keyboard()
    data = {btn["callback_data"] for row in kb["inline_keyboard"] for btn in row}
    assert "auto:on" in data
    assert "kill:on" in data
    assert "style:scalping" in data
    assert "status" in data
    assert "ai" in data



if __name__ == "__main__":
    tests = [
        test_ea_frame_types,
        test_native_close_without_volume,
        test_prop_does_not_reflatten,
        test_features_survive_flat_volume_and_mt5_time,
        test_loader_build_isolated,
        test_forming_candle_is_not_closed,
        test_pull_candles_refuses_market_watch,
        test_tick_without_hello_creates_visible_agent,
        test_nul_terminated_hello_ingests,
        test_candle_upsert_dedupes_and_sorts,
        test_desk_order_skips_per_symbol_cap,
        test_position_profit_pct,
        test_file_inbox_blob_creates_agent,
        test_position_matches_broker_suffix,
        test_locked_presets_are_distinct_and_sealed,
        test_parse_strategy_tag,
        test_strategy_stats_and_close_dedupe,
        test_persist_state_roundtrip,
        test_features_include_macd_and_hour,
        test_sync_position_book_writes_history,
        test_deals_are_not_written_to_store,
        test_ea_has_send_deals_v117,
        test_stale_agents_need_fresh_heartbeat,
        test_pull_candles_ignores_cache_without_live_ea,
        test_file_inbox_skips_stale_backlog,
        test_telegram_remote_settings,
        test_public_agents_ignore_orphan_ticks,
        test_telegram_status_open_close_text,
        test_telegram_pairing_and_readonly,
        test_telegram_skips_bootstrap_then_notifies,
        test_backtest_does_not_disable_ema_rsi,
        test_strategy_stats_go_to_cards_not_comment,
        test_toggle_falls_back_to_custom_file_strategy,
        test_upload_registers_card_even_without_activate,
        test_update_and_delete_custom_strategy,
        test_builtin_strategies_are_read_only,
        test_reserved_and_illegal_upload_names_rejected,
        test_license_freemium_default_and_locks,
        test_license_dev_key_unlocks_premium,
        test_license_paid_key_offline_plans_and_expiry,
        test_license_expired_plan_falls_back_to_freemium,
        test_license_online_consumption_mock_server,
        test_set_auto_scalping_requires_premium,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("ok", fn.__name__)
        except Exception as exc:
            failed += 1
            print("FAIL", fn.__name__, exc)
    raise SystemExit(failed)


_CUSTOM_SRC = '''
class Flow:
    name = "flow"
    params = {"volume": 0.1}

    def __init__(self, params=None):
        self.params = dict(type(self).params)
        if params:
            self.params.update(params)

    def on_candle(self, ctx):
        return None
'''

_CUSTOM_SRC_V2 = _CUSTOM_SRC.replace('name = "flow"', 'name = "flow"  # v2')


def _bare_trader_with_loader(tmpdir):
    from collections import deque

    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader.book = {}
    trader.strategy = None
    trader.strategy_meta = {}
    trader.auto_trade = False
    trader.require_ai_agree = True
    trader.min_ai_confidence = 0.55
    trader.trade_style = "normal"
    trader.news_trade = False
    trader.prop = type("P", (), {"enabled": False})()
    trader.store = type("S", (), {"strategy_stats": staticmethod(lambda names=None: {})})()
    trader.robot_log = deque(maxlen=10)
    trader.loader = StrategyLoader()
    trader.loader.dir = Path(tmpdir)
    trader.active_symbol = "XAUUSD"
    trader.active_timeframe = "M15"
    trader._persist_runtime = lambda: None
    trader._ctx = lambda *a, **k: None

    class _Bus:
        def __init__(self):
            self.kinds = []

        async def publish(self, kind, payload=None):
            self.kinds.append(kind)

    trader.bus = _Bus()
    return trader


def test_toggle_falls_back_to_custom_file_strategy() -> None:
    """A .py sitting in the strategies folder must be toggleable — never hit the builtin lookup."""
    import asyncio
    import tempfile

    tmp = tempfile.mkdtemp()
    (Path(tmp) / "aurion_xauusd_strategy.py").write_text(_CUSTOM_SRC, encoding="utf-8")
    trader = _bare_trader_with_loader(tmp)

    async def run():
        r = await trader.toggle_strategy("aurion_xauusd_strategy", True)
        assert r.get("ok"), r
        slot = trader.book["aurion_xauusd_strategy"]
        assert slot["enabled"] is True
        assert slot["kind"] == "file"
        names = [i["name"] for i in trader.strategy_meta["items"]]
        assert "aurion_xauusd_strategy" in names
        r2 = await trader.toggle_strategy("does_not_exist", True)
        assert r2.get("ok") is False

    asyncio.run(run())


def test_upload_registers_card_even_without_activate() -> None:
    """Upload → apply(enabled=False): the card shows up, nothing is armed."""
    import asyncio
    import tempfile

    tmp = tempfile.mkdtemp()
    trader = _bare_trader_with_loader(tmp)
    dest = trader.loader.save_upload("flow.py", _CUSTOM_SRC)

    async def run():
        return await trader.apply_strategy({"kind": "file", "name": dest.name, "params": {}, "enabled": False})

    r = asyncio.run(run())
    assert r.get("ok"), r
    assert trader.book["flow"]["enabled"] is False
    item = next(i for i in trader.strategy_meta["items"] if i["name"] == "flow")
    assert item["kind"] == "file"


def test_update_and_delete_custom_strategy() -> None:
    """Custom strategies keep params through an edit and vanish completely on delete."""
    import asyncio
    import tempfile

    tmp = tempfile.mkdtemp()
    trader = _bare_trader_with_loader(tmp)
    dest = trader.loader.save_upload("flow.py", _CUSTOM_SRC)

    async def run():
        await trader.apply_strategy({"kind": "file", "name": dest.name, "params": {"volume": 0.5}, "enabled": True})
        src = trader.strategy_source("flow")
        assert src["ok"] and "class Flow" in src["source"]
        # Broken code is rejected and the file on disk is left untouched.
        bad = await trader.update_strategy("flow", "import os\n" + _CUSTOM_SRC)
        assert bad.get("ok") is False
        assert "import os" not in (Path(tmp) / "flow.py").read_text(encoding="utf-8")
        # A valid edit hot-reloads in place, keeping enabled + params.
        ok = await trader.update_strategy("flow", _CUSTOM_SRC_V2)
        assert ok.get("ok"), ok
        slot = trader.book["flow"]
        assert slot["enabled"] is True
        assert slot["inst"].params.get("volume") == 0.5
        assert "# v2" in (Path(tmp) / "flow.py").read_text(encoding="utf-8")
        # Delete removes card and file.
        done = await trader.delete_strategy("flow")
        assert done.get("ok"), done
        assert "flow" not in trader.book
        assert not (Path(tmp) / "flow.py").exists()
        gone = trader.strategy_source("flow")
        assert gone.get("ok") is False

    asyncio.run(run())


def test_builtin_strategies_are_read_only() -> None:
    """Edit/delete must refuse built-in strategies."""
    import asyncio
    import tempfile

    tmp = tempfile.mkdtemp()
    trader = _bare_trader_with_loader(tmp)
    trader.book["ema_rsi"] = {
        "inst": trader.loader.load_builtin("ema_rsi", {}),
        "enabled": False,
        "kind": "builtin",
        "last_action": "idle",
        "last_reason": "",
        "last_ts": "",
    }
    trader._sync_book_meta()
    assert trader.strategy_source("ema_rsi").get("ok") is False

    async def run():
        upd = await trader.update_strategy("ema_rsi", _CUSTOM_SRC)
        dele = await trader.delete_strategy("ema_rsi")
        return upd, dele

    upd, dele = asyncio.run(run())
    assert upd.get("ok") is False and "read-only" in upd.get("error", "")
    assert dele.get("ok") is False
    assert "ema_rsi" in trader.book
    assert not (Path(tmp) / "ema_rsi.py").exists()


def test_reserved_and_illegal_upload_names_rejected() -> None:
    import tempfile

    from aurion.strategy.loader import StrategyValidationError

    loader = StrategyLoader()
    loader.dir = Path(tempfile.mkdtemp())
    for bad in ("ema_rsi.py", "template.py", "my strat.py", "1flow.py", "_hidden.py"):
        try:
            loader.save_upload(bad, _CUSTOM_SRC)
        except StrategyValidationError:
            continue
        raise AssertionError(f"save_upload accepted illegal name {bad}")
    ok = loader.save_upload("aurion_xauusd_strategy.py", _CUSTOM_SRC)
    assert ok.name == "aurion_xauusd_strategy.py"
    # Path traversal is neutralised: only the bare file name survives.
    trav = loader.save_upload("../evil.py", _CUSTOM_SRC)
    assert trav.parent == loader.dir and trav.name == "evil.py"


# Test-only issuer keypair (RFC 8032 seed — never the production pair). The
# production private seed stays off-repo; tests inject their own via env.
_TEST_LIC_PRIV = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
_TEST_LIC_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"


def _use_test_issuer() -> None:
    import os

    os.environ["AXIASOFT_KEY_PRIVATE"] = _TEST_LIC_PRIV
    os.environ["AXIASOFT_KEY_PUBLIC"] = _TEST_LIC_PUB


def test_ed25519_official_rfc_vectors() -> None:
    """The engine's pure-Python Ed25519 must match RFC 8032 exactly."""
    from aurion.license import ed25519 as ed

    seed = bytes.fromhex(_TEST_LIC_PRIV)
    pub = ed.publickey(seed)
    assert pub.hex() == _TEST_LIC_PUB
    sig = ed.sign(seed, b"")
    assert sig.hex() == (
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    assert ed.verify(sig, b"", pub) is True
    assert ed.verify(sig, b"\x01", pub) is False


def test_license_freemium_default_and_locks() -> None:
    """No key -> freemium: prop/scalping/upload locked, account_type freemium."""
    from aurion.license.guard import Guard

    g = Guard()
    pub = g.public()
    assert pub["account_type"] == "freemium"
    assert pub["premium"] is False
    assert pub["features"]["prop"] is False
    assert pub["features"]["scalping"] is False
    assert pub["features"]["strategy_upload"] is False
    assert pub["features"]["telegram"] is False
    assert pub["features"]["news"] is False
    assert g.feature("other") is True
    assert g.expired() is False


def test_license_dev_key_unlocks_premium() -> None:
    """Owner AXI-DEV key -> premium features on, works offline (no keyserver)."""
    from aurion.license.guard import Guard, mint

    _use_test_issuer()
    g = Guard()
    g.license_urls = lambda: {"keyserver_url": "", "store_url": ""}
    key = mint("developer", "tests")
    assert key.startswith("AXI-DEV-")
    r = g.activate(key, "")
    assert r["ok"] is True, r
    pub = r["license"]
    assert pub["account_type"] == "premium"
    assert pub["premium"] is True
    assert all(pub["features"].values())
    assert pub["plan"] == "developer"
    # Unlimited reuse: the same owner key activates again without key_used.
    r2 = g.activate(key, "")
    assert r2["ok"] is True, r2


def test_license_forgot_dev_key_signature_rejected() -> None:
    """A well-formatted but forged AXI-DEV key must fail signature verification."""
    from aurion.license.guard import Guard

    _use_test_issuer()
    g = Guard()
    g.license_urls = lambda: {"keyserver_url": "", "store_url": ""}
    alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    import random

    rng = random.Random(42)
    sig = "".join(rng.choice(alpha) for _ in range(103))
    forged = "AXI-DEV-" + "-".join(["AB12", "CD34", "EF56", "789A"] + [sig[i : i + 4] for i in range(0, 103, 4)]).rstrip("-")
    assert len(sig) == 103
    r = g.activate(forged, "")
    assert r["ok"] is False and r["error"] == "invalid_key"


def test_license_paid_key_refused_offline() -> None:
    """Customer keys are server-verified: without a key server, refuse activation."""
    from aurion.license.guard import Guard, mint

    _use_test_issuer()
    g = Guard()
    g.license_urls = lambda: {"keyserver_url": "", "store_url": ""}
    key = mint("m3", "tests")
    r = g.activate(key, "")
    assert r["ok"] is False and r["error"] == "internet_required"


def test_license_developer_machine_binding() -> None:
    """Developer plan premium is valid on its own machine / unbound state."""
    from aurion.license.guard import Guard, machine_id

    g = Guard()
    g.state = {"plan": "developer", "machine": ""}
    assert g.premium_active() is True
    g.state = {"plan": "developer", "machine": machine_id()}
    assert g.premium_active() is True
    g.state = {"plan": "developer", "machine": "some-other-machine"}
    assert g.premium_active() is False


def test_license_expired_plan_falls_back_to_freemium() -> None:
    from aurion.license.guard import Guard

    g = Guard()
    g.state["plan"] = "m1"
    g.state["expires"] = "2020-01-01T00:00:00Z"
    g.state["machine"] = ""
    assert g.expired() is True
    pub = g.public()
    assert pub["account_type"] == "freemium"
    assert pub["features"]["prop"] is False
    assert pub["expired"] is True


def test_license_online_consumption_mock_server() -> None:
    """Engine activation consumes the key on the key server (online, once)."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from aurion.license import guard as licmod
    from aurion.license.guard import Guard, mint

    _use_test_issuer()
    calls = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            calls.append(body)
            if len(calls) == 1:
                payload = {"ok": True, "plan": "m1", "plan_label": "1 month", "activated_at": "2026-08-23T00:00:00Z", "expires_at": "2026-09-22T00:00:00Z"}
            else:
                payload = {"ok": False, "error": "machine_mismatch", "recover": True}
            blob = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        g = Guard()
        g.license_urls = lambda: {"keyserver_url": f"http://127.0.0.1:{srv.server_port}", "store_url": ""}
        key = mint("m1", "srv-test")
        r = g.activate(key, "")
        assert r["ok"] is True, r
        assert r["license"]["plan"] == "m1"
        assert r["license"]["expires"] == "2026-09-22T00:00:00Z"
        assert calls and calls[0]["machine"]
        # local one-time store also guards:
        r2 = g.activate(key, "")
        assert r2["ok"] is False and r2["error"] == "key_used"
    finally:
        srv.shutdown()
    del licmod


def test_license_dev_key_online_registration_and_revoke() -> None:
    """Owner key registers on the key server; revoked verdict blocks activation."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from aurion.license.guard import Guard, mint

    _use_test_issuer()
    seen = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            seen.append(body)
            if body.get("machine") == "REVOKED":
                payload = {"ok": False, "error": "key_revoked"}
            else:
                payload = {"ok": True, "plan": "developer", "activated_at": "2026-08-24T00:00:00Z", "expires_at": None, "owner": True}
            blob = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        g = Guard()
        g.license_urls = lambda: {"keyserver_url": f"http://127.0.0.1:{srv.server_port}", "store_url": ""}
        key = mint("developer", "srv-test")
        r = g.activate(key, "")
        assert r["ok"] is True, r
        assert r["license"]["plan"] == "developer"
        assert seen and seen[0]["key"].startswith("AXI-DEV-")
        # A revoked verdict (machine marker) blocks activation on this server.
        g2 = Guard()
        g2.license_urls = g.license_urls
        import aurion.license.guard as guard_mod

        orig_machine = guard_mod.machine_id
        guard_mod.machine_id = lambda: "REVOKED"
        try:
            g2.license_urls = lambda: {"keyserver_url": f"http://127.0.0.1:{srv.server_port}", "store_url": ""}
            r2 = g2.activate(key, "")
            assert r2["ok"] is False and r2["error"] == "key_revoked"
        finally:
            guard_mod.machine_id = orig_machine
    finally:
        srv.shutdown()

def test_set_auto_scalping_requires_premium() -> None:
    """Freemium cannot arm the scalping trade style; premium can."""
    from collections import deque

    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader.book = {}
    trader.strategy = None
    trader.strategy_meta = {}
    trader.auto_trade = False
    trader.require_ai_agree = True
    trader.min_ai_confidence = 0.55
    trader.trade_style = "normal"
    trader.news_trade = False
    trader.active_timeframe = "M15"
    trader.prop = type("P", (), {"enabled": False, "set_enabled": lambda self, v: None})()
    trader.store = type("S", (), {"strategy_stats": staticmethod(lambda names=None: {})})()
    trader.robot_log = deque(maxlen=8)
    trader.loader = StrategyLoader()

    class _Lic:
        def __init__(self, ok):
            self.ok = ok

        def feature(self, name):
            return bool(self.ok) if name == "scalping" else True

    trader.license = _Lic(False)
    trader._persist_runtime = lambda: None

    class _Bus:
        async def publish(self, *a, **k):
            pass

    trader.bus = _Bus()
    r = trader.set_auto({"trade_style": "scalping"})
    assert r.get("ok") is False and r.get("error") == "premium_required"
    assert trader.trade_style == "normal"
    trader.license = _Lic(True)
    r2 = trader.set_auto({"trade_style": "scalping"})
    assert r2.get("ok") is True
    assert trader.trade_style == "scalping"


def test_set_auto_news_trade_requires_premium() -> None:
    """Freemium cannot arm news trading; premium can."""
    from collections import deque

    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader.book = {}
    trader.strategy = None
    trader.strategy_meta = {}
    trader.auto_trade = False
    trader.require_ai_agree = True
    trader.min_ai_confidence = 0.55
    trader.trade_style = "normal"
    trader.news_trade = False
    trader.active_timeframe = "M15"
    trader.prop = type("P", (), {"enabled": False, "set_enabled": lambda self, v: None})()
    trader.store = type("S", (), {"strategy_stats": staticmethod(lambda names=None: {})})()
    trader.robot_log = deque(maxlen=8)
    trader.loader = StrategyLoader()

    class _Lic:
        def __init__(self, ok):
            self.ok = ok

        def feature(self, name):
            return bool(self.ok) if name == "news" else True

    trader.license = _Lic(False)
    trader._persist_runtime = lambda: None

    class _Bus:
        async def publish(self, *a, **k):
            pass

    trader.bus = _Bus()
    r = trader.set_auto({"news_trade": True})
    assert r.get("ok") is False and r.get("error") == "premium_required" and r.get("feature") == "news"
    assert trader.news_trade is False
    trader.license = _Lic(True)
    r2 = trader.set_auto({"news_trade": True})
    assert r2.get("ok") is True
    assert trader.news_trade is True


def test_freemium_bot_trade_limit_three_per_five_hours() -> None:
    """Freemium: 3 robot trades, then auto trading pauses until the 5h window resets."""
    import time as _t

    from aurion.license.guard import FREE_BOT_LIMIT, FREE_BOT_WINDOW_SEC, Guard

    g = Guard()
    g.state = {}  # pure freemium, in-memory
    for i in range(FREE_BOT_LIMIT):
        r = g.allow_bot_entry()
        assert r.get("ok") is True, r
        usage = g.bot_usage()
        assert usage["used"] == i
        assert usage["left"] == FREE_BOT_LIMIT - i
        g.note_bot_fill()
    usage = g.bot_usage()
    assert usage["used"] == FREE_BOT_LIMIT
    assert usage["ok"] is False
    assert usage["left"] == 0
    assert usage["lock_until"]
    assert usage["lock_until"] > _t.time() + FREE_BOT_WINDOW_SEC - 60
    r = g.allow_bot_entry()
    assert r.get("ok") is False and r.get("error") == "freemium_trade_limit"
    assert r.get("limit_until")
    assert r.get("window_hours") == 5
    # Five hours later the window resets and a fresh batch is available.
    g.state["bot_lock_until"] = _t.time() - 5
    assert g.allow_bot_entry().get("ok") is True
    assert g.bot_usage()["used"] == 0
    assert g.bot_usage()["left"] == FREE_BOT_LIMIT
    # Premium is never limited, even with an active window counter.
    g.state = {"plan": "developer", "machine": "", "bot_window_count": 99, "bot_lock_until": _t.time() + 99999}
    assert g.allow_bot_entry().get("ok") is True


def test_license_telegram_news_features_premium() -> None:
    """Premium unlocks telegram + news; freemium keeps them locked."""
    from aurion.license.guard import Guard

    g = Guard()
    g.state = {}
    assert g.feature("telegram") is False
    assert g.feature("news") is False
    g.state = {"plan": "developer", "machine": ""}
    assert g.feature("telegram") is True
    assert g.feature("news") is True


def test_license_paid_machine_binding_local() -> None:
    """A copied license folder NEVER premius on another machine (any plan)."""
    from aurion.license.guard import Guard, machine_id

    g = Guard()
    g.state = {"plan": "m6", "expires": "2099-01-01T00:00:00Z", "machine": ""}
    assert g.premium_active() is True  # pre-bind / migration safety
    g.state["machine"] = machine_id()
    assert g.premium_active() is True  # its own machine
    g.state["machine"] = "other-pc-fingerprint"
    assert g.premium_active() is False  # cloned onto another machine
    pub = g.public()
    assert pub["account_type"] == "freemium"
    assert pub["features"]["scalping"] is False


def test_license_heartbeat_ok_downgrade_and_clear() -> None:
    """Heartbeat: server detects the machine; downgrade verdict kills premium
    locally; a later OK verdict (e.g. un-revoked) restores it."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from aurion.license.guard import Guard, machine_id

    _use_test_issuer()
    calls = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            calls.append(body)
            if self.path != "/api/desk/heartbeat":
                payload = {"ok": False, "error": "route"}
            elif len(calls) == 1:
                payload = {"ok": True, "plan": "m6"}
            elif len(calls) == 2:
                payload = {"ok": False, "error": "machine_mismatch", "action": "downgrade"}
            else:
                payload = {"ok": True, "plan": "m6"}
            blob = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        g = Guard()
        g.license_urls = lambda: {"keyserver_url": f"http://127.0.0.1:{srv.server_port}", "store_url": ""}
        g.state = {
            "plan": "m6",
            "expires": "2099-01-01T00:00:00Z",
            "machine": machine_id(),
            "key_hash": "ab" * 32,
        }
        assert g.premium_active() is True
        r1 = g.heartbeat(force=True)
        assert r1["ok"] is True and calls[0]["machine"] == machine_id()
        assert g.state["last_heartbeat"]
        # throttle: immediate non-forced beat skips the network
        before = len(calls)
        assert g.heartbeat()["skipped"] is True and len(calls) == before
        # server says the key moved -> local downgrade
        r2 = g.heartbeat(force=True)
        assert r2["ok"] is False and "machine_mismatch" in r2["error"]
        assert g.premium_active() is False
        assert "machine_mismatch" in (g.public()["remote_revoked"])
        # owner restores the key -> next OK heartbeat clears the flag
        r3 = g.heartbeat(force=True)
        assert r3["ok"] is True
        assert g.premium_active() is True
        assert g.public()["remote_revoked"] == ""
        # unreachable server -> skipped, premium untouched
        g.license_urls = lambda: {"keyserver_url": "http://127.0.0.1:1", "store_url": ""}
        r4 = g.heartbeat(force=True)
        assert r4["skipped"] is True and g.premium_active() is True
    finally:
        srv.shutdown()


def test_ai_by_symbol_tracks_each_chart_independently():
    from aurion.ai.engine import AIEngine

    eng = AIEngine()
    eng.infer([], "EURUSD", "M15")
    eng.infer([], "XAUUSD", "H1")
    # Both charts keep their own state — the later infer must NOT wipe the first.
    assert set(eng.by_symbol) == {"EURUSD", "XAUUSD"}
    e, x = eng.by_symbol["EURUSD"], eng.by_symbol["XAUUSD"]
    assert e["timeframe"] == "M15" and x["timeframe"] == "H1"
    assert e["direction"] == "neutral" and e["display_direction"] in {"bull", "bear", "neutral"}
    # Fields the desk sliders consume (direction hero + outlook) are all present.
    for st in (e, x):
        for k in ("symbol", "timeframe", "ready", "direction", "display_direction", "confidence", "reason", "regime", "pattern", "outlook_strength", "outlook_text", "samples", "ts"):
            assert k in st


def test_ai_by_symbol_cap_prunes_oldest():
    from aurion.ai.engine import AIEngine

    eng = AIEngine()
    for i in range(30):
        eng.infer([], f"SYM{i:02d}", "M5")
    assert len(eng.by_symbol) == 24
    assert "SYM00" not in eng.by_symbol and "SYM29" in eng.by_symbol


def test_trader_snapshot_includes_ai_by_symbol_for_live_charts_only():
    from aurion.runtime import trader as trader_mod

    t = trader_mod.Trader.__new__(trader_mod.Trader)

    class _AI:
        last = {"symbol": "XAUUSD", "direction": "bull"}
        activity = []
        by_symbol = {
            "XAUUSD": {"symbol": "XAUUSD", "direction": "bull", "timeframe": "H1"},
            "OLD": {"symbol": "OLD", "direction": "bear", "timeframe": "M5"},
        }

    class _Agent:
        def __init__(self, symbol):
            self.symbol = symbol

    class _Bridge:
        def active_agents(self):
            return [_Agent("XAUUSD")]

    t.ai = _AI()
    t.bridge = _Bridge()
    rows = t._ai_by_symbol()
    assert [r["symbol"] for r in rows] == ["XAUUSD"]  # detached chart pruned
    t.bridge = type("_B", (), {"active_agents": lambda self: []})()
    rows = t._ai_by_symbol()
    assert {r["symbol"] for r in rows} == {"XAUUSD", "OLD"}  # no agents -> everything kept


def test_robot_volume_manual_pins_user_lot():
    from aurion.runtime import trader as trader_mod

    t = trader_mod.Trader.__new__(trader_mod.Trader)
    t.volume_mode = "manual"
    t.manual_volume = 0.25
    assert t._robot_volume({"volume": 0.05}) == 0.25  # strategy preset overridden
    t.manual_volume = 0.0
    assert t._robot_volume({"volume": 0.05}) == 0.05  # invalid manual -> fallback
    t.volume_mode = "auto"
    t.manual_volume = 0.25
    assert t._robot_volume({"volume": 0.05}) == 0.05  # auto keeps strategy volume


def test_set_auto_accepts_lot_mode_and_clamps():
    from aurion.runtime import trader as trader_mod

    t = trader_mod.Trader.__new__(trader_mod.Trader)
    t.volume_mode = "auto"
    t.manual_volume = 0.10

    # Minimal harness for set_auto's side effects.
    called = {"sync": 0, "persist": 0}

    class _Lic:
        def feature(self, name):
            return True

    class _Prop:
        enabled = False

        def set_enabled(self, on):
            self.enabled = on

    t.license = _Lic()
    t.prop = _Prop()
    t.active_timeframe = "M15"
    t.auto_trade = False
    t.strategy_meta = {}
    t._sync_book_meta = lambda: called.__setitem__("sync", called["sync"] + 1)
    t._persist_runtime = lambda: called.__setitem__("persist", called["persist"] + 1)

    t.set_auto({"volume_mode": "manual", "manual_volume": 3.0})
    assert t.volume_mode == "manual" and t.manual_volume == 3.0
    t.set_auto({"volume_mode": "weird"})
    assert t.volume_mode == "auto"
    t.set_auto({"volume_mode": "manual", "manual_volume": 99999})
    assert t.manual_volume <= 1000.0
    t.set_auto({"manual_volume": "junk"})
    assert t.manual_volume <= 1000.0 and t.manual_volume > 0
