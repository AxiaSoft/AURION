/**
 * Catch the PowerShell mistakes that otherwise cost a whole release.
 *
 * Nothing in this repository can run PowerShell. The scripts here are the
 * first thing a machine that cannot start AURION runs, so a stray brace in
 * scripts/provision.ps1 is not a typo - it is a bare Windows machine that
 * installs nothing, twice, and reports that neither the engine nor the desk
 * wrote anything.
 *
 * This cannot replace `powershell -NoProfile -Command { [scriptblock]::Create(...) }`
 * and does not try. It checks the one class of damage that a scripted edit
 * of a file nobody can run is most likely to cause: structure that no longer
 * balances, because a quotation mark closed early or a brace went missing.
 *
 * Strings and comments are removed first, by a scanner rather than a regular
 * expression, because both are full of the characters being counted - every
 * log line in provision.ps1 contains a brace, and `"`r?`n"` contains a
 * backtick escape that a naive counter reads as a quote.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** Everything that is not a comment, a string or a character literal. */
function structureOf(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];

    // <# block comment #>
    if (c === "<" && src[i + 1] === "#") {
      i += 2;
      while (i + 1 < n && !(src[i] === "#" && src[i + 1] === ">")) i++;
      i += 2;
      continue;
    }

    // # line comment
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // 'single quoted'. A quote is escaped by doubling it.
    if (c === "'") {
      i++;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // "double quoted". Backtick escapes the next character; doubling the
    // quote escapes the quote.
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === "`") { i += 2; continue; }
        if (src[i] === '"') {
          if (src[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // A backtick escapes the next character outside strings too.
    if (c === "`") { i += 2; continue; }

    out.push(c);
    i++;
  }
  return out.join("");
}

/** True when every string and comment closed before the end of the file. */
function stringsClosed(src) {
  let i = 0;
  const n = src.length;
  let unterminated = false;
  while (i < n) {
    const c = src[i];
    if (c === "<" && src[i + 1] === "#") {
      i += 2;
      while (i + 1 < n && !(src[i] === "#" && src[i + 1] === ">")) i++;
      if (i + 1 >= n) { unterminated = true; break; }
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let closed = false;
      while (i < n) {
        if (quote === '"' && src[i] === "`") { i += 2; continue; }
        if (src[i] === quote) {
          if (src[i + 1] === quote) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) { unterminated = true; break; }
      continue;
    }
    if (c === "`") { i += 2; continue; }
    i++;
  }
  return !unterminated;
}

function findScripts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") return [];
      return findScripts(path.join(dir, e.name));
    }
    return e.name.endsWith(".ps1") ? [path.join(dir, e.name)] : [];
  });
}

const files = findScripts(ROOT)
  .filter((f) => !f.includes(`${path.sep}vendor${path.sep}`))
  .sort();

check("the repository's PowerShell is all accounted for", files.length > 0, `${files.length} files`);

for (const file of files) {
  const name = path.relative(ROOT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");

  check(`${name} closes every string and comment`, stringsClosed(src));

  const code = structureOf(src);
  const pairs = [["{", "}"], ["(", ")"], ["[", "]"]];
  const off = pairs
    .map(([o, c]) => [o + c, [...code].filter((x) => x === o).length - [...code].filter((x) => x === c).length])
    .filter(([, d]) => d !== 0);

  check(
    `${name} is balanced`,
    off.length === 0,
    off.length ? off.map(([p, d]) => `${p} off by ${d}`).join(", ") : "braces, parens, brackets",
  );
}

// The scripts a machine runs when it cannot start. They are the ones that
// have to be runnable, and the ones most likely to be edited blind.
const provision = fs.readFileSync(path.join(ROOT, "scripts", "provision.ps1"), "utf8");

// [1..(Length - 1)] is the idiomatic way to drop the first element of an
// argv array, and it is wrong for exactly one element: PowerShell reads 1..0
// as the descending range 1, 0, so the command gets an empty argument and a
// repeated program name. setup, fix-numpy and the build's wheel collector
// all had it, and all three were quiet about the failure.
for (const file of files) {
  const name = path.relative(ROOT, file).replace(/\\/g, "/");
  const src = fs.readFileSync(file, "utf8");
  const guesses = [...src.matchAll(/\[1\.\.\(\$?\w+\.(Length|Count) - 1\)\]/g)];
  if (guesses.length === 0) continue;

  // Only acceptable behind a count check, which makes the one-element case
  // an empty array instead of a descending one.
  const guarded = /Count -gt 1/.test(src);
  check(`${name} does not slice an argv array with 1..(Length-1)`, guarded,
    guarded ? "behind a count check" : `${guesses.length} unguarded`);
}

// $LASTEXITCODE does not exist until a native command has run. Under
// Set-StrictMode -Version Latest, reading it before that is itself an error -
// which would be a setup script that dies on its first line of real work,
// with $ErrorActionPreference = "Stop" and no trap in place at the time.
check("provision.ps1 gives $LASTEXITCODE a value before anything reads it",
  /Set-StrictMode -Version Latest[\s\S]{0,400}\$global:LASTEXITCODE = 0/.test(provision));

// `return` at script scope ends the script: everything after it - the
// engine's libraries, Node, npm, runtime.env - never runs. It used to be
// used inside the Python branch.
check("provision.ps1 does not return out of the Python branch",
  !/Install-PythonFromZip[\s\S]{0,120}?\n\s*return\b/.test(provision));

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
