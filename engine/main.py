#!/usr/bin/env python3
"""AURION engine process — FastAPI + live MT5 bridge."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "engine") not in sys.path:
    sys.path.insert(0, str(ROOT / "engine"))

#: The engine used to refuse outright to start on CPython 3.13 or newer.
#: That rule was a proxy for a real constraint and outlived it. The
#: constraint was never the language version: it was that NumPy 2.1+
#: builds its *x86* wheels for the x86-64-v2 baseline, which an old
#: x86 chip cannot execute, while the last wheel that runs everywhere
#: - 1.26.4 - publishes nothing for 3.13+.
#:
#: engine/requirements.txt now states that properly with environment
#: markers, so an x86 machine on 3.12 still gets 1.26.4 and everything
#: else gets the current release. A version check here would only
#: re-impose, on every architecture, a limit that applies to one.
#:
#: What can still go wrong is narrower and is handled below: the
#: libraries are missing, or a NumPy built for a newer baseline than
#: this CPU was installed anyway. Both are detected by trying, which
#: is the only way either can honestly be known.
try:
    from aurion.config import load  # noqa: E402
    from aurion.util.log import setup  # noqa: E402
except ModuleNotFoundError as exc:
    sys.stderr.write(
        f"\nAURION: a required Python library is missing ({exc.name}).\n"
        f"This is Python {sys.version.split()[0]} on {sys.platform}.\n\n"
        "Install the engine's dependencies into the interpreter you are\n"
        "starting it with:\n\n"
        f"  {Path(sys.executable).name} -m pip install -r engine/requirements.txt\n\n"
    )
    raise SystemExit(2) from exc
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
