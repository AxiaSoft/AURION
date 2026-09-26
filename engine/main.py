#!/usr/bin/env python3
"""AURION engine process — FastAPI + live MT5 bridge."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "engine") not in sys.path:
    sys.path.insert(0, str(ROOT / "engine"))

try:
    from aurion.config import load  # noqa: E402
    from aurion.util.log import setup  # noqa: E402
except RuntimeError as exc:
    msg = str(exc)
    if "X86_V2" in msg or "baseline optimizations" in msg:
        sys.stderr.write(
            "\nAURION: this NumPy wheel needs CPU flags your machine does not have (X86_V2).\n"
            "Fix it, then start the engine again:\n\n"
            "  powershell -ExecutionPolicy Bypass -File .\\scripts\\fix-numpy.ps1\n\n"
            "Or by hand:\n"
            "  python -m pip uninstall -y numpy\n"
            "  python -m pip install --no-cache-dir numpy==1.26.4\n\n"
        )
        raise SystemExit(2) from exc
    raise


def _die_numpy() -> None:
    sys.stderr.write(
        "\nAURION: this NumPy wheel needs CPU flags your machine does not have (X86_V2).\n"
        "Fix it, then start the engine again:\n\n"
        "  powershell -ExecutionPolicy Bypass -File .\\scripts\\fix-numpy.ps1\n\n"
        "Or by hand:\n"
        "  python -m pip uninstall -y numpy\n"
        "  python -m pip install --no-cache-dir numpy==1.26.4\n\n"
    )
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(prog="aurion-engine")
    parser.add_argument("--host", default="")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if sys.platform.startswith("win") and sys.version_info >= (3, 13):
        sys.stderr.write(
            f"\nAURION on Windows needs Python 3.10–3.12. This is {sys.version.split()[0]}.\n"
            "Install 3.12 from https://www.python.org/downloads/windows/\n"
            "then:  py -3.12 -m pip install -r engine\\requirements.txt\n"
            "        py -3.12 engine\\main.py --host 127.0.0.1 --port 18765\n\n"
        )
        raise SystemExit(2)
    try:
        import numpy  # noqa: F401
    except RuntimeError as exc:
        if "X86_V2" in str(exc) or "baseline optimizations" in str(exc):
            _die_numpy()
        raise
    setup("INFO")
    cfg = load()
    host = args.host or cfg["engine"].get("bind") or "0.0.0.0"
    port = args.port or int(cfg["engine"].get("port") or 18765)
    import uvicorn

    try:
        uvicorn.run("aurion.api.server:app", host=host, port=port, reload=False, log_level="info")
    except RuntimeError as exc:
        if "X86_V2" in str(exc) or "baseline optimizations" in str(exc):
            _die_numpy()
        raise


if __name__ == "__main__":
    main()
