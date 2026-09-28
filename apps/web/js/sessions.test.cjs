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
const { MARKET_SESSIONS, sessionCovers, sessionsAt, sessionOpensBetween } = require("./charts.js");

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

/* -------------------------------------------------------------------------
   Marking the open on the candle it happens on.
   ------------------------------------------------------------------------- */
const ids = (a, b) => sessionOpensBetween(new Date(a), new Date(b)).map((s) => s.id);

check("London's open is marked on the candle that crosses 07:00 UTC", () => {
  assert.deepEqual(ids("2026-03-10T06:00:00Z", "2026-03-10T07:00:00Z"), ["london"]);
  assert.deepEqual(ids("2026-03-10T07:00:00Z", "2026-03-10T08:00:00Z"), [],
    "not marked again on the next candle");
});

check("a candle inside a session is not an open", () => {
  assert.deepEqual(ids("2026-03-10T10:00:00Z", "2026-03-10T11:00:00Z"), []);
});

check("Sydney's open is found across midnight", () => {
  assert.deepEqual(ids("2026-03-10T20:00:00Z", "2026-03-10T21:00:00Z"), ["sydney"]);
});

check("a 4H candle still reports an open that happened inside it", () => {
  // 04:00 -> 08:00 contains London's 07:00 open even though neither endpoint
  // is the opening hour.
  assert.ok(ids("2026-03-10T04:00:00Z", "2026-03-10T08:00:00Z").includes("london"));
});

check("two centres opening on one candle are both reported", () => {
  const open = ids("2026-03-10T11:00:00Z", "2026-03-10T13:00:00Z");
  assert.ok(open.includes("newyork"));
});

check("a weekend gap is left unmarked rather than flagging everything", () => {
  assert.deepEqual(ids("2026-03-06T21:00:00Z", "2026-03-09T01:00:00Z"), [],
    "a gap of a day or more would otherwise stack four flags on one candle");
});

check("out-of-order or identical timestamps report nothing", () => {
  assert.deepEqual(ids("2026-03-10T08:00:00Z", "2026-03-10T07:00:00Z"), []);
  assert.deepEqual(ids("2026-03-10T08:00:00Z", "2026-03-10T08:00:00Z"), []);
  assert.deepEqual(sessionOpensBetween(new Date("bad"), new Date()), []);
});

console.log(`\n${passed} checks passed.`);
