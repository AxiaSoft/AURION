"""An uploaded strategy must be runnable, not just loadable.

A trader uploaded a strategy, the desk accepted it, the card appeared,
the robot armed it — and running a backtest on it answered:

    unknown builtin strategy 'aurion_strategy_template'

Nothing was wrong with the file. Two things were wrong with the
plumbing between the dropdown and the loader:

  * the desk sent ``{kind: "builtin", name}`` for every backtest, whatever
    was picked, so an uploaded file was always asked for as a built-in;
  * ``StrategyLoader.build`` joined the name straight onto the strategies
    folder, so the dropdown's stem ("my_strategy") became a path with no
    extension and raised FileNotFoundError. Fixing only the desk would
    have swapped one error for another.

`kind` is now a hint rather than a promise: a caller that names
something real gets it, and a caller that names nothing real is told
what it could have asked for instead.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from aurion.strategy.loader import (
    BUILTIN_NAMES,
    StrategyLoader,
    StrategyValidationError,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "engine" / "strategies" / "examples" / "aurion_bos_retest_strategy.py"


def is_strategy(inst) -> bool:
    """What the loader itself requires of a strategy class.

    Deliberately not an isinstance check against the base class: several
    test files import aurion.strategy.base under a second module
    identity, so the class object differs and the check goes False on a
    perfectly good strategy. Nothing in engine/aurion does that check
    either - _instantiate asks for on_candle/on_tick - so this is the
    real contract rather than an accident of import order.
    """
    return bool(getattr(inst, "name", None)) and (
        hasattr(inst, "on_candle") or hasattr(inst, "on_tick")
    )


@pytest.fixture()
def loader():
    """A loader whose strategies folder is a throwaway directory."""
    ld = StrategyLoader()
    tmp = Path(tempfile.mkdtemp(prefix="aurion-strategies-"))
    ld.dir = tmp
    try:
        yield ld
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture()
def uploaded(loader):
    """The example, saved under the name the desk's download button gives."""
    source = EXAMPLE.read_text(encoding="utf-8")
    dest = loader.save_upload("aurion_strategy_template.py", source)
    assert dest.is_file()
    return loader, dest


# ------------------------------------------------- the reported failure


def test_an_uploaded_file_asked_for_as_a_builtin_still_runs(uploaded):
    """The exact request the desk used to send."""
    loader, _ = uploaded
    inst = loader.build({"kind": "builtin", "name": "aurion_strategy_template"})
    assert is_strategy(inst)
    assert inst.name == "bos_retest"


def test_an_uploaded_file_asked_for_by_stem(uploaded):
    """What the dropdown holds: a stem, with no .py."""
    loader, _ = uploaded
    inst = loader.build({"kind": "file", "name": "aurion_strategy_template"})
    assert inst.name == "bos_retest"


def test_an_uploaded_file_asked_for_by_filename(uploaded):
    """What the upload endpoint passes: dest.name, with the .py."""
    loader, _ = uploaded
    inst = loader.build({"kind": "file", "name": "aurion_strategy_template.py"})
    assert inst.name == "bos_retest"


def test_an_explicit_path_still_wins(uploaded):
    loader, dest = uploaded
    inst = loader.build({"kind": "file", "name": "ignored", "path": str(dest)})
    assert inst.name == "bos_retest"


def test_params_reach_the_instance(uploaded):
    loader, _ = uploaded
    inst = loader.build(
        {"kind": "builtin", "name": "aurion_strategy_template", "params": {"volume": 0.42}}
    )
    assert inst.params["volume"] == 0.42


# ------------------------------------------------------- builtins still work


@pytest.mark.parametrize("name", BUILTIN_NAMES)
def test_every_builtin_still_builds(loader, name):
    assert is_strategy(loader.build({"kind": "builtin", "name": name}))


def test_a_builtin_asked_for_as_a_file_still_runs(loader):
    """The mirror of the reported bug, so the leniency goes both ways."""
    assert is_strategy(loader.build({"kind": "file", "name": "ema_rsi"}))


def test_a_retired_builtin_still_resolves(loader):
    """An upgrade must not greet a trader with a missing strategy."""
    for retired in ("scalp_impulse", "king"):
        assert is_strategy(loader.build({"kind": "builtin", "name": retired}))


def test_an_uploaded_file_shadows_nothing(uploaded):
    """A file cannot take a builtin's name — sanitize_stem reserves them."""
    loader, _ = uploaded
    for reserved in ("ema_rsi.py", "price_action.py", "template.py", "base.py"):
        with pytest.raises(StrategyValidationError):
            loader.save_upload(reserved, "x = 1\n")


# ------------------------------------------------------- the error itself


def test_a_genuinely_missing_strategy_says_what_is_available(uploaded):
    loader, _ = uploaded
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "builtin", "name": "does_not_exist"})
    message = str(caught.value)
    assert "does_not_exist" in message
    # The old message named only the thing that failed, which read as a
    # broken upload rather than a mislabelled request.
    assert "ema_rsi" in message
    assert "aurion_strategy_template" in message, (
        "the uploaded strategies are the ones the trader is most likely to "
        "have meant, so they belong in the list"
    )


def test_an_empty_name_is_refused_not_guessed(loader):
    for spec in ({"kind": "builtin", "name": ""}, {"kind": "file", "name": None}):
        with pytest.raises(StrategyValidationError):
            loader.build(spec)


def test_uploaded_names_lists_what_is_on_disk(uploaded):
    loader, _ = uploaded
    assert loader.uploaded_names() == ["aurion_strategy_template"]
    (loader.dir / "_private.py").write_text("x = 1\n", encoding="utf-8")
    assert "_private" not in loader.uploaded_names()


def test_file_for_handles_both_spellings_and_misses(uploaded):
    loader, dest = uploaded
    assert loader.file_for("aurion_strategy_template") == dest
    assert loader.file_for("aurion_strategy_template.py") == dest
    assert loader.file_for("nope") is None
    assert loader.file_for("") is None
    assert loader.file_for(None) is None


def test_file_for_does_not_escape_the_strategies_folder(uploaded):
    """A name is a name, never a path out of the folder."""
    loader, _ = uploaded
    assert loader.file_for("../../etc/passwd") is None
    assert loader.file_for("/etc/passwd") is None
    assert loader.file_for("../aurion_strategy_template") == (
        loader.dir / "aurion_strategy_template.py"
    )
