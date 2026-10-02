"""Every branding asset must be the format its name claims.

A .png renamed to .ico passes every existence check in the build script and
then fails a minute later inside the C# compiler as:

    CSC : error CS7065: Error building Win32 resources --
          Icon stream is not in the expected format.

which names neither the file nor the reason. It cost a whole build to find
once. This makes it impossible to commit again.

    python3 engine/tests/test_installer_assets.py
"""
from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "installer" / "assets" / "generated"
SCRIPT = ROOT / "installer" / "tools" / "build-msi.ps1"
BUILDER = ROOT / "installer" / "assets" / "build-assets.py"

ICONS = ["aurion.ico", "exclamation.ico", "info.ico", "new.ico", "up.ico"]
BITMAPS = ["banner.bmp", "dialog.bmp"]


def test_every_icon_is_a_real_icon() -> None:
    for name in ICONS:
        blob = (ASSETS / name).read_bytes()
        assert blob[:4] == b"\x00\x00\x01\x00", (
            f"{name} starts with {blob[:4]!r} - that is not an ICO container"
        )


def test_every_icon_holds_the_images_it_promises() -> None:
    for name in ICONS:
        blob = (ASSETS / name).read_bytes()
        count = struct.unpack("<H", blob[4:6])[0]
        assert count >= 1, f"{name} declares no images"
        for i in range(count):
            off = 6 + i * 16
            size, data = struct.unpack("<II", blob[off + 8:off + 16])
            assert data + size <= len(blob), f"{name}: image {i + 1} points past the end"


def test_the_product_icon_is_the_real_logo_on_black() -> None:
    """The wordmark is silver; a transparent icon loses it on a light desktop.

    Checked on the 16x16 frame, which is a raw DIB and so can be read here
    without an image library: its corner pixel has to be opaque black.
    """
    blob = (ASSETS / "aurion.ico").read_bytes()
    count = struct.unpack("<H", blob[4:6])[0]
    smallest = None
    for i in range(count):
        off = 6 + i * 16
        w = blob[off] or 256
        size, data = struct.unpack("<II", blob[off + 8:off + 16])
        if smallest is None or w < smallest[0]:
            smallest = (w, data, size)
    w, data, _size = smallest
    assert blob[data:data + 4] != b"\x89PNG", "the smallest frame should be a DIB"
    header = struct.unpack("<I", blob[data:data + 4])[0]
    assert header == 40, "expected a 40-byte BITMAPINFOHEADER"
    bpp = struct.unpack("<H", blob[data + 14:data + 16])[0]
    assert bpp == 32, f"the {w}px frame is {bpp}bpp - icons should carry full colour"
    # First pixel of the bottom row, BGRA.
    b, g, r, a = blob[data + 40:data + 44]
    assert (b, g, r) == (0, 0, 0), f"the corner is not black, it is {(r, g, b)}"
    assert a == 255, "the corner is not opaque - the silver wordmark will vanish"


def test_the_generator_matches_the_committed_icon() -> None:
    """Whoever runs build-assets.py next must not undo this."""
    src = BUILDER.read_text(encoding="utf-8")
    body = src[src.index("def build_icon("):src.index("def build_glyph(")]
    assert 'WEB / "icons" / "mark.png"' in body, "the icon has to come from the real logo"
    assert "(0, 0, 0, 255)" in body, "and be composited onto black"
    assert "ICON_SIZES" in body, "and cover every size Windows asks for"
    # Prose mentioning cropping is fine; cropping is not.
    code = "\n".join(line for line in body.splitlines() if not line.strip().startswith(("#", '"')))
    assert ".crop(" not in code, (
        "the logo is used whole at every size - if that ever changes, "
        "update this test and say why"
    )


def test_the_product_icon_covers_the_sizes_windows_asks_for() -> None:
    """Explorer, the taskbar, alt-tab and the installer all want a different one."""
    blob = (ASSETS / "aurion.ico").read_bytes()
    count = struct.unpack("<H", blob[4:6])[0]
    sizes = {(blob[6 + i * 16] or 256) for i in range(count)}
    for need in (16, 32, 48, 256):
        assert need in sizes, f"aurion.ico has no {need}x{need} image (has {sorted(sizes)})"


def test_every_bitmap_is_a_real_bitmap() -> None:
    for name in BITMAPS:
        blob = (ASSETS / name).read_bytes()
        assert blob[:2] == b"BM", f"{name} is not a BMP - Windows Installer will not draw it"


