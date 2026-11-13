# =============================================================================
# AURION strategy template
# EN: Define entry / exit / filters / sizing. The engine hot-reloads this file.
# FA: منطق ورود، خروج، فیلتر و حجم را اینجا بنویسید. موتور فایل را زنده بارگذاری می‌کند.
# AR: عرّف الدخول والخروج والمرشحات والحجم. يعيد المحرك تحميل هذا الملف فوراً.
# =============================================================================
# Allowed imports: math, statistics, datetime, collections, typing, json
# Plus AURION helpers already imported below.
# Forbidden: os, sys, subprocess, socket, network, eval, exec, file deletion.
# =============================================================================
#
# READ THIS FIRST — the four things that make a new strategy go silent.
# این چهار مورد باعث می‌شود استراتژی تازه هیچ سیگنالی ندهد.
#
#   1. RETURN self.decline(...), NEVER A BARE None.
#      A bare `return None` tells the desk nothing. Ten different refusals
#      look identical, and the only way left to find out why your strategy
#      is quiet is to re-write it by hand with print statements. Every exit
#      below names its reason, and the counts show up in the desk, in the
#      journal and in `python3 scripts/strategy-xray.py`.
#      FA: به‌جای None خالی، همیشه self.decline(...) برگردانید تا میز بداند چرا.
#
#   2. ctx.position() RETURNS A DICT, NOT AN OBJECT.
#      Use pos.get("volume"). getattr(pos, "volume", None) is ALWAYS None
#      and will silence the strategy for good.
#      FA: ctx.position() یک دیکشنری است؛ با .get بخوانید نه getattr.
#
#   3. CANDLES ARE DICTS AND THE KEYS VARY.
#      The backtester sends "open"/"high"/"low"/"close"; the live bridge can
#      send "o"/"h"/"l"/"c". Use the price() helper below, which handles
#      both and returns None instead of raising — a raise inside on_candle
#      is logged as "strategy crashed".
#      FA: کلید کندل‌ها فرق می‌کند؛ از تابع price() استفاده کنید.
#
#   4. TEST ON A CHART THAT CONTAINS YOUR SETUP.
#      "It returns None on random data" proves nothing: random data rarely
#      contains a real pattern. Build the pattern by hand and assert that a
#      signal comes out. See engine/tests/test_bos_retest_example.py for a
#      worked example, and engine/strategies/examples/ for a full strategy.
#      FA: روی چارتی تست کنید که واقعاً الگوی شما را دارد.
#
# =============================================================================
#
# THE CONTRACT — what the engine guarantees, and what it expects back.
# قرارداد: موتور چه چیزی تضمین می‌کند و چه انتظاری دارد.
#
# ---- WHEN YOUR CODE RUNS -----------------------------------------------
#   on_start(ctx)   once, when the strategy is armed or the engine boots.
#   on_candle(ctx)  when a real MT5 candle CLOSES. This is the main hook,
#                   and the only one the backtester calls.
#   on_tick(ctx)    on every live price tick. Never called in a backtest,
#                   so logic you put only here cannot be measured.
#   on_stop(ctx)    once, when the strategy is disarmed or replaced.
#
#   All four are optional — the base class provides a no-op. Only the
#   hook that returns a signal needs writing.
#
# ---- WHAT ctx CARRIES ---------------------------------------------------
#   ctx.symbol      str   "XAUUSD"
#   ctx.timeframe   str   "M15"
#   ctx.candles     list  oldest first, CLOSED bars; ctx.candles[-1] is
#                         the bar that just closed. Dicts — see trap 3.
#   ctx.tick        dict or None. Live only; None in a backtest.
#   ctx.account     dict  balance, equity, currency...
#   ctx.positions   list  every open position, all symbols.
#   ctx.orders      list  pending orders.
#   ctx.ai          dict  the AI read for this bar, or {} — see below.
#   ctx.params      dict  the desk's parameters.
#   ctx.now         str   ISO-8601 UTC.
#   ctx.position(symbol=None) -> dict | None
#                         the open position on this symbol. Matches
#                         broker suffixes, so "XAUUSD" finds "XAUUSD.m".
#                         A DICT — see trap 2.
#
#   ctx.ai is {} during a chart replay ON PURPOSE. There is only today's
#   AI read, and applying it to a bar from last Tuesday is look-ahead
#   dressed up as confluence. A strategy that requires AI agreement will
#   therefore show its pure structural setups in a replay.
#
# ---- WHAT YOU RETURN ----------------------------------------------------
#   self.decline(kind, detail)  -> None   you are standing aside
#   StrategySignal(...)                   you want the trade
#
#   StrategySignal fields:
#     action      "buy" | "sell" | "close" | "close_all" | "modify" | "hold"
#     symbol      normally ctx.symbol
#     volume      lots. The desk may override it: in manual lot mode
#                 every robot entry uses the trader's fixed lot, and the
#                 risk engine can size it down to respect a cap.
#     sl, tp      absolute PRICES, not distances. 0.0 means "none".
#     price       0.0 for market. Only set it for a pending order.
#     reason      say why THIS bar qualified. It is shown on the desk,
#                 written to the journal and read back in the backtest
#                 report. "signal" is not a reason.
#     confidence  0.0 - 1.0, optional. The desk can gate on it.
#     comment     broker comment.
#     ticket      only for close/modify of a specific position.
#     extra       dict, carried through untouched.
#
#   Returning a signal does NOT mean a trade. Risk limits, the prop
#   guard, news windows, the single-armed-strategy rule and the money
#   cap can all refuse it afterwards, and the desk shows a signal that
#   was not sent with the reason it was not sent.
#
# ---- VERSION AND COMPATIBILITY -----------------------------------------
#   `name`     must be unique on the desk. It is what the trader sees
#              and what the saved config keys on, so changing it later
#              orphans the old entry and its statistics.
#   `version`  yours, not the product's. Bump it when you change the
#              rules so the journal can tell two runs apart. Nothing in
#              AURION derives its own version from it.
#   `language` "en" | "fa" | "ar" — which language your reason strings
#              are written in, so the desk does not translate them twice.
#   `params`   every tunable, with a default. The desk renders these and
#              passes overrides in; read them from self.params, which is
#              already merged. Add a new key with a default and an older
#              saved config still loads.
#   `evidence` see below. Leave it "unmeasured" until you have numbers.
#   `history_window`
#              how many bars back you actually read, or 0 for "all of
#              them". 0 is the default and is always safe.
#
#              Why it exists: AURION keeps at least thirty days of
#              history on every timeframe, and thirty days of M1 is
#              43 200 bars. A backtest calls on_candle once per bar and
#              hands you ctx.candles each time. If you need everything,
#              you are handed everything, and turning that into a frame
#              on every bar makes the run cost grow with the SQUARE of
#              its length - minutes become a quarter of an hour.
#
#              Declaring a window is a promise, not a hint: the
#              backtester will hand you exactly that many bars and no
#              more. Set it below what your longest indicator needs and
#              that indicator quietly reads a shorter history, which
#              changes your results without any error. Take your longest
#              lookback and leave room - the shipped ema_rsi reads back
#              about 50 bars and declares 1500.
#
#              Leave it 0 if anything you compute scans the whole series
#              (smart_money does, because it resamples the entire frame
#              for a higher-timeframe bias). Correct and slow beats fast
#              and wrong.
#
#              It only affects the backtest. Live, you get whatever the
#              terminal has sent.
#
#   The file name becomes the strategy's file on disk and must be a
#   valid Python identifier: letters, digits and underscore, not
#   starting with a digit. "my strategy.py" and "2024.py" are rejected
#   at upload. These names are reserved: template, base, ema_rsi,
#   price_action, atr_breakout, smart_money, scalp_impulse, king.
#
#   The engine picks the class that implements on_candle or on_tick. If
#   several do, the FIRST ONE IN THE FILE wins — not the first
#   alphabetically. A helper class that merely inherits BaseStrategy is
#   never chosen over one that implements a hook.
#
# ---- WHAT BREAKS, AND HOW -----------------------------------------------
#   A raise inside a hook is caught, logged as "the strategy crashed"
#   and the bar is skipped — it does not stop the engine or the other
#   strategies. But a strategy that raises on every bar is a strategy
#   that never trades, so prefer decline() over letting an exception
#   describe your edge case.
#
#   An import of something forbidden is refused at UPLOAD, not at run
#   time, with the name of the import. The scan is on the source text,
#   so hiding it behind a string does not help and is not supported.
#
#   Editing this file through the desk hot-reloads it in place. The
#   engine does not need restarting; your on_start runs again.
#
# ---- HOW TO KNOW IT WORKS ----------------------------------------------
#   1. Build a chart that contains your setup by hand and assert a
#      signal comes out (trap 4).
#   2. Run it through the real backtester, on this symbol and timeframe.
#      "It fires" and "it makes money" are different claims.
#   3. Only then fill in `evidence`.
#
# =============================================================================

