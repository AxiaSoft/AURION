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
const pyName = "python-3.12.7-amd64.exe";
const nodeName = "node-v20.17.0-win-x64.zip";
check("the three sides agree on what the bundled files are called",
  vendorPs1.includes("3.12.7") && vendorPs1.includes("v20.17.0") &&
  prereqCs.includes('PythonFullVersion = "3.12.7"') &&
  prereqCs.includes('NodeVersion = "v20.17.0"') &&
  provisionPs1.includes(pyName) && provisionPs1.includes("v20.17.0"));

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
