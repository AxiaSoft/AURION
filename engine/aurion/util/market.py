"""Market session awareness.

The FX market is shut over the weekend.  The desk has to say so explicitly:
"nothing traded because the market is closed" is a different answer from "no
setup on this bar", and on a Saturday the robot must never look broken.

datetime.weekday() is Monday=0 ... Saturday=5, Sunday=6.  The prop engine has
always blocked those two days through ``trading_hours.weekdays`` (default
``[0, 1, 2, 3, 4]``); this module makes the same fact available to the desk,
the journal and the order gate with a machine-readable reason.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

WEEKEND_DAYS = (5, 6)

# Localised by the desk (i18n); the engine only reports the key.
WEEKDAY_KEYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def next_open(now: datetime) -> datetime:
    """First moment the market is treated as open again (Monday 00:00 UTC)."""
    day = now
    while True:
        day = day + timedelta(days=1)
        if day.weekday() == 0:
            return day.replace(hour=0, minute=0, second=0, microsecond=0)


def session(now: datetime | None = None, friday_close_hour: int | None = None) -> dict[str, Any]:
    """Current session state.

    ``state`` is one of ``weekend`` / ``friday_close`` / ``open``.
    ``open`` is False only for the weekend; Friday's close hour is advisory
    because the prop engine already flattens positions there on its own.
    """
    now = _aware(now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    weekday = now.weekday()
    iso = now.isoformat()

    if weekday in WEEKEND_DAYS:
        reopen = next_open(now)
        return {
            "open": False,
            "state": "weekend",
            "reason": "market_closed_weekend",
            "weekday": weekday,
            "weekday_key": WEEKDAY_KEYS[weekday],
            "utc": iso,
            "next_open": reopen.isoformat(),
            "hours_to_open": round(max(0.0, (reopen - now).total_seconds() / 3600.0), 1),
            "weekend": True,
        }

    close_hour = friday_close_hour
    if close_hour is not None and weekday == 4 and now.hour >= int(close_hour):
        reopen = next_open(now)
        return {
            "open": True,
            "state": "friday_close",
            "reason": "friday_close_hour",
            "weekday": weekday,
            "weekday_key": WEEKDAY_KEYS[weekday],
            "utc": iso,
            "next_open": reopen.isoformat(),
            "hours_to_open": round(max(0.0, (reopen - now).total_seconds() / 3600.0), 1),
            "weekend": False,
        }

    return {
        "open": True,
        "state": "open",
        "reason": "",
        "weekday": weekday,
        "weekday_key": WEEKDAY_KEYS[weekday],
        "utc": iso,
        "next_open": "",
        "hours_to_open": 0.0,
        "weekend": False,
    }


def is_weekend(now: datetime | None = None) -> bool:
    return _aware(now or datetime.now(timezone.utc)).weekday() in WEEKEND_DAYS


def block_reason(session_state: dict[str, Any]) -> str:
    """Human-readable, language-neutral reason used in the journal."""
    if session_state.get("state") == "weekend":
        return "market closed for the weekend"
    if session_state.get("state") == "friday_close":
        return "friday close hour reached"
    return ""
