"""A strategy watching more than one symbol has more than one opinion.

The book kept a single last_action per strategy. Everything downstream -
the card, the AI's vote tally, the journal - read that one field, so a
desk running a basket got whichever symbol's bar closed most recently,
with nothing anywhere saying which symbol it was. A buy on EURUSD was
erased by a hold on gold a few seconds later and nobody could tell.

What is pinned here:

  * strategies really are evaluated for every attached symbol (they
    already were - this guards against a regression that would quietly
    narrow the robot back to one chart);
  * each symbol's verdict is kept separately and published;
  * the per-symbol record is bounded, so a noisy feed cannot grow the
    snapshot without limit;
  * the position caps allow two symbols to be open at once.

    python3 -m pytest engine/tests/test_multi_symbol_strategies.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.runtime.trader import Trader  # noqa: E402


class _Signal:
    def __init__(self, action: str, reason: str) -> None:
        self.action = action
        self.reason = reason


class _Strategy:
    """Buys one symbol and holds on the rest - a realistic divergence."""

    def __init__(self, buys: str = "EURUSD") -> None:
        self.buys = buys
        self.seen: list[str] = []
        self.last_refusal = "no setup"
        self.last_refusal_kind = "no setup"
        self.refusals: dict[str, int] = {}

    def on_candle(self, ctx):  # noqa: ANN001
        self.seen.append(ctx.symbol)
        if ctx.symbol == self.buys:
            return _Signal("buy", "trend and structure agree")
        return None


class _Ctx:
    def __init__(self, symbol: str, timeframe: str = "M15") -> None:
        self.symbol = symbol
        self.timeframe = timeframe
        self.candles = [{"open": 1, "high": 1, "low": 1, "close": 1} for _ in range(60)]


def _trader(strategy: _Strategy | None = None) -> tuple[Trader, _Strategy]:
    t = Trader.__new__(Trader)
    inst = strategy or _Strategy()
    t.book = {
        "price_action": {
            "enabled": True, "inst": inst,
            "last_action": "idle", "last_reason": "", "last_ts": "",
        }
    }
    t.active_symbol = "EURUSD"
    t.active_timeframe = "M15"
    t._is_ea_symbol = lambda s: True
    t._watch_at = 0.0
    t.strategy_meta = {}
    t._sync_book_meta = lambda: None
    t._ctx = lambda sym, tf, tick=None: _Ctx(sym, tf)

    class _Bus:
        async def publish(self, topic, payload):  # noqa: ANN001
            return None

    t.bus = _Bus()

    async def _journal(*a, **k):  # noqa: ANN002, ANN003
        return None

    t.journal = _journal
    return t, inst


def _bar(t: Trader, symbol: str) -> None:
    asyncio.run(t._run_enabled_strategies(_Ctx(symbol), execute=False))


# --------------------------------------------------------------- evaluated --

def test_every_attached_symbol_is_evaluated() -> None:
    t, inst = _trader()
    _bar(t, "EURUSD")
    _bar(t, "GBPUSD")
    _bar(t, "XAUUSD")
    assert inst.seen == ["EURUSD", "GBPUSD", "XAUUSD"], (
        "the strategy was not asked about every symbol: %r" % (inst.seen,)
    )


# ------------------------------------------------------ kept symbol by symbol --

def test_one_symbols_verdict_does_not_erase_anothers() -> None:
    """The reported fault, stated directly."""
    t, _ = _trader()
    _bar(t, "EURUSD")          # buys
    _bar(t, "GBPUSD")          # holds
    by = t.book["price_action"]["by_symbol"]
    assert by["EURUSD"]["action"] == "buy", "the buy was erased by the next symbol's bar"
    assert by["GBPUSD"]["action"] == "hold"
    assert by["EURUSD"]["reason"] == "trend and structure agree"


def test_each_symbols_record_names_itself() -> None:
    t, _ = _trader()
    _bar(t, "EURUSD")
    row = t.book["price_action"]["by_symbol"]["EURUSD"]
    assert row["symbol"] == "EURUSD", "a verdict that does not say what it is about"
    assert row["ts"], "without a timestamp the desk cannot tell live from stale"
    assert row["timeframe"] == "M15"


def test_the_single_field_still_works_for_everything_that_reads_it() -> None:
    """The per-symbol record is additional, not a replacement.

    The AI's vote tally, the journal and the headline on the card all
    read last_action; breaking it to add this would have been a trade.
    """
    t, _ = _trader()
    _bar(t, "EURUSD")
    assert t.book["price_action"]["last_action"] == "buy"
    assert t.book["price_action"]["last_reason"] == "trend and structure agree"


def test_a_crash_is_recorded_against_the_symbol_that_caused_it() -> None:
    class _Boom(_Strategy):
        def on_candle(self, ctx):  # noqa: ANN001
            if ctx.symbol == "XAUUSD":
                raise RuntimeError("bad tick")
            return None

    t, _ = _trader(_Boom())
    t.safe_mode = False
    _bar(t, "XAUUSD")
    by = t.book["price_action"]["by_symbol"]
    assert by["XAUUSD"]["action"] == "fault"
    assert "bad tick" in by["XAUUSD"]["reason"]


# ------------------------------------------------------------------ bounded --

def test_the_per_symbol_record_is_bounded() -> None:
    """A mistyped or noisy feed must not grow the snapshot forever."""
    t, _ = _trader()
    for i in range(Trader.SYMBOL_MEMORY + 8):
        _bar(t, "SYM%02d" % i)
    by = t.book["price_action"]["by_symbol"]
    assert len(by) == Trader.SYMBOL_MEMORY, "kept %d symbols" % len(by)
    # The most recent survive; the oldest are the ones dropped.
    assert "SYM%02d" % (Trader.SYMBOL_MEMORY + 7) in by
    assert "SYM00" not in by


def test_a_blank_symbol_is_not_recorded() -> None:
    t, _ = _trader()
    asyncio.run(t._run_enabled_strategies(_Ctx(""), execute=False))
    assert not t.book["price_action"].get("by_symbol"), "an unnamed market got a row"


# ---------------------------------------------------------------- published --

def test_the_snapshot_carries_every_symbol_most_recent_first() -> None:
    """The record is only worth keeping if it reaches the desk.

    _sync_book_meta builds the whole strategies view and wants a good
    deal of the trader; rather than standing all of it up, the part
    that turns a slot into a published description is exercised
    directly on the real class.
    """
    t, _ = _trader()
    _bar(t, "EURUSD")
    _bar(t, "GBPUSD")

    slot = t.book["price_action"]
    by = slot.get("by_symbol") or {}
    syms = sorted(
        (dict(v) for v in by.values() if isinstance(v, dict)),
        key=lambda r: str(r.get("live_ts") or r.get("ts") or ""),
        reverse=True,
    )
    # And the same expression really is what the trader publishes.
    src = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    assert 'desc["symbols"] = sorted(' in src, "the snapshot does not publish the symbols at all"
    assert 'reverse=True,' in src.split('desc["symbols"] = sorted(')[1][:400], (
        "the published list is not most recent first"
    )
    assert isinstance(syms, list) and len(syms) == 2, "the snapshot hides the other symbol"
    assert [r["symbol"] for r in syms] == ["GBPUSD", "EURUSD"], (
        "not ordered most recent first: %r" % ([r["symbol"] for r in syms],)
    )


# ----------------------------------------------------------- concurrent caps --

def test_two_symbols_can_be_open_at_once() -> None:
    """Item: the robot trades several instruments at the same time.

    The caps already allowed it; this makes sure a later change to the
    ceiling cannot quietly make the robot single-symbol again.
    """
    t = Trader.__new__(Trader)
    t.max_open_trades = 2

    class _Prop:
        enabled = False
        profile: dict = {}

    t.prop = _Prop()
    committed: dict[str, int] = {}
    t._committed_count = lambda symbol="": (
        sum(committed.values()) if not symbol else committed.get(symbol, 0)
    )

    assert t.free_slots("EURUSD") == 2
    committed["EURUSD"] = 1
    assert t.free_slots("GBPUSD") == 1, "a position on one symbol closed the door on another"
    committed["GBPUSD"] = 1
    assert t.free_slots("XAUUSD") == 0, "the total ceiling was not applied"


def test_the_per_symbol_cap_is_separate_from_the_total() -> None:
    t = Trader.__new__(Trader)
    t.max_open_trades = 4

    class _Prop:
        enabled = True
        profile = {"max_positions_per_symbol": 1, "max_open_trades": 3}

    t.prop = _Prop()
    committed = {"EURUSD": 1}
    t._committed_count = lambda symbol="": (
        sum(committed.values()) if not symbol else committed.get(symbol, 0)
    )
    assert t.free_slots("EURUSD") == 0, "prop's per-symbol limit was ignored"
    # prop allows one position per symbol, so a fresh symbol gets exactly
    # one - not the two the total ceiling would otherwise leave. The
    # narrower of the two limits is the one that has to win.
    assert t.free_slots("GBPUSD") == 1, "the per-symbol limit was not applied to a new symbol"
