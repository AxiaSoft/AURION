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
