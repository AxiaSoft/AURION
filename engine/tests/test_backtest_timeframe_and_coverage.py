"""A timeframe nothing has asked MetaTrader for yet, and a square that
said the wrong thing about itself.

Reported, in these words:

* "I ran a backtest on M5 for a symbol whose chart in the app was on
  H1, and it said there is nothing for M5."
* "Show the state of the analysis properly - that box is half the
  screen with 'analysing' in it, and then the signals come out
  OUTSIDE the box."

The backtest one is not a missing archive. A timeframe no chart has
ever been opened on does not exist in the terminal until something
asks for it: ``CopyRates`` on it returns nothing while MetaTrader goes
to the broker, and the expert answers the ask it was given out of what
it has at that moment, which is nothing. One ask was all the backtest
made, and "none arrived" was then reported as "this broker has no M5
history for this symbol" - a verdict on the data when the truth was a
download that had just started. So: ask more than once, and when the
answer is still empty, say which of the two it is. They need opposite
things from the trader - wait, or stop trying this symbol.

The analysis one was a label on the wrong rectangle. The shaded region
is the stretch that has NOT been analysed yet; calling it "analysing"
made it a claim about itself, and the marks found in the analysed part
then appeared outside the box that supposedly contained the work. The
engine now reports the analysed span by TIME as well as by index, plus
the slab the next pass will take, so the desk can draw the boundary and
the working slab as two different things.

Run:
    python3 -m pytest engine/tests/test_backtest_timeframe_and_coverage.py -q
"""

from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.mt5.bridge import MT5Bridge  # noqa: E402
from aurion.runtime.trader import Trader  # noqa: E402


def _bars(n: int, minutes: int = 5, start: int = 0) -> list[dict[str, Any]]:
    when = dt.datetime(2026, 4, 1) + dt.timedelta(minutes=minutes * start)
    out = []
    price = 1.1000
    for i in range(n):
        price += 0.0001 if i % 3 else -0.00005
        out.append({
            "time": (when + dt.timedelta(minutes=minutes * i)).isoformat() + "Z",
            "open": round(price, 5), "high": round(price + 0.0004, 5),
            "low": round(price - 0.0004, 5), "close": round(price, 5),
            "volume": 100 + i,
        })
    return out


# ───────────────────────── the bridge is willing to ask again ─────────

def _cold_bridge(answers_on: int, rows: list[dict[str, Any]]):
    """A bridge whose expert only produces the series on the Nth ask.

    That is the real shape of it: the first ``CopyRates`` on an
    unopened timeframe returns nothing and starts a download, and the
    bars exist by the time something asks a second time.
    """
    b = MT5Bridge()
    b.is_ea_symbol = lambda _s: True
    b.native.connected = False
    asks: list[int] = []

    async def request(symbol, tf, timeout=0.0, count=0):
        asks.append(count)
        if len(asks) >= answers_on:
            from aurion.mt5.types import Candle
            made = [
                Candle(symbol=symbol, timeframe=b._norm_tf(tf), time=r["time"],
                       time_msc=0, open=r["open"], high=r["high"], low=r["low"],
                       close=r["close"], volume=r["volume"])
                for r in rows
            ]
            bucket = b._tape_store("live")["candles"][(symbol, b._norm_tf(tf))]
            bucket.clear()
            bucket.extend(made)
            return made
        return []

    b._request_ea_history = request
    b._warm_from_disk = lambda *_a, **_k: []
    b._archive = lambda *_a, **_k: None
    return b, asks


def test_one_ask_is_still_the_default() -> None:
    """Everything on a timer keeps the old behaviour.

    A poll that re-asks until it gets an answer is a poll that never
    stops, and the back-off exists to stop exactly that.
    """
    rows = _bars(900)
    b, asks = _cold_bridge(answers_on=3, rows=rows)
    got = asyncio.run(b.pull_candles("EURUSD", "M5", 500))
    assert len(asks) == 1, f"an ordinary caller asked {len(asks)} times"
    assert got == []


def test_a_trader_waiting_on_an_answer_can_insist() -> None:
    rows = _bars(900)
    b, asks = _cold_bridge(answers_on=3, rows=rows)
    got = asyncio.run(b.pull_candles("EURUSD", "M5", 500, tries=3))
    assert len(asks) == 3, f"gave up after {len(asks)}"
    assert len(got) == 900, "the series that finally arrived was thrown away"


