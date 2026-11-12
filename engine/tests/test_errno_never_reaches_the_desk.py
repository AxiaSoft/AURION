"""No errno may reach a trader's screen, by any route.

A customer reported the same message three times, months apart, from
three different strategies - the last of them a strategy written for
them from the template and verified end to end:

    [Errno 2] No such file or directory:
      'C:\\Users\\...\\AURION\\engine\\strategies\\aurion_ict_fvg_sweep'

The joins that lost the ".py" were fixed, the loader was made to answer
with a sentence, and a net was put under the strategy endpoints. The
message still came back, because the net was inside api/server.py and
only covered answers that left through those endpoints.

A backtest does not leave through them. `trader.backtest()` builds its
result deep inside the trader and the desk receives it over the
websocket, so every `str(exc)` on that path went to the screen exactly
as Python produced it - including an errno, including a path nobody
typed, and with no build fingerprint to say which code produced it.

These tests pin the net at the level it now lives: a util both the
endpoints and the trader use, plus the two trader exits that were
bypassing it.
"""

from __future__ import annotations

import asyncio

import pytest

from aurion.util.errors import readable_error, readable_result

WINDOWS_ERRNO2 = (
    "[Errno 2] No such file or directory: "
    "'C:\\\\Users\\\\Aryan\\\\AppData\\\\Local\\\\Programs\\\\AURION"
    "\\\\engine\\\\strategies\\\\aurion_ict_fvg_sweep'"
)


# ------------------------------------------------------------ the sanitiser


def test_the_customers_exact_message_is_translated():
    out = readable_error(WINDOWS_ERRNO2)
    assert "Errno" not in out
    assert "C:\\" not in out
    assert "aurion_ict_fvg_sweep" in out, "it must still say which strategy"


def test_it_names_the_file_not_the_whole_windows_path():
    """A basename of "C:\\...\\name" helps nobody."""
    out = readable_error(WINDOWS_ERRNO2)
    assert "AppData" not in out
    assert "Programs" not in out


def test_a_posix_path_is_split_by_posix_rules():
    out = readable_error("[Errno 2] No such file or directory: '/opt/aurion/strategies/mine.py'")
    assert "mine.py" in out
    assert "/opt" not in out


def test_permission_denied_says_so():
    out = readable_error("[Errno 13] Permission denied: '/x/mine.py'")
    assert "permission" in out.lower()
    assert "Errno" not in out


def test_a_directory_says_so():
    out = readable_error("[Errno 21] Is a directory: '/x/mine'")
    assert "folder" in out
    assert "Errno" not in out


def test_an_unknown_errno_is_still_stripped():
    out = readable_error("[Errno 28] No space left on device: '/x/mine.py'")
    assert "[Errno" not in out
    assert "28" in out, "the number is still worth reporting, just not as an errno blob"


def test_a_sentence_passes_through_untouched():
    """It must not mangle the loader's own, already-good messages."""
    good = "no strategy called 'x' — available: ema_rsi, price_action"
    assert readable_error(good) == good


def test_it_survives_junk():
    for junk in (None, "", 0, [], {}):
        assert isinstance(readable_error(junk), str)


def test_readable_result_only_touches_failures():
    ok = {"ok": True, "error": WINDOWS_ERRNO2}
    assert readable_result(ok) is ok, "a success must not be rewritten"
    bad = readable_result({"ok": False, "error": WINDOWS_ERRNO2})
    assert "Errno" not in bad["error"]
    for other in (None, "x", 5, []):
        assert readable_result(other) is other


# ------------------------------------------------- the routes that bypassed it


def _trader():
    """A trader with only the attributes these two exits touch."""
    from aurion.runtime.trader import Trader

    t = Trader.__new__(Trader)
    t.book = {}
    t.backtest_run = None
    t.active_symbol = "XAUUSD"
    t.active_timeframe = "M15"
    return t


def test_the_backtest_endpoint_is_not_the_only_net():
    """The result travels over the socket, so the trader must sanitise.

    Pinning this at the endpoint instead would pass while the desk still
    received the raw text, which is exactly how this survived two fixes.
    """
    import inspect

    from aurion.runtime import trader as trader_mod

    src = inspect.getsource(trader_mod.Trader.backtest)
    assert "readable_error" in src, "backtest builds its own result; it must clean it"
    assert 'error": str(exc)' not in src, "a raw exception string is back on the backtest path"


def test_the_chart_replay_exit_is_covered_too():
    import inspect

    from aurion.runtime import trader as trader_mod

    name = "chart_signals" if hasattr(trader_mod.Trader, "chart_signals") else None
    src = inspect.getsource(trader_mod.Trader)
    marker = 'return {"ok": False, "error": str(exc)}'
    assert marker not in src, "an exit on the strategy path still returns a raw exception"


def test_a_failed_backtest_carries_the_build_fingerprint():
    """"This is not the code you shipped" has to be visible in the message."""
    import inspect

    from aurion.runtime import trader as trader_mod

    src = inspect.getsource(trader_mod.Trader.backtest)
    assert "BUILD_ID" in src


def test_the_server_delegates_to_the_shared_net():
    """Two copies of this logic is how one of them stays unfixed."""
    import inspect

    from aurion.api import server

    src = inspect.getsource(server._readable_error)
    assert "readable_error(text)" in src
    assert "Errno" not in src.split('"""')[-1], "the regex should live in the util, not here"


def test_the_endpoint_wrapper_still_cleans_and_stamps():
    from aurion.api import server

    out = server._strategy_reply({"ok": False, "error": WINDOWS_ERRNO2})
    assert "Errno" not in out["error"]
    assert out.get("build_id")


# ------------------------------------------------------- the stale fault card


def test_a_fault_recorded_with_the_suffix_can_be_cleared():
    """Why the same message appeared to come back after it was fixed.

    _note_strategy_fault keyed on the name it was given and
    _clear_strategy_fault stripped ".py" before looking it up, so a
    fault noted against "x.py" - how older runtime configs key their
    saved strategies - was unreachable forever. The card sat on the desk
    with its original text long after the strategy loaded fine.
    """
    t = _trader()
    t.strategy_faults = {}
    t._note_strategy_fault("aurion_ict_fvg_sweep.py", FileNotFoundError(2, "No such file"))
    assert t.strategy_faults, "the fault was not recorded at all"
    t._clear_strategy_fault("aurion_ict_fvg_sweep")
    assert t.strategy_faults == {}, "a loading strategy still shows a stale error card"


def test_clearing_works_both_ways_round():
    t = _trader()
    t.strategy_faults = {}
    t._note_strategy_fault("mine", FileNotFoundError(2, "No such file"))
    t._clear_strategy_fault("mine.py")
    assert t.strategy_faults == {}


def test_a_validation_error_is_stored_without_a_type_prefix():
    """The trader should read the sentence, not "StrategyValidationError:"."""
    from aurion.strategy.loader import StrategyValidationError

    t = _trader()
    t.strategy_faults = {}
    t._note_strategy_fault("mine", StrategyValidationError("no strategy called 'mine'"))
    assert t.strategy_faults["mine"]["error"] == "no strategy called 'mine'"
