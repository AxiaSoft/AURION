/* The native client, checked without a compiler.
 *
 * Phase one is being written in an environment with no .NET SDK and no
 * route to one (NuGet and the Microsoft download hosts are outside the
 * allowlist), so the C# cannot be built here. That is a reason to be
 * MORE careful, not a reason to ship unverified code and call it
 * progress.
 *
 * Three things can be checked by reading the source, and they are the
 * three most likely to be wrong:
 *
 *   1. the generated API client matches docs/api-surface.json exactly,
 *      so no route is missing, invented or mistyped;
 *   2. every language key the C# asks for by name exists in all three
 *      packs, the same check the web desk gets;
 *   3. the money rules did not quietly acquire a different constant
 *      from the Python they were ported from.
 *
 * What is NOT checked here is whether it compiles, and nothing
 * pretends otherwise. `dotnet test apps/native/Aurion.Core.Tests` is
 * the other half, and it answers against the same fixtures the engine
 * and the web desk answer to.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NATIVE = path.join(ROOT, "apps", "native");

let ok_ = 0, bad = 0;
function ok(cond, what, detail) {
  if (cond) { ok_ += 1; console.log("ok   " + what + (detail ? "  — " + detail : "")); }
  else { bad += 1; console.log("  x  " + what + (detail ? "  — " + detail : "")); }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

(async () => {
  console.log("— the generated client matches the manifest ----------------");

  const { generate } = await import("../scripts/gen-native-api.mjs");
  const GEN = path.join(NATIVE, "Aurion.Core", "Api", "AurionApi.g.cs");
  const onDisk = fs.existsSync(GEN) ? fs.readFileSync(GEN, "utf8") : "";

  ok(onDisk.length > 0, "AurionApi.g.cs exists");
  ok(onDisk === generate().text,
    "and is exactly what the generator produces",
    "run `npm run native:api` after changing a route");

  const manifest = JSON.parse(read("docs/api-surface.json"));

  /* Every route in the manifest is reachable from C#. Checked by
     looking for the path as a string literal, which is the thing that
     would actually be wrong if the generator's name-mangling collided
     and silently dropped one. */
  const missing = [];
  for (const route of manifest.routes) {
    const literal = route.path.replace(/:([A-Za-z0-9_]+)/g, "{Uri.EscapeDataString($1)}");
    if (!onDisk.includes(`"${literal}"`)) missing.push(route.path);
  }
  ok(missing.length === 0,
    "every route in the manifest has a method",
    missing.length ? missing.slice(0, 5).join(", ") : `${manifest.routes.length} routes`);

  /* And nothing invented. Every path literal in the C# is a path the
     manifest knows about - the direction that catches a hand-edit. */
  const literals = [...onDisk.matchAll(/"(\/api[^"]*)"|\$"(\/api[^"]*)"/g)]
    .map((m) => (m[1] || m[2]).replace(/\{Uri\.EscapeDataString\(([A-Za-z0-9_]+)\)\}/g, ":$1"));
  const known = new Set(manifest.routes.map((r) => r.path));
  const invented = [...new Set(literals)].filter((p) => !known.has(p));
  ok(invented.length === 0,
    "and no method reaches a route the backend does not have",
    invented.length ? invented.join(", ") : `${new Set(literals).size} distinct`);

  ok(/auto-generated/.test(onDisk) && /Do not edit by hand/.test(onDisk),
    "the file says it is generated, so nobody edits it by hand");

  console.log("\n— the C# asks for keys that exist --------------------------");

  {
    const packs = ["en", "fa", "ar"].map((l) => {
      const flat = {};
      (function walk(o, p) {
        for (const [k, v] of Object.entries(o)) {
          const key = p ? `${p}.${k}` : k;
          if (v && typeof v === "object") walk(v, key);
          else flat[key] = v;
        }
      })(JSON.parse(read(`lang/${l}.json`)), "");
      return { lang: l, flat };
    });

    /* Literal keys only: T("exec.buy"), Has("engerr.frozen"). A key
       built at runtime cannot be checked from here, which is exactly
       why the C# side should prefer literals. */
    const cs = [];
    for (const dir of ["Aurion.Core", "Aurion.Core.Tests"]) {
      const base = path.join(NATIVE, dir);
      if (!fs.existsSync(base)) continue;
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".cs")) cs.push(fs.readFileSync(full, "utf8"));
      });
      walk(base);
    }
    /* Keys the tests use BECAUSE they are absent. A missing-key test
       needs a key that is missing, and it must not be read as a
       defect by the very check it is demonstrating. Listed here
       explicitly so the exemption is visible rather than pattern-
       matched away. */
    const SENTINELS = new Set(["no.such.key.anywhere"]);

    const asked = new Set();
    for (const src of cs) {
      for (const m of src.matchAll(/\b(?:T|Has)\(\s*"([a-z][\w]*(?:\.[\w]+)+)"/g)) {
        if (!SENTINELS.has(m[1])) asked.add(m[1]);
      }
    }
    ok(asked.size > 0, "the C# asks for language keys by name", `${asked.size} keys`);

    const absent = [];
    for (const key of asked) {
      for (const { lang, flat } of packs) {
        if (!(key in flat)) absent.push(`${lang}.${key}`);
      }
    }
    ok(absent.length === 0,
      "and every one of them exists in all three packs",
      absent.length ? absent.slice(0, 6).join(", ") : "en/fa/ar complete");
  }

  console.log("\n— the ported rules kept their constants --------------------");

  {
    const risk = read("engine/aurion/runtime/risk.py");
    const cs = read("apps/native/Aurion.Core/Money/Risk.cs");
    const spec = read("apps/native/Aurion.Core/Money/SymbolSpec.cs");

    /* Constants that differ silently if mistyped. A reference lot of
       0.1 instead of 0.01 would make every "lot"-scope budget ten
       times too big and nothing would throw. */
    ok(/REFERENCE_LOT = 0\.01/.test(risk) && /ReferenceLot = 0\.01/.test(cs),
      "the reference lot is 0.01 on both sides");

    for (const [name, needle] of [
      ["the floor slack", "1e-6"],
      ["the rounding nudge", "1e-9"],
      ["the minimum-lot epsilon", "1e-12"],
    ]) {
      ok(risk.includes(needle) && cs.includes(needle),
        `${name} survived the port`, needle);
    }

    /* Half-up, stated. C# Math.Round is half-to-even like Python's, so
       a port that simply called it would be wrong in the same place
       the web desk already was. */
    ok(/Math\.Floor\(scaled \+ 0\.5/.test(cs) && /Math\.Ceiling\(scaled - 0\.5/.test(cs),
      "money rounds half-up explicitly, not by calling Math.Round");
    ok(/MidpointRounding\.AwayFromZero/.test(cs),
      "and where Math.Round is used, the mode is stated");

    /* The field-alias order is the $30-on-a-$100-cap bug. Loss first. */
    const order = ["trade_tick_value_loss", "tick_value_loss", "trade_tick_value", "tick_value"];
    // Quoted, because every one of these is a substring of the one
    // before it: a bare indexOf("tick_value") finds the "tick_value"
    // inside "trade_tick_value_loss" and reports the order backwards.
    const at = order.map((f) => spec.indexOf(`"${f}"`));
    ok(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])),
      "the loss tick value is still preferred over the profit one",
      order.join(" > "));

    /* Suffix folding: the CL.F25 / CL.G25 rule. */
    const ident = read("apps/native/Aurion.Core/Money/SymbolIdentity.cs");
    ok(/\{1,4\}\$/.test(ident) && /Index >= 3/.test(ident),
      "symbol identity keeps the four-letter and index-3 conditions");
  }

  console.log("\n— the project stays what it says it is ---------------------");

  {
    const proj = read("apps/native/Aurion.Core/Aurion.Core.csproj");
    ok(!/Avalonia|WindowsForms|Wpf|SkiaSharp/i.test(proj),
      "Aurion.Core has no UI dependency");
    ok(/<InvariantGlobalization>false/.test(proj),
      "globalization data is kept — fa-IR and ar-SA need ICU");
    ok(/<Nullable>enable/.test(proj), "nullability is on");
    const tests = read("apps/native/Aurion.Core.Tests/Aurion.Core.Tests.csproj");
    ok(/xunit/.test(tests) && /Aurion\.Core\.csproj/.test(tests),
      "the test project references the library and a runner");
  }

  console.log(`\n${ok_} ok, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
