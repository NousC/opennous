// The API plan's Usage and billing helpers (GET-633), pinned.
//
// Run: node --test apps/frontend/tests/usagePlan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { planLine, fillPct, dailyBars } from "../src/lib/usagePlan.ts";

const NOW = new Date(2026, 9, 2, 12, 0);
const TIERS = [{ credits: 960, priceUsd: 49 }, { credits: 2000, priceUsd: 99 }];

test("plan line prices from the bundle the allowance names", () => {
  const l = planLine({ plan: "api", aiCredits: { used: 312, included: 2000 }, subscription: { current_period_end: "2026-11-01" }, allPlans: [{ id: "api", monthlyPriceUsd: 49 }] }, TIERS, NOW);
  assert.deepEqual(l, { name: "API plan", price: "$99 a month", renews: "Renews 1 Nov", credits: 2000 });
});

test("unknown allowance falls back to the listed price; cancelling reads Ends", () => {
  const l = planLine({ plan: "api", aiCredits: { used: 0, included: 1234 }, subscription: { current_period_end: "2026-11-01", cancel_at_period_end: true }, allPlans: [{ id: "api", monthlyPriceUsd: 49 }] }, TIERS, NOW);
  assert.equal(l.price, "$49 a month");
  assert.equal(l.renews, "Ends 1 Nov");
});

test("no plan yet: from-price, no renewal, no credits line", () => {
  const l = planLine({ plan: "api", aiCredits: { used: 0, included: 960, needsPlan: true }, subscription: { current_period_end: "2026-11-01" } }, TIERS, NOW);
  assert.deepEqual(l, { name: "API plan", price: "From $49 a month", renews: null, credits: null });
});

test("fill is capped and safe on zero", () => {
  assert.equal(fillPct(312, 960), 32.5);
  assert.equal(fillPct(2000, 960), 100);
  assert.equal(fillPct(5, 0), 0);
  assert.equal(fillPct(null, 960), 0);
});

test("daily bars: heights against the peak, peak label, three axis dates", () => {
  const b = dailyBars([
    { day: "2026-09-03", credits: 4 }, { day: "2026-09-04", credits: 31 }, { day: "2026-09-05", credits: 0 },
  ], NOW);
  assert.deepEqual(b.bars.map((x) => x.pct), [13, 100, 0]);
  assert.equal(b.peak, "Peak 31 on 4 Sep");
  assert.deepEqual(b.axis, ["3 Sep", "4 Sep", "5 Sep"]);
  assert.equal(b.bars[1].label, "4 Sep: 31 credits");
});

test("daily bars with no usage have no peak", () => {
  const b = dailyBars([{ day: "2026-09-03", credits: 0 }], NOW);
  assert.equal(b.peak, null);
  assert.deepEqual(b.bars.map((x) => x.pct), [0]);
});

test("by-key credits: a number shows, 0 is muted, unknown is a dash and never 0", async () => {
  const { keyCreditsCell } = await import("../src/lib/usagePlan.ts");
  assert.deepEqual(keyCreditsCell(214), { text: "214", muted: false });
  assert.deepEqual(keyCreditsCell(1840), { text: "1,840", muted: false });
  assert.deepEqual(keyCreditsCell(0), { text: "0", muted: true });
  for (const v of [null, undefined, Number.NaN]) assert.deepEqual(keyCreditsCell(v), { text: "—", muted: true });
});
