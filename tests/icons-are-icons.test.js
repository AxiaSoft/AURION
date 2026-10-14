/**
 * Every .ico in the installer must be a structurally valid icon.
 *
 * The C# compiler embeds installer/assets/generated/aurion.ico as the Win32
 * resource of AURION.exe. When the file is malformed it does not say so --
 * it says:
 *
 *     CSC : error CS7065: Error building Win32 resources --
 *           Unable to read beyond the end of the stream.
 *
 * which names neither the icon nor what is wrong with it, and which cost a
 * whole build cycle on somebody else's machine to diagnose. The cause was
 * make-icon.ps1 writing 16-bit fields through BinaryWriter.Write, which
 * Windows PowerShell 5.1 resolves to the Char overload: one UTF-8 byte
 * instead of two. Directory entries came out 14 bytes wide instead of 16,
 * every image offset drifted, and the last one pointed past the end of the
 * file.
 *
 * This reads the icons the way the compiler does and checks the arithmetic
 * that actually broke. It runs anywhere, which is the point: the generator
 * only runs on Windows, so without this the first machine to find out is a
 * build machine.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/**
 * Parse an ICO the way Roslyn does, and return what is wrong with it.
 * An empty array means the file is sound.
 */
function iconProblems(buf) {
  const bad = [];
  if (buf.length < 6) return [`only ${buf.length} bytes long`];

  if (buf.readUInt16LE(0) !== 0) bad.push("reserved field is not zero");
  if (buf.readUInt16LE(2) !== 1) bad.push(`type is ${buf.readUInt16LE(2)}, not 1`);

  const count = buf.readUInt16LE(4);
  if (count < 1) return ["claims to contain no images"];

  const directoryEnd = 6 + 16 * count;
  if (buf.length < directoryEnd) {
    return [`claims ${count} images but is too short to hold their directory`];
  }

  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);

    // The failure mode that produced CS7065: entries narrower than 16 bytes
    // push the first image offset back into the directory itself.
    if (offset < directoryEnd) {
      bad.push(`image ${i} starts at ${offset}, inside the ${directoryEnd}-byte directory`);
      continue;
    }
    if (offset + size > buf.length) {
      bad.push(`image ${i} runs to ${offset + size} but the file is ${buf.length} bytes`);
      continue;
    }

    // Each image is either a PNG or a BITMAPINFOHEADER. Anything else is not
    // something the compiler will embed.
    const head = buf.subarray(offset, offset + 8);
    const isPng = head.length >= 4 && head.readUInt32BE(0) === 0x89504e47;
    const isDib = head.length >= 4 && head.readUInt32LE(0) === 40;
    if (!isPng && !isDib) {
      bad.push(`image ${i} is neither a PNG nor a DIB (starts ${head.subarray(0, 4).toString("hex")})`);
    }
  }
  return bad;
}

const dir = path.join(ROOT, "installer", "assets", "generated");
const icons = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".ico")).sort()
  : [];

check("the installer's generated icons are present", icons.length > 0,
  `${icons.length} found`);

for (const name of icons) {
  const buf = fs.readFileSync(path.join(dir, name));
  const problems = iconProblems(buf);
  check(`${name} is a well-formed icon`, problems.length === 0,
    problems.length ? problems.join("; ") : `${buf.readUInt16LE(4)} images, ${buf.length} bytes`);
}

// The product icon is the one the compiler embeds, so it gets the extra
// requirement: Windows asks for the small classic sizes and a container
// holding nothing but a 256px PNG is what most online converters produce.
const productPath = path.join(dir, "aurion.ico");
if (fs.existsSync(productPath)) {
  const buf = fs.readFileSync(productPath);
  const sizes = [];
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const w = buf.readUInt8(6 + 16 * i);
    sizes.push(w === 0 ? 256 : w);
  }
  check("the product icon carries the small sizes Windows asks for",
    [16, 32, 48].every((s) => sizes.includes(s)), sizes.join(", "));
}

// And the generator must not go back to the overload that caused this.
const maker = fs.readFileSync(path.join(ROOT, "installer", "tools", "make-icon.ps1"), "utf8");
check("make-icon.ps1 writes integers through BitConverter, not BinaryWriter",
  /BitConverter\]::GetBytes/.test(maker) && !/\$writer\.Write\(\[uint16\]/.test(maker) &&
  !/\$bw\.Write\(\[uint16\]/.test(maker));
check("and checks its own output before replacing the icon",
  /Test-IconBytes/.test(maker) && /Move-Item -LiteralPath \$temp/.test(maker));

// Belt and braces. The generator is fixed, but regenerating a known-good,
// tested artefact on every build buys nothing and can only go wrong - which
// it did, twice, on a machine nobody here can see.
const csproj = fs.readFileSync(
  path.join(ROOT, "installer", "window", "AurionWindow.csproj"), "utf8");
check("the build does not regenerate the icon unless asked",
  /AurionRebuildIcon\)' == 'true'/.test(csproj));

// And if something does rewrite it, the build has to name the file rather
// than hand back CS7065.
const buildMsi = fs.readFileSync(
  path.join(ROOT, "installer", "tools", "build-msi.ps1"), "utf8");
check("the build checks the icon itself, immediately before the compile",
  /Test-ProductIcon/.test(buildMsi) &&
  buildMsi.indexOf("Test-ProductIcon -Path") < buildMsi.indexOf("publish $windowProject"));

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
