// The API keys pages' small rules (GET-629, GET-630, GET-639), pinned.
//
// Run: node --test apps/frontend/tests/apiKeys.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTEND_OPTIONS, KEY_NAME_MAX, UNDO_REVOKE_MS, extendErrorMessage, extendedExpiry, UNDO_TOAST_MS, accessLabel, restoreErrorMessage, canManageKey, daysLeft, keyNameError, renameErrorMessage, errorRate, expiresInLabel, expiringSoon, isExpired, maskedKey, prefixOf,
  revokeConfirmed, rotateExpiryDays, statusTone, surfaceLabel, writeSecret,
} from "../src/lib/apiKeys.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

test("the key column: stored prefix masked, else pk_…", () => {
  assert.equal(prefixOf("pk_3f9a1cdeadbeef"), "pk_3f9a1c");
  assert.equal(maskedKey("pk_3f9a1c"), "pk_3f9a1c••••••••");
  assert.equal(maskedKey(null), "pk_…");
  assert.equal(maskedKey(undefined), "pk_…");
});

test("access maps the API's capability values", () => {
  assert.equal(accessLabel("read_only"), "Read-only");
  assert.equal(accessLabel("read_write"), "Read & write");
  assert.equal(accessLabel(null), "Read & write");
});

test("expiry: days left, expired, and the 7-day window", () => {
  assert.equal(daysLeft(null, NOW), null);
  assert.equal(daysLeft(at(5.5), NOW), 6);
  assert.equal(isExpired(at(-0.1), NOW), true);
  assert.equal(isExpired(at(0.1), NOW), false);
  assert.equal(isExpired(null, NOW), false);
  const keys = [
    { id: "never", expires_at: null },
    { id: "gone", expires_at: at(-1) },
    { id: "six", expires_at: at(6) },
    { id: "two", expires_at: at(2) },
    { id: "eight", expires_at: at(8) },
  ];
  assert.deepEqual(expiringSoon(keys, NOW).map((k) => k.id), ["two", "six"]);
  assert.equal(expiresInLabel(at(6), NOW), "expires in 6 days");
  assert.equal(expiresInLabel(at(0.5), NOW), "expires tomorrow");
  assert.equal(expiresInLabel(at(0), NOW), "expires today");
});

test("rotate keeps the remaining lifetime, never makes an expiring key permanent", () => {
  assert.equal(rotateExpiryDays({ expires_at: null, created_at: at(-10) }, NOW), 0);
  assert.equal(rotateExpiryDays({ expires_at: at(29.2), created_at: at(-0.8) }, NOW), 30);
});

test("rotating an expired or same-day key renews its original lifetime, not forever", () => {
  // A 30-day key, expired two days ago.
  assert.equal(rotateExpiryDays({ expires_at: at(-2), created_at: at(-32) }, NOW), 30);
  // A 7-day key with five hours left.
  assert.equal(rotateExpiryDays({ expires_at: at(5 / 24), created_at: at(-7 + 5 / 24) }, NOW), 7);
  // Lifetime rounds up; an unknown creation date falls back to 90 days.
  assert.equal(rotateExpiryDays({ expires_at: at(-1), created_at: at(-31.5) }, NOW), 31);
  assert.equal(rotateExpiryDays({ expires_at: at(-1), created_at: null }, NOW), 90);
  assert.equal(rotateExpiryDays({ expires_at: at(-1) }, NOW), 90);
});

test("request status and surface", () => {
  assert.equal(statusTone(200), "ok");
  assert.equal(statusTone(204), "ok");
  assert.equal(statusTone(401), "warn");
  assert.equal(statusTone(429), "warn");
  assert.equal(statusTone(500), "bad");
  assert.equal(surfaceLabel("mcp"), "MCP");
  assert.equal(surfaceLabel("rest"), "REST");
  assert.equal(surfaceLabel(null), "REST");
});

test("error rate over the last 7 days", () => {
  assert.equal(errorRate({ calls_7d: 0, errors_7d: 0 }), null);
  assert.equal(errorRate({ calls_7d: 1000, errors_7d: 4 }), "0.4%");
  assert.equal(errorRate({ calls_7d: 1000, errors_7d: 0 }), "0%");
  assert.equal(errorRate({ calls_7d: 100000, errors_7d: 1 }), "<0.1%");
  assert.equal(errorRate({ calls_7d: 10, errors_7d: 3 }), "30%");
});

test("revoke needs the exact name", () => {
  assert.equal(revokeConfirmed("metabase-read", "metabase-readonly"), false);
  assert.equal(revokeConfirmed(" metabase-readonly ", "metabase-readonly"), true);
  assert.equal(revokeConfirmed("Metabase-readonly", "metabase-readonly"), false);
  assert.equal(revokeConfirmed("", ""), false);
});

test("writeSecret reports a refused clipboard instead of throwing", async () => {
  const g = globalThis as { navigator?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } } });
    assert.equal(await writeSecret("pk_x"), false);
    let got = "";
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (s: string) => { got = s; } } } });
    assert.equal(await writeSecret("pk_y"), true);
    assert.equal(got, "pk_y");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    assert.equal(await writeSecret("pk_z"), false);
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete g.navigator;
  }
});

test("rotate/revoke show only for keys the server marks manageable", () => {
  assert.equal(canManageKey({ can_manage: false }), false);
  assert.equal(canManageKey({ can_manage: true }), true);
  // An older API without the field: show, the server still answers 403.
  assert.equal(canManageKey({}), true);
});

test("rename: the same name rule as the API, and the refusal toasts", () => {
  assert.equal(KEY_NAME_MAX, 60);
  assert.equal(keyNameError("  cursor "), null);
  assert.equal(keyNameError("x".repeat(60)), null);
  assert.match(keyNameError("x".repeat(61)) ?? "", /60/);
  assert.match(keyNameError("   ") ?? "", /empty/);
  assert.match(renameErrorMessage("name_taken"), /already has that name/);
  assert.match(renameErrorMessage("name_too_long"), /1 to 60/);
  assert.match(renameErrorMessage("forbidden"), /old name stays/);
  assert.match(renameErrorMessage(null), /old name stays/);
});

test("undo revoke: the toast's Undo ends well inside the API's 10-minute window; refusals say why", () => {
  assert.equal(UNDO_REVOKE_MS, 10 * 60_000);
  assert.ok(UNDO_TOAST_MS >= 5_000 && UNDO_TOAST_MS < UNDO_REVOKE_MS);
  assert.match(restoreErrorMessage("undo_window_passed"), /Too late/);
  assert.match(restoreErrorMessage("key_expired"), /expired/);
  assert.match(restoreErrorMessage("key_rotated"), /rotation/);
  assert.match(restoreErrorMessage("name_taken"), /name/);
  assert.match(restoreErrorMessage(undefined), /stays revoked/);
});

test("extend: max(now, expiry) + days, as the API computes it; the three choices", () => {
  assert.deepEqual(EXTEND_OPTIONS.map((o) => o.days), [30, 90, 365]);
  assert.equal(extendedExpiry(at(6), 90, NOW), at(96));
  assert.equal(extendedExpiry(at(-20), 30, NOW), at(30));
  assert.equal(extendedExpiry(null, 90, NOW), null);
  assert.equal(extendedExpiry("not a date", 90, NOW), null);
  assert.match(extendErrorMessage("key_revoked"), /revoked/);
  assert.match(extendErrorMessage("no_expiry"), /never expires/);
  assert.match(extendErrorMessage("boom"), /unchanged/);
});