def test_it_stops_as_soon_as_the_series_is_long_enough() -> None:
    """Three tries is a ceiling, not a quota.

    The window a caller gets is floored to the six months the product
    promises, so "long enough" means that window and not the number in
    the call - which is why the first test here is answered three
    times for a 900-bar series.
    """
    rows = _bars(52_000)
    b, asks = _cold_bridge(answers_on=1, rows=rows)
    asyncio.run(b.pull_candles("EURUSD", "M5", 500, tries=3))
    assert len(asks) == 1, "it kept asking for a series it already had"


def test_the_cooldown_still_guards_the_first_ask() -> None:
    """Otherwise `tries` would be a way around the back-off entirely."""
    rows = _bars(900)
    b, asks = _cold_bridge(answers_on=99, rows=rows)
    b._may_ask_history = lambda *_a, **_k: False
    asyncio.run(b.pull_candles("EURUSD", "M5", 500, tries=3))
    assert asks == [], "a symbol in its cooldown was asked anyway"


# ──────────────────── waiting and absent are different answers ────────

def _trader_with_no_bars(depth: dict[str, Any]) -> Trader:
    t = Trader()
    t._is_ea_symbol = lambda _s: True

    async def pull(*_a, **_k):
        return []

    t.bridge.pull_candles = pull
    t.bridge.candles_of = lambda *_a, **_k: []
    t.bridge.hist_depth = lambda *_a, **_k: dict(depth)
    return t


def test_a_download_in_progress_is_not_a_missing_archive() -> None:
    """The terminal has not answered at all yet."""
    t = _trader_with_no_bars({})
    out = asyncio.run(t.backtest({"symbol": "EURUSD", "timeframe": "M5"}))
    assert out["ok"] is False
    assert out["code"] == "history_downloading", \
        "a series that is still coming down was reported as a series that does not exist"
    assert out.get("downloading") is True
    assert out["args"]["timeframe"] == "M5", \
        "the refusal must name the timeframe ASKED FOR, not the chart's"


def test_a_terminal_that_answered_none_is_believed() -> None:
    """It said it holds nothing. Waiting will not change that."""
    t = _trader_with_no_bars({"at": 1234567890.0, "available": 0, "requested": 5000})
    out = asyncio.run(t.backtest({"symbol": "EURUSD", "timeframe": "M5"}))
    assert out["code"] == "no_history", \
        "the trader is left waiting for bars the broker does not have"


def test_an_answer_that_promises_bars_is_a_download() -> None:
    t = _trader_with_no_bars({"at": 1234567890.0, "available": 40000, "requested": 51840})
    out = asyncio.run(t.backtest({"symbol": "EURUSD", "timeframe": "M5"}))
    assert out["code"] == "history_downloading"


def test_the_run_uses_the_timeframe_it_was_given() -> None:
    """Independent of whatever the desk happens to be showing."""
    t = _trader_with_no_bars({})
    t.active_timeframe = "H1"
    seen: list[str] = []

    async def pull(symbol, timeframe, *_a, **kw):
        seen.append(timeframe)
        assert kw.get("tries", 1) >= 2, "a cold timeframe is still asked for only once"
        return []

    t.bridge.pull_candles = pull
    asyncio.run(t.backtest({"symbol": "EURUSD", "timeframe": "M5"}))
    assert seen == ["M5"], f"the H1 chart dragged the run onto {seen}"


def test_a_period_outside_a_filling_series_says_it_is_filling() -> None:
    """'This terminal only has April onwards' is a lie while April is
    still arriving - it sends the trader to change broker settings over
    a window that is about to show up by itself."""
    t = Trader()
    t._is_ea_symbol = lambda _s: True
    held = _bars(300)  # far short of any sane `want` for M5
    t.bridge.candles_of = lambda *_a, **_k: []

    async def pull(*_a, **_k):
        return held

    t.bridge.pull_candles = pull
    t.bridge.hist_depth = lambda *_a, **_k: {}
    out = asyncio.run(t.backtest({
        "symbol": "EURUSD", "timeframe": "M5",
        "from": "2025-01-01", "to": "2025-01-31",
    }))
    assert out["ok"] is False
    assert out["code"].endswith("_filling"), f"reported {out['code']} as settled fact"
    assert out["args"].get("filling") is True


# ─────────────────── which candles, precisely, and which next ─────────

def _merged(total: int, held_from: int | None = None, held_to: int | None = None):
    t = Trader()
    bars = _bars(total, minutes=15)
    armed: list[Any] = []
    key = t._chart_mark_key("EURUSD", "M15", armed)
    if held_from is not None:
        t._marks_store()[key] = {
            "from_time": bars[held_from]["time"],
            "to_time": bars[held_to]["time"],
            "signals": [],
        }
    plan = t._chart_mark_plan("EURUSD", "M15", armed, bars)
    result = {"signals": [], "covered_from": plan["first"], "covered_to": plan["last"]}
    out = t._chart_marks_merge("EURUSD", "M15", armed, bars, plan, result)
    return out, bars


