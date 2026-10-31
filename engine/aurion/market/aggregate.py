"""Ticks in, candles out.

A feed gives ticks, or at best one-minute bars. Every other period on
the desk has to be built here, which makes this the most load-bearing
file in the market layer: if it is subtly wrong, the chart, the
indicators, the strategies and the backtester are all wrong together
and all agree with each other, which is the hardest kind of bug to see.

Four decisions, each of which is a defect if taken the other way:

  Bars are aligned to the clock, never to the first tick. Boundaries
  come from timeframes.bucket_start, so two engines fed the same ticks
  in a different order and started at different moments produce
  identical bars. A chart that disagrees with a backtest about where
  15:00 began is not a chart.

  Open and close are decided by timestamp, not by arrival. A feed that
  delivers two ticks of the same bucket out of order must not invert
  the body of the candle. High and low do not care; open and close are
  the whole of a candle's direction.

  A gap produces no bar. Not a flat bar, not a repeat of the last
  close, nothing. The weekend, a halt and a dead socket all look like
  silence, and the one thing worse than a chart with a hole in it is a
  chart that invents a price to cover the hole. This is the same rule
  MT5Bridge states for itself and it is kept deliberately.

  Late ticks are dropped and counted. A tick for a bar that already
  closed cannot be folded in without rewriting history that indicators
  have already consumed, so it is refused - but `stats()` reports how
  often it happened, because a feed that does it constantly is a feed
  that needs a different transport, and silence would hide that.
"""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Iterable

from ..mt5.types import Candle, Tick
from . import timeframes as tfs

DEFAULT_TIMEFRAMES: tuple[str, ...] = ("M1", "M5", "M15", "M30", "H1", "H4", "D1")


def _iso(epoch_ms: int) -> str:
    return datetime.fromtimestamp(int(epoch_ms) / 1000, tz=timezone.utc).isoformat()


def _tick_ms(tick: Tick) -> int:
    """Epoch ms for a tick, from whichever field the feed populated."""
    if getattr(tick, "time_msc", 0):
        return int(tick.time_msc)
    raw = str(getattr(tick, "time", "") or "")
    if not raw:
        return 0
    try:
        when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return int(when.timestamp() * 1000)


def _tick_price(tick: Tick, side: str) -> float:
    """The series price for a tick.

    Bid by default, because that is what a MetaTrader chart plots and
    the desk has to agree with the terminal a trader is comparing it
    against. A feed that only carries a mid or a last still works.
    """
    if side == "mid":
        return float(tick.mid or 0.0)
    if side == "ask":
        return float(tick.ask or tick.last or tick.bid or 0.0)
    return float(tick.bid or tick.last or tick.ask or 0.0)


