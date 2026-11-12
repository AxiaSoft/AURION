# =============================================================================
# AURION strategy: ICT liquidity sweep -> displacement -> FVG retrace
# EN: Price runs the stops above a swing high (or below a swing low), fails,
#     reverses with one displacement leg that leaves a Fair Value Gap behind
#     it, then retraces into that gap. We enter there. Stop goes beyond the
#     wick that took the liquidity; target is a multiple of the risk.
# FA: قیمت نقدینگی بالای یک سقف (یا زیر یک کف) را می‌زند، شکست می‌خورد، با یک
#     حرکت قدرتمند برمی‌گردد و پشت سرش یک «شکاف ارزش منصفانه» جا می‌گذارد،
#     سپس به همان شکاف برمی‌گردد. ورود همان‌جاست. استاپ بالای فتیله‌ای که
#     نقدینگی را برداشت، و تارگت ضریبی از ریسک.
# AR: يكنس السعر السيولة فوق قمة (أو تحت قاع)، يفشل، ينعكس بحركة اندفاعية
#     تترك فجوة قيمة عادلة، ثم يعود إليها. الدخول هناك.
# =============================================================================
# Allowed imports only: math, statistics, datetime, collections, typing, json
# This file imports nothing but the AURION base class.
# =============================================================================
#
# WHY THIS FILE EXISTS / چرا این فایل هست
# ----------------------------------------
# It is a second, independent ICT strategy, written to be dropped straight
# onto a desk and switched on. It deliberately shares no code with
# aurion_bos_retest_strategy.py so that the two can be compared, and it was
# written against the four traps named at the top of template.py:
#
#   1. Every exit calls self.decline(bucket, detail). Not one bare `return
#      None` in the file. When it is quiet, the desk and
#      scripts/strategy-xray.py can say WHICH gate is eating the bars.
#   2. ctx.position() is read with .get(), never getattr - it is a dict.
#   3. Candles are read through _px(), which accepts "open"/"o"/"Open" and
#      returns None instead of raising. The backtester and the live bridge
#      do not agree on key names.
#   4. It was tested on a chart that actually contains the setup, built by
#      hand, and then run through the real Backtester. "It returns None on
#      random data" would have proved nothing.
#
# WHAT IT IS NOT / آنچه نیست
# ---------------------------
# evidence.state is "unmeasured" and must stay that way until somebody runs
# it out of sample on their own instrument. It is known to FIRE and known to
# TRADE - that is tested - and that is a completely different claim from
# knowing it makes money. The desk shows this line to the trader before they
# arm the robot, and filling it in with a number nobody measured is the one
# thing this file must not do.
#
# THE SETUP, BAR BY BAR / ساختار معامله
# --------------------------------------
# For a SELL (mirrored for a BUY):
#
#   1. SWING: a pivot high at index p, higher than `pivot` bars either side.
#      That high is where stops sit. In ICT terms it is buy-side liquidity.
#   2. SWEEP: a later bar whose HIGH trades through that pivot high but whose
#      CLOSE comes back below it. The stops were taken and the move failed.
#      A close above it is not a sweep - that is a breakout, and this
#      strategy stands aside for it by name.
#   3. DISPLACEMENT + FVG: within `displace_bars` after the sweep, three
#      consecutive bars (a, b, c) where c.high < a.low. The untouched space
#      between a.low and c.high is the Fair Value Gap. The middle bar is the
#      displacement leg. The gap must be at least `min_gap_atr` x ATR, or it
#      is noise rather than an imbalance.
#   4. RETRACE: a later bar trades back up INTO the gap (high >= gap bottom)
#      without closing above the top of it. Price has returned to the
#      imbalance and has not invalidated it.
#   5. ENTRY: that bar closes bearish (close < open). Stop goes above the
#      sweep wick plus a buffer; target is `rr` times the distance.
#
# Everything is measured off CLOSED bars. ctx.candles[-1] is the bar that has
# just closed, and no decision here reads anything that would not have been
# on the screen at that moment.
#
# =============================================================================

from aurion.strategy.base import BaseStrategy, StrategyContext, StrategySignal


# ----------------------------- helpers ---------------------------------------
def _px(candle, field):
    """One price off one candle, or None.

    The backtester sends {"open","high","low","close"}; the live bridge can
    send {"o","h","l","c"}; a replayed bar can carry capitalised keys. A
    strategy that reads candle["close"] works in a backtest and is silent
    live, which is the single most expensive bug in this whole file.

    Returns None rather than raising. A raise inside on_candle is reported
    as "the strategy crashed" and takes the robot off the chart; bad data is
    a refusal, not an exception.

    FA: خواندن یک قیمت از کندل؛ اگر نبود None (نه خطا).
    """
    for key in (field, field[0], field.capitalize()):
        if isinstance(candle, dict):
            if key in candle and candle[key] is not None:
                try:
                    return float(candle[key])
                except (TypeError, ValueError):
                    return None
        else:
            value = getattr(candle, key, None)
            if value is not None:
                try:
                    return float(value)
                except (TypeError, ValueError):
                    return None
    return None


