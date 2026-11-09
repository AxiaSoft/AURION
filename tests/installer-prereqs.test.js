/**
 * A bare machine must come out of setup able to run AURION.
 *
 * The product can install its own runtimes: installer/window/Prerequisites.cs
 * downloads Python, Node.js and WebView2 from their vendors, checks the
 * Authenticode publisher, and installs them. The bug this guards against was
 * never in that code — it was that nothing reliably *called* it. Setup only
 * detected, the detection could say "found" about a Node too old to use, and
 * the one path that started the provisioner was a checkbox the user was free
 * to untick. Install, untick, launch, error.
 *
 * None of that can be caught by building the MSI on a Windows box either: it
 * only shows up on a machine with no runtimes. So the wiring is checked here,
 * as text, on any machine.
 *
 * What this is not: proof that provisioning works. That needs a clean Windows
 * VM. It is proof that provisioning is reachable, which is the half that
 * regressed.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const prereqWxs = read("installer/src/Prerequisites.wxs");
const actions = read("installer/src/Actions.wxs");
const ui = read("installer/src/ui/AurionUI.wxs");
const wxl = read("installer/src/ui/en-us.wxl");
const prereqCs = read("installer/window/Prerequisites.cs");
const program = read("installer/window/Program.cs");
const appWindow = read("installer/window/AppWindow.cs");
const setupPanel = read("installer/window/SetupPanel.cs");
const hiddenVbs = read("scripts/hidden.vbs");
const provisionPs1 = read("scripts/provision.ps1");
const startPs1 = read("scripts/start.ps1");
const prepareRuntime = read("installer/tools/prepare-runtime.ps1");
const ciBuild = read("installer/ci/build-msi.yml");
const startCmd = read("start-aurion.cmd");
const buildMsi = read("installer/tools/build-msi.ps1");
const stagePs1 = read("installer/tools/stage.ps1");
const verifyBundle = read("installer/tools/verify-bundle.ps1");
const vendorPs1 = read("installer/tools/fetch-vendor.ps1");

// ---------------------------------------------------------------- detection

check("setup decides whether there is anything to provision",
  /SetProperty Id="AURION_PROVISION_NEEDED"/.test(prereqWxs) &&
  /NOT AURION_PYTHON_OK OR NOT AURION_NODE_OK/.test(prereqWxs));

// AURION_PROVISION_NEEDED reads the two OK flags, so it has to be scheduled
// after whatever writes them. Scheduling it After="AppSearch" like its inputs
// would be a coin toss.
check("the provisioning flag is sequenced after the flags it reads",
  /Id="AURION_PROVISION_NEEDED"[^>]*After="AurionSetNodeOk"/s.test(prereqWxs) &&
  /Id="AURION_NODE_OK" Action="AurionSetNodeOk"/.test(prereqWxs));

// A Node 16 that reports "found" is worse than no check: the user clears the
// wizard and meets the failure at launch instead.
check("Node detection insists on a version, not merely a file",
  /Name="node\.exe" MinVersion="18\.0\.0\.0"/.test(prereqWxs));
check("the unversioned Node registry key is not treated as proof",
  !/RegistrySearch[^>]*Node\.js/.test(prereqWxs));

// --------------------------------------------------------------- the action

check("the MSI has an action that provisions the runtimes",
  /CustomAction Id="AurionProvisionRuntimes"/.test(actions));

const provision = actions.match(/<CustomAction Id="AurionProvisionRuntimes"[\s\S]*?\/>/);
check("provisioning runs AURION.exe in setup mode",
  provision && /AURION\.exe&quot; --setup/.test(provision[0]),
  provision ? "" : "action not found");

// A per-user package is never elevated, and Python is installed per-user with
// PrependPath. Running as anyone but the logged-on user puts it in the wrong
// profile and the PATH change lands where nobody will see it.
check("provisioning runs as the logged-on user",
  provision && /Impersonate="yes"/.test(provision[0]));

// Node ships as an .msi and Windows Installer's _MSIExecute mutex forbids a
// nested install, so this must be a detached process, never deferred work
// inside the transaction.
check("provisioning does not block the transaction it cannot nest inside",
  provision && /Execute="immediate"/.test(provision[0]) &&
  /Return="asyncNoWait"/.test(provision[0]));

check("the window app understands the setup switch",
  /--setup/.test(program) && /\/setup/.test(program));

// ------------------------------------------------------------- reachability

// The whole point. Two disjoint paths, and between them they cover every way
// the MSI can finish.
const finishBlock = ui.match(/<Control Id="Finish"[\s\S]*?<\/Control>/);
check("the finish page provisions when the user does not launch the desk",
  finishBlock &&
  /DoAction" Value="AurionProvisionRuntimes"[\s\S]*?Condition="AURION_PROVISION_NEEDED AND NOT AURION_LAUNCH_AFTER/.test(finishBlock[0]));

// Ticking "Start AURION now" runs the same check on the way up, so the two
// must not both fire — two setup windows racing each other over one download
// folder is worse than none.
check("provisioning and launching cannot both fire",
  finishBlock &&
  /Value="AurionProvisionRuntimes" Order="1"/.test(finishBlock[0]) &&
  /Value="AurionLaunchApplication" Order="2"/.test(finishBlock[0]) &&
  /EndDialog" Value="Return" Order="3"/.test(finishBlock[0]));

// /qn, /qb and /qr never show a finish page, and an unprovisioned machine is
// exactly the failure being fixed.
check("an install with no finish page still provisions",
  /Custom Action="AurionProvisionRuntimes"[\s\S]*?After="InstallFinalize"/.test(actions) &&
  /UILevel &lt; 5/.test(actions));

check("administrators can opt out of provisioning",
  /Property Id="AURION_SKIP_PROVISION"/.test(prereqWxs) &&
  /AURION_SKIP_PROVISION &lt;&gt; &quot;1&quot;/.test(actions));

// The console launcher is the documented daily entry point. It used to print
// advice and exit 1 — the error the user actually saw.
check("start-aurion.cmd hands off to setup instead of giving up",
  /AURION\.exe --setup/.test(startCmd) && /AURION_SETUP_DONE/.test(startCmd));
check("the hand-off cannot loop",
  /if defined AURION_SETUP_DONE goto :BYHAND/.test(startCmd));

// ------------------------------------------------------------------- saying so

// The page used to promise the opposite of what now happens: "Setup only
// checks for them - it never downloads or replaces them", plus instructions
// to go and install Python by hand. A user who follows that is back where
// they started.
check("the wizard no longer disclaims the thing it now does",
  !/never downloads or replaces/.test(wxl) && !/Install Python 3\.12 from python\.org, then run/.test(wxl));
check("the wizard says setup will install what is missing",
  /Setup will install Python 3\.12/.test(wxl) && /Setup will install Node\.js 20/.test(wxl));
check("the finish page warns that a window is about to open",
  /String Id="ExitProvision"/.test(wxl) && /loc\.ExitProvision/.test(ui));

// -------------------------------------------------------------- the payload

// All of the above is theatre if the binary that does the work is not in the
// MSI.
check("the window app is published into the payload",
  /\$windowProject = [^\n]*AurionWindow\.csproj/.test(buildMsi) &&
  /publish \$windowProject/.test(buildMsi));
check("the build fails rather than shipping without it",
  /AURION\.exe/.test(buildMsi) && /throw|Write-Error/.test(buildMsi));

// And theatre again if the provisioner cannot reach the vendors.
check("the provisioner still knows where the runtimes come from",
  /python\.org\/ftp\/python\//.test(prereqCs) &&
  /PythonFullVersion = "3\.\d+\.\d+"/.test(prereqCs) &&
  /nodejs\.org\/dist\//.test(prereqCs) &&
  /NodeVersion = "v\d+\.\d+\.\d+"/.test(prereqCs));
check("downloads are still checked against their publisher before running",
  /Python Software Foundation/.test(prereqCs) &&
  /SignedBy\(/.test(prereqCs));

// Node is the exception, and the replacement check has to be real: the zip
// is unsigned, so it is verified against the SHA-256 the vendor publishes
// beside it. Dropping that line would leave one download unchecked.
check("the Node zip is verified against the vendor's published checksum",
  /SHASUMS256\.txt/.test(prereqCs) &&
  /VerifyAgainstPublishedSumAsync/.test(prereqCs) &&
  /SHA256\.HashData\(/.test(prereqCs));

// --------------------------------------------- preparing itself, unattended

// The failure this was written for: on a bare machine the setup screen listed
// what was missing and waited for a click nobody made, the launcher gave up,
// and the window showed a three-minute timeout.
// The whole point: the loading screen does the work. Not a wizard, not a
// button, not a second window behind the one the trader is looking at.
// EnsurePrerequisitesAsync must call InstallAsync itself.
const ensureBody = appWindow.slice(
  appWindow.indexOf("private async Task<bool> EnsurePrerequisitesAsync"),
  appWindow.indexOf("private async Task<bool> ShowSetupPanelAsync"));
check("the loading screen installs what is missing, with nobody asked first",
  /Prerequisites\.InstallAsync\(missing/.test(ensureBody) &&
  !/new SetupPanel/.test(ensureBody));
check("and it narrates it on the splash rather than in silence",
  /_splash\.Status = "Installing/.test(ensureBody) &&
  /_splash\.Progress/.test(ensureBody));
check("the setup panel is now only the failure surface",
  /ShowSetupPanelAsync\(items, cancel, trouble\)/.test(appWindow) &&
  appWindow.indexOf("ShowSetupPanelAsync(items, cancel, trouble)") >
    appWindow.indexOf("Prerequisites.InstallAsync(missing"));
check("and can still be stopped while it runs",
  /CancelRequested/.test(setupPanel) && /CancelRequested/.test(appWindow) &&
  /cancel\.Token/.test(appWindow) && /FormClosing \+= \(_, _\) => cancel\.Cancel\(\)/.test(appWindow));
check("a first run that cannot even check the machine is not fatal",
  /catch \(Exception ex\)[\s\S]{0,200}prerequisite check could not complete/.test(appWindow));

// Node used to arrive as a per-machine MSI: a UAC prompt on a per-user
// install, and node.exe somewhere only a PATH refresh could find.
check("Node is unpacked into the install folder, not installed machine-wide",
  /"-win-x64\.zip"/.test(prereqCs) &&
  /ExtractToDirectory/.test(prereqCs) &&
  !/msiexec/.test(prereqCs));
check("nothing is left behind: runtime\\ goes on uninstall",
  /INSTALLFOLDER\]runtime&quot; rmdir \/s \/q/.test(actions));

// PATH is the thing that cannot be trusted here, in either direction.
check("the launcher is handed a PATH rebuilt from the registry",
  /psi\.Environment\["PATH"\]/.test(appWindow) && /CurrentPath\(\)/.test(appWindow));
check("the interpreters are recorded by absolute path for the launcher",
  /runtime\.env/.test(prereqCs) && /WriteRuntimeEnv/.test(prereqCs) &&
  /runtime\.env/.test(startCmd));
check("start-aurion.cmd actually refreshes PATH - :REFRESHPATH was dead code",
  /^call :REFRESHPATH/m.test(startCmd) && /^call :LOADRUNTIME/m.test(startCmd));
check("the desk is launched through the Node that was found, not a bare name",
  /desk\.log" %NODECMD% src\\index\.js/.test(startCmd));

// A `pause` in a window the app deliberately hides is not a prompt, it is a
// process that never returns - which is exactly what produced the timeout.
check("the hidden launcher never stops on a prompt nobody can see",
  /if defined AURION_NO_BROWSER exit \/b 1/.test(startCmd) &&
  startCmd.indexOf("if defined AURION_NO_BROWSER exit /b 1") < startCmd.indexOf("\npause"));
check("it writes why it gave up where the window will read it",
  /SAYWHATSMISSING/.test(startCmd) && /desk\.log/.test(startCmd) &&
  /NewIn\("desk\.log"/.test(appWindow));
// start-aurion.cmd gives the desk 45 seconds and then exits 1 itself. A
// first run can take longer than that just importing numpy, so an exit is
// only believed when it comes early enough to mean something is missing.
check("an early launcher exit is fatal, a late one is not",
  /launcher\.HasExited && launcher\.ExitCode != 0/.test(appWindow) &&
  /clock\.Elapsed < TimeSpan\.FromSeconds\(30\)/.test(appWindow));

// engine.log and desk.log are appended to and never truncated. Quoting
// their last lines quoted a successful start from three weeks ago and
// presented it as the reason today's run failed.
check("the failure box quotes this run only",
  /MarkLogs\(\)/.test(appWindow) && /_logMarks/.test(appWindow) &&
  /stream\.Position = from/.test(appWindow));
check("and says what no log can: who else holds port 8080",
  /WhoHasPort8080/.test(appWindow) && /GetActiveTcpListeners/.test(appWindow));
check("and which interpreters were actually used",
  /private string Runtimes\(\)/.test(appWindow) && /runtime\.env/.test(appWindow));

// The same work as the setup window, as a plain script, so a machine that
// already has AURION can be repaired without shipping it a new binary.
check("there is an unattended provisioner that needs nobody watching it",
  /param\(/.test(provisionPs1) && /InstallFolder/.test(provisionPs1) &&
  /Find-Python/.test(provisionPs1) && /Find-Node/.test(provisionPs1));
check("the launcher prefers it over the window that waits for a click",
  /provision\.ps1/.test(startCmd) &&
  startCmd.indexOf("provision.ps1") < startCmd.indexOf(":SETUPWINDOW"));
check("it keeps both download rules: signature for the exe, checksum for the zip",
  /Assert-SignedBy/.test(provisionPs1) && /Python Software Foundation/.test(provisionPs1) &&
  /Assert-PublishedChecksum/.test(provisionPs1) && /SHASUMS256\.txt/.test(provisionPs1) &&
  /Get-FileHash/.test(provisionPs1));
check("it installs Python per-user and Node without an installer at all",
  /InstallAllUsers=0/.test(provisionPs1) &&
  /(Expand-Archive|ExtractToDirectory)/.test(provisionPs1) &&
  !/msiexec/.test(provisionPs1));
check("it re-reads PATH after installing, or it would not find its own work",
  /Update-PathFromRegistry/.test(provisionPs1) &&
  /GetEnvironmentVariable\("PATH", "Machine"\)/.test(provisionPs1));
// The most useful way to run it is on a machine where AURION is installed
// and broken and the script is not there yet - fetched straight from the
// repository into %TEMP%, where $PSScriptRoot is worthless.
check("the provisioner can find the installation when run from anywhere",
  provisionPs1.includes("HKCU:\\Software\\AURION") &&
  provisionPs1.includes("Programs\\AURION") &&
  /Could not find an installed AURION/.test(provisionPs1));
check("and can finish by starting the desk, so one command is the whole fix",
  /\[switch\] \$Start/.test(provisionPs1) && /Start-Process -FilePath \$exe/.test(provisionPs1));

check("it records the runtimes the launcher reads",
  /runtime\.env/.test(provisionPs1) && /PYTHON=/.test(provisionPs1) && /NODE=/.test(provisionPs1));
check("it is shipped in the MSI payload",
  /Copy-Tree -From \(Join-Path \$Root "scripts"\)/.test(stagePs1) &&
  !/provision\.ps1/.test(stagePs1.split("ExcludeFiles")[1] || ""));

// A build with 139 MB of verified payload already on disk died because
// nodejs.org refused a connection for a 4 KB text file.
check("every bundled file is cached, including the checksum list",
  /Get-Vendor -Url \$NodeSumsUrl -Name "SHASUMS256\.txt"/.test(vendorPs1) &&
  !/^\s*Invoke-WebRequest -Uri \$NodeSumsUrl/m.test(vendorPs1));
check("downloads are retried before the build is lost",
  /for \(\$try = 1; \$try -le \$attempts/.test(vendorPs1) &&
  /Start-Sleep -Seconds \(\$try \* 3\)/.test(vendorPs1));
check("and a complete bundle survives the network going away",
  /Every bundled runtime is already present/.test(buildMsi) &&
  /the bundle is incomplete/.test(buildMsi));

// One timeout cannot answer two questions. "Is this interpreter here?" is
// answered in well under a second. "Can it import numpy and scikit-learn?"
// compiles several thousand files to bytecode the first time anything on
// the machine does it. Four seconds for both killed the import halfway on
// a first launch and reported the libraries as missing; the second launch
// found a warm cache and worked - hangs once, fine afterwards.
check("the import check gets a budget suited to a cold bytecode cache",
  /int timeoutMs = 4000/.test(prereqCs) &&
  /timeoutMs: 240_000/.test(prereqCs) &&
  /ImportsWorkAsync/.test(prereqCs));
check("and it says what it is doing while it does it",
  /WithHeartbeatResult/.test(prereqCs) &&
  /IProgress<string>\? say = null/.test(prereqCs) &&
  /InspectAsync\(items, _installDir, checking\)/.test(appWindow));

// Node is a zip; unpacking it answers to nobody. Python is an MSI bundle,
// and Windows permits one installation at a time across the machine. A
// desk launched from its own MSI's finish page races the installer that
// started it: the Python bundle exits 1618 instantly, with no download and
// no message, while Node installs happily afterwards.
check("Python waits for Windows Installer instead of racing it",
  /WaitForWindowsInstaller/.test(prereqCs) &&
  /Global\\\\_MSIExecute/.test(prereqCs) &&
  /code 1618/.test(prereqCs));

// /quiet makes python.org's bundle silent in every sense: no stdout, no
// log, failure as a bare exit code. There was nothing at all to look at.
check("the Python installer is made to explain itself",
  /\/quiet \/log/.test(prereqCs) &&
  /python-install\.log/.test(prereqCs) &&
  /Decisive\(installLog\)/.test(prereqCs) &&
  /private static string Explain\(string message\)/.test(prereqCs));

// /passive still asks no questions, but it can show a UAC prompt - which
// /quiet cannot, so a bundle needing elevation just fails with a number.
check("and a silent failure is retried where it can speak",
  /\/passive \/log/.test(prereqCs));

// python.org's .exe is an MSI bundle. When it will not run at all, the
// embeddable build is a zip of files: nothing to queue behind, no
// elevation, no registry - the same shape as the Node install, which is
// the one runtime that has never failed to install on a customer machine.
check("a Python that cannot be installed can still be unpacked",
  /python-" \+ PythonFullVersion \+ "-embed-amd64\.zip/.test(prereqCs) &&
  /UnpackPythonAsync/.test(prereqCs) &&
  /Install-PythonFromZip/.test(provisionPs1) &&
  /\$PythonZipName   = "python-\$PythonVersion-embed-amd64\.zip"/.test(provisionPs1));
check("and the build bundles what unpacking needs",
  /python-\$PythonVersion-embed-amd64\.zip/.test(vendorPs1) &&
  /bootstrap\.pypa\.io\/get-pip\.py/.test(vendorPs1));

// The embeddable build ships with "import site" commented out, which
// leaves site-packages switched off - pip then installs into a directory
// the interpreter never looks in, and every engine import fails with the
// libraries sitting right there.
check("the unpacked Python has site-packages switched back on",
  /#import site/.test(prereqCs) && /Lib\\\\site-packages/.test(prereqCs) &&
  /get-pip/.test(prereqCs) &&
  provisionPs1.includes('"#import site"'));

// A Burn log is thousands of lines and the useful one is rarely the last;
// quoting the tail produced four lines about deleting temporary files.
check("the error quotes the lines that name a failure, not the tail",
  /private static string Decisive\(string path\)/.test(prereqCs) &&
  !/LastLinesOf/.test(prereqCs) &&
  /Detected related/.test(prereqCs));

// From a real python-install.log: the bundle found its own packages
// already Present, switched to Modify, planned "execute: None" for all 52,
// ignored TargetDir and exited 0. A complete success that installed
// nothing - so the exit code proves nothing and python.exe must be looked
// for directly.
check("a success that installed nothing is not treated as success",
  /Plan begin, 52 packages, action: Modify/.test(prereqCs) &&
  /had nothing to do and left no Python behind/.test(prereqCs) &&
  /had nothing to do and left no Python behind/.test(provisionPs1));

// PrependPath=0, Include_launcher=0 and refusing the Store alias are all
// deliberate, and together they made a perfectly good CPython 3.12.7
// invisible. python.org writes its location to the registry regardless.
check("an existing python.org install is found through the registry",
  prereqCs.includes("Software\\Python\\PythonCore\\{version}\\InstallPath") &&
  provisionPs1.includes('Software\\Python\\PythonCore\\$v\\InstallPath'));

// ICE77, learned the hard way: a deferred custom action runs inside the
// installation script, and the script is the span between
// InstallInitialize and InstallFinalize. Scheduling one outside that span
// is not a warning, it fails the build - and the build is on a machine
// that is not this one, so it costs a day.
{
  // One element at a time. A single regex spanning from an Id to a later
  // Execute="deferred" reaches straight across the element boundary and
  // reported an immediate action as deferred.
  const deferred = actions
    .split("<CustomAction")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("/>")))
    .filter((el) => /Execute="deferred"/.test(el))
    .map((el) => /Id="([^"]+)"/.exec(el))
    .filter((m) => m !== null)
    .map((m) => m[1]);

  const scheduled = new Map();
  for (const m of actions.matchAll(
    /<Custom\s+Action="([^"]+)"\s+(After|Before)="([^"]+)"/g)) {
    scheduled.set(m[1], { when: m[2], anchor: m[3] });
  }

  const wrong = [];
  for (const id of deferred) {
    const slot = scheduled.get(id);
    if (!slot) { wrong.push(`${id} is never sequenced`); continue; }
    if (slot.when === "After" && slot.anchor === "InstallFinalize") {
      wrong.push(`${id} is After InstallFinalize, outside the script`);
    }
    if (slot.when === "Before" && slot.anchor === "InstallInitialize") {
      wrong.push(`${id} is Before InstallInitialize, outside the script`);
    }
  }

  check("every deferred action is sequenced inside the install script",
    wrong.length === 0,
    wrong.length ? wrong.join("; ") : `${deferred.length} deferred actions`);
}

// "It used Windows' uninstaller" and "the fix is in, rebuild" is a
// conversation that repeats forever unless both sides can see the same
// facts. This prints them.
const checkInstall = read("scripts/check-install.ps1");
check("there is a way to read back what AURION actually registered",
  /CurrentVersion\\Uninstall/.test(checkInstall) &&
  /SystemComponent/.test(checkInstall) &&
  /AURION-Uninstall\.exe/.test(checkInstall) &&
  /Software\\AxiaSoft\\AURION/.test(checkInstall));

// The loading screen, the setup wizard and the uninstaller are three
// separate programs a customer meets weeks apart. The only thing that
// makes them read as one product is that they are drawn by the same
// code, so that is what is checked.
const aurora = read("installer/shell/shared/Aurora.cs");
check("one backdrop, shared by all three windows",
  /static void Paint\(Graphics g, int w, int h\)/.test(aurora) &&
  /Aurora\.Paint/.test(read("installer/shell/shared/Brand.cs")) &&
  /Aurora\.Paint/.test(read("installer/window/SplashPanel.cs")) &&
  /shell\\shared\\Aurora\.cs/.test(read("installer/window/AurionWindow.csproj")));

// Wide dark gradients band into visible arcs on an 8-bit display. A
// sparse dither breaks the steps up; it is drawn once, into the cached
// bitmap, so it costs nothing per frame.
check("the backdrop is dithered against banding, once",
  /static void Grain/.test(aurora) &&
  /new Random\(0x4155_5249\)/.test(aurora));

// Everything static goes into the cached bitmap. A mark drawn in OnPaint
// is the largest image in the window and repaints whenever any child
// invalidates.
check("the mark and its halo are cached, not painted per frame",
  /protected virtual void PaintBrand/.test(read("installer/shell/shared/Brand.cs")) &&
  /protected override void PaintBrand/.test(read("installer/shell/setup/SetupWindow.cs")) &&
  /protected override void PaintBrand/.test(read("installer/shell/uninstall/UninstallWindow.cs")) &&
  /Aurora\.Halo/.test(read("installer/window/SplashPanel.cs")));

// Captions change: "Install" becomes "Install what is missing" becomes
// "Try again"; "Remove" becomes "Remove everything". A fixed 150px button
// drew the long ones clipped mid-word, and a label with a hand-picked
// height clipped the bottom line of any sentence longer than the one it
// was measured against.
const brandCs = read("installer/shell/shared/Brand.cs");
check("buttons and labels are sized from their own text",
  /public void FitToText\(\)/.test(brandCs) &&
  /TextRenderer\.MeasureText/.test(brandCs) &&
  /public void Fit\(int maxLines = 4\)/.test(brandCs));
check("and the actions are laid out from the right margin, not pinned",
  /private void LayOutActions\(\)/.test(read("installer/shell/setup/SetupWindow.cs")) &&
  /private void LayOutActions\(\)/.test(read("installer/shell/uninstall/UninstallWindow.cs")));

// Closing either window mid-flight is how a machine ends up with a
// half-written installation, so it asks - in AURION's own window, since
// a grey system box at that moment gives back exactly what these
// programs exist to replace.
const askCs = read("installer/shell/shared/Ask.cs");
check("closing asks first, in AURION's own window",
  /class Ask : BrandForm/.test(askCs) &&
  /Ask\.Show\(this, "Leave setup\?"/.test(read("installer/shell/setup/SetupWindow.cs")) &&
  /Ask\.Show\(this, "Leave this alone\?"/.test(read("installer/shell/uninstall/UninstallWindow.cs")));

// Where a program puts itself and what it adds to the Start menu are not
// advanced questions, and an "Options" button is the shape you choose for
// settings you would rather nobody saw.
check("the wizard asks where it goes and how to reach it, in that order",
  /enum Page \{ Welcome = 0, Where = 1, Shortcuts = 2, Working = 3, Done = 4 \}/
    .test(read("installer/shell/setup/SetupWindow.cs")) &&
  /INSTALLFOLDER=/.test(read("installer/shell/setup/SetupWindow.cs")) &&
  // The button assignment, not the comment explaining why it is gone.
  !/_secondary\.Text = "Options"/.test(read("installer/shell/setup/SetupWindow.cs")));

// Showing the keep-or-delete choice again, under a title saying it is
// already done, reads as "did that not work?".
check("the uninstaller says goodbye rather than re-asking",
  /private void Farewell\(\)/.test(read("installer/shell/uninstall/UninstallWindow.cs")) &&
  /Goodbye, and thank you/.test(read("installer/shell/uninstall/UninstallWindow.cs")));

// ------------------------------------------------------- the setup wizard

// Windows Installer's dialogs take a banner bitmap and a licence page and
// nothing else: the typeface, the spacing, the buttons and the word
// "Setup" in the title bar stay Microsoft's. For a product whose entire
// first impression is that window, that is the wrong first impression.
const uninstallWindow = read("installer/shell/uninstall/UninstallWindow.cs");
const uninstallProgram = read("installer/shell/uninstall/Program.cs");
const uninstallProj = read("installer/shell/uninstall/AurionUninstall.csproj");
const setupWindow = read("installer/shell/setup/SetupWindow.cs");
const setupProgram = read("installer/shell/setup/Program.cs");
const setupProj = read("installer/shell/setup/AurionSetup.csproj");

check("there is a setup wizard with AURION's own interface",
  /class SetupWindow : BrandForm/.test(setupWindow) &&
  /AssemblyName>AURION-Setup</.test(setupProj));

// The MSI still installs. Only its dialogs are replaced, so upgrades,
// rollback, repair and Add or Remove Programs are untouched.
check("it drives the real MSI rather than replacing it",
  /Msi\.RunAsync\(\$"\/i \\"\{_msiPath\}\\"\{properties\}"/.test(setupWindow) &&
  /AURION\*\.msi/.test(setupProgram));

// Properties the MSI has always understood and nothing could set.
check("the wizard's choices reach the MSI",
  /AURION_WANT_STARTMENU=/.test(setupWindow) &&
  /AURION_WANT_DESKTOP=/.test(setupWindow) &&
  /AURION_SKIP_PROVISION=1/.test(setupWindow) &&
  /AURION_WANT_STARTMENU/.test(read("installer/src/Prerequisites.wxs")));

// Provisioning is left to the desk window's first start, which has a
// splash, a progress bar and an explanation. Letting the MSI do it too
// would mean two different-looking setups running back to back.
check("it does not race the desk window to set up the runtimes",
  /AURION_SKIP_PROVISION=1/.test(setupWindow) &&
  /StartAurion/.test(setupWindow));

check("the build produces it beside the package",
  /AurionSetup\.csproj/.test(buildMsi) &&
  /AURION-Setup\.exe was not produced/.test(buildMsi) &&
  /Signing the setup wizard failed/.test(buildMsi));

// It has no dependency on the MSI - it finds the .msi beside itself at
// run time. Building it last meant a C# mistake in it surfaced only after
// a four-minute MSI compile, and when that compile failed the wizard was
// never produced at all. The report was "I click AURION-Setup.exe and
// nothing happens", which was true: there was no such file.
check("the wizard is built with the other executables, not after the MSI",
  buildMsi.indexOf('Step "Building the setup wizard"') <
  buildMsi.indexOf('Step "Compiling MSI"'));

check("and the build ends by listing what it actually produced",
  /In \$outputDir/.test(buildMsi) &&
  /Get-ChildItem \$outputDir -File/.test(buildMsi));

// Both installers are drawn from one palette, so the program a user meets
// on day one and the one they meet a year later look like one product.
const brand = read("installer/shell/shared/Brand.cs");
const controls = read("installer/shell/shared/Controls.cs");
check("both installers share one visual language",
  /class BrandForm : Form/.test(brand) &&
  /class ChoiceCard : Control/.test(controls) &&
  /Compile Include="\.\.\\shared\\\*\.cs"/.test(setupProj) &&
  /Compile Include="\.\.\\shared\\\*\.cs"/.test(uninstallProj));

// ------------------------------------------------------ the uninstaller

// Windows Installer's own uninstall is an unnamed progress bar, and it has
// no way to ask the only question that matters here: whether four years of
// trade history goes with the application.
check("there is an uninstaller with AURION's own interface",
  /class UninstallWindow : BrandForm/.test(uninstallWindow) &&
  /AssemblyName>AURION-Uninstall</.test(uninstallProj));
check("it asks whether the trading data goes too, and keeps it by default",
  /Keep my trading data/.test(uninstallWindow) &&
  /AURION_REMOVE_DATA=all/.test(uninstallWindow) &&
  /_keep\.Selected = true/.test(uninstallWindow) &&
  /AURION_REMOVE_DATA/.test(actions));

// Rewriting Windows Installer's own UninstallString with a custom action
// lost the race: Control Panel went on calling msiexec and the
// uninstaller never appeared. AURION hides that entry and writes its own
// as an ordinary component, which is transactional, rolls back and is
// removed on uninstall - and cannot be raced.
const registry = read("installer/src/Registry.wxs");
check("Control Panel is pointed at it by an entry AURION owns",
  /ARPSYSTEMCOMPONENT" Value="1"/.test(read("installer/src/Package.wxs")) &&
  registry.includes("CurrentVersion\\Uninstall\\$(var.ProductName)") &&
  /Name="UninstallString"[\s\S]{0,120}AURION-Uninstall\.exe/.test(registry) &&
  !/AurionOwnUninstallEntry/.test(actions));

// A scripted removal must stay scripted, and Change must still reach
// Windows Installer, which is the thing that knows how to add features.
check("the hand-written entry keeps the parts Windows did better",
  /Name="QuietUninstallString"[\s\S]{0,120}MsiExec\.exe \/x/.test(registry) &&
  /Name="ModifyPath"[\s\S]{0,120}MsiExec\.exe \/i/.test(registry));

// Both earlier attempts deduced the ProductCode from the registry, and
// both broke: the uninstaller told a machine with AURION plainly
// installed that it was not installed. MsiEnumRelatedProducts asks the
// installer database, which is the same question Windows Installer asks
// itself and cannot be out of date.
const msiCs = read("installer/shell/shared/Msi.cs");
check("the uninstaller asks Windows Installer, not the registry",
  /MsiEnumRelatedProductsW/.test(msiCs) &&
  /DllImport\("msi\.dll"/.test(msiCs) &&
  msiCs.indexOf("MsiEnumRelatedProductsW(UpgradeCode") <
  msiCs.indexOf('OpenSubKey(@"Software'));

// The registry remains a fallback for a damaged registration.
check("and still keeps a fallback the MSI writes",
  /Name="ProductCode"\s+Type="string" Value="\[ProductCode\]"/.test(registry) &&
  msiCs.includes("Software\\AxiaSoft\\AURION") &&
  /GetValue\("ProductCode"\)/.test(msiCs));

// A constant in two places is a constant that will drift.
{
  const props = read("installer/Version.props");
  const inProps = /<AurionUpgradeCode>(\{[^<]+\})<\/AurionUpgradeCode>/.exec(props);
  const inCode = /UpgradeCode = "(\{[^"]+\})"/.exec(msiCs);
  check("the uninstaller's upgrade code is the one the MSI is built with",
    inProps !== null && inCode !== null && inProps[1] === inCode[1],
    inProps && inCode ? `${inCode[1]}` : "not found in both");
}

// It lives in the folder Windows Installer is about to delete.
check("it copies itself out before deleting the folder it lives in",
  /RelaunchFromTemp/.test(uninstallProgram) &&
  /--relaunched/.test(uninstallProgram));

// /qn says nothing at all, and a progress bar that cannot move is the
// thing people kill. Windows Installer narrates itself to its own log.
check("a silent msiexec is still made to show its work",
  /Action\\s\+\[\\d:\]\+/.test(read("installer/shell/shared/Msi.cs")) &&
  /FileShare\.ReadWrite \| FileShare\.Delete/.test(read("installer/shell/shared/Msi.cs")));

check("the build produces it into the payload",
  /AurionUninstall\.csproj/.test(buildMsi) &&
  /AURION-Uninstall\.exe was not produced/.test(buildMsi));

// ------------------------------------------- the setup screen stays alive

// The bundle exists so the machine needs no network. Running `pip install
// --upgrade pip` immediately before using it is a contradiction, and on a
// machine that genuinely has no network it is where setup appeared to
// hang: pip retries and backs off for a minute behind the words
// "Updating pip...".
// Now stronger than skipping it when the bundle is present: the upgrade is
// gone. A machine that cannot reach PyPI spent its first network attempt on
// the one package it did not need, and inherited that failure. pip is only
// ever installed - from ensurepip, then the bundled get-pip.py - and only
// when it is genuinely absent.
check("pip is not upgraded over a network the bundle exists to avoid",
  !/pip install --upgrade pip/.test(prereqCs) &&
  /static async Task EnsurePipAsync/.test(prereqCs) &&
  /if \(PipWorks\(exe, args\)\) return;/.test(prereqCs));
check("and pip is never left waiting for input or a version check",
  /--no-input --disable-pip-version-check/.test(prereqCs));

// pip and npm narrate their work; a setup screen that does not show it is
// indistinguishable from a frozen one for the several minutes they take.
check("long tools are shown saying what they are doing",
  /IProgress<string>\? tail = null/.test(prereqCs) &&
  /BeginOutputReadLine\(\)/.test(prereqCs) &&
  /TimeSpan\.FromMilliseconds\(400\)/.test(prereqCs));

// python-3.12.7-amd64.exe is run with /quiet and prints nothing for one to
// three minutes. A static line for three minutes is a hang to anyone
// watching, and the usual response is to kill it mid-install.
check("and the silent ones at least show a clock",
  /WithHeartbeat/.test(prereqCs) &&
  /Installing Python into AURION's own folder", say, ct/.test(prereqCs) &&
  /Unpacking Node\.js", say, ct/.test(prereqCs) &&
  /Installing the WebView2 runtime", say, ct/.test(prereqCs));

// The relay above was reported through a Progress<string>, whose callback
// runs on the thread that created it: the UI thread. Every line therefore
// did a CreateDirectory and an open-append-close from the message loop.
// Fine for the six lines setup used to produce; fatal at five a second for
// several minutes on a machine where Defender scans every write. The fix
// for a frozen screen had frozen the screen.
check("the setup log is written off the UI thread, on one open handle",
  /private sealed class Recorder : IProgress<string>, IDisposable/.test(prereqCs) &&
  /AutoFlush = true/.test(prereqCs) &&
  !/File\.AppendAllText\(/.test(prereqCs) &&
  /_screen\.Report\(value\)/.test(prereqCs));
check("and a stack trace goes to the file without crossing the screen",
  /public void Log\(string value\)/.test(prereqCs) &&
  /recorder\.Log\(\$"\{req\.Id\}: FAILED/.test(prereqCs));

// ------------------------------------------------- the window stays alive

// The splash drew a full-window gradient, two radial glows, three freshly
// created Fonts and three MeasureString calls sixty-two times a second. On
// a developer's machine that is invisible; on a bare VM with no graphics
// acceleration it saturates the core the message loop runs on, and Windows
// writes "not responding" across the title bar while the work it is
// waiting for proceeds perfectly well on a background thread.
const splash = read("installer/window/SplashPanel.cs");
check("the splash builds its fonts and brushes once, not per frame",
  !/new Font\(/.test(splash.split("OnPaint")[1] || "") &&
  /private readonly Font _titleFont/.test(splash) &&
  /private readonly SolidBrush _inkBrush/.test(splash));
check("the parts that never move are drawn once into a bitmap",
  /private Bitmap\? _backdrop/.test(splash) &&
  /BuildBackdrop\(w, h\)/.test(splash) &&
  /DrawImageUnscaled\(_backdrop/.test(splash));
check("and only the strip that animates is invalidated",
  /Invalidate\(AnimatedStrip\(\)\)/.test(splash) &&
  /Interval = 33/.test(splash) &&
  /if \(Visible\) _ticker\.Start\(\); else _ticker\.Stop\(\);/.test(splash));

// py.exe is an app execution alias on a machine with no Python: launching
// it opens the Store instead of answering, so all three probes ran to
// their timeout for nothing.
check("hopeless probes are not attempted at all",
  /if \(!IsStoreAlias\(WhereIs\("py"\)\)\)/.test(prereqCs) &&
  /NodeVersionAsync\(installDir, nodeCommand\)/.test(prereqCs));

// InspectAsync was async, but everything it did first was not: three
// `py -3.1x` probes, a `where python`, a `python --version`, then the same
// for Node - all on the thread that paints the window. On a bare machine
// every one runs to its timeout, so the setup panel appeared unpainted and
// Windows marked AURION "not responding" for most of a minute.
check("nothing probes the machine on the UI thread",
  /var \(python, nodeCommand, pythonVersion\) = await Task\.Run/.test(prereqCs) &&
  /var py = FindPython\(installDir\);/.test(prereqCs));
check("probes fail fast and do not leak a hung process",
  !/WaitForExit\(8000\)/.test(prereqCs) && !/WaitForExit\(5000\)/.test(prereqCs) &&
  /if \(!p\.WaitForExit\(4000\)\)/.test(prereqCs) &&
  /p\.Kill\(entireProcessTree: true\)/.test(prereqCs));
check("and hashing 28 MB does not freeze the progress it is reporting",
  /await Task\.Run\(\(\) => VerifyAgainstSums/.test(prereqCs));

// app.manifest declares PerMonitorV2, but ApplicationConfiguration's
// generated default is SystemAware and nothing set AutoScaleMode. At 125%
// or 150% the panels were laid out for 96 DPI: cramped, clipped and
// overlapping, which reads as a window that has not finished loading.
const windowCsproj = read("installer/window/AurionWindow.csproj");
// Panel derives from ScrollableControl, not ContainerControl, so it has no
// AutoScaleMode at all - setting it there was a compile error. The form's
// scaling propagates to its children regardless.
check("the window scales with the display",
  /AutoScaleMode = AutoScaleMode\.Dpi/.test(appWindow) &&
  !/AutoScaleMode =/.test(setupPanel));

// Declaring DPI awareness in both places is warning WFAC010, and the
// manifest is the half WinForms cannot see: the loader applies it before
// any managed code runs, so WinForms lays out for 96 DPI anyway.
check("DPI awareness is declared once, where WinForms can act on it",
  /<ApplicationHighDpiMode>PerMonitorV2<\/ApplicationHighDpiMode>/.test(windowCsproj) &&
  !/dpiAware/.test(read("installer/window/app.manifest")));

// ------------------------------------- AURION brings its own interpreters

// The engine is pinned to NumPy 1.26.4 - the last official Windows wheel
// that does not require x86-64-v2 - and that wheel exists only for CPython
// 3.9 to 3.12. Following whatever Python the machine has meant that
// upgrading it, an ordinary thing to do, silently broke the engine.
check("Python is installed inside AURION, not into the machine",
  /PrivatePython/.test(prereqCs) &&
  /TargetDir=/.test(prereqCs) &&
  /runtime\\python/.test(provisionPs1) &&
  /TargetDir=\$target/.test(provisionPs1));
check("and it takes nothing over on the way in",
  /PrependPath=0/.test(prereqCs) && /AssociateFiles=0/.test(prereqCs) &&
  /Include_launcher=0/.test(prereqCs) &&
  /PrependPath=0/.test(provisionPs1) && /Include_launcher=0/.test(provisionPs1));
check("every consumer looks for AURION's own interpreter first",
  /PrivatePython\(installDir\)/.test(prereqCs) &&
  startCmd.includes("runtime\\python\\python.exe") &&
  provisionPs1.includes('runtime\\python\\python.exe'));
check("a quoted interpreter path survives being split into exe and args",
  /command\.StartsWith\('"'\)/.test(prereqCs));
check("and the uninstall takes the private Python with it",
  /AurionRemovePrivatePython/.test(actions) &&
  /\/quiet \/uninstall/.test(actions) &&
  /Before="RemoveFiles"[\s\S]{0,120}AurionRemovePrivatePython|AurionRemovePrivatePython[\s\S]{0,160}Before="RemoveFiles"/.test(actions));

// %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is an app execution
// alias, not an interpreter: it resolves only inside an interactive session
// belonging to the user who installed it, redirects writes away from
// site-packages, and started detached through wscript it exits without
// producing output or a log. One machine had it recorded in runtime.env and
// believed ever since - engine and desk wrote nothing, launcher returned 1.
// FIND parses its arguments with C runtime rules, so the backslash in
// "\WindowsApps\" escaped the closing quote and the search string arrived
// unterminated. The subroutine it lived in also cost the launcher exit
// code 255. Both are gone: plain cmd substring removal, no label, no pipe.
check("the Microsoft Store's Python is refused everywhere",
  /IsStoreAlias/.test(prereqCs) &&
  provisionPs1.includes('-notlike "*\\WindowsApps\\*"') &&
  startCmd.includes("%AURION_PY:WindowsApps=%") &&
  !/find \/i/.test(startCmd) && !/USABLEPY/.test(startCmd));

// `reg query` returns REG_EXPAND_SZ raw, so the registry PATH arrives
// containing the literal text %SystemRoot%\system32 and cmd will not expand
// it a second time. Assigning that over PATH replaced a working PATH with a
// list of placeholders: nothing could be found at all, including
// powershell.exe, and the launcher exited 9009.
check("the PATH handed to the launcher keeps what this process had",
  /parts\.Insert\(0, Environment\.GetEnvironmentVariable\("PATH"\)/.test(appWindow) &&
  /"runtime", "python"\)/.test(appWindow));
check("refreshing the PATH appends to it and never replaces it",
  !/set "PATH=%MACHINE_PATH%/.test(startCmd) &&
  startCmd.includes('set "PATH=%PATH%;%MACHINE_PATH%"') &&
  startCmd.includes('set "PATH=%PATH%;%USER_PATH%"') &&
  /\$env:PATH = \(@\(\$env:PATH\)/.test(provisionPs1));
check("and Windows' own tools are found without the PATH at all",
  /set "PS=%SystemRoot%\\System32\\WindowsPowerShell/.test(startCmd) &&
  /set "CSCRIPT=%SystemRoot%\\System32\\cscript\.exe"/.test(startCmd) &&
  !/^powershell -NoProfile/m.test(startCmd) &&
  !/^cscript \/\/nologo/m.test(startCmd));

// Every path out of the launcher now leaves a line behind. Without this a
// failure before the engine starts produces no log at all, anywhere.
check("the launcher records what it chose, as it chooses it",
  /\[launcher\] python: %PYCMD%/.test(startCmd) &&
  /\[launcher\] node: %NODECMD%/.test(startCmd) &&
  /no usable Python found/.test(startCmd) &&
  /prerequisites satisfied, starting/.test(startCmd));
check("AURION's own interpreter outranks the one in runtime.env",
  startCmd.indexOf("runtime\\python\\python.exe") < startCmd.indexOf("if defined AURION_PY"));
check("and a stale runtime.env can no longer pin a bad choice forever",
  /\$env:AURION_PY -notlike/.test(provisionPs1));

// When nothing started, setup.log is the only account of what happened.
check("the failure box reads setup.log when the other two are empty",
  /NewIn\("setup\.log", 8\)/.test(appWindow) &&
  /"engine\.log", "desk\.log", "setup\.log"/.test(appWindow));

// ------------------------------------------- nothing fetched on their machine

// The customer's machine is the worst possible place to be discovering a
// proxy or a blocked vendor domain: nobody can log into it and the only
// symptom is a desk that does not start. Fetch on the build machine instead.
check("the build collects the runtimes so the MSI can carry them",
  /python-\$PythonVersion-amd64\.exe/.test(vendorPs1) &&
  /node-\$NodeVersion-win-x64\.zip/.test(vendorPs1) &&
  /MicrosoftEdgeWebview2Setup\.exe/.test(vendorPs1) &&
  /pip download/.test(vendorPs1));
check("bundling is on by default and the build wires it in",
  /\[switch\] \$NoBundle/.test(buildMsi) && /fetch-vendor\.ps1/.test(buildMsi) &&
  /if \(\$NoBundle\)/.test(buildMsi));
check("the payload carries the bundle",
  /vendor/.test(stagePs1) && /Join-Path \$appDir "vendor"/.test(stagePs1));

// Filenames are the contract between the three. They have to agree exactly.
check("the three sides agree on what the bundled files are called",
  vendorPs1.includes("3.12.7") && vendorPs1.includes("v20.17.0") &&
  prereqCs.includes('PythonFullVersion = "3.12.7"') &&
  prereqCs.includes('NodeVersion = "v20.17.0"') &&
  provisionPs1.includes('$PythonVersion   = "3.12.7"') &&
  provisionPs1.includes('"python-$PythonVersion-amd64.exe"') &&
  provisionPs1.includes("v20.17.0"));

check("the installed app prefers the bundle over the network",
  /Bundled\(installDir, PythonExeName\)/.test(prereqCs) &&
  /Bundled\(installDir, NodeZipName\)/.test(prereqCs) &&
  /Bundled\(installDir, "MicrosoftEdgeWebview2Setup\.exe"\)/.test(prereqCs) &&
  // by its own operands, not by the bare flag: there are two --no-index
  // commands here now and a substring test is satisfied by either one
  /--no-index --find-links \\"\{wheels\}\\" -r \\"\{requirements\}\\"/.test(prereqCs));
check("and so does the script, for an install that is already on a machine",
  /Get-Bundled/.test(provisionPs1) &&
  // the flags travel as separate argv elements now, so a path with a space
  // in it cannot be split in half by the shell
  /"--no-index", "--find-links", \$wheels/.test(provisionPs1));

// A bundled file is still checked - a bundle is only as good as the build
// that made it - but a failed check must not delete part of the install.
check("bundled runtimes are still verified",
  /SignedBy\(file, PythonPublisher\)/.test(prereqCs) &&
  /VerifyAgainstSums\(zip/.test(prereqCs) &&
  /Assert-LocalChecksum/.test(provisionPs1));
check("but a bad bundled file is not deleted out of the installation",
  /Only a \*downloaded\* file is deleted/.test(prereqCs) &&
  /Never deletes: this/.test(provisionPs1));

// No bundle must still work. A build with -NoBundle, or an older MSI, falls
// back to the network exactly as before.
check("an unbundled build still falls back to downloading",
  /DownloadAsync\(PythonUrl/.test(prereqCs) &&
  /DownloadAsync\(NodeZipUrl/.test(prereqCs) &&
  /vendor\\ is absent/.test(stagePs1));

// An interpreter under "C:\\Program Files" came back from WScript.Arguments
// as three words and the desk never started.
check("hidden.vbs re-quotes arguments that contain spaces",
  /InStr\(arg, " "\) > 0/.test(hiddenVbs));

// ---------------------------------------------------------------------------
// "The libraries are missing and it will not install them"
// ---------------------------------------------------------------------------
// The report that produced this section, from window.log on a bare machine:
//
//     == AURION setup
//     Python is already here: ...\runtime\python\python.exe
//     [launcher] that Python cannot import fastapi, numpy and sklearn
//
// and nothing else - no pip, no error, no line after it, and an engine that
// never started. Setup had died one statement after saying the interpreter
// was there: the check that decides whether to install the libraries.
//
// Two faults, both of them only in the case that matters (AURION's own
// interpreter is a one-element argv array):
//
//   * $Python[1..($Python.Length - 1)] with one element evaluates 1..0, and
//     PowerShell reads that as the *descending* range 1, 0 - so the command
//     was "python.exe <nothing> <python.exe> -c ...", which exits 2.
//   * $ErrorActionPreference = "Stop" plus a native program writing to
//     stderr is a terminating error in Windows PowerShell 5.1, and 2>$null
//     does not prevent it. A failing "import numpy" writes a traceback to
//     stderr, so the check killed the script instead of reporting a library.
const fixNumpy = read("scripts/fix-numpy.ps1");

check("the interpreter's argv is never sliced with 1..(Length-1)",
  !/\[1\.\.\(\$Python\.Length - 1\)\]/.test(provisionPs1) &&
  !/\[1\.\.\(\$Python\.Length - 1\)\]/.test(fixNumpy) &&
  // where a range is still used it is behind a count check, which makes the
  // one-element case an empty array rather than a descending one
  /\$Python\.Count -gt 1/.test(provisionPs1) &&
  /\$Python\.Count -gt 1/.test(fixNumpy));

check("a child writing to stderr cannot end setup",
  /function Invoke-Program/.test(provisionPs1) &&
  /function Invoke-PythonCaptured/.test(provisionPs1) &&
  /\$ErrorActionPreference = "Continue"/.test(provisionPs1) &&
  /\$ErrorActionPreference = \$previous/.test(provisionPs1) &&
  !/& py "-\$v" -c "import sys" 2>\$null/.test(provisionPs1));

check("setup writes down why it stopped, and exits non-zero",
  /^trap \{/m.test(provisionPs1) &&
  /SETUP STOPPED/.test(provisionPs1) &&
  /exit 1/.test(provisionPs1));

check("the engine's libraries are installed, not merely noticed",
  /function Install-EngineLibraries/.test(provisionPs1) &&
  /Install-EngineLibraries -Python \$python -Requirements \$requirements/.test(provisionPs1) &&
  /"-m", "pip", "install", "-r", \$Requirements/.test(provisionPs1) &&
  /function Test-EngineImports/.test(provisionPs1));

check("and are proven by importing them afterwards",
  /\$check = Test-EngineImports -Python \$Python/.test(provisionPs1) &&
  /still do not import/.test(provisionPs1) &&
  // the same question decides whether the machine is "ready" at all
  /if \(\$engineLibsFailed\) \{\s*\$ready = \$false/.test(provisionPs1));

check("pip is set up when the interpreter has none",
  /function Enable-Pip/.test(provisionPs1) &&
  /ensurepip/.test(provisionPs1) &&
  /Get-Bundled \$GetPipName/.test(provisionPs1) &&
  /bootstrap\.pypa\.io/.test(provisionPs1) &&
  /EnsurePipAsync/.test(prereqCs) &&
  /ensurepip --upgrade --default-pip/.test(prereqCs));

check("the window asks for pip before it asks pip for anything",
  prereqCs.indexOf("await EnsurePipAsync") > 0 &&
  prereqCs.indexOf("await EnsurePipAsync") < prereqCs.indexOf("-m pip install -r"));

check("a filtered network has somewhere to be named",
  /AURION_PIP_INDEX_URL/.test(provisionPs1) &&
  /AURION_PIP_INDEX_URL/.test(prereqCs) &&
  /AURION_PIP_INDEX_URL/.test(fixNumpy) &&
  /--index-url/.test(prereqCs));

check("a failed pip says what to do about it",
  /function Explain-PipFailure/.test(provisionPs1) &&
  /CERTIFICATE_VERIFY_FAILED/.test(provisionPs1) &&
  /vendor\\wheels/.test(provisionPs1));

check("npm's warnings cannot end setup either",
  /Invoke-Program -Program \$node/.test(provisionPs1) &&
  !/& \$node \$cli install/.test(provisionPs1));

check("a machine with no bundle can still be given a Python and a pip",
  /Get-File -Url \$PythonZipUrl/.test(provisionPs1) &&
  /Get-File -Url \$GetPipUrl/.test(provisionPs1));

// ------------------------------------------------------- the launcher's half

check("the launcher names which engine libraries are missing",
  /set "LIBSPROBLEM=1"/.test(startCmd) &&
  /:NAMEMISSINGLIBS/.test(startCmd) &&
  /find_spec/.test(startCmd) &&
  /the engine's libraries are not installed/.test(startCmd));

check("and that line reaches the failure box",
  /if defined LIBSPROBLEM >> "data\\logs\\desk\.log" echo   - the engine's Python libraries are missing: %MISSINGLIB%/.test(startCmd) &&
  /data\\logs\\setup\.log/.test(startCmd));

check("the launcher records what setup did with its exit code",
  /set "SETUPCODE=%errorlevel%"/.test(startCmd) &&
  /setup stopped with code %SETUPCODE%/.test(startCmd));

// ------------------------------------------------------ the hand repair path

// start-aurion.cmd and the engine both point a stuck user at fix-numpy.ps1.
// It used to run `python -m pip`, which on this machine is either absent or
// the Microsoft Store alias - a repair script that repairs the wrong
// interpreter and reports success.
check("the hand repair uses the interpreter AURION runs on",
  /runtime\\python\\python\.exe/.test(fixNumpy) &&
  /function Find-Python/.test(fixNumpy) &&
  !/^python -m pip/m.test(fixNumpy));

check("and refuses the Microsoft Store alias, like everything else",
  /WindowsApps/.test(fixNumpy) &&
  /\$recorded -notlike/.test(fixNumpy));

check("and proves the result instead of claiming it",
  /import fastapi, numpy, sklearn, pandas, scipy, uvicorn/.test(fixNumpy) &&
  /exit 1/.test(fixNumpy));

// ------------------------------------------------- a bundle that is actually whole

// The four things AURION runs on used to be downloaded on the customer's
// machine. Bundling them moved that to the build machine, but left the
// expensive half behind: the installer still ran pip over ninety megabytes of
// wheels on a laptop it could not see, and a wheel that would not unpack there
// was a support call. prepare-runtime.ps1 does that work once, where a failure
// is visible, and ships the result: the interpreter arrives with the engine's
// libraries already inside it.

check("one file name, in every place that has to agree on it",
  /"runtime-python\.zip"/.test(prepareRuntime) &&
  /private const string RuntimePythonZipName = "runtime-python\.zip"/.test(prereqCs) &&
  /\$RuntimeZipName\s*=\s*"runtime-python\.zip"/.test(provisionPs1) &&
  /runtime-python\.zip/.test(stagePs1) &&
  /runtime-python\.zip/.test(buildMsi));

check("the runtime is filled from the wheels the build carries, never from PyPI",
  /--no-index/.test(prepareRuntime) &&
  /--find-links/.test(prepareRuntime) &&
  /requirements\.txt/.test(prepareRuntime) &&
  !/pypi\.org/.test(prepareRuntime) &&
  /fetch-vendor\.ps1/.test(prepareRuntime));

check("and it is proven by importing, in isolation, before it is packaged",
  /Arguments @\("-I", "-c", \$imports\)/.test(prepareRuntime) &&
  /import sys, fastapi, uvicorn, numpy, pandas, scipy, sklearn/.test(prepareRuntime) &&
  prepareRuntime.indexOf('@("-I", "-c", $imports)') < prepareRuntime.indexOf("CreateFromDirectory"),
  "-I: no PYTHONPATH, no user site - what imports is what is in the zip");

check("the zip unpacks straight into runtime\\python",
  /::Optimal, \$false\)/.test(prepareRuntime));

check("the Visual C++ runtime travels next to python.exe",
  /vcruntime140\.dll/.test(prepareRuntime) &&
  /msvcp140\.dll/.test(prepareRuntime));

check("the vendor fetch builds the runtime, and the terminal's own package",
  /prepare-runtime\.ps1/.test(vendorPs1) &&
  /-SkipRuntime/.test(vendorPs1) &&
  /pip download "MetaTrader5"/.test(vendorPs1));

check("the setup window unpacks the runtime instead of installing a Python",
  /Bundled\(installDir, RuntimePythonZipName\)\.Length > 0/.test(prereqCs) &&
  prereqCs.indexOf("Bundled(installDir, RuntimePythonZipName).Length > 0") <
    prereqCs.indexOf("await DownloadAsync(PythonUrl"));

// This used to pin `if (!PipWorks(exe, ""))` inside UnpackPythonAsync.
// That line is gone on purpose: having a second place that bootstrapped
// pip is what let the get-pip-goes-to-PyPI bug survive in one of them
// after the other was fixed. UnpackPythonAsync now delegates, and the
// behaviour this guard exists for - never run get-pip over a working
// pip - is the first line of the routine it delegates to.
check("and does not run get-pip over a pip that is already there",
  /private static async Task EnsurePipAsync\([\s\S]{0,400}?if \(PipWorks\(exe, args\)\) return;/.test(prereqCs));

check("and does not run pip over libraries that are already installed",
  /if \(await ImportsWorkAsync\(PythonCommand, ct\)\)/.test(prereqCs));

check("the console provisioner takes the same shortcut",
  /elseif \(Get-Bundled \$RuntimeZipName\)/.test(provisionPs1) &&
  provisionPs1.indexOf("elseif (Get-Bundled $RuntimeZipName)") <
    provisionPs1.indexOf("Get-File -Url $PythonUrl"));

check("staging refuses a vendor folder that would put pip on the customer's machine",
  /runtime-python\.zip/.test(stagePs1) &&
  /-AllowIncompleteVendor/.test(stagePs1) &&
  /missing runtime-python\.zip/.test(stagePs1));

check("and does not ship the interpreter's installers beside the ready runtime",
  /python-\*-amd64\.exe/.test(stagePs1) &&
  /python-\*-embed-amd64\.zip/.test(stagePs1));

check("a release build without the runtime fails instead of shipping quietly",
  /\$needed \+= "runtime-python\.zip"/.test(buildMsi) &&
  /needed to bundle the engine's/.test(buildMsi));

check("the installed copy prefers the wheels it carries over PyPI",
  /--find-links/.test(startPs1) &&
  /vendor\\wheels/.test(startPs1));

check("CI has a Python to collect the wheels, and keeps the bundle between runs",
  /setup-python/.test(ciBuild) &&
  /actions\/cache/.test(ciBuild) &&
  /installer\/vendor/.test(ciBuild));
/* ============================================================== * The engine's libraries, and the button that gave up on them.
 *
 * From a bare machine: "pydeps" missing four times in a row, on an
 * installation whose Python was present and working. What the window
 * said was "Setup stopped: python.exe finished with code 1". What pip
 * said - the only account of WHY - went to a throttled label that was
 * then repainted, and was written nowhere at all. And after the first
 * attempt the install button disappeared, because it was shown for
 * items that were Missing and a tried-and-failed item is Failed.
 *
 * So: the failure is written down, the failure is named, the retry
 * tries something different, and the button survives failing.
 * =================================================================== */

