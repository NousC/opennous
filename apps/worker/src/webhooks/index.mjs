// Inbound webhook router — registers routes for all signal sources.
// Each route validates the workspace_id, checks HMAC auth where supported,
// then delegates to the source-specific handler.

import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { handleFireflies } from './handlers/fireflies.mjs';
import { handleFathom } from './handlers/fathom.mjs';
import { handleGranola } from './handlers/granola.mjs';
import { handleFellow } from './handlers/fellow.mjs';
import { handleRB2B } from './handlers/rb2b.mjs';
import { handleInstantly } from './handlers/instantly.mjs';
import { handleEmailBison } from './handlers/emailbison.mjs';
import { handleHeyReach } from './handlers/heyreach.mjs';
import { handleSmartlead } from './handlers/smartlead.mjs';
import { handleLemlist } from './handlers/lemlist.mjs';
import { handleCalendly } from './handlers/calendly.mjs';
import { handleCalCom } from './handlers/calcom.mjs';
import { handleStripe } from './handlers/stripe.mjs';
import { handleAiArk } from './handlers/aiark.mjs';
import { handleComposio } from './handlers/composio.mjs';
import { handlePostHog } from './handlers/posthog.mjs';
import { enqueueForRetry } from '../utils/webhookInbox.mjs';

// Ops metering note: each webhook handler writes its own workspace_system_log
// row (the live op log), and workspace_system_log.billable_ops defaults to 1 —
// so every inbound webhook is metered as 1 op without any extra call here.

export const webhookRouter = Router();

