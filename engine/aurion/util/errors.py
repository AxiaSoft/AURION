"""One place that turns a raw OS error into a sentence a trader can act on.

This lived inside api/server.py, which meant it only protected the
answers that happened to leave through those endpoints. A backtest does
not: its result is handed back over the websocket, built deep inside
the trader, and it reached the desk exactly as Python produced it.

So the same customer kept seeing

    [Errno 2] No such file or directory:
      'C:\\Users\\...\\AURION\\engine\\strategies\\aurion_ict_fvg_sweep'

An errno is a fact about a filesystem call. It is never an answer to
"why will my strategy not run", and the path in it is one no trader
ever typed. Putting the net in a util module lets every exit use the
same one instead of each caller remembering to.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath, PureWindowsPath

_ERRNO = re.compile(r"\[Errno (\d+)\][^:]*:\s*'([^']*)'")


def readable_error(text: str) -> str:
    """Pure text in, text out.

    It cannot know which call failed, only that whatever came back is
    unusable as it stands. The original stays in the engine log, where
    diagnosing it belongs.
    """
    raw = str(text or "")
    match = _ERRNO.search(raw)
    if not match:
        return raw
    errno_no = match.group(1)
    target = match.group(2).replace("\\\\", "\\")
    # A Windows path has to be split by Windows rules even when the
    # engine reporting it is not on Windows: the desk reads these
    # messages, the test suite runs on Linux, and a basename of
    # "C:\\...\\name" helps nobody.
    parts = PureWindowsPath(target) if "\\" in target else PurePosixPath(target)
    name = parts.name or target
    if errno_no == "2":
        return (
            f"'{name}' is not on disk where the engine looked for it. "
            "Upload the strategy file again, or pick another one from the list."
        )
    if errno_no == "13":
        return f"the engine is not allowed to read '{name}' — check the file's permissions"
    if errno_no == "21":
        return f"'{name}' is a folder, not a strategy file"
    return f"the engine could not read '{name}' (OS error {errno_no})"


def readable_result(result):
    """Sanitise the `error` of a failed result dict, in place of a copy.

    Anything that is not a failed dict is handed back untouched, so this
    is safe to wrap around any return value.
    """
    if not isinstance(result, dict) or result.get("ok") is not False:
        return result
    out = dict(result)
    if isinstance(out.get("error"), str):
        out["error"] = readable_error(out["error"])
    return out
