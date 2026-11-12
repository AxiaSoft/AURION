"""Custom strategies were removed from the product. Keep them removed.

The engine used to import Python written by the user: an upload
endpoint, an editor, a per-file importer, an AST scan for forbidden
imports, a reserved-name list and a vault under data/ that kept a
user's file out of the installer's reach. All of it is gone.

A removal is easy to undo by accident. Someone restoring "just the
loader helper" or "just the endpoint" brings back a code path that
executes arbitrary Python inside the trading engine, and nothing else
in the suite would notice. These tests are the thing that notices.

The tests that used to live in test_strategy_loading_errors.py went
with the feature they covered. The part of that file still worth
keeping - no errno may reach the desk - was already pinned in
test_errno_never_reaches_the_desk.py, which is unaffected: a backtest
can still fail, and must still fail in words.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from aurion.strategy import loader as loader_mod
from aurion.strategy.cleanup import run_once
from aurion.strategy.loader import BUILTIN_NAMES, StrategyLoader, StrategyValidationError

ENGINE = Path(__file__).resolve().parents[1]
REPO = ENGINE.parent


# --------------------------------------------------- the loader cannot import


def test_the_loader_has_no_way_to_execute_a_file():
    """The whole point. No importer, no AST scan, no file reads.

    Checked by name rather than by behaviour because the risk is a
    helper being restored on its own, before anything calls it.
    """
    for gone in (
        "load_path",
        "save_upload",
        "validate_source",
        "validate_file",
        "sanitize_stem",
        "file_for",
        "sync_vault",
        "forget",
        "candidate",
    ):
        assert not hasattr(StrategyLoader, gone), f"{gone} is back on the loader"
        assert not hasattr(loader_mod, gone), f"{gone} is back in the loader module"


def test_the_module_does_not_import_the_machinery_to_run_user_code():
    src = (ENGINE / "aurion" / "strategy" / "loader.py").read_text(encoding="utf-8")
    for banned in ("import ast", "import importlib", "import inspect", "import sys"):
        assert banned not in src, f"{banned} is back in the loader"


def test_the_loader_holds_no_folder_at_all():
    """There is no directory for a strategy file to be dropped into."""
    inst = StrategyLoader()
    for attr in ("dir", "vault"):
        assert not hasattr(inst, attr), f"the loader still knows about a {attr}"


def test_the_forbidden_lists_went_with_the_feature():
    """They existed to make user code safe. There is no user code."""
    for gone in ("FORBIDDEN_NAMES", "FORBIDDEN_MODULES", "RESERVED_NAMES"):
        assert not hasattr(loader_mod, gone), f"{gone} survived without its caller"


# ------------------------------------------------------- what still resolves


@pytest.mark.parametrize("name", list(BUILTIN_NAMES))
def test_every_builtin_still_builds(name):
    assert StrategyLoader().build({"kind": "builtin", "name": name}).name == name


def test_a_retired_builtin_still_resolves():
    """A saved config naming one of these must not stop the engine."""
    assert StrategyLoader().build({"name": "king"}).name == "price_action"


def test_the_kind_and_path_of_an_old_spec_are_ignored_not_rejected():
    """Saved configs and Telegram commands still carry them.

    Answering "unknown strategy" to the desk's own stored config would
    look broken rather than changed.
    """
    inst = StrategyLoader().build(
        {"kind": "file", "name": "ema_rsi", "path": r"C:\\Users\\x\\strategies\\ema_rsi.py"}
    )
    assert inst.name == "ema_rsi"


def test_a_strategy_that_was_uploaded_is_now_simply_unknown():
    with pytest.raises(StrategyValidationError) as err:
        StrategyLoader().build({"kind": "file", "name": "aurion_ict_fvg_sweep"})
    message = str(err.value)
    assert "aurion_ict_fvg_sweep" in message
    assert "ema_rsi" in message, "it must say what the trader can pick instead"


def test_an_unnamed_strategy_is_not_called_none():
    with pytest.raises(StrategyValidationError) as err:
        StrategyLoader().build({"kind": "file"})
    assert "None" not in str(err.value)


def test_the_list_offers_only_builtins():
    items = StrategyLoader().list()
    assert [i["name"] for i in items] == list(BUILTIN_NAMES)
    assert all(i["builtin"] for i in items)


def test_nothing_is_uploadable():
    assert StrategyLoader().uploaded_names() == []


# -------------------------------------------------------------- the API surface


def test_the_endpoints_are_gone():
    src = (ENGINE / "aurion" / "api" / "server.py").read_text(encoding="utf-8")
    for route in (
        "/v1/strategies/upload",
        "/v1/strategies/source",
        "/v1/strategies/update",
        "/v1/strategies/delete",
        "/v1/strategies/template",
    ):
        assert route not in src, f"{route} is back"
    # The two that drive the built-ins stay.
    assert "/v1/strategies/apply" in src
    assert "/v1/strategies/toggle" in src


def test_the_desk_cannot_reach_them_either():
    """An endpoint removed from one side only is still an open door."""
    src = (REPO / "backend" / "src" / "index.js").read_text(encoding="utf-8")
    for route in (
        "/strategies/upload",
        "/strategies/source",
        "/strategies/update",
        "/strategies/delete",
        "/strategies/template",
    ):
        assert route not in src, f"the backend still proxies {route}"


def test_the_trader_has_no_custom_strategy_management():
    from aurion.runtime.trader import Trader

    for gone in ("_custom_slot", "strategy_source", "update_strategy", "delete_strategy"):
        assert not hasattr(Trader, gone), f"{gone} is back on the trader"


def test_the_boot_sweep_no_longer_walks_a_strategies_folder():
    from aurion.runtime import trader as trader_mod

    src = inspect.getsource(trader_mod)
    assert "loader.dir" not in src, "the trader is reaching for a folder that no longer exists"


def test_no_strategy_files_ship_any_more():
    assert not (ENGINE / "strategies").exists(), "the strategies folder is back in the tree"


def test_the_premium_feature_was_retired():
    src = (ENGINE / "aurion" / "license" / "guard.py").read_text(encoding="utf-8")
    assert "strategy_upload" not in src


# ------------------------------------------------------------- the cleanup


def test_the_cleanup_deletes_both_copies(tmp_path, monkeypatch):
    """A customer's files are on disk in two places; both must go."""
    from aurion.strategy import cleanup as cleanup_mod

    work = tmp_path / "engine" / "strategies"
    vault = tmp_path / "data" / "strategies"
    work.mkdir(parents=True)
    vault.mkdir(parents=True)
    (work / "mine.py").write_text("x = 1", encoding="utf-8")
    (work / "template.py").write_text("x = 1", encoding="utf-8")
    (vault / "mine.py").write_text("x = 1", encoding="utf-8")

    monkeypatch.setattr(cleanup_mod, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(cleanup_mod, "_strategies_dir", lambda: work)

    out = cleanup_mod.run_once()
    assert out["already"] is False
    assert not work.exists(), "the working folder survived"
    assert not vault.exists(), "the vault survived - an upgrade will never reach it"
    assert "mine" in out["user"]
    assert "template" in out["shipped"], "our own example should be recorded separately"


def test_the_cleanup_runs_only_once(tmp_path, monkeypatch):
    """Otherwise every boot walks the disk and re-logs the same deletion."""
    from aurion.strategy import cleanup as cleanup_mod

    work = tmp_path / "engine" / "strategies"
    work.mkdir(parents=True)
    (work / "mine.py").write_text("x = 1", encoding="utf-8")
    monkeypatch.setattr(cleanup_mod, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(cleanup_mod, "_strategies_dir", lambda: work)

    first = cleanup_mod.run_once()
    second = cleanup_mod.run_once()
    assert first["already"] is False
    assert second["already"] is True
    marker = json.loads((tmp_path / "data" / cleanup_mod.MARKER).read_text(encoding="utf-8"))
    assert marker["user"] == ["mine"]


def test_the_cleanup_leaves_anything_that_is_not_a_strategy(tmp_path, monkeypatch):
    """It deletes a feature's leftovers, not whatever shares the folder."""
    from aurion.strategy import cleanup as cleanup_mod

    work = tmp_path / "engine" / "strategies"
    work.mkdir(parents=True)
    (work / "mine.py").write_text("x = 1", encoding="utf-8")
    (work / "notes.txt").write_text("keep me", encoding="utf-8")
    monkeypatch.setattr(cleanup_mod, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(cleanup_mod, "_strategies_dir", lambda: work)

    cleanup_mod.run_once()
    assert (work / "notes.txt").is_file(), "it took a file that was not ours"
    assert not (work / "mine.py").exists()


def test_a_cleanup_that_cannot_run_does_not_stop_the_engine(tmp_path, monkeypatch):
    """The desk goes down with the engine. Never fail a start over this."""
    from aurion.strategy import cleanup as cleanup_mod

    monkeypatch.setattr(cleanup_mod, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(
        cleanup_mod, "_strategies_dir", lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    assert cleanup_mod.run_once()["ok"] is True


def test_the_engine_runs_the_cleanup_on_startup():
    """A cleanup nobody calls deletes nothing."""
    from aurion.runtime import trader as trader_mod

    src = inspect.getsource(trader_mod.Trader.__init__)
    assert "cleanup" in src and "run_once" in src
