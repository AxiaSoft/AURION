"""The market data layer: bucketing, symbol identity, routing.

This is the seam that lets prices come from something other than a
MetaTrader terminal, so the checks here are mostly about the two things
that go wrong silently when a second source appears:

  * a bar boundary that depends on when the engine started, rather than
    on the clock, so a chart and a backtest disagree about where 15:00
    began and neither of them looks broken;

  * two names for one market, so a position on EURUSD.m and a series on
    EUR/USD become two rows that never reconcile.

The adapter checks are the conservative half: MT5Provider must keep
answering exactly what the /v1/candles endpoint used to decide for
itself, because a routing layer that is subtly more generous will send
a symbol to a terminal with no chart on it and get silence back.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.market import symbols as sym  # noqa: E402
from aurion.market import timeframes as tfs  # noqa: E402
from aurion.market.aggregate import BarAggregator, resample  # noqa: E402
from aurion.market.hub import MarketHub  # noqa: E402
from aurion.market.mt5_provider import MT5Provider  # noqa: E402
from aurion.market.provider import Instrument, MarketDataProvider  # noqa: E402
from aurion.mt5.types import Candle, Tick  # noqa: E402


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


def iso(epoch_ms: int) -> str:
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).isoformat()


# ============================================================ timeframes


def test_intraday_bars_align_to_the_clock_not_to_the_first_tick() -> None:
    """A bar that starts when the engine did is a bar nobody else has."""
    late = ms("2026-03-04T15:07:23")
    assert tfs.bucket_start(late, "M15") == ms("2026-03-04T15:00:00")
    assert tfs.bucket_start(late, "M5") == ms("2026-03-04T15:05:00")
    assert tfs.bucket_start(late, "H1") == ms("2026-03-04T15:00:00")
    assert tfs.bucket_start(late, "H4") == ms("2026-03-04T12:00:00")


def test_daily_bars_open_at_utc_midnight() -> None:
    assert tfs.bucket_start(ms("2026-03-04T23:59:59"), "D1") == ms("2026-03-04T00:00:00")
    assert tfs.bucket_start(ms("2026-03-05T00:00:00"), "D1") == ms("2026-03-05T00:00:00")


def test_weekly_bars_open_on_monday() -> None:
    """A modulo of the epoch lands on a Thursday, and is wrong all year."""
    # 2026-03-04 is a Wednesday; its week opens on Monday the 2nd.
    assert tfs.bucket_start(ms("2026-03-04T12:00:00"), "W1") == ms("2026-03-02T00:00:00")
    assert tfs.bucket_start(ms("2026-03-08T23:00:00"), "W1") == ms("2026-03-02T00:00:00")
    assert tfs.bucket_start(ms("2026-03-09T00:00:00"), "W1") == ms("2026-03-09T00:00:00")


def test_monthly_bars_are_calendar_months_including_across_a_year() -> None:
    assert tfs.bucket_start(ms("2026-03-31T23:59:00"), "MN1") == ms("2026-03-01T00:00:00")
    assert tfs.bucket_end(ms("2026-03-15T00:00:00"), "MN1") == ms("2026-04-01T00:00:00")
    # The December rollover is where a naive +1 raises ValueError.
    assert tfs.bucket_end(ms("2026-12-15T00:00:00"), "MN1") == ms("2027-01-01T00:00:00")


def test_timeframe_aliases_from_feeds_are_understood() -> None:
    for alias, want in [("15", "M15"), ("1h", "H1"), ("4H", "H4"), ("d", "D1"), ("1W", "W1")]:
        assert tfs.normalise(alias) == want


# =============================================================== symbols


def test_broker_suffixes_are_the_same_instrument() -> None:
    for other in ("EURUSD.m", "EURUSDm", "EURUSD-ECN", "EURUSD.pro"):
        assert sym.matches("EURUSD", other), other
        assert sym.canonical(other) == "EURUSD", other


def test_separators_collapse_to_one_canonical_name() -> None:
    assert sym.canonical("EUR/USD") == "EURUSD"
    assert sym.canonical("eur_usd") == "EURUSD"


def test_a_name_that_is_not_a_pair_is_left_alone() -> None:
    """Confidently cutting US30 into 'US3' + '0' is worse than not trying."""
    for odd in ("US30", "USOIL", "NAS100", "BTC"):
        assert sym.split_pair(odd) is None, odd
        assert sym.canonical(odd) == odd.upper()


def test_metals_quote_like_a_pair_but_are_not_forex() -> None:
    assert sym.split_pair("XAUUSD") == ("XAU", "USD")
    assert sym.is_forex("XAUUSD") is False
    assert sym.is_forex("EURUSD") is True


def test_a_cross_knows_the_two_pairs_it_can_be_built_from() -> None:
    assert sym.cross_legs("EURGBP") == ("EURUSD", "GBPUSD")
    assert sym.cross_legs("CADJPY") == ("CADUSD", "JPYUSD")
    # Already priced in the via currency: there is nothing to derive.
    assert sym.cross_legs("EURUSD") is None
    assert sym.cross_legs("US30") is None


# ============================================================ aggregation


def tick(symbol: str, when: str, bid: float, ask: float | None = None) -> Tick:
    stamp = ms(when)
    return Tick(symbol=symbol, time=iso(stamp), bid=bid,
                ask=ask if ask is not None else bid + 0.0001, time_msc=stamp)


def test_a_bar_is_built_from_its_ticks() -> None:
    agg = BarAggregator(timeframes=("M5",))
    for when, price in [("10:00:10", 1.10), ("10:01:00", 1.12), ("10:02:00", 1.08), ("10:04:59", 1.11)]:
        agg.add_tick(tick("EURUSD", f"2026-03-04T{when}", price))
    bar = agg.forming("EURUSD", "M5")
    assert bar is not None
    assert (bar.open, bar.high, bar.low, bar.close) == (1.10, 1.12, 1.08, 1.11)
    assert bar.volume == 4
    assert bar.time_msc == ms("2026-03-04T10:00:00")


def test_the_first_tick_does_not_define_the_bar_boundary() -> None:
    """Start the engine mid-bar; the bar still opens on the clock."""
    agg = BarAggregator(timeframes=("M15",))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:07:23", 1.10))
    assert agg.forming("EURUSD", "M15").time_msc == ms("2026-03-04T10:00:00")


def test_out_of_order_ticks_within_a_bar_do_not_invert_it() -> None:
    """Arrival order must not decide which end of the candle is the open."""
    agg = BarAggregator(timeframes=("M5",))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:03:00", 1.20))   # later, arrives first
    agg.add_tick(tick("EURUSD", "2026-03-04T10:01:00", 1.10))   # earlier, arrives second
    bar = agg.forming("EURUSD", "M5")
    assert bar.open == 1.10, "the open is the earliest tick by time"
    assert bar.close == 1.20, "the close is the latest tick by time"
    assert (bar.high, bar.low) == (1.20, 1.10)


def test_a_tick_for_an_already_closed_bar_is_refused_and_counted() -> None:
    agg = BarAggregator(timeframes=("M5",))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:01:00", 1.10))
    closed = agg.add_tick(tick("EURUSD", "2026-03-04T10:06:00", 1.20))
    assert len(closed) == 1 and closed[0].close == 1.10

    closed_before = [(c.time_msc, c.open, c.high, c.low, c.close) for c in agg.bars("EURUSD", "M5")]
    forming_before = agg.forming("EURUSD", "M5")
    shape_before = (forming_before.open, forming_before.high, forming_before.low, forming_before.close)

    agg.add_tick(tick("EURUSD", "2026-03-04T10:02:00", 9.99))    # belongs to a closed bar

    after = [(c.time_msc, c.open, c.high, c.low, c.close) for c in agg.bars("EURUSD", "M5")]
    assert after == closed_before, "a closed bar was rewritten under a reader's feet"
    forming_after = agg.forming("EURUSD", "M5")
    assert (forming_after.open, forming_after.high, forming_after.low, forming_after.close) == shape_before, \
        "the late tick leaked into the wrong bar instead of being refused"
    assert agg.stats()["late_ticks"] == 1, "a late tick must be visible, not silent"


def test_a_gap_produces_no_bar_at_all() -> None:
    """Not a flat bar, not a repeated close. A hole is the truth."""
    agg = BarAggregator(timeframes=("M5",))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:01:00", 1.10))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:31:00", 1.20))    # 30 minutes of silence
    closed = agg.bars("EURUSD", "M5")
    assert len(closed) == 1, f"invented {len(closed) - 1} bar(s) across the gap"
    assert closed[0].time_msc == ms("2026-03-04T10:00:00")


def test_a_quiet_market_still_closes_its_last_bar() -> None:
    """Nothing closes a bar but a later tick, and on Friday none comes."""
    agg = BarAggregator(timeframes=("M5",))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:01:00", 1.10))
    assert agg.bars("EURUSD", "M5") == []
    rolled = agg.roll(ms("2026-03-04T10:05:00"))
    assert len(rolled) == 1
    assert agg.forming("EURUSD", "M5") is None
    assert agg.roll(ms("2026-03-04T10:20:00")) == [], "nothing left to close"


def test_one_tick_feeds_every_timeframe_consistently() -> None:
    agg = BarAggregator(timeframes=("M1", "M5", "M15"))
    agg.add_tick(tick("EURUSD", "2026-03-04T10:07:30", 1.10))
    assert agg.forming("EURUSD", "M1").time_msc == ms("2026-03-04T10:07:00")
    assert agg.forming("EURUSD", "M5").time_msc == ms("2026-03-04T10:05:00")
    assert agg.forming("EURUSD", "M15").time_msc == ms("2026-03-04T10:00:00")


# ============================================================== resample


def bar(when: str, o: float, h: float, l: float, c: float, v: float = 10,
        timeframe: str = "M1") -> Candle:
    stamp = ms(when)
    return Candle(symbol="EURUSD", timeframe=timeframe, time=iso(stamp), time_msc=stamp,
                  open=o, high=h, low=l, close=c, volume=v)


def test_minute_bars_build_a_correct_five_minute_bar() -> None:
    rows = [
        bar("2026-03-04T10:00:00", 1.10, 1.13, 1.09, 1.12),
        bar("2026-03-04T10:01:00", 1.12, 1.15, 1.11, 1.14),
        bar("2026-03-04T10:02:00", 1.14, 1.16, 1.08, 1.10),
        bar("2026-03-04T10:03:00", 1.10, 1.11, 1.07, 1.09),
        bar("2026-03-04T10:04:00", 1.09, 1.12, 1.09, 1.11),
    ]
    out = resample(rows, "M5")
    assert len(out) == 1
    got = out[0]
    assert (got.open, got.high, got.low, got.close) == (1.10, 1.16, 1.07, 1.11)
    assert got.volume == 50
    assert got.time_msc == ms("2026-03-04T10:00:00")
    assert got.timeframe == "M5"


def test_resampling_groups_by_the_clock_so_backfill_meets_live_data() -> None:
    rows = [bar(f"2026-03-04T10:0{i}:00", 1.1, 1.1, 1.1, 1.1) for i in range(0, 8)]
    out = resample(rows, "M5")
    assert [c.time_msc for c in out] == [ms("2026-03-04T10:00:00"), ms("2026-03-04T10:05:00")]


def test_an_incomplete_trailing_bar_can_be_dropped_for_a_backtest() -> None:
    """A partial high and low is a look-ahead the strategy never had."""
    rows = [bar(f"2026-03-04T10:0{i}:00", 1.1, 1.1, 1.1, 1.1) for i in range(0, 7)]
    assert len(resample(rows, "M5")) == 2, "a chart wants the forming bar"
    assert len(resample(rows, "M5", drop_partial=True)) == 1, "a backtest must not see it"


def test_downsampling_is_refused_rather_than_faked() -> None:
    rows = [bar("2026-03-04T10:00:00", 1.1, 1.2, 1.0, 1.15, timeframe="M15")]
    assert resample(rows, "M5") == []


def test_resample_of_nothing_is_nothing() -> None:
    assert resample([], "M5") == []


# ============================================================ the adapter


class FakeAgent:
    def __init__(self, symbol: str, timeframe: str = "M15") -> None:
        self.symbol = symbol
        self.timeframe = timeframe


class FakeNative:
    connected = False


class FakeBridge:
    """Only the surface MT5Provider is allowed to touch."""

    def __init__(self, agents=(), cached=()) -> None:
        self._agents = list(agents)
        self._cached = list(cached)
        self.native = FakeNative()
        self.pulled: list[tuple[str, str, int]] = []

    def active_agents(self):
        return self._agents

    def active_tape(self):
        return "live"

    def symbol_spec(self, symbol):
        return {"digits": 5, "point": 0.00001, "description": f"spec {symbol}"}

    def is_ea_symbol(self, symbol):
        return any(sym.matches(symbol, a.symbol) for a in self._agents)

    def _candles_for(self, symbol, timeframe):
        return [c for c in self._cached if sym.matches(c.symbol, symbol)]

    def public_ticks(self):
        return {a.symbol: tick(a.symbol, "2026-03-04T10:00:00", 1.1) for a in self._agents}

    async def pull_candles(self, symbol, timeframe, count=800):
        self.pulled.append((symbol, timeframe, count))
        return [bar("2026-03-04T10:00:00", 1.1, 1.2, 1.0, 1.15).to_dict()]


def test_the_adapter_reports_the_charts_the_terminal_actually_has() -> None:
    provider = MT5Provider(FakeBridge([FakeAgent("EURUSD"), FakeAgent("XAUUSD")]))
    items = provider.instruments()
    assert [i.symbol for i in items] == ["EURUSD", "XAUUSD"]
    assert items[0].kind == "forex" and items[1].kind == "metal"
    assert items[0].digits == 5
    assert all(i.source == "mt5" for i in items)


def test_a_terminal_with_no_chart_carries_no_instruments() -> None:
    provider = MT5Provider(FakeBridge([]))
    assert provider.instruments() == []
    assert provider.status()["connected"] is False


def test_coverage_still_means_what_the_endpoint_used_to_decide() -> None:
    """EA attached, OR bars still cached. Both halves are load-bearing."""
    attached = MT5Provider(FakeBridge([FakeAgent("EURUSD")]))
    assert attached.covers("EURUSD") is True
    assert attached.covers("EURUSD.m") is True, "a broker suffix is the same symbol"
    assert attached.covers("GBPUSD") is False

    # The chart detached but the desk is still showing its bars.
    detached = MT5Provider(FakeBridge([], cached=[bar("2026-03-04T10:00:00", 1, 1, 1, 1)]))
    assert detached.covers("EURUSD") is True, "a cached series must not blank the chart"


def test_history_round_trips_through_the_dataclass_without_loss() -> None:
    provider = MT5Provider(FakeBridge([FakeAgent("EURUSD")]))
    rows = asyncio.run(provider.history("EURUSD", "M15", 500))
    assert len(rows) == 1 and isinstance(rows[0], Candle)
    assert (rows[0].open, rows[0].high, rows[0].low, rows[0].close) == (1.1, 1.2, 1.0, 1.15)
    assert provider.bridge.pulled == [("EURUSD", "M15", 500)]


# ================================================================== hub


class StubProvider(MarketDataProvider):
    def __init__(self, name: str, syms: list[str]) -> None:
        self.name = name
        self.label = name
        self._syms = syms

    def instruments(self):
        return [Instrument(symbol=s, source=self.name) for s in self._syms]

    async def history(self, symbol, timeframe, count=800):
        return [bar("2026-03-04T10:00:00", 1, 1, 1, 1)] if self.covers(symbol) else []

    def ticks(self):
        return {s: tick(s, "2026-03-04T10:00:00", 1.1) for s in self._syms}


def test_the_hub_routes_a_symbol_to_a_provider_that_has_it() -> None:
    hub = MarketHub()
    hub.register(StubProvider("terminal", ["EURUSD"]))
    hub.register(StubProvider("feed", ["GBPUSD", "USDJPY"]))
    assert hub.provider_for("EURUSD").name == "terminal"
    assert hub.provider_for("USDJPY").name == "feed"
    assert hub.provider_for("BTCUSD") is None


def test_the_first_registered_provider_wins_a_contested_symbol() -> None:
    """The trader's own broker outranks a feed on the same pair."""
    hub = MarketHub()
    hub.register(StubProvider("terminal", ["EURUSD"]))
    hub.register(StubProvider("feed", ["EURUSD"]))
    assert hub.provider_for("EURUSD").name == "terminal"
    assert [i.source for i in hub.instruments()] == ["terminal"], "one row per market"


