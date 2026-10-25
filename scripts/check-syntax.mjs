/**
 * Parse every tracked JavaScript file.
 *
 * `node --check` is the cheapest guard the repo has: the desk ships its
 * sources straight to the browser with no bundler and no build step, so a
 * syntax error in any one of them is only discovered when a user opens the
 * page that loads it.
 *
 *     node scripts/check-syntax.mjs
 */
import { execFileSync } from "node:child_process";

const tracked = execFileSync(
  "git",
  ["ls-files", "*.js", "*.cjs", "*.mjs"],
  { encoding: "utf8" }
)
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  // Vendored dependencies are not ours to police.
  .filter((f) => !f.includes("node_modules/"));

const broken = [];
for (const file of tracked) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    broken.push(`${file}\n${String(err.stderr || err.message).trim()}`);
  }
}

if (broken.length) {
  console.error(`${broken.length} file(s) do not parse:\n\n${broken.join("\n\n")}`);
  process.exit(1);
}
console.log(`${tracked.length} JavaScript files parse cleanly.`);
