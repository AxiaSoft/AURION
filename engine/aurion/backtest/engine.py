from __future__ import annotations

from copy import deepcopy
from itertools import product
from typing import Any

from ..ai.engine import AIEngine
from ..ai.features import build_feature_frame
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


# How many replayed bars travel with each progress update. Enough for
# the desk to draw a chart that is recognisably moving, small enough
# that the cost per update does not grow with the length of the run.
_REPLAY_BARS = 160


def _slim(bar: Any) -> dict[str, Any]:
    """A bar reduced to what a chart needs.

    MT5 bars carry spread, tick volume and real volume as well; none of
    that is drawn, and all of it would be sent twice a second.
    """
    if not isinstance(bar, dict):
        return {}
    def num(*keys: str) -> float:
        for k in keys:
            v = bar.get(k)
            if v not in (None, ""):
                try:
                    return round(float(v), 6)
                except (TypeError, ValueError):
                    return 0.0
        return 0.0
    return {
        "t": _bar_time(bar),
        "o": num("open", "o"),
        "h": num("high", "h"),
        "l": num("low", "l"),
        "c": num("close", "c"),
    }


def _thin(values: list[float], most: int) -> list[float]:
    """Evenly sample a long series down to something a sparkline can draw.

    The live curve is republished twice a second while a replay runs, so
    sending every point would grow without bound over a long test. The
    first and last points are always kept: the ends are the two the eye
    actually reads.
    """
    n = len(values)
    if n <= most:
        return [round(float(v), 2) for v in values]
    stepf = (n - 1) / float(most - 1)
    out = [values[int(round(k * stepf))] for k in range(most)]
    out[-1] = values[-1]
    return [round(float(v), 2) for v in out]


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
        volume_mode: str = "auto",
        manual_volume: float = 0.0,
        max_open: int = 1,
    ) -> dict[str, Any]:
        """Replay real bars. `progress(done, total)` is optional and never fatal.

        A run asks the AI for a fresh read on every bar, so fifteen hundred
        bars is not instant. Without a progress callback the only thing the
        desk could do was wait on one HTTP request and eventually decide the
        engine had died - which is exactly what it did.

        `volume_mode` and `manual_volume` are the desk's own lot setting,
        passed in so a replay sizes its trades the way the live robot
        would: manual pins every entry to the trader's fixed lot, auto
        leaves the strategy's own volume alone. The backtest used to
        ignore the setting entirely and fall back to a hard-coded 0.1
        lot, so the money it reported was not the money the same signals
        would have made.

        `max_open` is how many positions may run at once, matching the
        live cap. It was fixed at one: every signal after the first was
        silently dropped until the open trade closed, which is why a
        strategy that fires in clusters showed a handful of trades over
        a window where the robot would have taken many.
        """
        if not bars or len(bars) < warmup + 5:
            return {"ok": False, "error": "not enough real historical bars from MT5 to backtest"}
        if getattr(strategy, "on_start", None) is None:
            return {"ok": False, "error": "strategy has no lifecycle methods"}
        equity = initial_equity
        peak = initial_equity
        curve = [equity]
        trades: list[dict[str, Any]] = []
        positions: list[dict[str, Any]] = []
        cap = max(1, int(max_open or 1))
        # Normalised once here and reported in the result below, so what
        # the desk prints is what the replay sized its entries with.
        mode = "manual" if str(volume_mode or "auto").lower() == "manual" else "auto"
        lot = max(0.0, float(manual_volume or 0.0))
        brain = ai or AIEngine()
        feats = self._precompute_features(bars)
        ctx_start = self._ctx(strategy, symbol, timeframe, bars[:warmup], None, equity, [], brain)
        strategy.on_start(ctx_start)
        manage = self._manage_rules(getattr(strategy, "params", {}) or {})
        total = max(1, len(bars) - warmup)
        step = max(1, total // 50)          # ~2% at a time, not per bar
        for i in range(warmup, len(bars)):
            if progress is not None and (i - warmup) % step == 0:
                try:
                    # Carry the run's state, not just how far along it is.
                    # A percentage says the engine is alive; it does not
                    # let the desk show the replay happening. The curve is
                    # thinned to something a sparkline can use, and only
                    # the tail of the trade list travels - the whole thing
                    # arrives at the end anyway.
                    # The bars being replayed travel with the progress.
                    #
                    # Without them the desk had nothing of the test to
                    # draw, so it drew the only candles it had - the live
                    # market - beside a replay of a window that had
                    # finished hours ago. Two unrelated things in one
                    # panel, the larger of them labelled as the test.
                    # A window of the most recent bars is enough to show
                    # the replay moving and is a fixed cost per update.
                    seen = bars[max(warmup, i - _REPLAY_BARS + 1): i + 1]
                    progress(i - warmup, total, {
                        "equity": round(equity, 2),
                        "peak": round(peak, 2),
                        "equity_curve": _thin(curve, 240),
                        "trades_so_far": len(trades),
                        "recent_trades": trades[-12:],
                        "at": _bar_time(bars[i]),
                        "open_side": (positions[0].get("type") if positions else None),
                        "open_count": len(positions),
                        "replay_bars": [_slim(b) for b in seen],
                        # Where the trades sit on those bars, so they can
                        # be marked rather than merely counted.
                        "marks": self._marks(trades, positions, seen),
                    })
                except TypeError:
                    # An older two-argument reporter. Keep it working.
                    try:
                        progress(i - warmup, total)
                    except Exception:
                        progress = None
                except Exception:
                    progress = None         # a broken reporter must not stop the run
            window = bars[: i + 1]
            bar = bars[i]
            price = float(bar.get("close") or bar.get("c") or 0)
            if price <= 0:
                continue
            # Settle every open trade against this bar before asking the
            # strategy anything. Iterated over a copy, because closing
            # removes from the list being walked.
            for pos in list(positions):
                hit = self._hit(pos, bar)
                if hit:
                    pnl = self._pnl(pos, hit["price"], point_value)
                    equity += pnl
                    risk0 = pos.get("initial_sl") or pos.get("sl")
                    trades.append({
                        **pos,
                        "exit": hit["price"],
                        "profit": pnl,
                        "exit_time": bar.get("time"),
                        "exit_reason": hit["reason"],
                        "risk": abs(pos["entry"] - float(risk0)) * pos["volume"] * point_value if risk0 else 0,
                    })
                    positions.remove(pos)
                else:
                    # Manage the stop the way the live robot manages it.
                    self._manage(pos, bar, manage)
            account = {"equity": equity, "balance": equity, "profit": 0, "currency": "USD"}
            state = brain.infer(window, symbol, timeframe, frame=self._feature_row(feats, i, bars))
            ctx = self._ctx(strategy, symbol, timeframe, window, bar, equity, positions, brain, state)
            signal = strategy.on_candle(ctx)
            if not signal:
                peak = max(peak, equity)
                curve.append(equity)
                continue
            payload = signal.to_dict() if hasattr(signal, "to_dict") else dict(signal)
            action = payload.get("action")
            if action == "close" and positions:
                # A close signal flattens the book, the way it does live.
                for pos in list(positions):
                    pnl = self._pnl(pos, price, point_value)
                    equity += pnl
                    trades.append({**pos, "exit": price, "profit": pnl, "exit_time": bar.get("time"), "exit_reason": payload.get("reason") or "strategy", "risk": self._risk(pos, point_value)})
                positions = []
            elif action in {"buy", "sell"} and len(positions) < cap:
                positions.append({
                    "symbol": symbol,
                    "type": action,
                    "volume": self._entry_volume(payload, volume_mode, manual_volume),
                    "entry": price,
                    "sl": float(payload.get("sl") or 0),
                    # The stop as it was placed. Break-even and trailing
                    # move "sl", and R has to keep meaning what it meant
                    # when the risk was taken.
                    "initial_sl": float(payload.get("sl") or 0),
                    "tp": float(payload.get("tp") or 0),
                    "time": bar.get("time"),
                    "reason": payload.get("reason"),
                })
            peak = max(peak, equity)
            curve.append(equity)
        for pos in list(positions):
            last = float(bars[-1].get("close") or 0)
            pnl = self._pnl(pos, last, point_value)
            equity += pnl
            trades.append({**pos, "exit": last, "profit": pnl, "exit_time": bars[-1].get("time"), "exit_reason": "eod", "risk": self._risk(pos, point_value)})
            curve.append(equity)
        positions = []
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
            # The lot rule this run actually used, for the same reason as
            # `data` above. The replay has honoured the desk's auto/fixed
            # lot setting and its open-trade cap for a while, but the
            # result said nothing about either, so a run under the right
            # rule and a run under the wrong one produced identical
            # output. "It used your settings" is an assertion until the
            # result names them. These are the values in force here, not
            # the ones that were requested, so the 0.1 fallback inside
            # _entry_volume cannot hide behind a reported 0.0.
            "volume_mode": mode,
            "manual_volume": lot,
            "max_open": cap,
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

    def _precompute_features(self, bars: list[dict[str, Any]]):
        """The AI's feature frame for the whole series, built once.

        A replay asks the AI to read every bar in turn. The AI builds its
        feature frame from whatever list it is handed, and the replay was
        handing it bars[:i+1] -- so the frame was rebuilt from the start
        of history on every single bar, and a run cost time proportional
        to the square of its length. Profiled on 500 tested bars of real
        EURUSD M15, that was 48 of 61 seconds.

        It is safe to hoist because every feature is causal: EMAs,
        backward rolling windows and shift(1), with no centred window
        anywhere, so the value on row i is the same whether the frame was
        built from the first i bars or from all of them. infer() reads
        only the last row, so one row is all it needs.

        The rows are matched back to the bars by timestamp rather than by
        position. build_feature_frame drops its own warmup -- the opening
        bars where a rolling indicator is still NaN -- and reindexes, so
        row i of the frame is not bar i. Lining the two up by position
        would hand the AI the features of a different bar, which is the
        kind of mistake that silently improves a backtest.

        Returns None if the bars carry no usable unique timestamps, and
        the caller then falls back to the original per-bar rebuild.
        """
        try:
            frame = build_feature_frame(bars)
        except Exception:
            return None
        if frame is None or frame.empty or "time" not in frame.columns:
            return None
        times = [str(t) for t in frame["time"].tolist()]
        index: dict[str, int] = {}
        for pos, t in enumerate(times):
            if t in index:                  # duplicate stamps: cannot match safely
                return None
            index[t] = pos
        return (frame, index)

    @staticmethod
    def _feature_row(feats, i: int, bars: list[dict[str, Any]] | None = None):
        """The single feature row for bar i, or None to rebuild as before.

        None is returned for the bars whose features were dropped as
        indicator warmup. Those sit before the replay's own warmup, so in
        practice the slow path is never actually taken.
        """
        if not feats or bars is None or i < 0 or i >= len(bars):
            return None
        frame, index = feats
        pos = index.get(str((bars[i] or {}).get("time")))
        if pos is None:
            return None
        return frame.iloc[[pos]]

    def _entry_volume(self, payload: dict[str, Any], mode: str, manual: float) -> float:
        """The lot this entry would actually have been given.

        Mirrors the live robot's rule (runtime/trader.py::_robot_volume):
        manual mode pins every robot trade to the trader's fixed lot,
        auto leaves the strategy's own volume alone. The replay used to
        ignore the setting and fall back to a hard-coded 0.1, so a desk
        set to trade 1.0 lots was shown the profit of a 0.1-lot run.
        """
        if str(mode or "auto") == "manual":
            try:
                fixed = float(manual or 0)
            except (TypeError, ValueError):
                fixed = 0.0
            if fixed > 0:
                return fixed
        try:
            vol = float(payload.get("volume") or 0)
        except (TypeError, ValueError):
            vol = 0.0
        # Last resort only: a strategy that names no size still has to
        # trade something, or the run reports nothing at all.
        return vol if vol > 0 else 0.1

    def _marks(
        self,
        trades: list[dict[str, Any]],
        positions: list[dict[str, Any]],
        window: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Entries and exits that fall inside the bars being sent.

        Filtered to the window rather than sent whole: a long run
        accumulates hundreds of trades and only the ones on screen can
        be drawn. Open positions are included so a trade in progress is
        visible before it has a result.
        """
        if not window:
            return []
        times = {_bar_time(b) for b in window}
        out: list[dict[str, Any]] = []
        for t in trades[-60:]:
            at_in = str(t.get("time") or "")
            if at_in in times:
                out.append({"t": at_in, "kind": "in", "side": t.get("type"),
                            "price": t.get("entry"), "volume": t.get("volume")})
            at_out = str(t.get("exit_time") or "")
            if at_out in times:
                out.append({"t": at_out, "kind": "out", "side": t.get("type"),
                            "price": t.get("exit"), "profit": round(float(t.get("profit") or 0), 2),
                            "reason": t.get("exit_reason")})
        for pos in positions:
            at_in = str(pos.get("time") or "")
            if at_in in times:
                out.append({"t": at_in, "kind": "in", "side": pos.get("type"),
                            "price": pos.get("entry"), "volume": pos.get("volume"), "open": True})
        return out

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
