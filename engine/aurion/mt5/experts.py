"""What AURION ships for MetaTrader 5, and what is actually running.

The problem this solves is an old one and it bites silently. AURION updates
itself; the two experts that live inside MetaTrader do not, because nothing
can reach into a terminal and recompile an ``.mq5``. So the desk ends up
talking a new protocol to an old expert: fields the engine expects are
missing, a message it now sends is ignored, and everything looks "connected"
while quietly misbehaving. The only honest way out is for the desk to know
both numbers - the version it ships and the version each chart reports - and
to say so out loud when they differ.

The shipped version is read from the ``.mq5`` files themselves rather than
kept in a constant next to them. A constant would be a second place to
remember, and a second place to remember is a place that goes stale; the
file that the user compiles is the only thing that cannot lie about its own
version. ``engine/tests/test_ea_version.py`` keeps the two strings *inside*
each expert (the ``#property`` and the one it reports on the wire) equal.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

#: The experts, in the order a human should think about them. ``required``
#: marks the one the desk cannot work without.
EXPERTS: tuple[dict[str, Any], ...] = (
    {
        "id": "bridge",
        "file": "AurionBridge.mq5",
        "role": "bridge",
        "required": True,
    },
    {
        "id": "chart_agent",
        "file": "AurionChartAgent.mq5",
        "role": "agent",
        "required": False,
    },
)

_PROPERTY = re.compile(r'#property\s+version\s+"([0-9][0-9.]*)"')


def ea_dir() -> Path:
    """Where the shipped experts live, in a checkout and in an install."""
    here = Path(__file__).resolve()
    # engine/aurion/mt5/experts.py -> engine/ea
    candidate = here.parents[2] / "ea"
    if candidate.is_dir():
        return candidate
    # An installed copy may flatten the tree; look one level up as well.
    alt = here.parents[3] / "engine" / "ea"
    return alt if alt.is_dir() else candidate


def file_version(path: Path) -> str:
    """The version MetaEditor will show for this expert, or ""."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    match = _PROPERTY.search(text)
    return match.group(1) if match else ""


def parse(version: str) -> tuple[int, ...]:
    """"1.18" -> (1, 18). Unreadable versions sort before everything."""
    parts: list[int] = []
    for chunk in str(version or "").strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        if digits == "":
            break
        parts.append(int(digits))
    return tuple(parts) or (0,)


def compare(running: str, shipped: str) -> str:
    """How the expert on the chart stands against the one we ship.

    "unknown" is kept separate from "old" on purpose: an expert too old to
    report a version at all is a different conversation from one that
    reports 1.17 against 1.18, and the desk says so differently.
    """
    if not shipped:
        return "unknown"
    if not running:
        return "unknown"
    a, b = parse(running), parse(shipped)
    if a == b:
        return "ok"
    return "old" if a < b else "newer"


def shipped() -> list[dict[str, Any]]:
    """The experts in this build, with the version compiled from them."""
    root = ea_dir()
    out: list[dict[str, Any]] = []
    for spec in EXPERTS:
        path = root / str(spec["file"])
        out.append(
            {
                "id": spec["id"],
                "file": spec["file"],
                "role": spec["role"],
                "required": bool(spec.get("required")),
                "version": file_version(path),
                "available": path.is_file(),
                "bytes": path.stat().st_size if path.is_file() else 0,
            }
        )
    return out


def shipped_version() -> str:
    """The version that matters: the bridge is the expert that does the work."""
    for item in shipped():
        if item["id"] == "bridge":
            return str(item["version"] or "")
    return ""


def source(expert_id: str) -> tuple[str, str]:
    """(filename, text) for one shipped expert, or ("", "").

    Only the names in EXPERTS are ever served; the identifier comes from a
    browser and must not be able to name a path.
    """
    for spec in EXPERTS:
        if spec["id"] != expert_id:
            continue
        path = ea_dir() / str(spec["file"])
        if not path.is_file():
            return "", ""
        try:
            return str(spec["file"]), path.read_text(encoding="utf-8")
        except OSError:
            return "", ""
    return "", ""


def install_receipt() -> dict[str, Any]:
    """What ``scripts/copy-ea.ps1`` last copied into the terminals.

    The copy happens on every start and again after an update that touched
    the experts, so the new file is usually already sitting next to
    MetaTrader before the user goes looking for it. Saying so turns "go and
    find the AURION folder" into "it is already there, press F7".
    """
    import json

    here = Path(__file__).resolve()
    for root in (here.parents[3], here.parents[2]):
        path = root / "data" / "ea-install.json"
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        folders = data.get("folders")
        if isinstance(folders, str):
            folders = [folders]
        return {
            "version": str(data.get("version") or ""),
            "at": str(data.get("at") or ""),
            "folders": [str(f) for f in (folders or [])],
        }
    return {}


def state(agents: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Everything the desk needs to show the EA card, in one read.

    ``agents`` are the charts the bridge currently sees, as published in the
    snapshot. Each one carries the version its expert reported at hello, so
    the stale list is per chart: one terminal can easily be updated while
    another, on a different machine, is not.
    """
    ships = shipped()
    want = shipped_version()
    charts: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    for agent in agents or []:
        if str(agent.get("status") or "") == "offline":
            continue
        running = str(agent.get("version") or "")
        verdict = compare(running, want)
        row = {
            "chart_id": str(agent.get("chart_id") or ""),
            "symbol": str(agent.get("symbol") or ""),
            "timeframe": str(agent.get("timeframe") or ""),
            "ea_name": str(agent.get("ea_name") or "AurionBridge"),
            "version": running,
            "state": verdict,
            "tester": bool(agent.get("tester")),
        }
        charts.append(row)
        if verdict in {"old", "unknown"}:
            stale.append(row)
    return {
        "shipped": ships,
        "version": want,
        "charts": charts,
        "stale": stale,
        "outdated": bool(stale),
        "installed": install_receipt(),
        "folder": "MQL5/Experts/Aurion",
        "http_port_hint": 18765,
    }
