"""Economic calendar feed.

The desk's Calendar tab and the prop news blackout both read
``prop.news_calendar_path`` — a CSV with ``time,currency,impact,title``.  Out
of the box that path is empty, so the calendar renders nothing.  This module
fills it from Forex Factory's public JSON feed:

    https://nfs.faireconomy.media/ff_calendar_thisweek.json

Each item carries ``title``, ``country`` (a currency code), ``date`` (ISO 8601
with offset) and ``impact`` (High / Medium / Low / Holiday), which maps
straight onto the CSV the engine already parses.

The feed is fetched on the owner's machine, not at build time, and cached to
``config/news_calendar.csv``.  A failed fetch never destroys the cache — the
desk keeps showing the last good week.
"""

from __future__ import annotations

import csv
import json
import logging
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import ROOT, load

log = logging.getLogger("aurion.news")

FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
CACHE = ROOT / "config" / "news_calendar.csv"
STAMP = ROOT / "config" / "news_calendar.fetched"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; AURION/1.0)"}

# Refresh at most every 6 hours; the feed only changes when FF revises it.
MIN_AGE_SECONDS = 6 * 3600

# After a failure, wait before trying again. Without this a machine with no
# outbound access retries a 25s-timeout download on every reload_news() call —
# which the desk triggers each time the Calendar tab is opened.
RETRY_AFTER_SECONDS = 30 * 60
_last_failure = 0.0

# Impact names come through with inconsistent casing across FF endpoints.
IMPACT_MAP = {
    "high": "high",
    "medium": "medium",
    "med": "medium",
    "low": "low",
    "holiday": "holiday",
    "non-economic": "low",
}


def _norm_impact(raw: Any) -> str:
    key = str(raw or "").strip().lower()
    return IMPACT_MAP.get(key, "low")


def _to_utc_iso(raw: Any) -> str:
    """FF dates look like 2026-09-10T08:30:00-04:00. Normalise to UTC ISO."""
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def parse_feed(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Normalise raw FF items into the CSV rows the engine expects."""
    rows: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        when = _to_utc_iso(item.get("date") or item.get("datetime") or "")
        title = str(item.get("title") or item.get("name") or "").strip()
        currency = str(item.get("country") or item.get("currency") or "").strip().upper()
        if not when or not title:
            continue
        rows.append(
            {
                "time": when,
                "currency": currency,
                "impact": _norm_impact(item.get("impact") or item.get("impactName")),
                "title": title,
                "forecast": str(item.get("forecast") or "").strip(),
                "previous": str(item.get("previous") or "").strip(),
            }
        )
    rows.sort(key=lambda r: r["time"])
    return rows


def write_csv(rows: list[dict[str, str]], path: Path | None = None) -> Path:
    target = path or CACHE
    target.parent.mkdir(parents=True, exist_ok=True)
    fields = ["time", "currency", "impact", "title", "forecast", "previous"]
    with target.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return target


def fetch(timeout: float = 25.0) -> list[dict[str, str]]:
    """Download and normalise the feed. Raises on network failure."""
    req = urllib.request.Request(FEED_URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as res:  # nosec - public feed
        payload = json.loads(res.read().decode("utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("events") or payload.get("data") or []
    if not isinstance(payload, list):
        raise ValueError("unexpected feed shape")
    return parse_feed(payload)


def cache_age_seconds() -> float:
    try:
        return time.time() - float(STAMP.read_text(encoding="utf-8").strip() or 0)
    except Exception:
        return float("inf")


def refresh(force: bool = False) -> dict[str, Any]:
    """Fetch the feed unless the cache is fresh. Never raises.

    Returns ``{"ok", "count", "cached", "error"}`` so callers can surface why
    the calendar is empty instead of silently showing nothing.
    """
    global _last_failure
    if not force and cache_age_seconds() < MIN_AGE_SECONDS and CACHE.exists():
        # Must still point the config at the cache: a warm cache written by
        # another process left news_calendar_path empty, so reload_news()
        # returned 0 events while the CSV sat there with a full week in it.
        ensure_configured()
        return {"ok": True, "count": count_cached(), "cached": True, "error": ""}
    if not force and _last_failure and (time.time() - _last_failure) < RETRY_AFTER_SECONDS:
        # Still serve whatever is on disk: skipping this left the calendar
        # blank on an offline machine even though a good cache existed, because
        # the config path was only ever written on a successful fetch.
        have = count_cached()
        if have:
            ensure_configured()
        return {
            "ok": bool(have),
            "count": have,
            "cached": bool(have),
            "error": "" if have else "retry_backoff",
            "retry_in": int(RETRY_AFTER_SECONDS - (time.time() - _last_failure)),
        }
    try:
        rows = fetch()
    except Exception as exc:
        _last_failure = time.time()
        log.warning("news feed fetch failed: %s", exc)
        have = count_cached()
        if have:
            # Serve the last good week instead of an empty calendar.
            ensure_configured()
        return {
            "ok": bool(have),
            "count": have,
            "cached": bool(have),
            "error": str(exc),
        }
    _last_failure = 0.0
    if not rows:
        return {"ok": False, "count": 0, "cached": False, "error": "empty_feed"}
    write_csv(rows)
    try:
        STAMP.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass
    ensure_configured()
    return {"ok": True, "count": len(rows), "cached": False, "error": ""}


def count_cached() -> int:
    try:
        with CACHE.open("r", encoding="utf-8") as fh:
            return max(0, sum(1 for _ in csv.DictReader(fh)))
    except Exception:
        return 0


def ensure_configured() -> Path:
    """Point ``prop.news_calendar_path`` at the cache when it is unset.

    Without this the engine reads an empty path and the calendar stays blank
    even though a perfectly good CSV is sitting on disk.
    """
    from .config import merge

    try:
        path = str(load()["prop"].get("news_calendar_path") or "")
    except Exception:
        path = ""
    if not path:
        try:
            rel = str(CACHE.relative_to(ROOT)).replace("\\", "/")
        except ValueError:
            rel = str(CACHE)
        merge({"prop": {"news_calendar_path": rel}})
    return CACHE