def test_replacing_the_logo_is_enough() -> None:
    """One picture is the brand. The icon must follow it without being asked.

    apps/web/icons/mark.png is already the favicon, the apple-touch icon and
    the PWA icon. If the Windows icon needs a separate manual conversion,
    the two drift apart the first time somebody forgets - so the build
    rebuilds it whenever the logo is the newer file.
    """
    ps1 = SCRIPT.read_text(encoding="utf-8")
    assert "apps\\web\\icons\\mark.png" in ps1, "the build has to know where the logo lives"
    assert "the logo is newer than the icon" in ps1, "and rebuild when it changes"

    index = (ROOT / "apps" / "web" / "index.html").read_text(encoding="utf-8")
    assert 'rel="icon" href="/icons/mark.png' in index, "the favicon is the same file"
    assert 'rel="apple-touch-icon" href="/icons/mark.png' in index

    import json
    manifest = json.loads((ROOT / "apps" / "web" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["icons"][0]["src"] == "/icons/mark.png", "and so is the installed-app icon"

    csproj = (ROOT / "installer" / "window" / "AurionWindow.csproj").read_text(encoding="utf-8")
    assert "<ApplicationIcon>" in csproj, "Explorer's icon for the exe"
    assert 'LogicalName="AURION.ico"' in csproj, "and the window and taskbar icon are the same file"


def test_the_build_script_checks_this_before_compiling() -> None:
    ps1 = SCRIPT.read_text(encoding="utf-8")
    assert "asset formats verified" in ps1, "the build script must validate, not just Test-Path"
    assert "CS7065" in ps1, "and should say which failure it is preventing"


def test_a_dropped_png_can_be_repaired_without_extra_tools() -> None:
    """Somebody swapping in their own logo will copy a PNG over the .ico.

    The build repacks it rather than refusing, using nothing but PowerShell
    and System.Drawing - a build machine has no ImageMagick and may have no
    Python either.
    """
    maker = ROOT / "installer" / "tools" / "make-icon.ps1"
    assert maker.exists(), "installer/tools/make-icon.ps1 is missing"
    src = maker.read_text(encoding="utf-8")
    assert "System.Drawing" in src and "Add-Type" in src, "it must not need anything installed"
    # The container it writes: type 1, 32bpp, 256 stored as PNG, the rest DIB.
    assert "[uint16]1)                 # type 1 = icon" in src
    assert "[uint16]32)            # bits per pixel" in src
    assert "biHeight - colours + mask" in src, "an icon DIB doubles biHeight; that is the classic trap"

    ps1 = SCRIPT.read_text(encoding="utf-8")
    assert "make-icon.ps1" in ps1, "the build script has to know how to repair one"
    assert "repacking it" in ps1, "and say so rather than doing it silently"


def test_there_is_a_one_command_doctor() -> None:
    """When a build keeps failing, the answer has to be one paste, not five."""
    doc = ROOT / "installer" / "tools" / "fix-icon-now.ps1"
    assert doc.exists(), "installer/tools/fix-icon-now.ps1 is missing"
    src = doc.read_text(encoding="utf-8")
    # It has to answer the three questions that look identical from a log.
    assert "NOT a git checkout" in src, "it must catch a folder that cannot receive a pull"
    assert "rev-parse --abbrev-ref HEAD" in src, "and report the branch it is on"
    assert "not building from this folder" in src or "building from this folder" in src, \
        "and say so when the icon is fine but the build still fails"
    assert "make-icon.ps1" in src, "and repair what it can"


def test_binary_assets_are_marked_binary() -> None:
    """core.autocrlf on Windows must never get near an icon."""
    attrs = (ROOT / ".gitattributes").read_text(encoding="utf-8")
    for ext in ("*.ico", "*.png", "*.bmp"):
        assert f"{ext}" in attrs and "binary" in attrs, f"{ext} is not marked binary"


def test_the_generator_can_verify_without_pillow() -> None:
    src = BUILDER.read_text(encoding="utf-8")
    assert "--verify" in src, "a build machine has to be able to check without installing Pillow"
    assert "Image = ImageDraw = ImageFilter = ImageFont = None" in src, \
        "the Pillow import must not abort the verify path"


TESTS = [
    test_replacing_the_logo_is_enough,
    test_the_product_icon_is_the_real_logo_on_black,
    test_the_generator_matches_the_committed_icon,
    test_there_is_a_one_command_doctor,
    test_binary_assets_are_marked_binary,
    test_a_dropped_png_can_be_repaired_without_extra_tools,
    test_every_icon_is_a_real_icon,
    test_every_icon_holds_the_images_it_promises,
    test_the_product_icon_covers_the_sizes_windows_asks_for,
    test_every_bitmap_is_a_real_bitmap,
    test_the_build_script_checks_this_before_compiling,
    test_the_generator_can_verify_without_pillow,
]

if __name__ == "__main__":
    bad = 0
    for fn in TESTS:
        try:
            fn()
            print("  ok  " + fn.__name__)
        except AssertionError as exc:
            print("FAIL  " + fn.__name__ + " → " + str(exc))
            bad += 1
        except Exception as exc:  # a corrupt file must report, not traceback
            print("FAIL  " + fn.__name__ + " → " + type(exc).__name__ + ": " + str(exc))
            bad += 1
    print("\n%d failing." % bad if bad else "\nThe installer's artwork is what it says it is.")
    raise SystemExit(1 if bad else 0)
