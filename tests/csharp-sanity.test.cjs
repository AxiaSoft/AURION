/**
 * Catch the C# mistakes that otherwise cost a whole build cycle.
 *
 * Nothing in this repository can compile C#. The installer's window project
 * is built on a Windows machine with the .NET SDK, which is somebody else's
 * laptop, so every compile error is a round trip measured in hours. Three
 * have been paid for already:
 *
 *     SetupPanel.cs(110,9): error CS0118: 'AutoScaleMode' is a type but is
 *         used like a variable
 *     Prerequisites.cs(260,25): error CS0136: A local or parameter named
 *         'node' cannot be declared in this scope because that name is used
 *         in an enclosing local scope
 *     CSC : error CS7065: Error building Win32 resources
 *
 * This cannot replace a compiler and does not try. It checks the specific
 * classes of error that have actually happened, plus the structural damage
 * that a scripted edit to a file nobody can run is most likely to cause.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/**
 * Remove comments, strings and character literals, leaving the structure.
 *
 * Written as a scanner rather than a regular expression because the naive
 * version mis-handles interpolated strings - it reported a brace imbalance
 * in a file that was perfectly balanced, which is worse than no check.
 */
function structureOf(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === "@" && src[i + 1] === '"') {
      i += 2;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

// Everything C#, not just the desk window: the setup wizard and the
// uninstaller are separate programs that cannot be compiled here either,
// and they are newer, so they are likelier to be wrong.
function csharpUnder(...parts) {
  const dir = path.join(ROOT, ...parts);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? csharpUnder(...parts, e.name)
      : e.name.endsWith(".cs") ? [path.join(dir, e.name)] : []);
}

const files = [
  ...csharpUnder("installer", "window"),
  ...csharpUnder("installer", "shell"),
].sort();

const label = (f) => path.relative(path.join(ROOT, "installer"), f).replace(/\\/g, "/");

check("the installer's C# is all accounted for", files.length > 0, `${files.length} files`);

for (const file of files) {
  const name = label(file);
  const src = fs.readFileSync(file, "utf8");
  const code = structureOf(src);

  const pairs = [["{", "}"], ["(", ")"], ["[", "]"]];
  const off = pairs
    .map(([o, c]) => [o + c, [...code].filter((x) => x === o).length - [...code].filter((x) => x === c).length])
    .filter(([, d]) => d !== 0);
  check(`${name} is balanced`, off.length === 0,
    off.length ? off.map(([p, d]) => `${p} off by ${d}`).join(", ") : "braces, parens, brackets");
}

// ---------------------------------------------------------------------------
// CS0118: AutoScaleMode on something that does not have one
// ---------------------------------------------------------------------------
// AutoScaleMode is declared by ContainerControl. Form and UserControl have
// it; Panel does not, because Panel derives from ScrollableControl. Setting
// it on a Panel does not fail as "no such property" - the name resolves to
// the enum type instead, and the compiler says it is "a type but is used
// like a variable", which does not sound like the mistake it is.
for (const file of files) {
  const name = label(file);
  const code = structureOf(fs.readFileSync(file, "utf8"));
  if (!/\bAutoScaleMode\s*=/.test(code)) continue;

  // Attributed to the class it is actually written in. A file holding
  // several classes - a button deriving from Control next to a form
  // deriving from Form - would otherwise be judged by whichever was
  // declared first, which is how this check first accused a correct file.
  const declarations = [...code.matchAll(/class\s+(\w+)\s*:\s*(\w+)/g)]
    .map((m) => ({ at: m.index, name: m[1], base: m[2] }));

  const wrong = [];
  for (const use of code.matchAll(/\bAutoScaleMode\s*=/g)) {
    const owner = declarations.filter((d) => d.at < use.index).pop();
    const base = owner ? owner.base : "?";
    if (!["Form", "UserControl", "ContainerControl"].includes(base)) {
      wrong.push(`${owner ? owner.name : "?"} derives from ${base}`);
    }
  }

  check(`${name} only sets AutoScaleMode on a ContainerControl`,
    wrong.length === 0, wrong.length ? wrong.join("; ") : "correct hosts");
}

