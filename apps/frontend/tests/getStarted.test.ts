// The Get started stepper's steps (GET-622), pinned.
//
// Run: node --test apps/frontend/tests/getStarted.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillCount, setupLocked, setupSteps, stepStatus } from "../src/lib/getStarted.ts";

type C = Parameters<typeof setupSteps>[0];
const base: C = {
  crm: { done: true, provider: "hubspot", imported: true, accounts: 5200 },
  mail: { done: true, providers: ["gmail"] },
  notes: { done: true, providers: ["fireflies"] },
  backfill: { state: "running", started: true },
  seat: "founder",
  api_key: { created: true, used: false },
};

test("a founder has four steps; done comes from the checklist", () => {
  const s = setupSteps(base);
  assert.deepEqual(s.map((x) => x.key), ["crm", "tools", "backfill", "agent"]);
  assert.deepEqual(s.map((x) => x.done), [true, true, true, false]);
});

test("an invited member has no CRM step", () => {
  const s = setupSteps({ ...base, seat: "member", crm: { done: false, provider: null, imported: false, accounts: 0 } });
  assert.deepEqual(s.map((x) => x.key), ["tools", "backfill", "agent"]);
});

test("tools are done only when both mail and notes are", () => {
  const s = setupSteps({ ...base, notes: { done: false, providers: [] } });
  assert.equal(s.find((x) => x.key === "tools")!.done, false);
});

test("the agent step is done on the key's first call, not on creating it", () => {
  assert.equal(setupSteps(base).at(-1)!.done, false);
  assert.equal(setupSteps({ ...base, api_key: { created: true, used: true } }).at(-1)!.done, true);
});

test("rail status lines say only what the data says", () => {
  assert.equal(stepStatus("crm", base, null), "HubSpot · 5,200 accounts");
  assert.equal(stepStatus("crm", { ...base, crm: { ...base.crm, imported: false } }, null), "HubSpot · importing");
  assert.equal(stepStatus("tools", base, null), "Gmail, Fireflies");
  assert.equal(stepStatus("tools", { ...base, mail: { done: true, providers: ["gmail", "gmail_oauth"] }, notes: { done: false } }, null), "Gmail");
  assert.equal(stepStatus("backfill", base, { state: "running", progress: { pct: 71, read: 2140, to_read: 3000 } }), "2,140 of 3,000");
  assert.equal(stepStatus("backfill", base, { state: "running", progress: { pct: 40, read: 12 } }), "40%");
  assert.equal(stepStatus("backfill", { ...base, backfill: { state: "done", started: true } }, null), "Done");
  assert.equal(stepStatus("backfill", { ...base, backfill: { state: "none", started: false } }, null), "Not started");
  assert.equal(stepStatus("agent", base, null), "Claude Code, MCP or API");
  assert.equal(stepStatus("agent", { ...base, api_key: { created: true, used: true } }, null), "Connected");
});

test("backfill count: read of to_read when known, 100% when done", () => {
  assert.deepEqual(backfillCount({ state: "running", progress: { pct: 71, read: 2140, to_read: 3000 } }), { read: 2140, of: 3000, pct: 71 });
  assert.deepEqual(backfillCount({ state: "running", progress: { pct: 5, read: null } }), { read: 0, of: null, pct: 5 });
  assert.deepEqual(backfillCount({ state: "done", progress: { pct: 98, read: 900, to_read: 900 } }), { read: 900, of: 900, pct: 100 });
});

test("starting free settles the backfill step until the upgrade (GET-682)", () => {
  const free = { ...base, plan: { live: false, free: true }, backfill: { state: "waiting" as const, started: false, start_on_payment: true } };
  assert.equal(setupSteps(free).find((x) => x.key === "backfill")?.done, true);
  assert.equal(stepStatus("backfill", free, null), "Runs when you upgrade");
  // Not on Free, or never chose: still waiting on a decision.
  const undecided = { ...free, backfill: { state: "waiting" as const, started: false } };
  assert.equal(setupSteps(undecided).find((x) => x.key === "backfill")?.done, false);
  const paidButWaiting = { ...free, plan: { live: true, free: false } };
  assert.equal(setupSteps(paidButWaiting).find((x) => x.key === "backfill")?.done, false);
});

test("the dialog locks only for an unpaid founder who has not started reading", () => {
  const none = { ...base, backfill: { state: "none" as const, started: false } };
  assert.equal(setupLocked(none), true);
  assert.equal(setupLocked(base), false);
  // An invited member with no backfill of their own joins a workspace that has records.
  assert.equal(setupLocked({ ...none, seat: "member" }), false);
  // A paid workspace is never trapped on a step it may not be able to finish.
  assert.equal(setupLocked({ ...none, plan: { live: true } }), false);
});

test("the plan is checked against a month like their last one (GET-682)", async () => {
  const { planFit } = await import("../src/lib/getStarted.ts");
  const tiers = [{ credits: 960, priceUsd: 49 }, { credits: 2000, priceUsd: 99 }, { credits: 4000, priceUsd: 199 }];
  assert.deepEqual(planFit(1600, 960, tiers), { monthly: 1600, plan: 960, rec: { credits: 2000, priceUsd: 99 } });
  assert.equal(planFit(800, 960, tiers), null, "covered");
  assert.equal(planFit(1600, null, tiers), null, "Free or unpaid: the picker says it instead");
  assert.equal(planFit(null, 960, tiers), null, "nothing counted");
  assert.equal(planFit(9000, 4000, tiers), null, "already on the largest bundle: nothing to move to");
});

import { notInCrmLine } from "../src/lib/getStarted.ts";

test("the backfill step names the people the meeting notes add that are not in the CRM (GET-788)", () => {
  assert.equal(notInCrmLine({ people: 12, accounts: 4 }), "12 people and 4 companies from your meeting notes aren't in your CRM. They're added too, tagged Not in CRM.");
  assert.equal(notInCrmLine({ people: 1, accounts: 0 }), "1 person from your meeting notes isn't in your CRM. They're added too, tagged Not in CRM.");
  assert.equal(notInCrmLine({ people: 0, accounts: 0 }), null);
  assert.equal(notInCrmLine(null), null);
});
