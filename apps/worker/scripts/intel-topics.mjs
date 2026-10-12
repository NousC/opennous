#!/usr/bin/env node
// Group a workspace's intel into topics, for every account and person with enough facts to need it.
//
// The page builds a record's topics on its own the first time someone opens it (in the background;
// the chips show until then). This script does the same for a whole workspace up front, so the
// Intel tab is already grouped when people look. One Haiku read per record; a record whose facts
// have not changed since its last build costs nothing. See packages/core/src/db/intelTopics.ts.
//
// Run (in the worker container):
//   docker compose exec worker node apps/worker/scripts/intel-topics.mjs --workspace <uuid>
//   docker compose exec worker node apps/worker/scripts/intel-topics.mjs --workspace <uuid> --entity <id> --force
//   … --limit 20      only the 20 records with the most facts
//
// Apply supabase/migrations/2026_09_27_intel_topics.sql first.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const envPath = val('env') || '.env';
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* env may already be in the process (worker host) */ }

const workspaceId = val('workspace');
if (!workspaceId) {
  console.error('Usage: node apps/worker/scripts/intel-topics.mjs --workspace <uuid> [--entity <id>] [--force] [--limit N]');
  process.exit(1);
}

const {
  getSupabaseClient, listNotes, listAccountNotes, refreshIntelTopics, insightBoardModel, INTEL_TOPICS_MIN_FACTS,
} = await import('@nous/core');
const { read, acceptsObject } = await import('../src/noema/read.mjs');

const supabase = getSupabaseClient();
const force = flag('force');
const PAGE = 1000;

const ask = async (prompt) => {
  const res = await read({
    supabase, workspaceId, feature: 'intel-topics', meterAs: 'intel-topics', model: insightBoardModel(),
    accept: acceptsObject, parse: (t) => t, maxTokens: 8000, prompt,
  });
  return res.ok ? res.value : null;
};

// How many live facts each entity holds — to skip the records too small to group.
const counts = new Map();
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from('claims').select('entity_id')
    .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
    .is('value->metadata->>doc_type', null).order('id').range(from, from + PAGE - 1);
  if (error) throw error;
  for (const r of data) counts.set(r.entity_id, (counts.get(r.entity_id) ?? 0) + 1);
  if (data.length < PAGE) break;
}

const contactsOf = new Map();  // company id -> contact ids
const people = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from('contacts').select('id, company_id')
    .eq('workspace_id', workspaceId).order('id').range(from, from + PAGE - 1);
  if (error) throw error;
  for (const c of data) {
    people.push(c.id);
    if (c.company_id) { if (!contactsOf.has(c.company_id)) contactsOf.set(c.company_id, []); contactsOf.get(c.company_id).push(c.id); }
  }
  if (data.length < PAGE) break;
}

let jobs = [];
for (const [companyId, ids] of contactsOf) {
  const n = (counts.get(companyId) ?? 0) + ids.reduce((s, id) => s + (counts.get(id) ?? 0), 0);
  if (n >= INTEL_TOPICS_MIN_FACTS) jobs.push({ id: companyId, n, load: () => listAccountNotes(supabase, workspaceId, companyId, ids) });
}
for (const id of people) {
  const n = counts.get(id) ?? 0;
  if (n >= INTEL_TOPICS_MIN_FACTS) jobs.push({ id, n, load: () => listNotes(supabase, workspaceId, { entityId: id, limit: 200 }) });
}
if (val('entity')) jobs = jobs.filter(j => j.id === val('entity'));
jobs.sort((a, b) => b.n - a.n);
if (val('limit')) jobs = jobs.slice(0, Number(val('limit')));
console.log(`[INTEL_TOPICS] ${jobs.length} records to check`);

const tally = { built: 0, fresh: 0, small: 0, failed: 0 };
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    try {
      const r = await refreshIntelTopics(supabase, workspaceId, j.id, await j.load(), ask, { model: insightBoardModel(), force });
      tally[r]++;
      if (r !== 'fresh') console.log(`[INTEL_TOPICS] ${j.id} (${j.n} facts) ${r}`);
    } catch (err) {
      tally.failed++;
      console.warn(`[INTEL_TOPICS] ${j.id} failed: ${err.message}`);
    }
  }
}));
console.log('[INTEL_TOPICS] done', tally);
process.exit(tally.failed ? 1 : 0);
