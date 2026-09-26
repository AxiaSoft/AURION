from __future__ import annotations

from typing import Any

import numpy as np


def summarize(trades: list[dict[str, Any]], equity: list[float], initial: float) -> dict[str, Any]:
    if not trades:
        return {
            "trades": 0,
            "win_rate": 0.0,
            "profit_factor": 0.0,
            "net": 0.0,
            "max_drawdown": 0.0,
            "sharpe": 0.0,
            "avg_rr": 0.0,
            "wins": 0,
            "losses": 0,
        }
    profits = [float(t.get("profit") or 0) for t in trades]
    wins = [p for p in profits if p > 0]
    losses = [p for p in profits if p < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    pf = gross_win / gross_loss if gross_loss else (gross_win and float("inf") or 0.0)
    eq = np.array(equity if equity else [initial], dtype=float)
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / np.where(peak == 0, 1, peak)
    max_dd = float(dd.max() * 100.0) if len(dd) else 0.0
    rets = np.diff(eq) / np.where(eq[:-1] == 0, 1, eq[:-1]) if len(eq) > 2 else np.array([0.0])
    sharpe = 0.0
    if rets.std() > 0:
        sharpe = float(np.sqrt(252) * rets.mean() / rets.std())
    rr = []
    for t in trades:
        risk = abs(float(t.get("risk") or 0))
        if risk > 0:
            rr.append(float(t.get("profit") or 0) / risk)
    return {
        "trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": (len(wins) / len(trades)) * 100.0 if trades else 0.0,
        "profit_factor": pf if np.isfinite(pf) else 99.0,
        "net": float(sum(profits)),
        "max_drawdown": max_dd,
        "sharpe": sharpe,
        "avg_rr": float(np.mean(rr)) if rr else 0.0,
        "final_equity": float(eq[-1]) if len(eq) else initial,
    }
