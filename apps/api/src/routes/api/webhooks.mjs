import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { WEBHOOK_EVENT_TYPES } from '../../lib/webhookStatus.mjs';
import { publicApiBase } from '../../lib/publicApiBase.mjs';

export const webhooksRouter = Router();

// Single source of truth for the inbound URL of every webhook-capable provider.
// Both the URL list and the manual-subscribe validation read from this map, so a new
// provider is added in exactly one place.
const WEBHOOK_PATHS = {
  linkedin:   (b, w) => `${b}/inbound/linkedin?workspace_id=${w}`,
  rb2b:       (b, w) => `${b}/inbound/rb2b/${w}`,
  instantly:  (b, w) => `${b}/inbound/instantly/${w}`,
  emailbison: (b, w) => `${b}/inbound/emailbison/${w}`,
  heyreach:   (b, w) => `${b}/inbound/heyreach/${w}`,
  smartlead:  (b, w) => `${b}/inbound/smartlead/${w}`,
  lemlist:    (b, w) => `${b}/inbound/lemlist/${w}`,
  fireflies:  (b, w) => `${b}/inbound/fireflies/${w}`,
  fathom:     (b, w) => `${b}/inbound/fathom/${w}`,
  calendly:   (b, w) => `${b}/inbound/calendly/${w}`,
  cal_com:    (b, w) => `${b}/inbound/cal_com/${w}`,
  granola:    (b, w) => `${b}/inbound/granola/${w}`,
  posthog:    (b, w) => `${b}/inbound/posthog/${w}`,
};
const WEBHOOK_SOURCES = Object.keys(WEBHOOK_PATHS);
// PostHog's destination carries the connection's secret, which only connecting creates (GET-751):
// it is shown here once connected and can never be added by hand.
const CONNECT_ONLY = new Set(['posthog']);
const VALID_SOURCES = WEBHOOK_SOURCES.filter(s => !CONNECT_ONLY.has(s));

// GET /api/webhooks/subscriptions
webhooksRouter.get('/subscriptions', async (req, res) => {
  try {
    const workspaceId = req.workspaceId || req.query.workspaceId;
    if (!workspaceId) return res.json({ subscriptions: [] });

    const { data, error } = await getSupabaseClient()
      .from('workspace_webhook_subscriptions')
      .select('source, status, created_at, tested_at')
      .eq('workspace_id', workspaceId);

    if (error) {
      // Fall back to old table name if new one doesn't exist
      const { data: fallback } = await getSupabaseClient()
        .from('webhook_subscriptions')
        .select('source, is_active, created_at')
        .eq('workspace_id', workspaceId);
      return res.json({ subscriptions: fallback || [] });
    }
    return res.json({ subscriptions: data || [] });
  } catch (err) {
    console.error('[GET /api/webhooks/subscriptions]', err);
    return res.json({ subscriptions: [] });
  }
});

