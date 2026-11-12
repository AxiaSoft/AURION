"""Every way loading a strategy can fail, and what the trader is told.

Three separate reports led here, all of them the same shape: a strategy
file that was accepted, and then did not work, with an error that named
something the trader had never typed.

    unknown builtin strategy 'aurion_strategy_template'
    [Errno 2] No such file or directory:
        'C:\\...\\engine\\strategies\\auaurion_bos_retest_strategy'

Both were plumbing. The name was resolved in four different places -
loader.build, apply_strategy, the startup restore and toggle_strategy -
and three of them joined the name onto the strategies folder by hand,
which loses the ".py" whenever the caller passes a stem. The desk's
dropdown passes a stem.

So the rules this file holds the engine to:

  * one resolver, used everywhere, that accepts a stem, a filename or an
    explicit path, and does not care whether the caller guessed "kind";
  * no raw exception ever reaches the desk from a load — every failure
    is a StrategyValidationError carrying a sentence worth reading;
  * a file that will not load is reported, not silently absent.

The last one matters most for the live chart: a strategy that fails to
import is simply not in the book, so the desk shows no card, no row and
no error, and the upload looks lost.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest

import aurion.strategy.base as base_module
from aurion.strategy.loader import (
    BUILTIN_NAMES,
    StrategyLoader,
    StrategyValidationError,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "engine" / "strategies" / "examples" / "aurion_bos_retest_strategy.py"
GOOD = EXAMPLE.read_text(encoding="utf-8")


def is_strategy(inst) -> bool:
    """The loader's own contract, not an isinstance check.

    Several test files import aurion.strategy.base under a second module
    identity, so the base class object differs and isinstance goes False
    on a perfectly good strategy.
    """
    return bool(getattr(inst, "name", None)) and (
        hasattr(inst, "on_candle") or hasattr(inst, "on_tick")
    )


@pytest.fixture()
def loader():
    ld = StrategyLoader()
    tmp = Path(tempfile.mkdtemp(prefix="aurion-load-"))
    ld.dir = tmp
    try:
        yield ld
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def write(loader, name: str, source: str) -> Path:
    """Put a file in the strategies folder without going through validation.

    Code can break after it was uploaded - an engine upgrade, a renamed
    helper - so the loader has to cope with a bad file already on disk.
    """
    dest = loader.dir / name
    dest.write_text(source, encoding="utf-8")
    return dest


# ------------------------------------------------------- resolution works


@pytest.mark.parametrize(
    "spec",
    [
        {"kind": "file", "name": "mine"},            # the dropdown's stem
        {"kind": "file", "name": "mine.py"},         # the upload endpoint
        {"kind": "builtin", "name": "mine"},         # the old desk's label
        {"kind": None, "name": "mine"},              # no label at all
        {"name": "mine"},                            # no kind key
    ],
)
def test_an_uploaded_strategy_resolves_however_it_is_asked_for(loader, spec):
    loader.save_upload("mine.py", GOOD)
    assert is_strategy(loader.build(dict(spec)))


def test_an_explicit_path_wins(loader):
    dest = loader.save_upload("mine.py", GOOD)
    assert is_strategy(loader.build({"kind": "file", "name": "nonsense", "path": str(dest)}))


@pytest.mark.parametrize("name", BUILTIN_NAMES)
def test_builtins_resolve_under_either_label(loader, name):
    assert is_strategy(loader.build({"kind": "builtin", "name": name}))
    assert is_strategy(loader.build({"kind": "file", "name": name}))


def test_params_survive_resolution(loader):
    loader.save_upload("mine.py", GOOD)
    inst = loader.build({"kind": "builtin", "name": "mine", "params": {"volume": 0.33}})
    assert inst.params["volume"] == 0.33


# --------------------------------------------- nothing raw reaches the desk

BAD_FILES = {
    "import_time_error": (
        "from aurion.strategy.base import BaseStrategy\n"
        "LIMIT = int('not a number')\n"
        "class MyStrategy(BaseStrategy):\n"
        "    def on_candle(self, ctx):\n        return None\n"
    ),
    "init_error": (
        "from aurion.strategy.base import BaseStrategy\n"
        "class MyStrategy(BaseStrategy):\n"
        "    def __init__(self, params=None):\n        raise ValueError('bad default')\n"
        "    def on_candle(self, ctx):\n        return None\n"
    ),
    "no_strategy_class": (
        "from aurion.strategy.base import BaseStrategy\n"
        "class Helper:\n    pass\n"
    ),
    "empty": "",
    "syntax_error": "class MyStrategy(\n",
}


@pytest.mark.parametrize("label", sorted(BAD_FILES))
def test_a_broken_file_is_refused_with_a_sentence(loader, label):
    write(loader, f"{label}.py", BAD_FILES[label])
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "file", "name": label})
    message = str(caught.value)
    assert message.strip(), "the refusal carried no message at all"
    # Not a bare repr of a Python exception type.
    assert message != label


def test_an_import_time_error_names_the_line(loader):
    write(loader, "boom.py", BAD_FILES["import_time_error"])
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "file", "name": "boom"})
    message = str(caught.value)
    assert "boom.py" in message
    assert "line 2" in message, f"no line number in: {message}"
    assert "ValueError" in message


def test_a_failed_import_leaves_no_half_built_module(loader):
    """A second attempt must fail the same way, not find a stale module."""
    import sys

    write(loader, "boom.py", BAD_FILES["import_time_error"])
    for _ in range(2):
        with pytest.raises(StrategyValidationError):
            loader.build({"kind": "file", "name": "boom"})
    assert "aurion_user_strategy_boom" not in sys.modules


def test_a_missing_file_does_not_leak_a_path(loader):
    """This is the reported error, verbatim: a path the trader never typed."""
    loader.save_upload("mine.py", GOOD)
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "file", "name": "ghost"})
    message = str(caught.value)
    assert "Errno" not in message
    assert "ghost" in message
    assert "mine" in message, "the message should list what does exist"


def test_an_unnamed_strategy_is_not_called_none(loader):
    loader.save_upload("mine.py", GOOD)
    for spec in ({"kind": "file", "name": ""}, {"kind": "builtin", "name": None}, {}):
        with pytest.raises(StrategyValidationError) as caught:
            loader.build(dict(spec))
        assert "None" not in str(caught.value)


def test_a_directory_is_not_a_strategy(loader):
    (loader.dir / "folder.py").mkdir()
    with pytest.raises(StrategyValidationError):
        loader.load_path(loader.dir / "folder.py")


def test_a_non_utf8_file_says_so(loader):
    (loader.dir / "latin.py").write_bytes("x = 'caf\xe9'\n".encode("latin-1"))
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "file", "name": "latin"})
    assert "UTF-8" in str(caught.value)


# ------------------------------------------------- the right class is built


def test_the_class_that_implements_on_candle_wins(loader):
    """inspect.getmembers sorts by NAME, so a helper could win the file.

    `AHelper` beats `MyStrategy` alphabetically, and both inherit
    BaseStrategy's no-op on_candle, so hasattr() could not tell them
    apart. The desk armed a strategy that does nothing, silently.
    """
    loader.save_upload(
        "two.py",
        "from aurion.strategy.base import BaseStrategy\n"
        "class AHelper(BaseStrategy):\n    name = 'helper'\n"
        "class MyStrategy(BaseStrategy):\n"
        "    name = 'real'\n"
        "    def on_candle(self, ctx):\n        return None\n",
    )
    assert loader.build({"kind": "file", "name": "two"}).name == "real"


def test_an_explicit_path_with_no_extension_still_finds_the_file(loader):
    """Reported from a Windows desk, twice:

        [Errno 2] No such file or directory:
            'C:\\...\\AURION\\engine\\strategies\\aurion_bos_retest_strategy'

    The joins that dropped the ".py" are gone, but a spec written by an
    older build is still sitting in data/ on every machine that ran one,
    and it names a path in exactly that shape. A file that is plainly
    there must not be refused because of a missing four characters.
    """
    loader.save_upload("aurion_bos_retest_strategy.py", GOOD)
    naked = loader.dir / "aurion_bos_retest_strategy"       # no .py, does not exist
    assert not naked.exists()
    inst = loader.build({"kind": "file", "name": "aurion_bos_retest_strategy", "path": str(naked)})
    assert is_strategy(inst)


def test_a_path_that_is_wrong_in_any_other_way_is_still_refused_in_words(loader):
    """The recovery above must not turn into "guess what they meant"."""
    with pytest.raises(StrategyValidationError) as e:
        loader.build({"kind": "file", "name": "ghost", "path": str(loader.dir / "ghost")})
    assert "ghost" in str(e.value)
    assert "Errno" not in str(e.value)


def test_a_second_copy_of_the_base_module_does_not_confuse_the_pick(loader):
    """The choice must not rest on `is BaseStrategy.on_candle`.

    A user file is imported under its own module name and the process can
    end up holding two separate copies of aurion.strategy.base — the full
    test run does. Compared by identity, *every* class in the file then
    looks like it implements on_candle, and the helper won the file again
    from the other direction. The answer is read off the MRO instead.
    """
    import importlib.util as _ilu

    spec = _ilu.spec_from_file_location(
        "aurion_base_second_copy", Path(base_module.__file__)
    )
    twin = _ilu.module_from_spec(spec)
    sys.modules["aurion_base_second_copy"] = twin
    try:
        spec.loader.exec_module(twin)
        assert twin.BaseStrategy is not base_module.BaseStrategy

        class Helper(twin.BaseStrategy):
            name = "helper"

        class Real(twin.BaseStrategy):
            name = "real"

            def on_candle(self, ctx):
                return None

        assert StrategyLoader._implements(Real, "on_candle") is True
        assert StrategyLoader._implements(Helper, "on_candle") is False
    finally:
        sys.modules.pop("aurion_base_second_copy", None)


def test_source_order_breaks_a_tie_not_the_alphabet(loader):
    loader.save_upload(
        "pair.py",
        "from aurion.strategy.base import BaseStrategy\n"
        "class Zebra(BaseStrategy):\n"
        "    name = 'first_in_file'\n"
        "    def on_candle(self, ctx):\n        return None\n"
        "class Alpha(BaseStrategy):\n"
        "    name = 'second_in_file'\n"
        "    def on_candle(self, ctx):\n        return None\n",
    )
    assert loader.build({"kind": "file", "name": "pair"}).name == "first_in_file"


def test_a_file_with_no_hooks_names_the_classes_it_did_find(loader):
    write(loader, "none.py", "class Thing:\n    pass\nclass Other:\n    pass\n")
    with pytest.raises(StrategyValidationError) as caught:
        loader.build({"kind": "file", "name": "none"})
    message = str(caught.value)
    assert "Thing" in message and "Other" in message


def test_an_on_tick_only_strategy_is_accepted(loader):
    loader.save_upload(
        "ticker.py",
        "from aurion.strategy.base import BaseStrategy\n"
        "class MyStrategy(BaseStrategy):\n"
        "    name = 'ticks'\n"
        "    def on_tick(self, ctx):\n        return None\n",
    )
    assert loader.build({"kind": "file", "name": "ticker"}).name == "ticks"


# -------------------------------------------------- a bad file stays visible


def test_a_file_that_will_not_load_is_reported_not_hidden(loader):
    """The live-chart half of the report.

    A strategy that fails to import is absent from the book, so the desk
    shows no card and no error and the upload looks lost.
    """
    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader.loader = loader
    trader.book = {}

    loader.save_upload("good.py", GOOD)
    write(loader, "bad.py", BAD_FILES["import_time_error"])

    for path in sorted(loader.dir.glob("*.py")):
        try:
            inst = loader.load_path(path, {})
        except Exception as exc:
            trader._note_strategy_fault(path.stem, exc, file=path.name)
            continue
        trader.book[path.stem] = {"inst": inst, "enabled": False, "kind": "file"}
        trader._clear_strategy_fault(path.stem)

    assert sorted(trader.book) == ["good"]
    faults = trader.strategy_faults
    assert list(faults) == ["bad"]
    assert "line 2" in faults["bad"]["error"]
    assert faults["bad"]["file"] == "bad.py"

    # Repairing the file clears the report.
    loader.save_upload("bad.py", GOOD)
    loader.load_path(loader.dir / "bad.py", {})
    trader._clear_strategy_fault("bad")
    assert not trader.strategy_faults


def test_clearing_a_fault_accepts_either_spelling(loader):
    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader._note_strategy_fault("thing", ValueError("x"))
    trader._clear_strategy_fault("thing.py")
    assert not trader.strategy_faults


def test_noting_a_fault_ignores_a_blank_name(loader):
    from aurion.runtime.trader import Trader

    trader = Trader.__new__(Trader)
    trader._note_strategy_fault("", ValueError("x"))
    trader._note_strategy_fault(None, ValueError("x"))
    assert not getattr(trader, "strategy_faults", {})


# ---------------------------------------------------- no hand-rolled joins


def test_no_caller_builds_a_strategy_path_by_hand():
    """The bug was one expression, repeated in four places.

    Resolution belongs to the loader, which knows about the extension.
    A new caller that joins the folder and the name itself reintroduces
    exactly the reported error, so the pattern is pinned out.
    """
    import re

    source = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    offenders = []
    for i, line in enumerate(source.splitlines(), 1):
        if re.search(r"loader\.dir\s*/\s*(?!f\")", line) and ".py" not in line:
            if "glob(" in line:
                continue
            offenders.append(f"{i}: {line.strip()}")
    assert not offenders, "a strategy path is being built without .py:\n" + "\n".join(offenders)


# ---------------------------------------------------------------------------
# The net under everything else.
#
# A customer saw "[Errno 2] No such file or directory: '...\\engine\\
# strategies\\aurion_gold_pullback'" twice, months apart, from two
# different strategies. Every join that could produce a path like that
# has been fixed and the loader answers a missing file in words. This is
# the layer that makes the raw text unreachable whatever future edit
# takes a new route to the same mistake: the API rewrites it on the way
# out and stamps the build that produced it.
# ---------------------------------------------------------------------------

def _api_helpers():
    """The two helpers, without importing the FastAPI app.

    Importing aurion.api.server constructs a Trader, which wants a
    licence, a bus and a config. The helpers are pure text functions and
    are read out of the module source so the test stays a test of them.
    """
    import re as _re
    from pathlib import Path as _Path, PurePosixPath, PureWindowsPath

    src = (_Path(__file__).resolve().parents[1] / "aurion" / "api" / "server.py").read_text(encoding="utf-8")
    start = src.index("def _readable_error(")
    end = src.index('@app.get("/v1/strategies")')
    ns = {
        "re": _re,
        "PurePosixPath": PurePosixPath,
        "PureWindowsPath": PureWindowsPath,
        "Any": object,
        "build_id": type("B", (), {"BUILD_ID": "feedfacefeedface"}),
    }
    exec(compile(src[start:end], "server.py", "exec"), ns)
    return ns["_readable_error"], ns["_strategy_reply"]


def test_the_reported_message_never_reaches_the_desk_again():
    readable, _ = _api_helpers()
    raw = (
        "[Errno 2] No such file or directory: "
        r"'C:\\Users\\Aryan\\AppData\\Local\\Programs\\AURION\\engine"
        r"\\strategies\\aurion_gold_pullback'"
    )
    out = readable(raw)
    assert "Errno" not in out
    assert "No such file or directory" not in out
    # It still says which strategy, which is the only part of the
    # original that was ever any use.
    assert "aurion_gold_pullback" in out
    # And a Windows path is split by Windows rules even on Linux.
    assert "C:" not in out


def test_other_os_errors_are_named_too():
    readable, _ = _api_helpers()
    assert "permission" in readable("[Errno 13] Permission denied: '/x/a.py'").lower()
    assert "folder" in readable("[Errno 21] Is a directory: '/x/a'").lower()
    assert "OS error 28" in readable("[Errno 28] No space left on device: '/x/a.py'")


def test_a_sentence_is_left_exactly_as_it_was():
    """The loader's own messages are already right; do not touch them."""
    readable, _ = _api_helpers()
    msg = "no strategy called 'x' — available: ema_rsi, price_action"
    assert readable(msg) == msg


