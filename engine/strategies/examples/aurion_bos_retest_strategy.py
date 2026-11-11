# =============================================================================
# AURION strategy: BOS + Retest (Range-top failure -> break -> retest -> entry)
# EN: Uptrend fails to make a new high, ranges, then breaks the range-low /
#     last higher-low (blue + orange lines), retests the broken level, a
#     rejection candle confirms, then we enter. SL just beyond the level,
#     TP fixed by RR (or structure). Works for SELL and mirrored BUY.
# FA: روند صعودی، ناتوانی در شکستن سقف، رنج، شکست خطوط (آبی و نارنجی)،
#     برگشت به ناحیه شکست، کندل تایید، ورود. استاپ کمی بالاتر از خط،
#     تارگت مشخص. نسخه آینه‌ای (خرید) هم دارد.
# =============================================================================
# Allowed imports only: math, statistics, datetime, collections, typing, json
# =============================================================================
#
# WHAT WAS WRONG WITH THE FIRST VERSION / ایراد نسخه‌ی اول
# --------------------------------------------------------
# It loaded and ran. It passed validate_source, the loader found the class,
# on_candle was called on every bar - and it returned None forever.
#
# 1) THE KILLING BUG, in the "structure lines" step. The blue line was taken
#    as the lowest pivot low ANYWHERE after the peak:
#
#        rng_lows = [i for i in pl if i > peak_i]        # <-- after the peak
#        levels.append(min(l[i] for i in rng_lows))
#        zone = min(levels)
#
#    Pivot lows made AFTER the break - the displacement leg itself, the very
#    move the setup is trying to catch - are "after the peak" too. So every
#    time price broke down, the break dragged the level down with it, and the
#    next step looked for a close below a level the market had already fallen
#    to. It could not be found. Measured over 2 800 decisions of seeded M15
#    data (scripts/strategy-xray.py series, seed 7), "no close below the zone"
#    was the refusal on 1 032 bars on XAUUSD and 851 on EURUSD - by a wide
#    margin the biggest bucket, and a self-inflicted one.
#
#    The range low must be a pivot that formed INSIDE the range, i.e. between
#    the peak and the break. That is a two-pass problem (the level defines the
#    break, the break bounds the level), and it is solved below as two passes:
#    find the break on the last higher-low alone, then tighten the level with
#    the pivots that are strictly before that break, then re-confirm.
#
# 2) It never called self.decline(). A strategy that returns a bare None is
#    undebuggable: ten different refusals look identical from the desk, and
#    the only way to find bug (1) was to re-implement the scan by hand and
#    print each gate. Every exit below now names its bucket, so the desk,
#    the journal, refusal_report() and scripts/strategy-xray.py can say WHICH
#    condition is eating the signals.
#
# 3) The position guard was inverted in practice. ctx.position() returns a
#    DICT, so getattr(pos, "volume", None) was always None, which took the
#    "vol is None" branch and returned None - any open position on the symbol
#    silenced the strategy, and the float(vol) != 0.0 test was dead code.
#
# 4) _g() raised ValueError when a field was missing. Inside on_candle that is
#    a crash, caught upstream as "strategy ... on_candle crashed". Bad data is
#    a refusal, not an exception.
#
# 5) The break was always the FIRST close below the level in the whole
#    lookback. Once that break aged past max_retest_bars the setup was dead
#    for good, even when a fresh, clean break had happened since. It is now
#    the break of the MOST RECENT episode.
#
# =============================================================================

from aurion.strategy.base import BaseStrategy, StrategyContext, StrategySignal


# ----------------------------- helpers ---------------------------------------
def _g(c, name):
    """Read open/high/low/close from an object or dict, or None.

    FA: خواندن قیمت از کندل. اگر فیلد نبود، None برمی‌گرداند (نه خطا).

    The backtester hands dicts with "open"/"high"/"low"/"close", the live
    bridge can hand "o"/"h"/"l"/"c" or a Candle object, so all three spellings
    are tried. Returning None instead of raising matters: a raise inside
    on_candle is logged as a crash, and the strategy is then suspect rather
    than simply short of data.
    """
    for k in (name, name[0], name.capitalize()):
        if isinstance(c, dict):
            if k in c and c[k] is not None:
                try:
                    return float(c[k])
                except (TypeError, ValueError):
                    return None
        else:
            v = getattr(c, k, None)
            if v is not None:
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
    return None


