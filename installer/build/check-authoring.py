#!/usr/bin/env python3
"""Static sanity check for the AURION WiX authoring.

Runs anywhere (no WiX, no Windows) and catches the mistakes that otherwise
only surface halfway through a Windows build:

  * XML that is not well-formed
  * !(loc.Xxx) references with no matching <String> in the .wxl
  * unused localisation strings
  * NewDialog / SpawnDialog / Show targets that do not exist
  * Binary / Icon references that do not exist
  * dialog controls pointing at undeclared properties
  * missing branding asset files

It is a lint, not a compiler: a clean run does not replace `wix build`, it
just means the obvious things are right.

Usage:  python installer/build/check-authoring.py
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLER = HERE.parent
NS = {"w": "http://wixtoolset.org/schemas/v4/wxs",
      "l": "http://wixtoolset.org/schemas/v4/wxl"}

problems: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def tag(el: ET.Element) -> str:
    return el.tag.split("}")[-1]


def main() -> int:
    wxs = sorted(INSTALLER.rglob("src/**/*.wxs"))
    wxi = sorted(INSTALLER.rglob("src/**/*.wxi"))
    wxl = sorted(INSTALLER.rglob("src/**/*.wxl"))

    if not wxs:
        fail("no .wxs sources found")
        return report()

    # ---------------------------------------------------------------- parse
    trees: dict[Path, ET.Element] = {}
    for f in wxs + wxl + wxi:
        try:
            trees[f] = ET.parse(f).getroot()
        except ET.ParseError as exc:
            fail(f"{f.relative_to(INSTALLER)}: not well-formed XML - {exc}")
    if problems:
        return report()

    raw = {f: f.read_text(encoding="utf-8") for f in wxs}

    # ------------------------------------------------------- localisation
    defined_loc: set[str] = set()
    for f in wxl:
        for s in trees[f].iter():
            if tag(s) == "String" and s.get("Id"):
                defined_loc.add(s.get("Id"))

    used_loc: set[str] = set()
    for f, text in raw.items():
        for m in re.finditer(r"!\(loc\.([A-Za-z0-9_]+)\)", text):
            used_loc.add(m.group(1))

    for name in sorted(used_loc - defined_loc):
        fail(f"!(loc.{name}) is used but never defined in any .wxl")
    for name in sorted(defined_loc - used_loc):
        notes.append(f"localisation string '{name}' is defined but unused")

    # ------------------------------------------------------------ dialogs
    dialogs: set[str] = set()
    binaries: set[str] = set()
    icons: set[str] = set()
    properties: set[str] = set()
    custom_actions: set[str] = set()

    for f, root in trees.items():
        if f.suffix != ".wxs":
            continue
        for el in root.iter():
            t = tag(el)
            if t == "Dialog" and el.get("Id"):
                dialogs.add(el.get("Id"))
            elif t == "Binary" and el.get("Id"):
                binaries.add(el.get("Id"))
            elif t == "Icon" and el.get("Id"):
                icons.add(el.get("Id"))
            elif t in ("Property", "SetProperty") and el.get("Id"):
                properties.add(el.get("Id"))
            elif t == "CustomAction" and el.get("Id"):
                custom_actions.add(el.get("Id"))

    # Windows Installer reserved / standard properties we are allowed to use
    standard = {
        "INSTALLFOLDER", "ProductCode", "ProductVersion", "ProductName", "Manufacturer",
        "REMOVE", "Installed", "ALLUSERS", "REBOOT", "MsiLogging", "ErrorDialog",
        "DefaultUIFont", "ARPPRODUCTICON", "ARPHELPLINK", "ARPURLINFOABOUT",
        "ARPCONTACT", "ARPNOREPAIR", "ARPNOMODIFY", "ARPINSTALLLOCATION",
        "WixShellExecTarget", "FileInUseProcess", "MSIRESTARTMANAGERCONTROL",
        "_BrowseProperty", "INSTALLFOLDER_SET", "SystemFolder", "System64Folder",
        "AppDataFolder", "ProgramFiles64Folder", "LocalAppDataFolder",
    }
    known_props = properties | standard

    for f, root in trees.items():
        if f.suffix != ".wxs":
            continue
        rel = f.relative_to(INSTALLER)

        for el in root.iter():
            t = tag(el)

            if t == "Publish":
                ev, val = el.get("Event"), el.get("Value")
                if ev in ("NewDialog", "SpawnDialog") and val and val not in dialogs:
                    fail(f"{rel}: Publish {ev} -> dialog '{val}' does not exist")
                if ev == "DoAction" and val and val not in custom_actions:
                    fail(f"{rel}: Publish DoAction -> custom action '{val}' does not exist")
                prop = el.get("Property")
                if prop and prop not in known_props:
                    fail(f"{rel}: Publish sets undeclared property '{prop}'")

            elif t == "Show":
                d = el.get("Dialog")
                if d and d not in dialogs:
                    fail(f"{rel}: Show -> dialog '{d}' does not exist")

            elif t == "Control":
                ctype, text = el.get("Type"), el.get("Text")
                if ctype in ("Bitmap", "Icon") and text and not text.startswith("!(loc."):
                    if text not in binaries:
                        fail(f"{rel}: control '{el.get('Id')}' uses binary '{text}' which is not defined")
                prop = el.get("Property")
                if prop and prop not in known_props:
                    fail(f"{rel}: control '{el.get('Id')}' binds undeclared property '{prop}'")
                if ctype == "CheckBox" and not el.get("CheckBoxValue"):
                    fail(f"{rel}: checkbox '{el.get('Id')}' has no CheckBoxValue (it would never set its property)")

            elif t == "Shortcut":
                if el.get("Icon") and el.get("Icon") not in icons:
                    fail(f"{rel}: shortcut '{el.get('Id')}' uses icon '{el.get('Icon')}' which is not defined")

            elif t == "Custom":
                a = el.get("Action")
                if a and a not in custom_actions:
                    fail(f"{rel}: sequenced action '{a}' is not defined")

    # --------------------------------------------------- per-dialog sanity
    for f, root in trees.items():
        if f.suffix != ".wxs":
            continue
        rel = f.relative_to(INSTALLER)
        for dlg in [e for e in root.iter() if tag(e) == "Dialog"]:
            ids: set[str] = set()
            cancels = defaults = 0
            for c in [e for e in dlg.iter() if tag(e) == "Control"]:
                cid = c.get("Id")
                if cid in ids:
                    fail(f"{rel}: dialog '{dlg.get('Id')}' has two controls called '{cid}'")
                ids.add(cid)
                if c.get("Cancel") == "yes":
                    cancels += 1
                if c.get("Default") == "yes":
                    defaults += 1
            if cancels > 1:
                fail(f"{rel}: dialog '{dlg.get('Id')}' marks {cancels} controls as Cancel")
            if defaults > 1:
                fail(f"{rel}: dialog '{dlg.get('Id')}' marks {defaults} controls as Default")
            if dlg.get("Id") not in ("ErrorDlg",) and cancels == 0:
                notes.append(f"dialog '{dlg.get('Id')}' has no Cancel control (Esc will do nothing)")

    # --------------------------------------------------------- duplicates
    seen: dict[str, str] = {}
    for f, root in trees.items():
        if f.suffix != ".wxs":
            continue
        for el in root.iter():
            if tag(el) in ("Dialog", "Component", "Feature", "CustomAction", "Binary", "Icon"):
                key = f"{tag(el)}:{el.get('Id')}"
                if el.get("Id") is None:
                    continue
                if key in seen:
                    fail(f"duplicate {key} in {f.name} (already in {seen[key]})")
                seen[key] = f.name

    # ------------------------------------------------------------ assets
    generated = INSTALLER / "assets" / "generated"
    for asset in ("aurion.ico", "banner.bmp", "dialog.bmp",
                  "info.ico", "exclamation.ico", "new.ico", "up.ico"):
        if not (generated / asset).exists():
            fail(f"branding asset missing: assets/generated/{asset} (run assets/build-assets.py)")

    # ---------------------------------------------------------- launchers
    for vbs in ("AURION-Launch.vbs", "AURION-Stop.vbs"):
        if not (INSTALLER / "launcher" / vbs).exists():
            fail(f"launcher missing: launcher/{vbs}")

    return report()


def report() -> int:
    for n in notes:
        print(f"note:  {n}")
    if problems:
        print()
        for p in problems:
            print(f"ERROR: {p}")
        print(f"\n{len(problems)} problem(s) found.")
        return 1
    print(f"\nAuthoring looks consistent ({len(notes)} note(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
