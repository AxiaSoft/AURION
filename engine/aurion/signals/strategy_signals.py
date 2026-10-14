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
"""

from __future__ import annotations

import time
from typing import Any, Callable, Iterable

from ..strategy.base import StrategyContext


# Replaying a structural strategy is not free — it rebuilds swings and
# imbalances on every bar. Capping the replay keeps a chart refresh under a
# second or so, and nobody is reading a mark from eight hundred bars ago.
DEFAULT_WINDOW = 240

# Each strategy needs history before it will say anything at all. Replaying
# from bar zero would just produce a run of silent iterations.
WARMUP_BARS = 220


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
) -> dict[str, Any]:
    """Run each armed strategy across the tail of ``bars``.

    ``strategies`` is ``(name, instance)`` pairs — whatever the trader has
    enabled. Returns the same envelope the old detector returned, so the desk
    needs no special case, with ``source`` and per-signal ``strategy`` added
    so it can say where a mark came from.

    ``budget_seconds`` is a wall-clock ceiling rather than a bar count: a
    chart refresh that blocks for thirty seconds because somebody armed four
    strategies on a slow box is a worse outcome than a slightly shorter
    history of marks.
    """
    items = [(str(name), inst) for name, inst in strategies if inst is not None]
    total = len(bars)
    if not items:
        return {"ok": True, "signals": [], "count": 0, "bars": total, "source": "none"}
    if total < 60:
        return {"ok": True, "signals": [], "count": 0, "bars": total, "reason": "need_more_bars",
                "source": "strategy"}

    start_at = max(WARMUP_BARS, total - max(20, int(window or DEFAULT_WINDOW)))
    if start_at >= total:
        start_at = max(0, total - 20)

    deadline = time.monotonic() + max(0.5, float(budget_seconds))
    truncated = False
    out: list[dict[str, Any]] = []

    for i in range(start_at, total):
        if time.monotonic() > deadline:
            truncated = True
            break
        history = bars[: i + 1]
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
            out.append(_to_mark(signal, name, i, bar))

    out = _dedupe(out)
    return {
        "ok": True,
        "signals": out,
        "count": len(out),
        "bars": total,
        "source": "strategy",
        "strategies": [name for name, _ in items],
        "window": total - start_at,
        "truncated": truncated,
    }


def _to_mark(signal, name: str, index: int, bar: dict[str, Any]) -> dict[str, Any]:
    """One strategy signal, in the shape the chart overlay already reads."""
    extra = dict(getattr(signal, "extra", None) or {})
    entry = _norm(extra.get("entry")) or _norm(bar.get("close"))
    sl = _norm(signal.sl)
    tp = _norm(signal.tp)
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
        "volume": _norm(signal.volume),
        "confidence": round(_norm(signal.confidence), 3),
        "strategy": name,
        "reason": str(signal.reason or ""),
        "extra": extra,
    }


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
    return kept[-60:]
