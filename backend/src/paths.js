const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG = path.join(ROOT, "config", "aurion.json");
const LANG = path.join(ROOT, "lang");
const DATA = path.join(ROOT, "data");
const WEB = path.join(ROOT, "apps", "web");
const EXPORTS = path.join(DATA, "exports");
const UPLOADS = path.join(DATA, "uploads");
const USERS = path.join(DATA, "users.json");
const SECRET_FILE = path.join(DATA, "jwt.secret");
const ACCESS_DB = path.join(DATA, "aurion.access.db");
const ACCESS_PY = path.join(__dirname, "access_db.py");

module.exports = {
  ROOT, CONFIG, LANG, DATA, WEB, EXPORTS, UPLOADS, USERS, SECRET_FILE, ACCESS_DB, ACCESS_PY,
};
