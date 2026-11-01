import { test } from "node:test";
import assert from "node:assert/strict";
import { trialBanner, trialEnded, trialWallApplies } from "../src/lib/trial.ts";
import { planLine } from "../src/lib/usagePlan.ts";
import { creditsMeter } from "../src/lib/credits.ts";

const SIZES = [{ name: "Starter", credits: 2000, priceUsd: 79 }, { name: "Growth", credits: 4000, priceUsd: 149 }];

test("the banner counts down, then says the trial ended, and is silent otherwise", () => {
  const at = (trial: unknown) => trialBanner({ aiCredits: { trial } } as never);
  assert.equal(at({ daysLeft: 9, ended: false })?.text, "Trial: 9 days left.");
  assert.equal(at({ daysLeft: 9, ended: false })?.tone, "neutral");
  assert.equal(at({ daysLeft: 1, ended: false })?.text, "Trial: 1 day left.");
  assert.equal(at({ daysLeft: 1, ended: false })?.tone, "warning");
  assert.equal(at({ daysLeft: 0, ended: true })?.tone, "risk");
  assert.match(at({ daysLeft: 0, ended: true })?.text ?? "", /^Trial ended\./);
  assert.equal(at(null), null);
  assert.equal(trialBanner(null), null);
});

test("a trial that ended stops everything and says so, and billing stays open", () => {
  const ended = { aiCredits: { trial: { daysLeft: 0, ended: true } } } as never;
  const text = trialBanner(ended)?.text ?? "";
  assert.match(text, /stopped/);
  assert.match(text, /Subscribe/);
  assert.doesNotMatch(text, /readable/);
  assert.equal(trialEnded(ended), true);
  assert.equal(trialEnded({ aiCredits: { trial: { daysLeft: 3, ended: false } } } as never), false);
  assert.equal(trialEnded({ aiCredits: { trial: null } } as never), false);
  assert.equal(trialEnded(null), false);
  for (const path of ["/", "/accounts", "/rev-plays"]) assert.equal(trialWallApplies(path), true, path);
  for (const path of ["/billing", "/settings", "/company/billing", "/admin", "/admin/users"]) assert.equal(trialWallApplies(path), false, path);
});

test("the plan line reads a trial as a trial", () => {
  const l = planLine({ plan: "api", aiCredits: { used: 10, included: 500, trial: { endsAt: "x", daysLeft: 3, ended: false } }, subscription: { current_period_end: "2026-11-15" } }, SIZES);
  assert.deepEqual(l, { name: "Trial", price: "3 days left", renews: null, credits: 500 });
});

test("the plan line names a size, and a grandfathered price reads as itself", () => {
  assert.equal(planLine({ plan: "api", priceUsd: 79, aiCredits: { used: 0, included: 2000 } }, SIZES).name, "Starter");
  const old = planLine({ plan: "api", priceUsd: 99, aiCredits: { used: 0, included: 2000 } }, SIZES);
  assert.equal(old.price, "$99 a month");
  assert.equal(old.name, "API plan");
});

test("a trial's credits do not reset", () => {
  assert.equal(creditsMeter({ aiCredits: { used: 1, included: 500, trial: { ended: false }, periodEnd: "2026-11-15" } })?.resets, null);
});
