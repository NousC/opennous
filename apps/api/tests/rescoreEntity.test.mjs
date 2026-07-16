import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hasSupabase } from './helpers.mjs';
import { getSupabaseClient, rescoreEntityFromClaims } from '@nous/core';

// Re-score-on-enrichment. An account is first scored when it becomes scoreable,
// then enriched later (job title, seniority, firmographics arrive after). This
// recomputes the OPEN prediction from the entity's CURRENT claims — so the new
// evidence flows into the score and the trail (prior score kept as history) —
// while RESOLVED bets stay immutable. Runs against the real DB in a throwaway
// team/workspace that cascade-deletes.

const run = hasSupabase ? test : (n, _f) => test(n, { skip: 'no SUPABASE env' }, () => {});

let workspaceId = null;
let teamId = null;

before(async () => {
  if (!hasSupabase) return;
  const supabase = getSupabaseClient();
  const { data: team } = await supabase
    .from('teams').insert({ name: `zz-rescore-ent-${Date.now()}` }).select('id').single();
  teamId = team.id;
  const { data: ws } = await supabase
    .from('workspaces').insert({ name: `zz-rescore-ent-${Date.now()}`, team_id: teamId }).select('id').single();
  workspaceId = ws.id;
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

async function makeEntity(supabase) {
  const { data: ent } = await supabase
    .from('entities').insert({ workspace_id: workspaceId, type: 'person', status: 'active' }).select('id').single();
  return ent.id;
}
async function addClaim(supabase, entityId, property, value) {
  await supabase.from('claims').insert({
    workspace_id: workspaceId, entity_id: entityId, property, value,
    confidence: 1, epistemic_class: 'asserted',
  });
}
async function openPrediction(supabase, entityId, { score, seniority }) {
  const { data: pred } = await supabase.from('predictions').insert({
    workspace_id: workspaceId, entity_id: entityId, kind: 'icp_fit',
    predicted_value: { score, fit: score >= 70, reason: 'pre-enrichment' },
    predicted_confidence: score / 100,
    feature_snapshot: seniority ? { seniority: { value: seniority, confidence: 1 } } : {},
    model_version: 'sc_OLD',
    predicted_at: new Date(Date.now() - 86400000).toISOString(),
  }).select('id').single();
  return pred.id;
}

run('enrichment that adds a scoreable claim re-scores the open prediction + keeps the prior in history', async () => {
  const supabase = getSupabaseClient();
  // Scored 50 before enrichment had nothing to fire on; now a c_suite claim lands.
  const entityId = await makeEntity(supabase);
  const predId = await openPrediction(supabase, entityId, { score: 50, seniority: null });
  await addClaim(supabase, entityId, 'seniority', 'c_suite');

  const res = await rescoreEntityFromClaims(supabase, workspaceId, entityId);
  assert.equal(res.status, 'rescored', 'score moved after enrichment');
  assert.equal(res.from, 50);
  assert.equal(res.to, 73, 'c_suite fires +8 → logistic 73');

  const { data: row } = await supabase
    .from('predictions').select('predicted_value, feature_snapshot, model_version, resolved_at').eq('id', predId).single();
  assert.equal(row.predicted_value.score, 73, 'head is the fresh score');
  assert.ok(Array.isArray(row.predicted_value.history) && row.predicted_value.history[0].score === 50, 'prior score 50 kept in history');
  assert.equal(row.feature_snapshot.seniority.value, 'c_suite', 'snapshot refreshed to current claims');
  assert.ok(row.model_version.startsWith('sc_'), 'model_version stamped');
  assert.equal(row.resolved_at, null, 'still open');
});

run('a RESOLVED prediction is never touched', async () => {
  const supabase = getSupabaseClient();
  const entityId = await makeEntity(supabase);
  await addClaim(supabase, entityId, 'seniority', 'c_suite');
  const { data: pred } = await supabase.from('predictions').insert({
    workspace_id: workspaceId, entity_id: entityId, kind: 'icp_fit',
    predicted_value: { score: 50, fit: false, reason: 'bet' }, predicted_confidence: 0.5,
    feature_snapshot: {}, model_version: 'sc_OLD',
    predicted_at: new Date().toISOString(), resolved_at: new Date().toISOString(),
    outcome_value: { disposition: 'won', score: 1 },
  }).select('id').single();

  const res = await rescoreEntityFromClaims(supabase, workspaceId, entityId);
  assert.equal(res.status, 'no_open_prediction', 'resolved bet is not an open prediction');
  const { data: row } = await supabase.from('predictions').select('predicted_value, model_version').eq('id', pred.id).single();
  assert.equal(row.predicted_value.score, 50, 'resolved bet score frozen');
  assert.equal(row.model_version, 'sc_OLD', 'resolved bet model_version untouched');
});

run('no scoreable claim yet → not_scoreable, prediction untouched', async () => {
  const supabase = getSupabaseClient();
  const entityId = await makeEntity(supabase);
  await addClaim(supabase, entityId, 'first_name', 'Dana'); // identity only, not scoreable
  const predId = await openPrediction(supabase, entityId, { score: 50, seniority: null });

  const res = await rescoreEntityFromClaims(supabase, workspaceId, entityId);
  assert.equal(res.status, 'not_scoreable', 'identity-only claims are not scoreable');
  const { data: row } = await supabase.from('predictions').select('predicted_value').eq('id', predId).single();
  assert.equal(row.predicted_value.score, 50, 'untouched');
  assert.equal(row.predicted_value.history, undefined, 'no history added');
});

run('unchanged score → restamped, no noisy history entry', async () => {
  const supabase = getSupabaseClient();
  // manager fires nothing → score stays 50 (logistic baseline), so just restamp.
  const entityId = await makeEntity(supabase);
  await addClaim(supabase, entityId, 'seniority', 'manager');
  const predId = await openPrediction(supabase, entityId, { score: 50, seniority: 'manager' });

  const res = await rescoreEntityFromClaims(supabase, workspaceId, entityId);
  assert.equal(res.status, 'restamped', 'score did not move');
  const { data: row } = await supabase.from('predictions').select('predicted_value, feature_snapshot').eq('id', predId).single();
  assert.equal(row.predicted_value.score, 50);
  assert.equal(row.predicted_value.history, undefined, 'no history for a restamp');
  assert.equal(row.feature_snapshot.seniority.value, 'manager', 'snapshot still current');
});
