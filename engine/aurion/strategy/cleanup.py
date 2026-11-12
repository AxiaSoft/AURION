"""Remove what custom strategies left behind, once, on first start.

Deleting the feature does not delete the files it created on a
customer's machine. Two places hold them:

  * the working folder inside the installation - an upgrade would take
    this one on its own, eventually, but not a customer who never
    upgrades again;
  * the vault under data/, which exists precisely so that nothing the
    installer does can reach it. The MSI excludes data/, the updater
    refuses to write there and a factory reset keeps it. Nothing will
    ever remove it unless code does.

So this is the only thing that can, and it is deliberately kept out of
the loader: the loader no longer knows that user files were ever a
thing, and a destructive sweep should be a module someone can read in
one sitting rather than a side effect of constructing an object.

It runs once. A marker is left in data/ so a reinstall or a repair does
not make the engine walk these folders again on every boot, and so the
log line that says what was deleted is written once rather than daily.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import DATA_DIR, ROOT, load
from ..util.clock import utc_iso
from ..util.log import get

log = get("strategy")

MARKER = "custom-strategies-removed.json"

# Files that shipped with the product rather than being written by a
# user. They are deleted too - the whole folder goes - but they are
# listed so the record distinguishes "we removed our own example" from
# "we removed something the customer wrote".
SHIPPED = {"template", "aurion_bos_retest_strategy", "aurion_ict_fvg_sweep"}


def _strategies_dir() -> Path | None:
    try:
        cfg = load()
        return ROOT / cfg["paths"]["strategies"]
    except Exception:
        log.exception("could not work out where strategies used to live")
        return None


def _remove_tree(folder: Path, record: dict[str, list[str]]) -> None:
    if not folder.is_dir():
        return
    for path in sorted(folder.rglob("*.py")):
        bucket = "shipped" if path.stem in SHIPPED else "user"
        try:
            path.unlink()
            # By strategy, not by file. The same strategy exists in both
            # the working folder and the vault, so appending blindly
            # reported "deleted 2 strategy file(s): my_scalper,
            # my_scalper" for one strategy the customer had written.
            if path.stem not in record[bucket]:
                record[bucket].append(path.stem)
        except OSError:
            log.exception("could not delete %s", path)
    # Then the folders, deepest first, and only if they came out empty.
    # A directory with something else in it is somebody's, not ours.
    for path in sorted(folder.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir():
            try:
                path.rmdir()
            except OSError:
                pass
    try:
        folder.rmdir()
    except OSError:
        pass


def run_once() -> dict[str, Any]:
    """Delete the strategy folder and the vault. Safe to call every boot."""
    marker = DATA_DIR / MARKER
    if marker.exists():
        return {"ok": True, "already": True}

    record: dict[str, list[str]] = {"user": [], "shipped": []}
    # Working out where the folder was can fail too, so it is inside the
    # guard with everything else. A cleanup that cannot finish must never
    # stop the engine from starting: the desk would be gone with it.
    folders: list[Path] = []
    try:
        work = _strategies_dir()
        if work is not None:
            folders.append(work)
    except Exception:
        log.exception("could not work out where strategies used to live")
    try:
        folders.append(DATA_DIR / "strategies")
    except Exception:
        log.exception("could not work out where the strategy vault lived")

    for folder in folders:
        try:
            _remove_tree(folder, record)
        except Exception:
            log.exception("could not finish removing %s", folder)

    if record["user"]:
        log.warning(
            "custom strategies have been removed from AURION; deleted %d strategy file(s) "
            "that were on this machine: %s",
            len(record["user"]), ", ".join(sorted(record["user"])),
        )
    result = {"ok": True, "already": False, "ts": utc_iso(), **record}
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(result, indent=2), encoding="utf-8")
    except OSError:
        # Without the marker it runs again next boot and finds nothing,
        # which is wasteful but harmless. Not worth failing a start over.
        log.exception("could not write the cleanup marker")
    return result
