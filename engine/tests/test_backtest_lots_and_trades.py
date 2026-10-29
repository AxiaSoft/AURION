"""A replay has to trade the way the desk is set up to trade.

Two complaints, both about the backtest reporting a robot nobody runs.

  1. It sized every entry at a hard-coded 0.1 lot. The desk has a lot
     setting -- auto, which leaves the strategy's own volume alone, and
     manual, which pins every robot trade to a fixed lot -- and the
     replay ignored it. A trader set to 1.0 lots was shown the profit
     of a 0.1-lot run and told it was theirs.

  2. It held one position at a time. Every signal that arrived while a
     trade was open was dropped on the floor, so a strategy that fires
     in clusters showed a handful of trades over a window where the
     live robot, which has an open-trade cap of its own, would have
     taken many.

There is also the chart: the desk drew the live market beside the
replay because the engine sent it nothing of the test to draw. The
progress updates now carry the bars being replayed and the trades that
sit on them.

The strategies here are stubs, not the shipped ones. That is
deliberate: these check the replay machinery -- sizing, the cap, what
is reported -- and a stub that signals on demand is the only way to put
the machinery in the state being tested. Nothing here measures whether
a strategy makes money, and no figure from this file is a result.
"""

from __future__ import annotations

from typing import Any

import pytest

from aurion.backtest.engine import _REPLAY_BARS, Backtester, _slim


def bars(n: int = 300, start: float = 1000.0, drift: float = 0.01) -> list[dict[str, Any]]:
    """A gently rising series. Shape does not matter to these checks.

    Priced in four figures on purpose: the stubs below put their stop a
    flat 500 away, and on a two-figure price that lands below zero --
    which the engine correctly treats as "no stop", so the risk on every
    trade came out as nought and the first draft of this file failed on
    its own fixture rather than on the code.
    """
    out = []
    for i in range(n):
        mid = start + i * drift
        out.append({
            "time": f"2026-01-01T{i // 60:02d}:{i % 60:02d}:00",
            "open": round(mid, 4),
            "high": round(mid + 0.5, 4),
            "low": round(mid - 0.5, 4),
            "close": round(mid, 4),
            "volume": 1,
        })
    return out


class Always:
    """Wants to be long on every bar, with a stop far enough away that
    nothing closes by itself. Entries therefore pile up against the cap
    and nothing else."""

    name = "always"
    params: dict[str, Any] = {}

    def __init__(self, volume: float | None = 0.2) -> None:
        self.volume = volume

    def on_start(self, ctx) -> None:  # noqa: D401 - lifecycle hook
        return None

    def on_candle(self, ctx) -> dict[str, Any]:
        close = float(ctx.candles[-1]["close"])
        sig: dict[str, Any] = {"action": "buy", "sl": close - 500, "tp": close + 500, "reason": "stub"}
        if self.volume is not None:
            sig["volume"] = self.volume
        return sig


class Burst:
    """Fills the book, then sends one close. Written because the first
    draft of the flatten test used a strategy that only ever opened one
    trade -- closing one and closing all look identical from there, and
    a mutant that shut only the first position went unnoticed."""

    name = "burst"
    params: dict[str, Any] = {}

    def __init__(self, open_until: int = 110, close_at: int = 130) -> None:
        self.open_until, self.close_at = open_until, close_at

    def on_start(self, ctx) -> None:
        return None

    def on_candle(self, ctx):
        n = len(ctx.candles)
        close = float(ctx.candles[-1]["close"])
        if n <= self.open_until:
            return {"action": "buy", "volume": 0.2, "sl": close - 500, "tp": close + 500}
        if n == self.close_at:
            return {"action": "close", "reason": "stub-close"}
        return None


