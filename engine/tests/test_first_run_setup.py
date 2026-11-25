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
    # The SDK project globs *.cs out of its own folder, so a new file next
    # to these two is compiled without being listed anywhere. What would
    # break that is turning the glob off, and only that: a <Compile
    # Include> pointing at a file from another folder (the window pulls in
    # ..\shell\shared\Aurora.cs) ADDS to the glob rather than replacing
    # it, and reading one as the other failed this test on a project that
    # compiles both files perfectly well.
    globbed = not re.search(
        r"<EnableDefault(Compile)?Items>\s*false\s*</EnableDefault(Compile)?Items>",
        csproj,
        re.I,
    )
    if not globbed:
        for name in ("Prerequisites.cs", "SetupPanel.cs"):
            assert name in csproj, f"{name} is not compiled"


def test_the_check_runs_before_the_desk_is_started() -> None:
    """Order is the whole feature: check first, start second."""
    app = APP.read_text(encoding="utf-8")
    boot = app[app.index("private async Task BootAsync("):]
    # Ends at the next method declaration, whatever it is called and
    # whatever it returns: this used to be pinned to the literal
    # "private bool StartDesk(" and broke when the launcher started
    # returning the Process it had started, which has nothing to do
    # with the order this test is about.
    boot = boot[:re.search(r"\n    private ", boot).end()]
    assert "EnsurePrerequisitesAsync" in boot, "boot does not check the machine"
    assert boot.index("EnsurePrerequisitesAsync") < boot.index("StartDesk()"), \
        "the check has to happen before the launcher is run"


def test_a_prepared_machine_never_sees_it() -> None:
    """The cost on a working desk must be nothing at all."""
    app = APP.read_text(encoding="utf-8")
    block = app[app.index("private async Task<bool> EnsurePrerequisitesAsync("):]
    block = block[:block.index("private static string Readable(")]
    assert "await DeskIsAnsweringAsync()) return true;" in block, \
        "a desk that is already answering must skip the check entirely"
    # "Nothing missing" is now Present OR Installed - a requirement that
    # this very run installed is as settled as one that was already
    # there, and counting only Present sent a machine that had just been
    # set up round the loop again.
    assert "missing.Count == 0" in block, \
        "a machine with nothing missing must go straight on"
    assert "r.State is ReqState.Present or ReqState.Installed" in block, \
        "a requirement installed by this run has to count as settled"


# ------------------------------------------------------------ it is honest --

