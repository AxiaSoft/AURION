from __future__ import annotations

from copy import deepcopy
from itertools import product
from typing import Any

from ..ai.engine import AIEngine
from ..strategy.base import StrategyContext
from ..util.clock import utc_iso
from .metrics import summarize


class Backtester:
    """Offline replay of REAL historical bars supplied by MT5.

    The backtester never invents candles. If `bars` is empty it refuses to run.
    Live trading never imports this class.
    """

    def run(
        self,
        strategy,
        bars: list[dict[str, Any]],
        symbol: str,
        timeframe: str,
        initial_equity: float = 10_000.0,
        point_value: float = 1.0,
        warmup: int = 80,
        ai: AIEngine | None = None,
    ) -> dict[str, Any]:
        if not bars or len(bars) < warmup + 5:
            return {"ok": False, "error": "not enough real historical bars from MT5 to backtest"}
        if getattr(strategy, "on_start", None) is None:
            return {"ok": False, "error": "strategy has no lifecycle methods"}
        equity = initial_equity
        peak = initial_equity
        curve = [equity]
        trades: list[dict[str, Any]] = []
        position: dict[str, Any] | None = None
        brain = ai or AIEngine()
        ctx_start = self._ctx(strategy, symbol, timeframe, bars[:warmup], None, equity, [], brain)
        strategy.on_start(ctx_start)
        for i in range(warmup, len(bars)):
            window = bars[: i + 1]
            bar = bars[i]
            price = float(bar.get("close") or bar.get("c") or 0)
            if price <= 0:
                continue
            if position:
                hit = self._hit(position, bar)
                if hit:
                    pnl = self._pnl(position, hit["price"], point_value)
                    equity += pnl
                    trades.append({**position, "exit": hit["price"], "profit": pnl, "exit_time": bar.get("time"), "exit_reason": hit["reason"], "risk": abs(position["entry"] - position["sl"]) * position["volume"] * point_value if position.get("sl") else 0})
                    position = None
            account = {"equity": equity, "balance": equity, "profit": 0, "currency": "USD"}
            positions = [position] if position else []
            state = brain.infer(window, symbol, timeframe)
            ctx = self._ctx(strategy, symbol, timeframe, window, bar, equity, positions, brain, state)
            signal = strategy.on_candle(ctx)
            if not signal:
                peak = max(peak, equity)
                curve.append(equity)
                continue
            payload = signal.to_dict() if hasattr(signal, "to_dict") else dict(signal)
            action = payload.get("action")
            if action == "close" and position:
                pnl = self._pnl(position, price, point_value)
                equity += pnl
                trades.append({**position, "exit": price, "profit": pnl, "exit_time": bar.get("time"), "exit_reason": payload.get("reason") or "strategy", "risk": 0})
                position = None
            elif action in {"buy", "sell"} and not position:
                position = {
                    "symbol": symbol,
                    "type": action,
                    "volume": float(payload.get("volume") or 0.1),
                    "entry": price,
                    "sl": float(payload.get("sl") or 0),
                    "tp": float(payload.get("tp") or 0),
                    "time": bar.get("time"),
                    "reason": payload.get("reason"),
                }
            peak = max(peak, equity)
            curve.append(equity)
        if position:
            last = float(bars[-1].get("close") or 0)
            pnl = self._pnl(position, last, point_value)
            equity += pnl
            trades.append({**position, "exit": last, "profit": pnl, "exit_time": bars[-1].get("time"), "exit_reason": "eod", "risk": 0})
            curve.append(equity)
        metrics = summarize(trades, curve, initial_equity)
        return {
            "ok": True,
            "mode": "backtest",
            "symbol": symbol,
            "timeframe": timeframe,
            "bars": len(bars),
            "strategy": getattr(strategy, "name", "unknown"),
            "metrics": metrics,
            "trades": trades[-200:],
            "equity_curve": curve[-500:],
            "ts": utc_iso(),
        }

    def optimize(
        self,
        factory,
        grid: dict[str, list[Any]],
        bars: list[dict[str, Any]],
        symbol: str,
        timeframe: str,
        initial_equity: float = 10_000.0,
        max_combinations: int = 80,
    ) -> dict[str, Any]:
        keys = list(grid.keys())
        combos = list(product(*[grid[k] for k in keys]))
        if len(combos) > max_combinations:
            combos = combos[:max_combinations]
        results = []
        for combo in combos:
            params = dict(zip(keys, combo))
            strategy = factory(params)
            run = self.run(strategy, bars, symbol, timeframe, initial_equity=initial_equity)
            if run.get("ok"):
                results.append({"params": params, "metrics": run["metrics"]})
        results.sort(key=lambda r: (r["metrics"]["profit_factor"], r["metrics"]["net"]), reverse=True)
        return {"ok": True, "tested": len(results), "best": results[:10], "mode": "backtest"}

    def _ctx(self, strategy, symbol, timeframe, window, tick, equity, positions, brain, state=None):
        return StrategyContext(
            symbol=symbol,
            timeframe=timeframe,
            candles=window,
            tick=tick,
            account={"equity": equity, "balance": equity, "profit": 0},
            positions=[p for p in positions if p],
            orders=[],
            ai=state or brain.last,
            params=getattr(strategy, "params", {}),
            now=str((window[-1] or {}).get("time") or utc_iso()),
        )

    def _hit(self, position: dict[str, Any], bar: dict[str, Any]) -> dict[str, Any] | None:
        high = float(bar.get("high") or bar.get("h") or 0)
        low = float(bar.get("low") or bar.get("l") or 0)
        sl, tp = float(position.get("sl") or 0), float(position.get("tp") or 0)
        if position["type"] == "buy":
            if sl and low <= sl:
                return {"price": sl, "reason": "sl"}
            if tp and high >= tp:
                return {"price": tp, "reason": "tp"}
        else:
            if sl and high >= sl:
                return {"price": sl, "reason": "sl"}
            if tp and low <= tp:
                return {"price": tp, "reason": "tp"}
        return None

    def _pnl(self, position: dict[str, Any], exit_price: float, point_value: float) -> float:
        direction = 1.0 if position["type"] == "buy" else -1.0
        return (exit_price - float(position["entry"])) * direction * float(position["volume"]) * float(point_value)
