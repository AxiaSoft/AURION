"""The broker connection has to say which route it is and whether it can trade.

The desk used to be told one thing about the broker: connected, yes or
no. That single fact is true of two arrangements that behave completely
differently -

  direct  the engine logs into the account itself with the number, the
          server and a password (MetaTrader5 Python package, Windows)
  expert  AurionBridge on a chart inside MetaTrader

- and it is also true of a connection that will refuse every order it is
given. An investor password logs in perfectly: prices stream, the
account reads back, the charts fill. Then the first signal becomes
retcode 10027 in a log nobody is reading, and the desk still shows a
green dot.

So the snapshot carries a link block, and an order that cannot possibly
be accepted is refused here with the reason rather than sent and
rejected by the broker.

    python3 -m pytest engine/tests/test_broker_link.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.mt5.bridge import MT5Bridge  # noqa: E402
from aurion.mt5.types import Account  # noqa: E402


def _bridge() -> MT5Bridge:
    return MT5Bridge()


def _connect_native(bridge: MT5Bridge, account: Account, terminal: dict | None = None) -> None:
    """Pretend the native adapter is logged in.

    Nothing here touches MetaTrader. The package is Windows-only and is
    not installed on the machine this suite runs on, which is exactly
    why the bridge must never be written so that only a Windows box can
    prove its behaviour.
    """
    bridge.native.connected = True
    bridge.native.terminal_info = lambda: dict(terminal or {})  # type: ignore[method-assign]
    bridge.account = account


def test_a_desk_with_nothing_attached_says_so() -> None:
    link = _bridge().link_status()
    assert link["route"] == "none"
    assert link["can_trade"] is False
    assert link["reason"] == "offline"


def test_a_direct_login_is_named_as_a_direct_login() -> None:
    bridge = _bridge()
    _connect_native(bridge, Account(login=512, server="Broker-Live", company="A Broker",
                                    leverage=100, trade_allowed=True))
    link = bridge.link_status()
    assert link["route"] == "direct"
    assert link["login"] == 512
    assert link["server"] == "Broker-Live"
    assert link["company"] == "A Broker"
    assert link["leverage"] == 100
    assert link["can_trade"] is True
    assert link["reason"] == ""


def test_an_investor_password_is_reported_as_read_only_not_as_connected() -> None:
    """The whole point. The link is healthy and it cannot trade."""
    bridge = _bridge()
    _connect_native(bridge, Account(login=512, server="Broker-Live", trade_allowed=False))
    link = bridge.link_status()
    assert link["route"] == "direct"
    assert link["can_trade"] is False
    assert link["reason"] == "read_only"


def test_the_link_rides_along_with_the_status_snapshot() -> None:
    """The desk reads one snapshot. A fact it has to ask for separately
    is a fact that is stale half the time."""
    bridge = _bridge()
    _connect_native(bridge, Account(login=7, server="S", trade_allowed=True))
    status = bridge.snapshot_status
    assert "link" in status
    assert status["link"]["login"] == 7


def test_an_order_on_a_read_only_login_is_refused_with_the_reason() -> None:
    bridge = _bridge()
    _connect_native(bridge, Account(login=512, trade_allowed=False), terminal={"trade_allowed": True})
    sent: list[dict] = []
    bridge.native.send_order = lambda req: sent.append(req) or {"ok": True}  # type: ignore[method-assign]

    result = asyncio.run(bridge.send_order({"action": "buy", "symbol": "EURUSD", "volume": 0.1}))

    assert result["ok"] is False
    assert result["reason"] == "read_only"
    assert "investor" in result["error"].lower()
    # Not sent and then rejected: not sent at all.
    assert sent == []


def test_autotrading_switched_off_is_not_blamed_on_the_password() -> None:
    """Both causes read back as trade_allowed=False on the account.

    Naming the wrong one sends the trader to re-enter a password that
    was never the problem, so the terminal is asked which it is.
    """
    bridge = _bridge()
    _connect_native(bridge, Account(login=512, trade_allowed=False), terminal={"trade_allowed": False})

    result = asyncio.run(bridge.send_order({"action": "buy", "symbol": "EURUSD", "volume": 0.1}))

    assert result["ok"] is False
    assert result["reason"] == "autotrading_off"
    assert "autotrading" in result["error"].lower()
    assert "investor" not in result["error"].lower()


def test_a_tradable_direct_login_still_reaches_the_broker() -> None:
    """The refusal must be narrow. A master password has to behave
    exactly as it did before any of this was added.

    The request builder is stubbed because it imports MetaTrader5 at
    the point of use, and that package exists only on Windows. What is
    being proved is the branch, not the field mapping: the order leaves
    the bridge instead of being turned back at the door.
    """
    bridge = _bridge()
    _connect_native(bridge, Account(login=512, trade_allowed=True))
    seen: list[dict] = []

    bridge._to_native_request = lambda req: {"action": 1, "symbol": req["symbol"]}  # type: ignore[method-assign]

    def _send(req: dict) -> dict:
        seen.append(req)
        return {"ok": True, "deal": 1}

    bridge.native.send_order = _send  # type: ignore[method-assign]

    result = asyncio.run(bridge.send_order({"action": "buy", "symbol": "EURUSD", "volume": 0.1}))

    assert result.get("ok") is True
    assert len(seen) == 1


def test_connecting_without_a_server_is_refused_before_the_terminal_is_touched() -> None:
    """MetaTrader given a number and no server attaches to whichever
    account the terminal is already logged into - which is how a desk
    ends up showing a stranger's equity with no clue why."""
    bridge = _bridge()
    result = asyncio.run(bridge.connect_native({"login": 512, "server": "", "password": "x"}))
    assert result["ok"] is False
    assert result["reason"] == "no_server"


def test_connecting_without_a_password_is_refused_rather_than_half_done() -> None:
    bridge = _bridge()
    result = asyncio.run(bridge.connect_native({"login": 512, "server": "Broker-Live", "password": ""}))
    assert result["ok"] is False
    assert result["reason"] == "no_password"