class Spaced:
    """One short trade every `gap` bars, so that most trades are far
    outside any recent window."""

    name = "spaced"
    params: dict[str, Any] = {}

    def __init__(self, gap: int = 100, hold: int = 4) -> None:
        self.gap, self.hold = gap, hold

    def on_start(self, ctx) -> None:
        return None

    def on_candle(self, ctx):
        n = len(ctx.candles)
        close = float(ctx.candles[-1]["close"])
        if n % self.gap == 0:
            return {"action": "buy", "volume": 0.2, "sl": close - 500, "tp": close + 500}
        if n % self.gap == self.hold:
            return {"action": "close", "reason": "spaced-close"}
        return None


class Once:
    """Opens on one bar and closes on a later one."""

    name = "once"
    params: dict[str, Any] = {}

    def __init__(self, open_at: int = 100, close_at: int = 140) -> None:
        self.open_at, self.close_at, self.seen = open_at, close_at, 0

    def on_start(self, ctx) -> None:
        return None

    def on_candle(self, ctx):
        self.seen = len(ctx.candles)
        close = float(ctx.candles[-1]["close"])
        if self.seen == self.open_at:
            return {"action": "buy", "volume": 0.3, "sl": close - 500, "tp": close + 500}
        if self.seen == self.close_at:
            return {"action": "close", "reason": "stub-close"}
        return None


def run(strategy, data=None, **kw) -> dict[str, Any]:
    return Backtester().run(strategy, data or bars(), "XAUUSD", "M5", 10_000.0, 1.0, 80, None, None, **kw)


# ----------------------------------------------------------- the lot ---

def test_auto_mode_keeps_the_strategy_lot():
    res = run(Always(volume=0.2), volume_mode="auto", manual_volume=0.0, max_open=3)
    assert res["ok"]
    assert {t["volume"] for t in res["trades"]} == {0.2}


def test_manual_mode_pins_every_entry_to_the_fixed_lot():
    # The whole point of manual: the strategy asks for 0.2 and is overruled.
    res = run(Always(volume=0.2), volume_mode="manual", manual_volume=1.5, max_open=3)
    assert res["ok"]
    assert {t["volume"] for t in res["trades"]} == {1.5}


def test_manual_mode_with_no_lot_set_does_not_zero_the_trade():
    # A manual mode whose lot was never filled in must not size at zero,
    # which would report every trade as making exactly nothing.
    res = run(Always(volume=0.2), volume_mode="manual", manual_volume=0.0, max_open=2)
    assert {t["volume"] for t in res["trades"]} == {0.2}


def test_a_strategy_that_names_no_lot_still_trades():
    res = run(Always(volume=None), volume_mode="auto", manual_volume=0.0, max_open=1)
    assert res["ok"]
    assert len(res["trades"]) >= 1
    assert all(t["volume"] > 0 for t in res["trades"])


def test_the_lot_actually_scales_the_money():
    # If sizing were ignored further down, both runs would report the
    # same profit and the setting would be decorative.
    small = run(Always(volume=0.2), volume_mode="manual", manual_volume=0.1, max_open=1)
    large = run(Always(volume=0.2), volume_mode="manual", manual_volume=1.0, max_open=1)
    assert small["ok"] and large["ok"]
    assert small["metrics"]["net"] != large["metrics"]["net"]
    # ten times the lot, ten times the result, give or take rounding
    assert large["metrics"]["net"] == pytest.approx(small["metrics"]["net"] * 10, rel=1e-6)


# -------------------------------------------------- how many at once ---

@pytest.mark.parametrize("cap", [1, 2, 5, 9])
def test_the_cap_is_what_limits_concurrent_trades(cap):
    seen_open = []

    def report(done, total, live=None):
        if live:
            seen_open.append(int(live.get("open_count") or 0))

    res = Backtester().run(
        Always(), bars(), "XAUUSD", "M5", 10_000.0, 1.0, 80, None, report,
        "auto", 0.0, cap,
    )
    assert res["ok"]
    # Nothing closes on its own here, so the book fills to the cap and
    # every one of them is settled at the end of the run.
    assert len(res["trades"]) == cap
    assert max(seen_open) == cap


