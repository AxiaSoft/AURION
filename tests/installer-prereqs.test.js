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
const startCmd = read("start-aurion.cmd");
const buildMsi = read("installer/tools/build-msi.ps1");

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
  /python\.org\/ftp\/python\/3\.12/.test(prereqCs) &&
  /nodejs\.org\/dist\/v\d+\./.test(prereqCs));
check("downloads are still checked against their publisher before running",
  /Python Software Foundation/.test(prereqCs) &&
  /OpenJS Foundation/.test(prereqCs) &&
  /SignedBy\(/.test(prereqCs));

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
