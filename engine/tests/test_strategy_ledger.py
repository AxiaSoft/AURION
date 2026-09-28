"""Every strategy keeps its own record, and keeps it after a history reset.

Uses a real SQLite store in a temp directory - the ledger is SQL, so testing
the SQL is the only test worth having. No numpy, no MT5.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from aurion.runtime.store import Store, normalise_strategy_tag


@pytest.fixture()
def store(tmp_path):
    return Store(tmp_path / "test.db")


def close(store, strategy, profit, swap=0.0, commission=0.0, ticket=None, comment=""):
    close.n = getattr(close, "n", 0) + 1
    store.record_trade({
        "time": f"2026-01-0{min(9, close.n)}T10:00:00Z",
        "ticket": ticket if ticket is not None else 1000 + close.n,
        "symbol": "XAUUSD", "side": "buy", "volume": 0.1, "price": 2000.0,
        "profit": profit, "swap": swap, "commission": commission,
        "comment": comment, "strategy": strategy, "kind": "close", "entry": "out",
    })


def test_each_strategy_keeps_its_own_record(store):
    """The reported bug: only one strategy ever accumulated anything."""
    close(store, "ema_rsi", 10.0)
    close(store, "price_action", -4.0)
    close(store, "atr_breakout", 7.5)
    close(store, "scalp_impulse", -2.5)
    close(store, "my_custom_bot", 20.0)

    led = store.strategy_ledger()
    assert set(led) == {"ema_rsi", "price_action", "atr_breakout", "scalp_impulse", "my_custom_bot"}
    assert led["ema_rsi"]["trades"] == 1
    assert led["my_custom_bot"]["net"] == 20.0, "a custom strategy records like any other"


def test_win_rate_and_profit_factor(store):
    for profit in (10.0, 20.0, -5.0, -5.0):
        close(store, "ema_rsi", profit)
    rec = store.strategy_ledger()["ema_rsi"]
    assert rec["trades"] == 4
    assert rec["wins"] == 2 and rec["losses"] == 2
    assert rec["win_rate"] == 50.0
    assert rec["net"] == 20.0
    assert rec["profit_factor"] == 3.0     # 30 gross profit / 10 gross loss
    assert rec["best"] == 20.0 and rec["worst"] == -5.0
    assert rec["avg"] == 5.0


def test_net_includes_swap_and_commission(store):
    """A gross win that swap turns into a loss must count as a loss."""
    close(store, "ema_rsi", 3.0, swap=-2.0, commission=-2.0)
    rec = store.strategy_ledger()["ema_rsi"]
    assert rec["net"] == -1.0
    assert rec["losses"] == 1 and rec["wins"] == 0


def test_profit_factor_is_undefined_before_a_loss(store):
    close(store, "ema_rsi", 10.0)
    assert store.strategy_ledger()["ema_rsi"]["profit_factor"] is None


def test_requested_names_always_appear(store):
    led = store.strategy_ledger(["ema_rsi", "price_action"])
    assert led["ema_rsi"]["trades"] == 0
    assert led["price_action"]["win_rate"] == 0.0


def test_the_record_survives_clearing_the_history(store):
    """The other half of the report: clearing history erased the stats."""
    for profit in (10.0, -3.0, 6.0):
        close(store, "ema_rsi", profit)
    before = store.strategy_ledger()["ema_rsi"]
    assert before["trades"] == 3

    assert store.archive_and_reset(0).get("ok")

    assert store.history(50, closed_only=False) == [], "the trade list is cleared"
    after = store.strategy_ledger()["ema_rsi"]
    assert after == before, "the strategy's record is not"


def test_tag_spellings_collapse_to_one_record(store):
    """MT5 comments, file names and desk tags spell the same strategy in
    several ways; each spelling must not become its own card."""
    close(store, "EMA-RSI", 5.0)
    close(store, "ema_rsi.py", 5.0)
    close(store, " ema_rsi ", 5.0)
    led = store.strategy_ledger()
    assert led["ema_rsi"]["trades"] == 3
    assert len([k for k in led if "ema" in k]) == 1


def test_normalise_tag():
    assert normalise_strategy_tag("EMA-RSI") == "ema_rsi"
    assert normalise_strategy_tag("Scalp Impulse.py") == "scalp_impulse"
    assert normalise_strategy_tag("") == "other"
    assert normalise_strategy_tag("@desk") == "@desk", "reserved tags keep their marker"


def test_backfill_seeds_from_existing_history_once(store):
    close(store, "ema_rsi", 8.0)
    store.execute("DELETE FROM strategy_ledger")
    assert store.backfill_strategy_ledger() == 1
    assert store.strategy_ledger()["ema_rsi"]["trades"] == 1
    assert store.backfill_strategy_ledger() == 0, "never runs twice"