@pytest.mark.parametrize("bad", [0, None, -4])
def test_a_nonsense_cap_does_not_stop_it_trading(bad):
    # The desk reads this off a setting. A zero or a missing value must
    # fall back to one open trade, not to a run that quietly takes none
    # and reports a flat equity curve as the strategy's performance.
    res = run(Always(), max_open=bad)
    assert res["ok"]
    assert len(res["trades"]) == 1


def test_one_at_a_time_is_still_available():
    res = run(Always(), max_open=1)
    assert len(res["trades"]) == 1


def test_a_close_signal_flattens_the_whole_book():
    # Four trades open, one close signal: all four must go. A close that
    # shut only the oldest would leave the rest to be swept up at the end
    # of the run, so the exit reasons are what gives it away.
    res = run(Burst(open_until=110, close_at=130), max_open=4)
    assert res["ok"]
    assert len(res["trades"]) == 4
    assert [t["exit_reason"] for t in res["trades"]] == ["stub-close"] * 4


def test_a_single_open_trade_still_closes_on_signal():
    res = run(Once(open_at=100, close_at=140), max_open=4)
    assert len(res["trades"]) == 1
    assert res["trades"][0]["exit_reason"] == "stub-close"


def test_trades_left_open_are_settled_at_the_end():
    res = run(Always(), max_open=3)
    assert len(res["trades"]) == 3
    assert all(t["exit_reason"] == "eod" for t in res["trades"])


def test_every_trade_carries_what_it_risked():
    # R was being recorded as zero for some exits, which quietly dropped
    # them out of the average-R figure.
    res = run(Always(volume=0.5), max_open=3)
    assert all(t["risk"] > 0 for t in res["trades"])


# ------------------------------------------- what the desk is sent -----

def test_progress_carries_the_bars_being_replayed():
    last: dict[str, Any] = {}

    def report(done, total, live=None):
        if live:
            last.update(live)

    data = bars(400)
    Backtester().run(Always(), data, "XAUUSD", "M5", 10_000.0, 1.0, 80, None, report, "auto", 0.0, 2)
    sent = last.get("replay_bars")
    assert isinstance(sent, list) and sent, "the desk is sent nothing of the test to draw"
    assert len(sent) <= _REPLAY_BARS, "the window is unbounded and grows with the run"
    assert set(sent[0]) == {"t", "o", "h", "l", "c"}


def test_the_replayed_window_ends_on_the_bar_being_reported():
    last: dict[str, Any] = {}

    def report(done, total, live=None):
        if live:
            last.clear()
            last.update(live)

    data = bars(400)
    Backtester().run(Always(), data, "XAUUSD", "M5", 10_000.0, 1.0, 80, None, report, "auto", 0.0, 2)
    # Whatever bar the run says it is standing on must be the last one
    # it sent, or the chart and the clock beside it disagree.
    assert last["replay_bars"][-1]["t"] == last["at"]


def test_the_window_never_reaches_back_into_the_warmup():
    last: dict[str, Any] = {}

    def report(done, total, live=None):
        if live and not last:
            last.update(live)       # the first report, closest to the warmup

    data = bars(400)
    Backtester().run(Always(), data, "XAUUSD", "M5", 10_000.0, 1.0, 80, None, report, "auto", 0.0, 1)
    first_tested = data[80]["time"]
    assert last["replay_bars"][0]["t"] >= first_tested


