import { Router } from 'express';
import {
  getSupabaseClient,
  createTrigger,
  listTriggers,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  TRIGGER_EVENTS,
} from '@nous/core';
import { mountWebhookDeliveryRoutes } from '../../lib/webhookDeliveryRoutes.mjs';
import { mountWebhookTestRoute } from '../../lib/webhookTestSend.mjs';
import { destinationFromBody, webhookOut, managedRefusal, githubReposFor } from '../../lib/webhookDestination.mjs';

// A validation code from core or the destination parser, which the caller can fix.
const CLIENT_ERRORS = /^(events_required|unknown_event:|invalid_url|name_required|invalid_event|destination_required|invalid_destination|url_required|github_repo_required|github_token_required|invalid_github_repo|connected_repo_needs_a_person|no_connected_repo|company_repo_needs_admin)/;
const isClientError = (err) => CLIENT_ERRORS.test(err?.message ?? '');

// Triggers — outbound webhooks. Callable from both the dashboard (JWT) and
// programmatically (API key) so n8n / scripts can set up subscriptions
// without clicking through the UI. Auth is verifyAuthEither (mounted in
// index.mjs); req.workspaceId is set by whichever path verified.

export const triggersRouter = Router();

// Rotating the signing secret is the one way to see a secret after create, so it is for workspace
// owners/admins (or an admin-scoped API key) only. viewerScope is set by both auth paths.
export const canRotateSecret = (req) => req.viewerScope === 'admin';

// All triggers routes require a workspace context. The dashboard passes
// ?workspace_id=…; verifyAuthEither/verifySupabaseAuth set req.workspaceId
// when membership is confirmed. Fail fast with a clear error so silent
// empty-list bugs in the UI don't happen.
triggersRouter.use((req, res, next) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  next();
});

// GET /api/triggers — list subscriptions for the workspace. No signing secrets: those come back
// only from POST (create) and PATCH { rotate_secret: true }.
// Response: { triggers: [...], available_events: [...] }
triggersRouter.get('/', async (req, res) => {
  try {
    const triggers = await listTriggers(getSupabaseClient(), req.workspaceId);
    return res.json({ triggers: triggers.map(webhookOut), available_events: TRIGGER_EVENTS });
  } catch (err) {
    console.error('[GET /api/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/triggers — create a subscription.
// Body: { name, url, events: ['interaction.email_received', ...] }
//    or { name, destination: { type: 'github', repo: 'owner/name', token }, events } (GET-670)
// A URL webhook's response includes signing_secret ONCE (the only time it's returned).
triggersRouter.post('/', async (req, res) => {
  try {
    const { name, events } = req.body ?? {};
    const destination = await destinationFromBody(req.body, req);
    const result = await createTrigger(getSupabaseClient(), req.workspaceId, { name, destination, events });
    if (['github', 'claude'].includes(result.subscription.destination_type)) {
      return res.status(201).json({ trigger: webhookOut(result.subscription) });
    }
    return res.status(201).json({
      trigger: webhookOut(result.subscription),
      signing_secret: result.secret,
      message: 'Save this signing_secret — it is shown only once. Use it to verify the X-Nous-Signature header on incoming POSTs.',
    });
  } catch (err) {
    if (isClientError(err)) {
      return res.status(400).json({ error: err.message, available_events: TRIGGER_EVENTS });
    }
    console.error('[POST /api/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Delivery log (GET-624): GET /:id/deliveries?limit=&before=, GET /:id/stats,
// POST /deliveries/:deliveryId/resend. Any workspace member, like the rest of this router.
mountWebhookDeliveryRoutes(triggersRouter, { logPath: '/:id/deliveries', label: '/api/triggers' });

// POST /:id/test — send one webhook.test event now through the shared signed send, record it in
// the delivery log and answer with the attempt ({ delivery, result }). 50 per webhook per minute.
mountWebhookTestRoute(triggersRouter, { label: '/api/triggers' });

// GET /api/triggers/github-repos — the repos connected in Settings, for the Add endpoint dropdown
// (GET-674). Never their tokens. Mounted before /:id so the path is not read as an id.
triggersRouter.get('/github-repos', async (req, res) => {
  try { return res.json({ repos: await githubReposFor(req) }); }
  catch (err) { console.error('[GET /api/triggers/github-repos]', err); return res.status(500).json({ error: 'internal_error' }); }
});

// GET /api/triggers/:id — fetch one.
triggersRouter.get('/:id', async (req, res) => {
  try {
    const trigger = await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!trigger) return res.status(404).json({ error: 'not_found' });
    return res.json({ trigger: webhookOut(trigger) });
  } catch (err) {
    console.error('[GET /api/triggers/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/triggers/:id — update name, url, events, active, or rotate secret.
// Body: { name?, url?, events?, active?, rotate_secret? }
triggersRouter.patch('/:id', async (req, res) => {
  try {
    if (req.body?.rotate_secret && !canRotateSecret(req)) {
      return res.status(403).json({ error: 'admin_required', detail: 'Only workspace owners or admins can rotate a signing secret.' });
    }
    const refusal = managedRefusal(await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id));
    if (refusal) return res.status(409).json(refusal);
    const { destination: _d, url: _u, ...rest } = req.body ?? {};
    const destination = await destinationFromBody(req.body ?? {}, req);
    const result = await updateTrigger(getSupabaseClient(), req.workspaceId, req.params.id, destination ? { ...rest, destination } : rest);
    if (!result) return res.status(404).json({ error: 'not_found' });
    const out = { trigger: webhookOut(result.subscription) };
    if (result.secret) {
      out.signing_secret = result.secret;
      out.message = 'New signing_secret returned — the previous one has been revoked. Update your verifier.';
    }
    return res.json(out);
  } catch (err) {
    if (isClientError(err)) {
      return res.status(400).json({ error: err.message, available_events: TRIGGER_EVENTS });
    }
    console.error('[PATCH /api/triggers/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/triggers/:id — remove. Outstanding outbound_events for the
// subscription are cascaded out by the FK ON DELETE.
triggersRouter.delete('/:id', async (req, res) => {
  try {
    const refusal = managedRefusal(await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id));
    if (refusal) return res.status(409).json(refusal);
    const ok = await deleteTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    return res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/triggers/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
