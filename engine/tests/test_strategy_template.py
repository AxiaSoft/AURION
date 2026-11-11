"""The template people start from must not teach them the wrong thing.

A user wrote a structure strategy against engine/strategies/template.py
and it was silent for days. Two of the reasons came straight out of the
template: it modelled refusal as a bare ``return None`` (so the desk
could never say why the strategy was quiet), and it showed
``ctx.position()`` without showing that the thing it returns is a dict
(``getattr(pos, "volume", None)`` on it is always None, which silences
the strategy the moment any position is open).

Both are now demonstrated in the template itself, and pinned here so a
later tidy-up cannot quietly drop them.
"""

from __future__ import annotations

import importlib.util
import inspect
import sys
from pathlib import Path

from aurion.strategy.base import BaseStrategy, StrategyContext
from aurion.strategy.loader import sanitize_stem, validate_source

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "engine" / "strategies" / "template.py"
SOURCE = TEMPLATE.read_text(encoding="utf-8")


def _load():
    spec = importlib.util.spec_from_file_location("aurion_template_under_test", TEMPLATE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    found = [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if obj.__module__ == module.__name__
        and obj.__name__ not in {"BaseStrategy", "Strategy"}
        and (hasattr(obj, "on_candle") or hasattr(obj, "on_tick"))
    ]
    assert found, "the loader would find no strategy class in the template"
    return module, found[0]


MODULE, STRATEGY = _load()


def _candles(n: int = 120) -> list[dict]:
    return [
        {
            "time": 1_700_000_000 + i * 900,
            "open": 2000.0 + i,
            "high": 2001.0 + i,
            "low": 1999.0 + i,
            "close": 2000.5 + i,
        }
        for i in range(n)
    ]


def _ctx(candles, positions=None) -> StrategyContext:
    return StrategyContext(
        symbol="XAUUSD",
        timeframe="M15",
        candles=candles,
        tick=None,
        account={"balance": 10_000.0, "equity": 10_000.0},
        positions=positions or [],
        orders=[],
        ai={},
        params={},
        now="2026-01-01T00:00:00Z",
    )


def test_the_template_still_loads_and_runs():
    strategy = STRATEGY({})
    strategy.on_start(_ctx(_candles()))
    assert strategy.on_candle(_ctx(_candles())) is None
    assert strategy.on_tick(_ctx(_candles())) is None
    strategy.on_stop(_ctx(_candles()))
    assert issubclass(STRATEGY, BaseStrategy)


def test_the_template_would_pass_upload_validation():
    assert validate_source(SOURCE).get("ok") is True
    assert sanitize_stem("my_strategy.py") == "my_strategy"


def test_standing_aside_is_explained():
    """The template must demonstrate decline(), not a bare return None."""
    strategy = STRATEGY({})
    strategy.on_start(_ctx(_candles()))
    assert strategy.on_candle(_ctx(_candles())) is None
    assert strategy.last_refusal_kind, (
        "the template stood aside without naming a reason — the thing it is "
        "supposed to teach"
    )
    assert strategy.refusals


def test_short_history_is_explained():
    strategy = STRATEGY({})
    strategy.on_start(_ctx(_candles()))
    assert strategy.on_candle(_ctx(_candles(5))) is None
    assert "history" in strategy.last_refusal_kind

    strategy2 = STRATEGY({})
    strategy2.on_start(_ctx([]))
    assert strategy2.on_candle(_ctx([])) is None
    assert strategy2.last_refusal_kind


def test_the_position_guard_reads_a_dict():
    """ctx.position() is a dict; the template must show .get(), not getattr."""
    strategy = STRATEGY({})
    strategy.on_start(_ctx(_candles()))
    held = _ctx(_candles(), positions=[{"symbol": "XAUUSD", "volume": 0.10, "type": 0}])
    assert strategy.on_candle(held) is None
    assert "already in this symbol" in strategy.last_refusal_kind, (
        "the template's position guard did not recognise an open position"
    )
    assert 'pos.get("volume")' in SOURCE
    # The anti-pattern may only appear in the warning comment, never in code.
    code = [ln for ln in SOURCE.splitlines() if not ln.lstrip().startswith("#")]
    assert not any("getattr(pos" in ln for ln in code)


def test_the_price_helper_handles_both_key_styles_and_never_raises():
    price = MODULE.price
    assert price({"close": "2000.5"}, "close") == 2000.5
    assert price({"c": 2000.5}, "close") == 2000.5
    assert price({"Close": 2000.5}, "close") == 2000.5

    class Bar:
        high = 7.5

    assert price(Bar(), "high") == 7.5
    assert price({}, "close") is None
    assert price({"close": "not a number"}, "close") is None


def test_evidence_starts_honest():
    """A blank claim reads as "this is known to work". It must not."""
    assert STRATEGY.evidence["state"] == "unmeasured"
    assert "state" in STRATEGY.evidence and "basis" in STRATEGY.evidence


def test_the_template_warns_about_the_four_traps():
    """The comments are the deliverable here, so they are pinned."""
    for marker in (
        "self.decline",
        "RETURNS A DICT",
        "CANDLES ARE DICTS",
        "TEST ON A CHART THAT CONTAINS YOUR SETUP",
    ):
        assert marker in SOURCE, f"the template no longer warns about: {marker}"
    # The Persian desk is the one that hit this, so the guidance is bilingual.
    assert "FA:" in SOURCE
