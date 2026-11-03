"""Day baseline + lock behaviour of the prop engine.

These cover the three bugs a brand new account used to hit: a phantom daily
P/L inherited from the previous login, a prop lock that fired without a
single trade, and an unlock that re-locked itself on the next account tick.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.prop import rules as prop_rules  # noqa: E402
from aurion.prop.rules import PropEngine, account_key  # noqa: E402


def _engine(tmp_path: Path) -> PropEngine:
    prop_rules.STATE_FILE = tmp_path / "prop-day.json"
    engine = PropEngine()
    engine.enabled = True
    return engine


def test_fresh_account_reports_flat_day(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    metrics = prop.metrics(account)
    assert metrics["ready"] is True
    assert metrics["daily_pl_pct"] == 0.0
    assert metrics["drawdown_pct"] == 0.0
    assert metrics["traded_today"] is False


def test_new_account_does_not_inherit_the_old_baseline(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    old = {"login": 111, "server": "Broker-Demo", "equity": 9200.0, "balance": 9200.0}
    prop.metrics(old)
    # A brand new account with more equity used to read as +8.7% daily P/L.
    new = {"login": 222, "server": "Broker-Live", "equity": 10000.0, "balance": 10000.0}
    metrics = prop.metrics(new)
    assert metrics["account"] == account_key(new)
    assert metrics["daily_pl_pct"] == 0.0
    assert metrics["day_start_equity"] == 10000.0
    assert metrics["high_water"] == 10000.0


def test_untraded_account_is_never_locked(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    prop.metrics(account)
    # Force an impossible-looking baseline, as a stale state file would.
    prop.day_start_equity = 20000.0
    prop.high_water = 20000.0
    decision = prop.evaluate_account(account, [])
    assert decision["ok"] is True
    assert prop.locked is False


def test_lock_still_trips_once_the_account_has_traded(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    prop.metrics(account)
    prop.note_entry()
    prop.note_closed_trade(-900.0)
    losing = {"login": 111, "server": "Broker-Demo", "equity": 9000.0, "balance": 9000.0}
    decision = prop.evaluate_account(losing, [])
    assert decision["ok"] is False
    assert decision["code"] in {"daily_loss", "max_dd"}


def test_unlock_sticks(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    prop.metrics(account)
    prop.note_entry()
    prop.note_closed_trade(-900.0)
    losing = {"login": 111, "server": "Broker-Demo", "equity": 9000.0, "balance": 9000.0}
    prop.evaluate_account(losing, [])
    assert prop.locked is True
    prop.unlock(losing)
    assert prop.locked is False
    # The very next account tick used to re-lock the desk instantly.
    again = prop.evaluate_account(losing, [])
    assert again["ok"] is True
    assert prop.locked is False


def test_deposit_is_not_read_as_profit(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    prop.metrics(account)
    prop.note_entry()  # make the day "active" so nothing re-anchors silently
    funded = {"login": 111, "server": "Broker-Demo", "equity": 15000.0, "balance": 15000.0}
    metrics = prop.metrics(funded)
    assert abs(metrics["daily_pl_pct"]) < 1e-6


def test_baseline_survives_a_restart_on_the_same_day(tmp_path: Path) -> None:
    prop = _engine(tmp_path)
    account = {"login": 111, "server": "Broker-Demo", "equity": 10000.0, "balance": 10000.0}
    prop.metrics(account)
    prop.note_entry()
    prop.note_closed_trade(-100.0)
    prop.metrics({"login": 111, "server": "Broker-Demo", "equity": 9900.0, "balance": 9900.0})
    restarted = PropEngine()
    assert restarted.account_key == account_key(account)
    assert restarted.day_start_equity == 10000.0
    assert restarted.closed_today == 1