class BarAggregator:
    """Builds and keeps candles for one set of timeframes."""

    def __init__(
        self,
        timeframes: Iterable[str] = DEFAULT_TIMEFRAMES,
        depth: int = 3000,
        price: str = "bid",
        source: str = "",
    ) -> None:
        self.timeframes = tuple(tfs.normalise(t) for t in timeframes)
        self.depth = int(depth)
        self.price = str(price or "bid").lower()
        self.source = source
        # Closed bars, oldest first.
        self._closed: dict[tuple[str, str], deque[Candle]] = defaultdict(
            lambda: deque(maxlen=self.depth)
        )
        # The bar currently being built, plus the timestamps that decide
        # its open and close when ticks arrive out of order.
        self._open: dict[tuple[str, str], Candle] = {}
        self._edges: dict[tuple[str, str], tuple[int, int]] = {}
        self._late = 0
        self._ticks = 0

    # ---------------------------------------------------------------- feed

    def add_tick(self, tick: Tick) -> list[Candle]:
        """Fold a tick into every timeframe. Returns the bars that closed."""
        price = _tick_price(tick, self.price)
        when = _tick_ms(tick)
        symbol = str(getattr(tick, "symbol", "") or "")
        if not symbol or not price or when <= 0:
            return []

        self._ticks += 1
        closed: list[Candle] = []
        for timeframe in self.timeframes:
            bar = self._fold(symbol, timeframe, when, price, tick)
            if bar is not None:
                closed.append(bar)
        return closed

    def _fold(self, symbol: str, timeframe: str, when: int, price: float, tick: Tick) -> Candle | None:
        key = (symbol, timeframe)
        start = tfs.bucket_start(when, timeframe)
        current = self._open.get(key)
        finished: Candle | None = None

        if current is not None and start > current.time_msc:
            finished = self._close(key)
            current = None
        elif current is not None and start < current.time_msc:
            # The bar this tick belongs to is already closed and already
            # read. Refusing it is the honest option; see the docstring.
            self._late += 1
            return None

        if current is None:
            self._open[key] = Candle(
                symbol=symbol,
                timeframe=timeframe,
                time=_iso(start),
                time_msc=start,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=1,
                spread=float(getattr(tick, "spread", 0.0) or 0.0),
                real_volume=float(getattr(tick, "volume", 0.0) or 0.0),
            )
            self._edges[key] = (when, when)
            return finished

        bar = current
        first, last = self._edges[key]
        bar.high = max(bar.high, price)
        bar.low = min(bar.low, price)
        bar.volume += 1
        bar.real_volume += float(getattr(tick, "volume", 0.0) or 0.0)
        # Order by time, not by arrival.
        if when <= first:
            bar.open = price
            first = when
        if when >= last:
            bar.close = price
            bar.spread = float(getattr(tick, "spread", 0.0) or 0.0)
            last = when
        self._edges[key] = (first, last)
        return finished

    def roll(self, now_ms: int) -> list[Candle]:
        """Close every bar whose period has elapsed.

        Without this a quiet market leaves the last bar forming for
        ever: a bar only ever closed because a later tick arrived, and
        at 23:59 on a Friday no later tick is coming. Call it from the
        same timer that drives the rest of the engine.
        """
        closed: list[Candle] = []
        for key in list(self._open.keys()):
            bar = self._open[key]
            if int(now_ms) >= tfs.bucket_end(bar.time_msc, key[1]):
                done = self._close(key)
                if done is not None:
                    closed.append(done)
        return closed

    def _close(self, key: tuple[str, str]) -> Candle | None:
        bar = self._open.pop(key, None)
        self._edges.pop(key, None)
        if bar is None:
            return None
        self._closed[key].append(bar)
        return bar

    # ---------------------------------------------------------------- read

    def bars(self, symbol: str, timeframe: str, include_forming: bool = False) -> list[Candle]:
        key = (symbol, tfs.normalise(timeframe))
        out = list(self._closed.get(key, ()))
        if include_forming and key in self._open:
            out.append(self._open[key])
        return out

    def forming(self, symbol: str, timeframe: str) -> Candle | None:
        return self._open.get((symbol, tfs.normalise(timeframe)))

    def seed(self, bars: Iterable[Candle]) -> None:
        """Load history so a live feed continues a series instead of starting one."""
        for bar in bars:
            key = (bar.symbol, tfs.normalise(bar.timeframe))
            self._closed[key].append(bar)

    def symbols(self) -> list[str]:
        seen = {key[0] for key in self._closed} | {key[0] for key in self._open}
        return sorted(seen)

    def stats(self) -> dict[str, Any]:
        return {
            "ticks": self._ticks,
            "late_ticks": self._late,
            "series": len(self._closed),
            "forming": len(self._open),
            "price": self.price,
        }


def resample(candles: list[Candle], target: str, drop_partial: bool = False) -> list[Candle]:
    """Build a higher timeframe from a lower one.

    Most feeds sell one-minute history and nothing else, so every other
    period on a chart is this function's output. Bars are grouped by the
    clock, exactly as live ticks would have been grouped, which is what
    makes a backfilled series and a live series line up at the join.

    `drop_partial` removes a trailing bucket that the source data cannot
    fill completely. A chart wants the forming bar; a backtest must not
    see one, because an incomplete high and low is a look-ahead the
    strategy would never have had.
    """
    if not candles:
        return []

    tf = tfs.normalise(target)
    rows = sorted(candles, key=lambda c: int(c.time_msc or 0))
    source_tf = tfs.normalise(rows[0].timeframe or "M1")
    if tfs.seconds(source_tf) > tfs.seconds(tf) and tf != "MN1":
        # Downsampling is not resampling: a 15-minute bar does not
        # contain the five-minute bars it was made of.
        return []

    out: list[Candle] = []
    bucket: Candle | None = None
    bucket_end = 0

    for row in rows:
        when = int(row.time_msc or 0)
        if when <= 0:
            continue
        start = tfs.bucket_start(when, tf)
        if bucket is None or start != bucket.time_msc:
            if bucket is not None:
                out.append(bucket)
            bucket = Candle(
                symbol=row.symbol,
                timeframe=tf,
                time=_iso(start),
                time_msc=start,
                open=row.open,
                high=row.high,
                low=row.low,
                close=row.close,
                volume=row.volume,
                spread=row.spread,
                real_volume=row.real_volume,
            )
            bucket_end = tfs.bucket_end(start, tf)
            continue
        bucket.high = max(bucket.high, row.high)
        bucket.low = min(bucket.low, row.low)
        bucket.close = row.close
        bucket.volume += row.volume
        bucket.real_volume += row.real_volume
        bucket.spread = row.spread

    if bucket is not None:
        out.append(bucket)

    if drop_partial and out:
        last = rows[-1]
        covered_to = int(last.time_msc or 0) + tfs.seconds(source_tf) * 1000
        if covered_to < bucket_end:
            out.pop()

    return out
