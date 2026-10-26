// /v2/webhooks — subscribe to events and get them pushed to your own stack (GET-559).
//
// The same subscriptions and outbox as /v2/workspace/triggers, with the shape a developer
// expects: full CRUD, an event catalog, a test send against one of your real accounts, and the
// delivery log. Record events (conversation.*, deal.*) carry the account, its people, the deal
// and the evidence; see services/events.mjs for the envelope.
//
// The signing secret is shown ONCE — on create and on rotate — and never in a list or a read.
// Every POST we send carries X-Nous-Signature: sha256=<HMAC of the raw body with that secret>.
import { Router } from 'express';
import { destinationFromBody, webhookOut, managedRefusal, githubReposFor } from '../../lib/webhookDestination.mjs';
import {
  getSupabaseClient, createTrigger, listTriggers, getTrigger, updateTrigger, deleteTrigger,
  listDeliveries, TRIGGER_EVENTS, EVENT_CATALOG, EVENT_API_VERSION,
} from '@nous/core';
import { mountWebhookDeliveryRoutes } from '../../lib/webhookDeliveryRoutes.mjs';
import { buildTestPayload, testSendLimiter } from '../../lib/webhookTestSend.mjs';

export const webhooksV2Router = Router();

// Who may change or remove a webhook: an admin (owner/admin/legacy) key. Any key may list,
// create and test — a webhook only ever carries what every member may read.
const isAdmin = (req) => req.viewerScope === 'admin' || req.viewerScope == null;

const shape = webhookOut;

const SIGNATURE = {
  header: 'X-Nous-Signature',
  scheme: 'sha256=<hex HMAC-SHA256 of the raw request body, keyed with your webhook secret>',
  also: ['X-Nous-Event-Id', 'X-Nous-Event-Type'],
};

// A GitHub destination (GET-670): what the repo's workflow receives instead of a signed POST.
const GITHUB_DELIVERY = {
  sends: 'repository_dispatch to the repo, authenticated by your token (needs Contents: read and write)',
  event_type: 'nous.<event>, e.g. nous.conversation.call_ended',
  client_payload: ['event_id', 'event_type', 'occurred_at', 'workspace_id', 'entity_id', 'account_id', 'meeting_id', 'source'],
  note: 'A small flat payload: read the full record from the API by entity_id.',
};

function badRequest(res, err) {
  return res.status(400).json({ error: err.message, available_events: TRIGGER_EVENTS });
}

/** The catalog: every event you can subscribe to, and what the record events carry. */
webhooksV2Router.get('/events', (_req, res) => {
  res.json({ api_version: EVENT_API_VERSION, events: EVENT_CATALOG, signature: SIGNATURE, github: GITHUB_DELIVERY });
});

/** The GitHub repos already connected in Settings that a webhook can use (GET-674). No tokens. */
webhooksV2Router.get('/github-repos', async (req, res) => {
  try { res.json({ repos: await githubReposFor(req) }); }
  catch (err) { console.error('[GET /v2/webhooks/github-repos]', err); res.status(500).json({ error: 'internal_error' }); }
});

