// Prediction-write worker — stakes Scorecard predictions on entities.
//
// For every workspace with an active Scorecard, finds person-entities that
// carry claims but have no open `icp_fit` prediction, scores each from its
// claims, and stakes a prediction. This is the front of the compound loop:
// evidence (observations) becomes beliefs (claims) becomes a prediction the
// outcome job will later grade. See packages/core/src/db/predictions.ts.

import {
  getSupabaseClient,
  listSignals,
  scoreAndStake,
  entitiesNeedingScore,
  recogniseTeamMembers,
  logWorkerRun,
} from '@nous/core';

const PER_WORKSPACE_LIMIT = 200;

export async function scoreEntities() {
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  try {
    // Workspaces with at least one active signal — no Scorecard, nothing to stake.
    const { data: sigRows, error } = await supabase
      .from('scorecard_signals')
      .select('workspace_id')
      .eq('active', true);

    // Migration / tables not yet applied — skip silently.
    if (error?.code === '42P01' || error?.code === 'PGRST205') return;
    if (error) throw error;

    const workspaceIds = [...new Set((sigRows ?? []).map(r => r.workspace_id))];
    if (workspaceIds.length === 0) return;

    // Per-workspace tallies so each workspace sees its own prediction-stake activity.
    const perWorkspace = new Map(); // workspace_id → { staked, failed }
    const bump = (wsId, field) => {
      const row = perWorkspace.get(wsId) || { staked: 0, failed: 0 };
      row[field]++;
      perWorkspace.set(wsId, row);
    };
    let totalStaked = 0, totalFailed = 0;

    for (const workspaceId of workspaceIds) {
      const signals = await listSignals(supabase, workspaceId, { activeOnly: true });
      if (signals.length === 0) continue;

      // Flag team members before scoring so operators never get an ICP score.
      // Idempotent and cheap; the first run backfills everyone already in the graph.
      try { await recogniseTeamMembers(supabase, workspaceId); }
      catch (err) { console.warn(`[SCORE_ENTITIES] team recognition ${workspaceId}:`, err.message); }

      const entityIds = await entitiesNeedingScore(supabase, workspaceId, PER_WORKSPACE_LIMIT);

      // Belt-and-suspenders gate (mirrors scoreAndStake): only score entities
      // that actually carry a scoreable ICP claim. Unenriched contacts (name /
      // pipeline only) never get a hollow 0 staked — which pollutes calibration.
      // Lives here in plain JS so it can't be bypassed by a stale compiled core.
      let scoreable = new Set();
      if (entityIds.length) {
        const { data: scClaims } = await supabase
          .from('claims')
          .select('entity_id')
          .eq('workspace_id', workspaceId)
          .in('entity_id', entityIds)
          .in('property', ['job_title', 'seniority', 'department', 'industry', 'employee_count'])
          .is('invalid_at', null);
        scoreable = new Set((scClaims || []).map(c => c.entity_id));
      }

      for (const entityId of entityIds) {
        if (!scoreable.has(entityId)) continue; // awaiting enrichment — skip, don't stake a hollow 0
        try {
          const result = await scoreAndStake(supabase, workspaceId, entityId, signals);
          if (result) { totalStaked++; bump(workspaceId, 'staked'); }
        } catch (err) {
          totalFailed++; bump(workspaceId, 'failed');
          console.error(`[SCORE_ENTITIES] ${entityId}:`, err.message);
        }
      }
    }

    if (totalStaked || totalFailed) {
      console.log(`[SCORE_ENTITIES] staked=${totalStaked} failed=${totalFailed}`);
      for (const [workspaceId, counts] of perWorkspace) {
        await logWorkerRun(supabase, {
          worker: 'score_entities',
          workspaceId,
          status: counts.failed && !counts.staked ? 'error' : 'success',
          summary: `staked ${counts.staked}${counts.failed ? `, failed ${counts.failed}` : ''}`,
          details: counts,
          startedAt,
        });
      }
    }
  } catch (err) {
    console.error('[SCORE_ENTITIES] sweep error:', err.message);
    await logWorkerRun(supabase, {
      worker: 'score_entities',
      status: 'error',
      summary: 'sweep failed',
      error: err.message,
      startedAt,
    });
  }
}