def test_the_analysed_span_is_reported_by_time_as_well_as_index() -> None:
    """An index is not something a trader can check. The desk holds a
    different slice of the history than the engine analysed, so it
    cannot turn 14 200 into a date on its own."""
    out, bars = _merged(5000)
    assert out["covered_from_time"] == bars[out["covered_from"]]["time"]
    assert out["covered_to_time"] == bars[out["covered_to"] - 1]["time"]
    assert out["total_bars"] == 5000


def test_the_next_slab_is_named_so_the_box_can_point_at_it() -> None:
    out, bars = _merged(5000)
    assert out["complete"] is False
    assert isinstance(out["next_from"], int) and isinstance(out["next_to"], int)
    assert out["next_from"] < out["next_to"] <= 5000
    assert out["next_to"] <= out["covered_from"] + 1, \
        "the next pass is advertised over bars that are already analysed"
    assert out["next_from_time"] == bars[out["next_from"]]["time"]


def test_a_finished_chart_advertises_no_next_slab() -> None:
    """Otherwise the desk outlines a slab nobody is working on, for ever."""
    out, _bars_ = _merged(300, held_from=0, held_to=299)
    assert out["complete"] is True
    assert out["analysing"] is False
    assert out["next_from"] is None and out["next_to"] is None
    assert out["next_from_time"] == "" and out["next_to_time"] == ""


def test_a_bar_that_closes_is_analysed_without_redoing_the_history() -> None:
    """Reported: "it should be signalling all the way to the head of
    the chart, and it is not."

    A finished chart does not stay finished - a bar closes every
    minute and the right-hand edge moves away from the analysis. The
    engine has to notice and catch up, and catching up has to be
    CHEAP, or every closing bar would cost a full replay and the desk
    could not afford to ask.
    """
    t = Trader()
    bars = _bars(1000, minutes=15)
    armed: list[Any] = []
    key = t._chart_mark_key("EURUSD", "M15", armed)
    # Where the trader was left: everything analysed, engine content.
    t._marks_store()[key] = {
        "from_time": bars[0]["time"], "to_time": bars[-1]["time"], "signals": [],
    }
    assert t._chart_mark_plan("EURUSD", "M15", armed, bars).get("complete") is True

    # Two more bars close.
    grown = bars + _bars(2, minutes=15, start=len(bars))
    plan = t._chart_mark_plan("EURUSD", "M15", armed, grown)
    assert plan.get("complete") is not True, "a chart that grew still calls itself finished"
    assert plan["last"] == len(grown), "the newest bar is not in the slab to analyse"
    assert plan["last"] - plan["first"] <= 3, \
        f"re-analysed {plan['last'] - plan['first']} bars because two arrived"

    res = {"signals": [], "covered_from": plan["first"], "covered_to": plan["last"]}
    out = t._chart_marks_merge("EURUSD", "M15", armed, grown, plan, res)
    assert out["covered_to"] == len(grown)
    assert out["covered_to_time"] == grown[-1]["time"], "coverage does not reach the newest candle"
    assert out["complete"] is True


def test_the_span_only_ever_grows_towards_the_start() -> None:
    """Coverage walking backwards is the whole point; a pass that
    narrowed it would make the box jump about."""
    t = Trader()
    bars = _bars(5000, minutes=15)
    armed: list[Any] = []
    first = None
    for _ in range(3):
        plan = t._chart_mark_plan("EURUSD", "M15", armed, bars)
        res = {"signals": [], "covered_from": plan["first"], "covered_to": plan["last"]}
        out = t._chart_marks_merge("EURUSD", "M15", armed, bars, plan, res)
        if first is not None:
            assert out["covered_from"] <= first, "the analysed span went backwards"
        first = out["covered_from"]
        assert out["covered_to"] == 5000, "the right-hand edge stopped being covered"


@pytest.mark.parametrize("code", [
    "history_downloading", "no_bars_in_period_filling", "no_bars_in_period_have_filling",
])
def test_every_new_refusal_has_a_sentence_in_all_three_packs(code: str) -> None:
    import json
    packs = ROOT.parent / "lang"
    for name in ("en", "fa", "ar"):
        pack = json.loads((packs / f"{name}.json").read_text(encoding="utf-8"))
        assert isinstance(pack.get("engerr", {}).get(code), str), f"{name} has no {code}"
