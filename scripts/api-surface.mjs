/**
 * The desk's API surface, read out of the source rather than described.
 *
 * Three layers have to agree for any request to work:
 *
 *   the desk        calls  /api/x
 *   the backend     serves /api/x and proxies it to /v1/y
 *   the engine      serves /v1/y
 *
 * Nothing has ever checked that they do. A desk path with no backend
 * route is a 404 the trader meets as a button that does nothing; a
 * passthrough aimed at a /v1 route the engine does not serve is the
 * same failure one layer further in.
 *
 * It matters more now than it did. The native port replaces the web
 * desk, so this surface stops being an implementation detail of one
 * codebase and becomes the contract a second client is written
 * against. A contract that exists only as 115 scattered route
 * registrations is not one anybody can code against, so it is read
 * out mechanically here and written down in docs/api-surface.json.
 *
 * Reading the source, not the running server: the surface has to be
 * checkable in a test run with no engine, no terminal and no network.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Strip a trailing slash without turning "/" into "". */
const tidy = (p) => p.replace(/\/+$/, "") || "/";

/**
 * Does a concrete path match a registered Express route pattern?
 *
 * Only ":param" segments, which is all this codebase uses. Written out
 * rather than pulled in, because a dependency for one regex is a
 * dependency to keep updated forever.
 */
export function routeMatches(pattern, concrete) {
  const a = tidy(pattern).split("/");
  const b = tidy(concrete).split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
}

/** Every /v1 route the engine actually serves. */
export function engineRoutes() {
  const src = read("engine/aurion/api/server.py");
  const out = new Map();
  for (const m of src.matchAll(/@app\.(get|post|put|delete|patch)\("([^"]+)"/g)) {
    const p = tidy(m[2]);
    if (!out.has(p)) out.set(p, new Set());
    out.get(p).add(m[1].toUpperCase());
  }
  return out;
}

/**
 * Every /api route the backend serves.
 *
 * Two registration styles, and both count: `guarded.get("/x", ...)`
 * mounts under /api behind the auth middleware, and `app.get("/api/x")`
 * registers the full path directly.
 */
export function backendRoutes() {
  const src = read("backend/src/index.js");
  const out = new Map();
  const add = (p, verb, target) => {
    const k = tidy(p);
    if (!out.has(k)) out.set(k, { verbs: new Set(), targets: new Set() });
    out.get(k).verbs.add(verb.toUpperCase());
    if (target) out.get(k).targets.add(target);
  };
  for (const m of src.matchAll(/guarded\.(get|post|put|delete)\(\s*"([^"]+)"/g)) {
    add("/api" + m[2], m[1]);
  }
  for (const m of src.matchAll(/app\.(get|post|put|delete)\(\s*"(\/api[^"]*)"/g)) {
    add(m[2], m[1]);
  }
  // The proxy targets, so the second hop can be checked too.
  for (const m of src.matchAll(
    /guarded\.(get|post|put|delete)\(\s*"([^"]+)"\s*,\s*passthrough\(\s*"(\w+)"\s*,\s*"([^"]+)"/g)) {
    add("/api" + m[2], m[1], m[4]);
  }
  return out;
}

/**
 * Every /api path the desk asks for.
 *
 * Literal prefixes only. A call like API.get("/api/users/" + id) is
 * recorded as the fixed part it starts with, because that is the part
 * a route has to exist for; the id is matched against ":param" by
 * routeMatches. Template holes are cut at the first ${.
 */
export function deskCalls() {
  const dir = path.join(ROOT, "apps/web/js");
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js") || name.includes(".test.")) continue;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    for (const m of src.matchAll(/API\.(get|post|download)\(\s*([`"'])([^`"']*)/g)) {
      const verb = m[1] === "download" ? "GET" : m[1].toUpperCase();
      let p = m[3].split("?")[0].split("${")[0];
      if (!p.startsWith("/api")) continue;
      p = tidy(p);
      if (p === "/api") continue;
      if (!out.has(p)) out.set(p, { verbs: new Set(), files: new Set() });
      out.get(p).verbs.add(verb);
      out.get(p).files.add(name);
    }
  }
  return out;
}

/** A desk path is served when some backend route matches it, or is its parent. */
export function servedBy(routes, call) {
  for (const pattern of routes.keys()) {
    if (routeMatches(pattern, call)) return pattern;
    // "/api/exports/" + name is written as the literal "/api/exports"
    // and served by "/api/exports/:name".
    if (routeMatches(pattern, call + "/x")) return pattern;
  }
  return null;
}

export function surface() {
  const engine = engineRoutes();
  const backend = backendRoutes();
  const desk = deskCalls();

  const unserved = [];
  for (const call of desk.keys()) if (!servedBy(backend, call)) unserved.push(call);

  const dangling = [];
  for (const [p, info] of backend) {
    for (const target of info.targets) {
      const t = tidy(target.split("?")[0]);
      if (!engine.has(t)) dangling.push({ api: p, engine: t });
    }
  }

  return {
    counts: { engine: engine.size, backend: backend.size, desk: desk.size },
    unserved: unserved.sort(),
    dangling: dangling.sort((a, b) => a.api.localeCompare(b.api)),
    routes: [...backend.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, i]) => ({
      path: p,
      methods: [...i.verbs].sort(),
      engine: [...i.targets].sort(),
      usedByDesk: Boolean([...desk.keys()].find((c) => servedBy(new Map([[p, i]]), c))),
    })),
    engineRoutes: [...engine.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([p, v]) => ({ path: p, methods: [...v].sort() })),
  };
}
