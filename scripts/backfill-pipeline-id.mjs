// One-off backfill: give every already-synced CRM deal its `pipeline_id` observation.
//
// The sync now writes `pipeline_id` next to the `pipeline` display name on every deal it
// touches, but it only refetches deals modified since `last_synced_at`, so a workspace's
// existing deals would wait indefinitely. This script resolves each deal's pipeline from what
// the graph already holds, most reliable first:
//
//   1. the deal's `stage_id` observation → the pipeline that stage belongs to (exact), else
//   2. the deal's `pipeline` name, trimmed → the pipeline with that trimmed name.
//
// It also stamps crm_sync_configs.primary_pipeline_ref from the provider's own marker, the
// same way a fresh sync would.
//
// READ-ONLY against HubSpot (one pipelines call). Writes to Supabase only with --apply;
// without it, prints what it would do. Idempotent: deals that already have a `pipeline_id`
// observation are skipped.
//
//   node scripts/backfill-pipeline-id.mjs --env .env --workspace <uuid> --token-env HUBSPOT_TEST_TOKEN
//   node scripts/backfill-pipeline-id.mjs --env .env --workspace <uuid> --token-env HUBSPOT_SERVICE_KEY --apply
//
// @supabase/supabase-js is only installed under packages/core, so it is required from there.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRequire = createRequire(path.join(here, '..', 'packages', 'core', 'package.json'));
const { createClient } = coreRequire('@supabase/supabase-js');

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes(`--${k}`);

const envPath = arg('env');
if (envPath) {
  for (const line of readFileSync(path.resolve(envPath), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}
const WORKSPACE = arg('workspace');
const TOKEN = process.env[arg('token-env') || 'HUBSPOT_SERVICE_KEY'];
const APPLY = flag('apply');
if (!WORKSPACE || !TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('need --workspace <uuid>, a HubSpot token via --token-env, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── the provider's pipelines: stage id → pipeline id, trimmed name → pipeline id ──
const res = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', { headers: { Authorization: `Bearer ${TOKEN}` } });
if (!res.ok) { console.error('HubSpot pipelines', res.status, (await res.text()).slice(0, 200)); process.exit(1); }
const pipelines = (await res.json()).results ?? [];
const byStageId = new Map(), byName = new Map();
for (const p of pipelines) {
  byName.set(String(p.label ?? '').trim(), String(p.id));
  for (const s of p.stages ?? []) byStageId.set(String(s.id), String(p.id));
}
// Same rule as pickPrimaryPipeline in @nous/core: HubSpot's primary is the literal `default`.
const primaryRef = pipelines.find(p => String(p.id) === 'default')?.id ?? pipelines[0]?.id ?? null;
console.log(`pipelines: ${pipelines.length} · primary: ${primaryRef}`);

// ── every deal's stage_id / pipeline / pipeline_id observations in this workspace ──
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('observations')
    .select('entity_id, property, value, observed_at')
    .eq('workspace_id', WORKSPACE).in('property', ['stage_id', 'pipeline', 'pipeline_id'])
    .order('observed_at', { ascending: true }).order('id', { ascending: true })
    .range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
const deals = new Map();   // entity_id → { stageId, name, has }
for (const r of rows) {
  const d = deals.get(r.entity_id) ?? { stageId: null, name: null, has: false };
  const v = typeof r.value === 'string' ? r.value : (r.value?.value ?? null);
  if (r.property === 'stage_id') d.stageId = v;            // ascending order: last write is current
  else if (r.property === 'pipeline') d.name = v;
  else if (r.property === 'pipeline_id') d.has = true;
  deals.set(r.entity_id, d);
}

const inserts = [];
let viaStage = 0, viaName = 0, unresolved = 0, already = 0;
for (const [entityId, d] of deals) {
  if (d.has) { already++; continue; }
  let id = d.stageId ? byStageId.get(String(d.stageId)) : null;
  if (id) viaStage++;
  else if (d.name && byName.has(String(d.name).trim())) { id = byName.get(String(d.name).trim()); viaName++; }
  if (!id) { unresolved++; continue; }
  inserts.push({
    workspace_id: WORKSPACE, entity_id: entityId, kind: 'state', property: 'pipeline_id', value: id,
    source: 'hubspot', method: 'crm_sync', observed_at: new Date().toISOString(),
    raw: { backfill: 'scripts/backfill-pipeline-id.mjs', resolved_by: d.stageId && byStageId.has(String(d.stageId)) ? 'stage_id' : 'pipeline_name' },
  });
}
console.log(`deals seen: ${deals.size} · already have pipeline_id: ${already} · resolve via stage_id: ${viaStage} · via name: ${viaName} · unresolved: ${unresolved}`);

if (!APPLY) { console.log('dry run: pass --apply to write'); process.exit(0); }

for (let i = 0; i < inserts.length; i += 500) {
  const { error } = await sb.from('observations').insert(inserts.slice(i, i + 500));
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
}
console.log(`wrote ${inserts.length} pipeline_id observations`);

// Recording which pipeline is primary is the second half of the job, and it can fail for two
// very different reasons. `.update()` matching NO row is not an error in PostgREST, so this
// asks for the updated rows back rather than trusting a null error: without `.select()` a
// workspace with no config row read as a clean success and printed a ref it never stored.
let exitCode = 0;
if (primaryRef) {
  const { data: updated, error } = await sb.from('crm_sync_configs')
    .update({ primary_pipeline_ref: String(primaryRef) })
    .eq('workspace_id', WORKSPACE).eq('provider', 'hubspot')
    .select('id');

  if (error) {
    // The column arrives with a hand-applied migration; until then there is nowhere to put it.
    const missingColumn = ['42703', '42P01', 'PGRST204', 'PGRST205'].includes(String(error.code));
    console.error(missingColumn
      ? `\n✖ primary_pipeline_ref NOT recorded: the column does not exist yet.\n  Apply supabase/migrations/2026_09_16_pipeline_identity.sql, then re-run this script.`
      : `\n✖ primary_pipeline_ref NOT recorded: ${error.message}`);
    exitCode = 1;
  } else if (!updated?.length) {
    // The migration is fine; this workspace simply has no crm_sync_configs row, which is the
    // state of a workspace whose CRM was pulled by hand and never connected through the app.
    console.error(`\n✖ primary_pipeline_ref NOT recorded: this workspace has no crm_sync_configs row for hubspot,\n  so there is nothing to write it on. The ${inserts.length} deals above ARE tagged and correct.\n  Connect HubSpot through the app (Integrations page, or POST /v2/workspace/integrations),\n  then re-run this script to record the primary pipeline.`);
    exitCode = 1;
  } else {
    console.log(`crm_sync_configs.primary_pipeline_ref = ${primaryRef}`);
  }
}
// Non-zero when the ref did not land, so a live backfill cannot scroll past it unnoticed.
process.exit(exitCode);
