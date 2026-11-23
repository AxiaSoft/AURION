/**
 * The MSI build must find the Python that is on the machine.
 *
 * A release build failed twice in one run, in two places, for one
 * reason. build-msi.ps1 announced the Python it had found:
 *
 *     C:\Users\...\AppData\Local\Microsoft\WindowsApps\python.exe
 *
 * and three screens later fetch-vendor.ps1 stopped the whole build with
 * "No Python on this build machine, so the engine's wheels cannot be
 * collected". Both statements were true of the same stub, and neither
 * was true of the machine: python.org's 3.12 was installed and working.
 *
 * %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is not an
 * interpreter. It is a stub that opens the Microsoft Store - and
 * uninstalling the Store Python LEAVES IT BEHIND, still first on PATH.
 * So `Get-Command python` answers forever, with nothing behind it:
 * one caller believed the answer, the other ran it, got a non-zero exit
 * and concluded the machine had no Python at all.
 *
 * What is pinned here:
 *
 *   1. There is ONE resolver for the build machine, and both callers
 *      use it - the half-hour of confusion was them disagreeing.
 *   2. It judges an interpreter by what it IS: sys.executable and
 *      version, never a name on PATH.
 *   3. It knows where a quiet python.org install hides, because
 *      "installed but not on PATH" is the normal case here.
 *   4. The refusal explains itself, including the shell that has to be
 *      reopened.
 *   5. The icon writer survives PowerShell unrolling a byte[].
 *
 *     node tests/msi-build-python.test.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const FINDER = read("installer/tools/find-build-python.ps1");
const BUILD = read("installer/tools/build-msi.ps1");
const FETCH = read("installer/tools/fetch-vendor.ps1");
const ICON = read("installer/tools/make-icon.ps1");

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    const note = fn();
    pass++;
    console.log("PASS  " + name + (note ? "  — " + note : ""));
  } catch (err) {
    fails.push(name + ": " + err.message);
    console.log("FAIL  " + name + "  — " + err.message);
  }
}

/* ------------------------------------------------- 1. one resolver */

check("both build steps ask the same resolver", () => {
  for (const [name, src] of [["build-msi.ps1", BUILD], ["fetch-vendor.ps1", FETCH]]) {
    if (!/find-build-python\.ps1/.test(src)) {
      throw new Error(name + " does not dot-source the shared resolver");
    }
    if (!/Find-BuildPython/.test(src)) throw new Error(name + " never calls it");
  }
  return "one answer, two callers";
});

check("neither of them guesses with Get-Command any more", () => {
  const offenders = [];
  for (const [name, src] of [["build-msi.ps1", BUILD], ["fetch-vendor.ps1", FETCH]]) {
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (/^#/.test(t)) continue;
      if (/Get-Command\s+(py|python)\b/.test(t)) offenders.push(name + ": " + t);
      /* fetch-vendor's old probe: `& py "-$v" -c "import sys"` proves
         only that something ran, which the stub also does. */
      if (/&\s*py\s+"-\$v"/.test(t)) offenders.push(name + ": " + t);
    }
  }
  if (offenders.length) throw new Error("still guessing:\n      " + offenders.join("\n      "));
  return "no name is trusted";
});

/* --------------------------------------------- 2. it asks what it is */

check("a candidate is judged by sys.executable and its version", () => {
  if (!/sys\.executable/.test(FINDER)) throw new Error("the resolver never asks where the interpreter is");
  if (!/version_info/.test(FINDER)) throw new Error("it never asks which version it is");
  if (!/WindowsApps/.test(FINDER)) throw new Error("the Store stub would be accepted");
  return "probed, not guessed";
});