const fetchVendor = read("installer/tools/fetch-vendor.ps1");

check("a failed attempt still offers to try again",
  /_install\.Visible = missing \+ failed > 0;/.test(setupPanel) &&
  !/_install\.Visible = missing > 0;/.test(setupPanel),
  "the button used to vanish the moment the only missing item became a failed one");

check("the reason fits on the row that carries it",
  /Height = failed \? 112 : 66/.test(setupPanel) &&
  /failed \? 70 : 26/.test(setupPanel),
  "a one-line label clipped the diagnosis to its first few words");

check("there is a door to the log, not an instruction to go hunting",
  /LogsRequested/.test(setupPanel) &&
  /_logs\.Visible = failed > 0;/.test(setupPanel) &&
  /setup\.LogsRequested \+=/.test(appWindow) &&
  /"data", "logs"/.test(appWindow));

check("pip's own output is captured in full, not sampled",
  /private static async Task<\(int Code, string Output\)> RunCapturedAsync/.test(prereqCs) &&
  /RedirectStandardOutput = true/.test(prereqCs));

check("and every attempt is written to the setup log, in full",
  /LogOnly\(say, \$"-- attempt \{i \+ 1\}\/\{attempts\.Count\}: \{label\} -> exit \{code\}", output\);/.test(prereqCs) &&
  /if \(say is not Recorder recorder\) return;/.test(prereqCs),
  "through the handle the Recorder already holds, not a second opener of the same file");