// ---------------------------------------------------------------------------
// A transparent BackColor on a plain Control throws at construction
// ---------------------------------------------------------------------------
// Control.BackColor throws ArgumentException for any colour whose alpha is
// below 255 unless ControlStyles.SupportsTransparentBackColor is set, and
// Color.Transparent has an alpha of zero. Label and Panel set that style
// themselves; a class deriving straight from Control does not.
//
// It compiles. It throws at runtime, from a constructor, before
// Application.Run has started pumping - so a WinExe dies with no window,
// no message and nothing in any log. AURION-Setup.exe did exactly nothing
// when double-clicked, every time, for this.
const allClasses = files.flatMap((f) =>
  [...structureOf(fs.readFileSync(f, "utf8")).matchAll(/class\s+(\w+)\s*:\s*(\w+)/g)]
    .map((m) => ({ name: m[1], base: m[2] })));

for (const file of files) {
  const name = label(file);

  // Everything below works on the comment-free code, never the raw file.
  // The first version searched the raw text for the style name, found it
  // in the comment explaining why the style is needed, and happily passed
  // a file from which the style itself had been deleted.
  const code = structureOf(fs.readFileSync(file, "utf8"));

  // Only assignments to the class's own BackColor. "_title.BackColor =
  // Color.Transparent" sets it on a Label, which supports it; an earlier
  // draft could not tell the two apart and accused two correct files.
  const own = /(?<![\w.])BackColor\s*=\s*Color\.Transparent/g;
  if (!own.test(code)) continue;
  own.lastIndex = 0;

  const declarations = [...code.matchAll(/class\s+(\w+)\s*:\s*(\w+)/g)]
    .map((m) => ({ at: m.index, name: m[1], base: m[2] }));

  // Types that already carry the style, plus anything in this repository
  // that derives from one of them - BrandForm is a Form, and a window
  // deriving from BrandForm is as safe as one deriving from Form.
  const safe = ["Form", "UserControl", "Panel", "Label", "ContainerControl"];
  for (let settled = false; !settled; ) {
    settled = true;
    for (const d of allClasses) {
      if (!safe.includes(d.name) && safe.includes(d.base)) {
        safe.push(d.name);
        settled = false;
      }
    }
  }

  const wrong = [];
  for (const use of code.matchAll(own)) {
    const owner = declarations.filter((d) => d.at < use.index).pop();
    if (!owner || safe.includes(owner.base)) continue;

    const next = declarations.find((d) => d.at > owner.at);
    const body = code.slice(owner.at, next ? next.at : code.length);
    if (!/SupportsTransparentBackColor/.test(body)) {
      wrong.push(`${owner.name} derives from ${owner.base}`);
    }
  }

  check(`${name} never sets a transparent BackColor it cannot have`,
    wrong.length === 0,
    wrong.length ? [...new Set(wrong)].join("; ") : "styles declared");
}

// ---------------------------------------------------------------------------
// CS0136: the same local name twice, where one scope encloses the other
// ---------------------------------------------------------------------------
// Introduced by adding a tuple deconstruction at the top of a method that
// already declared one of those names further down. C# forbids that even
// though the two uses never overlap.
//
// It does NOT forbid the same name in two sibling blocks, which is common
// and correct - two `using (var size = ...)` in one method is fine. So the
// test tracks the scope each declaration sits in and only reports a pair
// when one scope is an ancestor of the other, which is the actual rule.
function localClashes(code) {
  const clashes = [];
  const declared = []; // { name, path }
  let path = [0];
  let counter = [0];

  const related = (a, b) => {
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    return short.every((v, i) => v === long[i]);
  };

  const note = (name) => {
    if (!name || /^(var|new|return|if|out|in|is)$/.test(name)) return;
    for (const prior of declared) {
      if (prior.name === name && related(prior.path, path)) {
        clashes.push(name);
        return;
      }
    }
    declared.push({ name, path: path.slice() });
  };

  // Walk the code so declarations can be attributed to a scope.
  const tokens = [...code.matchAll(/[{}]|\bvar\s+\(([^)]*)\)\s*=|\bvar\s+([A-Za-z_]\w*)\s*=/g)];
  for (const t of tokens) {
    if (t[0] === "{") {
      counter[counter.length - 1]++;
      path.push(counter[counter.length - 1]);
      counter.push(0);
    } else if (t[0] === "}") {
      path.pop();
      counter.pop();
      if (path.length === 0) { path = [0]; counter = [0]; }
    } else if (t[1] !== undefined) {
      for (const part of t[1].split(",")) note(part.trim());
    } else {
      note(t[2]);
    }
  }
  return [...new Set(clashes)];
}

for (const file of files) {
  const name = label(file);
  const code = structureOf(fs.readFileSync(file, "utf8"));
  const clashes = localClashes(code);
  check(`${name} never shadows a local with another local`, clashes.length === 0,
    clashes.length ? clashes.join(", ") : "no shadowing");
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
