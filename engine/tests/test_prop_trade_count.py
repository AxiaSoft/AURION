"""Prop mode must not reduce how many trades the robot takes.

Reported, in the trader's words: turning the prop profile on made the
robot take fewer trades. It did, and the reduction was almost entirely
AURION's own. Five of the gates in PropEngine.allow_order count tickets
rather than money:

    max_open_trades, max_positions_per_symbol, max_trades_per_day,
    min_minutes_between_trades, max_consecutive_losses

None of them appear in the published rulebook of any funded-account
firm. A firm measures money - daily loss, maximum drawdown, lot size,
the hours, the instruments, the news window - and those limits are not
optional and are not touched here. The count gates are now opt-in per
profile (``throttle_entries``), and the firm-shaped profiles ship with
them off.

The second half of the report: a refusal AND a pass must both be
announced, because "prop is quietly doing its job" and "prop is eating
my trades" looked identical from the desk - the refusal only ever
reached the robot log.
"""

from __future__ import annotations

import ast
import asyncio
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.prop.profiles import LOCKED_IDS, PROFILES, get_profile  # noqa: E402
from aurion.prop.rules import PropEngine  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402

OPEN_ALL_HOURS = {"start": "00:00", "end": "23:59", "weekdays": [0, 1, 2, 3, 4, 5, 6]}
ACCOUNT = {"equity": 10000.0, "balance": 10000.0}

# The gates that count tickets instead of money. Named here so a sixth
# one cannot be added quietly: every name in this list has to be
# reachable only while throttle_entries is on.
COUNT_RULES = [
    "max_open_trades",
    "max_positions_per_symbol",
    "max_trades_per_day",
    "min_minutes_between_trades",
    "max_consecutive_losses",
]


def _engine(**overrides) -> PropEngine:
    prop = PropEngine()
    prop.enabled = True
    prop.set_profile({"id": "custom"})
    prop.profile["trading_hours"] = dict(OPEN_ALL_HOURS)
    prop.profile["allow_weekend"] = True
    prop.profile["news_filter"] = False
    prop.profile.update(overrides)
    return prop


def _prime_day(prop: PropEngine, equity: float = 10000.0) -> None:
    """Open today's book without letting the next call roll it shut.

    metrics() rolls the day when the stamp is stale, and rolling zeroes
    entries_today and consecutive_losses - so a counter set before the
    first metrics() call is wiped before any gate reads it.
    """
    prop.metrics({"equity": equity, "balance": equity})
    prop.day_stamp = prop._today()
    prop.day_start_equity = equity
    prop.high_water = equity


def _order(**kw) -> dict:
    base = {"action": "buy", "side": "buy", "symbol": "EURUSD", "volume": 0.10, "source": "robot"}
    base.update(kw)
    return base


def _positions(n: int, symbol: str = "EURUSD") -> list[dict]:
    return [{"symbol": symbol, "type": "buy", "volume": 0.10, "ticket": i + 1} for i in range(n)]


# ── the count gates are off unless the profile asks for them ──────────


def test_the_firm_shaped_profiles_do_not_throttle_the_count() -> None:
    for name in ("ftmo_challenge", "fundingpips", "the5ers"):
        assert get_profile(name)["throttle_entries"] is False, \
            f"{name} is still counting tickets; no firm's rulebook does"


def test_the_in_house_conservative_book_still_throttles() -> None:
    # It is not a firm. "Few tickets" is the entire point of it, and a
    # trader who picks it has asked for a tight book on purpose.
    assert get_profile("conservative")["throttle_entries"] is True


def test_every_profile_answers_the_question() -> None:
    for name in PROFILES:
        assert "throttle_entries" in get_profile(name), f"{name} has no answer for throttle_entries"


def test_open_trade_count_does_not_refuse_an_entry_by_itself() -> None:
    prop = _engine(max_open_trades=2, max_positions_per_symbol=1)
    held = _positions(5)
    assert prop.allow_order(_order(), ACCOUNT, held).get("ok") is True, \
        "prop refused an entry on ticket count alone"


def test_the_same_profile_refuses_once_throttling_is_asked_for() -> None:
    prop = _engine(max_open_trades=2, max_positions_per_symbol=1, throttle_entries=True)
    gate = prop.allow_order(_order(), ACCOUNT, _positions(5))
    assert gate.get("ok") is False
    assert "max open trades" in str(gate.get("error"))


def test_trades_per_day_is_a_count_gate() -> None:
    prop = _engine(max_trades_per_day=1)
    _prime_day(prop)
    prop.entries_today = 9
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is True
    prop.profile["throttle_entries"] = True
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False


def test_the_gap_between_entries_is_a_count_gate() -> None:
    import time

    prop = _engine(min_minutes_between_trades=60)
    _prime_day(prop)
    prop.last_entry_ts = time.time()
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is True
    prop.profile["throttle_entries"] = True
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False


def test_the_losing_streak_is_a_count_gate() -> None:
    prop = _engine(max_consecutive_losses=2)
    _prime_day(prop)
    prop.consecutive_losses = 7
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is True
    prop.profile["throttle_entries"] = True
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False


def test_positions_per_symbol_is_a_count_gate() -> None:
    prop = _engine(max_open_trades=99, max_positions_per_symbol=1)
    held = _positions(4)
    assert prop.allow_order(_order(), ACCOUNT, held).get("ok") is True
    prop.profile["throttle_entries"] = True
    gate = prop.allow_order(_order(), ACCOUNT, held)
    assert gate.get("ok") is False and "symbol" in str(gate.get("error"))


