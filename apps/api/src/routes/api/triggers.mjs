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

// Triggers — outbound webhooks. Callable from both the dashboard (JWT) and
// programmatically (API key) so n8n / scripts can set up subscriptions
// without clicking through the UI. Auth is verifyAuthEither (mounted in
// index.mjs); req.workspaceId is set by whichever path verified.

export const triggersRouter = Router();

// All triggers routes require a workspace context. The dashboard passes
// ?workspace_id=…; verifyAuthEither/verifySupabaseAuth set req.workspaceId
// when membership is confirmed. Fail fast with a clear error so silent
// empty-list bugs in the UI don't happen.
triggersRouter.use((req, res, next) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  next();
});

// GET /api/triggers — list subscriptions for the workspace.
// Response: { triggers: [...], available_events: [...] }
triggersRouter.get('/', async (req, res) => {
  try {
    const triggers = await listTriggers(getSupabaseClient(), req.workspaceId);
    return res.json({ triggers, available_events: TRIGGER_EVENTS });
  } catch (err) {
    console.error('[GET /api/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/triggers — create a subscription.
// Body: { name, url, events: ['interaction.email_received', ...] }
// Response includes signing_secret ONCE (the only time it's returned).
triggersRouter.post('/', async (req, res) => {
  try {
    const { name, url, events } = req.body ?? {};
    const result = await createTrigger(getSupabaseClient(), req.workspaceId, { name, url, events });
    return res.status(201).json({
      trigger: result.subscription,
      signing_secret: result.secret,
      message: 'Save this signing_secret — it is shown only once. Use it to verify the X-Nous-Signature header on incoming POSTs.',
    });
  } catch (err) {
    if (err?.message?.startsWith('events_required') || err?.message?.startsWith('unknown_event:') ||
        err?.message?.startsWith('invalid_url') || err?.message === 'name_required' ||
        err?.message === 'invalid_event') {
      return res.status(400).json({ error: err.message, available_events: TRIGGER_EVENTS });
    }
    console.error('[POST /api/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/triggers/:id — fetch one.
triggersRouter.get('/:id', async (req, res) => {
  try {
    const trigger = await getTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!trigger) return res.status(404).json({ error: 'not_found' });
    return res.json({ trigger });
  } catch (err) {
    console.error('[GET /api/triggers/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/triggers/:id — update name, url, events, active, or rotate secret.
// Body: { name?, url?, events?, active?, rotate_secret? }
triggersRouter.patch('/:id', async (req, res) => {
  try {
    const result = await updateTrigger(getSupabaseClient(), req.workspaceId, req.params.id, req.body ?? {});
    if (!result) return res.status(404).json({ error: 'not_found' });
    const out = { trigger: result.subscription };
    if (result.secret) {
      out.signing_secret = result.secret;
      out.message = 'New signing_secret returned — the previous one has been revoked. Update your verifier.';
    }
    return res.json(out);
  } catch (err) {
    if (err?.message?.startsWith('events_required') || err?.message?.startsWith('unknown_event:') ||
        err?.message?.startsWith('invalid_url') || err?.message === 'name_required' ||
        err?.message === 'invalid_event') {
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
    const ok = await deleteTrigger(getSupabaseClient(), req.workspaceId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    return res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/triggers/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
