import { Router } from 'express';
import crypto from 'crypto';
import { getSupabaseClient, resolveFocus, upsertIdentifier } from '@nous/core';
import { workerBaseUrl } from '../../providers/webhooks.mjs';

// /v2/unresolved — the agent-facing queue of inbound events that were received but couldn't be
// tied to a contact: a meeting whose room matched nobody we know. The agent lists them, decides
// who each belongs to, and resolves it — which re-fires the normal ingest pipeline against the
// chosen contact so notes + claim/insight extraction + evidence run exactly as usual.
//
// Every note-taker that can queue a row can now be resolved (GET-229). It used to be Fireflies
// only, so a queued Granola or Fellow call was a dead end: visible, unresolvable, forever.
export const unresolvedV2Router = Router();

// GET /v2/unresolved?status=pending — list the queue for this workspace.
unresolvedV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const status = String(req.query.status || 'pending');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { data, error } = await supabase
      .from('unresolved_ingest')
      .select('id, source, kind, external_id, title, occurred_at, detected_names, detected_emails, summary, status, last_seen_at, created_at')
      .eq('workspace_id', workspaceId)
      .eq('status', status)
      .order('last_seen_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ unresolved: data || [], count: (data || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /v2/unresolved/:id/resolve  { focus }
// Attach the meeting to the contact named by `focus` and re-run the full pipeline.
unresolvedV2Router.post('/:id/resolve', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus } = req.body || {};
    if (!focus) return res.status(400).json({ error: 'focus_required' });

    const { data: row } = await supabase.from('unresolved_ingest')
      .select('*').eq('workspace_id', workspaceId).eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status === 'resolved') return res.json({ ok: true, already: true });
    if (!RESOLVABLE.has(row.source)) return res.status(400).json({ error: `unsupported_source_${row.source}` });

    // Resolve the target contact. Return ambiguity/not-found as 200 bodies (not
    // HTTP errors) so the MCP client renders candidates instead of throwing.
    const r = await resolveFocus(supabase, workspaceId, String(focus));
    if (r?.status === 'ambiguous') {
      return res.json({ ok: false, ambiguous: true, focus, candidates: r.candidates || [] });
    }
    if (r?.status !== 'resolved' || !r.entity_id) {
      return res.json({ ok: false, error: 'contact_not_found', focus });
    }
    const entityId = r.entity_id;

    // Teach the identity: attach the meeting's detected email(s) to this contact so
    // future events resolve on their own (and normal resolution catches this one too).
    for (const email of row.detected_emails || []) {
      const { data: claimed } = await supabase.from('entity_identifiers')
        .select('entity_id').eq('workspace_id', workspaceId).eq('kind', 'email').eq('value', email).maybeSingle();
      if (!claimed) await upsertIdentifier(supabase, workspaceId, entityId, 'email', email).catch(() => {});
    }

    // Re-fire the worker with the forced entity → full ingest pipeline. The worker marks the
    // row resolved on a successful log; we also set it here idempotently.
    const wjson = await reingest(row.source, workspaceId, row.external_id, entityId);
    if (wjson?.error === 'worker_unreachable') {
      return res.status(503).json({ error: 'worker_unreachable', message: 'Could not reach the ingest worker to re-run this meeting.' });
    }
    const logged = Number(wjson?.logged || 0);

    if (logged > 0) {
      await supabase.from('unresolved_ingest').update({
        status: 'resolved', resolved_entity_id: entityId, resolved_at: new Date().toISOString(),
      }).eq('id', row.id).neq('status', 'resolved');
    }
    res.json({ ok: true, entity_id: entityId, resolved: logged > 0, worker: wjson });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The sources whose handler can re-run one meeting by id and force a contact onto it. */
const RESOLVABLE = new Set(['fireflies', 'granola', 'fellow', 'ringcentral']);

/**
 * Ask the worker to re-run this meeting. Over the compose network (/internal/reingest), because
 * the public /inbound door is signature-checked and an internal re-fire carries no provider
 * signature — which is the reason this only ever worked for Fireflies, the one source whose
 * env secret we could forge ourselves.
 *
 * The old signed-/inbound path stays as the fallback for Fireflies on a self-host with no
 * WORKER_SECRET, so nobody loses a feature they had.
 */
async function reingest(source, workspaceId, externalId, entityId) {
  const workerUrl = process.env.NOUS_WORKER_URL;
  if (workerUrl && process.env.WORKER_SECRET) {
    try {
      const r = await fetch(`${workerUrl.replace(/\/+$/, '')}/internal/reingest`, {
        method: 'POST',
        headers: { 'x-worker-secret': process.env.WORKER_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ source, workspaceId, externalId, resolveToEntityId: entityId }),
      });
      return await r.json().catch(() => ({}));
    } catch (e) {
      console.warn('[unresolved/resolve] worker internal call failed:', e?.message || e);
      if (source !== 'fireflies') return { error: 'worker_unreachable' };
    }
  } else if (source !== 'fireflies') {
    return { error: 'worker_unreachable' };
  }

  const body = { meetingId: externalId, eventType: 'agent_resolve', resolveToEntityId: entityId };
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (secret) headers['x-nous-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
  const wres = await fetch(`${workerBaseUrl()}/inbound/fireflies/${workspaceId}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return await wres.json().catch(() => ({}));
}

// POST /v2/unresolved/:id/dismiss — junk / not worth resolving.
unresolvedV2Router.post('/:id/dismiss', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { data } = await supabase.from('unresolved_ingest')
      .update({ status: 'dismissed' })
      .eq('workspace_id', workspaceId).eq('id', req.params.id).select('id').maybeSingle();
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
