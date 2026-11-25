"""The expert's millisecond clock must not be the one that wraps.

MQL5 offers two millisecond clocks. ``GetTickCount()`` is a ``uint`` of
milliseconds since the machine booted, so it returns to zero every 49.7
days. ``GetTickCount64()`` is a ``ulong`` of the same milliseconds and
wraps after roughly 584 million years.

The bridge uses that clock two ways, and only one of them survives a
wrap:

    now - g_last_beat >= InpHeartbeatMs     an ELAPSED time. Unsigned
                                            subtraction wraps the same
                                            way the clock does, so the
                                            answer stays right.

    if(now < g_next_try) return;            an ABSOLUTE deadline, and
                                            this one does not.

The absolute form was the bug. ``g_next_try`` is set to ``now + 600``
whenever a flush fails. If that happened in the last second before a
wrap, the deadline held a value near 2**32 while the clock restarted at
zero -- and ``OnTimer`` then returned on its second line, every time,
for the next 49.7 days. The expert did not crash and did not log. It
stopped: no heartbeat, no prices, no history, and no order could leave
the desk, on a terminal the trader could see was still running.
``OnTick`` and ``PumpHistory`` carried the same shape.

MetaTrader is routinely left running for months, which is precisely the
uptime that reaches 49.7 days.

These tests are textual because there is no MQL5 compiler here, and
textual is enough: the defect is a type and a function name, and both
are visible in the source.

    python3 -m pytest engine/tests/test_ea_clock_wrap.py
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EA_DIR = ROOT / "engine" / "ea"
BRIDGE = EA_DIR / "AurionBridge.mq5"

#: Every variable that holds a moment on the millisecond clock, as
#: opposed to a duration. These are the ones compared absolutely.
CLOCKS = (
    "g_last_beat",
    "g_last_quote",
    "g_last_spec",
    "g_up_since",
    "g_next_try",
    "g_hist_next",
)


def source() -> str:
    return BRIDGE.read_text(encoding="utf-8")


def code_lines() -> list[tuple[int, str]]:
    """Source lines with the comments taken out.

    The file explains the bug at length, so a naive grep for
    ``GetTickCount()`` finds the prose rather than the code. Only real
    statements are of interest here.
    """
    out: list[tuple[int, str]] = []
    in_block = False
    for number, raw in enumerate(source().splitlines(), start=1):
        line = raw
        if in_block:
            end = line.find("*/")
            if end < 0:
                continue
            line = line[end + 2 :]
            in_block = False
        while True:
            start = line.find("/*")
            if start < 0:
                break
            end = line.find("*/", start + 2)
            if end < 0:
                line = line[:start]
                in_block = True
                break
            line = line[:start] + line[end + 2 :]
        line = re.sub(r"//.*$", "", line)
        if line.strip():
            out.append((number, line))
    return out


def test_the_bridge_never_reads_the_32_bit_clock() -> None:
    """``GetTickCount()`` must not appear in code at all.

    Not "must not appear in an absolute comparison" -- must not appear.
    A 32-bit reading assigned to a 64-bit deadline is the same bug one
    step removed, and the only way to keep the whole class out is to
    keep the short clock out.
    """
    bad = [
        (number, line.strip())
        for number, line in code_lines()
        if re.search(r"\bGetTickCount\s*\(", line)
        and not re.search(r"\bGetTickCount64\s*\(", line)
    ]
    assert not bad, (
        "GetTickCount() wraps every 49.7 days and the retry deadlines are "
        "compared absolutely against it, which freezes the bridge for seven "
        "weeks. Use GetTickCount64():\n"
        + "\n".join(f"  line {n}: {t}" for n, t in bad)
    )


def test_the_bridge_actually_uses_the_64_bit_clock() -> None:
    """Guard the other direction: the calls must still be there.

    Deleting every clock reading would pass the test above.
    """
    hits = sum(
        len(re.findall(r"\bGetTickCount64\s*\(", line)) for _, line in code_lines()
    )
    assert hits >= 8, f"only {hits} GetTickCount64() calls - the clock reads went missing"


@pytest.mark.parametrize("name", CLOCKS)
def test_every_clock_variable_is_64_bit(name: str) -> None:
    """A ulong deadline fed by a uint variable still wraps."""
    match = re.search(rf"^\s*(\w+)\s+{name}\s*=", source(), flags=re.M)
    assert match, f"{name} is no longer declared - update CLOCKS"
    assert match.group(1) == "ulong", (
        f"{name} holds a moment on the millisecond clock and is declared "
        f"{match.group(1)}; a uint wraps every 49.7 days"
    )


def test_the_local_now_snapshots_are_64_bit() -> None:
    """``uint now = GetTickCount64()`` would truncate at the assignment.

    This is the subtle way the bug comes back: the call is modernised,
    the variable it lands in is not, and the wrap returns with nothing
    in the diff that looks wrong.
    """
    bad = [
        (number, line.strip())
        for number, line in code_lines()
        if re.search(r"\buint\s+now\s*=", line)
    ]
    assert not bad, (
        "a 64-bit clock truncated into a uint wraps exactly as before:\n"
        + "\n".join(f"  line {n}: {t}" for n, t in bad)
    )


def test_the_millisecond_inputs_are_not_cast_back_down() -> None:
    """``now - g_last_quote >= (uint)InpTickMs`` re-narrows the comparison."""
    bad = [
        (number, line.strip())
        for number, line in code_lines()
        if re.search(r"\(uint\)\s*Inp(TickMs|HeartbeatMs)", line)
    ]
    assert not bad, (
        "casting the interval to uint drags a 64-bit comparison back to 32 "
        "bits:\n" + "\n".join(f"  line {n}: {t}" for n, t in bad)
    )


def test_the_absolute_deadlines_are_still_absolute() -> None:
    """The comparisons this fix protects must still exist.

    If a later refactor turns them into elapsed-time subtractions that
    is fine and better, but silently deleting the retry backoff is not,
    and this test should be read again rather than deleted.
    """
    text = source()
    assert re.search(r"now\s*<\s*g_next_try", text), "OnTimer's retry backoff went missing"
    assert re.search(r"GetTickCount64\(\)\s*<\s*g_hist_next", text), (
        "PumpHistory's backoff between CopyRates attempts went missing"
    )
