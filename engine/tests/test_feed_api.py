"""The feed's HTTP surface.

These call the endpoint coroutines directly rather than through a live
server, so the whole Trader does not have to boot to prove the routes work.
The provider is swapped for the deterministic simulator, because this
sandbox -- and plenty of customer machines -- cannot reach the internet.

The point being defended: these endpoints must answer with no MetaTrader
terminal anywhere in the picture.  That is the entire reason they exist.
"""

from __future__ import annotations

import asyncio

import pytest

from aurion.feed import FeedManager
from aurion.feed.synthetic import SyntheticFeed


@pytest.fixture()
def api(monkeypatch):
    """The server module with a deterministic offline feed attached."""
    from aurion.api import server

    mgr = FeedManager(provider=SyntheticFeed(), watchlist=["EURUSD", "GBPUSD"])
    monkeypatch.setattr(server, "feed", mgr)
    return server


def run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


def test_status_reports_the_provider_and_its_flags(api):
    res = run(api.feed_status())
    assert res["ok"]
    data = res["data"]
    assert data["provider"] == "synthetic"
    # The desk must be able to tell the trader this is not the market.
    assert data["simulated"] is True
    assert "state" in data and "market_open" in data


def test_symbol_search_is_ranked_not_alphabetical(api):
    res = run(api.feed_symbols(q="jpy", limit=5))
    assert res["ok"]
    names = [s["name"] for s in res["data"]["symbols"]]
    assert names[0] == "USDJPY"
    assert res["data"]["total"] > 120


def test_symbol_search_can_filter_by_kind(api):
    res = run(api.feed_symbols(q="", limit=100, kind="metal"))
    assert {s["kind"] for s in res["data"]["symbols"]} == {"metal"}


def test_symbol_search_carries_the_spec_the_chart_needs(api):
    res = run(api.feed_symbols(q="usdjpy", limit=1))
    spec = res["data"]["symbols"][0]
    assert spec["name"] == "USDJPY"
    assert spec["digits"] == 3
    assert spec["pip"] == pytest.approx(0.01)
    assert spec["description"]


def test_groups_cover_the_whole_universe(api):
    res = run(api.feed_groups())
    groups = res["data"]["groups"]
    assert sum(len(v) for v in groups.values()) == res["data"]["total"]
    assert set(groups) == {"major", "minor", "metal", "exotic"}


def test_candles_render_without_any_terminal(api):
    res = run(api.feed_candles(symbol="EURUSD", timeframe="M15", count=120))
    assert res["ok"]
    data = res["data"]
    assert data["symbol"] == "EURUSD"
    assert data["count"] == 120
    assert len(data["candles"]) == 120
    first = data["candles"][0]
    assert first["low"] <= first["open"] <= first["high"]
    # the spec travels with the bars so the chart can format prices
    assert data["spec"]["digits"] == 5


def test_candles_accept_a_broker_spelling(api):
    res = run(api.feed_candles(symbol="eur/usd.m", timeframe="M5", count=10))
    assert res["ok"]
    assert res["data"]["symbol"] == "EURUSD"


def test_candles_refuse_an_unknown_symbol_instead_of_inventing_one(api):
    res = run(api.feed_candles(symbol="NOTAPAIR"))
    assert not res["ok"]
    assert res["error"] == "unknown_symbol"


def test_opening_a_chart_subscribes_the_symbol(api):
    assert "XAUUSD" not in api.feed.subscriptions
    run(api.feed_candles(symbol="XAUUSD", timeframe="M15", count=10))
    assert "XAUUSD" in api.feed.subscriptions


def test_quotes_subscribe_and_return_prices(api):
    api.feed.poll_once()
    res = run(api.feed_quotes(symbols="EURUSD,GBPUSD"))
    assert res["ok"]
    quotes = res["data"]["quotes"]
    assert set(quotes) == {"EURUSD", "GBPUSD"}
    assert quotes["EURUSD"]["bid"] < quotes["EURUSD"]["ask"]
    assert res["data"]["status"]["provider"] == "synthetic"


def test_subscribe_can_replace_the_whole_set(api):
    run(api.feed_subscribe({"symbols": ["USDJPY"], "replace": True}))
    assert api.feed.subscriptions == ["USDJPY"]


def test_subscribe_ignores_junk(api):
    res = run(api.feed_subscribe({"symbols": ["NOTAPAIR", "EURJPY"]}))
    assert res["data"]["added"] == ["EURJPY"]
