"""Market-structure primitives: swings, breaks, imbalance, liquidity.

The other built-ins read the market through moving averages and oscillators.
Those answer "which way has price been going", which is a lagging question and
the reason an indicator-only signal so often buys the top of the leg.

These helpers answer a different one: *where* is price, relative to the
structure that institutional order flow leaves behind. Three ideas do most of
the work:

* **Structure.** A market that is making higher highs and higher lows is
  bullish until a swing low breaks. The break itself — a close beyond the last
  swing — is the event, not a crossover.
* **Imbalance.** A move fast enough to leave a three-bar gap (a fair-value
  gap) is a move somebody had to pay up for. Price returning into that gap is
  an entry with a defined invalidation; price running away from it is a chase.
* **Liquidity.** Stops cluster beyond swing highs and lows. That is where the
  move is trying to get to, so that is where the target belongs — not at a
  round ATR multiple that happens to sit mid-range.

Everything here is pure, takes a plain OHLC frame and returns plain numbers,
so the backtester, the unit tests and the live engine all see exactly the same
reads. No I/O, no configuration, no state.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd


# ---------------------------------------------------------------------------
# Higher timeframe
# ---------------------------------------------------------------------------


def resample(frame: pd.DataFrame, factor: int) -> pd.DataFrame:
    """Aggregate ``factor`` bars into one, anchored on the newest bar.

    Anchored on the newest bar rather than on a clock boundary, which is a
    deliberate choice and worth the sentence: a clock-aligned higher timeframe
    spends most of its life showing a partly-formed candle, so its high, low
    and close all change mid-bar and the bias computed from them flickers.
    Anchoring on the last bar means every aggregated candle is complete. The
    cost is that the boundaries shift by one bar as each new bar arrives,
    which moves a level slightly; a flickering bias costs far more.

    Returns the frame unchanged when there is not enough history to aggregate,
    so callers never have to special-case a short series.
    """
    rows = len(frame)
    if factor <= 1 or rows < factor * 4:
        return frame.reset_index(drop=True)
    usable = (rows // factor) * factor
    tail = frame.iloc[rows - usable :].reset_index(drop=True)
    groups = tail.index // factor
    out = tail.groupby(groups).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
    )
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Swings
# ---------------------------------------------------------------------------


@dataclass
class Swing:
    index: int
    price: float
    kind: str  # "high" | "low"


def swings(frame: pd.DataFrame, k: int = 2) -> list[Swing]:
    """Fractal pivots: a bar whose extreme beats its ``k`` neighbours each side.

    ``k`` is the whole personality of the read. Small values see every wiggle
    and call it structure; large values see only the skeleton and arrive late.
    Two or three is the usual compromise on an entry chart.

    The last ``k`` bars can never be pivots — their right-hand neighbours do
    not exist yet. That is not a limitation to work around; an unconfirmed
    pivot is exactly the thing that repaints.
    """
    rows = len(frame)
    if rows < 2 * k + 1 or k < 1:
        return []
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    found: list[Swing] = []
    for i in range(k, rows - k):
        window_hi = highs[i - k : i + k + 1]
        window_lo = lows[i - k : i + k + 1]
        if highs[i] >= window_hi.max():
            found.append(Swing(i, float(highs[i]), "high"))
        if lows[i] <= window_lo.min():
            found.append(Swing(i, float(lows[i]), "low"))
    return found


def _last(kind: str, points: list[Swing], count: int = 1) -> list[Swing]:
    picked = [s for s in points if s.kind == kind]
    return picked[-count:] if picked else []


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


@dataclass
class Structure:
    """What the swings say about who is in control."""

    bias: str = "neutral"          # "bull" | "bear" | "neutral"
    event: str = "none"            # "bos" | "choch" | "none"
    broke_at: float = 0.0          # the level that was taken out
    broke_index: int = -1          # bar that did the breaking
    range_high: float = 0.0
    range_low: float = 0.0
    swing_high: float = 0.0
    swing_low: float = 0.0
    bars_since_break: int = -1
    note: str = ""

    @property
    def has_range(self) -> bool:
        return self.range_high > self.range_low > 0

    def equilibrium(self, price: float) -> float:
        """Where price sits in the dealing range: 0 at the low, 1 at the high."""
        if not self.has_range:
            return 0.5
        span = self.range_high - self.range_low
        if span <= 0:
            return 0.5
        return max(0.0, min(1.0, (price - self.range_low) / span))


def structure_state(frame: pd.DataFrame, k: int = 2) -> Structure:
    """Read the market's structure from its confirmed swings.

    Two different events matter and they are not the same thing:

    * **BOS** (break of structure) — price closed beyond the last swing *in
      the direction it was already going*. Continuation.
    * **CHoCH** (change of character) — price closed beyond the last swing
      *against* the previous sequence. The first warning that control changed
      hands.

    The bias is **persistent**: it is set by the last break and survives the
    retracement that follows, because that retracement is the only part of
    the move worth entering on. An implementation that only reported a bias
    on the breaking bar itself would be unusable — by the time it spoke,
    price would be at the extreme, which is the one place you must not buy.

    The dealing range is the leg that produced the break: from the swing that
    started it to the furthest price reached since. ``equilibrium()`` against
    that range is therefore a genuine retracement depth, which is what the
    premium/discount rule needs.
    """
    out = Structure()
    if len(frame) < 4 * k + 6:
        out.note = "not enough bars for structure"
        return out

    points = swings(frame, k)
    if not points:
        out.note = "no confirmed swings"
        return out

    # A pivot at bar i is only knowable at bar i + k. Replaying the series
    # with that delay is the difference between a backtest and a fantasy.
    confirmed: dict[int, list[Swing]] = {}
    for s in points:
        confirmed.setdefault(s.index + k, []).append(s)

    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    closes = frame["close"].to_numpy()
    rows = len(frame)

    last_hi: Swing | None = None
    last_lo: Swing | None = None
    used_hi = -1          # pivot already broken, so it cannot break twice
    used_lo = -1
    origin = 0.0

    for i in range(rows):
        for s in confirmed.get(i, []):
            if s.kind == "high":
                last_hi = s
            else:
                last_lo = s
        close = float(closes[i])

        # A break only counts on a close. An intrabar poke through a swing is
        # a liquidity grab, and trading it as a break is how you end up long
        # at the exact high.
        if last_hi is not None and close > last_hi.price and last_hi.index != used_hi:
            used_hi = last_hi.index
            out.event = "bos" if out.bias == "bull" else "choch"
            out.bias = "bull"
            out.broke_at = last_hi.price
            out.broke_index = i
            origin = last_lo.price if last_lo is not None else float(lows[: i + 1].min())
        elif last_lo is not None and close < last_lo.price and last_lo.index != used_lo:
            used_lo = last_lo.index
            out.event = "bos" if out.bias == "bear" else "choch"
            out.bias = "bear"
            out.broke_at = last_lo.price
            out.broke_index = i
            origin = last_hi.price if last_hi is not None else float(highs[: i + 1].max())

    out.swing_high = last_hi.price if last_hi is not None else 0.0
    out.swing_low = last_lo.price if last_lo is not None else 0.0

    if out.bias == "neutral" or out.broke_index < 0:
        # Never broke anything in the window: it is a range, and the range is
        # simply the two live pivots.
        out.event = "none"
        out.range_high = max(out.swing_high, out.swing_low)
        out.range_low = min(x for x in (out.swing_high, out.swing_low) if x > 0) if (out.swing_high or out.swing_low) else 0.0
        out.note = "no break — ranging"
        return out

    since = slice(out.broke_index, rows)
    if out.bias == "bull":
        out.range_low = origin
        out.range_high = float(highs[since].max())
        out.note = f"broke {out.broke_at:.5f} to the upside, {rows - 1 - out.broke_index} bars ago"
    else:
        out.range_high = origin
        out.range_low = float(lows[since].min())
        out.note = f"broke {out.broke_at:.5f} to the downside, {rows - 1 - out.broke_index} bars ago"

    out.bars_since_break = rows - 1 - out.broke_index
    return out


# ---------------------------------------------------------------------------
# Imbalance
# ---------------------------------------------------------------------------


@dataclass
class Zone:
    """A price area with an upper and a lower edge."""

    low: float
    high: float
    index: int = -1
    kind: str = ""

    def contains(self, price: float, pad: float = 0.0) -> bool:
        return (self.low - pad) <= price <= (self.high + pad)

    @property
    def mid(self) -> float:
        return (self.low + self.high) / 2.0

    @property
    def size(self) -> float:
        return max(0.0, self.high - self.low)


def fair_value_gaps(frame: pd.DataFrame, side: str, lookback: int = 30) -> list[Zone]:
    """Unmitigated three-bar imbalances, newest last.

    A bullish gap exists when bar *i+1*'s low is above bar *i-1*'s high:
    between those two prices nothing traded on the way up. It stays
    interesting only until price trades back through it, so anything already
    filled is dropped here rather than left for the caller to notice.
    """
    rows = len(frame)
    # Three bars is the pattern. The guard used to ask for five, which quietly
    # blinded the detector on exactly the short frames the unit tests use —
    # and would have done the same on the first bars after a gap in the feed.
    if rows < 3:
        return []
    start = max(1, rows - 1 - max(3, lookback))
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    out: list[Zone] = []
    for i in range(start, rows - 1):
        if side == "buy" and lows[i + 1] > highs[i - 1]:
            zone = Zone(float(highs[i - 1]), float(lows[i + 1]), i, "fvg")
        elif side == "sell" and highs[i + 1] < lows[i - 1]:
            zone = Zone(float(highs[i + 1]), float(lows[i - 1]), i, "fvg")
        else:
            continue
        if zone.size <= 0:
            continue
        # Mitigated? Anything after the gap that traded through it closes it.
        after = slice(i + 2, rows)
        if side == "buy" and rows > i + 2 and lows[after].min() <= zone.low:
            continue
        if side == "sell" and rows > i + 2 and highs[after].max() >= zone.high:
            continue
        out.append(zone)
    return out


def order_block(frame: pd.DataFrame, side: str, lookback: int = 20) -> Zone | None:
    """The last opposing candle before the move that broke structure.

    For a bullish break that is the final down-close candle before the rally:
    the place the buyers who caused the move were filled, and the level they
    tend to defend. Crude compared with real order-flow data, but it is what
    OHLC can honestly support, and it beats a round number.
    """
    rows = len(frame)
    if rows < 3:
        return None
    opens = frame["open"].to_numpy()
    closes = frame["close"].to_numpy()
    highs = frame["high"].to_numpy()
    lows = frame["low"].to_numpy()
    start = max(0, rows - 1 - max(3, lookback))
    for i in range(rows - 2, start - 1, -1):
        bullish_candle = closes[i] > opens[i]
        if side == "buy" and not bullish_candle:
            return Zone(float(lows[i]), float(highs[i]), i, "ob")
        if side == "sell" and bullish_candle:
            return Zone(float(lows[i]), float(highs[i]), i, "ob")
    return None


# ---------------------------------------------------------------------------
# Liquidity
# ---------------------------------------------------------------------------


def liquidity_target(
    frame: pd.DataFrame, side: str, entry: float, k: int = 2, min_distance: float = 0.0
) -> float:
    """The nearest pool of stops the move can reasonably reach.

    Swing highs above (for a long) are where late sellers' stops sit; that is
    the natural magnet. Returns 0.0 when nothing qualifies, which the caller
    should read as "no structural target, fall back to a multiple" rather than
    as an error.
    """
    points = swings(frame, k)
    if not points:
        return 0.0
    if side == "buy":
        above = [s.price for s in points if s.kind == "high" and s.price > entry + min_distance]
        return float(min(above)) if above else 0.0
    below = [s.price for s in points if s.kind == "low" and s.price < entry - min_distance]
    return float(max(below)) if below else 0.0


def swept_liquidity(frame: pd.DataFrame, side: str, k: int = 2, bars: int = 3) -> bool:
    """Did the recent bars take out a swing and close back inside it?

    This is the stop hunt: the wick that trips everybody's stop before the
    real move. Taking an entry *after* one is a materially better bet than
    taking the same entry before it, so it earns confidence rather than
    gating the trade.
    """
    rows = len(frame)
    if rows < 2 * k + bars + 2:
        return False
    points = swings(frame.iloc[: rows - bars], k)
    if not points:
        return False
    recent = frame.iloc[rows - bars :]
    if side == "buy":
        lows = [s.price for s in points if s.kind == "low"]
        if not lows:
            return False
        level = max(lows)
        return bool(recent["low"].min() < level <= float(frame["close"].iloc[-1]))
    highs = [s.price for s in points if s.kind == "high"]
    if not highs:
        return False
    level = min(highs)
    return bool(recent["high"].max() > level >= float(frame["close"].iloc[-1]))


# ---------------------------------------------------------------------------
# Displacement
# ---------------------------------------------------------------------------


@dataclass
class Displacement:
    ok: bool = False
    strength: float = 0.0  # body of the leg in ATR
    bars: int = 0
    note: str = ""
    extras: dict[str, float] = field(default_factory=dict)


def displacement(frame: pd.DataFrame, side: str, atr: float, bars: int = 3, min_atr: float = 1.0) -> Displacement:
    """Was the recent move fast enough to mean something?

    Structure breaks on low momentum are the ones that get reclaimed an hour
    later. Measuring the *net* move across the last few bars in ATR separates
    a genuine displacement from a slow grind that happens to cross a level.
    """
    rows = len(frame)
    if rows < bars + 2 or atr <= 0:
        return Displacement(note="no atr")
    window = frame.iloc[rows - bars :]
    first_open = float(window["open"].iloc[0])
    last_close = float(window["close"].iloc[-1])
    net = last_close - first_open
    signed = net if side == "buy" else -net
    strength = signed / atr
    if strength < min_atr:
        return Displacement(False, round(strength, 3), bars, f"move is only {strength:.2f} ATR")
    return Displacement(True, round(strength, 3), bars, f"{strength:.2f} ATR displacement")
