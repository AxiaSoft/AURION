"""The expert's version must be one number, and the desk must act on it.

Two failures are being prevented here.

The first is drift inside the expert itself. ``#property version`` is what
MetaEditor shows the user, and a separate string is what the expert reports
to the engine at hello - and the reported one is the only one the desk can
judge. They used to be two literals typed by hand, so a missed edit meant a
1.18 expert introducing itself as 1.17 and nobody able to tell.

The second is the thing the user actually complained about: AURION updates
itself, the ``.mq5`` inside MetaTrader does not, and until now nothing
noticed. The engine now reads the shipped version out of the file it ships
and compares it with what each chart reports.

    python3 -m pytest engine/tests/test_ea_version.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from aurion.mt5 import experts  # noqa: E402

EA_DIR = ROOT / "engine" / "ea"
BRIDGE = EA_DIR / "AurionBridge.mq5"
AGENT = EA_DIR / "AurionChartAgent.mq5"


def _define(text: str) -> str:
    match = re.search(r'#define\s+AURION_EA_VERSION\s+"([^"]+)"', text)
    return match.group(1) if match else ""


def test_the_expert_has_exactly_one_version_string() -> None:
    src = BRIDGE.read_text(encoding="utf-8")
    define = _define(src)
    assert define, "AurionBridge must define AURION_EA_VERSION"
    assert experts.file_version(BRIDGE) == define, \
        "#property version and AURION_EA_VERSION disagree - MetaEditor and the desk would show different numbers"
    start = src.rindex("bool SendHello()")
    hello = src[start:src.index("\n  }", start)]
    assert "AURION_EA_VERSION" in hello, "hello must report the macro, not a literal"
    assert not re.search(r"version.{0,8}[0-9]+\\.[0-9]+", hello.replace("AURION_EA_VERSION", "")), \
        "a hard-coded version is still being sent on the wire"


def test_both_experts_ship_the_same_version() -> None:
    """The alias advertises the bridge it is an alias for."""
    assert experts.file_version(BRIDGE) == experts.file_version(AGENT)
    assert _define(AGENT.read_text(encoding="utf-8")) == experts.file_version(AGENT)


def test_the_install_note_matches_what_is_shipped() -> None:
    want = experts.shipped_version()
    text = (EA_DIR / "INSTALL.txt").read_text(encoding="utf-8")
    assert f"You must see version {want}." in text, \
        "the install note tells the user to look for a version this build no longer ships"


def test_the_written_guides_name_the_version_that_is_shipped() -> None:
    """Static documentation cannot read a file, so it is checked instead.

    Every guide tells the user "the version must be X" - that sentence is
    the whole point of the page, and it is also the first thing to rot
    after a bump. Nothing here can keep it in step automatically; what it
    can do is refuse to let a release go out with the wrong number in it.
    """
    want = experts.shipped_version()
    stale = int(want.split(".")[1]) - 1
    old = f"{want.split('.')[0]}.{stale}"
    pages = [
        ROOT / "apps" / "web" / "guide.html",
        ROOT / "README.md",
        ROOT / "docs" / "en" / "01-installation.md",
        ROOT / "docs" / "ar" / "01-installation.md",
        ROOT / "engine" / "ea" / "INSTALL.txt",
    ]
    for page in pages:
        if not page.is_file():
            continue
        text = page.read_text(encoding="utf-8")
        assert old not in text, f"{page.name} still tells the user to look for {old}"
        assert want in text, f"{page.name} never names the shipped version {want}"


def test_the_engine_reads_the_version_from_the_file_it_ships() -> None:
    assert experts.shipped_version() == experts.file_version(BRIDGE)
    ships = {x["id"]: x for x in experts.shipped()}
    assert ships["bridge"]["available"] and ships["bridge"]["required"]
    assert ships["chart_agent"]["available"] and not ships["chart_agent"]["required"]


def test_an_older_chart_is_reported_as_old() -> None:
    want = experts.shipped_version()
    older = ".".join([want.split(".")[0], str(max(0, int(want.split(".")[1]) - 1))])
    state = experts.state([
        {"chart_id": "7", "symbol": "EURUSD", "timeframe": "M15", "version": older, "status": "online"},
        {"chart_id": "8", "symbol": "XAUUSD", "timeframe": "H1", "version": want, "status": "online"},
    ])
    assert state["outdated"] is True
    assert [c["symbol"] for c in state["stale"]] == ["EURUSD"]
    assert [c["state"] for c in state["charts"]] == ["old", "ok"]


def test_a_chart_that_reports_nothing_is_not_called_up_to_date() -> None:
    state = experts.state([{"chart_id": "9", "symbol": "US30", "version": "", "status": "online"}])
    assert state["charts"][0]["state"] == "unknown"
    assert state["outdated"] is True


def test_offline_charts_are_not_nagged_about() -> None:
    state = experts.state([{"chart_id": "9", "symbol": "US30", "version": "0.9", "status": "offline"}])
    assert state["charts"] == [] and state["outdated"] is False


def test_versions_compare_as_numbers_not_text() -> None:
    assert experts.compare("1.9", "1.18") == "old", "1.9 is older than 1.18, though it sorts later as text"
    assert experts.compare("1.18", "1.18") == "ok"
    assert experts.compare("2.0", "1.18") == "newer"
    assert experts.compare("", "1.18") == "unknown"


def test_only_the_shipped_names_can_be_read() -> None:
    """The identifier arrives from a browser; it must not name a path."""
    assert experts.source("bridge")[0] == "AurionBridge.mq5"
    assert experts.source("../../config/aurion.json") == ("", "")
    assert experts.source("") == ("", "")


def test_the_update_carries_the_experts_and_says_when_it_did() -> None:
    """An update that cannot ship the .mq5 leaves the user nothing to install."""
    updater = (ROOT / "backend" / "src" / "updater.js").read_text(encoding="utf-8")
    assert 'path.join(ROOT, "engine", "ea")' in updater, \
        "the experts are not part of the update manifest"
    assert "ea_changed" in updater, "an update that changed the experts has to say so"


def test_the_desk_shows_both_numbers() -> None:
    desk = (ROOT / "apps" / "web" / "js" / "app.js").read_text(encoding="utf-8")
    assert "function expertsCardHtml(" in desk
    assert "${expertsCardHtml()}" in desk, "the card has to be rendered in Settings -> System"
    assert "ea.guide_title" in desk, "the install guide has to be on the card"
    assert "wiz-eaver" in desk, "an old expert must also be visible outside the settings tab"
    trader = (ROOT / "engine" / "aurion" / "runtime" / "trader.py").read_text(encoding="utf-8")
    assert '"experts": self.experts_state()' in trader, "the snapshot has to carry it"
    bridge = (ROOT / "engine" / "aurion" / "mt5" / "bridge.py").read_text(encoding="utf-8")
    assert "_warn_if_expert_is_old" in bridge, "the warning has to reach the log when the chart attaches"


def test_every_string_on_the_card_exists_in_all_three_packs() -> None:
    import json

    keys = {
        "title", "help", "required", "optional", "bridge_about", "chart_agent_about",
        "save_file", "saved", "save_failed", "attached", "no_charts", "running",
        "state_ok", "state_old", "state_newer", "state_unknown", "tester",
        "outdated_title", "outdated_body", "stale_pill", "changed_by_update",
        "none_shipped", "guide_title", "guide_note",
    } | {f"step{n}" for n in range(1, 7)}
    for lang in ("fa", "en", "ar"):
        pack = json.loads((ROOT / "lang" / f"{lang}.json").read_text(encoding="utf-8"))
        missing = keys - set((pack.get("ea") or {}).keys())
        assert not missing, f"{lang} is missing ea.{sorted(missing)}"
        assert (pack.get("logs") or {}).get("ea_outdated"), f"{lang} has no log line for an old expert"


TESTS = [
    test_the_expert_has_exactly_one_version_string,
    test_both_experts_ship_the_same_version,
    test_the_install_note_matches_what_is_shipped,
    test_the_written_guides_name_the_version_that_is_shipped,
    test_the_engine_reads_the_version_from_the_file_it_ships,
    test_an_older_chart_is_reported_as_old,
    test_a_chart_that_reports_nothing_is_not_called_up_to_date,
    test_offline_charts_are_not_nagged_about,
    test_versions_compare_as_numbers_not_text,
    test_only_the_shipped_names_can_be_read,
    test_the_update_carries_the_experts_and_says_when_it_did,
    test_the_desk_shows_both_numbers,
    test_every_string_on_the_card_exists_in_all_three_packs,
]


if __name__ == "__main__":  # pragma: no cover
    for fn in TESTS:
        fn()
        print("  ok  " + fn.__name__)
    print("\nOne version, read from the file, shown where it matters.")
