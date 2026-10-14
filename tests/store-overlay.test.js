/**
 * Nothing invisible may sit in front of the page.
 *
 * The storefront loaded, answered every request, and could not be used:
 * a full-screen veil with no writing on it covered the whole window and
 * swallowed every click.
 *
 * It was <div class="modal" hidden>. The browser hides [hidden] with a
 * user-agent rule of display:none, and ANY author rule that sets display
 * beats a user-agent rule regardless of specificity. `.modal{position:
 * fixed; inset:0; background:rgba(0,0,0,.6); backdrop-filter:blur(8px);
 * z-index:50; display:grid}` therefore won, permanently. `.mobile-menu`
 * (display:flex, z-index:30) was doing the same one layer below.
 *
 * This renders the real markup with the real stylesheet and asks the
 * same question a user would: is anything marked hidden actually on
 * screen? jsdom carries the HTML default stylesheet, so the check fails
 * against the old CSS and passes against the fixed one.
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

let failed = 0;
function check(name, ok, detail) {
  const good = ok === true;
  if (!good) failed++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** Every page in the product that ships its own stylesheet. */
const PAGES = [
  {
    name: "store",
    html: "store/keyserver/public/index.html",
    css: ["store/keyserver/public/style.css"],
  },
  {
    name: "admin panel",
    html: "admin/panel/public/index.html",
    css: [],                                   // styles live in the page
  },
  {
    name: "update panel",
    html: "admin/update-server/public/panel.html",
    css: [],                                   // styles live in the page
  },
];

for (const page of PAGES) {
  const htmlPath = path.join(ROOT, page.html);
  if (!fs.existsSync(htmlPath)) {
    check(`${page.name}: page exists`, false, page.html);
    continue;
  }

  let html = fs.readFileSync(htmlPath, "utf8");

  // Inline the stylesheets; jsdom does not fetch them.
  const styles = page.css
    .map((p) => fs.readFileSync(path.join(ROOT, p), "utf8"))
    .join("\n");
  html = html.replace("</head>", `<style>${styles}</style></head>`);

  // No script execution: this is about what the first paint looks like,
  // which is exactly when the user met the veil.
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const { window } = dom;
  const doc = window.document;

  // Not every page uses the attribute; that is fine, and not a result.
  const hiddenEls = [...doc.querySelectorAll("[hidden]")];
  console.log(`      ${page.name}: ${hiddenEls.length} element(s) marked hidden`);

  const showing = hiddenEls.filter(
    (el) => window.getComputedStyle(el).display !== "none"
  );

  check(`${page.name}: everything marked hidden is actually hidden`,
    showing.length === 0,
    showing.map((el) => {
      const id = el.id ? "#" + el.id : "";
      const cls = el.className ? "." + String(el.className).split(/\s+/).join(".") : "";
      return (id + cls) + " is " + window.getComputedStyle(el).display;
    }).join(", "));

  // The one-line cure, so a new overlay cannot bring the bug back.
  if (page.css.length > 0) {
    check(`${page.name}: the stylesheet honours [hidden] outright`,
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles));
  }

  // A veil that covers the window must at least say something, so that
  // if one ever shows up by mistake it is reportable rather than blank.
  const veils = [...doc.querySelectorAll("*")].filter((el) => {
    const s = window.getComputedStyle(el);
    return s.position === "fixed" && s.inset === "0px" && s.display !== "none";
  });
  check(`${page.name}: no blank full-window layer at rest`,
    veils.length === 0,
    veils.map((el) => el.id || el.className).join(", "));

  window.close();
}

console.log(failed === 0
  ? "\nstore overlay: all checks passed"
  : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
