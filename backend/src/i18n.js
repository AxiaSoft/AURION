const fs = require("fs");
const path = require("path");
const { LANG } = require("./paths");

/* The packs are read once and kept, but "once" has to mean "once per
   version of the file", not "once per process".
 *
 * Reported from the field: a desk that had just been updated showed an
 * English label in the middle of a Persian page. The pack on disk had
 * the string; this cache was holding the copy it read when the server
 * started, before the update replaced the file, and the desk asks
 * /api/i18n/<lang> BEFORE it falls back to the published lang/*.json -
 * so the fresh file on disk was never consulted. Every new string an
 * update shipped stayed invisible until somebody restarted the server,
 * and nothing anywhere said so.
 *
 * A stat per request is the whole cost of never having that again:
 * cheap next to the parse it avoids, and it is the file's own mtime
 * and size that decide, so a file replaced by an update, by the
 * recovery script, or by hand all invalidate alike. */
const cache = {};

function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function pack(lang) {
  const code = ["en", "fa", "ar"].includes(lang) ? lang : "en";
  const file = path.join(LANG, `${code}.json`);
  const at = stamp(file);
  const held = cache[code];
  if (held && held.at === at) return held.pack;
  try {
    cache[code] = { at, pack: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    /* A pack that cannot be read right now - mid-copy, say - must not
       take the desk down with it. The copy we already have is older
       than the disk but it is a pack; nothing is not. */
    if (held) return held.pack;
    throw err;
  }
  return cache[code].pack;
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
