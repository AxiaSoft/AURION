"""The check a bare machine gets before the desk is started.

A fresh Windows box has no Python, no Node and sometimes no WebView2. The
launcher used to notice, print three lines into a console the desk window
deliberately hides, and exit - so the trader watched a progress bar crawl for
three minutes and then read "AURION could not be started".

The window now asks the same questions itself and offers to fetch what is
missing. Downloading and running installers is a serious thing for an app to
do, so the rules it follows are pinned here rather than left to a reviewer's
memory.

    python3 engine/tests/test_first_run_setup.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WINDOW = ROOT / "installer" / "window"
PREREQ = WINDOW / "Prerequisites.cs"
PANEL = WINDOW / "SetupPanel.cs"
APP = WINDOW / "AppWindow.cs"
CSPROJ = WINDOW / "AurionWindow.csproj"
LAUNCHER = ROOT / "start-aurion.cmd"
REQUIREMENTS = ROOT / "engine" / "requirements.txt"


def _prereq() -> str:
    return PREREQ.read_text(encoding="utf-8")


# --------------------------------------------------------------- it exists --

def test_the_pieces_are_there() -> None:
    for path in (PREREQ, PANEL):
        assert path.exists(), f"{path.name} is missing"
    csproj = CSPROJ.read_text(encoding="utf-8")
    # The project globs *.cs, so a new file is compiled without being listed;
    # this fails if somebody switches it to explicit <Compile> items and
    # forgets these two.
    if "<Compile " in csproj:
        for name in ("Prerequisites.cs", "SetupPanel.cs"):
            assert name in csproj, f"{name} is not compiled"


def test_the_check_runs_before_the_desk_is_started() -> None:
    """Order is the whole feature: ask first, start second."""
    app = APP.read_text(encoding="utf-8")
    boot = app[app.index("private async Task BootAsync("):]
    boot = boot[:boot.index("private bool StartDesk(")]
    assert "EnsurePrerequisitesAsync" in boot, "boot does not check the machine"
    assert boot.index("EnsurePrerequisitesAsync") < boot.index("StartDesk()"), \
        "the check has to happen before the launcher is run"


def test_a_prepared_machine_never_sees_it() -> None:
    """The cost on a working desk must be nothing at all."""
    app = APP.read_text(encoding="utf-8")
    block = app[app.index("private async Task<bool> EnsurePrerequisitesAsync("):]
    block = block[:block.index("/// <summary>Runs the application's own launcher")]
    assert "await DeskIsAnsweringAsync()) return true;" in block, \
        "a desk that is already answering must skip the check entirely"
    assert "items.All(r => r.State == ReqState.Present)" in block, \
        "and a machine with everything present must go straight on"


# ------------------------------------------------------------ it is honest --

def test_every_download_is_https_and_from_the_vendor() -> None:
    src = _prereq()
    urls = re.findall(r'"(https?://[^"]+)"', src)
    assert urls, "no download URLs found - has the manifest moved?"
    allowed = ("https://www.python.org/", "https://nodejs.org/", "https://go.microsoft.com/")
    for url in urls:
        assert url.startswith("https://"), f"{url} is not https"
        assert any(url.startswith(a) for a in allowed), \
            f"{url} is not one of the official vendor hosts"


def test_nothing_unsigned_is_ever_executed() -> None:
    src = _prereq()
    assert "X509Certificate.CreateFromSignedFile" in src, \
        "downloads must be Authenticode-checked"
    download = src[src.index("private static async Task<string> DownloadAsync("):]
    download = download[:download.index("private static bool SignedBy(")]
    assert "SignedBy(" in download, "the download path must verify the signature"
    assert "File.Delete(target)" in download, "and delete anything that fails"
    # The publisher has to be checked, not merely the presence of a signature.
    for publisher in ("Python Software Foundation", "OpenJS Foundation", "Microsoft Corporation"):
        assert publisher in src, f"no expected publisher for {publisher}"


def test_consent_comes_before_the_download() -> None:
    panel = PANEL.read_text(encoding="utf-8")
    assert "InstallRequested" in panel, "there must be an explicit action to start"
    assert "SkipRequested" in panel, "and a way to decline"
    # The vendor and the size are shown on the row before anything is fetched.
    assert "req.Source" in panel and "req.Size" in panel, \
        "the consent screen has to say what comes from where, and how big"
    app = APP.read_text(encoding="utf-8")
    assert "setup.InstallRequested +=" in app, "installation must be driven by that event"
    assert "Prerequisites.InstallAsync" in app
    assert app.index("setup.InstallRequested +=") < app.index("Prerequisites.InstallAsync"), \
        "nothing may be installed before the trader asks for it"


def test_the_result_is_verified_rather_than_assumed() -> None:
    app = APP.read_text(encoding="utf-8")
    block = app[app.index("setup.InstallRequested +="):]
    assert "Prerequisites.InspectAsync" in block, \
        "after installing, the machine is asked again - an installer's exit code is not proof"
    assert block.index("Prerequisites.InstallAsync") < block.index("Prerequisites.InspectAsync"), \
        "the re-check belongs after the install"


# ------------------------------------------------- it agrees with the rest --

def test_the_python_policy_is_the_same_everywhere() -> None:
    """3.13 has no numpy wheels for this pin, and the engine refuses to start on it.

    That rule is now stated in three places; they have to say the same thing.
    """
    src = _prereq()
    versions = re.search(r'PythonVersions\s*=\s*{([^}]*)}', src)
    assert versions, "the supported Python list has moved"
    listed = set(re.findall(r'"(\d+\.\d+)"', versions.group(1)))
    assert listed == {"3.12", "3.11", "3.10"}, f"unexpected Python policy: {sorted(listed)}"

    launcher = LAUNCHER.read_text(encoding="utf-8", errors="replace")
    assert "3.13" in launcher, "the launcher should still warn about 3.13"

    main = (ROOT / "engine" / "main.py").read_text(encoding="utf-8")
    assert "3, 13" in main or "3.13" in main, \
        "engine/main.py should still refuse to run on 3.13"


def test_the_python_libraries_come_from_the_pinned_file() -> None:
    src = _prereq()
    assert "requirements.txt" in src, "the libraries must come from engine/requirements.txt"
    assert REQUIREMENTS.exists(), "engine/requirements.txt is missing"
    assert "pip install -r" in src, "and be installed from it, not named one by one"


def test_node_is_installed_per_machine_and_python_per_user() -> None:
    """Elevation is asked for exactly once, and only where it is unavoidable."""
    src = _prereq()
    assert "InstallAllUsers=0" in src, "Python must install per-user - no elevation needed"
    python_call = src[src.index("async Task InstallPythonAsync("):]
    python_call = python_call[:python_call.index("private static async Task InstallPythonLibsAsync(")]
    assert "elevate: false" in python_call, "the Python install must not prompt for admin"

    node_call = src[src.index("async Task InstallNodeAsync("):]
    node_call = node_call[:node_call.index("private static async Task InstallNodeLibsAsync(")]
    assert "elevate: true" in node_call, "Node's MSI is per-machine and does need admin"


def test_a_reboot_request_counts_as_success() -> None:
    src = _prereq()
    assert "3010" in src, "exit code 3010 means 'installed, wants a reboot' and is not a failure"


def test_the_launcher_points_at_the_window() -> None:
    launcher = LAUNCHER.read_text(encoding="utf-8", errors="replace")
    block = launcher[launcher.index(":NEEDINSTALL"):]
    assert "desk window" in block, \
        "the console path should send people to the thing that can fix it for them"


def test_a_bare_machine_can_reach_the_explanation() -> None:
    """The screen that explains a missing WebView2 must not need WebView2.

    The browser control is only given a window handle once the runtime is
    known to be installed; adding it in the constructor risked throwing on
    exactly the machine the setup screen exists for.
    """
    app = APP.read_text(encoding="utf-8")
    ctor = app[app.index("public AppWindow(bool setupOnly"):app.index("// ----------------------------------------------------------------- boot")]
    assert "Controls.Add(_splash)" in ctor, "the splash is always safe to show"
    assert "Controls.Add(_view)" not in ctor,         "the WebView2 control must not be realised before the runtime is checked"
    assert "Controls.Add(_view)" in app, "it still has to be added later"
    show = app[app.index("private async Task ShowDeskAsync("):]
    assert "Controls.Add(_view)" in show[:2000], "and that later is when the desk is shown"


def test_a_long_download_looks_alive() -> None:
    src = _prereq()
    download = src[src.index("private static async Task<string> DownloadAsync("):]
    download = download[:download.index("private static bool SignedBy(")]
    assert "ReadAsync" in download and "WriteAsync" in download, \
        "the copy is done by hand so progress can be reported"
    assert "Megabytes(" in download, "and reported in a unit a person reads"
    assert "FromMilliseconds(250)" in download, "throttled, so the UI is not flooded"


def test_a_failure_can_be_sent_to_support() -> None:
    src = _prereq()
    assert '"setup.log"' in src or "setup.log" in src, "setup has to leave a log"
    assert "data" in src and "logs" in src, "next to the desk's other logs"
    install = src[src.index("public static async Task InstallAsync("):]
    assert "Write(log," in install, "and record what happened, not only what is on screen"


def test_the_check_can_be_run_on_demand() -> None:
    """`AURION.exe --setup` answers "what is this machine missing" on its own.

    Support needs that: it is a ten second answer that does not require
    booting the engine, and it is the same screen the app shows itself.
    """
    prog = (WINDOW / "Program.cs").read_text(encoding="utf-8")
    assert '"--setup"' in prog, "there is no --setup switch"
    assert "setupOnly" in prog, "and nothing carries it into the window"
    assert "!isFirst && !setupOnly" in prog, \
        "the single-instance guard must not swallow a deliberate setup run"

    app = APP.read_text(encoding="utf-8")
    assert "_setupOnly" in app, "the window has to know it is in setup mode"
    assert "if (_setupOnly) { Close(); return; }" in app, \
        "and close afterwards rather than starting the desk"
    assert "if (!_setupOnly && await DeskIsAnsweringAsync())" in app, \
        "a deliberate check must run even when the desk is already up"


TESTS = [
    test_the_check_can_be_run_on_demand,
    test_a_bare_machine_can_reach_the_explanation,
    test_a_long_download_looks_alive,
    test_a_failure_can_be_sent_to_support,
    test_the_pieces_are_there,
    test_the_check_runs_before_the_desk_is_started,
    test_a_prepared_machine_never_sees_it,
    test_every_download_is_https_and_from_the_vendor,
    test_nothing_unsigned_is_ever_executed,
    test_consent_comes_before_the_download,
    test_the_result_is_verified_rather_than_assumed,
    test_the_python_policy_is_the_same_everywhere,
    test_the_python_libraries_come_from_the_pinned_file,
    test_node_is_installed_per_machine_and_python_per_user,
    test_a_reboot_request_counts_as_success,
    test_the_launcher_points_at_the_window,
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
        except Exception as exc:
            print("FAIL  " + fn.__name__ + " → " + type(exc).__name__ + ": " + str(exc))
            bad += 1
    print("\n%d failing." % bad if bad else "\nA bare machine gets an answer, not a spinner.")
    raise SystemExit(1 if bad else 0)