def test_a_failure_says_which_build_produced_it():
    """Why this exists, in one line.

    The same message kept coming back from a machine whose files had
    already been fixed, because the files had been replaced under a
    running process that went on executing the old ones. With the build
    stamped on the error, that is visible in the message itself.
    """
    _, reply = _api_helpers()
    out = reply({"ok": False, "error": "[Errno 2] No such file or directory: '/x/y'"})
    assert out["build_id"] == "feedfacefeedface"
    assert "Errno" not in out["error"]


def test_a_success_is_passed_through_untouched():
    _, reply = _api_helpers()
    ok = {"ok": True, "strategy": {"name": "x"}}
    assert reply(ok) == ok
    assert "build_id" not in reply(ok)


# ---------------------------------------------------------------------------
# Where a user's strategy lives.
#
# The real cause of "[Errno 2] ... \engine\strategies\<name>", reported
# twice for two different strategies: user-written strategies were kept
# in engine/strategies, inside the installation. Windows Installer owns
# that folder. A major upgrade is scheduled afterInstallInitialize, so
# the old product is removed in full before the new one is laid down -
# correct for shipped files, fatal for a customer's own. The loader was
# blamed both times and was never at fault; it was asked for a file that
# genuinely was not there any more.
#
# The user's copy now lives in data/strategies, which every part of this
# product already treats as untouchable: the installer excludes data\,
# the updater's protected list refuses to write under it, a factory
# reset keeps it.
# ---------------------------------------------------------------------------

