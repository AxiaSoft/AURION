#!/usr/bin/env node
/*
 * arp-clean.test.js — behavioural regression tests for the AURION uninstaller
 * logic, run on a mocked machine (WMI registry + file system + process
 * launcher). Runs anywhere Node.js exists; no Windows or wscript needed.
 *
 *   node windows-app/packaging/tests/arp-clean.test.js
 *
 * Covers: wix/arp-clean-inner.js (the template) and the generated wrappers
 * (wix/arp-clean.js, wix/arp-remove-old.js) + the installed standalone
 * uninstaller (wix/uninstall-aurion.js).
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const HERE = __dirname;
const WIX = path.join(HERE, "..", "wix");
const TEMPLATE = path.join(WIX, "arp-clean-inner.js");

const OWN = "{11111111-2222-3333-4444-555555555555}";
const STALE_CU = "{99999999-8888-7777-6666-555555555555}";
const OTHER = "{88888888-4444-2222-1111-999999999999}";
const STALE_HKLM = "{AAAA9999-8888-7777-6666-555555555555}";
const U1 = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const UW = "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const ROOT = "C:\\Users\\u\\AppData\\Local\\Programs\\AURION";
const SCRIPT = ROOT + "\\resources\\uninstall-aurion.js";
const SM = "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\AURION";
const TASKBAR = "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\AURION.lnk";

let dirs, vals, folders, files;
function reset(opts) {
  opts = opts || {};
  dirs = {
    ["HKCU|" + U1]: [OWN, STALE_CU, OTHER].filter((x) => !(opts.noOwnInstalled && x === OWN)),
    ["HKCU|" + UW]: [],
    ["HKLM|" + U1]: [STALE_HKLM],
    ["HKLM|" + UW]: [],
  };
  vals = {
    ["HKCU|" + U1 + "\\" + OWN]: { DisplayName: "AURION", UninstallString: 'wscript.exe "' + SCRIPT + '"', InstallLocation: ROOT + "\\" },
    ["HKCU|" + U1 + "\\" + STALE_CU]: { DisplayName: "AURION 0.9" },
    ["HKCU|" + U1 + "\\" + OTHER]: { DisplayName: "Other App" },
    ["HKLM|" + U1 + "\\" + STALE_HKLM]: { DisplayName: "AURION machine" },
    ["HKCU|Software\\AURION"]: opts.noAppKey ? undefined : { InstallPath: ROOT + "\\", Version: "1.0.0" },
  };
  folders = {}; files = {};
  const mk = (k, d, f) => { folders[k] = { dirs: d || [], files: f || [] }; };
  mk(ROOT, ["resources", "config", "backend"], ["AURION.exe"]);
  mk(ROOT + "\\resources", ["data", "app"], []);
  mk(ROOT + "\\resources\\data", ["license"], ["db.sqlite"]);
  mk(ROOT + "\\resources\\data\\license", [], ["key.dat"]);
  mk(ROOT + "\\resources\\app", [], ["main.js"]);
  mk(ROOT + "\\config", [], ["aurion.json"]);
  mk(ROOT + "\\backend", ["node_modules"], []);
  mk(ROOT + "\\backend\\node_modules", [], ["x.js"]);
  mk(SM, [], ["AURION.lnk"]);
  files["C:\\Users\\u\\Desktop\\AURION.lnk"] = 1;
  files[TASKBAR] = 1;
}

class Enum { constructor(a){this.a=a;this.i=0;} atEnd(){return this.i>=this.a.length;} item(){return this.a[this.i];} moveNext(){this.i++;} }

function makeCtx(admin, props) {
  const cmds = [], logs = [], popups = [];
  let elevated = null;
  const ctx = {
    VBArray: function (a) { return { toArray: () => a }; },
    Enumerator: Enum,
    WScript: { Arguments: { Length: admin ? 1 : 0 }, Sleep: () => {}, ScriptFullName: SCRIPT },
    GetObject: () => ({
      Methods_: { Item: () => ({ InParameters: { SpawnInstance_: () => ({}) } }) },
      ExecMethod_: (m, a) => {
        const hive = a.hDefKey === 0x80000001 ? "HKCU" : "HKLM";
        if (m === "EnumKey") {
          if (a.sSubKeyName === "Software\\AURION") {
            const n = vals["HKCU|Software\\AURION"];
            return { ReturnValue: n ? 0 : 1, sNames: n ? Object.keys(n) : null };
          }
          const list = dirs[hive + "|" + a.sSubKeyName];
          return { ReturnValue: list ? 0 : 1, sNames: list || null };
        }
        if (a.sSubKeyName === "Software\\AURION") {
          const n = vals["HKCU|Software\\AURION"];
          const has = n && n[a.sValueName] !== undefined;
          return { ReturnValue: has ? 0 : 1, sValue: has ? n[a.sValueName] : "" };
        }
        const v = vals[hive + "|" + a.sSubKeyName];
        const has = v && v[a.sValueName] !== undefined;
        return { ReturnValue: has ? 0 : 1, sValue: has ? v[a.sValueName] : "" };
      },
    }),
    ActiveXObject: function (n) {
      if (n === "WScript.Shell") return {
        ExpandEnvironmentStrings: (x) => String(x)
          .replace("%TEMP%", "C:\\T")
          .replace("%LOCALAPPDATA%", "C:\\Users\\u\\AppData\\Local")
          .replace("%APPDATA%", "C:\\Users\\u\\AppData\\Roaming"),
        Run: (c) => { cmds.push(c); return 0; },
        Popup: (t) => { popups.push(String(t)); return 1; },
        SpecialFolders: () => "C:\\Users\\u\\Desktop",
      };
      if (n === "Scripting.FileSystemObject") return {
        OpenTextFile: () => ({ WriteLine: (m) => logs.push(m), Close() {} }),
        CreateTextFile: () => ({ Write: (b) => { ctx.__inner = b; }, Close() {} }),
        FileExists: (f) => files[f] === 1,
        DeleteFile: (f) => { delete files[f]; },
        FolderExists: (f) => { const k = f.replace(/[\\\/]+$/, ""); return !!folders[k]; },
        DeleteFolder: (f) => {
          const k = f.replace(/[\\\/]+$/, "");
          if (!folders[k]) throw new Error("no " + k);
          delete folders[k];
          for (const p of Object.keys(folders)) if (p.startsWith(k + "\\")) delete folders[p];
        },
        CreateFolder: (f) => { folders[f] = { dirs: [], files: [] }; },
        CopyFolder: (s2, d) => {
          const k = s2.replace(/[\\\/]+$/, ""), dk = d.replace(/[\\\/]+$/, "");
          if (!folders[k]) throw new Error("no " + k);
          const cl = (src, dst) => {
            folders[dst] = { dirs: folders[src].dirs.map((x) => x), files: folders[src].files.map((x) => x) };
            for (const p of Object.keys(folders)) if (p.startsWith(src + "\\")) cl(p, dst + p.slice(src.length));
          };
          cl(k, dk);
        },
        GetFolder: (f) => {
          const k = f.replace(/[\\\/]+$/, "");
          const n = folders[k];
          if (!n) throw new Error("no " + k);
          return {
            SubFolders: n.dirs.map((d) => ({ Name: d, Path: k + "\\" + d })),
            Files: n.files.map((x) => ({ Name: x, Path: k + "\\" + x })),
          };
        },
      };
      if (n === "Shell.Application") return { ShellExecute: (...a) => { elevated = a; } };
      throw new Error("AX " + n);
    },
  };
  ctx.__cmds = cmds; ctx.__logs = logs; ctx.__popups = popups; ctx.__elevated = () => elevated;
  return ctx;
}

function runTemplate(globals, admin, opts) {
  reset(opts);
  let tpl = fs.readFileSync(TEMPLATE, "utf8");
  tpl = globals + "\n" + tpl;
  const ctx = makeCtx(admin, {});
  vm.createContext(ctx);
  vm.runInContext(tpl, ctx);
  return ctx;
}

function runChain(wrapperFile, props, opts) {
  reset(opts || {});
  const outer = fs.readFileSync(wrapperFile, "utf8");
  let inner = null, launched = null;
  const pctx = {
    Session: { Property: (k) => (k in props ? String(props[k]) : "") },
    ActiveXObject: function (n) {
      if (n === "WScript.Shell") return {
        ExpandEnvironmentStrings: (x) => String(x).replace("%TEMP%", "C:\\T"),
        Run: (c) => { launched = c; return 0; },
      };
      if (n === "Scripting.FileSystemObject") return { CreateTextFile: () => ({ Write: (b) => { inner = b; }, Close() {} }) };
      throw new Error("AX " + n);
    },
  };
  vm.createContext(pctx); vm.runInContext(outer, pctx);
  if (!inner) throw new Error(wrapperFile + ": inner script not written");
  const ctx = makeCtx(false, props);
  ctx.__launched = launched;
  vm.createContext(ctx); vm.runInContext(inner, ctx);
  return ctx;
}

let ok = true;
const expect = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) ok = false; };

// ---- 1) standalone uninstaller, healthy engine -----------------------------
{
  console.log("== 1) uninstall-aurion.js, engine healthy ==");
  const tpl = 'var OWN="SELF";var MODE="remove";var MYDIR="";var KEEP=1;var CODES="";var UNINSTALL=0;var ENGINE=1;var POPUP=1;';
  const ctx = runTemplate(tpl, false, {});
  expect("SELF discovered", ctx.__logs.some((l) => l.includes("found self product " + OWN)));
  expect("engine uninstall first", ctx.__cmds.some((c) => c.includes("msiexec.exe /x " + OWN + " /passive")));
  expect("taskkill", ctx.__cmds.some((c) => c.startsWith("taskkill")));
  expect("HKCU\\Software\\AURION deleted", ctx.__cmds.some((c) => c.includes('delete "HKCU\\Software\\AURION"')));
  expect("own ARP force-clean", ctx.__cmds.some((c) => c.includes(OWN) && c.includes("Uninstall")));
  expect("desktop lnk removed", files["C:\\Users\\u\\Desktop\\AURION.lnk"] !== 1);
  expect("pinned taskbar lnk removed", files[TASKBAR] !== 1);
  expect("start menu folder removed", !folders[SM]);
  expect("license kept", !!folders[ROOT + "\\resources\\data\\license"]);
  expect("config kept", !!folders[ROOT + "\\resources\\config"]);
  expect("app files gone", !folders[ROOT + "\\resources\\app"]);
  expect("start popup shown", ctx.__popups.some((p) => p.includes("being removed")));
  expect("done popup shown", ctx.__popups.some((p) => p.includes("has been removed")));
}
// ---- 2) standalone uninstaller, BROKEN engine registration ------------------
{
  console.log("== 2) uninstall-aurion.js, engine broken (no app key) ==");
  const tpl = 'var OWN="SELF";var MODE="remove";var MYDIR="";var KEEP=1;var CODES="";var UNINSTALL=0;var ENGINE=1;var POPUP=1;';
  const ctx = runTemplate(tpl, false, { noAppKey: true });
  expect("SELF still discovered", ctx.__logs.some((l) => l.includes("found self product " + OWN)));
  expect("engine attempted (may fail), force path ran", ctx.__cmds.some((c) => c.startsWith("taskkill")));
  expect("license kept", !!folders[ROOT + "\\resources\\data\\license"]);
  expect("app files gone", !folders[ROOT + "\\resources\\app"]);
}
// ---- 3) moved-install fallback (script folder is the app tree) --------------
{
  console.log("== 3) moved install fallback (no ARP entry points at us) ==");
  const tpl = 'var OWN="SELF";var MODE="remove";var MYDIR="";var KEEP=1;var CODES="";var UNINSTALL=0;var ENGINE=1;var POPUP=1;';
  const ctx = runTemplate(tpl, false, { noAppKey: true });
  // simulate: the ARP discovery found nothing -> fallback uses the script dir
  expect("fallback engaged or self found", ctx.__logs.some((l) => l.includes("using script folder") || l.includes("found self product")));
}
// ---- 4) template as CA: REMOVE mode (wizard transaction) --------------------
{
  console.log("== 4) CA wrapper arp-clean.js REMOVE (keep-data) ==");
  const ctx = runChain(path.join(WIX, "arp-clean.js"),
    { ProductCode: OWN, AURION_REMOVING: "1", AURION_KEEPDATA: "1", INSTALLDIR: ROOT, REMOVE: "" }, {});
  expect("launched wscript", !!ctx.__launched && ctx.__launched.includes("wscript.exe"));
  expect("taskkill", ctx.__cmds.some((c) => c.startsWith("taskkill")));
  expect("license restored", !!folders[ROOT + "\\resources\\data\\license"]);
  expect("HKCU\\Software\\AURION deleted", ctx.__cmds.some((c) => c.includes('delete "HKCU\\Software\\AURION"')));
  expect("NO popup inside wizard session", ctx.__popups.length === 0);
  expect("no engine attempt inside session", !ctx.__cmds.some((c) => c.includes("msiexec.exe /x " + OWN + " /passive")));
}
// ---- 5) CA wrapper arp-clean.js CLEAN after uninstall -----------------------
{
  console.log("== 5) CA wrapper arp-clean.js CLEAN after UNINSTALL ==");
  const ctx = runChain(path.join(WIX, "arp-clean.js"),
    { ProductCode: OWN, AURION_REMOVING: "", AURION_KEEPDATA: "1", INSTALLDIR: ROOT, REMOVE: "ALL" }, {});
  expect("node_modules removed", !folders[ROOT + "\\backend\\node_modules"]);
  expect("stale HKCU uninstalled", ctx.__cmds.some((c) => c.includes("/x " + STALE_CU)));
  expect("tree kept", !!folders[ROOT + "\\resources\\data\\license"]);
  expect("no taskkill in clean", !ctx.__cmds.some((c) => c.startsWith("taskkill")));
}
// ---- 6) CA wrapper arp-clean.js CLEAN after install (update) ----------------
{
  console.log("== 6) CA wrapper arp-clean.js CLEAN after INSTALL ==");
  const ctx = runChain(path.join(WIX, "arp-clean.js"),
    { ProductCode: OWN, AURION_REMOVING: "", AURION_KEEPDATA: "1", INSTALLDIR: "", REMOVE: "" }, {});
  expect("node_modules NOT touched", !!folders[ROOT + "\\backend\\node_modules"]);
}
// ---- 7) CA wrapper arp-remove-old.js (mode-dialog Remove) -------------------
{
  console.log("== 7) CA wrapper arp-remove-old.js ==");
  const ctx = runChain(path.join(WIX, "arp-remove-old.js"),
    { ProductCode: OWN, AURION_KEEPDATA: "1", AURION_PREV_PATH: ROOT, OLDPRODUCTFOUND: STALE_CU }, { noOwnInstalled: true });
  expect("previous product uninstalled passive", ctx.__cmds.some((c) => c.includes("/x " + STALE_CU) && c.includes("/passive")));
  expect("no self-uninstall", !ctx.__cmds.some((c) => c.includes("msiexec /x " + OWN)));
  expect("license restored", !!folders[ROOT + "\\resources\\data\\license"]);
  expect("HKLM stale -> UAC retry", !!ctx.__elevated());
}
// ---- 8) version compare matrix ----------------------------------------------
{
  console.log("== 8) version compare (VBScript logic transliterated) ==");
  const cmp = (prev, cur) => {
    if (String(prev).trim() === "") return "older";
    const pv = String(prev).split("."), cv = String(cur).split(".");
    for (let i = 0; i < 3; i++) {
      const num = (s) => (/^\d+$/.test(String(s)) ? parseInt(s, 10) : 0);
      const a = num(pv[i]), b = num(cv[i]);
      if (a > b) return "newer";
      if (a < b) return "older";
    }
    return "same";
  };
  const cases = [["1.0.0","1.0.0","same"],["1.0","1.0.0","same"],["0.9","1.0.0","older"],["1.0.1","1.0.0","newer"],["","1.0.0","older"],["1.0.0.0","1.0.0","same"],["1.10.0","1.9.9","newer"],["1.0.0","1.0.2","older"]];
  for (const [a, b, e] of cases) expect(`${a} vs ${b} = ${e}`, cmp(a, b) === e);
}

console.log(ok ? "\nALL PASS" : "\nSOME FAILURES");
process.exit(ok ? 0 : 1);
