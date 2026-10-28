"""The standalone market data layer.

AURION's prices used to come only from the MetaTrader bridge, so there was
nothing to test without a terminal.  These cover the replacement: the symbol
universe, the provider contract, and the manager that turns polled quotes
into a live chart.

Nothing here touches the network.  The live provider is exercised against
recorded Yahoo payloads, and everything else against a fake provider, so the
suite is deterministic and runs offline.
"""

from __future__ import annotations

import time

import pytest

from aurion.feed import build_feed, symbols as S
from aurion.feed.base import Quote
from aurion.feed.manager import FeedManager
from aurion.feed.synthetic import SyntheticFeed
from aurion.feed.yahoo import YahooFeed, resample


# ---------------------------------------------------------------- universe


def test_universe_is_populated_and_sane():
    assert len(S.UNIVERSE) > 120
    for name, rec in S.UNIVERSE.items():
        assert name == f"{rec.base}{rec.quote}"
        assert rec.base != rec.quote
        assert rec.digits in (2, 3, 5)
        assert rec.kind in ("major", "minor", "metal", "exotic")
        assert rec.description and "/" in rec.description


def test_every_major_pair_exists_exactly_once():
    """All 28 major-major combinations, and never both orientations."""
    seen = 0
    for i, a in enumerate(S.MAJORS):
        for b in S.MAJORS[i + 1:]:
            fwd, rev = f"{a}{b}", f"{b}{a}"
            assert (fwd in S.UNIVERSE) ^ (rev in S.UNIVERSE), f"{fwd}/{rev}"
            seen += 1
    assert seen == 28


@pytest.mark.parametrize("name", [
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    "EURGBP", "EURJPY", "GBPJPY", "XAUUSD", "XAGUSD", "USDTRY", "USDMXN",
    "USDZAR", "EURSEK", "USDSGD", "USDHKD", "CNHJPY", "NOKSEK",
])
def test_pairs_are_quoted_the_way_the_market_quotes_them(name):
    assert name in S.UNIVERSE


@pytest.mark.parametrize("wrong", [
    "USDEUR", "USDGBP", "JPYUSD", "USDXAU", "JPYEUR", "USDAUD",
    # The yen is the quote against exotics too; the first cut of the
    # precedence table produced these.
    "JPYCNH", "JPYZAR", "JPYTRY", "JPYMXN",
])
def test_inverted_pairs_are_never_generated(wrong):
    assert wrong not in S.UNIVERSE


def test_yen_and_metal_pairs_use_the_right_tick_size():
    assert S.UNIVERSE["EURUSD"].digits == 5
    assert S.UNIVERSE["EURUSD"].pip == pytest.approx(0.0001)
    assert S.UNIVERSE["USDJPY"].digits == 3
    assert S.UNIVERSE["USDJPY"].pip == pytest.approx(0.01)
    assert S.UNIVERSE["XAUUSD"].digits == 2


@pytest.mark.parametrize("raw,want", [
    ("EURUSD", "EURUSD"), ("eurusd", "EURUSD"), (" EurUsd ", "EURUSD"),
    ("EUR/USD", "EURUSD"), ("EUR-USD", "EURUSD"), ("EUR_USD", "EURUSD"),
    ("EURUSD.m", "EURUSD"), ("EURUSD.ecn", "EURUSD"), ("EURUSDpro", "EURUSD"),
    ("EURUSD_raw", "EURUSD"), ("EURUSDmicro", "EURUSD"), ("XAUUSD.cent", "EURUSD".replace("EURUSD", "XAUUSD")),
    ("USDJPYm", "USDJPY"),
    # Decorations on the FRONT are just as real as on the end, and the
    # suffix table this replaced could not handle any of them.
    ("FX:EURUSD", "EURUSD"), ("#EURUSD", "EURUSD"), ("m.EURUSD", "EURUSD"),
    ("FX_GBPUSD", "GBPUSD"), ("_XAUUSD", "XAUUSD"), ("FX:USDJPY.pro", "USDJPY"),
])
def test_broker_decorations_fold_onto_the_canonical_name(raw, want):
    assert S.normalise(raw) == want


@pytest.mark.parametrize("raw", ["NOTAPAIR", "EUR", "", "USDOLLAR", "HELLO"])
def test_normalise_does_not_hallucinate_a_pair(raw):
    """The window scan must not find a pair inside an unrelated string."""
    assert S.normalise(raw) not in S.UNIVERSE


