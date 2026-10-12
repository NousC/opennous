// The API plan's source cards (GET-631), pinned.
//
// Run: node --test apps/frontend/tests/sourceCardModel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { accountLine, anySyncing, progressTitle, shortAgo, sourceStatus, syncPercent, syncedLabel } from "../src/components/integrations/sourceCardModel.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();

test("status comes only from what the connection reports", () => {
  assert.deepEqual(sourceStatus({ is_verified: true }), { kind: "live", label: "Live" });
  assert.deepEqual(sourceStatus({ is_verified: false }), { kind: "warn", label: "Needs attention" });
  const p = (percent: number) => ({ percent, done: 1, total: 2, label: "Importing history" });
  assert.deepEqual(sourceStatus({ is_verified: true, sync_progress: p(72.6) }), { kind: "syncing", label: "Syncing 72%" });
  assert.deepEqual(sourceStatus({ is_verified: true, sync_progress: p(0) }), { kind: "syncing", label: "Syncing 0%" });
  // No progress, a finished or a nonsense one is not a sync in flight.
  assert.equal(sourceStatus({ is_verified: true, sync_progress: null }).kind, "live");
  assert.equal(sourceStatus({ is_verified: true, sync_progress: p(100) }).kind, "live");
  assert.equal(sourceStatus({ is_verified: true, sync_progress: p(Number.NaN) }).kind, "live");
  // A broken connection is broken, whatever its progress says.
  assert.equal(sourceStatus({ is_verified: false, sync_progress: p(40) }).kind, "warn");
});

test("relative times are short", () => {
  assert.equal(shortAgo(before(20_000), NOW), "just now");
  assert.equal(shortAgo(before(4 * 60_000), NOW), "4m ago");
  assert.equal(shortAgo(before(3 * 3_600_000), NOW), "3h ago");
  assert.equal(shortAgo(before(2 * 86_400_000), NOW), "2d ago");
  assert.equal(shortAgo(null, NOW), null);
  assert.equal(shortAgo("not a date", NOW), null);
  // A clock slightly ahead never says "in the future".
  assert.equal(shortAgo(new Date(NOW + 5_000).toISOString(), NOW), "just now");
});

test("the foot never guesses a sync time", () => {
  assert.equal(syncedLabel(before(4 * 60_000), before(86_400_000 * 5), NOW), "Synced 4m ago");
  assert.equal(syncedLabel(null, before(86_400_000 * 5), NOW), "Connected 5d ago");
  assert.equal(syncedLabel(null, null, NOW), "Not synced yet");
});

test("the account line: the connection's name, who connected a shared one, else who it is for", () => {
  assert.equal(accountLine({ name: "Gmail", scope: "personal", provider: { display_name: "Gmail" } }), "Only you");
  assert.equal(accountLine({ name: "theo@acme.example", scope: "personal", provider: { display_name: "Gmail" } }), "theo@acme.example");
  assert.equal(accountLine({ name: "HubSpot", scope: "company", owner_name: "Theo", provider: { display_name: "HubSpot" } }), "connected by Theo");
  assert.equal(accountLine({ name: "HubSpot", scope: "company", is_mine: true, owner_name: "Theo", provider: { display_name: "HubSpot" } }), "connected by you");
  assert.equal(accountLine({ name: "Prod portal", scope: "company", owner_name: "Ana", provider: { display_name: "HubSpot" } }), "Prod portal · connected by Ana");
  assert.equal(accountLine({ name: "Slack", scope: "company", provider: { display_name: "Slack" } }, "Opennous"), "Everyone in Opennous");
});

test("sync progress: the percent, the poll switch and the bar's tooltip", () => {
  const running = { percent: 35.2, done: 1204, total: 3412, label: "Importing history" };
  assert.equal(syncPercent(running), 35);
  assert.equal(syncPercent(null), null);
  assert.equal(syncPercent({ percent: -1, done: 0, total: 0 }), null);
  assert.equal(progressTitle(running), "Importing history · 1,204 of 3,412");
  assert.equal(progressTitle({ ...running, label: null }), "1,204 of 3,412");
  assert.equal(progressTitle({ ...running, percent: 100 }), undefined);
  assert.equal(progressTitle(null), undefined);
  // Polling runs only while a card is actually syncing; a broken one does not keep it alive.
  assert.equal(anySyncing([{ is_verified: true, sync_progress: running }, { is_verified: true }]), true);
  assert.equal(anySyncing([{ is_verified: true }, { is_verified: true, sync_progress: null }]), false);
  assert.equal(anySyncing([{ is_verified: false, sync_progress: running }]), false);
  assert.equal(anySyncing([]), false);
});