def _ohlc(candles):
    """Four parallel lists, or None if any bar is unreadable.

    Done once per call instead of per access: the scan below touches the
    same bars many times and _px is not free.
    """
    o, h, l, c = [], [], [], []
    for bar in candles:
        bo = _px(bar, "open")
        bh = _px(bar, "high")
        bl = _px(bar, "low")
        bc = _px(bar, "close")
        if None in (bo, bh, bl, bc):
            return None
        o.append(bo)
        h.append(bh)
        l.append(bl)
        c.append(bc)
    return o, h, l, c


def _atr(h, l, c, length):
    """Average true range over the last `length` closed bars.

    Plain arithmetic mean of the true ranges - not Wilder's - because the
    only thing it is used for here is scaling two thresholds, and a
    difference in smoothing would be lost inside the parameters anyway.
    """
    if len(c) < length + 1:
        return None
    total = 0.0
    for i in range(len(c) - length, len(c)):
        prev = c[i - 1]
        total += max(h[i] - l[i], abs(h[i] - prev), abs(l[i] - prev))
    atr = total / float(length)
    return atr if atr > 0 else None


def _pivot_highs(h, left, right):
    """Indices of bars higher than `left` before and `right` after.

    Strictly greater on both sides, so a flat double top does not register
    twice. The last `right` bars can never qualify - their right-hand side
    has not happened yet - and that is correct: a pivot is only a pivot in
    hindsight, and pretending otherwise is look-ahead.
    """
    out = []
    for i in range(left, len(h) - right):
        v = h[i]
        if all(v > h[j] for j in range(i - left, i)) and all(v > h[j] for j in range(i + 1, i + right + 1)):
            out.append(i)
    return out


def _pivot_lows(l, left, right):
    out = []
    for i in range(left, len(l) - right):
        v = l[i]
        if all(v < l[j] for j in range(i - left, i)) and all(v < l[j] for j in range(i + 1, i + right + 1)):
            out.append(i)
    return out


