import { scoreTier } from '@nous/core';

// Batch ICP overlay for LIST endpoints: the latest icp_fit prediction per entity
// → { score, tier }. This is the ONE source the lead list and the people list both
// overlay at read time, so the two surfaces can never show a different ICP number
// or tier than the person record. Batched IN() in chunks of 100 — a 500+-UUID IN
// makes a URL the PostgREST gateway can truncate (silently dropping rows).
export async function fetchIcpByEntity(supabase, workspaceId, entityIds) {
  const out = new Map();
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('predictions')
      .select('entity_id, predicted_value, predicted_at')
      .eq('workspace_id', workspaceId).eq('kind', 'icp_fit')
      .in('entity_id', ids.slice(i, i + 100))
      .order('predicted_at', { ascending: false });
    for (const p of (data || [])) {
      if (out.has(p.entity_id)) continue;        // first = latest (ordered desc)
      const sc = p.predicted_value?.score;
      if (sc == null) continue;
      const score = Number(sc);
      out.set(p.entity_id, { score, tier: p.predicted_value.tier ?? scoreTier(score) });
    }
  }
  return out;
}

// Batch INTENT overlay for LIST endpoints — the sibling of fetchIcpByEntity, but
// for the "reach out NOW?" axis. Reads the `intent_score`/`intent_band` claims the
// intent worker stakes (see apps/worker/src/intentScore.mjs). One source the lead
// list and people list both overlay, so intent never disagrees across surfaces.
// Entities with no claim default to score 0 / band 'Dormant' at the call site.
export async function fetchIntentByEntity(supabase, workspaceId, entityIds) {
  const out = new Map();
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('entity_id', ids.slice(i, i + 100))
      .in('property', ['intent_score', 'intent_band'])
      .is('invalid_at', null);
    for (const c of (data || [])) {
      const row = out.get(c.entity_id) || { score: 0, band: 'Dormant' };
      if (c.property === 'intent_score') row.score = Number(c.value) || 0;
      else if (c.property === 'intent_band') row.band = c.value || 'Dormant';
      out.set(c.entity_id, row);
    }
  }
  return out;
}

// The latest ICP fit score for an entity, shaped for the agent-facing record.
// Lets get_context / get_account return not just *who you sell to* (workspace
// facts) but *whether this specific account is one of them, and how confident* —
// so an agent can act on the score, not just read context.
export async function icpFit(supabase, workspaceId, entityId) {
  const { data } = await supabase
    .from('predictions')
    .select('predicted_value, predicted_at, resolved_at, outcome_value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const pv = data?.predicted_value;
  if (!pv || pv.score == null) return null;

  return {
    score: pv.score,                 // 0–100 fit score
    fit: pv.fit ?? null,             // boolean: score >= 70
    tier: pv.tier ?? null,           // tier_1 | tier_2 | tier_3 | not_icp — the actionable class
    reason: pv.reason ?? null,       // which signals fired (or "no signals matched")
    scored_at: data.predicted_at,
    // The score history trail — prior {score, reason, at} entries, newest first,
    // so an agent can see how the fit evolved and what moved it. Not shown in the
    // UI (which displays only the current score); this is for agents to read.
    history: Array.isArray(pv.history) ? pv.history : [],
    // Once the prediction has resolved, the realized outcome (0–1) so an agent
    // can see whether the bet paid off.
    outcome_score: data.resolved_at ? (data.outcome_value?.score ?? null) : null,
  };
}
