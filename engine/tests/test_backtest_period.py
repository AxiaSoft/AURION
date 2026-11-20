"""Backtesting a chosen period, and reporting trades in pips.

Three reported problems meet here.

ONE. "I want to pick a past month, a week or a day from the calendar
and test it." Until now the only testable period was "every bar the
engine holds", which at the new six-month window is 259 200 M1 bars.

TWO. "The equity curve changes when the run finishes and disagrees with
what it showed while running." It did: the live panel published the
whole run evenly thinned, and the result published the last 500 points.
Two different series describing the same run, swapped at the hand-over.

THREE. "Show me the volume and the pips per trade." The trade list had
money only, which mixes distance with lot size.

Run:
    python3 -m pytest engine/tests/test_backtest_period.py -q
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aurion.backtest import engine as bt_engine  # noqa: E402
from aurion.runtime.trader import RANGE_WARMUP_BARS, _slice_bars  # noqa: E402


# --------------------------------------------------------------- helpers


def _bars(days: int, start: str = "2026-01-01", hours_step: int = 1) -> list[dict[str, Any]]:
    """Hourly bars, so a day is a handful and a month is hundreds."""
    begin = dt.datetime.fromisoformat(start)
    out = []
    for i in range((days * 24) // hours_step):
        when = begin + dt.timedelta(hours=i * hours_step)
        price = 1.1000 + (i % 40) * 0.0001
        out.append({
            "time": when.isoformat() + "Z",
            "open": price, "high": price + 0.0005,
            "low": price - 0.0005, "close": price,
        })
    return out


def _code(module: Any) -> str:
    """A module's source with comments and docstrings removed.

    Searching raw source for a broken expression finds the comment that
    explains why it was removed. That is how a guard ends up reporting
    a fixed bug as still present, permanently.
    """
    import io
    import tokenize

    raw = Path(module.__file__).read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)
    kill: list[tuple[int, int, int, int]] = []
    prev = tokenize.INDENT
    for tok in tokenize.generate_tokens(io.StringIO(raw).readline):
        drop = tok.type == tokenize.COMMENT or (
            tok.type == tokenize.STRING
            and prev in (tokenize.INDENT, tokenize.NEWLINE, tokenize.NL, tokenize.DEDENT)
        )
        if drop:
            kill.append((tok.start[0], tok.start[1], tok.end[0], tok.end[1]))
        if tok.type not in (tokenize.NL, tokenize.COMMENT):
            prev = tok.type
    # Blanked in place rather than deleted, so every other character
    # keeps its position and a multi-token expression is still one
    # searchable string.
    for r1, c1, r2, c2 in reversed(kill):
        for row in range(r1, r2 + 1):
            line = lines[row - 1]
            a = c1 if row == r1 else 0
            b = c2 if row == r2 else len(line.rstrip("\n"))
            lines[row - 1] = line[:a] + " " * (b - a) + line[b:]
    return "".join(lines)


def _days(bars: list[dict[str, Any]]) -> set[str]:
    # .get, not [], because one of the checks below deliberately feeds a
    # bar with no timestamp through the slicer.
    return {str(b.get("time", ""))[:10] for b in bars if b.get("time")}


# ------------------------------------------------- picking a period


def test_no_bounds_means_everything() -> None:
    """The unbounded run must stay exactly as it was.

    Adding a period picker must not quietly change what happens when no
    period is picked - that is every existing caller.
    """
    bars = _bars(40)
    got = _slice_bars(bars, "", "")
    assert got["bars"] is bars
    assert "error" not in got


@pytest.mark.parametrize(
    "lo,hi,expect_days",
    [
        ("2026-02-10", "2026-02-10", 1),    # one day
        ("2026-02-09", "2026-02-15", 7),    # one week
        ("2026-02-01", "2026-02-28", 28),   # one month
    ],
)
def test_a_day_a_week_and_a_month_can_each_be_asked_for(lo: str, hi: str, expect_days: int) -> None:
    bars = _bars(120)
    got = _slice_bars(bars, lo, hi)
    assert not got.get("error")
    # The period is reported back as what was actually covered, so the
    # desk titles the run with the bars that existed rather than the
    # dates that were asked for.
    assert got["from"] == lo
    assert got["to"] == hi
    # Every day of the period is present, and the run-up before it, and
    # nothing after it.
    inside = {d for d in _days(got["bars"]) if lo <= d <= hi}
    assert len(inside) == expect_days
    assert max(_days(got["bars"])) == hi


def test_the_end_date_is_included() -> None:
    """A trader who picks the 10th means the whole of the 10th.

    An exclusive end would silently drop the last day of every month,
    week and day asked for - and on a one-day request would leave
    nothing at all.
    """
    bars = _bars(60)
    got = _slice_bars(bars, "2026-02-10", "2026-02-10")
    assert "2026-02-10" in _days(got["bars"])
    assert len([b for b in got["bars"] if str(b["time"])[:10] == "2026-02-10"]) == 24


def test_run_up_is_supplied_before_the_period_and_is_declared() -> None:
    """Indicators must arrive primed, and the count must be honest.

    The replay discards its first `warmup` bars without trading them.
    A slice that began exactly at the chosen date would therefore spend
    the start of the period warming up - on a one-day run, the entire
    day. So the bars BEFORE the period are handed over too.

    They are counted and reported, because "1144 bars tested" must not
    be read as "1144 bars in the month you picked".
    """
    bars = _bars(200)
    got = _slice_bars(bars, "2026-04-01", "2026-04-30")
    assert got["warmup"] == RANGE_WARMUP_BARS
    assert len(got["bars"]) > RANGE_WARMUP_BARS
    before = sorted(_days(got["bars"]))[0]
    assert before < "2026-04-01", "no run-up was supplied"


def test_run_up_is_capped_by_the_history_that_exists() -> None:
    """A period at the very start of history is still answerable."""
    bars = _bars(40)
    got = _slice_bars(bars, "2026-01-01", "2026-01-03")
    assert not got.get("error")
    assert got["warmup"] == 0
    assert got["bars"][0] is bars[0]


def test_an_empty_period_is_an_answer_not_a_crash_and_not_a_widening() -> None:
    """The two wrong behaviours are both worse than the error.

    Widening to the whole history would replay six months when one week
    was asked for and report it as that week. Raising would look like a
    broken engine when the real answer is "there are no bars there".
    """
    bars = _bars(30)
    got = _slice_bars(bars, "2019-05-01", "2019-05-07")
    assert got["error"] == "no bars in that period"
    assert got["bars"] == []


def test_a_bar_with_no_timestamp_cannot_sink_the_request() -> None:
    bars = _bars(30)
    bars.insert(5, {"open": 1, "high": 1, "low": 1, "close": 1})
    got = _slice_bars(bars, "2026-01-10", "2026-01-12")
    assert not got.get("error")
    assert len(_days(got["bars"]) & {"2026-01-10", "2026-01-11", "2026-01-12"}) == 3


def test_a_full_iso_timestamp_is_accepted_as_a_bound() -> None:
    """The desk sends YYYY-MM-DD, but a caller may send more."""
    bars = _bars(60)
    plain = _slice_bars(bars, "2026-02-03", "2026-02-05")
    iso = _slice_bars(bars, "2026-02-03T00:00:00Z", "2026-02-05T23:59:59Z")
    assert _days(iso["bars"]) == _days(plain["bars"])


# ------------------------------------------- one equity curve, not two


def test_the_live_curve_and_the_final_curve_are_the_same_series() -> None:
    """The reported bug, pinned at the source.

    Both publications must thin the WHOLE run. The failure was that one
    of them took a tail: `curve[-500:]`. On any run with more than 500
    points that describes a different period from the live one, so the
    picture jumped at the finish and the final version silently hid the
    beginning - including the drawdown someone was watching for.

    Read off the source because the two publications happen in
    different places in a long method, and the thing being guarded is
    precisely that they agree.
    """
    # Comments stripped first. The fix's own comment quotes the broken
    # expression to explain it, and a bare search would match that and
    # report the bug as still present for ever.
    src = _code(bt_engine)
    assert "curve[-500:]" not in src, "the final result went back to publishing a tail"
    publications = src.count('"equity_curve":')
    thinned = src.count("_thin(curve,")
    assert publications >= 2, "expected both a live and a final publication"
    assert thinned == publications, (
        f"{publications} places publish an equity curve but only {thinned} thin the whole run"
    )


def test_thinning_keeps_both_ends_so_the_two_curves_start_and_finish_together() -> None:
    """Whatever the density, the first and last points must match.

    This is what makes the hand-over invisible: the live curve is drawn
    at 240 points and the final one at 500, and the trader must not see
    the start or the end of their run move.
    """
    curve = [1000.0 + i for i in range(5000)]
    live = bt_engine._thin(curve, 240)
    final = bt_engine._thin(curve, 500)
    assert live[0] == final[0] == curve[0]
    assert live[-1] == final[-1] == curve[-1]
    assert len(live) <= 240 and len(final) <= 500


def test_a_short_run_is_not_thinned_at_all() -> None:
    curve = [1000.0 + i for i in range(120)]
    assert bt_engine._thin(curve, 240) == curve
    assert bt_engine._thin(curve, 500) == curve


# ------------------------------------------------------ pips per trade


class _Pos(dict):
    pass


def test_pips_are_signed_by_direction_not_by_price() -> None:
    """A short that falls is a winner, and must not read as -40 pips."""
    pips = bt_engine.Backtester._pips
    long_win = pips({"type": "buy", "entry": 1.1000}, 1.1040, 0.0001)
    short_win = pips({"type": "sell", "entry": 1.1000}, 1.0960, 0.0001)
    short_loss = pips({"type": "sell", "entry": 1.1000}, 1.1040, 0.0001)
    assert long_win == pytest.approx(40.0)
    assert short_win == pytest.approx(40.0)
    assert short_loss == pytest.approx(-40.0)


def test_no_pip_size_means_no_figure_rather_than_a_guessed_one() -> None:
    """0, which the desk prints as a dash.

    point_value already falls back to 1.0 when the broker will not
    answer. A pip count derived from an assumed tick size would be a
    wrong number stated with complete confidence, which is worse than
    no number.
    """
    pips = bt_engine.Backtester._pips
    assert pips({"type": "buy", "entry": 1.1}, 1.2, 0) == 0.0
    assert pips({"type": "buy", "entry": 1.1}, 1.2, None) == 0.0


def test_a_malformed_trade_cannot_sink_the_result() -> None:
    pips = bt_engine.Backtester._pips
    assert pips({}, 1.2, 0.0001) == 0.0
    assert pips({"type": "buy", "entry": "x"}, 1.2, 0.0001) == 0.0


def test_every_closed_trade_carries_volume_and_pips() -> None:
    """All three exit paths, not just the convenient one.

    A trade can leave by its stop or target, by a close signal, or by
    the end of the data. Each appends its own dict, so each is its own
    chance to forget a field - and a trade list where two thirds of the
    rows have a pip count is worse than one where none do.
    """
    src = _code(bt_engine)
    appends = src.count("trades.append(")
    assert appends >= 3, "expected the three exit paths"
    assert src.count('"pips": self._pips(') == appends, (
        "an exit path appends a trade without a pip figure"
    )


def test_the_result_reports_the_pip_size_it_used() -> None:
    """So the desk can tell "no pips available" from "it went nowhere"."""
    src = _code(bt_engine)
    assert '"pip_size": float(pip_size or 0.0),' in src
