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

__all__ = ["resolve_zone", "window_open", "broker_offset_minutes", "zone_label"]


def broker_offset_minutes(server_time: datetime | str | None, at: datetime | None = None) -> int | None:
    """
    How far ahead of UTC the broker's clock is, in minutes.

    Worked out rather than configured. MetaTrader stamps every tick with
    its server's own time, so the difference between that and the clock
    here is the broker's offset - and a trader should not have to know
    that their broker runs on EET, or notice when it changes for summer
    time, to make the prop window line up with the session they watch.

    Rounded to the nearest fifteen minutes because broker offsets are
    whole or half hours and the raw difference is mostly network delay
    and a tick that was already a moment old when it left.

    Returns None when the difference is implausible - more than fourteen
    hours either way is a clock that is wrong, not a timezone, and
    guessing from it would move the trading window to somewhere nobody
    chose.
    """
    if isinstance(server_time, str):
        text = server_time.strip().replace("Z", "+00:00")
        if not text:
            return None
        try:
            server_time = datetime.fromisoformat(text)
        except ValueError:
            return None
    if server_time is None:
        return None

    now = at or datetime.now(timezone.utc)
    if server_time.tzinfo is None:
        server_time = server_time.replace(tzinfo=timezone.utc)

    raw = (server_time - now).total_seconds() / 60.0
    if abs(raw) > 14 * 60:
        return None

    return int(round(raw / 15.0) * 15)


def zone_label(name: str | None, broker_minutes: int | None = None) -> str:
    """What to show on the desk for a timezone setting."""
    text = str(name or "").strip() or "UTC"
    if text.lower() != "broker":
        return text
    if broker_minutes is None:
        return "broker (unknown)"
    sign = "+" if broker_minutes >= 0 else "-"
    hh, mm = divmod(abs(broker_minutes), 60)
    return f"broker ({sign}{hh:02d}:{mm:02d})"


def resolve_zone(name: str | None, broker_minutes: int | None = None) -> timezone | None:
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

    if text.lower() == "broker":
        # Unknown until a tick has arrived. UTC until then, rather than
        # refusing to trade because the broker has not said hello yet.
        return timezone.utc if broker_minutes is None else timezone(timedelta(minutes=broker_minutes))

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
    default_zone: str | None = None,
    broker_minutes: int | None = None,
) -> tuple[bool, str]:
    """
    (open, reason). The reason is empty when it is open.

    The weekday is read in the same timezone as the clock. Reading one
    in the window's zone and the other in UTC is how a Friday evening
    session becomes a Saturday and stops.
    """
    hours = hours or {}

    # A profile that does not name a zone follows the desk's setting.
    # That is the whole arrangement: the timezone is chosen once, in
    # System settings, and every prop profile is read in it - rather
    # than being restated, and eventually contradicted, per profile.
    chosen = str(hours.get("timezone") or "").strip() or str(default_zone or "").strip() or "UTC"
    zone = resolve_zone(chosen, broker_minutes)
    label = zone_label(chosen, broker_minutes)
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
