import { Router } from 'express';
import {
  getSupabaseClient, getAccountRecord, resolveFocus, mergeEntities, readContextFromReq,
  compressAccount, budgetForIntent,
} from '@nous/core';
import { icpFit } from '../../lib/icpFit.mjs';

export const accountsV2Router = Router();

// POST /v2/accounts/merge — fold a duplicate person into a survivor.
// Body: { keep, drop } — each an entity UUID, email, LinkedIn URL, domain, or name.
// Agent-only dedup. Lossless (drop's identifiers re-attach to keep) + reversible
// (drop becomes a merged tombstone). A name that matches several people returns
// candidates instead of merging — the agent confirms which, then re-calls.
accountsV2Router.post('/merge', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { keep, drop } = req.body || {};
    if (!keep || !drop) return res.status(400).json({ error: 'keep_and_drop_required' });

    for (const [which, value] of [['keep', keep], ['drop', drop]]) {
      const r = await resolveFocus(supabase, workspaceId, String(value));
      if (r.status === 'not_found') return res.status(404).json({ error: 'entity_not_found', which, value });
      if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', which, candidates: r.candidates });
      if (which === 'keep') req._keepId = r.entity_id; else req._dropId = r.entity_id;
    }
    if (req._keepId === req._dropId) return res.status(400).json({ error: 'same_entity' });

    const summary = await mergeEntities(supabase, workspaceId, req._keepId, req._dropId);
    return res.json({ status: 'merged', ...summary });
  } catch (err) {
    const msg = err?.message || 'internal_error';
    const client = /not found|already merged|type mismatch|itself/.test(msg);
    if (!client) console.error('[POST /v2/accounts/merge]', err);
    return res.status(client ? 400 : 500).json({ error: msg });
  }
});

// GET /v2/accounts/:id — the full account-record projection:
// entity + claims-with-epistemics + recent observation timeline.
// :id may be an entity UUID, email, domain, LinkedIn URL, or a name.
//
// ?intent=meeting_prep|call_prep|account_review|follow_up|draft_email
//   Ranks the timeline by how much each interaction actually TELLS you, and keeps
//   the number a question of that shape needs. The result rides alongside the raw
//   record as `key_activity` + `activity_summary`.
//
// ?compress=1
//   Drops the raw `recent_observations` and returns only the ranked view.
//
// Both are opt-in, and that is deliberate. compressAccount replaces the timeline
// rather than reordering it, so making it the default would silently break every
// consumer already reading `recent_observations` — a shape we published. New
// callers ask for the good context; old ones keep what they were promised.
accountsV2Router.get('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status === 'not_found') {
      return res.status(404).json({ error: 'entity_not_found' });
    }
    if (resolution.status === 'ambiguous') {
      return res.json({ status: 'ambiguous', candidates: resolution.candidates });
    }

    const record = await getAccountRecord(supabase, workspaceId, resolution.entity_id, readContextFromReq(req));
    if (!record) return res.status(404).json({ error: 'entity_not_found' });
    const icp = await icpFit(supabase, workspaceId, resolution.entity_id);

    const intent   = req.query.intent ? String(req.query.intent) : null;
    const compress = req.query.compress === '1' || req.query.compress === 'true';

    let out = icp ? { ...record, icp } : { ...record };

    if (intent || compress) {
      const { key_activity, activity_summary } = compressAccount(record, budgetForIntent(intent));
      out = { ...out, key_activity, activity_summary };
      // Only drop the raw timeline when explicitly asked. Ranked AND raw is a
      // legitimate thing to want; ranked INSTEAD OF raw has to be a choice.
      if (compress) delete out.recent_observations;
    }

    return res.json(out);
  } catch (err) {
    console.error('[GET /v2/accounts/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
