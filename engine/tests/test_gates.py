"""Tests for the per-symbol trade gate ("who trades on which symbol")."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.prop.rules import PropEngine  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402


class _Native:
    connected = False


class _Bridge:
    connected = True

    def __init__(self) -> None:
        self.native = _Native()
        self.positions: list = []
        self._agents: list = []

    def active_agents(self):
        return list(self._agents)


class _License:
    def allow_bot_entry(self):
        return {"ok": True}


def _stub(prop_enabled: bool = False) -> Trader:
    t = Trader.__new__(Trader)
    t.bridge = _Bridge()
    t.kill_switch = False
    t.safe_mode = False
    t.auto_trade = True
    t.book = {"ema_rsi": {"enabled": True}}
    t.license = _License()
    t.ai = SimpleNamespace(last={}, by_symbol={})
    t.require_ai_agree = True
    t.min_ai_confidence = 0.55
    t.trade_style = "normal"
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    t.news_trade = False
    prop = PropEngine()
    prop.enabled = prop_enabled
    prop.locked = False
    prop.news_events = []
    t.prop = prop
    return t


def _pos(symbol: str) -> SimpleNamespace:
    return SimpleNamespace(symbol=symbol)


def test_ready_symbol_says_robot() -> None:
    t = _stub()
    t.bridge._agents = [SimpleNamespace(symbol="EURUSD", timeframe="M15")]
    gates = t.gates_by_symbol()
    assert len(gates) == 1
    g = gates[0]
    assert g["symbol"] == "EURUSD" and g["timeframe"] == "M15"
    assert g["who"] == "robot" and g["ready"] is True and g["reasons"] == []
    assert g["positions"] == 0 and g["manual_ok"] is True


def test_each_agent_gets_own_slide() -> None:
    t = _stub()
    t.bridge._agents = [
        SimpleNamespace(symbol="EURUSD", timeframe="M15"),
        SimpleNamespace(symbol="XAUUSD", timeframe="H1"),
        SimpleNamespace(symbol="EURUSD", timeframe="M15"),
    ]
    gates = t.gates_by_symbol()
    assert [(g["symbol"], g["timeframe"]) for g in gates] == [("EURUSD", "M15"), ("XAUUSD", "H1")]


def test_no_agents_falls_back_to_active_symbol() -> None:
    t = _stub()
    assert [g["symbol"] for g in t.gates_by_symbol()] == ["EURUSD"]


def test_ai_judged_per_symbol() -> None:
    t = _stub()
    t.ai = SimpleNamespace(
        last={"ready": True, "direction": "bull", "confidence": 0.9, "symbol": "XAUUSD"},
        by_symbol={"EURUSD": {"ready": True, "direction": "bear", "confidence": 0.2, "symbol": "EURUSD"}},
    )
    eu = t.gate_for_symbol("EURUSD", "M15")
    assert eu["ai_low"] is True and "ai_low" in eu["reasons"] and eu["who"] == "manual"
    au = t.gate_for_symbol("XAUUSD", "H1")
    assert au["ai_low"] is False and "ai_low" not in au["reasons"] and au["who"] == "robot"


def test_global_ai_low_does_not_leak_into_other_symbols() -> None:
    t = _stub()
    t.ai = SimpleNamespace(
        last={"ready": True, "direction": "bull", "confidence": 0.1, "symbol": "EURUSD"},
        by_symbol={},
    )
    assert "ai_low" in t.trade_gate()["reasons"]  # global gate still flags it
    assert "ai_low" not in t.gate_for_symbol("XAUUSD", "H1")["reasons"]


def test_prop_allow_list_blocks_symbol() -> None:
    t = _stub(prop_enabled=True)
    t.prop.profile["allowed_symbols"] = "GBPUSD"
    g = t.gate_for_symbol("EURUSD", "M15")
    assert "symbol_blocked" in g["reasons"]
    assert g["who"] == "manual" and g["manual_ok"] is False
    ok = t.gate_for_symbol("GBPUSD", "M15")
    assert "symbol_blocked" not in ok["reasons"] and ok["who"] == "robot"


def test_prop_per_symbol_cap_blocks_robot_only() -> None:
    t = _stub(prop_enabled=True)
    t.prop.profile["max_positions_per_symbol"] = 1
    t.bridge.positions = [_pos("EURUSD")]
    g = t.gate_for_symbol("EURUSD", "M15")
    assert "symbol_max" in g["reasons"] and g["who"] == "manual"
    assert g["positions"] == 1
    assert g["manual_ok"] is True  # desk manual entries are exempt from the cap


def test_news_blackout_blocks_symbol_entries() -> None:
    t = _stub()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    t.prop.news_events = [
        {"time": now.isoformat(), "currency": "EUR", "impact": "high", "title": "CPI"},
    ]
    g = t.gate_for_symbol("EURUSD", "M15")
    assert "news_block" in g["reasons"] and g["manual_ok"] is False
    other = t.gate_for_symbol("USDJPY", "M15")
    assert "news_block" not in other["reasons"]


def test_news_trading_on_lifts_blackout() -> None:
    t = _stub()
    t.news_trade = True
    now = datetime.now(timezone.utc).replace(microsecond=0)
    t.prop.news_events = [
        {"time": (now - timedelta(minutes=1)).isoformat(), "currency": "EUR", "impact": "high", "title": "CPI"},
    ]
    assert "news_block" not in t.gate_for_symbol("EURUSD", "M15")["reasons"]