def test_unknown_symbols_survive_normalisation_without_being_invented():
    assert S.normalise("NOTAPAIR") == "NOTAPAIR"
    assert S.get("NOTAPAIR") is None
    assert not S.is_known("NOTAPAIR")


@pytest.mark.parametrize("query,first", [
    ("eurusd", "EURUSD"),
    ("eur", "EURUSD"),
    # "JPY" prefix-matches a pile of exotics and only base/quote-matches the
    # pair people mean; liquidity has to win.
    ("jpy", "USDJPY"),
    ("usd", "USDCAD"),
    ("gold", "XAUUSD"),
    ("silver", "XAGUSD"),
    ("turkish", "USDTRY"),
    ("xau", "XAUUSD"),
])
def test_search_puts_the_obvious_answer_first(query, first):
    hits = S.search(query, 10)
    assert hits, query
    assert hits[0].name == first


@pytest.mark.parametrize("query", ["usd", "eur", "jpy", "gbp", "aud"])
def test_search_ranks_the_liquid_pairs_above_the_exotics(query):
    """Asserting only the first hit is not enough.

    Dropping the liquidity tier from the sort key left every first result
    correct while turning the rest of the list into an alphabetical parade
    of exotics -- "usd" went from EURUSD/GBPUSD to USDAED/USDARS/USDBGN.
    """
    top = S.search(query, 6)
    assert len(top) == 6
    assert all(h.kind in ("major", "minor", "metal") for h in top), \
        [h.name for h in top]


def test_empty_search_offers_the_default_watchlist():
    names = [s.name for s in S.search("", 8)]
    assert names == list(S.DEFAULT_WATCHLIST)


def test_search_can_be_limited_to_a_kind():
    hits = S.search("", 200, kinds=["metal"])
    assert hits and all(h.kind == "metal" for h in hits)


# ---------------------------------------------------------------- provider


def test_synthetic_feed_is_deterministic_and_declares_itself():
    a, b = SyntheticFeed(), SyntheticFeed()
    assert a.simulated is True
    qa = a.quotes(["EURUSD"]).quotes["EURUSD"]
    qb = b.quotes(["EURUSD"]).quotes["EURUSD"]
    # Same seed, same second -> same number.
    assert qa.mid == qb.mid
    assert qa.bid < qa.ask


def test_synthetic_candles_are_well_formed():
    bars = SyntheticFeed().candles("EURUSD", "M15", 50)
    assert len(bars) == 50
    for bar in bars:
        assert bar.low <= bar.open <= bar.high
        assert bar.low <= bar.close <= bar.high
        assert bar.timeframe == "M15"
    # strictly increasing, correctly spaced
    for prev, nxt in zip(bars, bars[1:]):
        assert nxt.time_msc - prev.time_msc == 15 * 60 * 1000


def test_quote_reports_source_age_not_arrival_age():
    now = int(time.time() * 1000)
    q = Quote(symbol="EURUSD", bid=1.0, ask=1.1, at=now - 5000)
    assert 4000 <= q.age_ms(now) <= 6000
    # A quote with no source stamp must say so rather than claim to be fresh.
    assert Quote(symbol="EURUSD", bid=1.0, ask=1.1, at=0).age_ms(now) == -1


def test_quote_converts_into_the_engine_tick_shape():
    q = Quote(symbol="EURUSD", bid=1.0800, ask=1.0802, at=1_700_000_000_000)
    tick = q.to_tick()
    assert tick.symbol == "EURUSD"
    assert tick.bid == 1.0800 and tick.ask == 1.0802
    assert tick.mid == pytest.approx(1.0801)
    assert tick.time.startswith("2023-")


# ------------------------------------------------------------------ yahoo


def _chart_payload(times, closes, price=None, opens=None):
    return {
        "chart": {
            "result": [{
                "meta": {"regularMarketPrice": price, "regularMarketTime": times[-1] if times else None},
                "timestamp": list(times),
                "indicators": {"quote": [{
                    "open": list(opens if opens is not None else closes),
                    "high": list(closes),
                    "low": list(closes),
                    "close": list(closes),
                    "volume": [1] * len(times),
                }]},
            }]
        }
    }


def test_yahoo_maps_symbols_to_its_own_tickers():
    f = YahooFeed()
    assert f._ticker("EURUSD") == "EURUSD=X"
    # Yahoo spells dollar-base pairs without the USD.
    assert f._ticker("USDJPY") == "JPY=X"
    assert f._ticker("XAUUSD") == "XAUUSD=X"