def _pivots(vals, s, kind):
    """Confirmed swing indexes. kind='high' or 'low'. / پیوت‌های تاییدشده

    A pivot is only confirmed once s bars have closed on BOTH sides, so the
    loop stops at n - s. That is deliberate: a swing that still needs future
    bars to be a swing is not tradable information.
    """
    n = len(vals)
    out = []
    for i in range(s, n - s):
        w = vals[i - s:i + s + 1]
        if kind == "high" and vals[i] >= max(w):
            out.append(i)
        elif kind == "low" and vals[i] <= min(w):
            out.append(i)
    return out


def _atr(h, l, c, period):
    """Simple mean of the last `period` true ranges. / میانگین دامنه واقعی

    Sign-invariant by construction (every term is a distance), which is why
    the mirrored BUY pass below can reuse the straight-price ATR.
    """
    trs = []
    for i in range(1, len(c)):
        trs.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    if not trs:
        return 0.0
    trs = trs[-period:]
    return sum(trs) / len(trs)


class MyStrategy(BaseStrategy):
    name = "bos_retest"
    version = "1.1.0"
    language = "fa"  # en | fa | ar

    #: Nothing has been measured out of sample yet, and saying so is the
    #: honest answer. The guard suite (engine/tests/test_bos_retest.py) only
    #: proves the setup is DETECTED on a chart that contains it and refused
    #: on one that does not - that is correctness, not profitability.
    evidence = {
        "state": "unmeasured",
        "basis": "detection verified on a hand-built BOS+retest fixture and on "
                 "2 800 decisions of seeded synthetic M15 (scripts/strategy-xray.py "
                 "series, seed 7); no out-of-sample profitability run, no spread "
                 "or commission modelled",
    }

    params = {
        # --- sizing / حجم ---
        "volume": 0.10,
        "point_size": 0.01,      # XAUUSD 2 digits: 1 point = 0.01
        "sl_points": 0.0,        # >0 => fixed SL distance (points) / استاپ ثابت
        "tp_points": 0.0,        # >0 => fixed TP distance (points) / تارگت ثابت
        "digits": 2,

        # --- direction / جهت ---
        "enable_sell": True,     # reversal from uptrend / برگشت از روند صعودی
        "enable_buy": True,      # mirror setup / حالت آینه‌ای

        # --- structure detection / ساختار ---
        "swing_strength": 3,     # bars each side of a pivot
        "lookback": 150,         # candles scanned for the setup
        "atr_period": 14,
        "min_bars": 60,
        "trend_min_atr": 3.0,    # min size of the prior trend (x ATR)
        "range_min_bars": 5,     # min bars between the top and the break
        "peak_tol_atr": 0.3,     # top may not be exceeded by more than this
        "break_mode": "both",    # both = close below ALL lines | any = highest line
        "min_break_atr": 0.5,    # min displacement below the level after break

        # --- retest + confirmation / برگشت و تایید ---
        "max_retest_bars": 40,   # max candles after break to wait for retest
        "zone_atr": 0.35,        # retest zone half-width (x ATR)
        "require_pattern": True, # pin bar or engulfing rejection
        "pin_wick_ratio": 0.35,  # upper wick / range for pin bar

        # --- stop / target / حد ضرر و تارگت ---
        "sl_mode": "level",      # level = just beyond the line | swing = beyond the top
        "sl_buffer_atr": 0.25,
        "min_risk_atr": 0.4,
        "max_risk_atr": 6.0,
        "tp_mode": "rr",         # rr | structure
        "rr": 2.0,
        "min_rr_structure": 1.2,

        # --- one-shot guard / جلوگیری از تکرار ---
        # A setup is taken once. The key is the peak that defines it, so the
        # same top cannot be sold four bars running. Bounded so a long replay
        # cannot grow the set without limit.
        "memory": 200,
    }

    # Anything over this many bars is trimmed before the scan; the pivot walk
    # is O(bars * swing_strength) and runs on every candle of a backtest.
    _MAX_WINDOW_PAD = 20

    def on_start(self, ctx: StrategyContext) -> None:
        self._used = []
        self._used_set = set()
        return None

    def on_stop(self, ctx: StrategyContext) -> None:
        return None

    def on_tick(self, ctx: StrategyContext) -> StrategySignal | None:
        return None

    # ------------------------------------------------------------- memory
    def _remember(self, key) -> bool:
        """True the first time this setup is seen, False afterwards."""
        if not hasattr(self, "_used_set"):
            self._used = []
            self._used_set = set()
        if key in self._used_set:
            return False
        self._used.append(key)
        self._used_set.add(key)
        cap = max(1, int(self.params["memory"]))
        while len(self._used) > cap:
            self._used_set.discard(self._used.pop(0))
        return True

    # -------------------------------------------------------------------------
    # Core scan, written for the SELL case. BUY runs on negated (mirrored) data.
    # `side` only labels the refusal buckets, so sell-side and buy-side
    # refusals can be told apart in refusal_report().
    # -------------------------------------------------------------------------
    def _scan(self, o, h, l, c, atr, side="sell"):
        P = self.params
        s = int(P["swing_strength"])
        n = len(c)
        k = n - 1
        start = max(0, n - int(P["lookback"]))

        ph = [i for i in _pivots(h, s, "high") if i >= start]
        pl = [i for i in _pivots(l, s, "low") if i >= start]
        if not ph or len(pl) < 2:
            return self.decline(f"{side}: no confirmed structure yet",
                                f"{len(ph)} swing highs, {len(pl)} swing lows")

        # 1) the top that failed to be broken (peak)
        peak_i = max(ph, key=lambda i: h[i])
        peak = h[peak_i]

        # 2) prior uptrend: last two swing lows before the peak make a higher low
        before = [i for i in pl if i < peak_i]
        if len(before) < 2:
            return self.decline(f"{side}: no two swing lows before the top",
                                f"{len(before)} before bar {peak_i}")
        lowA_i, lowZ_i = before[-1], before[-2]  # A = last HL (orange), Z = older
        if not l[lowA_i] > l[lowZ_i]:
            return self.decline(f"{side}: last leg is not a higher low",
                                f"{l[lowA_i]:.5f} <= {l[lowZ_i]:.5f}")
        if peak - l[lowZ_i] < P["trend_min_atr"] * atr:
            return self.decline(f"{side}: prior trend too small",
                                f"{(peak - l[lowZ_i]) / atr:.2f} ATR < "
                                f"{P['trend_min_atr']:.2f}")

        # 3) peak must hold (no real break above it) -> top / range
        after_max = max(h[peak_i + 1:]) if peak_i < k else peak
        if after_max > peak + P["peak_tol_atr"] * atr:
            return self.decline(f"{side}: the top was taken out",
                                f"{(after_max - peak) / atr:.2f} ATR above it")

        # 4) structure lines, pass one: the last higher low (the orange line).
        #    This is the one level that does not depend on where the break is,
        #    so the break is found against it first.
        hl_level = l[lowA_i]
        tol = P["zone_atr"] * atr
        first = peak_i + int(P["range_min_bars"])

        def break_index(level):
            """First close below `level` in the MOST RECENT episode below it.

            Scanning from the left and taking the first break ever seen means
            an old, stale break hides a fresh one and the setup can never come
            back. So: find the last bar that was clearly ABOVE the level, and
            take the first close below it after that.
            """
            last_above = first - 1
            for i in range(first, k):
                if c[i] > level + tol:
                    last_above = i
            for i in range(max(first, last_above + 1), k):
                if c[i] < level:
                    return i
            return None

        b = break_index(hl_level)
        if b is None:
            return self.decline(f"{side}: the last higher low has not broken",
                                f"level {hl_level:.5f}, last close {c[k]:.5f}")

        # 5) structure lines, pass two: the range low (the blue line) is the
        #    lowest pivot low formed INSIDE the range - after the top and
        #    BEFORE the break. A pivot low that belongs to the break leg is
        #    part of the move, not part of the range, and including it was
        #    exactly what made version 1.0.0 silent.
        levels = [hl_level]
        rng_lows = [i for i in pl if peak_i < i < b]
        if rng_lows:
            levels.append(min(l[i] for i in rng_lows))
        if P["break_mode"] == "both":
            zone = min(levels)      # both lines must give way
        else:
            zone = max(levels)      # the nearer line is enough

        # Re-confirm the break against the final (possibly lower) level,
        # without leaving the episode that was just identified.
        if zone < hl_level:
            nb = None
            for i in range(b, k):
                if c[i] < zone:
                    nb = i
                    break
            if nb is None:
                return self.decline(f"{side}: the range low has not broken",
                                    f"zone {zone:.5f}, lowest close "
                                    f"{min(c[b:k]):.5f}")
            b = nb

        age = k - b
        if age < 1:
            return self.decline(f"{side}: the break is this bar", f"age {age}")
        if age > int(P["max_retest_bars"]):
            return self.decline(f"{side}: the break is stale",
                                f"{age} bars > {int(P['max_retest_bars'])}")

        # displacement: price really left the zone after the break
        reach = zone - min(l[b:k])
        if reach < P["min_break_atr"] * atr:
            return self.decline(f"{side}: break without displacement",
                                f"{reach / atr:.2f} ATR < {P['min_break_atr']:.2f}")

        # break must not have failed: no close back above the zone before the
        # retest. Still reachable, because `zone` can be below the level the
        # episode was found on.
        for i in range(b + 1, k):
            if c[i] > zone + tol:
                return self.decline(f"{side}: the break failed",
                                    f"closed back above at bar {i}")

        # 6) retest + rejection on the just-closed candle
        rng = h[k] - l[k]
        if rng <= 0:
            return self.decline(f"{side}: last bar has no range", "high == low")
        if h[k] < zone - tol:
            return self.decline(f"{side}: price has not come back to the zone",
                                f"high {h[k]:.5f} < {zone - tol:.5f}")
        if c[k] >= zone:
            return self.decline(f"{side}: closed back inside the range",
                                f"close {c[k]:.5f} >= zone {zone:.5f}")
        if c[k] >= o[k]:
            return self.decline(f"{side}: retest candle is not a rejection",
                                f"close {c[k]:.5f} >= open {o[k]:.5f}")
        if P["require_pattern"]:
            upper = h[k] - max(o[k], c[k])
            pin = (upper / rng) >= P["pin_wick_ratio"]
            engulf = (k >= 1 and c[k - 1] > o[k - 1]
                      and c[k] < o[k - 1] and o[k] >= c[k - 1])
            if not (pin or engulf):
                return self.decline(f"{side}: no pin bar or engulfing",
                                    f"wick {upper / rng:.2f} < "
                                    f"{P['pin_wick_ratio']:.2f}")

        # 7) stop and target
        entry = c[k]
        base = max(zone + tol, h[k])
        if P["sl_mode"] == "swing":
            base = max(base, peak)
        sl = base + P["sl_buffer_atr"] * atr
        if P["sl_points"] > 0:
            sl = entry + P["sl_points"] * P["point_size"]
        risk = sl - entry
        if risk <= 0:
            return self.decline(f"{side}: stop is on the wrong side of entry",
                                f"entry {entry:.5f}, sl {sl:.5f}")
        if P["sl_points"] <= 0:
            if risk < P["min_risk_atr"] * atr:
                return self.decline(f"{side}: stop too tight",
                                    f"{risk / atr:.2f} ATR < {P['min_risk_atr']:.2f}")
            if risk > P["max_risk_atr"] * atr:
                return self.decline(f"{side}: stop too wide",
                                    f"{risk / atr:.2f} ATR > {P['max_risk_atr']:.2f}")

        tp = entry - P["rr"] * risk
        if P["tp_points"] > 0:
            tp = entry - P["tp_points"] * P["point_size"]
        elif P["tp_mode"] == "structure":
            tgt = min(l[max(0, peak_i - int(P["lookback"])):peak_i + 1])
            if tgt < entry and (entry - tgt) >= P["min_rr_structure"] * risk:
                tp = tgt

        return {"peak": peak, "zone": zone, "sl": sl, "tp": tp, "entry": entry}

    # -------------------------------------------------------------------------
    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        P = self.params
        if not hasattr(self, "_used_set"):
            self._used = []
            self._used_set = set()

        need = int(P["min_bars"])
        if not ctx.candles:
            return self.decline("no candles", "the chart sent nothing")
        if len(ctx.candles) < need:
            return self.decline("not enough history",
                                f"{len(ctx.candles)} bars < {need}")

        # One position at a time. ctx.position() returns a DICT (see
        # StrategyContext.position in aurion/strategy/base.py), so it is read
        # with .get(); getattr() on it is always None and would silence the
        # strategy for good.
        pos = ctx.position()
        if pos:
            try:
                vol = float(pos.get("volume") or 0.0)
            except (TypeError, ValueError):
                vol = 0.0
            if vol != 0.0:
                return self.decline("already in this symbol",
                                    f"{vol:g} lots open")

        cs = list(ctx.candles)[-int(P["lookback"]) - self._MAX_WINDOW_PAD:]
        o = [_g(x, "open") for x in cs]
        h = [_g(x, "high") for x in cs]
        l = [_g(x, "low") for x in cs]
        c = [_g(x, "close") for x in cs]
        if any(v is None for v in o) or any(v is None for v in h) \
                or any(v is None for v in l) or any(v is None for v in c):
            return self.decline("candle is missing a price field",
                                "open/high/low/close could not be read")

        atr = _atr(h, l, c, int(P["atr_period"]))
        if atr <= 0:
            return self.decline("ATR is zero", "flat or malformed candles")

        d = int(P["digits"])

        # ---- SELL: uptrend -> failure -> break down -> retest -> reject ----
        if P["enable_sell"]:
            r = self._scan(o, h, l, c, atr, "sell")
            if r:
                if self._remember(("sell", ctx.symbol, round(r["peak"], 5))):
                    return StrategySignal(
                        action="sell",
                        symbol=ctx.symbol,
                        volume=float(P["volume"]),
                        sl=round(r["sl"], d),
                        tp=round(r["tp"], d),
                        reason="uptrend failed at top, structure broken, retest rejected",
                        comment="AURION bos_retest S",
                    )
                self.decline("sell: this top was already traded",
                             f"peak {r['peak']:.5f}")

        # ---- BUY: mirrored (downtrend -> failure -> break up -> retest) ----
        # Every price is negated and high/low swap, so the SELL logic reads a
        # downtrend as an uptrend. ATR is NOT negated and must not be: it is a
        # mean of distances, so it is identical on the mirrored series.
        if P["enable_buy"]:
            o2 = [-x for x in o]
            h2 = [-x for x in l]
            l2 = [-x for x in h]
            c2 = [-x for x in c]
            r = self._scan(o2, h2, l2, c2, atr, "buy")
            if r:
                if self._remember(("buy", ctx.symbol, round(-r["peak"], 5))):
                    return StrategySignal(
                        action="buy",
                        symbol=ctx.symbol,
                        volume=float(P["volume"]),
                        sl=round(-r["sl"], d),
                        tp=round(-r["tp"], d),
                        reason="downtrend failed at bottom, structure broken, retest rejected",
                        comment="AURION bos_retest B",
                    )
                self.decline("buy: this bottom was already traded",
                             f"low {-r['peak']:.5f}")

        return None
