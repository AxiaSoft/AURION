"""A three-month backtest replays three months, not last month.

Reported in these words: "in the backtest, when I want to test three
months, or pick a range of several months by date, it has to download
as many candles as it needs - it must not just use last month's
candles".

It did exactly that, and the reason was a single line. History comes
down one month per round: the expert serves a month of new bars per
request and the engine asks again for the next month. The loop that
drives those rounds stopped the first time a round brought nothing
new:

    if not gained:
        break

A round brings nothing new far more often because the download it
just started has not landed than because the broker has no more
history. MetaTrader answers a period it does not hold by starting a
fetch and returning -1 meanwhile; that fetch can take a minute and a
half, and the engine's own wait for the reply is 8 to 25 seconds. So
the normal shape of a deep download - ask, wait, nothing yet, ask
again - was read as "there is no more", the loop ended after about
one month, and the run was replayed over whatever had arrived. No
error was raised, because a month of bars inside a three-month window
is not an empty slice.

What is pinned here:

  1. A round that brings nothing is retried, not treated as a
     verdict, and the loop keeps going until the period is covered.
  2. A terminal that really has no more history ends the loop. The
     test for that is MetaTrader's own SERIES_FIRSTDATE, not a guess.
  3. The request answers inside the desk's 25 second proxy window,
     and the rest of the download continues behind the answer.
  4. A period that could not be fully covered is stated on the
     result rather than silently replaced by a shorter one.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from aurion.runtime.trader import Trader, _period_shortfall

ROOT = Path(__file__).resolve().parents[2]


def _run(coro):
    return asyncio.run(coro)


def _bare() -> Trader:
    """A Trader with nothing started: only the history logic is wanted."""
    return Trader.__new__(Trader)


class _Bridge:
    """A terminal that serves one month per request, as the real one does.

    `months_available` is how deep the broker will go. Every call
    hands back what has been "downloaded" so far; a call that asks
    beyond what is downloaded starts the next month and returns the
    old answer, exactly like CopyRates answering -1 while it fetches.
    """

    def __init__(self, months_available: int = 6, lag_rounds: int = 1,
                 bars_per_month: int = 100) -> None:
        self.months_available = months_available
        self.lag_rounds = lag_rounds
        self.bars_per_month = bars_per_month
        self.downloaded = 1
        self.pending = 0
        self.calls = 0
        self.asked: list[int] = []

    def _norm_tf(self, tf: str) -> str:
        return str(tf)

    def _series(self) -> list[dict[str, object]]:
        total = self.downloaded * self.bars_per_month
        out = []
        for i in range(total):
            # Oldest first. Day 1 of the window is `downloaded` months back.
            day = i + 1
            month = (day - 1) // self.bars_per_month
            out.append({"time": f"2026-{(6 - self.downloaded + month) + 1:02d}-"
                                f"{(day - 1) % self.bars_per_month + 1:02d}T00:00:00"})
        return out

    async def pull_candles(self, symbol, timeframe, count=0, need_from="", tries=1):
        self.calls += 1
        self.asked.append(int(count or 0))
        if self.pending > 0:
            self.pending -= 1
            if self.pending == 0 and self.downloaded < self.months_available:
                self.downloaded += 1
        elif self.downloaded < self.months_available:
            # A new month was asked for: start fetching it.
            self.pending = self.lag_rounds
        return self._series()

    def hist_depth(self, symbol, timeframe):
        return {
            "at": time.time(),
            "available": self.downloaded * self.bars_per_month,
            "oldest": f"2026-{6 - self.downloaded + 1:02d}-01T00:00:00",
        }


def _oldest(bars) -> str:
    return str((bars[0] or {}).get("time") or "")[:10] if bars else ""


# ===================== the loop that gave up too early =====================


def test_a_round_that_brings_nothing_is_not_a_verdict() -> None:
    """The one-line bug, pinned.

    The terminal needs a round to fetch each month. With the old
    `break` the loop ended on the first of those and came back with
    one month; it has to come back with the three that were asked
    for.
    """
    t = _bare()
    t.bridge = _Bridge(months_available=6, lag_rounds=1)
    t.BACKTEST_SETTLE_S = 0.0

    async def go() -> None:
        bars = await t._pull_history_in_steps("XAUUSD", "M5", 0, "2026-04-01")
        assert _oldest(bars) <= "2026-04-01", (
            f"the download stopped at {_oldest(bars)} with the period "
            f"starting 2026-04-01 - a barren round ended the loop again"
        )

    _run(go())


def test_a_slow_terminal_is_waited_for() -> None:
    """Two or three empty rounds in a row are still a download.

    A busy terminal on a slow link can take several of the engine's
    rounds to produce one month. The loop has to outlast that.
    """
    t = _bare()
    t.bridge = _Bridge(months_available=6, lag_rounds=3)
    t.BACKTEST_SETTLE_S = 0.0

    async def go() -> None:
        bars = await t._pull_history_in_steps("XAUUSD", "M5", 0, "2026-03-01")
        assert _oldest(bars) <= "2026-03-01", (
            f"gave up at {_oldest(bars)} on a terminal that just needed "
            f"a few more seconds"
        )

    _run(go())


def test_a_broker_with_no_more_history_stops_being_asked() -> None:
    """Persistence is not the same thing as a loop that cannot stop.

    Nothing MetaTrader reports tells a fetch in progress apart from a
    broker with nothing left - SERIES_BARS_COUNT only grows when bars
    land, so it reads the same either way. The loop therefore does
    not guess; it asks a bounded number of further times and takes
    the absence of new bars as the answer.
    """
    t = _bare()
    bridge = _Bridge(months_available=2, lag_rounds=1)
    t.bridge = bridge
    t.BACKTEST_SETTLE_S = 0.0

    async def go() -> None:
        bars = await t._pull_history_in_steps("XAUUSD", "M5", 0, "2020-01-01")
        assert bars, "what the broker does have is still returned"
        assert bridge.calls <= t.BACKTEST_MAX_STEPS, "bounded either way"
        assert bridge.calls <= t.BACKTEST_BARREN_ROUNDS + 4, (
            f"{bridge.calls} rounds against a terminal that stopped "
            f"producing - that is a download storm, not persistence"
        )

    _run(go())


def test_a_terminal_that_served_everything_is_not_waited_for_twice() -> None:
    """The second ask gets a run, not another "please wait".

    "Still downloading" is honest the first time: the background fill
    is running. Once that fill has reached its own end, whatever it
    managed is the broker's answer, and saying "wait" again would be
    waiting for nothing.
    """
    t = _bare()
    t._fill_exhausted = {}
    t._filling_history = set()
    t._fill_tasks = set()
    t.bridge = _Bridge(months_available=2, lag_rounds=1)
    t.BACKTEST_SETTLE_S = 0.0

    async def go() -> None:
        await t._keep_filling_history("XAUUSD", "M5", 0, "2020-01-01")
        assert t._fill_exhausted.get(("XAUUSD", "M5")) == "2020-01-01", (
            "a finished fill left no record, so the next attempt will ask "
            "the trader to wait for a download that already ended"
        )

    _run(go())


def test_the_loop_cannot_run_for_ever() -> None:
    """A hard stop, whatever the terminal does.

    This bridge always reports more coming and never delivers it -
    the shape of a terminal stuck on a symbol the broker is not
    serving. The loop must still end.
    """
    t = _bare()

    class _Liar(_Bridge):
        async def pull_candles(self, *a, **kw):
            self.calls += 1
            return self._series()

        def hist_depth(self, symbol, timeframe):
            return {"at": time.time(), "available": 10 ** 9, "oldest": ""}

    bridge = _Liar()
    t.bridge = bridge
    t.BACKTEST_SETTLE_S = 0.0

    async def go() -> None:
        await t._pull_history_in_steps("XAUUSD", "M5", 0, "2020-01-01")
        assert bridge.calls <= t.BACKTEST_MAX_STEPS, (
            f"{bridge.calls} rounds - the ceiling is not holding"
        )
        # And the ceiling itself has to be a ceiling. Each round can
        # wait seconds on the expert, so the number is a promise about
        # how long a stuck series may occupy the engine.
        assert t.BACKTEST_MAX_STEPS <= 24, (
            f"BACKTEST_MAX_STEPS is {t.BACKTEST_MAX_STEPS}; at a step a "
            f"month that is years of history and minutes of asking"
        )
        assert bridge.calls <= 24, f"{bridge.calls} rounds is not bounded"

    _run(go())


def test_the_request_answers_before_the_proxy_gives_up() -> None:
    """17 seconds of fetching, not 170.

    The desk's proxy allows one request 25 seconds and reads anything
    slower as "the engine is offline". A download that needs longer
    than that is finished behind the answer - see
    _keep_filling_history - but the answer itself has to come back.
    """
    t = _bare()

    class _Slow(_Bridge):
        """Always produces a bit more, slowly - so only the budget stops it.

        A bridge that produced nothing would be stopped by the
        barren-round ceiling instead, and the budget would never be
        tested at all.
        """

        async def pull_candles(self, *a, **kw):
            self.calls += 1
            await asyncio.sleep(0.08)
            self.downloaded += 1
            return [{"time": f"2020-01-01T00:00:0{i % 10}"} for i in range(self.downloaded)]

        def hist_depth(self, symbol, timeframe):
            return {"at": time.time(), "available": 10 ** 9, "oldest": ""}

    t.bridge = _Slow()
    t.BACKTEST_SETTLE_S = 0.05

    async def go() -> None:
        start = time.monotonic()
        await t._pull_history_in_steps(
            "XAUUSD", "M5", 0, "2019-01-01", budget_s=0.2,
        )
        spent = time.monotonic() - start
        assert t.bridge.calls > 1, "the budget stopped it before it started"
        assert spent < 0.6, (
            f"the fetch ran {spent:.2f}s against a 0.2s budget; with the "
            f"real budget that is a 504 and a desk saying the engine died"
        )

    _run(go())


def test_the_budget_is_well_inside_the_proxys_patience() -> None:
    """The numbers themselves, because they have to agree.

    `engine.js` gives a proxied request 25 000 ms. The fetch budget
    plus the slowest single round has to fit inside that with room to
    spare, or the fix for one fault becomes the other one.
    """
    proxy = (ROOT / "backend" / "src" / "engine.js").read_text(encoding="utf-8")
    assert "timeoutMs = 25000" in proxy, (
        "the proxy timeout moved - the backtest fetch budget is set "
        "against it and has to move with it"
    )
    assert Trader.BACKTEST_FETCH_BUDGET_S <= 20.0, (
        "the request's own history fetch can now outlast the proxy"
    )
    assert Trader.BACKTEST_FILL_BUDGET_S > Trader.BACKTEST_FETCH_BUDGET_S, (
        "the background continuation has to outlast the request, or it "
        "adds nothing"
    )


# ===================== finishing behind the answer =========================


def test_the_rest_of_the_download_continues_after_the_answer() -> None:
    """The refusal is not the end of the download.

    "Still downloading, try again" is only a fair answer if something
    is actually still downloading. The request starts the
    continuation before it returns.
    """
    t = _bare()
    bridge = _Bridge(months_available=6, lag_rounds=1)
    t.bridge = bridge
    t.BACKTEST_SETTLE_S = 0.0
    t._filling_history = set()
    t._fill_tasks = set()
    t._fill_exhausted = {}

    async def go() -> None:
        t._fill_history_later("XAUUSD", "M5", 0, "2026-02-01")
        assert t._fill_tasks, "nothing was started"
        await asyncio.gather(*list(t._fill_tasks))
        assert _oldest(bridge._series()) <= "2026-02-01", (
            "the continuation did not get the rest of the period"
        )
        assert not t._filling_history, "the series was left marked as busy"

    _run(go())


def test_one_download_per_series_however_often_it_is_asked_for() -> None:
    """A trader pressing the button four times is still one download."""
    t = _bare()
    t.bridge = _Bridge(months_available=6, lag_rounds=1)
    t.BACKTEST_SETTLE_S = 0.0
    t._filling_history = set()
    t._fill_tasks = set()
    t._fill_exhausted = {}

    async def go() -> None:
        # What one press costs, measured rather than assumed.
        alone = _bare()
        alone.bridge = _Bridge(months_available=6, lag_rounds=1)
        alone.BACKTEST_SETTLE_S = 0.0
        alone._filling_history = set()
        alone._fill_tasks = set()
        alone._fill_exhausted = {}
        alone._fill_history_later("XAUUSD", "M5", 0, "2026-02-01")
        await asyncio.gather(*list(alone._fill_tasks))
        once = alone.bridge.calls

        for _ in range(4):
            t._fill_history_later("XAUUSD", "M5", 0, "2026-02-01")
        await asyncio.gather(*list(t._fill_tasks))
        assert t.bridge.calls == once, (
            f"four presses cost {t.bridge.calls} rounds against {once} for "
            f"one - four downloads of the same series are running"
        )

    _run(go())


# ===================== saying so, when it could not be done ================


@pytest.mark.parametrize(
    "asked,have,expect",
    [
        ("2026-01-01", "2026-03-05", 63),   # two months missing: real
        ("2026-01-01", "2026-01-03", 0),    # a long weekend: not a shortfall
        ("2026-01-05", "2026-01-05", 0),    # exact
        ("", "2026-01-05", 0),              # no period asked for
        ("2026-03-01", "2026-02-01", 0),    # more than asked for is not less
    ],
)
def test_a_short_period_is_measured_not_guessed(asked, have, expect) -> None:
    assert _period_shortfall(asked, have) == expect


def test_the_result_carries_the_period_that_was_asked_for() -> None:
    """So a short run can never be read as a full one.

    The backtester answers about the bars it was handed and knows
    nothing about the period on screen. Without carrying these
    through, a run that covered one of three months looks identical
    to one that covered all three.
    """
    src = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    accepted = src[src.index('"accepted": True'):]
    accepted = accepted[:accepted.index("await self.bus.publish")]
    for field in ('"asked_from"', '"short_days"', '"period_short"'):
        assert field in accepted, f"the accepted run does not state {field}"
    finish = src[src.index('result["mode"] = "backtest"'):]
    finish = finish[:finish.index("self.backtest_run = result")]
    assert "period_short" in finish, (
        "the shortfall is announced while the run goes and forgotten when "
        "it finishes - which is when the numbers are read"
    )


def test_the_desk_shows_the_shortfall_and_waits_out_a_download() -> None:
    """The two desk-side halves of this, pinned where they are easy to lose."""
    app = (ROOT / "apps" / "web" / "js" / "app.js").read_text(encoding="utf-8")
    card = app[app.index("function renderBacktestCard"):]
    card = card[:card.index("\n}\n")]
    assert "btShortfallNote(" in card, (
        "the result card no longer states a period it could not cover"
    )
    assert "bt.period_short" in app, "...with a translated sentence"
    assert "postBacktestWhenHistoryIsReady(" in app, (
        "the desk no longer waits for the period to finish downloading"
    )
    waiter = app[app.index("async function postBacktestWhenHistoryIsReady"):]
    waiter = waiter[:waiter.index("\n}\n")]
    assert "S._btCancelling" in waiter, "the wait cannot be stopped"
    assert "Date.now() >= until" in waiter, (
        "the wait has no deadline - a desk that waits for ever on a period "
        "that is never coming is the same fault with a nicer spinner"
    )
    assert "history_downloading" in waiter, "the download refusals are not recognised"
    assert "_filling" in waiter, "...nor the ones that end in _filling"

    for lang in ("en", "fa", "ar"):
        import json
        pack = json.loads((ROOT / "lang" / f"{lang}.json").read_text(encoding="utf-8"))
        assert pack["bt"]["period_short"], f"{lang} has no shortfall sentence"
        assert pack["engerr"]["history_filling_period"], f"{lang} has no waiting sentence"


def test_a_cancelled_wait_does_not_ask_the_engine_to_cancel_nothing() -> None:
    """Stop, while waiting, stops the waiting.

    There is no run in the engine yet. Posting a cancel would be
    answered "nothing is running", which used to clear the cancelling
    flag and leave the desk waiting on a trader who had asked it to
    stop.
    """
    app = (ROOT / "apps" / "web" / "js" / "app.js").read_text(encoding="utf-8")
    body = app[app.index("async function cancelBacktest"):]
    body = body[:body.index("\n}\n")]
    assert "_btWaitingHistory" in body, "stop still posts a cancel for no run"
    assert body.index("_btWaitingHistory") < body.index("/api/backtest/cancel"), (
        "the waiting case has to be handled before the post, not after it"
    )


# ===================== not writing the same series fifty times =============


def test_an_unchanged_series_is_not_archived_again() -> None:
    """Every round used to rewrite the whole history to disk.

    A deep download is many rounds and most of them bring nothing
    new; six months of M1 is a quarter of a million rows and was
    measured at 2.4 seconds of executemany. Writing that fifty times
    for one download is minutes of disk for nothing.
    """
    from aurion.mt5.bridge import MT5Bridge
    from aurion.mt5.types import Candle

    writes: list[int] = []
    bridge = MT5Bridge()
    bridge.use_candle_archive(
        save=lambda sym, tf, rows: writes.append(len(rows)),
        load=lambda sym, tf, count: [],
    )
    rows = [
        Candle(symbol="XAUUSD", timeframe="M5", time=f"2026-01-01T00:{i:02d}:00",
               time_msc=i, open=1, high=2, low=0.5, close=1.5, volume=1, spread=1)
        for i in range(50)
    ]

    async def go() -> None:
        await bridge.archive_candles("XAUUSD", "M5", rows)
        await bridge.archive_candles("XAUUSD", "M5", rows)
        await bridge.archive_candles("XAUUSD", "M5", rows)
        assert writes == [50], (
            f"the same series was written {len(writes)} times"
        )
        # A series that actually grew is still written.
        grown = rows + [
            Candle(symbol="XAUUSD", timeframe="M5", time="2026-01-01T01:00:00",
                   time_msc=99, open=1, high=2, low=0.5, close=1.5, volume=1, spread=1)
        ]
        await bridge.archive_candles("XAUUSD", "M5", grown)
        assert writes == [50, 51], "a longer series must still reach the disk"
        # ...and so is one that reaches further back with the same count.
        deeper = [
            Candle(symbol="XAUUSD", timeframe="M5", time=f"2025-12-31T00:{i:02d}:00",
                   time_msc=i, open=1, high=2, low=0.5, close=1.5, volume=1, spread=1)
            for i in range(51)
        ]
        await bridge.archive_candles("XAUUSD", "M5", deeper)
        assert writes == [50, 51, 51], (
            "a series of the same length that starts earlier is different "
            "history, and has to be written"
        )

    _run(go())