// POST /api/webhooks/subscriptions
webhooksRouter.post('/subscriptions', async (req, res) => {
  try {
    const { source } = req.body;
    const workspaceId = req.workspaceId || req.body.workspaceId || req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });
    if (!source || !VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: 'invalid_source', valid: VALID_SOURCES });
    }

    const { data, error } = await getSupabaseClient()
      .from('workspace_webhook_subscriptions')
      .upsert({ workspace_id: workspaceId, source, status: 'pending' }, { onConflict: 'workspace_id,source' })
      .select('id, source, status, created_at')
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    console.error('[POST /api/webhooks/subscriptions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/webhooks/subscriptions/:source
webhooksRouter.delete('/subscriptions/:source', async (req, res) => {
  try {
    const workspaceId = req.workspaceId || req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });
    // Hard-remove the manual subscription so it drops off the Webhooks page. (A source
    // that's still connected as an integration stays active via the connection, not this.)
    await getSupabaseClient()
      .from('workspace_webhook_subscriptions')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('source', req.params.source);

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/webhooks/subscriptions/:source]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/webhooks/urls — inbound webhook URLs for each source, enriched
// with proof-of-life telemetry so the UI can give the user real confidence
// that a webhook is wired up. For each source we return:
//   - url:             where to paste / where events come in
//   - auto_registered: true only when we've stored proof that the provider's
//                      webhook-create API actually accepted our subscription
//                      (i.e. evidence-based, not aspirational)
//   - last_event_at:   ISO timestamp of the most recent inbound webhook
//   - status:          'live' (≤7d) | 'stale' (>7d) | 'pending' (never)
webhooksRouter.get('/urls', async (req, res) => {
  const workspaceId = req.workspaceId || req.query.workspaceId || req.query.workspace_id;
  // The URL a tool must call: the public address, never the internal Docker host (GET-666).
  const b = publicApiBase();

  const baseUrls = WEBHOOK_SOURCES.map(source => ({ source, url: WEBHOOK_PATHS[source](b, workspaceId) }));

  // No workspace → no telemetry to enrich with. Return the raw URLs (all inactive) so a
  // caller that only needs the source→URL map (the Integrations page) still works.
  if (!workspaceId) return res.json({ urls: baseUrls.map(u => ({ ...u, active: false })) });

  const supabase = getSupabaseClient();

  // ── Last received event per source ──────────────────────────────────────
  // Pull the most-recent webhook log rows ordered by occurred_at DESC and
  // keep the first hit for each source. The (workspace_id, occurred_at DESC)
  // index on workspace_system_log makes this O(scan-prefix).
  const lastBySource = {};
  try {
    const { data: logs } = await supabase
      .from('workspace_system_log')
      .select('source, occurred_at')
      .eq('workspace_id', workspaceId)
      .in('event_type', WEBHOOK_EVENT_TYPES)
      .order('occurred_at', { ascending: false })
      .limit(500);
    for (const row of logs || []) {
      if (!lastBySource[row.source]) lastBySource[row.source] = row.occurred_at;
    }
  } catch { /* table may not exist on fresh installs — fall through */ }

  // ── Proven auto-registration ────────────────────────────────────────────
  // A provider counts as "auto-registered" only when we have stored evidence
  // that its webhook-create API succeeded. LinkedIn is the exception: Unipile
  // handles registration on the OAuth callback, so connection presence is the
  // best proof we have without probing Unipile.
  // `connected` = the provider has an integration connection at all. That alone is enough
  // to surface its webhook (connect Fireflies in Integrations → its webhook shows here
  // automatically). `proven` is the stronger claim that we registered the webhook via the
  // provider's API — it drives the "auto-registered" badge, not visibility.
  const proven = new Set();
  const connected = new Set();
  try {
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials, provider:workflow_providers(name)')
      .eq('workspace_id', workspaceId);
    for (const c of conns || []) {
      const name  = c.provider?.name;
      const creds = c.encrypted_credentials || {};
      if (name) connected.add(name);
      if (name === 'calendly' && creds.webhook_subscription_uri) proven.add('calendly');
      if (name === 'cal_com'  && creds.webhook_id)               proven.add('cal_com');
      if (name === 'heyreach' && Array.isArray(creds.webhook_ids) && creds.webhook_ids.length) {
        proven.add('heyreach');
      }
      if (name === 'lemlist'  && creds.webhook_id)                proven.add('lemlist');
      if (name === 'granola'  && creds.webhook_id)                proven.add('granola');
      if (name === 'posthog'  && creds.hog_function_id)           proven.add('posthog');
    }
  } catch { /* fall through */ }

  // ── Manually-added webhooks ─────────────────────────────────────────────
  // A source the user added by hand from the Webhooks page (e.g. RB2B, which has no
  // integration to connect). Stored as an active row in webhook_subscriptions.
  const subscribed = new Set();
  try {
    const { data: subs } = await supabase
      .from('workspace_webhook_subscriptions')
      .select('source, status')
      .eq('workspace_id', workspaceId);
    for (const s of subs || []) if (s.status !== 'removed') subscribed.add(s.source);
  } catch { /* table may not exist — fall through */ }

  // LinkedIn auto-registration is handled by Unipile during the OAuth flow.
  // Treat a row in workspace_linkedin_connections as proof that the link is
  // live; once Unipile has the account, webhooks fire on /api/linkedin/webhook.
  try {
    const { count } = await supabase
      .from('workspace_linkedin_connections')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId);
    if ((count || 0) > 0) proven.add('linkedin');
  } catch { /* table may not exist — fall through */ }

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const urls = baseUrls.map(entry => {
    const last = lastBySource[entry.source] || null;
    let status = 'pending';
    if (last) {
      const ageMs = Date.now() - new Date(last).getTime();
      status = ageMs <= SEVEN_DAYS_MS ? 'live' : 'stale';
    }
    return {
      ...entry,
      auto_registered: proven.has(entry.source),
      last_event_at:   last,
      status,
      // Surface this webhook on the Webhooks page? Only if it's actually in play:
      // connected as an integration, registered by us, already receiving events, or
      // added by hand. Everything else stays hidden (and available under "Add").
      active: connected.has(entry.source) || proven.has(entry.source) || !!last || subscribed.has(entry.source),
      // Purely user-added (no integration behind it, no events yet) — so it can be
      // removed from the page. Connection/event-backed rows can't be "removed" here.
      manual: subscribed.has(entry.source) && !connected.has(entry.source) && !proven.has(entry.source) && !last,
      addable: !CONNECT_ONLY.has(entry.source),
    };
  });

  return res.json({ urls });
});

// GET /api/webhooks/events — the live log of inbound webhook deliveries.
//
// One row per delivery, newest first, straight from workspace_system_log — the same
// table the URL list reads for last-seen, but here we hand back the whole recent stream
// so the Webhooks page can show what actually arrived, and what failed and why.
//
//   webhook_received       a delivery we processed
//   webhook_unknown_event  arrived, but the provider sent an event type we don't map
//   webhook_failed         the handler threw; the payload is queued for retry. `summary`
//                          carries the reason.
//
// `kind` is derived so the frontend colours a row without re-deciding what each event_type
// means: ok | warn | error.
webhooksRouter.get('/events', async (req, res) => {
  try {
    const workspaceId = req.workspaceId || req.query.workspaceId || req.query.workspace_id;
    if (!workspaceId) return res.json({ events: [] });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('workspace_system_log')
      .select('id, source, event_type, summary, metadata, occurred_at')
      .eq('workspace_id', workspaceId)
      .in('event_type', ['webhook_received', 'webhook_unknown_event', 'webhook_failed'])
      .order('occurred_at', { ascending: false })
      .limit(limit);

    if (error) {
      // Table may not exist on a fresh install — an empty feed, not a 500.
      if (error.code === '42P01' || error.code === 'PGRST205') return res.json({ events: [] });
      throw error;
    }

    const kindOf = (t) =>
      t === 'webhook_failed' ? 'error'
      : t === 'webhook_unknown_event' ? 'warn'
      : 'ok';

    const events = (data || []).map(r => ({
      id:          r.id,
      source:      r.source,
      event_type:  r.event_type,
      kind:        kindOf(r.event_type),
      summary:     r.summary || null,
      detail:      r.metadata?.event || r.metadata?.error || r.metadata?.reason || null,
      occurred_at: r.occurred_at,
    }));

    return res.json({ events });
  } catch (err) {
    console.error('[GET /api/webhooks/events]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
