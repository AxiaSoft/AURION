"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./paths");
const { load, save } = require("./config");
const identity = require("./identity");

const OWNER_FILE = path.join(ROOT, "config", "owner.gmail");

function readFileGmail() {
  try {
    if (!fs.existsSync(OWNER_FILE)) return "";
    return String(fs.readFileSync(OWNER_FILE, "utf8") || "").split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

function normalizeGmail(raw) {
  const ident = identity.normalizeIdentity(raw);
  if (!ident || ident.type !== "gmail") return "";
  return ident.value;
}

function lockedOwnerGmail() {
  const cfg = load();
  const fromCfg = normalizeGmail((cfg.owner && cfg.owner.gmail) || "");
  if (fromCfg) return fromCfg;
  return normalizeGmail(readFileGmail());
}

function maskGmail(gmail) {
  const value = String(gmail || "");
  const at = value.indexOf("@");
  if (at < 1) return "";
  const local = value.slice(0, at);
  const vis = local.slice(0, Math.min(2, local.length));
  return vis + "***@" + value.slice(at + 1);
}

function lockOwnerGmail(raw) {
  const gmail = normalizeGmail(raw);
  if (!gmail) {
    const err = new Error("owner_gmail");
    err.status = 400;
    throw err;
  }
  const cfg = load();
  cfg.owner = { ...(cfg.owner || {}), gmail, locked: true };
  save(cfg);
  fs.writeFileSync(OWNER_FILE, gmail + "\n", { encoding: "utf8", mode: 0o600 });
  return gmail;
}

function shouldClaimOwner(ident) {
  const auth = require("./auth");
  if (!ident || ident.type !== "gmail") return false;
  if (!auth.needsOwner()) return false;
  const locked = lockedOwnerGmail();
  if (locked) return ident.value === locked;
  return true;
}

function publicState() {
  const locked = lockedOwnerGmail();
  const auth = require("./auth");
  const owner = (auth.listUsers() || []).find((u) => u && u.is_owner) || null;
  return {
    needs_owner: auth.needsOwner(),
    locked: Boolean(locked),
    hint: locked ? maskGmail(locked) : "",
    username: owner ? owner.username : "",
  };
}

module.exports = {
  OWNER_FILE,
  lockedOwnerGmail,
  maskGmail,
  lockOwnerGmail,
  shouldClaimOwner,
  publicState,
  normalizeGmail,
};
