/**
 * The update server, answered over HTTP rather than read.
 *
 * Two reports, one cause each, and neither was visible in the source
 * without running it:
 *
 *   "Cannot GET /"   — the server had no root route at all, so Express
 *                      served its default 404. A running server that
 *                      says "Cannot GET /" reads as a broken one.
 *
 *   "the panel is    — every response carried
 *    raw HTML with     Content-Security-Policy: default-src 'none'.
 *    no styling"       On a JSON API that is correct. On a page it also
 *                      means no style-src and no script-src, so the
 *                      browser discarded the panel's own <style> and
 *                      <script> and drew the bare markup. The server
 *                      had forbidden the panel its own stylesheet.
 *
 * A static test could not have caught either. This starts the real
 * server on a spare port and asks it.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "admin", "update-server");
const PORT = 8971;
const HASH = "test-panel-hash-9f2";
const TOKEN = "test-token-for-the-suite";

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// The server's dependencies are not committed. On a fresh clone there is
// nothing to boot, and that is not a failure of the code under test.
if (!fs.existsSync(path.join(SERVER, "node_modules", "express"))) {
  console.log("SKIP  update server: node_modules not installed "
            + "(cd admin/update-server && npm install)");
  process.exit(0);
}

const child = spawn(process.execPath, ["src/index.js"], {
  cwd: SERVER,
  env: {
    ...process.env,
    PORT: String(PORT),
    ADMIN_PANEL_HASH: HASH,
    ADMIN_TOKEN: TOKEN,
    DATA_DIR: path.join(require("node:os").tmpdir(), "aurion-update-test-" + process.pid),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}`;

async function waitForIt(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function allowsInline(csp) {
  return /style-src[^;]*'unsafe-inline'/.test(csp)
      && /script-src[^;]*'unsafe-inline'/.test(csp)
      && /connect-src[^;]*'self'/.test(csp);
}

(async () => {
  const up = await waitForIt();
  check("the update server starts", up, up ? "" : log.slice(-400));
  if (!up) { child.kill(); finish(); return; }

  /* --- the front page ------------------------------------------------ */
  const root = await fetch(base + "/");
  const rootBody = await root.text();

  check("GET / is a page, not 'Cannot GET /'",
    root.status === 200 && !/Cannot GET/.test(rootBody), `status ${root.status}`);

  check("...that says the server is running",
    /AURION/.test(rootBody) && /8971|سرور آپدیت/.test(rootBody));

  // The hash is the only thing between the open internet and the
  // publish button. A public page that prints it hands it over.
  check("...and never prints the panel hash",
    !rootBody.includes(HASH));

  check("...and may load its own stylesheet",
    allowsInline(root.headers.get("content-security-policy") || ""),
    root.headers.get("content-security-policy") || "none");

  /* --- the panel ------------------------------------------------------ */
  const panel = await fetch(`${base}/admin/${HASH}`);
  const panelBody = await panel.text();

  check("the panel is served", panel.status === 200);

  check("the panel is styled, and allowed to be",
    /<style>/.test(panelBody)
    && allowsInline(panel.headers.get("content-security-policy") || ""),
    panel.headers.get("content-security-policy") || "none");

  check("the panel carries AURION's interface, not a default one",
    /--cyan:#3ee0c4/.test(panelBody) && /border-radius/.test(panelBody));

  check("it says nothing by alert() any more",
    !/alert\(/.test(panelBody));

  check("and it points at the merged panel for the rest of the job",
    /8900/.test(panelBody));

  /* --- the rest of /admin stays quiet --------------------------------- */
  const wrong = await fetch(base + "/admin/not-the-hash");
  check("a wrong hash is a 404 that still admits the server is alive",
    wrong.status === 404 && /running/i.test(await wrong.text()));

  /* --- the API is still locked down ----------------------------------- */
  const api = await fetch(base + "/api/health");
  check("API responses keep the strict policy",
    /default-src 'none'/.test(api.headers.get("content-security-policy") || ""));

  const noTok = await fetch(base + "/api/admin/updates");
  check("admin API without a token is 401", noTok.status === 401);

  const withTok = await fetch(base + "/api/admin/updates", {
    headers: { "X-Admin-Token": TOKEN },
  });
  check("admin API with the token is 200", withTok.status === 200);

  child.kill();
  finish();
})().catch((err) => {
  check("the suite ran", false, String(err && err.message || err));
  child.kill();
  finish();
});

function finish() {
  console.log(failed === 0
    ? "\nupdate panel: all checks passed"
    : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}
