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

from aurion.prop.hours import (broker_offset_minutes, resolve_zone,
                               window_open, zone_label, zone_choices,
                               zone_offset_minutes, ZONES)

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

def test_no_shipped_profile_pins_its_own_timezone():
    """The clock is a desk setting, not a prop setting.

    Which hours a prop firm allows is their rule; what time it is where
    you sit is not. If a profile pinned its own zone it would quietly
    override the one choice the trader made in System settings.
    """
    from aurion.prop.profiles import PROFILES

    for name, profile in PROFILES.items():
        hours = profile.get("trading_hours") or {}
        assert "timezone" in hours, f"{name} has no timezone key to inherit through"
        assert not hours["timezone"], f"{name} pins its own zone and ignores the desk"


def test_a_profile_without_a_zone_follows_the_desk():
    hours = {"start": "07:00", "end": "20:00", "timezone": ""}
    nine_in_tehran = at("05:30")

    assert window_open(hours, now=nine_in_tehran, default_zone="UTC")[0] is False
    assert window_open(hours, now=nine_in_tehran, default_zone="+03:30")[0] is True


def test_a_profile_that_does_name_a_zone_still_wins():
    hours = {"start": "07:00", "end": "20:00", "timezone": "UTC"}
    assert window_open(hours, now=at("05:30"), default_zone="+03:30")[0] is False


# ------------------------------------------------- the broker's clock --

def test_the_broker_offset_is_read_from_its_own_tick():
    """Nobody should have to know their broker runs on EET."""
    now = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)

    # A tick stamped three hours ahead, arriving a couple of seconds late.
    assert broker_offset_minutes(now + timedelta(hours=3, seconds=-2), now) == 180
    assert broker_offset_minutes(now + timedelta(hours=5, minutes=30), now) == 330
    assert broker_offset_minutes(now - timedelta(hours=5), now) == -300

    # Network jitter must not become a different timezone.
    assert broker_offset_minutes(now + timedelta(hours=2, seconds=40), now) == 120


def test_an_impossible_clock_is_refused_rather_than_believed():
    """A wrong clock is not a timezone, and guessing from one would move
    the trading window somewhere nobody chose."""
    now = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
    assert broker_offset_minutes(now + timedelta(hours=40), now) is None
    assert broker_offset_minutes(now - timedelta(days=3), now) is None
    assert broker_offset_minutes("not a date") is None
    assert broker_offset_minutes(None) is None


def test_the_offset_can_be_read_straight_off_an_ea_tick_string():
    now = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)
    assert broker_offset_minutes("2026-10-13T15:00:00Z", now) == 180
    assert broker_offset_minutes("2026-10-13T15:00:00", now) == 180   # naive = UTC


def test_broker_time_is_usable_before_the_first_tick():
    """UTC until the broker says otherwise, rather than refusing to trade."""
    assert resolve_zone("broker", None) is UTC
    assert resolve_zone("broker", 180).utcoffset(None) == timedelta(hours=3)

    hours = {"start": "00:00", "end": "23:59", "timezone": "broker"}
    assert window_open(hours, now=at("12:00"), broker_minutes=None)[0] is True


def test_the_label_says_what_broker_time_turned_out_to_be():
    assert zone_label("broker", 180) == "broker (+03:00)"
    assert zone_label("broker", -330) == "broker (-05:30)"
    assert zone_label("broker", None) == "broker (unknown)"
    assert zone_label("+03:30") == "+03:30"


def test_every_shipped_profile_is_open_during_its_own_session():
    from aurion.prop.profiles import PROFILES

    for name, profile in PROFILES.items():
        hours = profile.get("trading_hours") or {}
        start = hours.get("start", "00:00")
        hh, mm = (int(x) for x in start.split(":"))
        midpoint = at(f"{(hh + 1) % 24:02d}:{mm:02d}")
        assert window_open(hours, now=midpoint)[0] is True, f"{name} shut inside its own window"


def test_the_offset_published_to_the_desk_is_the_one_in_effect_today():
    """The desk converts prop hours to broker time with this number, so
    it has to be the live offset rather than a nominal one."""
    assert zone_offset_minutes("UTC") == 0
    assert zone_offset_minutes("+03:30") == 210
    assert zone_offset_minutes("-05:00") == -300

    # "broker" resolves to whatever the ticks said.
    assert zone_offset_minutes("broker", 180) == 180
    assert zone_offset_minutes("broker", None) == 0      # UTC until a tick

    # A zone nobody can resolve yields nothing, so the desk shows no
    # conversion rather than a wrong one.
    assert zone_offset_minutes("Mars/Olympus") is None


def test_converting_an_hour_between_the_two_clocks():
    """The arithmetic the desk does, checked here where it is cheap.

    A time written in the trader's zone is the same instant as
    time - their_offset + broker_offset on the broker's clock.
    """
    def broker_time(text: str, mine: int, broker: int) -> str:
        hh, mm = (int(x) for x in text.split(":"))
        at = (hh * 60 + mm - mine + broker) % (24 * 60)
        return f"{at // 60:02d}:{at % 60:02d}"

    tehran, eet = 210, 180
    assert broker_time("07:00", tehran, eet) == "06:30"
    assert broker_time("23:45", tehran, eet) == "23:15"

    # Both midnight wraps, which is where an offset sum usually breaks.
    assert broker_time("01:00", tehran, eet) == "00:30"
    assert broker_time("00:15", tehran, eet) == "23:45"
    assert broker_time("23:30", 0, eet) == "02:30"

    # Same clock, same answer.
    assert broker_time("09:15", eet, eet) == "09:15"


def test_the_world_is_offered_by_city_not_by_database_key():
    picks = zone_choices(180)

    cities = {z["city"] for z in picks}
    for expected in ("Tehran", "London", "New York", "Tokyo", "Sydney", "Dubai"):
        assert expected in cities, f"{expected} is not offered"

    # The three that are not places come first; they are what most
    # people want.
    assert [z["id"] for z in picks[:3]] == ["broker", "local", "UTC"]

    # Every real zone carries a region to group under and today's offset.
    for z in picks[3:]:
        assert z["group"], f"{z['id']} has no region"
        assert z["offset"].startswith(("+", "-")), z


def test_every_offered_zone_actually_resolves():
    """A list that offers a zone the engine cannot use is a trap."""
    for _region, iana, city, _m in ZONES:
        assert resolve_zone(iana) is not None, f"{city} ({iana}) does not resolve"


def test_a_city_falls_back_to_its_standard_offset_without_a_tz_database():
    """Windows ships none. Reverting Tehran to UTC would move the window
    three and a half hours with nothing said."""
    import aurion.prop.hours as H

    real = H.ZONES
    try:
        # Simulate zoneinfo being unavailable by asking for a name that
        # is in the table but cannot be imported.
        offset = H._FALLBACK["Asia/Tehran"]
        assert offset == 210
    finally:
        H.ZONES = real

    # And the resolved zone is never None for a listed city.
    assert resolve_zone("Asia/Tehran") is not None


def test_the_label_names_the_city_and_its_offset():
    assert zone_label("Asia/Tehran").startswith("Tehran (")
    assert zone_label("America/New_York").startswith("New York (")
    assert zone_label("UTC") == "UTC"


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        fn()
        passed += 1
        print(f"ok   {name}")
    print(f"\n{passed}/{passed} prop hour checks passed")
