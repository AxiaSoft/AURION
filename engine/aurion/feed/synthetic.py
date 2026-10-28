"""A deterministic offline price source.

Needed for two honest reasons and one dishonest one it must never serve.

Honest: the test suite cannot reach the internet, and neither can a customer
machine that is simply offline -- the desk should still start, draw its
layout and let someone click around rather than show a dead screen.

Dishonest, and explicitly guarded against: this must never be mistaken for
the market.  `simulated` is True, the manager copies that flag into
`status()`, and the desk is required to label it.  No price from here may
reach a real-money decision; it exists for the chart's plumbing and for a
demo account that is honest about being a demo.

Prices are a seeded random walk, so the same symbol always produces the same
series -- a test that asserts on a number stays true tomorrow.
"""

from __future__ import annotations

import math
import random
import time
from datetime import datetime, timezone
from typing import Any, Sequence

from ..mt5.types import Candle
from .base import FeedResult, Quote, tf_seconds
from .symbols import UNIVERSE, normalise

#: Plausible starting levels so a chart does not open at 1.0 for everything.
#: These are reference levels for a simulation, not quotes.
_ANCHOR: dict[str, float] = {
    "EURUSD": 1.08, "GBPUSD": 1.27, "USDJPY": 150.0, "USDCHF": 0.88,
    "AUDUSD": 0.65, "USDCAD": 1.36, "NZDUSD": 0.60, "EURGBP": 0.85,
    "XAUUSD": 2050.0, "XAGUSD": 23.0, "USDTRY": 32.0, "USDMXN": 17.0,
}


def _anchor(name: str) -> float:
    if name in _ANCHOR:
        return _ANCHOR[name]
    rec = UNIVERSE.get(name)
    if not rec:
        return 1.0
    # Derive something stable and sanely scaled from the name itself.
    seed = sum(ord(c) for c in name)
    if rec.digits <= 2:
        return 100.0 + (seed % 2000)
    if rec.digits == 3:
        return 50.0 + (seed % 150)
    return 0.5 + (seed % 150) / 100.0


class SyntheticFeed:
    id = "synthetic"
    label = "Simulated (offline)"
    needs_key = False
    tick_true = True
    has_spread = True
    #: The flag everything downstream keys off. Never set this False here.
    simulated = True

    def __init__(self, seed: int = 7, volatility: float = 0.0006) -> None:
        self.seed = int(seed)
        self.volatility = float(volatility)
        self.last_error = ""

    def available(self) -> bool:
        return True

    def supports(self, symbol: Any) -> bool:
        return normalise(symbol) in UNIVERSE

    def _price_at(self, name: str, ts: int) -> float:
        """Price of `name` at epoch second `ts`, reproducibly.

        A hash-driven walk rather than stored state, so any point in the
        series can be asked for in any order and always gives the same
        answer -- which is what makes candles and quotes agree.
        """
        rec = UNIVERSE.get(name)
        base = _anchor(name)
        rnd = random.Random(f"{self.seed}:{name}")
        drift = rnd.uniform(-1.0, 1.0)
        # Three sine waves of different periods plus a seeded jitter: enough
        # shape to exercise an indicator, with no trend that runs away.
        t = ts / 60.0
        wave = (
            math.sin(t / 97.0 + drift) * 1.0
            + math.sin(t / 23.0 + drift * 2) * 0.45
            + math.sin(t / 7.0 + drift * 3) * 0.2
        )
        jitter = random.Random(f"{self.seed}:{name}:{ts // 60}").uniform(-0.35, 0.35)
        move = (wave + jitter) * self.volatility
        price = base * (1.0 + move)
        return round(price, rec.digits if rec else 5)

    def quotes(self, symbols: Sequence[Any]) -> FeedResult:
        now_ms = int(time.time() * 1000)
        out: dict[str, Quote] = {}
        for raw in symbols:
            name = normalise(raw)
            rec = UNIVERSE.get(name)
            if not rec:
                continue
            mid = self._price_at(name, now_ms // 1000)
            half = rec.point * 5
            out[name] = Quote(
                symbol=name,
                bid=round(mid - half, rec.digits),
                ask=round(mid + half, rec.digits),
                last=mid,
                at=now_ms,
            )
        return FeedResult(quotes=out, provider=self.id)

    def candles(self, symbol: Any, timeframe: Any = "M15", count: int = 240) -> list[Candle]:
        name = normalise(symbol)
        rec = UNIVERSE.get(name)
        if not rec:
            return []
        tf = str(timeframe or "M15").upper()
        step = tf_seconds(tf)
        count = max(1, min(int(count or 240), 5000))
        now = int(time.time())
        latest = now - (now % step)
        bars: list[Candle] = []
        for i in range(count - 1, -1, -1):
            slot = latest - i * step
            # Four samples inside the bar give it a real body and wicks.
            pts = [self._price_at(name, slot + int(step * f)) for f in (0.0, 0.33, 0.66, 0.99)]
            bars.append(Candle(
                symbol=name, timeframe=tf,
                time=datetime.fromtimestamp(slot, tz=timezone.utc).isoformat(),
                time_msc=slot * 1000,
                open=pts[0], high=max(pts), low=min(pts), close=pts[-1],
                volume=float(100 + (slot // step) % 400),
            ))
        return bars