def test_a_full_book_does_not_trip_a_lock_on_a_firm_profile() -> None:
    """evaluate_account must not flatten the desk over a ticket count."""
    prop = _engine(max_open_trades=1)
    _prime_day(prop)
    decision = prop.evaluate_account(ACCOUNT, _positions(4))
    assert decision.get("code") != "max_trades", "a ticket count tripped a prop lock"
    assert prop.locked is False


# ── the money gates are never optional ────────────────────────────────


def test_the_money_limits_still_refuse_with_throttling_off() -> None:
    prop = _engine(max_lot=0.20)
    gate = prop.allow_order(_order(volume=5.0), ACCOUNT, [])
    assert gate.get("ok") is False and "ceiling" in str(gate.get("error"))

    prop = _engine(max_daily_loss_pct=1.0)
    _prime_day(prop)
    # Floating loss, not a withdrawal: a balance that moves with no
    # closed trade behind it shifts the baseline instead of reading as P/L.
    poor = {"equity": 9000.0, "balance": 10000.0}
    assert prop.allow_order(_order(), poor, _positions(1)).get("ok") is False

    prop = _engine(allowed_symbols="GBPUSD")
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False

    prop = _engine()
    prop.profile["trading_hours"] = {"start": "00:00", "end": "00:01", "weekdays": []}
    prop.profile["allow_weekend"] = False
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False


def test_a_prop_lock_still_refuses_everything() -> None:
    prop = _engine()
    prop.lock("daily_loss")
    assert prop.allow_order(_order(), ACCOUNT, []).get("ok") is False


# ── the trader's own ceiling ──────────────────────────────────────────


class _Bus:
    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []

    async def publish(self, kind, payload=None):
        self.events.append((kind, payload))


def _trader(prop) -> Trader:
    t = Trader.__new__(Trader)
    t.bus = _Bus()
    t.robot_log = deque(maxlen=50)
    t.max_open_trades = 4
    t.prop = prop
    return t


def test_the_trader_ceiling_is_not_lowered_by_a_firm_profile() -> None:
    t = _trader(SimpleNamespace(enabled=True, profile={"max_open_trades": 1,
                                                       "max_positions_per_symbol": 1}, locked=False))
    assert t._total_cap() == 4
    assert t._per_symbol_cap() == 4


def test_the_trader_ceiling_is_lowered_when_the_profile_asks() -> None:
    t = _trader(SimpleNamespace(enabled=True, profile={"max_open_trades": 1,
                                                       "max_positions_per_symbol": 1,
                                                       "throttle_entries": True}, locked=False))
    assert t._total_cap() == 1
    assert t._per_symbol_cap() == 1


# ── both verdicts are announced ───────────────────────────────────────


def _announce(gate: dict, enabled: bool = True) -> list[tuple[str, object]]:
    prop = SimpleNamespace(
        enabled=enabled,
        profile={"id": "ftmo_challenge"},
        throttle_names=lambda: [],
    )
    t = _trader(prop)
    asyncio.run(t._announce_prop_check(_order(), gate))
    return t.bus.events


def test_a_refusal_is_announced_with_its_reason() -> None:
    events = _announce({"ok": False, "error": "max daily loss reached"})
    said = [p for kind, p in events if kind == "prop_check"]
    assert said, "a prop refusal told nobody"
    assert said[0]["ok"] is False
    assert said[0]["why"] == "max daily loss reached"


def test_a_pass_is_announced_too() -> None:
    events = _announce({"ok": True})
    said = [p for kind, p in events if kind == "prop_check"]
    assert said, "prop let an order through in silence - the other half of the report"
    assert said[0]["ok"] is True
    assert said[0]["symbol"] == "EURUSD"
    assert said[0]["throttles"] == [], "a firm profile claimed to be throttling the count"


def test_nothing_is_announced_when_prop_is_off() -> None:
    assert not [p for kind, p in _announce({"ok": True}, enabled=False) if kind == "prop_check"]


def test_the_order_path_announces_before_it_refuses() -> None:
    """Source check: the announcement cannot sit after the early return."""
    src = (ROOT / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    at_gate = src.index("gate = self.prop.allow_order(")
    at_call = src.index("_announce_prop_check(request, gate)", at_gate)
    at_return = src.index("return gate", at_gate)
    assert at_call < at_return, "the pass is announced but the refusal is not"


def test_every_count_rule_is_behind_the_switch() -> None:
    """Each named count gate reads throttle_entries before it refuses.

    A source check on purpose: the behavioural tests above cover the
    five that exist today, and this one is what fails when a sixth is
    added without the gate.
    """
    rules = (ROOT / "aurion" / "prop" / "rules.py").read_text(encoding="utf-8")
    tree = ast.parse(rules)
    fn = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "allow_order"
    )
    body = ast.get_source_segment(rules, fn) or ""
    for rule in COUNT_RULES:
        for line in body.splitlines():
            if rule in line and line.strip().startswith(("if ", "elif ")):
                assert "throttle" in line, f"{rule} refuses without consulting throttle_entries"


def test_locked_profiles_are_still_sealed() -> None:
    for name in LOCKED_IDS:
        assert get_profile(name)["locked"] is True
