// GET-897: built-in jobs read as RevBox jobs. Their card's activity line and On/Off, the box chip
// a built-in's item gets in Priorities, and the add-a-built-in request (an operation, never the
// page's whole list).
//
// Run: node --test apps/frontend/tests/builtinJobs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinActivity, builtinState, builtinChip, addBuiltinBody, builtinTooltip, prioritiesDestination, builtinRowMeta } from "../src/lib/builtinJobs.ts";
import { buildItems, builtinOf } from "../src/components/priorities/inboxModel.ts";

const ago = (iso: string) => `at ${iso.slice(11, 16)}`;

test("the activity line says how many in 30 days and when the last one was", () => {
  assert.equal(builtinActivity({ drafts_30d: 12, last_draft_at: "2026-10-15T09:30:00Z" }, ago), "12 in the last 30 days · last at 09:30");
  assert.equal(builtinActivity({ drafts_30d: 1, last_draft_at: null }, ago), "1 in the last 30 days");
  assert.equal(builtinActivity({ drafts_30d: 0, last_draft_at: null }, ago), "None in the last 30 days");
});

test("On/Off is the workspace's real switch; unknown shows nothing", () => {
  assert.equal(builtinState(true), "On");
  assert.equal(builtinState(false), "Off");
  assert.equal(builtinState(null), null);
  assert.equal(builtinState(undefined), null);
});

test("a built-in's item in Priorities gets its box's chip, only for a box the viewer can open", () => {
  const homes = [
    { key: "sales_follow_up" as const, box_id: "b1", box_name: "Meetings Follow-up" },
    { key: "stale_deal" as const, box_id: "b2", box_name: null },
  ];
  assert.deepEqual(builtinChip(homes, "sales_follow_up"), { boxId: "b1", name: "Meetings Follow-up", href: "/revboxes/b1" });
  assert.equal(builtinChip(homes, "stale_deal"), null);
  assert.equal(builtinChip(homes, "expansion"), null);
  assert.equal(builtinChip(null, "sales_follow_up"), null);

  const items = buildItems({
    recommendations: [{ id: "r1", kind: "follow_up_call", title: "x", why: null, entity_id: "e", account: { id: "a", name: "Acme", domain: null }, followup: { status: "ready", meeting: { kind: "Demo", at: "2026-10-15T10:00:00Z", title: "Demo" } } }],
    actions: [
      { id: "d1", kind: "email", recipient: "p", linkedin_url: null, body: "b", rationale: null, status: "pending", origin: { source: "rec", name: "Deal signals", builtin: "deal_signals" } },
      { id: "d2", kind: "email", recipient: "p", linkedin_url: null, body: "b", rationale: null, status: "pending", origin: { source: "chat", name: "Ask Nous" } },
    ],
  });
  assert.deepEqual(items.map(builtinOf), ["sales_follow_up", "deal_signals", null]);
});

test("adding a built-in sends the change, not the page's copy of the list", () => {
  assert.deepEqual(addBuiltinBody("expansion", 4), { builtin_add: ["expansion"], revision: 4 });
});

// GET-902: a built-in looks like a job. What it did lately moves into its card's tooltip, and its box's
// Delivery shows Priorities, where the built-ins deliver, instead of "No destinations yet".
test("the card's activity is its tooltip", () => {
  assert.equal(builtinTooltip({ drafts_30d: 43, last_draft_at: "2026-10-15T11:42:00Z" }, ago), "What it did: 43 in the last 30 days · last at 11:42. Its work waits in Priorities.");
});

test("a box with built-ins delivers to Priorities; one without has no such destination", () => {
  assert.deepEqual(prioritiesDestination([{ key: "sales_follow_up" }]), { label: "Priorities", sub: "drafts you approve" });
  assert.equal(prioritiesDestination([]), null);
  assert.equal(prioritiesDestination(undefined), null);
});

test("a built-in's row reads like a routine's: Starts · On · Last run", () => {
  assert.equal(builtinRowMeta({ cadence: "After each call", enabled: true, last_draft_at: "2026-10-15T11:42:00Z", brief: { starts: "After each meeting" } }, ago), "After each meeting · On · Last run at 11:42");
  assert.equal(builtinRowMeta({ cadence: "Nightly", enabled: false, last_draft_at: null }, ago), "Nightly · Off · Not run yet");
  assert.equal(builtinRowMeta({ cadence: "Hourly", enabled: null, last_draft_at: null }, ago), "Hourly · Not run yet");
});