check("the failure is named rather than numbered",
  /ExplainPipFailure/.test(prereqCs) &&
  /failed to establish a new connection/.test(prereqCs) &&
  /no matching distribution found/.test(prereqCs) &&
  /microsoft visual c\\\+\\\+/i.test(prereqCs),
  "network, wrong Python and no-compiler are three different problems");

check("a retry escalates instead of repeating the same command",
  /var attempts = new List<\(string Label, string Args\)>\(\);/.test(prereqCs) &&
  /--no-index --find-links \\"\{wheels\}\\" -r \\"\{requirements\}\\"/.test(prereqCs) &&
  /ConfiguredIndexUrl/.test(prereqCs),
  "bundled copies, then PyPI, then a mirror if one is configured");

check("PyPI is never allowed to offer source code to a machine with no compiler",
  (prereqCs.match(/--only-binary=:all:/g) || []).length >= 2);

check("a mirror is something you choose, never a default",
  /AURION_PIP_INDEX/.test(prereqCs) &&
  /pip_index_url/.test(prereqCs) &&
  !/index-url\s+"https:\/\/(?!\{)/.test(prereqCs),
  "shipping somebody else's index as the default source of the engine is a supply-chain decision");

check("an interpreter that cannot see its own packages is repaired, not reinstalled",
  /RepairPrivatePythonPath\(installDir, say\);/.test(prereqCs) &&
  /Lib\\\\site-packages/.test(prereqCs),
  "the embeddable build ships with site-packages switched off");