def _code_only(src: str) -> str:
    """The source with its comments removed.

    This file reads C# as text, and the C# documents itself heavily -
    including, in one place, an example settings file containing the
    literal "https://...". Scanning comments for URLs makes a
    documentation example look like a download.
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    return re.sub(r"^\s*//.*$", "", src, flags=re.M)


def test_every_download_is_https_and_from_the_vendor() -> None:
    src = _code_only(_prereq())
    urls = re.findall(r'"(https?://[^"]+)"', src)
    assert urls, "no download URLs found - has the manifest moved?"
    allowed = (
        "https://www.python.org/",
        "https://nodejs.org/",
        "https://go.microsoft.com/",
        # pip's own bootstrap, from the Python Packaging Authority. The
        # embeddable Python build ships without pip and without
        # ensurepip, so this is the vendor route to one.
        "https://bootstrap.pypa.io/",
    )
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
    # The publisher has to be checked, not merely the presence of a
    # signature - for the two downloads that are signed executables.
    for publisher in ("Python Software Foundation", "Microsoft Corporation"):
        assert publisher in src, f"no expected publisher for {publisher}"
    # Node arrives as a ZIP, which carries no Authenticode signature at
    # all, so there is nothing to check a publisher against. It is
    # verified against the SHA-256 list nodejs.org publishes beside it
    # instead, and a file that does not match is not used.
    assert "SHASUMS256.txt" in src, "Node's download is not checked against anything"
    assert "does not match the checksum published for it" in src, \
        "a bad checksum has to stop the file being used, and say so"


def test_the_setup_screen_says_what_comes_from_where() -> None:
    """A first run installs by itself, and still has to be accountable.

    This check used to require consent BEFORE any download. The product
    deliberately changed: a bare machine now installs what it is missing
    without being asked, because the alternative - a dialog about
    WebView2 in front of a trader who wanted to open a trading desk -
    was a question only one answer made sense to. The banner over that
    code says so in as many words.

    What survives is everything that made the consent screen worth
    having: the panel still exists for when automatic setup does not
    get there, it still names the vendor and the size of each item, it
    still offers to retry or to carry on without, and the retry runs
    the same installer the automatic path runs.
    """
    panel = PANEL.read_text(encoding="utf-8")
    assert "InstallRequested" in panel, "there is no way to ask for a retry"
    assert "SkipRequested" in panel, "and no way to carry on without"
    assert "req.Source" in panel and "req.Size" in panel, \
        "the screen has to say what comes from where, and how big"
    app = APP.read_text(encoding="utf-8")
    assert "setup.InstallRequested +=" in app, "the retry is not wired to anything"
    handler = app[app.index("setup.InstallRequested +="):]
    handler = handler[:handler.index("setup.CancelRequested +=") if "setup.CancelRequested +=" in handler[:4000] else 4000]
    assert "Prerequisites.InstallAsync" in handler, \
        "the retry button does not run the installer"


def test_the_result_is_verified_rather_than_assumed() -> None:
    app = APP.read_text(encoding="utf-8")
    block = app[app.index("setup.InstallRequested +="):]
    assert "Prerequisites.InspectAsync" in block, \
        "after installing, the machine is asked again - an installer's exit code is not proof"
    assert block.index("Prerequisites.InstallAsync") < block.index("Prerequisites.InspectAsync"), \
        "the re-check belongs after the install"


# ------------------------------------------------- it agrees with the rest --

def test_the_windows_installer_still_offers_a_runtime_it_has_tested() -> None:
    """The Windows prerequisite list is a shipping decision, not a code limit.

    This used to assert that three separate places all refused Python
    3.13. Two of them should not: engine/requirements.txt now selects
    wheels by architecture, so the engine installs and runs on any
    current Python, and engine/main.py no longer rejects one by number.
    That is checked in test_requirements_policy.py.

    What is left here is narrower and still true. The Windows installer
    does not use whatever Python it finds - it offers to install a
    specific runtime, and that runtime is the one the MSI was built and
    verified against. Widening this list means fetching, bundling and
    testing another runtime on Windows, so it stays a deliberate act
    rather than something that drifts.
    """
    src = _prereq()
    versions = re.search(r'PythonVersions\s*=\s*{([^}]*)}', src)
    assert versions, "the supported Python list has moved"
    listed = set(re.findall(r'"(\d+\.\d+)"', versions.group(1)))
    assert listed == {"3.12", "3.11", "3.10"}, f"unexpected Python policy: {sorted(listed)}"


def test_the_python_libraries_come_from_the_pinned_file() -> None:
    src = _prereq()
    assert "requirements.txt" in src, "the libraries must come from engine/requirements.txt"
    assert REQUIREMENTS.exists(), "engine/requirements.txt is missing"
    assert "pip install -r" in src, "and be installed from it, not named one by one"


def test_nothing_in_setup_asks_for_administrator() -> None:
    """Stronger than it used to be, because the product got stronger.

    This asserted that Node's MSI elevated and Python's installer did
    not. Node is no longer an MSI: it is the official ZIP, unpacked
    beside the desk, so the one remaining UAC prompt in a first run is
    gone. Nothing in setup elevates now, and that is worth pinning -
    an elevated installer is the single most alarming thing a trading
    app can do on first launch, and it is now impossible rather than
    merely rare.
    """
    src = _code_only(_prereq())
    assert "InstallAllUsers=0" in src, "Python must install per-user - no elevation needed"
    assert "elevate: false" in src, "nothing in setup runs anything at all"
    assert "elevate: true" not in src, \
        "something in setup asks for administrator again"


def test_a_reboot_request_counts_as_success() -> None:
    src = _prereq()
    assert "3010" in src, "exit code 3010 means 'installed, wants a reboot' and is not a failure"


def test_the_launcher_runs_the_fix_instead_of_describing_it() -> None:
    """Pointing at the cure is not the cure.

    This used to assert the console path *mentioned* the desk window. It now
    asserts it starts it: a trader who double-clicks start-aurion.cmd on a
    bare machine should get the setup screen, not a paragraph and exit 1.
    """
    launcher = LAUNCHER.read_text(encoding="utf-8", errors="replace")
    block = launcher[launcher.index(":NEEDINSTALL"):]
    assert "AURION.exe --setup" in block, "the console path still only gives advice"
    assert "AURION_SETUP_DONE" in block, "nothing stops the hand-off looping"
    assert ":BYHAND" in block, "there is no fallback when setup cannot run"


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
    # The writing moved behind a recorder that holds the file open for
    # the session - opening and appending per line lost whole runs when
    # two steps wrote at once - so what is asserted is that the install
    # path records, not which call does it.
    assert "recorder.Log(" in install, \
        "and record what happened, not only what is on screen"
    assert "--- setup finished ---" in install, \
        "a log that does not say where a run ended cannot be read after two of them"


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
    test_the_setup_screen_says_what_comes_from_where,
    test_the_result_is_verified_rather_than_assumed,
    test_the_windows_installer_still_offers_a_runtime_it_has_tested,
    test_the_python_libraries_come_from_the_pinned_file,
    test_nothing_in_setup_asks_for_administrator,
    test_a_reboot_request_counts_as_success,
    test_the_launcher_runs_the_fix_instead_of_describing_it,
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
