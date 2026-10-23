/**
 * Translation parity.
 *
 * The desk reads one pack per language and falls back to printing the raw key
 * when a lookup misses, so a key added to en.json and forgotten in fa.json
 * ships as literal "settings.prop_enabled" in the Persian UI. Compare the
 * flattened key sets instead of waiting for someone to notice.
 *
 *     node scripts/check-lang.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LANG = join(dirname(fileURLToPath(import.meta.url)), "..", "lang");
const BASE = "en";

const flatten = (node, prefix = "", out = new Set()) => {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out);
    else out.add(path);
  }
  return out;
};

const packs = {};
for (const file of readdirSync(LANG).filter((f) => f.endsWith(".json"))) {
  packs[file.replace(/\.json$/, "")] = flatten(JSON.parse(readFileSync(join(LANG, file), "utf8")));
}

if (!packs[BASE]) {
  console.error(`lang/${BASE}.json is missing — nothing to compare against.`);
  process.exit(1);
}

let failed = false;
for (const [lang, keys] of Object.entries(packs)) {
  if (lang === BASE) continue;
  const missing = [...packs[BASE]].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !packs[BASE].has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`lang/${lang}.json differs from ${BASE}:`);
    if (missing.length) console.error(`  missing (${missing.length}): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`);
    if (extra.length) console.error(`  extra   (${extra.length}): ${extra.slice(0, 20).join(", ")}${extra.length > 20 ? " …" : ""}`);
  }
}

if (failed) process.exit(1);
console.log(`${Object.keys(packs).join(", ")} all define the same ${packs[BASE].size} keys.`);