from aurion.strategy.base import BaseStrategy, StrategyContext, StrategySignal


def price(candle, field):
    """Read open/high/low/close from a dict or an object. None if absent.

    FA: خواندن قیمت از کندل؛ اگر نبود None (نه خطا).
    AR: قراءة السعر من الشمعة؛ None إذا لم يوجد.
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


class MyStrategy(BaseStrategy):
    # EN: Unique name shown in the desk.
    # FA: نام یکتایی که در میز دیده می‌شود.
    # AR: الاسم الفريد الذي يظهر في المكتب.
    name = "my_strategy"
    version = "1.0.0"
    language = "en"  # en | fa | ar

    # EN: What has actually been MEASURED about this strategy. Leave the
    #     state "unmeasured" until you have run it out of sample — the desk
    #     shows this to the trader before they switch the robot on, and an
    #     empty claim reads as "this is known to work".
    #     state: measured | negative | unmeasured
    # FA: آنچه واقعاً اندازه‌گیری شده. تا وقتی تست خارج از نمونه نگرفته‌اید
    #     روی unmeasured بماند؛ میز این را به معامله‌گر نشان می‌دهد.
    evidence = {
        "state": "unmeasured",
        "basis": "",
    }

    # EN: How far back this strategy reads. 0 = the whole chart, which is
    #     always correct and is what you want until a backtest over thirty
    #     days of M1 feels slow. Then set it to your longest lookback with
    #     room to spare, and re-run the backtest to confirm the numbers did
    #     not move. If they moved, the window is too short.
    # FA: چند کندل عقب‌تر را می‌خوانید. صفر یعنی کل چارت و همیشه درست است.
    #     فقط اگر بک‌تست کند بود عددی بزرگ‌تر از بلندترین دوره‌ی خود بگذارید
    #     و دوباره بک‌تست بگیرید تا مطمئن شوید نتیجه تغییر نکرده.
    # AR: كم شمعة تقرأ إلى الوراء. صفر يعني الرسم كله وهو الخيار الآمن.
    history_window = 0

    params = {
        "volume": 0.10,  # EN lot size / FA حجم لات / AR حجم اللوت
        "sl_points": 0.0,
        "tp_points": 0.0,
        "min_bars": 60,
    }

    def on_start(self, ctx: StrategyContext) -> None:
        # EN: Reset any state you keep between bars here.
        # FA: هر حالتی که بین کندل‌ها نگه می‌دارید اینجا صفر کنید.
        return None

    def on_stop(self, ctx: StrategyContext) -> None:
        return None

    def on_tick(self, ctx: StrategyContext) -> StrategySignal | None:
        # EN: Called on every live tick. Return None to stand aside.
        # FA: با هر تیک زنده صدا زده می‌شود. برای بی‌عملی None برگردانید.
        # AR: يُستدعى مع كل تيك حي. أرجع None للوقوف جانباً.
        return None

    def on_candle(self, ctx: StrategyContext) -> StrategySignal | None:
        # EN: Called when a real MT5 candle closes.
        # FA: هنگام بسته شدن کندل واقعی متاتریدر فراخوانی می‌شود.
        # AR: يُستدعى عند إغلاق شمعة ميتاتريدر حقيقية.

        # ---- 1. enough history? ----------------------------------------
        need = int(self.params["min_bars"])
        if not ctx.candles:
            return self.decline("no candles", "the chart sent nothing")
        if len(ctx.candles) < need:
            return self.decline("not enough history",
                                f"{len(ctx.candles)} bars < {need}")

        # ---- 2. read the prices (see note 3 at the top) -----------------
        last = ctx.candles[-1]
        close = price(last, "close")
        open_ = price(last, "open")
        high = price(last, "high")
        low = price(last, "low")
        if None in (close, open_, high, low):
            return self.decline("candle is missing a price field",
                                "open/high/low/close could not be read")

        # ---- 3. already in this symbol? (see note 2 at the top) ---------
        pos = ctx.position()          # a DICT or None — never an object
        if pos:
            try:
                volume = float(pos.get("volume") or 0.0)
            except (TypeError, ValueError):
                volume = 0.0
            if volume != 0.0:
                return self.decline("already in this symbol",
                                    f"{volume:g} lots open")

        ai = ctx.ai or {}

        # ---- 4. your conditions ----------------------------------------
        # EN: Replace this with your logic. Give every refusal its own
        #     decline() bucket: the bucket is the stable rule name, the
        #     detail carries the numbers, so the tally aggregates.
        # FA: منطق خود را جایگزین کنید و برای هر رد شدن یک decline بنویسید.
        # AR: استبدل بمنطقك، واجعل لكل رفض سبباً باسم ثابت.
        #
        #   if close < slow_average:
        #       return self.decline("price is below the trend",
        #                           f"{close:.5f} < {slow_average:.5f}")
        #
        _ = high, low, ai
        return self.decline("no setup on this bar", "template has no rules yet")

        # EN: When your conditions DO line up, return a signal instead.
        # FA: وقتی شرط‌ها برقرار شد، به‌جای decline سیگنال برگردانید.
        # return StrategySignal(
        #     action="buy",          # buy | sell | close | close_all | modify | hold
        #     symbol=ctx.symbol,
        #     volume=float(self.params["volume"]),
        #     sl=0.0,
        #     tp=0.0,
        #     reason="describe why this live bar qualifies",
        #     comment="AURION my_strategy",
        # )
