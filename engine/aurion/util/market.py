"""Market session awareness.

The FX market runs on New York time, not UTC: it closes Friday 17:00
America/New_York and reopens Sunday 17:00 America/New_York.  Because New York
observes DST, that boundary is 21:00 UTC in summer and 22:00 UTC in winter —
a hardcoded UTC hour is wrong for half the year, which is what made the desk
announce "friday close" at the wrong moment.

The desk has to say so explicitly: "nothing traded because the market is
closed" is a different answer from "no setup on this bar", and on a Saturday
the robot must never look broken.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

# datetime.weekday(): Monday=0 ... Saturday=5, Sunday=6
WEEKEND_DAYS = (5, 6)
WEEKDAY_KEYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

MARKET_TZ = "America/New_York"
OPEN_HOUR_NY = 17  # 17:00 New York — Friday close and Sunday open alike


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _ny():
    """America/New_York, or None when tzdata is unavailable."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(MARKET_TZ)
    except Exception:
        return None


def _at_ny(day: datetime, hour: int = OPEN_HOUR_NY) -> datetime:
    """``hour``:00 New York on ``day``'s date, returned as a UTC instant."""
    naive = datetime(day.year, day.month, day.day, hour, 0, 0)
    tz = _ny()
    if tz is not None:
        return naive.replace(tzinfo=tz).astimezone(timezone.utc)
    # No tzdata: fall back to the DST-half answer (21:00 UTC).
    return naive.replace(hour=21, tzinfo=timezone.utc)


def _week_bounds(now: datetime) -> tuple[datetime, datetime]:
    """(most recent Sunday 17:00 NY at or before ``now``, the Friday 17:00 NY
    that follows it).

    The market is open exactly when ``sunday_open <= now < friday_close``.
    """
    now = _aware(now).astimezone(timezone.utc)

    sunday_open = None
    for back in range(0, 9):
        day = now - timedelta(days=back)
        if day.weekday() == 6:  # Sunday
            cand = _at_ny(day)
            # Today is Sunday: if 17:00 NY has not happened yet, the session
            # still belongs to last Sunday.
            sunday_open = cand if cand <= now else _at_ny(day - timedelta(days=7))
            break
    if sunday_open is None:  # pragma: no cover - defensive
        sunday_open = _at_ny(now - timedelta(days=7))

    friday_close = None
    for fwd in range(0, 9):
        day = sunday_open + timedelta(days=fwd)
        if day.weekday() == 4:  # Friday
            cand = _at_ny(day)
            if cand > sunday_open:
                friday_close = cand
                break
    if friday_close is None:  # pragma: no cover - defensive
        friday_close = sunday_open + timedelta(days=5)

    return sunday_open, friday_close


def next_open(now: datetime) -> datetime:
    """The next Sunday 17:00 New York strictly after ``now``."""
    now = _aware(now).astimezone(timezone.utc)
    for fwd in range(0, 9):
        day = now + timedelta(days=fwd)
        if day.weekday() == 6:  # Sunday
            cand = _at_ny(day)
            if cand > now:
                return cand
    return _at_ny(now + timedelta(days=7))  # pragma: no cover - defensive


def session(now: datetime | None = None, friday_close_hour: int | None = None) -> dict[str, Any]:
    """Current session state.

    ``state`` is ``weekend`` (market shut) or ``open``.  ``friday_close_hour``
    is accepted for backwards compatibility but ignored: the close is derived
    from New York time so it tracks DST on its own.
    """
    now = _aware(now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    weekday = now.weekday()
    sunday_open, friday_close = _week_bounds(now)

    base = {
        "weekday": weekday,
        "weekday_key": WEEKDAY_KEYS[weekday],
        "utc": now.isoformat(),
        "tz": MARKET_TZ,
        "week_open": sunday_open.isoformat(),
        "week_close": friday_close.isoformat(),
        # No separate "friday_close" state any more: past 17:00 NY on Friday
        # the market simply is closed, and saying otherwise is what produced
        # the misleading banner.
    }

    if sunday_open <= now < friday_close:
        return {
            **base,
            "open": True,
            "state": "open",
            "reason": "",
            "next_open": "",
            "hours_to_open": 0.0,
            "hours_to_close": round((friday_close - now).total_seconds() / 3600.0, 1),
            "weekend": False,
        }

    reopen = next_open(now)
    return {
        **base,
        "open": False,
        "state": "weekend",
        "reason": "market_closed_weekend",
        "next_open": reopen.isoformat(),
        "hours_to_open": round(max(0.0, (reopen - now).total_seconds() / 3600.0), 1),
        "weekend": True,
    }


def is_weekend(now: datetime | None = None) -> bool:
    return not session(now)["open"]


def block_reason(session_state: dict[str, Any]) -> str:
    """Human-readable, language-neutral reason used in the journal."""
    if session_state.get("state") == "weekend":
        return "market closed for the weekend"
    return ""