check("3.13 and newer are refused here, not discovered later", () => {
  /* The engine is pinned to NumPy 1.26.4, whose last official Windows
     wheel is for CPython 3.12. A 3.13 on the build machine collects
     wheels that no installed AURION can import - a failure that only
     shows up on the customer's computer. */
  if (!/3\.12/.test(FINDER) || !/3\.10/.test(FINDER)) {
    throw new Error("the supported range is not stated");
  }
  if (!/NumPy|numpy/.test(FINDER)) throw new Error("nothing records WHY the range is what it is");
  return "3.10 - 3.12";
});

check("the one-element argv slice that once shipped an empty MSI is guarded", () => {
  /* $argv[1..($argv.Count - 1)] on a one-element array is 1..0, which
     PowerShell evaluates as 1, 0 - handing python an empty first
     argument. Every wheel collection failed that way once, quietly. */
  const slices = FINDER.match(/\[1\.\.\(\$\w+\.Count - 1\)\]/g) || [];
  if (slices.length && !/if \(\$\w+\.Count -gt 1\)/.test(FINDER)) {
    throw new Error("the array is sliced without a count check");
  }
  return "behind a count check";
});

/* ------------------------------- 3. where a quiet install actually is */

check("it looks where python.org puts an interpreter that is not on PATH", () => {
  if (!/PythonCore/.test(FINDER)) {
    throw new Error("the registry key python.org always writes is not consulted");
  }
  if (!/Programs\\Python/.test(FINDER)) {
    throw new Error("the per-user install folder is not consulted");
  }
  /* And this tree's own runtime, which provision.ps1 may have put
     there - it is the most specific answer available. */
  if (!/runtime\\python\\python\.exe/.test(FINDER)) {
    throw new Error("the tree's own runtime\\python is ignored");
  }
  return "runtime\\python, py, registry, install folders, PATH";
});

/* ----------------------------------------------- 4. the refusal talks */

check("'no Python' explains itself instead of repeating the old advice", () => {
  if (!/Get-BuildPythonAdvice/.test(FINDER)) throw new Error("there is no shared message");
  for (const [what, re] of [
    ["the Store stub", /Store stub|Microsoft\s*\n?.*Store/i],
    ["the order it looked in", /in order/i],
    ["a new shell", /NEW shell|new shell/],
    ["the escape hatches", /-SkipWheels/],
  ]) {
    if (!re.test(FINDER)) throw new Error("the advice does not mention " + what);
  }
  /* Telling a user to "install Python 3.12" on a machine where Python
     3.12 is installed is how an afternoon disappears. */
  for (const [name, src] of [["build-msi.ps1", BUILD], ["fetch-vendor.ps1", FETCH]]) {
    if (/Install CPython 3\.12 here/.test(src)) {
      throw new Error(name + " still gives the advice that was wrong on the machine that needed it");
    }
  }
  return "it says what it tried";
});

/* --------------------------------------------------- 5. the icon bug */

check("the icon writer survives PowerShell unrolling its byte arrays", () => {
  /*
   *   Cannot convert argument "collection", with value "System.Object[]",
   *   to type "System.Collections.Generic.IEnumerable`1[System.Byte]"
   *
   * printed in the middle of the same release build. `return $array`
   * from a PowerShell function unrolls, and the caller collects boxed
   * bytes into an Object[] that List[byte].AddRange refuses.
   */
  const returns = ICON.match(/return\s+,?\s*\$\w+\.ToArray\(\)/g) || [];
  if (returns.length < 2) throw new Error("expected two byte-array producers (check this test)");
  for (const r of returns) {
    if (!/return\s+,/.test(r)) throw new Error("unrolled on the way out: " + r.trim());
  }
  if (!/AddRange\(\[byte\[\]\]/.test(ICON)) {
    throw new Error("AddRange is still handed whatever the caller collected");
  }
  return "comma-wrapped and cast";
});

console.log("\nmsi-build-python: " + pass + " of " + (pass + fails.length) + " checks passed");
if (fails.length) {
  console.error("\nFAILED:\n  " + fails.join("\n  "));
  process.exit(1);
}
