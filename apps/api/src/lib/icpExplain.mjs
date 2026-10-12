// Why this account carries the ICP score it carries.
//
// The score itself is one number on the record; the reason it landed there is spread across
// three places nobody reads together: the staked prediction (score, tier, the reason string),
// the signals that fired (keys only — the labels live in the scorecard), and the feature
// snapshot the rules were evaluated against. This assembles the three into one answer.
//
// The honest case matters most. When NO signal fires, the lead does not score "average" for a
// reason — it scores the model's baseline because nothing in the model could be evaluated, and
// that is usually a missing-input problem (no industry, no company size, no country on the
// record), not a judgment about the buyer. Saying which inputs were missing turns a dead-end
// number into a worklist.

import { listSignals } from '@nous/core';

/** ICP lives on PEOPLE. For a company, the best-scoring person represents the account. */
async function resolveScoredEntity(supabase, workspaceId, entityId) {
  const { data: company } = await supabase.from('companies')
    .select('id').eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();
  if (!company) return { entityId, via: null };

  const { data: people } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, icp_score')
    .eq('workspace_id', workspaceId).eq('company_id', entityId)
    .order('icp_score', { ascending: false, nullsFirst: false }).limit(1);
  const person = people?.[0];
  if (!person) return { entityId, via: null };
  return {
    entityId: person.id,
    via: { id: person.id, name: [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email || null },
  };
}

export async function explainIcp(supabase, workspaceId, entityId) {
  const { entityId: scoredId, via } = await resolveScoredEntity(supabase, workspaceId, entityId);

  const { data: preds } = await supabase.from('predictions')
    .select('predicted_value, fired_signals, feature_snapshot, model_version, predicted_at')
    .eq('workspace_id', workspaceId).eq('entity_id', scoredId).eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: false }).limit(1);
  const pred = preds?.[0];
  if (!pred) {
    return { scored: false, note: 'This account has never been scored against the ICP model.', via_person: via };
  }

  let signals = [];
  try { signals = await listSignals(supabase, workspaceId, { activeOnly: true }); } catch { /* labels are a nicety */ }
  const byKey = new Map(signals.map(s => [s.key, s]));

  const fired = (pred.fired_signals || []).map(f => ({
    key: f.key,
    label: byKey.get(f.key)?.label ?? f.key,
    weight: f.weight,
  }));

  // Which inputs the live model needs but this record does not carry. A rule whose feature is
  // absent from the snapshot cannot fire, however true it might be about the account.
  const snapshot = pred.feature_snapshot || {};
  const held = new Set(Object.keys(snapshot).filter(k => {
    const v = snapshot[k];
    const val = v && typeof v === 'object' && 'value' in v ? v.value : v;
    return val !== null && val !== undefined && val !== '';
  }));
  const missing = [...new Set(signals.map(s => s.rule?.feature).filter(f => f && !held.has(f)))].slice(0, 8);

  const val = pred.predicted_value || {};
  return {
    scored: true,
    score: val.score ?? null,
    tier: val.tier ?? null,
    fit: val.fit ?? null,
    reason: val.reason ?? null,
    scored_at: pred.predicted_at ?? null,
    model_version: pred.model_version ?? null,
    via_person: via,
    fired,
    missing_inputs: missing,
    note: fired.length
      ? null
      : `No signal in the ICP model matched this record, so ${val.score ?? 'the score'} is the model's baseline rather than a judgment about fit.`
        + (missing.length ? ` The model's rules read ${missing.join(', ')}, and none of those is on the record.` : ''),
  };
}
