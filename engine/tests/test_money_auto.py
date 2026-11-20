"""Automatic money management: the cap is a share of the live account.

Asked for: a money-management mode that manages itself. A fixed
currency amount, typed once when the desk was set up, is the one risk
setting guaranteed to be wrong later - the account that was 1 000 is
1 600, or it is 700, and the number no longer means what the trader
meant by it.

Automatic mode states the rule the way a trader holds it in their head
- "I risk one percent" - and recomputes the cap from live equity for
every ticket. It is implemented in Trader._cap() and nowhere else,
because _cap() is the single number the whole money rule is built on:
lot sizing, stop capping and the chart replay all read it, so one
insertion point means they cannot disagree.

Two things it must never do: multiply the percentage by the lot size
(then it is not a percentage of the account), and quietly become "no
rule" when the account has not reported equity yet.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.runtime.trader import Trader  # noqa: E402


def _trader(equity: float = 10_000.0, balance: float | None = None, **kw) -> Trader:
    t = Trader.__new__(Trader)
    t.max_loss_per_lot = 10.0
    t.money_scope = "lot"
    t.money_mode = "auto"
    t.money_risk_pct = 1.0
    t._auto_cap_last = 0.0
    t.prop = SimpleNamespace(enabled=False, profile={})
    account = {"equity": equity, "balance": balance if balance is not None else equity}
    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=lambda: account))
    for key, value in kw.items():
        setattr(t, key, value)
    return t


# ── the cap follows the account ───────────────────────────────────────


def test_one_percent_of_the_account() -> None:
    assert _trader(10_000.0)._cap() == 100.0


def test_it_grows_and_shrinks_with_the_account() -> None:
    assert _trader(16_000.0)._cap() == 160.0
    assert _trader(7_000.0)._cap() == 70.0


def test_the_percentage_is_the_traders_own() -> None:
    assert _trader(10_000.0, money_risk_pct=0.5)._cap() == 50.0
    assert _trader(10_000.0, money_risk_pct=2.0)._cap() == 200.0


def test_equity_is_preferred_over_balance() -> None:
    # A floating loss has already happened; risking a percentage of a
    # balance the account no longer has is risking more than was asked.
    assert _trader(equity=8_000.0, balance=10_000.0)._cap() == 80.0


def test_balance_is_used_when_equity_is_missing() -> None:
    t = _trader()
    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=lambda: {"balance": 5_000.0}))
    assert t._cap() == 50.0


def test_fixed_mode_is_untouched() -> None:
    t = _trader(10_000.0, money_mode="fixed")
    assert t._cap() == 10.0


# ── it is always per trade ────────────────────────────────────────────


def test_automatic_mode_is_always_per_trade() -> None:
    t = _trader(10_000.0)
    t.money_scope = "lot"
    assert t._scope() == "trade", \
        "a percentage of the account that multiplies by the lot is not a percentage of the account"


def test_the_stored_scope_is_not_rewritten() -> None:
    """Switching to automatic must not destroy the fixed-mode setting."""
    t = _trader(10_000.0)
    assert t.money_scope == "lot"
    t._scope()
    assert t.money_scope == "lot"


# ── bounds, and the prop ceiling ──────────────────────────────────────


def test_the_percentage_is_bounded() -> None:
    assert _trader(10_000.0, money_risk_pct=500.0)._auto_risk_pct() == Trader.AUTO_RISK_MAX_PCT
    assert _trader(10_000.0, money_risk_pct=0.0)._auto_risk_pct() == Trader.AUTO_RISK_MIN_PCT


def test_an_armed_prop_profile_can_only_lower_it() -> None:
    t = _trader(10_000.0, money_risk_pct=2.0)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 0.5})
    assert t._auto_risk_pct() == 0.5
    assert t._cap() == 50.0


def test_a_looser_prop_profile_does_not_raise_it() -> None:
    t = _trader(10_000.0, money_risk_pct=0.5)
    t.prop = SimpleNamespace(enabled=True, profile={"max_risk_per_trade_pct": 5.0})
    assert t._auto_risk_pct() == 0.5


def test_a_disarmed_prop_profile_is_ignored() -> None:
    t = _trader(10_000.0, money_risk_pct=2.0)
    t.prop = SimpleNamespace(enabled=False, profile={"max_risk_per_trade_pct": 0.1})
    assert t._auto_risk_pct() == 2.0


# ── it fails closed ───────────────────────────────────────────────────


def test_an_unknown_account_holds_the_last_cap_rather_than_dropping_the_rule() -> None:
    t = _trader(10_000.0)
    assert t._cap() == 100.0
    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=lambda: {}))
    assert t._cap() == 100.0, \
        "a reconnect silently removed the stop cap - zero means 'no rule', not 'no risk'"


def test_with_nothing_known_at_all_it_falls_back_to_the_fixed_amount() -> None:
    t = _trader(10_000.0)
    t.max_loss_per_lot = 25.0
    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=lambda: {}))
    assert t._cap() == 25.0


def test_a_broken_bridge_does_not_raise() -> None:
    t = _trader(10_000.0)

    def _boom():
        raise RuntimeError("mid reconnect")

    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=_boom))
    assert t._cap() == 10.0  # the stored fixed amount, not an exception


# ── what the desk is told ─────────────────────────────────────────────


def test_the_words_a_human_reads_name_the_percentage_and_the_equity() -> None:
    words = _trader(10_000.0)._cap_words()
    assert "100.00" in words and "1.00%" in words and "10000.00" in words


def test_the_words_admit_when_equity_is_unknown() -> None:
    t = _trader(10_000.0)
    t.bridge = SimpleNamespace(account=SimpleNamespace(to_dict=lambda: {}))
    assert "not reported" in t._cap_words()
