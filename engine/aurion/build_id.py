"""What code is this engine actually running?

Reported from the field, twice, and the second time after an update had
been installed:

    [Errno 2] No such file or directory:
      'C:\\Users\\...\\AURION\\engine\\strategies\\aurion_bos_retest_strategy'

The fault behind that message had been fixed and shipped. The files on
the customer's disk were the new ones. The engine was still running the
old ones, because Python holds a module in memory for the life of the
process and nothing had restarted it -- so the desk said "up to date",
the disk agreed, and the running code did not. There was no way for
anyone, including the desk, to tell the difference.

This is that way. The engine takes a fingerprint of its own source at
import time -- before anything can change on disk underneath it -- and
reports it. The desk takes the same fingerprint of the same files as
they are right now. Two different answers means exactly one thing: the
files have moved on and the process has not, and the only cure is a
restart.

The fingerprint deliberately covers source, not behaviour:

  * every .py under engine/aurion, which is what an update replaces;
  * hashed by content, so a copy that preserves mtimes is still caught
    and a touch that changes nothing is not;
  * __pycache__ is skipped -- bytecode is derived, and stale bytecode is
    its own separate hazard that the updater clears;
  * sorted by path, so two machines with the same files agree.

Cost is one read of about a hundred small files, once, at startup.
Measured at well under a tenth of a second on the machines this runs on,
against a process that then lives for days.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .config import ROOT

#: The tree an update replaces. Everything else in the installation is
#: either data (which must not be fingerprinted) or not Python.
SOURCE_DIR = ROOT / "engine" / "aurion"

SKIP_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", "models"}


def _iter_sources(root: Path):
    """Every shipped .py under `root`, in a stable order."""
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        yield path


def compute(root: Path | None = None) -> str:
    """The fingerprint of the Python source under `root`.

    Returns a short hex digest, or "" when the tree cannot be read --
    and "" always means "no statement". A fingerprint that cannot be
    taken must never be reported as a mismatch, because "I do not know"
    and "they differ" lead to opposite actions.
    """
    base = Path(root) if root else SOURCE_DIR
    try:
        digest = hashlib.sha256()
        found = False
        for path in _iter_sources(base):
            try:
                blob = path.read_bytes()
            except OSError:
                continue
            found = True
            rel = path.relative_to(base).as_posix()
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            digest.update(hashlib.sha256(blob).hexdigest().encode("ascii"))
            digest.update(b"\n")
        if not found:
            return ""
        return digest.hexdigest()[:16]
    except Exception:
        return ""


#: Taken once, at import, which is as close to "what was loaded" as a
#: running process can honestly get. Read it, never recompute it: a
#: fresh reading would describe the disk, and the disk is the thing
#: this exists to be compared against.
BUILD_ID: str = compute()


def report() -> dict[str, object]:
    """What the engine says about itself, for /health and the desk."""
    return {
        "build_id": BUILD_ID,
        "source_dir": str(SOURCE_DIR),
    }
