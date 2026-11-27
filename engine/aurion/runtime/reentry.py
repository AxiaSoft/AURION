"""How soon the robot is allowed to take the same trade again.

Reported as: "sometimes the robot enters, the trade closes at a loss or a
profit, and then it just keeps firing trade after trade, spamming entries
and exits."

That was not a bug in any one rule. It was the absence of one. The only
brake on entry frequency was the open-position ceiling, so the instant a
trade closed its slot came free and nothing else stood in the way - and
the built-in strategies happily re-fired, because most of their entries
are *states*, not events. ``ema_rsi``'s continuation entry says "in an
established trend, price pulled into the slow EMA and closed back on the
trend side". In a healthy trend that sentence is true on bar after bar
after bar. The strategy has no memory of having already acted on it, so:

    bar closes, condition true   -> enter
    stop is hit                  -> slot free
    next bar, condition STILL true -> enter again
    ...

On M15 that is a trade every quarter of an hour; on M1, every minute.

Three brakes are defined here, each answering a different question:

  * **Cooldown** - how long after an exit before this symbol may be
    traded again. Measured in BARS, not seconds, because a fixed number
    of seconds means something different on M1 than on H4 and the thing
    being waited for is new information, which arrives one bar at a time.
    A loss waits longer than a win: a win means the read was right and
    the next setup is probably also right; a loss is the market saying
    the read was wrong, and that is exactly when re-entering immediately
    turns into the loop above.

  * **Setup identity** - has anything actually changed since the entry
    that was already taken? A signal with the same symbol, side, entry
    kind and structural level is the SAME setup being re-announced, not a
    new opportunity. Acting on it twice is the state-versus-event bug,
    and the fingerprint below is what turns the state back into an event.

  * **Consecutive losses** - after a run of stop-outs on one symbol, the
    robot is wrong about that symbol right now. Stand down until
    something resets it.

Pure arithmetic and string handling, no MT5 and no trader import, so all
of it is testable without a terminal. See engine/tests/test_reentry.py.
"""
from __future__ import annotations

import time
from typing import Any

#: Bars to stand down on this symbol after an exit. A loss waits longer
#: than a win, for the reason in the module docstring.
DEFAULT_COOLDOWN_LOSS_BARS = 3
DEFAULT_COOLDOWN_WIN_BARS = 1

#: Stop-outs in a row on one symbol before the robot stands down there.
DEFAULT_MAX_CONSECUTIVE_LOSSES = 3

#: Bars to stand down for once that run is hit. Deliberately much longer
#: than a single cooldown: the point is to leave the market alone, not to
#: pause politely and resume the same loop.
DEFAULT_LOSS_STREAK_BARS = 12

#: Seconds in one bar of each timeframe. A timeframe nobody recognises is
#: treated as M15 rather than as zero - an unknown that means "no wait at
#: all" is the failure mode this whole module exists to prevent.
_TF_SECONDS: dict[str, int] = {
    "M1": 60, "M2": 120, "M3": 180, "M4": 240, "M5": 300, "M6": 360,
    "M10": 600, "M12": 720, "M15": 900, "M20": 1200, "M30": 1800,
    "H1": 3600, "H2": 7200, "H3": 10800, "H4": 14400, "H6": 21600,
    "H8": 28800, "H12": 43200,
    "D1": 86400, "W1": 604800, "MN1": 2592000,
}

FALLBACK_TF = "M15"


def timeframe_seconds(timeframe: str) -> int:
    """One bar of this timeframe, in seconds. Never zero."""
    key = str(timeframe or "").strip().upper()
    return _TF_SECONDS.get(key) or _TF_SECONDS[FALLBACK_TF]


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default  # NaN without importing math


def cooldown_bars(
    net: float,
    *,
    loss_bars: int = DEFAULT_COOLDOWN_LOSS_BARS,
    win_bars: int = DEFAULT_COOLDOWN_WIN_BARS,
) -> int:
    """How many bars to stand down after an exit that netted ``net``.

    Break-even counts as a loss. A trade that closed flat did not confirm
    anything, and the setup that produced it is the one still sitting on
    the chart waiting to be re-entered.
    """
    loss_bars = max(0, int(loss_bars))
    win_bars = max(0, int(win_bars))
    return win_bars if _num(net) > 0 else loss_bars


def block_until(
    at: float,
    bars: int,
    timeframe: str,
) -> float:
    """Epoch second at which a cooldown of ``bars`` bars has elapsed."""
    return float(at) + max(0, int(bars)) * timeframe_seconds(timeframe)


def cooldown_left(block: dict[str, Any] | None, now: float | None = None) -> float:
    """Seconds still to wait, or 0.0 when there is nothing to wait for."""
    if not isinstance(block, dict):
        return 0.0
    now = time.time() if now is None else float(now)
    return max(0.0, _num(block.get("until")) - now)


def describe_wait(seconds: float) -> str:
    """A wait a human reads at a glance: "40s", "4m", "1h 10m"."""
    seconds = max(0, int(round(_num(seconds))))
    if seconds < 90:
        return f"{seconds}s"
    minutes, secs = divmod(seconds, 60)
    if minutes < 90:
        return f"{minutes}m" if not secs else f"{minutes}m {secs}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h" if not minutes else f"{hours}h {minutes}m"


def setup_fingerprint(payload: dict[str, Any], *, digits: int = 5) -> str:
    """What makes this setup *this* setup, as one comparable string.

    Symbol, side, the strategy that produced it and the kind of entry are
    the identity; the structural price is what makes one instance of that
    setup different from the next. The price is rounded hard on purpose -
    a level that moved by a tick is the same level, and a fingerprint
    that changes on noise is a fingerprint that never blocks anything,
    which is the bug.

    Entry price is preferred, then the stop, then the target. A signal
    carrying none of the three is identified by its structure alone,
    which is the conservative answer: it will look like a repeat.
    """
    if not isinstance(payload, dict):
        return ""
    symbol = str(payload.get("symbol") or "").strip().upper()
    side = str(payload.get("side") or payload.get("action") or "").strip().lower()
    kind = str(payload.get("entry_kind") or payload.get("kind") or "").strip().lower()
    tag = str(payload.get("strategy") or payload.get("source") or "").strip().lower()
    anchor = 0.0
    for field in ("price", "entry", "sl", "tp"):
        anchor = _num(payload.get(field))
        if anchor > 0:
            break
    digits = max(0, int(digits))
    return f"{symbol}|{side}|{tag}|{kind}|{anchor:.{digits}f}"


def same_setup(previous: str, current: str) -> bool:
    """True when nothing that identifies the setup has changed."""
    return bool(previous) and bool(current) and previous == current
