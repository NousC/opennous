// The sidebar credits meter (GET-620), pinned.
//
// Run: node --test apps/frontend/tests/credits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsMeter } from "../src/lib/credits.ts";

const NOW = new Date(2026, 9, 2, 12, 0);

test("used / included with a reset date", () => {
  const m = creditsMeter({ aiCredits: { used: 312, included: 960 }, subscription: { current_period_end: "2026-11-01" } }, NOW);
  assert.deepEqual(m, { used: "312", included: "960", pct: 32.5, resets: "Resets 1 Nov", over: false, stopped: false });
});

test("no period end: no reset line", () => {
  const m = creditsMeter({ aiCredits: { used: 5, included: 2000 }, subscription: null }, NOW);
  assert.equal(m?.resets, null);
  assert.equal(m?.included, "2,000");
});

test("over the allowance caps the bar at 100", () => {
  assert.equal(creditsMeter({ aiCredits: { used: 2600, included: 2000 } }, NOW)?.pct, 100);
});

test("no allowance: no included figure, empty bar", () => {
  const m = creditsMeter({ aiCredits: { used: 40, included: null } }, NOW);
  assert.equal(m?.included, null);
  assert.equal(m?.pct, 0);
});

test("nothing to show without credits or without a live plan", () => {
  assert.equal(creditsMeter(null, NOW), null);
  assert.equal(creditsMeter({ aiCredits: null }, NOW), null);
  assert.equal(creditsMeter({ aiCredits: { used: 0, included: 2000, needsPlan: true } }, NOW), null);
});

test("over the allowance: the card says an upgrade is needed; past 120% reading has stopped (GET-733)", () => {
  const over = creditsMeter({ aiCredits: { used: 1050, included: 960, state: "over" } }, NOW);
  assert.equal(over?.over, true);
  assert.equal(over?.stopped, false);
  const stopped = creditsMeter({ aiCredits: { used: 1200, included: 960, state: "restricted" } }, NOW);
  assert.equal(stopped?.stopped, true);
  assert.equal(creditsMeter({ aiCredits: { used: 900, included: 960, state: "warn" } }, NOW)?.over, false);
});

test("no subscription end: resets a month after the period start the API gives", () => {
  const m = creditsMeter({ aiCredits: { used: 5, included: 960, periodEnd: "2026-10-19T13:01:49Z" }, subscription: { current_period_end: null } }, NOW);
  assert.equal(m?.resets, "Resets 19 Oct");
});
