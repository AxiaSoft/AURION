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
const startCmd = read("start-aurion.cmd");
const buildMsi = read("installer/tools/build-msi.ps1");
const stagePs1 = read("installer/tools/stage.ps1");
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
check("pip is not upgraded over a network the bundle exists to avoid",
  /if \(!offline\)[\s\S]{0,400}pip install --upgrade pip/.test(prereqCs) &&
  /--retries 1 --timeout 15/.test(prereqCs));
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
  /--no-index --find-links/.test(prereqCs));
check("and so does the script, for an install that is already on a machine",
  /Get-Bundled/.test(provisionPs1) && /--no-index --find-links/.test(provisionPs1));

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

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
