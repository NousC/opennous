// Notification preferences (GET-636), pinned.
//
// Run: node --test apps/frontend/tests/notificationPrefs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_NOTIF_KEYS, defaultNotifPrefs, effectiveNotifPrefs, isOn, modeOf, notifRowsFor, setMode, setOn,
} from "../src/components/settings/notificationPrefs.ts";

test("the API plan shows its own five rows; Custom never shows the API alerts", () => {
  assert.deepEqual(notifRowsFor(true).map((r) => r.key),
    ["account_signals", "sync_failures", "webhook_failures", "key_expiring", "credits_low"]);
  assert.deepEqual(notifRowsFor(true).slice(2).map((r) => r.label),
    ["Webhook failures", "Key expiring", "Credits running low"]);
  assert.equal(notifRowsFor(false).length, 5);
  for (const k of ["webhook_failures", "key_expiring", "credits_low"]) {
    assert.ok(!notifRowsFor(false).some((r) => r.key === k));
    assert.ok(API_NOTIF_KEYS.includes(k));
  }
});

test("API alerts default on for owners and admins, off for members (what the api sends)", () => {
  for (const k of ["webhook_failures", "key_expiring", "credits_low"]) {
    assert.equal(isOn(defaultNotifPrefs(), k), true);
    assert.equal(isOn(defaultNotifPrefs({ admin: true }), k), true);
    assert.equal(isOn(defaultNotifPrefs({ admin: false }), k), false);
  }
  assert.equal(isOn(defaultNotifPrefs({ admin: false }), "sync_failures"), true);
});

test("defaults are all on, both channels", () => {
  const p = defaultNotifPrefs();
  assert.equal(p.daily_digest, true);
  assert.equal(isOn(p, "mentions"), true);
  assert.equal(modeOf(p, "mentions"), "both");
});

test("the switch clears and restores both channels; the stored shape is unchanged", () => {
  const off = setOn(defaultNotifPrefs(), "sync_failures", false);
  assert.deepEqual(off.sync_failures, { email: false, app: false });
  assert.equal(isOn(off, "sync_failures"), false);
  const on = setOn(off, "sync_failures", true);
  assert.deepEqual(on.sync_failures, { email: true, app: true });
  assert.equal(on.daily_digest, true);
});

test("mode maps onto the two channels", () => {
  const p = defaultNotifPrefs();
  assert.deepEqual(setMode(p, "mentions", "email").mentions, { email: true, app: false });
  assert.deepEqual(setMode(p, "mentions", "app").mentions, { email: false, app: true });
  assert.equal(modeOf(setMode(p, "mentions", "app"), "mentions"), "app");
  assert.equal(modeOf(setMode(p, "mentions", "email"), "mentions"), "email");
});

test("a stored row that predates a key reads as on", () => {
  const p = { daily_digest: false } as ReturnType<typeof defaultNotifPrefs>;
  assert.equal(isOn(p, "account_signals"), true);
});

test("the shown prefs follow the role even when it resolves after the load", () => {
  const stored = { daily_digest: false };
  // Before /me says admin: API alerts default off.
  assert.equal(isOn(effectiveNotifPrefs(stored, false), "webhook_failures"), false);
  // Once it does: on, and the stored choice still wins where one was made.
  const admin = effectiveNotifPrefs(stored, true);
  assert.equal(isOn(admin, "webhook_failures"), true);
  assert.equal(admin.daily_digest, false);
  assert.equal(isOn(effectiveNotifPrefs({ webhook_failures: { email: false, app: false } }, true), "webhook_failures"), false);
  assert.deepEqual(effectiveNotifPrefs(null, true), defaultNotifPrefs({ admin: true }));
});