webhooksV2Router.get('/', async (req, res) => {
  try {
    const subs = await listTriggers(getSupabaseClient(), req.workspaceId);
    res.json({ webhooks: subs.map(shape) });
  } catch (err) {
    console.error('[GET /v2/webhooks]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Body: { name?, events, url } or { name?, events, destination: { type: 'url', url } |
// { type: 'github', repo: 'owner/name', token } | { type: 'claude', url: <Fire URL>, token } }. A GitHub
// destination sends each event as a repository_dispatch (event_type nous.<event>) to that repo, so its
// Actions run on it (GET-670); a Claude one fires that scheduled task with the event (GET-1035).
webhooksV2Router.post('/', async (req, res) => {
  const { name, events } = req.body || {};
  let destination;
  try { destination = await destinationFromBody(req.body, req); } catch (err) { return badRequest(res, err); }
  if (!destination || !Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: 'destination_and_events_required', available_events: TRIGGER_EVENTS });
  }
  try {
    const fallbackName = destination.type === 'github' ? destination.repo : new URL(destination.url).hostname;
    const { subscription, secret } = await createTrigger(getSupabaseClient(), req.workspaceId, {
      name: name || fallbackName, destination, events,
    });
    // The signing secret only means something to a URL receiver; GitHub and a Claude task authenticate by token.
    res.status(201).json({ webhook: shape(subscription), ...(['github', 'claude'].includes(subscription.destination_type) ? {} : { secret }) });
  } catch (err) {
    if (err?.message && !/failed to create/.test(err.message)) return badRequest(res, err);
    console.error('[POST /v2/webhooks]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

webhooksV2Router.get('/:id', async (req, res) => {
  try {
    const sub = await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'not_found' });
    res.json({ webhook: shape(sub) });
  } catch (err) {
    console.error('[GET /v2/webhooks/:id]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const PATCH_FIELDS = ['name', 'url', 'destination', 'events', 'active', 'rotate_secret'];

webhooksV2Router.patch('/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin_key_required' });
  const body = req.body || {};
  const unknown = Object.keys(body).filter(k => !PATCH_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: 'unknown_fields', fields: unknown, supported: PATCH_FIELDS });
  let patch;
  try {
    const { destination: _d, url: _u, ...rest } = body;
    const destination = await destinationFromBody(body, req);
    patch = destination ? { ...rest, destination } : rest;
  } catch (err) { return badRequest(res, err); }
  try {
    const current = await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    const refusal = managedRefusal(current);
    if (refusal) return res.status(409).json(refusal);
    const out = await updateTrigger(getSupabaseClient(), req.workspaceId, req.params.id, patch);
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json({ webhook: shape(out.subscription), ...(out.secret ? { secret: out.secret } : {}) });
  } catch (err) {
    if (err?.message && !/failed to update/.test(err.message)) return badRequest(res, err);
    console.error('[PATCH /v2/webhooks/:id]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

webhooksV2Router.delete('/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin_key_required' });
  try {
    const refusal = managedRefusal(await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id));
    if (refusal) return res.status(409).json(refusal);
    const gone = await deleteTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!gone) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /v2/webhooks/:id]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Send one `webhook.test` event now, built against a real account — the one you name, else the
 * workspace's most recently active — so you see the exact shape your handler will receive. It
 * goes through the same signed, retried delivery as a real event and shows in the delivery log.
 * Shares the dashboard's rate limit: 10 test sends per webhook per minute.
 */
webhooksV2Router.post('/:id/test', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const sub = await getTrigger(supabase, req.workspaceId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'not_found' });
    if (!testSendLimiter.allow(sub.id)) return res.status(429).json({ error: 'rate_limited', retry_after_s: 60 });

    const { payload, accountId, accountName } = await buildTestPayload(supabase, req.workspaceId, req.body?.account_id);
    const { error } = await supabase.from('outbound_events').insert({
      workspace_id: req.workspaceId, subscription_id: sub.id, entity_id: accountId,
      event_type: 'webhook.test', payload, occurred_at: payload.occurred_at,
    });
    if (error) throw new Error(error.message);
    res.status(202).json({ queued: true, event_id: payload.id, account: accountName, note: 'Delivered within 30 seconds; see GET /v2/webhooks/:id/deliveries.' });
  } catch (err) {
    console.error('[POST /v2/webhooks/:id/test]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

webhooksV2Router.get('/:id/deliveries', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const sub = await getTrigger(supabase, req.workspaceId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'not_found' });
    const deliveries = await listDeliveries(supabase, req.workspaceId, sub.id, Number(req.query.limit) || 50);
    res.json({ deliveries });
  } catch (err) {
    console.error('[GET /v2/webhooks/:id/deliveries]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Per-attempt delivery log, stats and Resend (GET-624). /:id/deliveries above stays as it is (one
// row per EVENT with its current outbox state — a published contract); /:id/attempts is one row
// per HTTP attempt, retries and resends included. Any key may read and resend, like test: a
// resend only re-sends what this webhook was already sent.
mountWebhookDeliveryRoutes(webhooksV2Router, { logPath: '/:id/attempts', label: '/v2/webhooks' });
