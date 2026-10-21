// Our own product analytics, sent from the server (GET-820). The tracking plan is
// docs/product-events.md; nothing outside it is sent.
//
// The browser SDK only captures after a visitor accepts cookies, so most signups never reached
// PostHog with an email, and PostHog-as-a-source (GET-751) had almost nobody to bring into our
// own workspace. These events are sent from the API at the moment the thing happens, with the
// same distinct id the browser identifies with (users.id), so the two halves join into one person.
// No cookies are set and nothing is read from the visitor's browser.
//
// Same rules as the dogfood helper (lib/dogfood.mjs): never from a self-hosted or open-source
// instance, best-effort, never blocks or throws into the caller. Never customer content: event
// names, ids, plan and provider names, counts. The email and name are set on the person only.

import { HAS_CLOUD } from './cloud.mjs';

// The live project's token. POSTHOG_API_KEY on the prod box is the retired project; not read.
const KEY = process.env.POSTHOG_SERVER_KEY || process.env.VITE_POSTHOG_KEY || null;
const HOST = (process.env.POSTHOG_SERVER_HOST || process.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');

export const PRODUCT_EVENTS = Object.freeze([
  'signed_up', 'invite_accepted', 'workspace_created', 'integration_connected', 'backfill_started',
  'onboarding_completed', 'api_key_created', 'invite_sent', 'plan_purchased', 'app_active',
]);

function configured() {
  if (process.env.SELF_HOSTED === 'true' || !HAS_CLOUD) return false;
  return !!KEY;
}

/** The capture body for one event, or null when it is not one we send. Pure. */
export function productEventBody({ distinctId, event, properties = {}, set = null, workspaceId = null, at = new Date() }, apiKey = KEY) {
  if (!distinctId || !PRODUCT_EVENTS.includes(event)) return null;
  const props = { ...properties, $lib: 'opennous-api' };
  if (workspaceId) props.workspace_id = workspaceId;
  if (set && Object.keys(set).length) props.$set = set;
  return { api_key: apiKey, event, distinct_id: String(distinctId), properties: props, timestamp: at.toISOString() };
}

/** Send one event. Fire-and-forget: callers do not await it and it never throws. */
export function captureProductEvent(input) {
  if (!configured()) return;
  const body = productEventBody(input);
  if (!body) return;
  fetch(`${HOST}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then(r => {
    if (!r.ok) console.warn(`[PRODUCT_EVENTS] ${body.event} -> ${r.status}`);
  }).catch(err => console.warn(`[PRODUCT_EVENTS] ${body.event} failed: ${err.message}`));
}

// ── app_active: daily use that does not depend on cookies (GET-751) ─────────────────────────────
//
// The browser only reports after someone accepts cookies, so most users' day-to-day use never
// reached PostHog and our own usage numbers read 2 users. One `app_active` per signed-in user per
// UTC day, from the auth middleware, is enough for the usage pull to count active days, last seen
// and active users per account. It carries the email on the person, so the pull can name them.
const seenToday = new Map();   // users.id → the UTC day we last sent for them
const MAX_TRACKED = 50_000;

/** Whether this user's app_active for `day` is still to send; marks it sent. Pure apart from the map. */
export function firstActiveToday(userId, day = new Date().toISOString().slice(0, 10), seen = seenToday) {
  if (!userId || seen.get(userId) === day) return false;
  if (seen.size >= MAX_TRACKED) seen.clear();
  seen.set(userId, day);
  return true;
}

/** Called on every authenticated app request; sends at most one app_active per user per day. */
export function noteActive(userId, email, workspaceId = null) {
  if (!configured() || !firstActiveToday(userId)) return;
  captureProductEvent({ distinctId: userId, event: 'app_active', set: email ? { email } : null, workspaceId });
}
