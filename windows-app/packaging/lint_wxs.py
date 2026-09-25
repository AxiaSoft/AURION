#!/usr/bin/env python3
"""Structural validator for the generated AURION MSI .wxs.

wixl/candle are only available on specific machines, so this linter is the
portable gate: it catches the class of mistakes that would otherwise only
surface during the real build (dangling references, bad GUIDs, bad version
formats, missing assets, quote-broken conditions, shipped runtime files).

Usage:  python3 lint-wxs.py <path-to-wxs>
Exit:   0 = OK, 1 = problems found.
"""
from __future__ import annotations

import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.microsoft.com/wix/2006/wi}"
# Stock WixUI (WiX 3) dialog ids
STANDARD_DIALOGS = {
    "WelcomeDlg", "InstallDirDlg", "BrowseDlg", "DiskCostDlg", "ErrorDlg",
    "FatalError", "FilesInUse", "MsiRMFilesInUse", "PrepareDlg", "ProgressDlg",
    "ResumeDlg", "UserExit", "ExitDialog", "VerifyReadyDlg", "CancelDlg",
    "InvalidDirDlg", "MaintenanceWelcomeDlg", "MaintenanceTypeDlg",
    "LicenseAgreementDlg", "FeaturesDlg", "CustomizeDlg", "WaitForCostingDlg",
    "OutOfDiskDlg", "OutOfRbDiskDlg",
}
GUID_RE = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$", re.I)
# Runtime state must never ship inside the installer.
FORBIDDEN_FILES = {"aurion.json"}
FORBIDDEN_DIR_PREFIX = "data/"


def fail(errors: list[str], msg: str) -> None:
    errors.append(msg)


