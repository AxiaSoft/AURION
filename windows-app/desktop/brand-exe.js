#!/usr/bin/env node
/*
 * brand-exe.js — stamp the AURION icon + version strings into the packaged
 * AURION.exe (electron-builder runs with signAndEditExecutable=false, so the
 * unpacked exe still carries the stock Electron icon; that icon is what
 * Apps & features / the taskbar show).
 *
 *   node brand-exe.js <path\to\AURION.exe> [icon.ico] [version]
 *
 * Pure JS (resedit) — no rcedit / wine / signtool needed.
 */
"use strict";
const fs = require("fs");
const path = require("path");

async function main() {
  const [exe, icoArg, verArg] = process.argv.slice(2);
  if (!exe || !fs.existsSync(exe)) {
    console.error("usage: node brand-exe.js <AURION.exe> [icon.ico] [version]");
    process.exit(2);
  }
  const ico = icoArg || path.join(__dirname, "icon.ico");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const version = verArg || pkg.version || "1.0.0";
  const nums = version.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  while (nums.length < 4) nums.push(0);

  const R = await import("resedit");
  const buf = fs.readFileSync(exe);
  const pe = R.NtExecutable.from(buf, { ignoreCert: true });
  const res = R.NtExecutableResource.from(pe);

  // ---- version info --------------------------------------------------
  const viList = R.Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList.length ? viList[0] : R.Resource.VersionInfo.createEmpty();
  const langs = vi.getAllLanguagesForStringValues();
  const lang = langs.length ? langs[0] : { lang: 0x0409, codepage: 1200 };
  vi.setFileVersion(nums[0], nums[1], nums[2], nums[3], lang.lang);
  vi.setProductVersion(nums[0], nums[1], nums[2], nums[3], lang.lang);
  vi.setStringValues(lang, {
    CompanyName: pkg.author || "Axiasoft",
    FileDescription: pkg.productName || "AURION",
    FileVersion: version,
    InternalName: "AURION",
    OriginalFilename: "AURION.exe",
    ProductName: pkg.productName || "AURION",
    ProductVersion: version,
    LegalCopyright: `Copyright © ${new Date().getFullYear()} ${pkg.author || "Axiasoft"}`,
  });
  vi.outputToResourceEntries(res.entries);

  // ---- icon (group 1 = Electron's main icon) --------------------------
  if (fs.existsSync(ico)) {
    const iconFile = R.Data.IconFile.from(fs.readFileSync(ico));
    R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang.lang, iconFile.icons.map((i) => i.data));
    // some Electron builds keep the group under a different lang id — replace those too
    for (const g of R.Resource.IconGroupEntry.fromEntries(res.entries)) {
      if (g.id === 1 && g.lang !== lang.lang) {
        R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, g.lang, iconFile.icons.map((i) => i.data));
      }
    }
  } else {
    console.warn("icon not found, skipping icon:", ico);
  }

  res.outputResource(pe);
  const out = Buffer.from(pe.generate());
  fs.writeFileSync(exe, out);
  console.log(`branded ${exe} (v${version}, icon ${path.basename(ico)}, ${(out.length / 1048576).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error("brand-exe failed:", e && e.stack || e);
  process.exit(1);
});