import shutil

import pytest

from aurion.strategy import loader as loader_mod


GOOD = """
from aurion.strategy.base import BaseStrategy


class MyStrategy(BaseStrategy):
    name = "vaulted"

    def on_candle(self, ctx):
        return None
"""


@pytest.fixture()
def vaulted(tmp_path, monkeypatch):
    """A loader whose two folders are both throwaway."""
    work = tmp_path / "install" / "engine" / "strategies"
    vault = tmp_path / "data" / "strategies"
    work.mkdir(parents=True)

    def make():
        ld = loader_mod.StrategyLoader.__new__(loader_mod.StrategyLoader)
        ld.dir = work
        ld.vault = vault
        ld.loaded = {}
        ld.sync_vault()
        return ld

    return make, work, vault


def test_an_upload_is_kept_outside_the_installation(vaulted):
    make, work, vault = vaulted
    ld = make()
    ld.save_upload("aurion_gold_pullback.py", GOOD)
    assert (work / "aurion_gold_pullback.py").is_file()
    assert (vault / "aurion_gold_pullback.py").is_file(), "nothing outside the install tree"


def test_a_strategy_survives_the_installation_being_wiped(vaulted):
    """The reported failure, reproduced and then cured.

    Removing the install folder's copy is exactly what a major upgrade
    does to a file it does not own in a directory it manages.
    """
    make, work, vault = vaulted
    make().save_upload("aurion_gold_pullback.py", GOOD)

    shutil.rmtree(work)
    work.mkdir(parents=True)
    assert not (work / "aurion_gold_pullback.py").exists()

    ld = make()
    assert (work / "aurion_gold_pullback.py").is_file(), "the upgrade still loses the strategy"
    inst = ld.build({"kind": "file", "name": "aurion_gold_pullback"})
    assert inst.name == "vaulted"


