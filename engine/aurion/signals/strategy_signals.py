"""Chart signals produced by the strategies that are actually armed.

Until now the marks on the chart came from ``chart_signals.py``: a fixed
EMA-cross-plus-RSI detector with no connection to anything the trader had
switched on. Arm King, arm price_action, arm nothing at all — the chart drew
the same EMA crosses either way. A trader reasonably reads those marks as
"what the robot is thinking", acts on them, and is acting on a different
system from the one that places the orders.

This replays the enabled strategies over the bar history, bar by bar, with
exactly the context the live engine gives them, and returns what *they* said.
The marks on the chart and the orders in the account now come from one place.

Two things this deliberately does not do:

* **It does not look ahead.** Each bar is evaluated with ``candles[:i+1]``,
  so a signal drawn at bar *i* is one the strategy could really have produced
  at bar *i*. Slicing is cheap; being wrong about this makes every mark on
  the chart a lie.
* **It does not invent levels.** The stop and target drawn are the ones the
  strategy put on the ticket. Where a strategy sends none, none are shown.

One thing it *does* change, and says so on the mark: money management.
A stop wider than the account's per-lot loss cap would never be sent at
that distance, so drawing it would show the trader a trade they cannot
take. ``cap`` is the caller's rule — the engine's — and when it moves a
level the mark carries ``capped: true`` and the original distance.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Iterable

from ..strategy.base import StrategyContext


# How much of the chart gets marks. 0 means all of it.
#
# This was 240 bars, with the reasoning "nobody is reading a mark from
# eight hundred bars ago". That was wrong, and it was reported as a bug:
# the trader scrolls back through the history precisely to see what the
# robot would have done there, and found arrows bunched at the right
# edge and six months of apparently empty chart behind them. An absent
# mark does not read as "not analysed", it reads as "no setup here".
#
# The cost that justified the cap is real but was fixable, and has been
# fixed below: the replay used to hand each bar the whole history before
# it, which makes a full pass quadratic. It now hands over only as much
# as the strategy declares it reads, so a pass is linear in the number
# of bars.
DEFAULT_WINDOW = 0

# Each strategy needs history before it will say anything at all. Replaying
# from bar zero would just produce a run of silent iterations.
WARMUP_BARS = 220

#: The most history any strategy is handed per bar during a chart replay.
#:
#: The longest lookback in any builtin is 150 bars, so 2000 is more than
#: a decade of headroom on that.
#:
#: MEASURED on the strategy this could change — smart_money, the only
#: builtin declaring history_window = 0, because its higher-timeframe
#: bias resamples the frame. Over 3000 M15 bars, unbounded slices
#: against a 2000-bar ceiling: identical marks, identical levels. The
#: resample sees the same recent structure either way; what it cannot
#: see is a bar 2000 back, which no bias from two years ago should be
#: deciding anyway. The A/B is in engine/tests/test_chart_signal_span.py.
SLICE_CEILING = 2000

#: The most marks drawn on one chart.
#:
#: There has to be a limit - a six-month M1 chart could produce tens of
#: thousands of arrows and be unreadable. The limit used to be "the
#: newest 60", which is the one shape it must not be: it threw away the
#: older history, which is precisely what the trader scrolled back to
#: look at. See thin_marks().
MAX_MARKS = 600


def _norm(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def replay(
    bars: list[dict[str, Any]],
    strategies: Iterable[tuple[str, Any]],
    symbol: str,
    timeframe: str,
    window: int = DEFAULT_WINDOW,
    ai: dict[str, Any] | None = None,
    budget_seconds: float = 6.0,
    on_error: Callable[[str, Exception], None] | None = None,
    cap: Callable[[str, float, float], float] | None = None,
    first: int | None = None,
    last: int | None = None,
) -> dict[str, Any]:
    """Run each armed strategy over a range of ``bars``.

    ``strategies`` is ``(name, instance)`` pairs — whatever the trader has
    enabled. Returns the same envelope the old detector returned, so the desk
    needs no special case, with ``source`` and per-signal ``strategy`` added
    so it can say where a mark came from.

    ``first`` and ``last`` bound the pass to ``bars[first:last]``. They are
    what lets the caller fill the chart in across several refreshes instead
    of blocking once for minutes: six months of M15 is 17 280 bars, and
    smart_money alone is about 11 ms of work per bar. Omitted, the pass
    covers everything from WARMUP_BARS to the end.

    ``budget_seconds`` is a wall-clock ceiling rather than a bar count: a
    chart refresh that blocks for thirty seconds because somebody armed four
    strategies on a slow box is a worse outcome than a slightly shorter
    history of marks. When the budget runs out the envelope says where the
    pass stopped, so the caller can resume there rather than losing it.
    """
    items = [(str(name), inst) for name, inst in strategies if inst is not None]
    total = len(bars)
    if not items:
        return {"ok": True, "signals": [], "count": 0, "bars": total, "source": "none"}
    if total < 60:
        return {"ok": True, "signals": [], "count": 0, "bars": total, "reason": "need_more_bars",
                "source": "strategy"}

    stop_at = total if last is None else max(0, min(total, int(last)))
    if first is not None:
        start_at = max(WARMUP_BARS, min(int(first), stop_at))
    else:
        span = int(window if window is not None else DEFAULT_WINDOW)
        if span <= 0:
            # The whole chart. Still never before WARMUP_BARS, because a
            # strategy asked about bar 3 has nothing to work with and
            # would only produce a run of silent iterations.
            start_at = WARMUP_BARS
        else:
            start_at = max(WARMUP_BARS, stop_at - max(20, span))
    if start_at >= stop_at:
        return {"ok": True, "signals": [], "count": 0, "bars": total, "source": "strategy",
                "strategies": [name for name, _ in items], "window": 0, "truncated": False,
                "covered_from": start_at, "covered_to": start_at, "slice": 0}

    # How much history each strategy is handed per bar.
    #
    # `bars[:i+1]` was the old slice, and it is what made a full-history
    # pass impossible: bar 10 000 was handed 10 000 bars, so the work
    # grew with the square of the history and six months of M15 would
    # have taken hours. A strategy that declares history_window = 1500
    # has said it reads no further back than that, so handing it more is
    # pure cost.
    #
    # A strategy that declares 0 means "the whole frame", and in a
    # BACKTEST that is honoured exactly. Here it cannot be: 0 over six
    # months of M1 is a quarter of a million bars squared. So 0 becomes
    # SLICE_CEILING and the envelope reports the number used, because
    # the alternative is not "more correct marks" - it is no marks at
    # all on everything but the last few hundred bars, which is the bug
    # this is fixing.
    slices = []
    for _, inst in items:
        try:
            declared = int(getattr(inst, "history_window", 0) or 0)
        except (TypeError, ValueError):
            declared = 0
        slices.append(min(SLICE_CEILING, declared) if declared > 0 else SLICE_CEILING)
    # One number for the whole pass: the widest any armed strategy asked
    # for. Slicing per strategy would be tighter but would build a
    # different list for each one on every bar, which costs more than it
    # saves at these sizes.
    per_bar = max(slices)

    deadline = time.monotonic() + max(0.5, float(budget_seconds))
    truncated = False
    out: list[dict[str, Any]] = []

    # NEWEST BAR FIRST.
    #
    # Reported: "the signals are not drawn on the newer candles - I
    # have never once seen a mark on the last candles." This loop is
    # why. It used to run start_at -> stop_at, oldest to newest, and
    # it is on a time budget: smart_money costs roughly 11ms a bar, a
    # slab is 1200 bars, and the budget is seconds - so the deadline
    # was reached part-way through and the pass stopped BEFORE the
    # newest bars every single time. The slab nearest the right-hand
    # edge was the one reliably sacrificed, which is the opposite of
    # what a trader needs: the mark on the last candle is the only one
    # they can still act on.
    #
    # Walking backwards means the deadline now costs the OLDEST bars
    # of the slab, which the next refresh picks up anyway (the
    # caller's planner extends coverage backwards call by call). The
    # bars analysed are still a contiguous run, so coverage is still
    # one range - it is now [reached, stop_at) instead of
    # [start_at, reached).
    reached = start_at
    for i in range(stop_at - 1, start_at - 1, -1):
        if time.monotonic() > deadline:
            # Where to resume: everything from here back is untouched,
            # and the caller must not read it as "no setups here".
            truncated = True
            reached = i + 1
            break
        history = bars[max(0, i + 1 - per_bar): i + 1]
        bar = bars[i]
        for name, inst in items:
            ctx = StrategyContext(
                symbol=symbol,
                timeframe=timeframe,
                candles=history,
                tick=None,
                account={},
                # No positions on purpose. The replay is asking "what setups
                # were there", not "what would the book have looked like" —
                # feeding it today's open position would silence every past
                # signal on that symbol and leave a chart full of holes.
                positions=[],
                orders=[],
                ai=ai or {},
                params=getattr(inst, "params", {}) or {},
                now=str(bar.get("time") or ""),
            )
            try:
                signal = inst.on_candle(ctx)
            except Exception as exc:  # one broken strategy must not blank the chart
                if on_error:
                    on_error(name, exc)
                continue
            if not signal or signal.action not in {"buy", "sell"}:
                continue
            out.append(_to_mark(signal, name, i, bar, cap))

    # Found newest-first; a chart reads oldest-first.
    out.sort(key=lambda m: int(m.get("index", 0)))
    out = thin_marks(_dedupe(out))
    return {
        "ok": True,
        "signals": out,
        "count": len(out),
        "bars": total,
        "source": "strategy",
        "strategies": [name for name, _ in items],
        "window": stop_at - reached,
        "truncated": truncated,
        # What the trader is actually looking at. `covered_from` is the
        # first bar that was analysed, so the desk can say "marks begin
        # here" instead of leaving the trader to read an unanalysed
        # stretch as a stretch with no setups. The pass runs backwards
        # from the newest bar, so a budget that runs out moves this
        # boundary UP - the right-hand edge is always covered.
        "covered_from": reached,
        "covered_to": stop_at,
        "slice": per_bar,
    }


def _to_mark(
    signal,
    name: str,
    index: int,
    bar: dict[str, Any],
    cap: Callable[[str, float, float], float] | None = None,
) -> dict[str, Any]:
    """One strategy signal, in the shape the chart overlay already reads."""
    extra = dict(getattr(signal, "extra", None) or {})
    entry = _norm(extra.get("entry")) or _norm(bar.get("close"))
    sl = _norm(signal.sl)
    tp = _norm(signal.tp)
    capped = False
    if cap is not None and entry > 0 and sl > 0:
        try:
            tightened = _norm(cap(str(signal.action), entry, sl), sl)
        except Exception:
            tightened = sl
        if tightened > 0 and abs(tightened - sl) > 1e-12:
            extra["sl_before_cap"] = sl
            sl, capped = tightened, True
    risk = abs(entry - sl) if sl else 0.0
    reward = abs(tp - entry) if tp else 0.0
    return {
        "index": index,
        "time": bar.get("time"),
        "type": signal.action,
        "side": signal.action,
        "price": entry,
        "entry": entry,
        "sl": sl,
        "tp": tp,
        "rr": round(reward / risk, 2) if risk > 0 and reward > 0 else 0.0,
        "capped": capped,
        "volume": _norm(signal.volume),
        "confidence": round(_norm(signal.confidence), 3),
        "strategy": name,
        "reason": str(signal.reason or ""),
        "extra": extra,
    }


def thin_marks(signals: list[dict[str, Any]], most: int = MAX_MARKS) -> list[dict[str, Any]]:
    """Keep the chart readable without emptying its older half.

    This replaces `kept[-60:]`, which was the SECOND cause of "the
    signals are only drawn at the right edge". Even once the replay
    covered the whole history, the sixty newest marks were the only
    ones that survived - so widening the analysis would have changed
    nothing a trader could see.

    Keeping the newest is the one trim that cannot be right here,
    because it is exactly the bias being complained about. Instead the
    history is divided into equal slices and the most confident mark in
    each is kept, so thinning reduces density evenly and every month
    keeps its best setups.
    """
    total = len(signals)
    if total <= most or most <= 0:
        return signals
    lo = min(int(s["index"]) for s in signals)
    hi = max(int(s["index"]) for s in signals)
    span = max(1, hi - lo + 1)
    best: dict[int, dict[str, Any]] = {}
    for sig in signals:
        bucket = ((int(sig["index"]) - lo) * most) // span
        held = best.get(bucket)
        if held is None or float(sig.get("confidence") or 0) > float(held.get("confidence") or 0):
            best[bucket] = sig
    out = list(best.values())
    out.sort(key=lambda s: int(s["index"]))
    return out


def _dedupe(signals: list[dict[str, Any]], gap: int = 4) -> list[dict[str, Any]]:
    """Collapse the same strategy repeating itself on consecutive bars.

    A structural setup stays valid for several bars, so a replay naturally
    reports it several times. Drawing five arrows for one idea makes the
    chart unreadable and, worse, makes a careful strategy look trigger-happy.
    The highest-confidence instance wins, because that is the bar on which the
    most confluences had arrived.
    """
    signals.sort(key=lambda s: (s["index"], s["strategy"]))
    kept: list[dict[str, Any]] = []
    # slot = where in `kept` this cluster lives; anchor = the bar the cluster
    # started on. The anchor must not move when a later, more confident bar
    # replaces the winner, or every bar would extend the cluster by another
    # `gap` and a strategy that speaks continuously would collapse to a
    # single mark for the whole history.
    slot: dict[tuple[str, str], int] = {}
    anchor: dict[tuple[str, str], int] = {}
    for sig in signals:
        key = (sig["strategy"], sig["type"])
        at = slot.get(key)
        if at is not None and sig["index"] - anchor[key] <= gap:
            if sig["confidence"] > kept[at]["confidence"]:
                kept[at] = sig
            continue
        kept.append(sig)
        slot[key] = len(kept) - 1
        anchor[key] = sig["index"]
    kept.sort(key=lambda s: s["index"])
    return kept
