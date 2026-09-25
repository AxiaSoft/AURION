from __future__ import annotations

import json
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from ..config import load


def check() -> dict[str, Any]:
    cfg = load()
    lic = cfg.get("license") or {}
    repo = str(lic.get("github_repo") or "").strip()
    current = str(cfg.get("version") or "1.0.0")
    if not repo:
        return {"ok": True, "configured": False, "current": current, "latest": None}
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    req = Request(url, headers={"User-Agent": "AURION-Axiasoft", "Accept": "application/vnd.github+json"})
    try:
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except URLError as exc:
        return {"ok": False, "configured": True, "current": current, "error": str(exc.reason or exc)}
    except Exception as exc:
        return {"ok": False, "configured": True, "current": current, "error": str(exc)}
    tag = str(data.get("tag_name") or data.get("name") or "").lstrip("v")
    return {
        "ok": True,
        "configured": True,
        "current": current,
        "latest": tag,
        "newer": bool(tag and tag != current),
        "url": data.get("html_url") or f"https://github.com/{repo}/releases",
        "name": data.get("name") or tag,
    }
