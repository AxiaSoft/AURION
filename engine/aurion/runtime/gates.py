"""Why a signal would not be sent, in words.

Pure, so it can be tested without a terminal, a broker or numpy - the
same reason runtime/stops.py is pure. The difference is that this one is
not about money going wrong; it is about a trader being able to find out
why nothing happened.

"Signal seen but auto-trade is not armed (or a gate is closed)" was the
whole of what the log used to say. That is five possibilities in one
sentence - the arming switch, the emergency switch, safe mode after a
fault, a prop lock, a tape that is not live - and each of them has a
different fix. Naming the one that is actually shut is the difference
between a log line and an answer.
"""

from __future__ import annotations

__all__ = ["fire_blockers"]


def fire_blockers(
    *,
    auto_trade: bool,
    kill_switch: bool,
    safe_mode: bool,
    prop_enabled: bool,
    prop_locked: bool,
    tape_mode: str,
) -> list[str]:
    """Every reason an entry would be refused right now.

    Empty means the path is clear. All of them are reported rather than
    only the first: a trader who turns the auto-trade switch on because
    the log told them to, and then finds the kill switch is also down,
    has been sent round the loop twice for no reason.
    """
    reasons: list[str] = []
    if not auto_trade:
        reasons.append("auto-trade is off")
    if kill_switch:
        reasons.append("the emergency switch is down")
    if safe_mode:
        reasons.append("safe mode is on after a strategy fault")
    if prop_enabled and prop_locked:
        reasons.append("prop rules have locked trading")
    tape = str(tape_mode or "unknown")
    if tape != "live":
        reasons.append(f"the tape is '{tape}', not live")
    return reasons
