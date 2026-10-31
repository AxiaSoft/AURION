"""The timeframe vocabulary, and where a bar of each one begins.

Bucketing is the whole of candle building, and it is the part that is
quietly wrong in most implementations, because three of these periods
are not a fixed number of seconds from an arbitrary origin:

  * D1  starts at UTC midnight, not at "now minus a multiple of 86400".
  * W1  starts on a Monday. Picking the wrong weekday silently shifts
        every weekly bar by up to six days, and the error is invisible
        on a chart until it is compared with somebody else's.
  * MN1 is a calendar month. The existing TIMEFRAMES table calls it
        43200 minutes, which is thirty days -- fine as a sort key, a
        wrong answer as a bucket.

So `bucket_start` is written per family rather than as one modulo, and
the minute table stays what it always was for everything that only
needs to order or label a period.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# Minutes per period. MN1 is nominal: see the module docstring.
TIMEFRAMES: dict[str, int] = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
    "W1": 10080,
    "MN1": 43200,
}

ALIASES: dict[str, str] = {
    "1": "M1", "5": "M5", "15": "M15", "30": "M30",
    "60": "H1", "240": "H4", "1440": "D1", "10080": "W1",
    "1M": "M1", "5M": "M5", "15M": "M15", "30M": "M30",
    "1H": "H1", "4H": "H4", "1D": "D1", "D": "D1", "1W": "W1", "W": "W1",
    "MN": "MN1", "1MN": "MN1",
}


def normalise(timeframe: str) -> str:
    """The canonical name for whatever a caller or a feed called it."""
    name = str(timeframe or "M15").strip().upper()
    return ALIASES.get(name, name)


def minutes(timeframe: str) -> int:
    return TIMEFRAMES.get(normalise(timeframe), 15)


def seconds(timeframe: str) -> int:
    return minutes(timeframe) * 60


def known(timeframe: str) -> bool:
    return normalise(timeframe) in TIMEFRAMES


def bucket_start(epoch_ms: int, timeframe: str) -> int:
    """The opening timestamp, in epoch ms, of the bar `epoch_ms` falls in.

    Every bar boundary here is absolute, never relative to the first
    tick that happened to arrive. Two engines fed the same ticks in a
    different order, or started at a different moment, must produce
    byte-identical bars, or a chart and a backtest disagree about what
    happened.
    """
    tf = normalise(timeframe)
    if tf not in TIMEFRAMES:
        tf = "M15"
    ms = int(epoch_ms)

    if tf == "MN1":
        when = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        first = when.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return int(first.timestamp() * 1000)

    if tf == "W1":
        when = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        midnight = when.replace(hour=0, minute=0, second=0, microsecond=0)
        monday = midnight - timedelta(days=midnight.weekday())
        return int(monday.timestamp() * 1000)

    # D1 and everything shorter divides the UTC day evenly, so a plain
    # modulo of the epoch is already aligned to midnight.
    step = seconds(tf) * 1000
    return (ms // step) * step


def bucket_end(epoch_ms: int, timeframe: str) -> int:
    """The first millisecond that belongs to the NEXT bar."""
    tf = normalise(timeframe)
    start = bucket_start(epoch_ms, tf)

    if tf == "MN1":
        when = datetime.fromtimestamp(start / 1000, tz=timezone.utc)
        year, month = (when.year + 1, 1) if when.month == 12 else (when.year, when.month + 1)
        return int(when.replace(year=year, month=month).timestamp() * 1000)

    return start + seconds(tf) * 1000
