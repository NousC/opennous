import { resolveFocus, listSignals, scoreAndStake } from '@nous/core';
import { icpFit, fetchIntentByEntity } from './icpFit.mjs';

// The scoring atom behind the public `score` verb (POST /v2/score, MCP `score`)
// AND the batch external-list path (attach_list). One identifier in — a lean
// judgment out, plus the icp_fit prediction staked into the graph so agents read
// the same number through get_context / query. Deliberately leaner than
// assembleContext: a sheet cell wants {fit, tier, intent, band}, not the whole
// account.
//
// Read-mostly by design. The evolving score is re-computed in place by the
// worker (scoreEntities every 10m, rescore on model change). This verb only
// BOOTSTRAP-stakes: if a known entity carries scoreable claims but was never
// scored, we stake once on demand so the sheet gets a number now instead of
// waiting for the next cron. It never re-stakes an already-scored entity — that
// would churn duplicate predictions on every weekly refresh.
//
// Returns one of:
//   { resolved:false, reason:'unknown_identifier' }        — not in the graph; enrich first
//   { resolved:false, reason:'ambiguous', candidates }     — a name matched several people
//   { resolved:true, scored:false, reason:'awaiting_enrichment', entity_id }
//   { resolved:true, scored:true, entity_id, icp:{...}, intent:{...} }
export async function scoreIdentifier(supabase, workspaceId, identifier, { intent } = {}) {
  const focus = String(identifier ?? '').trim();
  if (!focus) return { resolved: false, reason: 'identifier_required' };

  const resolution = await resolveFocus(supabase, workspaceId, focus);
  if (resolution.status === 'not_found') {
    return { resolved: false, reason: 'unknown_identifier' };
  }
  if (resolution.status === 'ambiguous') {
    return { resolved: false, reason: 'ambiguous', candidates: resolution.candidates };
  }

  const entityId = resolution.entity_id;

  // Bootstrap-stake a known-but-unscored entity so the caller gets a live number
  // now. scoreAndStake itself gates on scoreable features + internal-team, so a
  // hollow 0 is never staked — it returns null and we report awaiting_enrichment.
  let icp = await icpFit(supabase, workspaceId, entityId);
  if (!icp) {
    const signals = await listSignals(supabase, workspaceId, { activeOnly: true });
    if (signals.length) {
      try { await scoreAndStake(supabase, workspaceId, entityId, signals); }
      catch (err) { console.warn('[SCORE_IDENTIFIER] stake', entityId, err.message); }
      icp = await icpFit(supabase, workspaceId, entityId);
    }
  }

  if (!icp) {
    return { resolved: true, scored: false, reason: 'awaiting_enrichment', entity_id: entityId };
  }

  const intentMap = await fetchIntentByEntity(supabase, workspaceId, [entityId]);
  const it = intentMap.get(entityId) || { score: 0, band: 'Dormant' };

  return {
    resolved: true,
    scored: true,
    entity_id: entityId,
    icp: {
      score: icp.score,          // 0–100 ICP fit
      fit: icp.fit,              // boolean: score >= 70
      tier: icp.tier,            // tier_1 | tier_2 | tier_3 | not_icp — drives the play
      reason: icp.reason,        // which signals fired
      scored_at: icp.scored_at,
    },
    intent: {
      score: it.score,           // 0–100 decaying intent
      band: it.band,             // Red-hot | Hot | Warm | Aware | Dormant
    },
  };
}
