/**
 * Market session hours.
 *
 * The wrap-around case is the one that matters: Sydney opens at 21:00 UTC and
 * closes at 06:00, so its end hour is smaller than its start. A naive
 * `open <= h && h < close` makes that session vanish entirely, which is the
 * classic way this overlay breaks.
 *
 *     node apps/web/js/sessions.test.cjs
 */
const assert = require("node:assert");
const { MARKET_SESSIONS, sessionCovers, sessionsAt } = require("./charts.js");

const byId = Object.fromEntries(MARKET_SESSIONS.map((s) => [s.id, s]));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok  " + name); }

check("London is open mid-afternoon UTC and shut at night", () => {
  assert.equal(sessionCovers(byId.london, 10), true);
  assert.equal(sessionCovers(byId.london, 2), false);
});

check("Sydney wraps past midnight", () => {
  assert.equal(sessionCovers(byId.sydney, 22), true, "before midnight");
  assert.equal(sessionCovers(byId.sydney, 3), true, "after midnight");
  assert.equal(sessionCovers(byId.sydney, 12), false, "midday is shut");
});

check("a session is closed exactly at its closing hour", () => {
  assert.equal(sessionCovers(byId.london, 16), false);
  assert.equal(sessionCovers(byId.london, 15.99), true);
});

check("hours outside 0-23 are normalised", () => {
  assert.equal(sessionCovers(byId.tokyo, 24), sessionCovers(byId.tokyo, 0));
  assert.equal(sessionCovers(byId.tokyo, -1), sessionCovers(byId.tokyo, 23));
});

check("London and New York overlap in the afternoon", () => {
  const open = sessionsAt(new Date("2026-03-10T14:00:00Z")).map((s) => s.id);
  assert.deepEqual(open.sort(), ["london", "newyork"]);
});

check("the Tokyo/Sydney handover has both open", () => {
  const open = sessionsAt(new Date("2026-03-10T02:00:00Z")).map((s) => s.id);
  assert.deepEqual(open.sort(), ["sydney", "tokyo"]);
});

check("every hour of the day has at least one centre open", () => {
  for (let h = 0; h < 24; h++) {
    const at = new Date(Date.UTC(2026, 2, 10, h, 30));
    assert.ok(sessionsAt(at).length > 0, `nothing open at ${h}:30 UTC`);
  }
});

check("a bad timestamp yields nothing rather than throwing", () => {
  assert.deepEqual(sessionsAt(new Date("not a date")), []);
  assert.deepEqual(sessionsAt(null), []);
});

console.log(`\n${passed} checks passed.`);