export function verifyHmac(req, secret) {
  if (!secret) return false;
  const sig = req.headers['x-nous-signature'] || req.headers['x-hub-signature-256'];
  if (!sig) {
    // A secret is configured but the request carried no signature header. We still
    // reject (fail-closed is correct — otherwise an attacker bypasses HMAC by just
    // omitting the header), but log it so a misconfiguration is diagnosable instead
    // of a silent 401. If the provider genuinely doesn't sign, unset its *_WEBHOOK_SECRET.
    console.warn('[webhook] signing secret set but request has no x-hub-signature-256/x-nous-signature header — rejecting. Unset the *_WEBHOOK_SECRET if this provider does not sign.');
    return false;
  }
  // The HMAC MUST be computed over the exact raw bytes the sender signed. Re-serializing
  // the parsed body (JSON.stringify(req.body)) changes key order / whitespace / unicode
  // escaping, so a valid signature would never match. req.rawBody is captured by the
  // express.json({ verify }) hook in index.mjs.
  const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// All inbound routes accept /:workspaceId so the worker can handle any workspace
// without needing API key auth (HMAC on sensitive sources instead).

// Cloud's inbound sources (LinkedIn via Unipile, GET-754) mount here: ahead of every public
// source below and of the catch-all at the end, which would otherwise answer them first.
// index.mjs hands this router to the cloud layer's register() as its webhookRouter.
export const cloudWebhookRouter = Router();
webhookRouter.use(cloudWebhookRouter);

webhookRouter.post('/fireflies/:workspaceId', (req, res) => {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (secret && !verifyHmac(req, secret)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  handleFireflies(req, res, req.params.workspaceId).catch(err => {
    console.error('[WEBHOOK/fireflies]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

webhookRouter.post(['/fathom/:workspaceId', '/fathom'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  // Fathom uses its own svix-based signature — handled inside the handler
  handleFathom(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/fathom]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

// Granola uses the Standard Webhooks signature (webhook-id / webhook-timestamp /
// webhook-signature) with a per-connection signing secret — verified inside the
// handler, which has the DB access to look up the right secret for this workspace.
webhookRouter.post(['/granola/:workspaceId', '/granola'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  handleGranola(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/granola]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

// Fellow answers its own url_verification challenge and verifies the svix signature
// against the per-connection secret inside the handler. The handler ACKs before it
// processes (Fellow's 15s budget), hence the headersSent guard.
webhookRouter.post(['/fellow/:workspaceId', '/fellow'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  handleFellow(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/fellow]', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

webhookRouter.post('/rb2b/:workspaceId', (req, res) => {
  const secret = process.env.RB2B_WEBHOOK_SECRET;
  if (secret && !verifyHmac(req, secret)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  handleRB2B(req, res, req.params.workspaceId).catch(err => {
    console.error('[WEBHOOK/rb2b]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

webhookRouter.post(['/instantly/:workspaceId', '/instantly'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (secret && !verifyHmac(req, secret)) return res.status(401).json({ error: 'invalid_signature' });
  handleInstantly(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/instantly]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

// Shared-secret query-param check used by providers that don't sign payloads.
function checkQuerySecret(req, envSecret) {
  if (!envSecret) return true;
  const querySecret = (req.query.secret || '').toString();
  try {
    return querySecret.length === envSecret.length &&
      crypto.timingSafeEqual(Buffer.from(querySecret), Buffer.from(envSecret));
  } catch { return false; }
}

// EmailBison — webhooks registered manually in Settings → Webhooks (no API for
// registration as of 2026-05). Auth is shared-secret via optional query param,
// since EmailBison doesn't sign payloads. If EMAILBISON_WEBHOOK_SECRET is set,
// users paste `/inbound/emailbison/<workspaceId>?secret=...` into EmailBison.
webhookRouter.post(['/emailbison/:workspaceId', '/emailbison'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!checkQuerySecret(req, process.env.EMAILBISON_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  handleEmailBison(req, res, workspaceId).catch(async err => {
    console.error('[WEBHOOK/emailbison] handler threw, queuing for retry:', err.message);
    await enqueueForRetry(getSupabaseClient(), { workspaceId, source: 'emailbison', req, err });
    if (!res.headersSent) res.status(200).json({ ok: true, queued: true });
  });
});

// HeyReach — webhooks auto-registered on connect via their API. No signing,
// so we rely on the workspace-scoped URL plus an optional shared secret.
webhookRouter.post(['/heyreach/:workspaceId', '/heyreach'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!checkQuerySecret(req, process.env.HEYREACH_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  handleHeyReach(req, res, workspaceId).catch(async err => {
    console.error('[WEBHOOK/heyreach] handler threw, queuing for retry:', err.message);
    await enqueueForRetry(getSupabaseClient(), { workspaceId, source: 'heyreach', req, err });
    if (!res.headersSent) res.status(200).json({ ok: true, queued: true });
  });
});

// Smartlead — webhooks registered manually per-campaign in Smartlead's UI.
// Optional shared secret via SMARTLEAD_WEBHOOK_SECRET.
webhookRouter.post(['/smartlead/:workspaceId', '/smartlead'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!checkQuerySecret(req, process.env.SMARTLEAD_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  handleSmartlead(req, res, workspaceId).catch(async err => {
    console.error('[WEBHOOK/smartlead] handler threw, queuing for retry:', err.message);
    await enqueueForRetry(getSupabaseClient(), { workspaceId, source: 'smartlead', req, err });
    if (!res.headersSent) res.status(200).json({ ok: true, queued: true });
  });
});

// Lemlist — webhook auto-registered on connect with a per-workspace secret.
// Secret verification lives inside the handler because it needs DB access to
// look up the right stored secret for this workspace. The legacy
// LEMLIST_WEBHOOK_SECRET env var is honoured as a fallback for self-hosters
// who set up webhooks manually instead of via auto-register.
webhookRouter.post(['/lemlist/:workspaceId', '/lemlist'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  handleLemlist(req, res, workspaceId).catch(async err => {
    console.error('[WEBHOOK/lemlist] handler threw, queuing for retry:', err.message);
    await enqueueForRetry(getSupabaseClient(), { workspaceId, source: 'lemlist', req, err });
    if (!res.headersSent) res.status(200).json({ ok: true, queued: true });
  });
});

// Calendly uses its own signing format (Calendly-Webhook-Signature: t=<ts>,v1=<hmac>)
// with a per-workspace signing key stored on the connection. Verification lives
// in the handler so it has DB access to look up the right key.
webhookRouter.post(['/calendly/:workspaceId', '/calendly'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  handleCalendly(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/calendly]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

// Cal.com — signature verification in handler (x-cal-signature-256, per-workspace secret)
webhookRouter.post(['/cal_com/:workspaceId', '/cal_com'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  handleCalCom(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/cal_com]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

webhookRouter.post(['/stripe/:workspaceId', '/stripe'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  const secret = process.env.STRIPE_INBOUND_WEBHOOK_SECRET;
  if (secret && !verifyHmac(req, secret)) return res.status(401).json({ error: 'invalid_signature' });
  handleStripe(req, res, workspaceId).catch(err => {
    console.error('[WEBHOOK/stripe]', err);
    res.status(500).json({ error: 'internal_error' });
  });
});

// AI-Ark — the lookalike-builder skill points the email-finder webhook here with
// the target lead list in the path: /inbound/aiark/:workspaceId/:leadListId.
// AI-Ark doesn't sign payloads, so auth is an optional shared secret query param.
webhookRouter.post(['/aiark/:workspaceId/:leadListId', '/aiark/:workspaceId', '/aiark'], (req, res) => {
  const workspaceId = req.params.workspaceId || req.query.workspace_id;
  const leadListId = req.params.leadListId || req.query.lead_list_id || null;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
  if (!checkQuerySecret(req, process.env.AIARK_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'invalid_secret' });
  }
  handleAiArk(req, res, workspaceId, leadListId).catch(async err => {
    console.error('[WEBHOOK/aiark] handler threw, queuing for retry:', err.message);
    await enqueueForRetry(getSupabaseClient(), { workspaceId, source: 'aiark', req, err });
    if (!res.headersSent) res.status(200).json({ ok: true, queued: true });
  });
});

// Composio — ONE project-level webhook for Gmail + Calendar triggers (no workspaceId in the
// path). svix signature verification + workspace resolution happen inside the handler, off
// the connected-account id in the payload. Registered before the catch-all so /composio
// (a single path segment) is matched here, not swallowed by /:source/:workspaceId.
webhookRouter.post('/composio', (req, res) => {
  handleComposio(req, res).catch(err => {
    console.error('[WEBHOOK/composio]', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

// PostHog (GET-751) — the destination is created on connect with a per-workspace secret, sent
// as X-Nous-Secret. Verification lives in the handler: it needs the stored secret.
// A throw here came before the secret was checked, so nothing is queued: PostHog retries a 5xx.
webhookRouter.post('/posthog/:workspaceId', (req, res) => {
  handlePostHog(req, res, req.params.workspaceId).catch(err => {
    console.error('[WEBHOOK/posthog]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });
});

// Catch-all for unrecognized sources — log and 200 to prevent retries
webhookRouter.post('/:source/:workspaceId', (req, res) => {
  console.log(`[WEBHOOK] Unhandled source: ${req.params.source}`);
  res.json({ ok: true, skipped: true });
});
