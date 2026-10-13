"""The prop trading window, at every hour rather than this one.

The reported symptom was "with prop on the robot never trades, with prop
off it does". The cause was not a bug at first glance and that is what
made it expensive: the conservative profile runs 07:00-20:00 UTC, which
in Tehran is 10:30-23:30, so a trader starting the robot at nine in the
morning local time is outside a window that looks, on the screen, like
the one they meant.

The second finding is a real bug and was sitting underneath: the window
was compared as text, so any session wrapping past midnight never
matched at any hour of any day.

Both are only testable if the clock is an argument, which is why
prop/hours.py takes one.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aurion.prop.hours import resolve_zone, window_open

UTC = timezone.utc


def at(hhmm: str, weekday: int = 1) -> datetime:
    """A UTC moment at a given time, on a weekday (0 = Monday)."""
    base = datetime(2026, 10, 12, tzinfo=UTC)      # a Monday
    hh, mm = (int(x) for x in hhmm.split(":"))
    return base + timedelta(days=weekday, hours=hh, minutes=mm)


# ------------------------------------------------------- the ordinary --

def test_an_ordinary_window_opens_and_shuts():
    hours = {"start": "07:00", "end": "20:00"}

    assert window_open(hours, now=at("12:00"))[0] is True
    assert window_open(hours, now=at("07:00"))[0] is True
    assert window_open(hours, now=at("20:00"))[0] is True

    shut, why = window_open(hours, now=at("06:59"))
    assert shut is False and "07:00-20:00" in why

    assert window_open(hours, now=at("23:30"))[0] is False


# ------------------------------- the bug: a window that crosses midnight --

def test_an_overnight_window_is_open_overnight():
    """22:00-06:00 could not place an order at any hour, ever.

    Compared as text, "22:00" <= "23:00" <= "06:00" is false, and so is
    every other hour of the day. The desk reported "outside trading
    hours 22:00-06:00", which is also exactly what it would say if the
    session simply had not started.
    """
    hours = {"start": "22:00", "end": "06:00", "weekdays": [0, 1, 2, 3, 4, 5, 6]}

    assert window_open(hours, now=at("23:00"))[0] is True, "late evening is inside"
    assert window_open(hours, now=at("02:00"))[0] is True, "after midnight is inside"
    assert window_open(hours, now=at("22:00"))[0] is True
    assert window_open(hours, now=at("06:00"))[0] is True

    assert window_open(hours, now=at("12:00"))[0] is False, "midday is outside"
    assert window_open(hours, now=at("21:59"))[0] is False


# ------------------------------------------------- the cause: timezones --

def test_a_window_can_be_stated_in_the_traders_own_time():
    """09:00 in Tehran is 05:30 UTC and outside the shipped window."""
    utc_window = {"start": "07:00", "end": "20:00", "timezone": "UTC"}
    nine_in_tehran = at("05:30")

    assert window_open(utc_window, now=nine_in_tehran)[0] is False

    # The same hours, meant locally, are open - which is what the trader
    # thought they had configured.
    tehran = {"start": "07:00", "end": "20:00", "timezone": "+03:30"}
    assert window_open(tehran, now=nine_in_tehran)[0] is True


def test_the_reason_says_which_clock_it_is_using():
    shut, why = window_open({"start": "07:00", "end": "20:00"}, now=at("23:00"))
    assert shut is False
    assert "UTC" in why
    assert "23:00" in why, "the current time has to be in the message"

    shut, why = window_open(
        {"start": "07:00", "end": "20:00", "timezone": "+03:30"}, now=at("23:00"))
    assert "+03:30" in why
    assert "02:30" in why, "quoted in the window's own zone, not UTC"


def test_the_weekday_is_read_in_the_same_zone_as_the_clock():
    """Friday night UTC is Saturday in Tehran. One of them trades."""
    friday_2300_utc = at("23:00", weekday=4)
    weekdays_only = {"start": "00:00", "end": "23:59", "weekdays": [0, 1, 2, 3, 4]}

    assert window_open(weekdays_only, now=friday_2300_utc)[0] is True

    tehran = {**weekdays_only, "timezone": "+03:30"}     # 02:30 Saturday there
    assert window_open(tehran, now=friday_2300_utc)[0] is False


# ------------------------------------------------------------- zones --

def test_zone_forms_that_have_to_work_without_a_tz_database():
    """Windows ships none, and a rule that works on Linux and refuses
    every order on the customer's VPS is worse than no feature."""
    assert resolve_zone(None) is UTC
    assert resolve_zone("") is UTC
    assert resolve_zone("UTC") is UTC

    plus = resolve_zone("+03:30")
    assert plus is not None and plus.utcoffset(None) == timedelta(hours=3, minutes=30)

    minus = resolve_zone("-05:00")
    assert minus is not None and minus.utcoffset(None) == timedelta(hours=-5)

    assert resolve_zone("local") is not None


def test_a_mistyped_zone_falls_back_to_utc_rather_than_stopping_trading():
    assert resolve_zone("Mars/Olympus") is None

    # And the window still answers, in UTC, rather than refusing.
    open_now, why = window_open(
        {"start": "00:00", "end": "23:59", "timezone": "Mars/Olympus"}, now=at("12:00"))
    assert open_now is True, why


# --------------------------------------------- the shipped profiles --

def test_every_shipped_profile_states_its_timezone():
    """Otherwise the desk cannot show what the hours mean, which is the
    whole reason this was hard to diagnose."""
    from aurion.prop.profiles import PROFILES

    for name, profile in PROFILES.items():
        hours = profile.get("trading_hours") or {}
        assert hours.get("timezone"), f"{name} does not say which clock it uses"


def test_every_shipped_profile_is_open_during_its_own_session():
    from aurion.prop.profiles import PROFILES

    for name, profile in PROFILES.items():
        hours = profile.get("trading_hours") or {}
        start = hours.get("start", "00:00")
        hh, mm = (int(x) for x in start.split(":"))
        midpoint = at(f"{(hh + 1) % 24:02d}:{mm:02d}")
        assert window_open(hours, now=midpoint)[0] is True, f"{name} shut inside its own window"


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        fn()
        passed += 1
        print(f"ok   {name}")
    print(f"\n{passed}/{passed} prop hour checks passed")