def test_a_strategy_from_an_older_build_is_adopted(vaulted):
    """Nobody has a vault yet. The first start has to build one."""
    make, work, vault = vaulted
    (work / "legacy_one.py").write_text(GOOD, encoding="utf-8")
    make()
    assert (vault / "legacy_one.py").is_file()


def test_an_edit_wins_over_the_stored_copy(vaulted):
    """The working file is what the engine runs and the desk edits."""
    make, work, vault = vaulted
    make().save_upload("edited.py", GOOD)
    changed = GOOD.replace('name = "vaulted"', 'name = "edited by hand"')
    (work / "edited.py").write_text(changed, encoding="utf-8")
    make()
    assert (vault / "edited.py").read_text(encoding="utf-8") == changed


def test_deleting_really_deletes(vaulted):
    """Otherwise the safety net becomes the bug."""
    make, work, vault = vaulted
    ld = make()
    ld.save_upload("gone.py", GOOD)
    ld.forget("gone")
    assert not (work / "gone.py").exists()
    assert not (vault / "gone.py").exists()
    make()
    assert not (work / "gone.py").exists(), "a deleted strategy came back"


def test_the_shipped_template_is_not_taken_into_a_user_vault(vaulted):
    """It belongs to the build, so an update must be able to replace it."""
    make, work, vault = vaulted
    (work / "template.py").write_text(GOOD, encoding="utf-8")
    make()
    assert not (vault / "template.py").exists()


def test_the_vault_is_under_the_data_directory(tmp_path):
    """Which is what makes it safe: data/ is protected everywhere.

    Built by hand rather than with StrategyLoader(): the real
    constructor reconciles the real folders, so a test that called it
    would create data/strategies inside the checkout and leave it
    there. A test must not write into the tree it is testing.
    """
    from aurion.config import DATA_DIR, ROOT

    src = (
        __import__("pathlib").Path(loader_mod.__file__)
    ).read_text(encoding="utf-8")
    assert 'self.vault = DATA_DIR / "strategies"' in src

    work = ROOT / "engine" / "strategies"
    vault = DATA_DIR / "strategies"
    # The point of the whole change: the two are not in the same tree,
    # and the user's one is the one the installer excludes.
    assert vault != work
    assert work not in vault.parents