def test_one_market_under_two_names_is_one_instrument() -> None:
    hub = MarketHub()
    hub.register(StubProvider("terminal", ["EURUSD.m"]))
    hub.register(StubProvider("feed", ["EUR/USD", "GBPUSD"]))
    items = hub.instruments()
    assert [i.canonical for i in items] == ["EURUSD", "GBPUSD"]
    assert items[0].symbol == "EURUSD.m", "the winning provider keeps its own naming"


def test_an_unknown_symbol_returns_nothing_rather_than_raising() -> None:
    hub = MarketHub()
    hub.register(StubProvider("feed", ["EURUSD"]))
    assert asyncio.run(hub.history("BTCUSD", "M15")) == []
    assert hub.covers("BTCUSD") is False


def test_an_empty_hub_is_answerable() -> None:
    hub = MarketHub()
    assert hub.instruments() == []
    assert hub.ticks() == {}
    assert hub.status()["connected"] is False
    assert asyncio.run(hub.history("EURUSD", "M15")) == []


def test_a_broken_provider_does_not_take_the_hub_down() -> None:
    class Broken(StubProvider):
        def instruments(self):
            raise RuntimeError("socket died")

    hub = MarketHub()
    hub.register(Broken("broken", ["EURUSD"]))
    hub.register(StubProvider("feed", ["GBPUSD"]))
    assert [i.symbol for i in hub.instruments()] == ["GBPUSD"]
    assert hub.status()["connected"] is True
