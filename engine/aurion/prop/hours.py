"""Is the market window open right now?

Pure, so it can be tested at any hour of any day without waiting for one
- which matters here more than usual, because the bug this replaces was
invisible for thirteen hours out of every twenty-four and perfectly
reproducible for the other eleven.

Two things were wrong.

The window was compared as text:

    start <= "14:30" <= end

That works while the window sits inside one day and silently never
matches when it wraps past midnight. A profile with a 22:00-06:00
session - an overnight desk, an Asia-session book - could not place a
single order, at any hour, and the reason it gave was "outside trading
hours 22:00-06:00", which is exactly what it would say if the hours were
simply not reached yet.

And the window was always UTC with nothing saying so on the desk. The
shipped conservative profile runs 07:00-20:00 UTC, which in Tehran is
10:30-23:30; a trader there who starts the robot at nine in the morning
is told the market window is shut while the market is plainly open, and
the hours they are shown look like the ones they meant.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

__all__ = ["resolve_zone", "window_open"]


def resolve_zone(name: str | None) -> timezone | None:
    """
    Turn a timezone setting into something datetime can use.

    Accepts, in order of how likely anybody is to type them:

        "UTC" or empty   the default, and what every existing profile means
        "+03:30"         a plain offset, which needs no tz database
        "local"          whatever the machine is set to
        "Asia/Tehran"    an IANA name, if this Python has the data

    An offset is listed before IANA names on purpose. Windows ships no
    tz database, so ZoneInfo("Asia/Tehran") raises there unless the
    tzdata package happens to be installed - and a prop rule that works
    on the developer's Linux box and refuses every order on the
    customer's Windows VPS is worse than one that never offered the
    feature.

    Returns None when the name cannot be resolved, which callers treat
    as UTC rather than as an error: a mistyped timezone must not be able
    to stop trading.
    """
    text = str(name or "").strip()
    if not text or text.upper() == "UTC":
        return timezone.utc

    if text.lower() == "local":
        return datetime.now().astimezone().tzinfo  # type: ignore[return-value]

    if text[0] in "+-" and ":" in text:
        try:
            sign = -1 if text[0] == "-" else 1
            hh, mm = text[1:].split(":", 1)
            return timezone(sign * timedelta(hours=int(hh), minutes=int(mm)))
        except (ValueError, TypeError):
            return None

    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(text)  # type: ignore[return-value]
    except Exception:
        return None


def _minutes(hhmm: str, fallback: int) -> int:
    try:
        hh, mm = str(hhmm).split(":", 1)
        value = int(hh) * 60 + int(mm)
    except (ValueError, TypeError):
        return fallback
    return value if 0 <= value <= 24 * 60 else fallback


def window_open(
    hours: dict | None,
    *,
    allow_weekend: bool = False,
    now: datetime | None = None,
) -> tuple[bool, str]:
    """
    (open, reason). The reason is empty when it is open.

    The weekday is read in the same timezone as the clock. Reading one
    in the window's zone and the other in UTC is how a Friday evening
    session becomes a Saturday and stops.
    """
    hours = hours or {}
    zone = resolve_zone(hours.get("timezone"))
    label = str(hours.get("timezone") or "UTC").strip() or "UTC"
    if zone is None:
        zone, label = timezone.utc, "UTC"

    moment = (now or datetime.now(timezone.utc)).astimezone(zone)

    weekdays = set(hours.get("weekdays") or [0, 1, 2, 3, 4])
    if moment.weekday() not in weekdays and not allow_weekend:
        return False, "outside allowed weekdays"

    start_text = str(hours.get("start") or "00:00")
    end_text = str(hours.get("end") or "23:59")
    start = _minutes(start_text, 0)
    end = _minutes(end_text, 24 * 60 - 1)
    here = moment.hour * 60 + moment.minute

    # A window that wraps past midnight is two ranges, not one.
    inside = (start <= here <= end) if start <= end else (here >= start or here <= end)
    if inside:
        return True, ""

    return False, (
        f"outside trading hours {start_text}-{end_text} {label} "
        f"(it is {moment:%H:%M} {label} now)"
    )