def test_yahoo_parses_a_quote(monkeypatch):
    f = YahooFeed()
    monkeypatch.setattr(f, "_chart", lambda *a, **k: _chart_payload([1_700_000_000], [1.0850], price=1.0851))
    res = f.quotes(["EURUSD"])
    assert res.ok
    q = res.quotes["EURUSD"]
    assert q.mid == pytest.approx(1.0851)
    assert q.at == 1_700_000_000_000


def test_yahoo_skips_the_null_padding_instead_of_drawing_zero_bars(monkeypatch):
    """Yahoo pads gaps with nulls; those are not candles."""
    f = YahooFeed()
    times = [1_700_000_000 + i * 60 for i in range(5)]
    closes = [1.08, None, 1.09, None, 1.10]
    monkeypatch.setattr(f, "_chart", lambda *a, **k: _chart_payload(times, closes))
    bars = f.candles("EURUSD", "M1", 10)
    assert len(bars) == 3
    assert all(b.close > 0 for b in bars)


def test_yahoo_reports_failure_rather_than_inventing_a_price(monkeypatch):
    f = YahooFeed()

    def boom(*a, **k):
        raise OSError("dns")

    monkeypatch.setattr(f, "_chart", boom)
    res = f.quotes(["EURUSD"])
    assert not res.ok
    assert res.quotes == {}
    assert f.candles("EURUSD", "M15", 10) == []


def test_one_bad_symbol_does_not_blank_the_watchlist(monkeypatch):
    f = YahooFeed()

    def chart(ticker, interval, rng):
        if ticker == "GBPUSD=X":
            raise OSError("timeout")
        return _chart_payload([1_700_000_000], [1.0850], price=1.0851)

    monkeypatch.setattr(f, "_chart", chart)
    res = f.quotes(["EURUSD", "GBPUSD", "USDJPY"])
    assert res.ok
    assert set(res.quotes) == {"EURUSD", "USDJPY"}


def test_h4_is_resampled_from_hourly_bars_on_epoch_boundaries():
    from aurion.mt5.types import Candle

    # Align to a 4h boundary. An arbitrary hour-aligned start is 2h into a
    # bucket, so eight bars would correctly span three of them -- which is
    # the epoch alignment working, not a bug.
    base = 1_700_000_000
    base -= base % (4 * 3600)
    bars = [
        Candle(symbol="EURUSD", timeframe="H1", time="", time_msc=(base + i * 3600) * 1000,
               open=1.0 + i, high=2.0 + i, low=0.5 + i, close=1.5 + i, volume=10)
        for i in range(8)
    ]
    out = resample(bars, 240)
    assert len(out) == 2
    for bar in out:
        assert bar.time_msc // 1000 % (4 * 3600) == 0
        assert bar.timeframe == "H4"
    assert out[0].open == bars[0].open
    assert out[0].close == bars[3].close
    assert out[0].high == max(b.high for b in bars[:4])
    assert out[0].low == min(b.low for b in bars[:4])
    assert out[0].volume == 40


# ----------------------------------------------------------------- manager


class FakeProvider:
    """A provider under the test's control."""

    id = "fake"
    label = "Fake"
    needs_key = False
    tick_true = True
    has_spread = True
    simulated = False

    def __init__(self):
        self.price = 1.1000
        self.at = 1_700_000_000_000
        self.calls = 0
        self.fail = False
        self.asked: list[list[str]] = []

    def available(self):
        return True

    def supports(self, s):
        return True

    def quotes(self, syms):
        from aurion.feed.base import FeedResult

        self.calls += 1
        self.asked.append(list(syms))
        if self.fail:
            return FeedResult(error="boom", provider=self.id)
        return FeedResult(
            quotes={s: Quote(symbol=s, bid=self.price - 0.0001, ask=self.price + 0.0001,
                             last=self.price, at=self.at) for s in syms},
            provider=self.id,
        )

    def candles(self, symbol, timeframe, count):
        from aurion.mt5.types import Candle
        from aurion.feed.base import tf_seconds

        step = tf_seconds(timeframe)
        now = self.at // 1000
        latest = now - (now % step)
        return [
            Candle(symbol=symbol, timeframe=timeframe, time="",
                   time_msc=(latest - i * step) * 1000,
                   open=1.0, high=1.0, low=1.0, close=1.0, volume=1)
            for i in range(count - 1, -1, -1)
        ]


