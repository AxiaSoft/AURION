/* The API surface is a contract now, so it gets checked like one.
 *
 * Phase one. The native desk replaces the web one, which turns this
 * surface from an implementation detail of a single codebase into the
 * contract a SECOND client is written against. Up to now it existed
 * only as 115 route registrations scattered through backend/src and
 * 75 call sites scattered through app.js, and nothing anywhere
 * checked that the two agreed - let alone that the engine served what
 * the backend proxied to.
 *
 * Three layers, two joins:
 *
 *   desk     /api/x      ->  backend serves /api/x
 *   backend  /api/x      ->  engine serves  /v1/y
 *
 * A break in the first join is a button that does nothing. A break in
 * the second is the same failure one layer further in, and harder to
 * see because the backend answers 200 with an error body.
 *
 * Checked by reading the source, so this runs with no engine, no
 * terminal and no network.
 */

let ok_ = 0, bad = 0;
function ok(cond, what, detail) {
  if (cond) { ok_ += 1; console.log("ok   " + what + (detail ? "  — " + detail : "")); }
  else { bad += 1; console.log("  x  " + what + (detail ? "  — " + detail : "")); }
}

(async () => {
  const S = await import("../scripts/api-surface.mjs");
  const fs = require("fs");
  const path = require("path");

  console.log("— the three layers agree ----------------------------------");

  const s = S.surface();

  ok(s.unserved.length === 0,
    "every /api path the desk calls is served by the backend",
    s.unserved.length ? s.unserved.join(", ") : `${s.counts.desk} paths`);

  ok(s.dangling.length === 0,
    "every passthrough aims at a /v1 route the engine serves",
    s.dangling.length
      ? s.dangling.map((d) => `${d.api} -> ${d.engine}`).join(", ")
      : `${s.routes.filter((r) => r.engine.length).length} proxied`);

  /* Floors, not equalities. A surface that is allowed to shrink
     silently is one that can be emptied by a bad merge and still pass,
     which is the failure mode of every "the sweep was undone" check in
     this repo. */
  ok(s.counts.engine >= 68, "the engine still serves its routes", `${s.counts.engine}`);
  ok(s.counts.backend >= 115, "the backend still registers its routes", `${s.counts.backend}`);
  ok(s.counts.desk >= 75, "the desk still reaches the engine by name", `${s.counts.desk}`);

  console.log("\n— the matcher itself ---------------------------------------");

  /* The joins above are only as honest as this, and a matcher that
     says yes to everything would make every check above pass. */
  ok(S.routeMatches("/api/users/:id/:off", "/api/users/7/0"),
    "a parametrised route matches a concrete path");
  ok(!S.routeMatches("/api/users/:id", "/api/users/7/0"),
    "and does not match a longer one");
  ok(!S.routeMatches("/api/order", "/api/kill"),
    "two different paths do not match");
  ok(S.routeMatches("/api/order", "/api/order/"),
    "a trailing slash is not a different route");
  ok(!S.routeMatches("/api/exports/:name", "/api/exports"),
    "a parameter is not optional");

  console.log("\n— the written contract is current --------------------------");

  /* The port is written against the file, not against this test run,
     so the file has to be the same answer the source gives. Generated
     by scripts/api-surface.mjs; regenerate with `npm run api:surface`. */
  const MANIFEST = path.join(__dirname, "..", "docs", "api-surface.json");
  const onDisk = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : null;
  ok(onDisk !== null, "docs/api-surface.json exists");

  if (onDisk) {
    const fresh = { routes: s.routes, engineRoutes: s.engineRoutes };
    ok(JSON.stringify(onDisk.routes) === JSON.stringify(fresh.routes)
      && JSON.stringify(onDisk.engineRoutes) === JSON.stringify(fresh.engineRoutes),
      "and matches the source",
      "run `npm run api:surface` after changing a route");

    ok(onDisk.routes.every((r) => typeof r.path === "string" && Array.isArray(r.methods)),
      "every entry carries a path and its methods");

    /* The whole point of writing it down: a client that is not this
       desk has to be able to find the engine route behind an /api
       path without reading Express source. */
    const proxied = onDisk.routes.filter((r) => r.engine.length);
    ok(proxied.length >= 55,
      "and the proxied ones name their engine route",
      `${proxied.length} of ${onDisk.routes.length}`);
  }

  console.log("\n— nothing is reachable by accident -------------------------");

  {
    /* Auth is part of the contract. A route registered on `app`
       instead of `guarded` is outside the middleware, and the native
       client needs to know which those are rather than discovering
       them. This does not judge them - several are deliberately open,
       like the EA ingest endpoint - it pins the count so a new one
       cannot be added without a deliberate edit here. */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "backend", "src", "index.js"), "utf8");
    const open = [...src.matchAll(/app\.(get|post|put|delete)\(\s*"(\/api[^"]*)"/g)]
      .map((m) => m[2]);
    const unique = [...new Set(open)].sort();
    ok(unique.length <= 60,
      "the set of /api routes outside the auth middleware is pinned",
      `${unique.length} open`);
  }

  console.log(`\n${ok_} ok, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
