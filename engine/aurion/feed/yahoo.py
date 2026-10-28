"""Keyless live forex prices from Yahoo Finance.

Chosen because it is the only source that needs neither an API key nor a
paid plan while still covering the whole currency universe and serving real
intraday bars.  Everything else that streams forex -- Twelve Data, Finnhub,
Polygon, TraderMade -- wants a key, a paid tier, or both.

Two honest limitations, stated here because they are easy to paper over and
the desk must not:

*Granularity.*  The finest bar Yahoo serves is one minute, and its quote
updates land every few seconds at best.  AURION can poll once a second and
will show a new price the moment one exists, but a one-second poll does not
turn a source into a tick feed.  `tick_true` is False for exactly this
reason, and the desk is expected to say so rather than imply tick accuracy.

*No bid/ask.*  The chart endpoint returns a single price.  Rather than
inventing a spread -- which would be a made-up number on a trading screen --
bid and ask are left equal to it and `has_spread` is False.  A demo account
applies its own configured spread on top; it does not pretend this one is
the market's.

Everything goes through the `v8/finance/chart` endpoint.  The older `v7/quote`
batch endpoint now demands a crumb and cookie handshake and breaks without
warning, so one chart call per symbol -- run concurrently -- is the stable
route even though it costs more requests.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Sequence

from ..mt5.types import Candle
from .base import FeedResult, Quote, tf_minutes
from .symbols import UNIVERSE, get as sym_get, normalise

HOST = "https://query1.finance.yahoo.com"
#: Yahoo rejects the default urllib agent outright.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AURION/1.0",
    "Accept": "application/json",
}

#: AURION timeframe -> Yahoo interval.  Yahoo has no four-hour bar, so H4 is
#: resampled from 60m rather than silently served as H1.
_INTERVAL: dict[str, str] = {
    "M1": "1m", "M5": "5m", "M15": "15m", "M30": "30m",
    "H1": "60m", "H4": "60m", "D1": "1d", "W1": "1wk", "MN1": "1mo",
}

#: Yahoo only keeps fine intervals for a short window; asking for 1m over a
#: year returns nothing at all instead of an error.
_MAX_RANGE_DAYS: dict[str, int] = {
    "1m": 7, "5m": 59, "15m": 59, "30m": 59, "60m": 729,
    "1d": 10000, "1wk": 10000, "1mo": 10000,
}


class YahooFeed:
    id = "yahoo"
    label = "Yahoo Finance"
    needs_key = False
    #: Real market prints, but not tick-by-tick. See the module docstring.
    tick_true = False
    has_spread = False

    def __init__(self, timeout: float = 8.0, workers: int = 8) -> None:
        self.timeout = timeout
        self.workers = max(1, int(workers))
        self.last_error = ""

    # ------------------------------------------------------------ plumbing

    def available(self) -> bool:
        return True

    def supports(self, symbol: Any) -> bool:
        return normalise(symbol) in UNIVERSE

    def _ticker(self, symbol: Any) -> str:
        rec = sym_get(symbol)
        return rec.yahoo if rec else ""

    def _get(self, url: str) -> dict[str, Any]:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=self.timeout) as res:  # nosec - public endpoint
            raw = res.read()
        return json.loads(raw.decode("utf-8", "replace"))

    def _chart(self, ticker: str, interval: str, rng: str) -> dict[str, Any]:
        url = f"{HOST}/v8/finance/chart/{urllib.parse.quote(ticker)}?interval={interval}&range={rng}"
        return self._get(url)

    # -------------------------------------------------------------- quotes

    def quotes(self, symbols: Sequence[Any]) -> FeedResult:
        """Current price for each symbol, fetched concurrently.

        A failure on one symbol must not blank the rest of the watchlist, so
        every symbol is caught individually and simply omitted.
        """
        wanted: list[str] = []
        for raw in symbols:
            name = normalise(raw)
            if name in UNIVERSE and name not in wanted:
                wanted.append(name)
        if not wanted:
            return FeedResult(provider=self.id)

        out: dict[str, Quote] = {}
        errors: list[str] = []

        def one(name: str) -> None:
            try:
                q = self._quote_one(name)
                if q is not None:
                    out[name] = q
            except Exception as exc:  # per-symbol, never fatal
                errors.append(f"{name}: {exc}")

        with ThreadPoolExecutor(max_workers=min(self.workers, len(wanted))) as pool:
            list(pool.map(one, wanted))

        err = ""
        if not out:
            # Only an outright blank counts as a feed error; a few missing
            # exotics while the majors flow is a working feed.
            err = errors[0] if errors else "no_data"
            self.last_error = err
        else:
            self.last_error = ""
        return FeedResult(quotes=out, error=err, provider=self.id)

    def _quote_one(self, name: str) -> Quote | None:
        ticker = self._ticker(name)
        if not ticker:
            return None
        doc = self._chart(ticker, "1m", "1d")
        result = (((doc or {}).get("chart") or {}).get("result") or [None])[0]
        if not result:
            return None
        meta = result.get("meta") or {}
        price = _f(meta.get("regularMarketPrice"))
        stamp = meta.get("regularMarketTime")

        # Prefer the last complete 1m bar's close when the meta price is
        # missing; never fall back to a previous close, which would be
        # yesterday's number wearing a live timestamp.
        if not price:
            closes = _series(result, "close")
            times = result.get("timestamp") or []
            for i in range(len(closes) - 1, -1, -1):
                if closes[i] is not None:
                    price = _f(closes[i])
                    stamp = times[i] if i < len(times) else stamp
                    break
        if not price:
            return None

        at = int(_f(stamp) * 1000) if stamp else 0
        return Quote(symbol=name, bid=price, ask=price, last=price, at=at)

    # ------------------------------------------------------------- candles

    def candles(self, symbol: Any, timeframe: Any, count: int = 240) -> list[Candle]:
        name = normalise(symbol)
        rec = UNIVERSE.get(name)
        if not rec:
            return []
        tf = str(timeframe or "M15").upper()
        interval = _INTERVAL.get(tf, "15m")
        count = max(1, min(int(count or 240), 5000))

        needed = tf_minutes(tf) * count
        days = max(1, int(needed / 1440) + 2)
        days = min(days, _MAX_RANGE_DAYS.get(interval, 729))
        rng = _range_for(days)

        try:
            doc = self._chart(rec.yahoo, interval, rng)
        except Exception as exc:
            self.last_error = str(exc)
            return []

        result = (((doc or {}).get("chart") or {}).get("result") or [None])[0]
        if not result:
            return []
        times = result.get("timestamp") or []
        o, h, l, c = (_series(result, k) for k in ("open", "high", "low", "close"))
        vol = _series(result, "volume")

        bars: list[Candle] = []
        for i, ts in enumerate(times):
            # Yahoo pads the arrays with nulls for gaps (weekends, halts).
            # Those are not candles and must not become flat zero bars.
            if i >= len(c) or c[i] is None or o[i] is None:
                continue
            bars.append(Candle(
                symbol=name,
                timeframe=tf,
                time=datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                time_msc=int(ts) * 1000,
                open=_f(o[i]), high=_f(h[i]), low=_f(l[i]), close=_f(c[i]),
                volume=_f(vol[i] if i < len(vol) else 0),
            ))

        if tf == "H4":
            bars = resample(bars, 240)
        return bars[-count:]


# -------------------------------------------------------------- helpers


def _f(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _series(result: dict[str, Any], key: str) -> list[Any]:
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    return quote.get(key) or []


def _range_for(days: int) -> str:
    for limit, label in ((1, "1d"), (5, "5d"), (30, "1mo"), (90, "3mo"),
                         (180, "6mo"), (365, "1y"), (730, "2y"), (1825, "5y")):
        if days <= limit:
            return label
    return "max"


def resample(bars: list[Candle], minutes: int) -> list[Candle]:
    """Fold finer bars into coarser ones, aligned to the epoch.

    Used for H4, which Yahoo does not serve.  Buckets are aligned on absolute
    time rather than on the first bar received, so the same candle comes out
    regardless of where the fetched window happened to start.
    """
    if not bars or minutes <= 0:
        return bars
    step = minutes * 60
    out: list[Candle] = []
    cur: Candle | None = None
    bucket = -1
    for b in bars:
        ts = b.time_msc // 1000
        slot = ts - (ts % step)
        if cur is None or slot != bucket:
            if cur is not None:
                out.append(cur)
            bucket = slot
            cur = Candle(
                symbol=b.symbol, timeframe=f"M{minutes}",
                time=datetime.fromtimestamp(slot, tz=timezone.utc).isoformat(),
                time_msc=slot * 1000,
                open=b.open, high=b.high, low=b.low, close=b.close, volume=b.volume,
            )
        else:
            cur.high = max(cur.high, b.high)
            cur.low = min(cur.low, b.low)
            cur.close = b.close
            cur.volume += b.volume
    if cur is not None:
        out.append(cur)
    for b in out:
        b.timeframe = "H4" if minutes == 240 else b.timeframe
    return out
