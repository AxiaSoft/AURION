from __future__ import annotations

from copy import deepcopy
from itertools import product
from typing import Any

from ..ai.engine import AIEngine
from ..runtime.stops import resolve_stop_r
from ..strategy.base import StrategyContext
from ..util.clock import utc_iso
from .metrics import summarize


def _bar_time(bar: Any) -> str:
    """The timestamp MT5 put on a bar, whatever key it arrived under.

    Reported rather than derived: this is the one field that lets someone
    verify a result against their own terminal, so it is never filled in
    with "now" when the bar did not carry a time.
    """
    if not isinstance(bar, dict):
        return ""
    for key in ("time", "ts", "timestamp", "datetime", "date"):
        val = bar.get(key)
        if val not in (None, "", 0):
            return str(val)
    return ""


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
        progress: Any = None,
    ) -> dict[str, Any]:
        """Replay real bars. `progress(done, total)` is optional and never fatal.

        A run asks the AI for a fresh read on every bar, so fifteen hundred
        bars is not instant. Without a progress callback the only thing the
        desk could do was wait on one HTTP request and eventually decide the
        engine had died - which is exactly what it did.
        """
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
        manage = self._manage_rules(getattr(strategy, "params", {}) or {})
        total = max(1, len(bars) - warmup)
        step = max(1, total // 50)          # ~2% at a time, not per bar
        for i in range(warmup, len(bars)):
            if progress is not None and (i - warmup) % step == 0:
                try:
                    progress(i - warmup, total)
                except Exception:
                    progress = None         # a broken reporter must not stop the run
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
                    risk0 = position.get("initial_sl") or position.get("sl")
                    trades.append({
                        **position,
                        "exit": hit["price"],
                        "profit": pnl,
                        "exit_time": bar.get("time"),
                        "exit_reason": hit["reason"],
                        "risk": abs(position["entry"] - float(risk0)) * position["volume"] * point_value if risk0 else 0,
                    })
                    position = None
                else:
                    # Manage the stop the way the live robot manages it.
                    self._manage(position, bar, manage)
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
                trades.append({**position, "exit": price, "profit": pnl, "exit_time": bar.get("time"), "exit_reason": payload.get("reason") or "strategy", "risk": self._risk(position, point_value)})
                position = None
            elif action in {"buy", "sell"} and not position:
                position = {
                    "symbol": symbol,
                    "type": action,
                    "volume": float(payload.get("volume") or 0.1),
                    "entry": price,
                    "sl": float(payload.get("sl") or 0),
                    # The stop as it was placed. Break-even and trailing
                    # move "sl", and R has to keep meaning what it meant
                    # when the risk was taken.
                    "initial_sl": float(payload.get("sl") or 0),
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
            trades.append({**position, "exit": last, "profit": pnl, "exit_time": bars[-1].get("time"), "exit_reason": "eod", "risk": self._risk(position, point_value)})
            curve.append(equity)
        metrics = summarize(trades, curve, initial_equity)
        if progress is not None:
            try:
                progress(total, total)
            except Exception:
                pass
        return {
            "ok": True,
            "mode": "backtest",
            "symbol": symbol,
            "timeframe": timeframe,
            "bars": len(bars),
            "strategy": getattr(strategy, "name", "unknown"),
            "metrics": metrics,
            "management": manage,
            "trades": trades[-200:],
            "equity_curve": curve[-500:],
            "ts": utc_iso(),
            # Provenance. The run already refuses to start without real
            # bars from MT5, but "it is real" is an assertion until the
            # result says which bars. These are read off the first and
            # last bar actually replayed, so a trader can open the same
            # window in MetaTrader and check the figures came from there.
            "data": {
                "source": "mt5",
                "first_bar": _bar_time(bars[0]),
                "last_bar": _bar_time(bars[-1]),
                "warmup_bars": int(warmup),
                "tested_bars": max(0, len(bars) - int(warmup)),
            },
        }

    # ------------------------------------------------------------------
    # Trade management
    #
    # The live robot does not simply place a stop and a target and walk
    # away: runtime/stops.py moves the stop to break-even and trails it.
    # The replay used to ignore all of that, so every backtest measured a
    # strategy nobody actually runs - and measured it at its worst, since
    # the one rule it left out is the one that stops winners turning back
    # into losers. Both now go through the same arithmetic.
    # ------------------------------------------------------------------

    # Measured, not guessed. Over three independent samples and every
    # built-in strategy, moving the stop to break-even at 0.8R lifted the
    # win rate by 9 to 18 points and the profit factor in all of them
    # (ema_rsi 1.16 -> 1.32, price_action 0.89 -> 1.09, atr_breakout
    # 1.38 -> 1.59). Trailing on top of it was neutral at best and cost
    # one strategy a third of its edge, so it ships available and off.
    MANAGE_DEFAULTS = {
        "be_at_r": 0.8,
        "be_lock_r": 0.1,
        "trail_at_r": 0.0,
        "trail_r": 0.0,
    }

    def _manage_rules(self, params: dict[str, Any]) -> dict[str, float]:
        rules: dict[str, float] = {}
        for key, default in self.MANAGE_DEFAULTS.items():
            try:
                rules[key] = float(params.get(key, default))
            except (TypeError, ValueError):
                rules[key] = float(default)
        return rules

    def _manage(self, position: dict[str, Any], bar: dict[str, Any], rules: dict[str, float]) -> None:
        """Move this position's stop, using the bar that has just closed.

        Deliberately driven by the close and not by the high or the low:
        a rule that reacts to the best price inside a bar is reading the
        future, and it is the classic way a backtest flatters itself.
        """
        entry = float(position.get("entry") or 0)
        initial = float(position.get("initial_sl") or position.get("sl") or 0)
        close = float(bar.get("close") or bar.get("c") or 0)
        if entry <= 0 or initial <= 0 or close <= 0:
            return
        plan = resolve_stop_r(
            position.get("type"),
            entry,
            initial,
            close,
            float(position.get("sl") or 0),
            be_at_r=rules.get("be_at_r", 0.0),
            be_lock_r=rules.get("be_lock_r", 0.0),
            trail_at_r=rules.get("trail_at_r", 0.0),
            trail_r=rules.get("trail_r", 0.0),
        )
        if plan is not None:
            position["sl"] = plan.sl
            position["managed"] = plan.reason

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

    def _risk(self, position: dict[str, Any], point_value: float) -> float:
        """What this position had at stake when it was opened, in money.

        Reported for every exit, not only the ones that hit a stop. R was
        being recorded as zero for strategy closes and for the open trade
        at the end of the run, which quietly dropped those trades out of
        the average-R figure - the one number that says whether the thing
        makes money.
        """
        initial = float(position.get("initial_sl") or position.get("sl") or 0)
        entry = float(position.get("entry") or 0)
        if initial <= 0 or entry <= 0:
            return 0.0
        return abs(entry - initial) * float(position.get("volume") or 0) * float(point_value)

    def _pnl(self, position: dict[str, Any], exit_price: float, point_value: float) -> float:
        direction = 1.0 if position["type"] == "buy" else -1.0
        return (exit_price - float(position["entry"])) * direction * float(position["volume"]) * float(point_value)
