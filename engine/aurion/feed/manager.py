"""The live feed: polling, candle building, and honest staleness.

This is what replaces the MetaTrader terminal as AURION's source of prices.
It owns three things:

*A subscription set.*  Only what is actually on screen or being traded gets
polled.  Charting 153 symbols once a second would be 153 requests a second
at a public endpoint, which is how a free source stops being available.

*The current bar.*  Providers serve completed candles; a chart needs the one
still forming.  `_fold()` merges each incoming quote into the open bar so the
last candle grows in real time, and rolls it over when its period ends.  This
is the part that makes the chart look live rather than redrawing every minute.

*The truth about freshness.*  `status()` separates three states that look
identical if you only track "last update": the market is closed, the feed is
working but quiet, and the feed is broken.  The desk is expected to show the
difference instead of implying a dead feed is a calm market.

Threading: one daemon poll thread, and every mutation of the shared maps
happens under `_lock`.  Readers copy before handing data out, because the API
serialises these structures while the poll thread is writing to them.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from ..mt5.types import Candle, Tick
from ..util import market
from .base import Quote, tf_seconds
from .symbols import UNIVERSE, DEFAULT_WATCHLIST, normalise

#: How many bars to keep per (symbol, timeframe).
DEPTH = 1500

#: Timeframes the manager keeps live. Coarser ones are served straight from
#: the provider on request rather than folded tick by tick.
LIVE_TIMEFRAMES: tuple[str, ...] = ("M1", "M5", "M15", "M30", "H1")


class FeedManager:
    def __init__(
        self,
        provider: Any,
        interval: float = 1.0,
        watchlist: Iterable[str] | None = None,
    ) -> None:
        self.provider = provider
        #: Poll cadence in seconds. The trader asked for per-second updates;
        #: note that this is how often we ASK, not how often the source has
        #: something new. See YahooFeed's docstring.
        self.interval = max(0.25, float(interval))
        self._lock = threading.RLock()
        self._subs: set[str] = set()
        self._ticks: dict[str, Tick] = {}
        self._quotes: dict[str, Quote] = {}
        self._bars: dict[tuple[str, str], deque[Candle]] = {}
        self._primed: set[tuple[str, str]] = set()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        #: Push targets. The desk already renders `tick` and `candle`
        #: events off the trader's bus, so the feed emits into that rather
        #: than making the browser poll -- which is what makes the forming
        #: candle move in real time instead of once a refresh.
        self._observers: list[Any] = []

        self.started_at = 0.0
        self.last_poll = 0.0
        self.last_change = 0.0
        self.last_error = ""
        self.poll_count = 0
        self.error_count = 0

        for sym in (watchlist if watchlist is not None else DEFAULT_WATCHLIST):
            self.subscribe(sym)

    # ----------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self.started_at = time.time()
        self._thread = threading.Thread(target=self._loop, name="aurion-feed", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=timeout)
        self._thread = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def on_update(self, callback: Any) -> None:
        """Register a sink for feed events.

        `callback(event, payload)` is invoked from the poll thread with
        event in {"tick", "candle"} and a plain dict payload.  Called
        OUTSIDE the manager's lock: a sink that blocks (or that calls back
        into the manager) must not be able to deadlock the poller.
        """
        if callable(callback) and callback not in self._observers:
            self._observers.append(callback)

    def _emit(self, events: list[tuple[str, dict]]) -> None:
        for name, payload in events:
            for cb in list(self._observers):
                try:
                    cb(name, payload)
                except Exception as exc:  # a bad sink must not kill the feed
                    self.last_error = f"observer: {exc}"

    # -------------------------------------------------------- subscription

    def subscribe(self, *symbols: Any) -> list[str]:
        added: list[str] = []
        with self._lock:
            for raw in _flatten(symbols):
                name = normalise(raw)
                if name in UNIVERSE and name not in self._subs:
                    self._subs.add(name)
                    added.append(name)
        return added

    def unsubscribe(self, *symbols: Any) -> None:
        with self._lock:
            for raw in _flatten(symbols):
                self._subs.discard(normalise(raw))

    @property
    def subscriptions(self) -> list[str]:
        with self._lock:
            return sorted(self._subs)

    # ------------------------------------------------------------- reading

    def tick(self, symbol: Any) -> Tick | None:
        with self._lock:
            return self._ticks.get(normalise(symbol))

    def ticks(self) -> dict[str, Tick]:
        with self._lock:
            return dict(self._ticks)

    def quote(self, symbol: Any) -> Quote | None:
        with self._lock:
            return self._quotes.get(normalise(symbol))

    def candles(self, symbol: Any, timeframe: Any = "M15", count: int = 240) -> list[Candle]:
        """Bars for a chart, newest last.

        Serves the live buffer when one exists, and otherwise asks the
        provider and primes the buffer from the answer, so the first chart
        for a symbol is history plus a growing last bar rather than a blank
        canvas that fills in a minute later.
        """
        name = normalise(symbol)
        tf = str(timeframe or "M15").upper()
        key = (name, tf)
        with self._lock:
            have = list(self._bars.get(key) or ())
        if have:
            return have[-int(count or 240):]
        self.prime(name, tf, count)
        with self._lock:
            return list(self._bars.get(key) or ())[-int(count or 240):]

    def prime(self, symbol: Any, timeframe: Any = "M15", count: int = 240) -> int:
        """Load history for one (symbol, timeframe) from the provider."""
        name = normalise(symbol)
        tf = str(timeframe or "M15").upper()
        if name not in UNIVERSE:
            return 0
        try:
            bars = self.provider.candles(name, tf, count) or []
        except Exception as exc:
            self.last_error = f"candles {name} {tf}: {exc}"
            self.error_count += 1
            return 0
        if not bars:
            return 0
        with self._lock:
            self._bars[(name, tf)] = deque(bars[-DEPTH:], maxlen=DEPTH)
            self._primed.add((name, tf))
        return len(bars)

    # -------------------------------------------------------------- status

    def status(self) -> dict[str, Any]:
        """Enough detail that the desk never has to guess why a chart is flat."""
        now = time.time()
        sess = market.session()
        closed = not sess.get("open", True)
        with self._lock:
            subs = sorted(self._subs)
            n_ticks = len(self._ticks)
            newest = max((q.at for q in self._quotes.values() if q.at), default=0)

        age = (now * 1000 - newest) if newest else -1
        if closed:
            state = "closed"
        elif not self.running:
            state = "stopped"
        elif self.last_error and not n_ticks:
            state = "error"
        elif age < 0:
            state = "starting"
        elif age > 120_000:
            state = "stale"
        else:
            state = "live"

        return {
            "provider": getattr(self.provider, "id", "?"),
            "provider_label": getattr(self.provider, "label", ""),
            # The desk shows these two verbatim rather than implying the
            # feed is something it is not.
            "tick_true": bool(getattr(self.provider, "tick_true", False)),
            "has_spread": bool(getattr(self.provider, "has_spread", False)),
            "simulated": bool(getattr(self.provider, "simulated", False)),
            "state": state,
            "running": self.running,
            "interval": self.interval,
            "subscriptions": subs,
            "symbols": n_ticks,
            "last_poll": self.last_poll,
            "last_change": self.last_change,
            "age_ms": int(age) if age >= 0 else -1,
            "polls": self.poll_count,
            "errors": self.error_count,
            "error": self.last_error,
            "market_open": not closed,
            "market_state": sess.get("state", ""),
        }

    # ---------------------------------------------------------- the engine

    def poll_once(self) -> int:
        """One round of quotes. Returns how many symbols changed."""
        with self._lock:
            wanted = sorted(self._subs)
        if not wanted:
            self.last_poll = time.time()
            return 0

        try:
            result = self.provider.quotes(wanted)
        except Exception as exc:
            self.last_error = str(exc)
            self.error_count += 1
            self.last_poll = time.time()
            return 0

        self.last_poll = time.time()
        self.poll_count += 1
        if result.error:
            self.last_error = result.error
            self.error_count += 1
            return 0
        self.last_error = ""

        changed = 0
        events: list[tuple[str, dict]] = []
        for name, q in (result.quotes or {}).items():
            if self._accept(name, q, events):
                changed += 1
        if changed:
            self.last_change = time.time()
        # Outside the lock, deliberately. See on_update().
        self._emit(events)
        return changed

    def _accept(self, name: str, q: Quote, events: list[tuple[str, dict]] | None = None) -> bool:
        """Record a quote, ignoring prints we have already seen.

        A poll that is faster than the source means the same print arrives
        repeatedly.  Folding it again would inflate volume and, worse, make a
        dead feed look alive -- so an unchanged (price, source timestamp) is
        dropped here rather than counted as an update.
        """
        with self._lock:
            prev = self._quotes.get(name)
            if prev is not None and prev.at == q.at and prev.mid == q.mid:
                return False
            self._quotes[name] = q
            tick = q.to_tick()
            self._ticks[name] = tick
            touched: list[Candle] = []
            for tf in LIVE_TIMEFRAMES:
                if (name, tf) in self._primed:
                    bar = self._fold(name, tf, q)
                    if bar is not None:
                        touched.append(bar)
        if events is not None:
            events.append(("tick", tick.to_dict()))
            # One event per timeframe being charted. Only primed pairs are
            # folded, so this is bounded by what has actually been opened.
            for bar in touched:
                events.append(("candle", bar.to_dict()))
        return True

    def _fold(self, name: str, tf: str, q: Quote) -> Candle | None:
        """Merge a quote into the forming bar, rolling over at the boundary.

        Called with `_lock` held. Returns the bar that changed, so the
        caller can push it to the desk without re-reading the buffer.
        """
        key = (name, tf)
        buf = self._bars.get(key)
        if buf is None:
            return None
        step = tf_seconds(tf)
        stamp = (q.at or q.received) // 1000
        slot = stamp - (stamp % step)
        price = q.mid
        if not price:
            return None

        last = buf[-1] if buf else None
        if last is not None and last.time_msc // 1000 == slot:
            last.high = max(last.high, price)
            last.low = min(last.low, price)
            last.close = price
            last.volume += 1
            return last
        if last is not None and last.time_msc // 1000 > slot:
            # A late print for a bar we have already closed. Dropping it is
            # correct: rewriting a closed candle would change history under
            # an indicator that has already consumed it.
            return None
        fresh = Candle(
            symbol=name, timeframe=tf,
            time=datetime.fromtimestamp(slot, tz=timezone.utc).isoformat(),
            time_msc=slot * 1000,
            # A new bar opens at the price that opened it, not at the
            # previous close: a gap is real information.
            open=price, high=price, low=price, close=price, volume=1,
        )
        buf.append(fresh)
        return fresh

    def _loop(self) -> None:
        while not self._stop.is_set():
            started = time.time()
            try:
                # Nothing trades at the weekend, and polling a public
                # endpoint through it for no new data is how a free source
                # starts refusing us.
                if market.is_weekend():
                    self._stop.wait(30.0)
                    continue
                self.poll_once()
            except Exception as exc:  # the thread must never die
                self.last_error = str(exc)
                self.error_count += 1
            # Drift-free cadence: sleep the remainder, not a flat interval.
            rest = self.interval - (time.time() - started)
            if rest > 0:
                self._stop.wait(rest)


def _flatten(items: Sequence[Any]) -> list[Any]:
    out: list[Any] = []
    for it in items:
        if isinstance(it, (list, tuple, set, frozenset)):
            out.extend(it)
        else:
            out.append(it)
    return out