def _mgr(**kw):
    return FeedManager(provider=FakeProvider(), watchlist=["EURUSD"], **kw)


def test_manager_only_polls_what_is_subscribed():
    m = _mgr()
    m.subscribe("GBPUSD", "XAUUSD")
    m.unsubscribe("EURUSD")
    m.poll_once()
    assert m.provider.asked[-1] == ["GBPUSD", "XAUUSD"]


def test_manager_ignores_unknown_symbols():
    m = _mgr()
    assert m.subscribe("NOTAPAIR") == []
    assert "NOTAPAIR" not in m.subscriptions


def test_manager_normalises_on_subscribe():
    m = _mgr()
    m.subscribe("eur/usd", "GBPUSD.m")
    assert m.subscriptions == ["EURUSD", "GBPUSD"]


def test_poll_records_a_tick():
    m = _mgr()
    assert m.poll_once() == 1
    tick = m.tick("EURUSD")
    assert tick is not None and tick.bid < tick.ask


def test_repeated_identical_prints_are_not_counted_as_updates():
    """A 1s poll on a slower source sees the same print repeatedly."""
    m = _mgr()
    assert m.poll_once() == 1
    assert m.poll_once() == 0
    m.provider.at += 1000
    m.provider.price = 1.1005
    assert m.poll_once() == 1


def test_candles_prime_from_the_provider_on_first_request():
    m = _mgr()
    bars = m.candles("EURUSD", "M15", 100)
    assert len(bars) == 100
    # second call is served from the buffer, not refetched
    before = m.provider.calls
    m.candles("EURUSD", "M15", 100)
    assert m.provider.calls == before


def test_quotes_grow_the_forming_candle():
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    last_before = m.candles("EURUSD", "M1", 10)[-1]
    slot = last_before.time_msc // 1000

    # a print inside the same minute
    m.provider.at = (slot + 10) * 1000
    m.provider.price = 1.2000
    m.poll_once()
    last = m.candles("EURUSD", "M1", 10)[-1]
    assert last.time_msc // 1000 == slot
    assert last.high == pytest.approx(1.2000)
    assert last.close == pytest.approx(1.2000)


def test_a_new_period_opens_a_new_candle_at_the_new_price():
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    n_before = len(m.candles("EURUSD", "M1", 500))
    slot = m.candles("EURUSD", "M1", 10)[-1].time_msc // 1000

    m.provider.at = (slot + 60) * 1000
    m.provider.price = 1.3000
    m.poll_once()
    bars = m.candles("EURUSD", "M1", 500)
    assert len(bars) == n_before + 1
    # A gap is information: the bar opens where it opened.
    assert bars[-1].open == pytest.approx(1.3000)
    assert bars[-1].time_msc // 1000 == slot + 60


def test_a_late_print_does_not_rewrite_a_closed_candle():
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    slot = m.candles("EURUSD", "M1", 10)[-1].time_msc // 1000
    m.provider.at = (slot + 60) * 1000
    m.provider.price = 1.3000
    m.poll_once()
    sealed = m.candles("EURUSD", "M1", 500)[-2]
    before = (sealed.open, sealed.high, sealed.low, sealed.close)

    m.provider.at = (slot + 30) * 1000  # late, belongs to the sealed bar
    m.provider.price = 9.9999
    m.poll_once()
    sealed = m.candles("EURUSD", "M1", 500)[-2]
    assert (sealed.open, sealed.high, sealed.low, sealed.close) == before


def test_provider_failure_is_reported_not_swallowed():
    m = _mgr()
    m.provider.fail = True
    assert m.poll_once() == 0
    st = m.status()
    assert st["error"] == "boom"
    assert st["errors"] >= 1
    assert m.tick("EURUSD") is None


def test_status_distinguishes_a_dead_feed_from_a_quiet_market():
    m = _mgr()
    # Four distinct states, where a single "last update" timestamp would
    # show one. A manager nobody started is not a broken feed.
    assert m.status()["state"] in ("stopped", "closed")

    m.start()
    try:
        m.provider.at = int(time.time() * 1000)
        m.poll_once()
        st = m.status()
        assert st["state"] in ("live", "closed")
        assert st["age_ms"] >= 0

        # an old print is stale, not live
        m.provider.at = int((time.time() - 600) * 1000)
        m.provider.price = 1.5
        m.poll_once()
        assert m.status()["state"] in ("stale", "closed")
    finally:
        m.stop()