class MyStrategy(BaseStrategy):
    """ICT: liquidity sweep, displacement, fair-value-gap retrace."""

    name = "ict_fvg_sweep"
    version = "1.0.0"
    language = "en"

    #: Measured: it fires, and it trades through the real Backtester on a
    #: chart containing the pattern. NOT measured: whether it is
    #: profitable on anybody's instrument. Those are different claims and
    #: the desk shows this one to the trader before they arm the robot.
    evidence = {
        "state": "unmeasured",
        "basis": (
            "Verified to produce signals on a hand-built chart and to open and "
            "close trades in the AURION backtester. No out-of-sample profit test "
            "has been run - do your own before trading it with money."
        ),
    }

    params = {
        # --- sizing -----------------------------------------------------
        "volume": 0.10,        # lots / حجم
        "rr": 2.0,             # target = rr x risk / نسبت سود به ضرر
        # --- structure --------------------------------------------------
        "pivot": 2,            # bars either side of a swing / کندل‌های دو طرف پیوت
        "lookback": 120,       # bars scanned for a setup / عمق جست‌وجو
        "displace_bars": 6,    # max bars from sweep to the gap / فاصله تا شکاف
        "max_retrace_bars": 20,  # how long a gap stays valid / عمر شکاف
        # --- quality ----------------------------------------------------
        "atr_len": 14,
        "min_gap_atr": 0.12,   # gap must be this x ATR / حداقل اندازه شکاف
        "min_sweep_atr": 0.05,  # wick must clear the high by this x ATR
        "sl_buffer_atr": 0.20,  # stop sits this x ATR beyond the wick
        "min_bars": 60,
        # --- direction --------------------------------------------------
        "allow_buy": True,
        "allow_sell": True,
    }

    # Deliberately not a parameter: two identical signals from one setup
    # are one trade and one duplicate. The key is the setup's own
    # coordinates, so the same gap cannot be taken twice while a different
    # one on the same bar still can.
    _MAX_MEMORY = 200

    def on_start(self, ctx: StrategyContext) -> None:
        self._taken = []
        return None

    def on_stop(self, ctx: StrategyContext) -> None:
        return None

    def _remember(self, key) -> bool:
        """True if this exact setup has already been signalled."""
        taken = getattr(self, "_taken", None)
        if taken is None:
            taken = self._taken = []
        if key in taken:
            return True
        taken.append(key)
        if len(taken) > self._MAX_MEMORY:
            del taken[: len(taken) - self._MAX_MEMORY]
        return False

    # ------------------------------------------------------------------
    # The scan. One direction at a time so the two are genuinely mirrored
    # rather than one being an afterthought with the comparisons flipped.
    # Returns (setup_dict, None) or (None, refusal_tuple).
    # ------------------------------------------------------------------
    def _scan_sell(self, o, h, l, c, atr, start):
        p = int(self.params["pivot"])
        displace = int(self.params["displace_bars"])
        max_retrace = int(self.params["max_retrace_bars"])
        min_gap = float(self.params["min_gap_atr"]) * atr
        min_sweep = float(self.params["min_sweep_atr"]) * atr
        last = len(c) - 1

        highs = [i for i in _pivot_highs(h, p, p) if i >= start]
        if not highs:
            return None, (0, "no swing high to run", f"{len(c) - start} bars scanned")

        # Newest pivot first: the most recent liquidity is the liquidity
        # the market is actually hunting.
        for pi in reversed(highs):
            level = h[pi]

            # --- 2. the sweep ------------------------------------------
            sweep_i = None
            for i in range(pi + 1, last + 1):
                if h[i] > level + min_sweep and c[i] < level:
                    sweep_i = i
                    break
                if c[i] > level:
                    # Closed above: this is a breakout, not a failed raid.
                    # The level is spent either way, so stop walking it.
                    break
            if sweep_i is None:
                continue

            # --- 3. displacement leaving a fair value gap --------------
            # Bearish FVG: three bars a,b,c with c.high < a.low. The space
            # between is price that was never offered on the way down.
            gap_top = gap_bot = None
            gap_i = None
            for a in range(sweep_i, min(sweep_i + displace, last - 1)):
                cc = a + 2
                if cc > last:
                    break
                if h[cc] < l[a]:
                    size = l[a] - h[cc]
                    if size >= min_gap:
                        gap_top, gap_bot, gap_i = l[a], h[cc], cc
                        break
            if gap_i is None:
                continue

            # --- 4. retrace back into the gap, without invalidating it --
            entry_i = None
            for i in range(gap_i + 1, last + 1):
                if i - gap_i > max_retrace:
                    break
                if c[i] > gap_top:
                    # Closed back above the imbalance: the idea is wrong.
                    break
                if h[i] >= gap_bot:
                    entry_i = i
                    break
            if entry_i is None:
                continue

            # The entry has to be THIS bar. A setup that completed ten bars
            # ago is history, and acting on it now would be entering at a
            # price that no longer exists.
            if entry_i != last:
                continue

            # --- 5. confirmation ---------------------------------------
            if c[last] >= o[last]:
                return None, (2, "no bearish confirmation on the retrace",
                              f"close {c[last]:.5f} >= open {o[last]:.5f}")

            return {
                "side": "sell",
                "pivot_i": pi,
                "level": level,
                "sweep_i": sweep_i,
                "sweep_extreme": h[sweep_i],
                "gap_top": gap_top,
                "gap_bot": gap_bot,
            }, None

        return None, (1, "no swept high with a gap behind it", f"{len(highs)} swing high(s) checked")

    def _scan_buy(self, o, h, l, c, atr, start):
        p = int(self.params["pivot"])
        displace = int(self.params["displace_bars"])
        max_retrace = int(self.params["max_retrace_bars"])
        min_gap = float(self.params["min_gap_atr"]) * atr
        min_sweep = float(self.params["min_sweep_atr"]) * atr
        last = len(c) - 1

        lows = [i for i in _pivot_lows(l, p, p) if i >= start]
        if not lows:
            return None, (0, "no swing low to run", f"{len(c) - start} bars scanned")

        for pi in reversed(lows):
            level = l[pi]

            sweep_i = None
            for i in range(pi + 1, last + 1):
                if l[i] < level - min_sweep and c[i] > level:
                    sweep_i = i
                    break
                if c[i] < level:
                    break
            if sweep_i is None:
                continue

            # Bullish FVG: c.low > a.high.
            gap_top = gap_bot = None
            gap_i = None
            for a in range(sweep_i, min(sweep_i + displace, last - 1)):
                cc = a + 2
                if cc > last:
                    break
                if l[cc] > h[a]:
                    size = l[cc] - h[a]
                    if size >= min_gap:
                        gap_bot, gap_top, gap_i = h[a], l[cc], cc
                        break
            if gap_i is None:
                continue

            entry_i = None
            for i in range(gap_i + 1, last + 1):
                if i - gap_i > max_retrace:
                    break
                if c[i] < gap_bot:
                    break
                if l[i] <= gap_top:
                    entry_i = i
                    break
            if entry_i is None:
                continue
            if entry_i != last:
                continue

            if c[last] <= o[last]:
                return None, (2, "no bullish confirmation on the retrace",
                              f"close {c[last]:.5f} <= open {o[last]:.5f}")

            return {
                "side": "buy",
                "pivot_i": pi,
                "level": level,
                "sweep_i": sweep_i,
                "sweep_extreme": l[sweep_i],
                "gap_top": gap_top,
                "gap_bot": gap_bot,
            }, None

        return None, (1, "no swept low with a gap behind it", f"{len(lows)} swing low(s) checked")

    # ------------------------------------------------------------------
    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        # ---- enough history? ------------------------------------------
        if not ctx.candles:
            return self.decline("no candles", "the chart sent nothing")
        need = int(self.params["min_bars"])
        if len(ctx.candles) < need:
            return self.decline("not enough history", f"{len(ctx.candles)} bars < {need}")

        # ---- already in this symbol? (ctx.position() is a DICT) -------
        pos = ctx.position()
        if pos:
            try:
                volume = float(pos.get("volume") or 0.0)
            except (TypeError, ValueError):
                volume = 0.0
            if volume != 0.0:
                return self.decline("already in this symbol", f"{volume:g} lots open")

        # ---- read the bars once ---------------------------------------
        # Only the window that can matter: a pivot cannot be used if the
        # whole setup after it would fall outside the lookback anyway, and
        # scanning 1500 bars to find a pattern that must end on the last
        # one is wasted work on every single tick.
        lookback = int(self.params["lookback"])
        window = ctx.candles[-(lookback + int(self.params["atr_len"]) + 2):]
        read = _ohlc(window)
        if read is None:
            return self.decline("candle is missing a price field",
                                "open/high/low/close could not be read")
        o, h, l, c = read

        atr = _atr(h, l, c, int(self.params["atr_len"]))
        if atr is None:
            return self.decline("no ATR", "the market has not moved in the ATR window")

        # Pivots need `pivot` bars of room on the left.
        start = int(self.params["pivot"])

        # ---- scan both directions --------------------------------------
        setup = None
        refusals = []
        if bool(self.params["allow_sell"]):
            setup, why = self._scan_sell(o, h, l, c, atr, start)
            if setup is None and why:
                refusals.append(why)
        if setup is None and bool(self.params["allow_buy"]):
            setup, why = self._scan_buy(o, h, l, c, atr, start)
            if setup is None and why:
                refusals.append(why)

        if setup is None:
            if not refusals:
                return self.decline("both directions are switched off",
                                    "allow_buy and allow_sell are both false")
            # Report the direction that got FURTHEST, not whichever ran
            # first. Taking refusals[0] meant the sell scan's generic "I
            # found nothing" always won, and a buy setup that reached the
            # confirmation gate and failed it by one tick was never
            # mentioned - the tally said the strategy had seen nothing all
            # day when in fact it had seen and rejected a dozen. Ranked:
            # 0 = no structure at all, 1 = structure but no completed
            # setup, 2 = a full setup that the last bar did not confirm.
            rank, kind, detail = max(refusals, key=lambda r: r[0])
            return self.decline(kind, detail)

        # ---- one signal per setup --------------------------------------
        key = (setup["side"], setup["pivot_i"], setup["sweep_i"], round(setup["gap_bot"], 8))
        if self._remember(key):
            return self.decline("this setup was already taken",
                                f"{setup['side']} at the gap below {setup['gap_top']:.5f}")

        # ---- stop, target, sanity --------------------------------------
        buffer_ = float(self.params["sl_buffer_atr"]) * atr
        entry = c[-1]
        if setup["side"] == "sell":
            sl = setup["sweep_extreme"] + buffer_
            risk = sl - entry
        else:
            sl = setup["sweep_extreme"] - buffer_
            risk = entry - sl

        if risk <= 0:
            # Possible when the retrace has already run past the stop.
            # Taking it anyway would be a trade whose stop is the wrong
            # side of its entry.
            return self.decline("the stop is on the wrong side of the entry",
                                f"entry {entry:.5f}, stop {sl:.5f}")

        rr = float(self.params["rr"])
        tp = entry - risk * rr if setup["side"] == "sell" else entry + risk * rr

        self.accepted()
        side = setup["side"]
        return StrategySignal(
            action=side,
            symbol=ctx.symbol,
            volume=float(self.params["volume"]),
            sl=round(sl, 8),
            tp=round(tp, 8),
            confidence=0.6,
            reason=(
                f"{side}: swept the {'high' if side == 'sell' else 'low'} at "
                f"{setup['level']:.5f}, displaced away leaving a gap "
                f"{setup['gap_bot']:.5f}-{setup['gap_top']:.5f}, price retraced into it "
                f"and this bar confirmed; risk {risk:.5f}, target {rr:g}R"
            ),
            comment="AURION ict_fvg_sweep",
        )
