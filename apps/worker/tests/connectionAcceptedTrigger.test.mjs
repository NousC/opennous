/**
 * interaction.linkedin_connection_accepted — fires on the state change, from
 * both the connector-activity path and the claim state-transition path, and
 * dedups to a single delivery. Integration test against Supabase (service role).
 * Skips when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSupabaseClient, recordObservation, recomputeClaim, logActivity, createTrigger,
} from '@nous/core';

// Load repo-root .env if present (mirrors apps/api/tests/helpers.mjs).
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(resolve(__dir, '../../../.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { /* use real env */ }

const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  && !process.env.SUPABASE_URL.includes('your-project'));
const maybe = (name, fn) => hasSupabase ? test(name, fn) : test(name, { skip: 'no Supabase creds' }, fn);

const ACCEPT = 'interaction.linkedin_connection_accepted';
const supabase = hasSupabase ? getSupabaseClient() : null;
const teamId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const entityA = crypto.randomUUID();   // claim-path + reverse cases
const entityB = crypto.randomUUID();   // activity-path + idempotency + cross-layer

const channels = (state) => ({ linkedin: { state, connected_at: new Date().toISOString() } });

async function recordChannels(entityId, state, observedAt) {
  await recordObservation(supabase, {
    workspaceId, entityId, kind: 'state', property: 'channels',
    value: channels(state), source: 'test', method: 'api', observedAt,
  });
}

// outbound_events rows for the accept event on one entity.
async function acceptRows(entityId) {
  const { data } = await supabase
    .from('outbound_events')
    .select('id, external_id, event_type, payload')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('event_type', ACCEPT);
  return data ?? [];
}

// The activity path enqueues fire-and-forget — poll until the row lands.
async function waitForAcceptRows(entityId, want, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await acceptRows(entityId);
  while (rows.length < want && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    rows = await acceptRows(entityId);
  }
  return rows;
}

before(async () => {
  if (!hasSupabase) return;
  const team = await supabase.from('teams').insert({ id: teamId, name: `trigger-test-${teamId.slice(0, 8)}` });
  if (team.error) throw new Error(`team insert failed: ${team.error.message}`);
  const ws = await supabase.from('workspaces').insert({ id: workspaceId, team_id: teamId, name: `trigger-test-${workspaceId.slice(0, 8)}` });
  if (ws.error) throw new Error(`workspace insert failed: ${ws.error.message}`);
  const ent = await supabase.from('entities').insert([
    { id: entityA, workspace_id: workspaceId, type: 'person', status: 'active' },
    { id: entityB, workspace_id: workspaceId, type: 'person', status: 'active' },
  ]);
  if (ent.error) throw new Error(`entities insert failed: ${ent.error.message}`);
  await createTrigger(supabase, workspaceId, {
    name: 'test-sink', url: 'https://example.com/hook', events: [ACCEPT],
  });
});

after(async () => {
  if (!hasSupabase) return;
  // Cascade deletes outbound_events, entities, observations, claims, subscription.
  await supabase.from('workspaces').delete().eq('id', workspaceId);
});

// 1 — a non-connected state never fires.
maybe('no fire when channels.linkedin.state is not connected', async () => {
  await recordChannels(entityA, 'not_connected', new Date(Date.now() - 10_000).toISOString());
  await recomputeClaim(supabase, workspaceId, entityA, 'channels');
  assert.equal((await acceptRows(entityA)).length, 0);
});

// 4 — claim-only path: state flips to connected with NO activity logged → fires once.
maybe('claim state-transition into connected fires exactly once', async () => {
  await recordChannels(entityA, 'connected', new Date().toISOString());
  await recomputeClaim(supabase, workspaceId, entityA, 'channels');
  const rows = await acceptRows(entityA);
  assert.equal(rows.length, 1, 'exactly one accept event');
  assert.equal(rows[0].external_id, `li-accept:${entityA}`);
  assert.equal(rows[0].payload?.event_data?.detected_via, 'state_transition');
});

// 5 — reverse transition (connected → not_connected) must NOT fire accepted.
maybe('reverse transition does not fire accepted', async () => {
  await recordChannels(entityA, 'not_connected', new Date(Date.now() + 10_000).toISOString());
  await recomputeClaim(supabase, workspaceId, entityA, 'channels');
  assert.equal((await acceptRows(entityA)).length, 1, 'still just the one earlier fire');
});

// 2 — activity path (real-time / sync both log linkedin_connected) fires.
maybe('linkedin_connected activity fires the accept trigger', async () => {
  await logActivity(supabase, {
    workspaceId, contactId: entityB, type: 'linkedin_connected', source: 'linkedin',
    externalId: `li_conn_${entityB}`, description: 'Connected on LinkedIn',
    rawData: { detected_by: 'invite_poll' },
  });
  const rows = await waitForAcceptRows(entityB, 1);
  assert.equal(rows.length, 1, 'exactly one accept event');
  assert.equal(rows[0].external_id, `li-accept:${entityB}`);
  assert.equal(rows[0].payload?.event_data?.detected_via, 'invite_poll');
});

// 3 — idempotency: re-log + claim path on the same entity stays at one delivery.
maybe('repeat activity and claim path dedup to a single delivery', async () => {
  await logActivity(supabase, {
    workspaceId, contactId: entityB, type: 'linkedin_connected', source: 'linkedin',
    externalId: `li_conn_${entityB}_again`, description: 'Connected on LinkedIn (re-sync)',
    rawData: { detected_by: 'full_sync' },
  });
  await recordChannels(entityB, 'connected', new Date().toISOString());
  await recomputeClaim(supabase, workspaceId, entityB, 'channels');
  const rows = await waitForAcceptRows(entityB, 2, 1500); // give any extra a chance to (not) appear
  assert.equal(rows.length, 1, 'still exactly one delivery after re-fires across both paths');
});