def test_status_carries_the_provider_honesty_flags():
    m = FeedManager(provider=SyntheticFeed(), watchlist=["EURUSD"])
    st = m.status()
    assert st["simulated"] is True
    assert st["provider"] == "synthetic"

    m2 = FeedManager(provider=YahooFeed(), watchlist=["EURUSD"])
    st2 = m2.status()
    assert st2["simulated"] is False
    # Yahoo is real, but it is not a tick feed and carries no spread.
    assert st2["tick_true"] is False
    assert st2["has_spread"] is False


def test_build_feed_defaults_to_the_live_provider_and_never_silently_simulates():
    feed = build_feed()
    assert feed.provider.id == "yahoo"
    assert getattr(feed.provider, "simulated", False) is False
    assert build_feed("synthetic").provider.id == "synthetic"
    # An unknown name falls back to the live provider, not the simulator.
    assert build_feed("nonsense").provider.id == "yahoo"


def test_buffer_depth_is_bounded():
    from aurion.feed.manager import DEPTH

    m = _mgr()
    m.candles("EURUSD", "M1", 100)
    key = ("EURUSD", "M1")
    for i in range(DEPTH + 50):
        m.provider.at = (1_700_000_000 + i * 60) * 1000
        m.provider.price = 1.1 + i * 1e-5
        m.poll_once()
    assert len(m._bars[key]) <= DEPTH


def test_the_poll_thread_starts_and_stops():
    m = _mgr(interval=0.25)
    m.start()
    try:
        assert m.running
        time.sleep(0.6)
    finally:
        m.stop()
    assert not m.running


# ------------------------------------------------- push to the desk


def test_updates_are_pushed_not_polled():
    """The forming candle must move when a price lands, not on a refresh.

    The desk already renders `tick` and `candle` events off the trader's
    bus, so the feed emitting into it is what makes the open bar update in
    real time with no browser-side polling.
    """
    m = _mgr()
    seen: list[tuple[str, dict]] = []
    m.on_update(lambda ev, payload: seen.append((ev, payload)))
    m.candles("EURUSD", "M1", 10)

    slot = m.candles("EURUSD", "M1", 10)[-1].time_msc // 1000
    m.provider.at = (slot + 5) * 1000
    m.provider.price = 1.2345
    m.poll_once()

    kinds = [e for e, _ in seen]
    assert "tick" in kinds
    assert "candle" in kinds
    tick = next(p for e, p in seen if e == "tick")
    assert tick["symbol"] == "EURUSD"
    bar = next(p for e, p in seen if e == "candle")
    # The pushed bar is the one still forming, carrying the new price.
    assert bar["timeframe"] == "M1"
    assert bar["close"] == pytest.approx(1.2345)
    assert bar["time_msc"] // 1000 == slot


def test_nothing_is_pushed_when_the_price_has_not_moved():
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    m.poll_once()
    seen: list[str] = []
    m.on_update(lambda ev, payload: seen.append(ev))
    m.poll_once()  # identical print
    assert seen == []


def test_only_charted_timeframes_are_pushed():
    """Priming is what opts a timeframe in, so traffic stays bounded."""
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    m.candles("EURUSD", "M15", 10)
    seen: list[dict] = []
    m.on_update(lambda ev, p: seen.append(p) if ev == "candle" else None)
    m.provider.at += 60_000
    m.provider.price = 1.2
    m.poll_once()
    assert sorted(b["timeframe"] for b in seen) == ["M1", "M15"]


def test_a_broken_observer_cannot_kill_the_feed():
    m = _mgr()
    m.candles("EURUSD", "M1", 10)

    def bad(ev, payload):
        raise RuntimeError("sink exploded")

    good: list[str] = []
    m.on_update(bad)
    m.on_update(lambda ev, p: good.append(ev))
    m.provider.at += 60_000
    m.provider.price = 1.25
    assert m.poll_once() == 1
    assert good, "a failing sink must not stop the others"


def test_observers_are_called_outside_the_lock():
    """A sink that calls back into the manager must not deadlock it."""
    m = _mgr()
    m.candles("EURUSD", "M1", 10)
    reentered: list[int] = []

    def sink(ev, payload):
        # Re-entering the manager from the callback is exactly what the
        # API bridge does when it serialises status() for a client.
        reentered.append(len(m.subscriptions))

    m.on_update(sink)
    m.provider.at += 60_000
    m.provider.price = 1.26
    m.poll_once()
    assert reentered
