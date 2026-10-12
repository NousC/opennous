import { Router } from 'express';
import { getSupabaseClient, recomputeClaim } from '@nous/core';
import { recordObservations } from '../../lib/recordObservations.mjs';

export const observationsV2Router = Router();

// POST /v2/observations — record what happened / was learned.
// Body: {
//   focus: <entity UUID | email | domain>,
//   observations: [ { kind:'event'|'state', property, value, source?, method?,
//                      observed_at?, external_id?, raw? } ]
// }
// Agents never "update" — they observe. The substrate derives the new claims.
//
// The work lives in lib/recordObservations.mjs so the in-app agent's `record` tool runs
// exactly this path rather than a second, drifting copy (GET-94). This route is the HTTP
// skin: parse, call, map the result onto a status code.
observationsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const out = await recordObservations(supabase, req.workspaceId, req.body ?? {}, {
      userId: req.memberUserId ?? req.internalUserId ?? null,
      // Credits a write causes are billed later, in the worker; this is how they find the key.
      apiKeyId: req.apiKeyId ?? null,
    });
    if (!out.ok) {
      const { status, ok, ...body } = out;   // eslint-disable-line no-unused-vars
      return res.status(status ?? 400).json(body);
    }
    const { ok, ...body } = out;             // eslint-disable-line no-unused-vars
    return res.json(body);
  } catch (err) {
    console.error('[POST /v2/observations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /v2/observations/:id — retract an observation recorded by mistake, and heal the
// derived layer. Deletes the observation row, then recomputes the claim for its
// (entity, property) from the observations that remain; if that was the last observation
// for the property, the claim is invalidated. This is how you unsay something the agent
// observed wrongly — the fact re-derives as if the observation had never happened.
observationsV2Router.delete('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { id } = req.params;

    const { data: obs } = await supabase
      .from('observations')
      .select('id, entity_id, property')
      .eq('id', id).eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!obs) return res.status(404).json({ error: 'observation_not_found' });

    const { error: delErr } = await supabase
      .from('observations')
      .delete().eq('id', id).eq('workspace_id', workspaceId);
    if (delErr) throw delErr;

    // Re-derive the claim from what's left. recomputeClaim returns early when nothing
    // remains, so handle the "last observation removed" case ourselves: with no
    // observations left for the property, invalidate the stale claim.
    let claim = 'recomputed';
    const { count } = await supabase
      .from('observations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('entity_id', obs.entity_id).eq('property', obs.property);
    if ((count ?? 0) === 0) {
      await supabase.from('claims')
        .update({ invalid_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('entity_id', obs.entity_id).eq('property', obs.property)
        .is('invalid_at', null);
      claim = 'invalidated';
    } else {
      await recomputeClaim(supabase, workspaceId, obs.entity_id, obs.property);
    }

    return res.json({ status: 'retracted', id, entity_id: obs.entity_id, property: obs.property, claim });
  } catch (err) {
    console.error('[DELETE /v2/observations/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
