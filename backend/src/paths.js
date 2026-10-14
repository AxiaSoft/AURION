const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_DIR = process.env.AURION_CONFIG_DIR
  ? path.resolve(process.env.AURION_CONFIG_DIR)
  : path.join(ROOT, "config");

// Everything the desk writes at runtime — the access database, the JWT
// secret, logs, exports, uploads — lives under one directory so a deployment
// can point it at a volume, a per-user profile, or a throwaway sandbox
// without touching the source tree. Unset keeps the historical layout.
const DATA = process.env.AURION_DATA_DIR
  ? path.resolve(process.env.AURION_DATA_DIR)
  : path.join(ROOT, "data");

const CONFIG = path.join(CONFIG_DIR, "aurion.json");
const LANG = path.join(ROOT, "lang");
const WEB = path.join(ROOT, "apps", "web");
const EXPORTS = path.join(DATA, "exports");
const UPLOADS = path.join(DATA, "uploads");
const USERS = path.join(DATA, "users.json");
const SECRET_FILE = path.join(DATA, "jwt.secret");
const ACCESS_DB = path.join(DATA, "aurion.access.db");
const ACCESS_PY = path.join(__dirname, "access_db.py");

module.exports = {
  ROOT, CONFIG, CONFIG_DIR, LANG, DATA, WEB, EXPORTS, UPLOADS, USERS, SECRET_FILE, ACCESS_DB, ACCESS_PY,
};
