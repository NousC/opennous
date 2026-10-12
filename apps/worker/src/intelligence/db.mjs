// Data-access for the six intelligence tables. The runners and jobs go through
// here so the persistence rules (versioning, upsert-not-duplicate, evidence) live
// in exactly one place.

import { isActive } from './types.mjs';

// ── Behaviors ────────────────────────────────────────────────────────────────

/**
 * Write behaviors idempotently. The unique key (ws, subject, behavior_key,
 * extractor_version) means re-running an extractor is safe and backfillable — a
 * bumped extractor_version re-extracts without colliding with the old rows.
 */
export async function upsertBehaviors(supabase, workspaceId, behaviors) {
  if (!behaviors?.length) return 0;
  const rows = behaviors.map((b) => ({
    workspace_id: workspaceId,
    subject_type: b.subjectType,
    subject_id: String(b.subjectId),
    behavior_key: b.key,
    value_num: b.valueNum ?? null,
    value_bool: b.valueBool ?? null,
    value_text: b.valueText ?? null,
    evidence_ids: b.evidenceIds ?? [],
    extractor_version: b.extractorVersion ?? 1,
    observed_at: b.observedAt ?? new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('ri_behaviors')
    .upsert(rows, { onConflict: 'workspace_id,subject_type,subject_id,behavior_key,extractor_version' });
  if (error) { console.warn('[ri.db] upsertBehaviors:', error.message); return 0; }
  return rows.length;
}

/** Read behaviors for a workspace, optionally by key and/or subject type. */
export async function getBehaviors(supabase, workspaceId, { behaviorKey, subjectType } = {}) {
  let q = supabase.from('ri_behaviors').select('*').eq('workspace_id', workspaceId);
  if (behaviorKey) q = q.eq('behavior_key', behaviorKey);
  if (subjectType) q = q.eq('subject_type', subjectType);
  const { data, error } = await q;
  if (error) { console.warn('[ri.db] getBehaviors:', error.message); return []; }
  return data ?? [];
}

// ── Observations (+ version time series) ─────────────────────────────────────

/**
 * Upsert a learned observation and append a version row whenever the effect,
 * confidence, or sample size actually moved. This is the "watch understanding
 * evolve" mechanism — history is append-only, never mutated. Returns the row id.
 */
export async function upsertObservation(supabase, workspaceId, obs) {
  const conditions = obs.conditions ?? {};
  const { data: existing } = await supabase
    .from('ri_observations').select('*')
    .eq('workspace_id', workspaceId).eq('question_key', obs.questionKey)
    .eq('conditions', conditions).maybeSingle();

  const moved = !existing
    || existing.effect !== (obs.effect ?? null)
    || existing.confidence !== obs.confidence
    || existing.sample_size !== (obs.sampleSize ?? 0);

  const version = existing ? (moved ? existing.version + 1 : existing.version) : 1;
  const row = {
    workspace_id: workspaceId,
    question_key: obs.questionKey,
    category: obs.category,
    job_type: obs.jobType,
    behavior_key: obs.behaviorKey ?? null,
    outcome_key: obs.outcomeKey ?? null,
    conditions,
    sample_size: obs.sampleSize ?? 0,
    effect: obs.effect ?? null,
    confidence: obs.confidence,
    status: isActive(obs.confidence) ? 'active' : 'learning',
    recommendation_template: obs.recommendationTemplate ?? null,
    evidence: obs.evidence ?? {},
    version,
    updated_at: new Date().toISOString(),
  };

  const { data: saved, error } = await supabase
    .from('ri_observations')
    .upsert(row, { onConflict: 'workspace_id,question_key,conditions' })
    .select('id')
    .single();
  if (error) { console.warn('[ri.db] upsertObservation:', error.message); return null; }

  if (moved) {
    await supabase.from('ri_observation_versions').insert({
      observation_id: saved.id, version, effect: row.effect,
      confidence: row.confidence, sample_size: row.sample_size,
    });
  }
  return saved.id;
}

/** Active (surfaceable) observations, optionally filtered by category. */
export async function getActiveObservations(supabase, workspaceId, category) {
  let q = supabase.from('ri_observations').select('*')
    .eq('workspace_id', workspaceId).eq('status', 'active');
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) { console.warn('[ri.db] getActiveObservations:', error.message); return []; }
  return data ?? [];
}

// ── Recommendations ──────────────────────────────────────────────────────────

/**
 * Upsert a recommendation. rec_key + target dedupe it, so re-running refreshes the
 * text/evidence instead of piling up duplicates. A rec the user already decided
 * (acted/dismissed) is left alone — the worklist must not resurrect handled work.
 */
export async function upsertRecommendation(supabase, workspaceId, rec) {
  const { data: existing } = await supabase
    .from('ri_recommendations').select('id, status')
    .eq('workspace_id', workspaceId).eq('target_type', rec.targetType)
    .eq('target_id', String(rec.targetId)).eq('rec_key', rec.recKey).maybeSingle();

  // A user decision (acted/dismissed) is final — never resurrect handled work. But a
  // system-expired rec (auto-resolved because it stopped qualifying) SHOULD come back
  // if it qualifies again — fall through and the upsert re-opens it.
  if (existing && (existing.status === 'acted' || existing.status === 'dismissed')) return existing.id;

  const row = {
    workspace_id: workspaceId,
    category: rec.category,
    rec_key: rec.recKey,
    target_type: rec.targetType,
    target_id: String(rec.targetId),
    observation_id: rec.observationId ?? null,
    text: rec.text,
    impact_estimate: rec.impactEstimate ?? null,
    priority: rec.priority ?? 1.0,   // learned effectiveness rank (1.0 = neutral); see effectiveness.mjs
    evidence: rec.evidence ?? {},
    status: 'open',
    updated_at: new Date().toISOString(),
  };
  const { data: saved, error } = await supabase
    .from('ri_recommendations')
    .upsert(row, { onConflict: 'workspace_id,target_type,target_id,rec_key' })
    .select('id').single();
  if (error) { console.warn('[ri.db] upsertRecommendation:', error.message); return null; }
  return saved.id;
}

/**
 * Auto-resolve: OPEN recommendations for a rule that the latest run did NOT re-emit
 * are no longer true (the deal added a stakeholder, got a touch, closed) — expire
 * them so the worklist stays honest without a human dismissing each one. Called only
 * after a job's recommend() SUCCEEDS; on an error we don't know the truth and must
 * not expire anything. `emitted` is the set of "<targetType>:<targetId>" this run
 * produced for this rec_key.
 */
export async function expireStaleRecs(supabase, workspaceId, recKey, emitted) {
  const { data: open } = await supabase
    .from('ri_recommendations').select('id, target_type, target_id')
    .eq('workspace_id', workspaceId).eq('rec_key', recKey).eq('status', 'open');
  const stale = (open ?? []).filter((r) => !emitted.has(`${r.target_type}:${r.target_id}`));
  if (!stale.length) return 0;
  const now = new Date().toISOString();
  await supabase.from('ri_recommendations')
    .update({ status: 'expired', decided_at: now, updated_at: now })
    .in('id', stale.map((r) => r.id));
  return stale.length;
}

// ── Playbooks (curation) ─────────────────────────────────────────────────────

/**
 * Upsert a workspace's playbook for a motion — a curated bundle of its currently
 * active observations. Version bumps only when the bundle actually changes, so the
 * version history is the record of how the playbook grew.
 */
export async function upsertPlaybook(supabase, workspaceId, motion, observationIds, metrics) {
  const ids = [...observationIds].sort();
  const { data: existing } = await supabase
    .from('ri_playbooks').select('id, version, observation_ids')
    .eq('workspace_id', workspaceId).eq('motion', motion).maybeSingle();
  const changed = !existing || JSON.stringify([...(existing.observation_ids ?? [])].sort()) !== JSON.stringify(ids);
  const version = existing ? (changed ? existing.version + 1 : existing.version) : 1;
  await supabase.from('ri_playbooks').upsert(
    { workspace_id: workspaceId, motion, observation_ids: ids, metrics: metrics ?? {}, version, updated_at: new Date().toISOString() },
    { onConflict: 'workspace_id,motion' },
  );
  return version;
}

// ── Priors + run bookkeeping ─────────────────────────────────────────────────

/** The anonymized cross-workspace seed for a question, if any. Small-N bootstrap. */
export async function getPrior(supabase, questionKey) {
  const { data } = await supabase
    .from('ri_global_priors').select('*').eq('question_key', questionKey).maybeSingle();
  return data ?? null;
}

export async function recordRun(supabase, runnerKey, workspaceId = null, meta = {}) {
  try {
    await supabase.from('ri_engine_runs').insert({ runner_key: runnerKey, workspace_id: workspaceId, meta });
  } catch { /* bookkeeping only */ }
}