check("success is proved by importing, not by pip's exit code",
  /if \(await ImportsWorkAsync\(PythonCommand, ct\)\)/.test(prereqCs) &&
  /pip reported success but the imports still fail/.test(prereqCs));

// A console repair already exists and is better placed than a second copy
// of it would be: provision.ps1 is what start-aurion.cmd runs when the desk
// cannot start, and it repairs ._pth, installs pip, prefers vendor\wheels
// and verifies the imports - the same four steps, on the installation that
// is already broken and cannot wait for the next build.
check("the console repair does the same four things in the same order",
  /python\*\._pth/.test(provisionPs1) &&
  /get-pip\.py/.test(provisionPs1) &&
  /"--no-index", "--find-links"/.test(provisionPs1) &&
  /import fastapi, numpy, sklearn/.test(provisionPs1));
check("...and leaves its evidence where the window does",
  /data\\logs\\setup\.log/.test(provisionPs1) &&
  /setup\.log/.test(prereqCs));

// The bundle is what makes a bare machine work at all. It shipped without
// the wheels because losing them was a yellow line of text on the build
// machine.
check("a build cannot quietly ship without the engine's libraries",
  /throw \("No Python on this build machine, so the engine's wheels cannot be collected/.test(fetchVendor) &&
  /throw \("pip download failed with code \$code, so the engine's wheels are not in the bundle/.test(fetchVendor),
  "it used to say 'continuing without wheels' and carry on");

check("and the completeness check counts them",
  /\$wheelCount/.test(buildMsi) &&
  /-not \$SkipWheels -and \$wheelCount -lt 1/.test(buildMsi));

check("shipping without them is still possible, but only on purpose",
  /-SkipWheels/.test(fetchVendor) && /-SkipWheels/.test(buildMsi));

/* =====================================================================
 * "python.exe is not recognized as the name of a cmdlet"
 *
 * A real build log. Every phase of prepare-runtime.ps1 ran - the
 * interpreter was unpacked, get-pip installed pip with it, pip installed
 * ninety megabytes of libraries with it - and then the verification step
 * stopped with PowerShell's way of saying "that file does not exist",
 * naming the interpreter it had been using all along. Wrapped by
 * build-msi as "missing: runtime-python.zip", which points at the
 * output rather than the cause.
 *
 * Nothing in the script deletes the interpreter. Two things outside it
 * do: an antivirus quarantine, and a second build in the same tree. The
 * script now names both, and makes the second one impossible.
 * =================================================================== */

check("a vanished interpreter is diagnosed, not reported as a typo",
  /function Assert-Interpreter \{/.test(prepareRuntime) &&
  /The interpreter is gone: \$exe/.test(prepareRuntime) &&
  /Get-MpThreat/.test(prepareRuntime) &&
  /Add-MpPreference -ExclusionPath/.test(prepareRuntime),
  "the message has to carry the next command, not just the bad news");

check("every python run checks it first",
  /function Invoke-PythonRaw \{/.test(prepareRuntime) &&
  /Invoke-PythonRaw[\s\S]{0,200}Assert-Interpreter -Phase \$Phase/.test(prepareRuntime) &&
  // Every raw invocation lives inside Invoke-PythonRaw - the first attempt
  // and the retry after a repair. A call site anywhere else is another
  // place that can fail incomprehensibly.
  (() => {
    const all = (prepareRuntime.match(/& \$exe /g) || []).length;
    const body = prepareRuntime.slice(
      prepareRuntime.indexOf("function Invoke-PythonRaw {"),
      prepareRuntime.indexOf("function Invoke-Python {"));
    const inside = (body.match(/& \$exe /g) || []).length;
    return all > 0 && all === inside;
  })());

check("and the phase that failed is named",
  /Assert-Interpreter -Phase "the trimming step"/.test(prepareRuntime) &&
  /Assert-Interpreter -Phase "packaging"/.test(prepareRuntime) &&
  /-Phase "verifying the runtime"/.test(prepareRuntime));

check("CommandNotFound is translated instead of being allowed through",
  /catch \[System\.Management\.Automation\.CommandNotFoundException\]/.test(prepareRuntime));

// How a missing interpreter could be reported three phases late: the earlier
// phases read a success that belonged to whatever ran before them.
check("a stale exit code cannot be read as a success",
  /\$global:LASTEXITCODE = -1/.test(prepareRuntime) &&
  /\$code = \$LASTEXITCODE/.test(prepareRuntime));

check("two builds cannot unpack the same tree at once",
  /aurion-prepare-runtime-\$lockKey\.pid/.test(prepareRuntime) &&
  /Another build is already building the runtime in this tree/.test(prepareRuntime) &&
  /Get-Process -Id \$previousPid/.test(prepareRuntime),
  "the first thing the unpack does is delete the folder the other one is using");

check("the lock is keyed by a hash that survives leaving the process",
  /MD5\]::Create\(\)\.ComputeHash/.test(prepareRuntime) &&
  !/GetHashCode\(\)/.test(prepareRuntime),
  "String.GetHashCode is randomised per process, so it would never match");

check("the lock is not left inside the folder that becomes payload",
  /GetTempPath\(\)\) \$lockName/.test(prepareRuntime) &&
  /ExcludeDirs @\("\.runtime-build"\)/.test(stagePs1));

check("a crashed build does not block the next one for ever",
  /Remove-Item -LiteralPath \$lockFile -Force -ErrorAction SilentlyContinue/.test(prepareRuntime) &&
  /previousPid -ne \$PID/.test(prepareRuntime));

/* =====================================================================
 * The interpreter that keeps being taken away
 *
 * Second report, with the diagnosis from the first one working: the
 * interpreter was present at the trimming step and gone by the
 * verification step. The trimming step deletes *.pyc, __pycache__ and
 * packages' own test folders - nothing else - so the removal came from
 * outside the build, during the longest window of file activity in it.
 *
 * Telling somebody to run Get-MpThreat themselves was not enough. The
 * script now asks Defender itself, puts the interpreter back from the
 * zip it came out of, and says at the START that the folder is being
 * watched rather than after ten minutes of work.
 * =================================================================== */

check("the build asks Defender instead of telling the reader to",
  /function Get-DefenderEvidence \{/.test(prepareRuntime) &&
  /Get-MpThreatDetection/.test(prepareRuntime) &&
  /Defender reports no detection in this folder/.test(prepareRuntime),
  "a detection nobody reads is still there, but the build that provoked it is gone");

check("a removed interpreter is put back rather than losing the build",
  /function Restore-Interpreter \{/.test(prepareRuntime) &&
  /ZipFileExtensions\]::ExtractToFile/.test(prepareRuntime) &&
  /Assert-Interpreter[\s\S]{0,400}if \(Restore-Interpreter -Phase \$Phase\) \{ return \}/.test(prepareRuntime));

check("...only from the verified zip, and only files at its root",
  /if \(\$entry\.FullName\.Contains\("\/"\)\) \{ continue \}/.test(prepareRuntime) &&
  /if \(Test-Path -LiteralPath \$dest\) \{ continue \}/.test(prepareRuntime),
  "anything in a subfolder is pip's work, which this cannot recreate");

check("...and a restored ._pth is patched again",
  /if \(\$putBack \| Where-Object \{ \$_ -like "\*\._pth" \}\) \{ Enable-SitePackages \}/.test(prepareRuntime),
  "an unpatched ._pth leaves site-packages off and every library invisible");

check("...twice at most",
  /if \(\$script:Restores -ge 2\) \{ return \$false \}/.test(prepareRuntime) &&
  /taken away again/.test(prepareRuntime));

check("a build that needed repairing says so at the end",
  /if \(\$script:Restores -gt 0\) \{/.test(prepareRuntime) &&
  /The runtime was verified after that, so this zip is good\. The machine is not:/.test(prepareRuntime),
  "the zip is sound; the machine that made it is the finding");

check("and the warning comes before the ten minutes, not after",
  /function Show-ScannerAdvisory \{/.test(prepareRuntime) &&
  /RealTimeProtectionEnabled/.test(prepareRuntime) &&
  prepareRuntime.indexOf("Show-ScannerAdvisory\n\nHead \"Unpacking") > 0);

check("the scratch folder can be moved out of the scanner's way",
  /\[string\] \$Work\s+= ""/.test(prepareRuntime) &&
  /AURION_RUNTIME_WORK/.test(prepareRuntime) &&
  /Join-Path \(Resolve-Path -LiteralPath \$Work\)\.Path "aurion-runtime-build"/.test(prepareRuntime),
  "-Work must never be deleted wholesale: the unpack step removes $work outright");

check("the advisory and the repair both work on Windows PowerShell 5.1",
  !/\?\?/.test(prepareRuntime.replace(/#.*$/gm, "")),
  "?? is PowerShell 7 only, and the build machine may be running 5.1");

/* =====================================================================
 * "It built without errors" is not "it installs on a bare PC"
 *
 * Asked directly, after a clean build on a machine that had twice had
 * files removed out of the bundle mid-run: will this install on a
 * machine with nothing on it? Nothing in the build answered that. The
 * build proves the MSI was produced; it says nothing about whether the
 * wheels inside it still open.
 *
 * verify-bundle.ps1 answers it with evidence, on the build machine,
 * before anybody receives the file.
 * =================================================================== */

check("every wheel in the bundle is opened, not counted",
  /ZipFile\]::OpenRead\(\$wheel\.FullName\)/.test(verifyBundle) &&
  /\*\.dist-info\/METADATA/.test(verifyBundle) &&
  /not a readable archive/.test(verifyBundle),
  "a truncated wheel has a name and a size like any other; only opening it tells you");

check("the Node zip is checked against the checksum nodejs.org published",
  /SHASUMS256\.txt/.test(verifyBundle) &&
  /Get-FileHash -LiteralPath \$nodeZip -Algorithm SHA256/.test(verifyBundle));

check("the signed installers are checked by signature, not by size",
  /Get-AuthenticodeSignature -LiteralPath \$path/.test(verifyBundle));

check("every requirement must have a wheel to come from",
  /engine\\requirements\.txt/.test(verifyBundle) &&
  /no wheel for \$u/.test(verifyBundle) &&
  /function Normalise/.test(verifyBundle),
  "scikit_learn-1.5.2.whl satisfies scikit-learn, and the comparison has to know that");

check("the customer's own install is simulated, offline",
  /"--no-index", "--find-links", \$wheelDir,/.test(verifyBundle) &&
  /"--target", \$target,/.test(verifyBundle) &&
  /"--only-binary=:all:"/.test(verifyBundle),
  "--no-index so that needing the network is a failure rather than a silent success");

check("...and it cleans up after itself",
  /Remove-Item -LiteralPath \$target -Recurse -Force -ErrorAction SilentlyContinue/.test(verifyBundle));

check("the argv slice that broke provision.ps1 is not written again",
  /if \(\$candidate\.Count -gt 1\) \{ \$pre = @\(\$candidate\[1\.\.\(\$candidate\.Count - 1\)\]\) \}/.test(verifyBundle) &&
  !/\$args = /.test(verifyBundle),
  "1..0 is a descending range, and $args is an automatic variable");

check("the verdict is a verdict, with an exit code behind it",
  /This bundle installs on a machine with nothing on it and no network\./.test(verifyBundle) &&
  /Not ready to ship:/.test(verifyBundle) &&
  /exit 1/.test(verifyBundle));

check("...and it still says what it cannot prove",
  /run the MSI once on a/.test(verifyBundle) &&
  /clean machine with the network unplugged/.test(verifyBundle),
  "a check that overstates itself is worse than no check");

check("the build runs it, and does not pretend a failed check is a failed build",
  /Step "Verifying the bundle installs with no network"/.test(buildMsi) &&
  /verify-bundle\.ps1"\) -Root \$repoRoot -Msi \$msi\.FullName/.test(buildMsi) &&
  /The MSI is built, but the checks above say it is not ready to ship\./.test(buildMsi));

/* =====================================================================
 * The network error from the step that needs no network
 *
 * A bare machine, working internet, and the setup window still said the
 * prerequisites could not be installed - with a network error, while
 * thirty verified wheels sat unused in vendor\wheels.
 *
 * The embeddable Python has no pip and no ensurepip, so setup fell
 * through to get-pip.py. get-pip.py carries pip, but left to its
 * defaults it also fetches setuptools and wheel from PyPI. One
 * unreachable index and EnsurePipAsync threw, so the offline install
 * below it was never attempted at all. prepare-runtime.ps1 has passed
 * --no-setuptools --no-wheel since it was written; this path did not.
 * =================================================================== */

check("pip is bootstrapped from a wheel before anything that can reach PyPI",
  /BundledPipWheel\(installDir\)/.test(prereqCs) &&
  prereqCs.indexOf("var pipWheel = BundledPipWheel(installDir);") <
    prereqCs.indexOf("var getPip = Bundled(installDir, GetPipName);"),
  "a wheel is a zip with the package at its root, so python can run it to install it");

check("...offline, by its own flags",
  /--no-index --find-links \\"\{wheelDir\}\\" \\"\{pipWheel\}\\"/.test(prereqCs),
  "--no-index so that reaching for an index is an error rather than a silent download");

check("...and pip-* does not match pipdeptree",
  /char\.IsDigit\(name\[4\]\)/.test(prereqCs));

check("get-pip.py is never run with the defaults that go to PyPI first",
  /" --no-setuptools --no-wheel --no-warn-script-location --no-input",/.test(prereqCs) &&
  prereqCs.indexOf('" --no-setuptools --no-wheel --no-warn-script-location --no-input",') <
    prereqCs.indexOf('" --no-warn-script-location --no-input",'),
  "the plain call stays as a second attempt, in case a future get-pip.py drops the options");

check("every pip bootstrap attempt is written to setup.log",
  /LogOnly\(say, \$"-- pip from the bundled wheel -> exit \{code\}", output\)/.test(prereqCs) &&
  /LogOnly\(say, \$"-- get-pip\.py\{tail\} -> exit \{code\}", output\)/.test(prereqCs),
  "the first failure is the one that matters, and it was the one being thrown away");

check("the build collects pip's own wheel, and will not ship without it",
  /-m pip download "pip" --dest \$wheels/.test(fetchVendor) &&
  /\$_\.Name -match "\^pip-\[0-9\]"/.test(fetchVendor) &&
  /pip's own wheel could not be collected/.test(fetchVendor));

check("there is one routine that bootstraps pip, not two",
  (prereqCs.match(/Bundled\(installDir, GetPipName\)/g) || []).length === 1 &&
  /await EnsurePipAsync\(exe, "", installDir, say, ct\);/.test(prereqCs),
  "UnpackPythonAsync had its own get-pip call, and that is the copy the fix had missed");

check("the verifier fails a bundle that has no pip wheel",
  /pip's own wheel is bundled/.test(verifyBundle) &&
  /no pip wheel in the bundle/.test(verifyBundle),
  "the one wheel without which none of the others can be used");

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
