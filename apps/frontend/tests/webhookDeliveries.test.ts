// The Webhooks page's delivery-log helpers (GET-632), pinned.
//
// Run: node --test apps/frontend/tests/webhookDeliveries.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliveryStatus, formatDuration, successLabel, isFailing, maskSecret, resendMessage, testSendMessage, type Delivery,
} from "../src/lib/webhookDeliveries.ts";

const row = (over: Partial<Delivery>): Delivery => ({
  id: "d", subscription_id: "s", event: "deal.won", event_id: "e", attempt: 1,
  status_code: 200, ok: true, error: null, duration_ms: 120, created_at: "2026-10-02T10:00:00Z", resent_from: null,
  ...over,
});

test("status pill: 2xx, 5xx, timeout, network failure", () => {
  assert.deepEqual(deliveryStatus(row({})), { tone: "ok", label: "200" });
  assert.deepEqual(deliveryStatus(row({ ok: false, status_code: 502 })), { tone: "error", label: "502" });
  assert.deepEqual(deliveryStatus(row({ ok: false, status_code: null, error: "timeout" })), { tone: "timeout", label: "Timeout" });
  assert.deepEqual(deliveryStatus(row({ ok: false, status_code: null, error: "ECONNREFUSED" })), { tone: "error", label: "Failed" });
});

test("durations", () => {
  assert.equal(formatDuration(184), "184 ms");
  assert.equal(formatDuration(1200), "1.2 s");
  assert.equal(formatDuration(2000), "2 s");
  assert.equal(formatDuration(null), "—");
});

test("success label: one decimal, null when nothing was sent", () => {
  assert.equal(successLabel({ success_rate_7d: 0.9917, deliveries_7d: 120, failures_7d: 1, last_delivery_at: null }), "99.2% delivered · 7 days");
  assert.equal(successLabel({ success_rate_7d: 1, deliveries_7d: 3, failures_7d: 0, last_delivery_at: null }), "100% delivered · 7 days");
  assert.equal(successLabel({ success_rate_7d: null, deliveries_7d: 0, failures_7d: 0, last_delivery_at: null }), null);
});

test("failing: three failures this week and the latest attempt failed", () => {
  const stats = (f: number) => ({ success_rate_7d: 0.5, deliveries_7d: 10, failures_7d: f, last_delivery_at: null });
  const bad = [row({ ok: false, status_code: 500 })];
  const good = [row({})];
  assert.equal(isFailing(stats(2), bad), false);
  assert.equal(isFailing(stats(3), bad), true);
  assert.equal(isFailing(stats(3), good), false, "recovered");
  assert.equal(isFailing(stats(5), []), true, "no log loaded yet, stats decide");
  assert.equal(isFailing(null, bad), false);
});

test("secret mask keeps the prefix and last four", () => {
  assert.equal(maskSecret("whsec_abcdefghijklmnop3f9a"), `whsec_${"•".repeat(20)}3f9a`);
  assert.equal(maskSecret(""), "");
});

test("resend messages", () => {
  assert.equal(resendMessage(410, { error: "payload_gone" }).ok, false);
  assert.match(resendMessage(410, { error: "payload_gone" }).message, /can't be sent again/);
  assert.match(resendMessage(409, { error: "subscription_inactive" }).message, /turned off/);
  assert.deepEqual(resendMessage(200, { result: { ok: true, status_code: 200 } }), { ok: true, message: "Resent · 200" });
  assert.equal(resendMessage(200, { result: { ok: false, status_code: 500 } }).ok, false);
  assert.equal(resendMessage(500, null).ok, false);
});

test("resend: a rate-limited resend says to wait", () => {
  const out = resendMessage(429, { error: "rate_limited" });
  assert.equal(out.ok, false);
  assert.match(out.message, /in a minute/);
});

test("send test: the status line on the toast, never a body; refusals in plain words", () => {
  assert.deepEqual(testSendMessage(200, { result: { ok: true, status_code: 204, error: null, duration_ms: 184 } }), { ok: true, message: "Test delivered · 204 · 184 ms" });
  assert.deepEqual(testSendMessage(200, { result: { ok: false, status_code: 503, error: "503 Service Unavailable", duration_ms: 40 } }), { ok: false, message: "Test sent, the endpoint answered 503 Service Unavailable" });
  assert.equal(testSendMessage(200, { result: { ok: false, status_code: 500, error: "http_500" } }).message, "Test sent, the endpoint answered 500");
  assert.equal(testSendMessage(200, { result: { ok: false, status_code: null, error: "timeout" } }).message, "Test sent, the endpoint timed out");
  assert.equal(testSendMessage(200, { result: { ok: false, status_code: 302, error: "redirect not followed" } }).message, "Test sent, the endpoint redirected (302). Redirects aren't followed.");
  assert.equal(testSendMessage(200, { result: { ok: false, status_code: null, error: "ECONNREFUSED" } }).message, "Test sent, the request failed");
  assert.equal(testSendMessage(409, { error: "subscription_inactive" }).ok, false);
  assert.match(testSendMessage(429, { error: "rate_limited" }).message, /Try again in a minute/);
  assert.equal(testSendMessage(404, null).message, "That endpoint no longer exists.");
  assert.equal(testSendMessage(500, null).message, "Couldn't send a test. Try again.");
});
