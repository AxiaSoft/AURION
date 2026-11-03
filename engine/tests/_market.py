"""Market series that contain a setup, rather than hoping one turns up.

A Gaussian random walk does not reliably contain a liquidity sweep
followed by a displacement and a retrace into the imbalance it left --
seven seeds over 1500 bars produced not one. A strategy that trades that
sequence therefore looks broken on walk data when it is working exactly
as designed, and a test built on a walk is a coin toss that usually
tests nothing.

So the sequence is built explicitly here, and shared by every suite that
needs a selective strategy to actually speak.
"""

from __future__ import annotations


def _bar(i: int, o: float, h: float, l: float, c: float) -> dict:
    return {"time": f"2026-03-{1 + i // 1440:02d}T{(i // 60) % 24:02d}:{i % 60:02d}:00",
            "open": o, "high": h, "low": l, "close": c, "volume": 100}


def textbook(side: str = "buy", *, sweep: bool = True, displace: bool = True,
             retrace: bool = True, lead: int = 420) -> list[dict]:
    """The setup this strategy exists for, built by hand.

    A random walk does not contain this pattern -- seven different seeds
    over 1500 bars produced not one setup -- so hoping one turns up is
    not a test, it is a coin toss that usually tests nothing. This builds
    the sequence explicitly, which also means each step can be removed
    on its own to prove it was load-bearing.

    The three keyword flags each knock out one step:

    ``sweep=False``     no dip below the swing low -- liquidity untaken
    ``displace=False``  a slow drift up instead of three fast bars
    ``retrace=False``   price never comes back to the zone it left
    """
    flip = side == "sell"
    sign = -1.0 if flip else 1.0
    step, wig = 0.0009, 0.00035
    bars: list[dict] = []
    price = 1.0
    # A trend with real pullbacks, so swings, structure and the higher
    # timeframe all have something to read.
    for i in range(lead):
        up = (i % 10) < 7
        o = price
        price = price + sign * (step if up else -step * 0.8)
        c = price
        bars.append(_bar(i, o, max(o, c) + wig, min(o, c) - wig, c))
    n = len(bars)

    # 1. the sweep: take out the recent extreme, close back inside it.
    edge = (min(b["low"] for b in bars[-14:]) if not flip
            else max(b["high"] for b in bars[-14:]))
    o = bars[-1]["close"]
    c = edge + sign * 0.0012
    if sweep:
        lo = edge - 0.0008 if not flip else min(o, c) - wig
        hi = max(o, c) + wig if not flip else edge + 0.0008
        bars.append(_bar(n, o, hi, lo, c))
    else:
        bars.append(_bar(n, o, max(o, c) + wig, min(o, c) - wig, c))
    n += 1

    # 2. displacement away from it, which is what leaves the gap.
    move = 0.016 if displace else 0.0008
    for _ in range(3):
        o = bars[-1]["close"]
        c = o + sign * move
        bars.append(_bar(n, o, max(o, c) + wig, min(o, c) - wig * 0.2, c))
        n += 1

    # 3. and the retrace back into it, which is the entry.
    gap_lo, gap_hi = bars[-3]["high"], bars[-1]["low"]
    if flip:
        gap_lo, gap_hi = bars[-1]["high"], bars[-3]["low"]
    target = gap_lo + (gap_hi - gap_lo) * 0.05 if gap_hi > gap_lo else gap_lo
    for k in range(4):
        o = bars[-1]["close"]
        c = o + (target - o) * (0.55 if k < 3 else 1.0) if retrace else o + sign * 0.0006
        bars.append(_bar(n, o, max(o, c) + wig * 0.4, min(o, c) - wig * 0.4, c))
        n += 1
    return bars
