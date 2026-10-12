import { scoreTier, SCORE_LAYERS, intentBandOr } from '@nous/core';

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
      // Two shapes in the wild — bare "Warm", or { band, score, from } when the
      // history observation was re-derived over the claim. Passing the object
      // through put a JSON blob where every caller expects a band string
      // (contacts list, lead lists, /v2/leads). See core/intentBand.ts.
      else if (c.property === 'intent_band') row.band = intentBandOr(c.value);
      out.set(c.entity_id, row);
    }
  }
  return out;
}

// Batch REPLY-DISPOSITION overlay — the latest inbound reply's canonical signal
// (positive / objection / neutral / negative / unsubscribe / do_not_contact /
// auto_reply). Staked as a `reply_signal` claim by the worker on every classified
// reply (see apps/worker/src/utils/activity.mjs). This is a DIFFERENT axis from
// intent: intent says how ready-to-buy they are, reply says how they last answered.
// Entities with no reply default to null at the call site (no chip shown).
export async function fetchReplySignalByEntity(supabase, workspaceId, entityIds) {
  const out = new Map();
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('claims')
      .select('entity_id, value, last_observed_at')
      .eq('workspace_id', workspaceId)
      .in('entity_id', ids.slice(i, i + 100))
      .eq('property', 'reply_signal')
      .is('invalid_at', null);
    for (const c of (data || [])) {
      out.set(c.entity_id, { signal: c.value || null, at: c.last_observed_at || null });
    }
  }
  return out;
}

// The recommended play, as a function of the SHAPE of the resolved hypothesis —
// not a single tier. An unresolved layer is an instruction to enrich, not a reason
// to skip. This is what makes the score work-generating.
export function layeredPlay({ layers, band, missing }) {
  const fit = layers.fit;
  if (fit == null) return 'enrich — resolve fit first';
  if (fit < 50) return 'suppress — not a fit';
  // Strong-looking fit but we've observed nothing about the problem or the timing.
  if (missing.includes('pain') && missing.includes('intent')) {
    return 'research — strong-looking fit; enrich pain and intent before outreach';
  }
  if (band === 'high') return 'work now — high priority';
  if (layers.intent != null && layers.intent < 50) return 'nurture — good fit, no timing yet';
  if (missing.length) return `enrich — resolve ${missing.join(', ')}`;
  return band === 'medium' ? 'work — medium priority' : 'nurture — low priority';
}

// Shape a scoreByLayer() result (computed live, not read from claims) into the same
// API shape fetchIcpLayers returns: { priority, band, layers:{L:number}, missing, play }.
// Used for leads too thin to STAKE (calibration-protected) but that can still resolve
// Fit/Pain from keywords/company — so the caller gets a partial hypothesis + worklist
// instead of a dead "awaiting_enrichment".
export function shapeLayeredResult(r) {
  const layers = {};
  for (const [L, v] of Object.entries(r.layers || {})) {
    if (v && v.known && v.score != null) layers[L] = v.score;
  }
  return { priority: r.priority ?? null, band: r.band ?? null, layers, missing: r.missing || [], play: layeredPlay({ layers, band: r.band ?? null, missing: r.missing || [] }) };
}

// The LAYERED ICP breakdown (Fit · Pain · Intent · Ability + Priority) for an
// entity, read from the icp.<layer> claims writeLayerClaims stakes. Unknown layers
// carry no claim → they surface in `missing` (the enrichment worklist), never as 0.
// Returns null when nothing is resolved yet (the caller falls back to the flat icp).
export async function fetchIcpLayers(supabase, workspaceId, entityId) {
  const props = ['icp.fit', 'icp.pain', 'icp.intent', 'icp.ability', 'icp.priority', 'icp.priority_band'];
  const { data } = await supabase.from('claims')
    .select('property, value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .in('property', props)
    .is('invalid_at', null);

  const layers = {};
  let priority = null, band = null;
  for (const c of (data || [])) {
    if (c.property === 'icp.priority') priority = Number(c.value);
    else if (c.property === 'icp.priority_band') band = c.value ?? null;
    else layers[c.property.slice(4)] = Number(c.value);   // strip the 'icp.' prefix
  }
  if (priority == null && Object.keys(layers).length === 0) return null;

  // Every layer with no live claim is "unknown" — the enrichment worklist.
  const missing = SCORE_LAYERS.filter(l => layers[l] == null);
  return { priority, band, layers, missing, play: layeredPlay({ layers, band, missing }) };
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