def check_wxs(path: Path) -> list[str]:
    errors: list[str] = []
    tree = ET.parse(path)
    root = tree.getroot()
    base = path.parent
    # WixVariable bitmap/icon paths are relative to light's -b (the packaging dir)
    pkg = Path(__file__).resolve().parent
    def asset(val: str) -> Path:
        for b in (pkg, base):
            if (b / val).exists():
                return b / val
        return pkg / val

    comps: set[str] = set()
    dirs: set[str] = set()
    props: set[str] = set()
    cas: set[str] = set()
    dialogs: set[str] = set()
    controls: dict[str, set[str]] = {}
    icons_src: list[tuple[str, str]] = []
    file_srcs: list[tuple[str, str, str]] = []  # file id, source, name
    component_guids: list[tuple[str, str]] = []
    dirref_depth = [0]

    product = root.find(f"{NS}Product")
    if product is None:
        fail(errors, "no <Product> element")
        return errors

    # Product-level checks
    # DirectoryRef must never nest (CNDL0005) - walk with ancestry.
    def walk_dirrefs(el, inside: bool) -> None:
        for ch in el:
            t = ch.tag.replace(NS, "")
            if t == "DirectoryRef":
                if inside:
                    fail(errors, f"DirectoryRef Id={ch.get('Id')}: nested inside another DirectoryRef (CNDL0005)")
                walk_dirrefs(ch, True)
            else:
                walk_dirrefs(ch, inside)
    walk_dirrefs(root, False)

    for el in root.iter():
        tag = el.tag.replace(NS, "")
        if tag == "Component":
            cid = el.get("Id")
            comps.add(cid)
            g = el.get("Guid", "*")
            if g != "*":
                component_guids.append((cid, g))
        elif tag == "Directory":
            dirs.add(el.get("Id"))
        elif tag == "Property":
            props.add(el.get("Id"))
        elif tag == "CustomAction":
            cas.add(el.get("Id"))
        elif tag == "Dialog":
            dialogs.add(el.get("Id"))
            w, h = el.get("Width"), el.get("Height")
            if not (w and h and w.lstrip("-").isdigit() and h.isdigit()):
                fail(errors, f"Dialog {el.get('Id')}: bad Width/Height ({w}x{h})")
            for ctrl in el.iter(f"{NS}Control"):
                controls.setdefault(el.get("Id"), set()).add(ctrl.get("Id"))
        elif tag == "Icon":
            icons_src.append((el.get("Id"), el.get("SourceFile", "")))
        elif tag == "File":
            file_srcs.append((el.get("Id"), el.get("Source", ""), el.get("Name", "")))

    for cid, g in component_guids:
        if not GUID_RE.match(g):
            fail(errors, f"Component {cid}: invalid Guid {g}")

    uc = product.get("UpgradeCode", "")
    if not (uc and GUID_RE.match(uc)):
        fail(errors, f"Product UpgradeCode is not a valid GUID: {uc!r}")

    ver = product.get("Version", "")
    # AURION version policy: exactly three parts (1.0.0). A 4th field would
    # surface as "1.0.0.0" in the wizard and Apps & features.
    if not re.match(r"^\d+\.\d+\.\d+$", ver):
        fail(errors, f"Product Version must be x.y.z.w: {ver!r}")
    else:
        for part in ver.split("."):
            if int(part) > 65535:
                fail(errors, f"Product Version part {part} > 65535")

    # ComponentRef targets, and every component must be in a feature (ICE21)
    referenced = set()
    for ref in root.iter(f"{NS}ComponentRef"):
        referenced.add(ref.get("Id"))
        if ref.get("Id") not in comps:
            fail(errors, f"ComponentRef -> missing component {ref.get('Id')}")
    orphans = sorted(comps - referenced)
    if orphans:
        fail(errors, f"{len(orphans)} component(s) not in any Feature (ICE21), e.g. {orphans[:3]}")
    # MSI conditions: [Prop] formatting is illegal in a condition (ICE03)
    for el in root.iter():
        tag = el.tag.replace(NS, "")
        if tag in ("Custom", "Show", "Publish", "Condition") and el.text:
            c = el.text.strip()
            if "[" in c or "&lt;" in c or "&gt;" in c or re.search(r"[A-Za-z]~[A-Za-z]", c):
                fail(errors, f"{tag}: malformed MSI condition (ICE03): {c[:70]}")
    for ca in root.iter(f"{NS}CustomAction"):
        if ca.get("Script") and ca.text and len(ca.text) > 255:
            fail(errors, f"CustomAction {ca.get('Id')}: inline script > 255 chars (ICE03) - use Binary + JScriptCall")
    for b in root.iter(f"{NS}Binary"):
        src = b.get("SourceFile", "")
        if not Path(src).exists():
            fail(errors, f"Binary {b.get('Id')}: source missing: {src}")

    # File sources exist + forbidden runtime files
    for fid, src, name in file_srcs:
        p = Path(src)
        if not p.exists():
            fail(errors, f"File {fid} ({name}): source missing: {src}")
        if name in FORBIDDEN_FILES:
            fail(errors, f"File {name} must NOT ship in the installer (runtime user config)")
        rel = str(p.relative_to(p.parents[len(p.parts) - 4]) if len(p.parts) > 4 else p).replace("\\", "/")
        # cheap guard: absolute path must contain /data/ or /config/aurion.json
        norm = str(p).replace("\\", "/")
        if "/data/" in norm:
            fail(errors, f"File under data/ shipped: {norm}")

    # Icon sources
    for iid, src in icons_src:
        if src and not (base / src).exists() and not Path(src).exists():
            fail(errors, f"Icon {iid}: source missing: {src}")

    # WixVariable values (banner / wizard icons)
    for wv in root.iter(f"{NS}WixVariable"):
        vid, val = wv.get("Id"), wv.get("Value", "").replace("\\", "/")
        if vid.startswith("WixUI_"):
            fail(errors, f"WixVariable {vid}: WiX 4 name - WiX 3 uses WixUIBannerBmp/WixUIDialogBmp/WixUI*Ico")
        if vid in ("WixUIBannerBmp", "WixUIDialogBmp"):
            p = asset(val)
            if not p.exists():
                fail(errors, f"{vid} file missing: {val}")
            else:
                raw = p.read_bytes()
                if len(raw) > 26 and raw[:2] == b"BM":
                    w, h = struct.unpack_from("<ii", raw, 18)
                    want = (493, 58) if vid == "WixUIBannerBmp" else (493, 312)
                    if (w, h) != want:
                        fail(errors, f"{vid} must be {want[0]}x{want[1]}, is {w}x{h}")
                else:
                    fail(errors, f"WixUI_Banner is not a BMP: {val}")
        elif vid in ("WixUIExclamationIco", "WixUIInfoIco", "WixUINewIco", "WixUIUpIco"):
            p = asset(val)
            if not p.exists():
                fail(errors, f"{vid} file missing: {val}")
            else:
                data = p.read_bytes()
                # count ICO images: header 6 bytes, then 16-byte directory entries
                if len(data) > 6 and data[:2] == b"\x00\x00":
                    count = struct.unpack_from("<H", data, 4)[0]
                    sizes = set()
                    for i in range(count):
                        d = 6 + i * 16
                        w = data[d]
                        sizes.add(0 if w == 0 else w)
                    if 32 not in sizes:
                        fail(errors, f"{vid} icon should contain a 32x32 image, has {sorted(sizes)}")
                else:
                    fail(errors, f"{vid} is not an ICO: {val}")

    # Publish references
    for pub in root.iter(f"{NS}Publish"):
        dlg = pub.get("Dialog")
        if dlg not in dialogs and dlg not in STANDARD_DIALOGS:
            fail(errors, f"Publish references unknown dialog {dlg}")
            continue
        ctrl = pub.get("Control")
        if dlg in dialogs and ctrl and ctrl not in controls.get(dlg, set()):
            fail(errors, f"Publish {dlg}/{ctrl}: control not found in dialog")
        val = pub.get("Value", "")
        ev = pub.get("Event")
        if ev is None and pub.get("Property") is None:
            fail(errors, f"Publish {dlg}/{ctrl}: needs Event or Property (WiX 3)")
        if ev == "NewDialog" and val not in dialogs and val not in STANDARD_DIALOGS:
            fail(errors, f"Publish {dlg}/{ctrl}: NewDialog -> unknown dialog {val}")
        if ev == "DoAction" and val not in cas and not val.startswith("WixUI"):
            fail(errors, f"Publish {dlg}/{ctrl}: DoAction -> unknown CustomAction {val}")
        if pub.get("Element") is not None or pub.get("Condition") is not None:
            fail(errors, f"Publish {dlg}/{ctrl}: WiX 4 attribute used (Element/Condition)")

    # Show references (UI sequence)
    for show in root.iter(f"{NS}Show"):
        d = show.get("Dialog")
        if d not in dialogs and d not in STANDARD_DIALOGS:
            fail(errors, f"Show references unknown dialog {d}")
        if show.get("Condition") is not None:
            fail(errors, f"Show {d}: Condition attribute is WiX 4 - use element text")
    for tagname, bad in (("Custom", {"Condition"}), ("Control", {"Condition", "Attributes"}),
                         ("Dialog", {"Condition", "ErrorDialog", "ToolDepend", "Minimize", "Maximize",
                                     "ShowBorder", "HideSourcePath", "ShowCancel"}),
                         ("CustomAction", {"Hidden"})):
        for el in root.iter(f"{NS}{tagname}"):
            used = bad & set(el.attrib)
            if used:
                fail(errors, f"{tagname} {el.get('Id') or el.get('Action') or el.get('Dialog')}: WiX 4 attributes {sorted(used)}")
    for ca in root.iter(f"{NS}CustomAction"):
        sc = ca.get("Script")
        if sc and sc not in ("jscript", "vbscript"):
            fail(errors, f"CustomAction {ca.get('Id')}: Script must be jscript|vbscript, got {sc}")
    for fs in root.iter(f"{NS}FileSearch"):
        pass
    for prop in root.iter(f"{NS}Property"):
        for ch in prop:
            if ch.tag == f"{NS}FileSearch":
                fail(errors, f"Property {prop.get('Id')}: FileSearch must be nested in DirectorySearch (WiX 3)")
    for wv in root.iter(f"{NS}UI"):
        if wv.find(f"{NS}WixVariable") is not None:
            fail(errors, "WixVariable must be a Product child, not inside UI")

    # Control ids unique per dialog; condition strings balanced
    for dlg in root.iter(f"{NS}Dialog"):
        did = dlg.get("Id")
        seen: set[str] = set()
        for ctrl in dlg.iter(f"{NS}Control"):
            cid = ctrl.get("Id")
            if cid in seen:
                fail(errors, f"Dialog {did}: duplicate control {cid}")
            seen.add(cid)
            controls.setdefault(did, set()).add(cid)
        for el in list(dlg.iter()) + [dlg]:
            cond = el.get("Condition")
            if cond:
                if cond.count('"') % 2 != 0:
                    fail(errors, f"Dialog {did}: unbalanced quotes in Condition {cond!r}")
                if cond.count("[") != cond.count("]"):
                    fail(errors, f"Dialog {did}: unbalanced [] in Condition {cond!r}")

    for prop in root.iter(f"{NS}Property"):
        cond = prop.get("Condition")
        if cond and cond.count('"') % 2 != 0:
            fail(errors, f"Property {prop.get('Id')}: unbalanced quotes in Condition {cond!r}")

    # InstallExecuteSequence condition balance
    for seq in root.iter(f"{NS}InstallExecuteSequence"):
        for custom in seq.iter(f"{NS}Custom"):
            cond = custom.get("Condition", "")
            if cond.count('"') % 2 != 0:
                fail(errors, f"Execute sequence Custom {custom.get('Action')}: unbalanced quotes {cond!r}")
            if custom.get("Action") not in cas:
                fail(errors, f"Execute sequence references unknown CustomAction {custom.get('Action')}")
            for kw in ("After", "Before"):
                anchor = custom.get(kw, "")
                if anchor and anchor not in cas and not re.match(r"^[A-Za-z]+$", anchor):
                    fail(errors, f"Execute sequence {custom.get('Action')} {kw}={anchor} not a known anchor")

    # CustomAction inline scripts: balanced braces/parens
    for ca in root.iter(f"{NS}CustomAction"):
        text = "".join(ca.itertext())
        if ca.get("Script"):
            if text.count("{") != text.count("}"):
                fail(errors, f"CustomAction {ca.get('Id')}: unbalanced braces in inline script")
            if text.count("(") != text.count(")"):
                fail(errors, f"CustomAction {ca.get('Id')}: unbalanced parens in inline script")
            if ca.get("Script") in ("JScript", "JavaScript") and "Wix.Msi" not in text and ca.get("Id") != "AurionMigrateState":
                # (informational only - a CA that neither logs nor uses the api is allowed)
                pass

    return errors


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    errors = check_wxs(path)
    if errors:
        print(f"LINT FAIL: {len(errors)} problem(s) in {path}")
        for e in errors:
            print("  -", e)
        return 1
    print(f"LINT OK: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
