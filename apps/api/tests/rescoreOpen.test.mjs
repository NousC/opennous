import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasSupabase } from './helpers.mjs';
import { getSupabaseClient, rescoreOpenPredictions, modelVersion } from '@nous/core';

// Phase 3 — re-score-open. When the model changes, OPEN predictions get their
// current fit recomputed in place from their stored feature_snapshot (prior
// score preserved as history), while RESOLVED bets stay immutable. Runs against
// the real DB in a throwaway team/workspace that cascade-deletes.

const run = hasSupabase ? test : (n, _f) => test(n, { skip: 'no SUPABASE env' }, () => {});

let workspaceId = null;
let teamId = null;

before(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  const { data: team } = await supabase
    .from('teams').insert({ name: `zz-rescore-test-${Date.now()}` }).select('id').single();
  teamId = team.id;
  const { data: ws } = await supabase
    .from('workspaces').insert({ name: `zz-rescore-test-${Date.now()}`, team_id: teamId }).select('id').single();
  workspaceId = ws.id;
  // One active signal: c_suite seniority → +8. The whole catalog, so a c_suite
  // account scores 100, anyone else 0.
  await supabase.from('scorecard_signals').insert({
    workspace_id: workspaceId, key: 'is_csuite', label: 'C-suite', weight: 8,
    rule: { feature: 'seniority', op: '==', value: 'c_suite' }, active: true,
  });
});

after(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  if (workspaceId) await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (teamId) await supabase.from('teams').delete().eq('id', teamId);
});

async function insertPrediction(supabase, { seniority, score, resolved = false, version = 'sc_OLD' }) {
  const { data: ent } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'person', status: 'active' }).select('id').single();
  const { data: pred } = await supabase
    .from('predictions')
    .insert({
      workspace_id: workspaceId, entity_id: ent.id, kind: 'icp_fit',
      predicted_value: { score, fit: score >= 70, reason: 'old' },
      predicted_confidence: score / 100,
      feature_snapshot: { seniority: { value: seniority, confidence: 1 } },
      model_version: version,
      predicted_at: new Date().toISOString(),
      ...(resolved ? { resolved_at: new Date().toISOString(), outcome_value: { disposition: 'won', score: 1 } } : {}),
    })
    .select('id').single();
  return pred.id;
}

run('open prediction whose score moves is re-scored, prior kept as history', async () => {
  const supabase = getSupabaseClient();
  // Stored score 50 but under the live model a c_suite account is 100 → moves.
  const id = await insertPrediction(supabase, { seniority: 'c_suite', score: 50 });

  const res = await rescoreOpenPredictions(supabase, workspaceId);
  assert.equal(res.rescored, 1, 'one account re-scored');
  assert.equal(res.version, modelVersion([{ active: true, key: 'is_csuite', weight: 8, rule: { feature: 'seniority', op: '==', value: 'c_suite' } }]), 'version is the live model fingerprint');

  const { data: row } = await supabase
    .from('predictions').select('predicted_value, model_version, resolved_at').eq('id', id).single();
  assert.equal(row.predicted_value.score, 73, 'current fit recomputed (logistic: +8 → 73)');
  assert.equal(row.predicted_value.fit, true, 'fit flipped true');
  assert.ok(Array.isArray(row.predicted_value.history) && row.predicted_value.history[0].score === 50, 'prior score 50 kept in history');
  assert.ok(row.model_version.startsWith('sc_'), 'model_version stamped');
  assert.equal(row.resolved_at, null, 'still open');
});

run('open prediction whose score is unchanged is only re-stamped (no history)', async () => {
  const supabase = getSupabaseClient();
  // 'manager' never fires the signal → score 0, and stored score is already 0.
  const id = await insertPrediction(supabase, { seniority: 'manager', score: 50 });

  const res = await rescoreOpenPredictions(supabase, workspaceId);
  assert.equal(res.rescored, 0, 'nothing re-scored (score did not move)');
  assert.ok(res.restamped >= 1, 'at least one re-stamped');

  const { data: row } = await supabase
    .from('predictions').select('predicted_value, model_version').eq('id', id).single();
  assert.equal(row.predicted_value.score, 50, 'score unchanged (manager fires nothing → logistic 50)');
  assert.equal(row.predicted_value.history, undefined, 'no history added for a restamp');
  assert.ok(row.model_version.startsWith('sc_'), 'version stamped to current');
});

run('a RESOLVED prediction is never touched by re-score', async () => {
  const supabase = getSupabaseClient();
  const id = await insertPrediction(supabase, { seniority: 'c_suite', score: 50, resolved: true });

  await rescoreOpenPredictions(supabase, workspaceId);

  const { data: row } = await supabase
    .from('predictions').select('predicted_value, model_version').eq('id', id).single();
  assert.equal(row.predicted_value.score, 50, 'resolved bet score frozen at 50');
  assert.equal(row.model_version, 'sc_OLD', 'resolved bet model_version untouched');
});

run('re-running re-score is idempotent — already-current predictions are skipped', async () => {
  const supabase = getSupabaseClient();
  await insertPrediction(supabase, { seniority: 'c_suite', score: 50 });
  await rescoreOpenPredictions(supabase, workspaceId);   // brings it to current
  const second = await rescoreOpenPredictions(supabase, workspaceId);  // nothing new to do
  assert.equal(second.rescored, 0, 'second pass re-scores nothing already at version');
});
