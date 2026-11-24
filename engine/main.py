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


# Told apart from every other non-zero exit. 3 is ours; 1 and 2 already
# mean "it broke" and "this machine cannot run it".
_EXIT_PORT_BUSY = 3


def _claim_port(host: str, port: int):
    """Take the engine's listening socket, or return None if it is taken.

    Returns a bound, listening socket ready to hand to uvicorn.

    Deliberately does NOT set SO_REUSEADDR. On Linux that option would
    only allow rebinding a socket in TIME_WAIT, which is harmless, but
    on Windows SO_REUSEADDR lets a second process steal a port that is
    actively being listened on - the exact thing this function exists to
    prevent. Windows refuses the duplicate bind by default, so the
    default is what we want on both.
    """
    import socket

    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        sock.listen(2048)
    except OSError:
        sock.close()
        return None
    sock.set_inheritable(True)
    return sock


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
    setup("INFO")
    cfg = load()
    host = args.host or cfg["engine"].get("bind") or "0.0.0.0"
    port = args.port or int(cfg["engine"].get("port") or 18765)

    # ------------------------------------------------------------------
    # Claim the port BEFORE a single piece of the engine starts.
    #
    # This is the fix for the engine that went offline and online and
    # offline again, and then stopped coming back at all.
    #
    # uvicorn.run() does application startup FIRST and binds the socket
    # AFTER it (Server.startup: `await self.lifespan.startup()`, then
    # `loop.create_server(...)`). Our startup event is trader.start(),
    # which opens the EA socket, attaches to MetaTrader and starts every
    # trading loop. So a second engine launched onto a machine that
    # already had one did not politely decline: it booted the whole
    # product - several seconds of importing numpy, pandas and
    # scikit-learn, then a live MetaTrader attach - and only then
    # discovered the port was taken and died.
    #
    # That is what turned one slow moment into the reported flapping.
    # The desk's supervisor starts an engine after three missed health
    # checks; a busy engine misses them; the spare engine it launches
    # burns CPU for several seconds on a machine that was already too
    # busy to answer in time, which guarantees the next checks are
    # missed too. Five attempts later the supervisor gave up, and that
    # was the "then nothing works at all".
    #
    # Binding first inverts it. A duplicate now costs one syscall and
    # exits in milliseconds, having touched nothing: no MetaTrader
    # attach, no EA socket, no loops, no CPU. And because the socket is
    # already ours when uvicorn gets it, there is no window in between
    # for a second process to win the race.
    sock = _claim_port(host, port)
    if sock is None:
        sys.stderr.write(
            f"\nAURION: an engine is already listening on {host}:{port}.\n"
            "This one is stopping so it cannot fight the one that is running.\n\n"
        )
        # A distinct code, so that "an engine was already running"
        # (which is fine, and must never be counted as a failed start)
        # can be told from a real failure (which must). Nothing reads
        # it today - the desk's supervisor spawns detached and decides
        # by asking the port directly, which works for engines it did
        # not start - but a launcher or an installer that waits on this
        # process needs the distinction available, and inventing it
        # later would mean changing an exit code that by then has
        # callers.
        raise SystemExit(_EXIT_PORT_BUSY)

    # Only now - holding the port, certain we are the engine - is it
    # worth paying for the heavy imports. A duplicate used to spend
    # several seconds here, on a machine that was already too busy, to
    # find out it was not needed.
    try:
        import numpy  # noqa: F401
    except RuntimeError as exc:
        if "X86_V2" in str(exc) or "baseline optimizations" in str(exc):
            _die_numpy()
        raise
    import uvicorn

    try:
        config = uvicorn.Config(
            "aurion.api.server:app", host=host, port=port, reload=False, log_level="info"
        )
        uvicorn.Server(config).run(sockets=[sock])
    except RuntimeError as exc:
        if "X86_V2" in str(exc) or "baseline optimizations" in str(exc):
            _die_numpy()
        raise


if __name__ == "__main__":
    main()