def test_trades_are_marked_on_the_bars_they_happened_on():
    marks: list[dict[str, Any]] = []

    def report(done, total, live=None):
        if live and live.get("marks"):
            marks.extend(live["marks"])

    res = Backtester().run(Once(open_at=100, close_at=140), bars(400), "XAUUSD", "M5",
                           10_000.0, 1.0, 80, None, report, "auto", 0.0, 2)
    (trade,) = res["trades"]
    kinds = {m["kind"] for m in marks}
    assert "in" in kinds, "an entry is never marked on the chart"
    assert "out" in kinds, "the chart shows where a trade opened but never where it ended"
    assert all("price" in m and "t" in m for m in marks)
    # Every mark, not just the first one found. An earlier version of
    # this check looked at one entry and passed while the marks built
    # from closed trades -- a different branch -- had lost their side.
    assert all(m["side"] == "buy" for m in marks), \
        "a mark without a side cannot be drawn as a buy or a sell"
    assert all(float(m["price"]) > 0 for m in marks)
    opened = [m for m in marks if m["kind"] == "in"]
    assert all(m.get("volume") for m in opened), "an entry mark carries no lot"
    assert any(m.get("open") for m in opened), "a trade in progress is never shown"
    closed = [m for m in marks if m["kind"] == "out"]
    assert all("profit" in m for m in closed), "an exit cannot be coloured without its result"
    assert all(m.get("reason") for m in closed), "an exit does not say why it happened"
    # Against the trade itself, so a mark that reports the entry price
    # at the exit -- which would draw the close in the wrong place on
    # the chart -- cannot pass.
    assert trade["entry"] != trade["exit"], "the fixture must move for this to mean anything"
    assert all(m["price"] == trade["exit"] for m in closed)
    assert all(m["price"] == trade["entry"] for m in opened)
    assert all(m["t"] == trade["exit_time"] for m in closed)


def test_a_mark_only_travels_while_its_bar_is_on_screen():
    """Marks are for drawing on the replayed window, so only the ones
    whose bar is still in that window should be sent.

    Spaced trades, not clustered ones: with a trade every 100 bars and a
    160-bar window, at most two can be on screen at once, while a run
    that sent its whole history would climb past that and keep climbing.
    """
    seen: list[int] = []

    def report(done, total, live=None):
        if live:
            seen.append(len(live.get("marks") or []))

    res = Backtester().run(Spaced(gap=100), bars(1000), "XAUUSD", "M5",
                           10_000.0, 1.0, 80, None, report, "auto", 0.0, 2)
    assert len(res["trades"]) >= 6, "the run must make enough trades for this to mean anything"
    assert max(seen) <= 6, f"marks accumulate instead of being windowed (peak {max(seen)})"


def test_slim_drops_everything_a_chart_does_not_draw():
    fat = {"time": "T", "open": 1, "high": 2, "low": 0.5, "close": 1.5,
           "spread": 9, "tick_volume": 1234, "real_volume": 5678}
    assert _slim(fat) == {"t": "T", "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5}


def test_slim_survives_rubbish():
    assert _slim(None) == {}
    assert _slim({"time": "T"})["o"] == 0.0


# ------------------------------------------------- nothing regressed ---

def test_a_reporter_that_throws_does_not_stop_the_run():
    def angry(done, total, live=None):
        raise RuntimeError("desk went away")

    res = Backtester().run(Always(), bars(), "XAUUSD", "M5", 10_000.0, 1.0, 80, None, angry, "auto", 0.0, 2)
    assert res["ok"]


def test_an_old_two_argument_reporter_still_works():
    calls: list[tuple[int, int]] = []

    def old(done, total):
        calls.append((done, total))

    res = Backtester().run(Always(), bars(), "XAUUSD", "M5", 10_000.0, 1.0, 80, None, old, "auto", 0.0, 2)
    assert res["ok"] and calls


def test_the_defaults_are_the_old_behaviour():
    # Callers that have not been updated must not change meaning.
    res = Backtester().run(Always(volume=0.2), bars(), "XAUUSD", "M5")
    assert res["ok"]
    assert len(res["trades"]) == 1


def test_it_still_refuses_to_invent_candles():
    res = Backtester().run(Always(), bars(20), "XAUUSD", "M5")
    assert not res["ok"]
    assert "historical bars" in res["error"]
