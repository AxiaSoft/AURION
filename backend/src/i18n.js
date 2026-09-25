const fs = require("fs");
const path = require("path");
const { LANG } = require("./paths");

const cache = {};

function pack(lang) {
  const code = ["en", "fa", "ar"].includes(lang) ? lang : "en";
  if (!cache[code]) {
    cache[code] = JSON.parse(fs.readFileSync(path.join(LANG, `${code}.json`), "utf8"));
  }
  return cache[code];
}

function t(lang, dotted, vars = {}) {
  const parts = dotted.split(".");
  let node = pack(lang);
  for (const part of parts) {
    if (!node || typeof node !== "object" || !(part in node)) {
      node = pack("en");
      for (const fb of parts) {
        if (!node || typeof node !== "object" || !(fb in node)) return dotted;
        node = node[fb];
      }
      break;
    }
    node = node[part];
  }
  let text = String(node);
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

function detect(req) {
  const q = (req.query && req.query.lang) || "";
  if (["en", "fa", "ar"].includes(q)) return q;
  if (req.user && ["en", "fa", "ar"].includes(req.user.language)) return req.user.language;
  const al = String(req.headers["accept-language"] || "").toLowerCase();
  if (al.startsWith("fa") || al.includes("fa-")) return "fa";
  if (al.startsWith("ar") || al.includes("ar-")) return "ar";
  return "en";
}

module.exports = { pack, t, detect };
