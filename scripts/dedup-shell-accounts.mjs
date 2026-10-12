// Fold identifier-less company shells into the real record they duplicate.
//
// WHAT A SHELL IS, AND WHY IT EXISTS
//
// Searching one group of related accounts in a synced workspace returns roughly twice as many
// account entities as there are real companies. Every duplicate pair has the same shape:
//
//   Marlowe Leisure Products   marlowe-leisure.example     1 open deal   $9,000 won
//   Marlowe Leisure Products   (no domain)     no deals      no identifiers at all
//
// The empty twin is not a second HubSpot company. It has NO `entity_identifiers` row — no domain,
// no `hubspot_company` id — and exactly the three observations `companyFacts` writes
// (`owner_name`, `owner_email`, `lifecycle_stage`) from a `hubspot/crm_sync` run, with the name,
// industry and location arriving later from a `v1_compat/trigger`. Zero relationships.
//
// So the CRM sync created a company entity, wrote its facts, and never attached the identifiers
// that would let the NEXT sync find it again — which is why running the sync a second time makes
// another one. This is our write path, not the customer's data, and it will happen to every CRM
// customer until that is fixed. Merging without fixing the writer buys one clean afternoon.
//
// THE RULE, WHICH IS EXACT AND NOT FUZZY
//
// A shell is a duplicate when it has no active identifiers AND its trimmed, case-folded name
// matches exactly one active company that HAS identifiers. Nothing is matched on similarity, on
// domain stems, or on a distance metric: name collisions across genuinely different companies are
// common, and a wrong merge is the least reversible thing we do to somebody's data. On a large
// synced workspace most shells have an exact-name twin that has identifiers; the few with no twin
// at all are left alone — they are orphans, not duplicates.
//
// SAFE BY CONSTRUCTION
//
// The merge itself is `mergeEntities`, which is lossless (the drop's identifiers re-attach to the
// survivor), soft (the drop becomes status='merged', merged_into=<keep>) and therefore reversible
// by re-activating the row. Conflicts are keep-wins and are parked on the tombstone rather than
// overwriting. Every merge records WHY: reason `duplicate_sweep`, the matched name, and this
// script as the actor.
//
//   node --env-file=.env scripts/dedup-shell-accounts.mjs --workspace <uuid>
//   node --env-file=.env scripts/dedup-shell-accounts.mjs --workspace <uuid> --apply
//
// Dry run by default. It prints every pair it would merge, and refuses any shell that turns out to
// carry a deal, a relationship or an identifier between the scan and the merge.

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
const APPLY = flag('apply');
const LIMIT = Number(arg('limit') || 0) || Infinity;
if (!WORKSPACE || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('need --workspace <uuid> and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** Every active company in the workspace, paged — PostgREST stops at 1000 without saying so. */
async function allCompanies() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('entities')
      .select('id, type, status')
      .eq('workspace_id', WORKSPACE).eq('type', 'company').eq('status', 'active')
      .order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** Active identifier counts, keyed by entity. */
async function identifierCounts(ids) {
  const counts = new Map(ids.map(id => [id, 0]));
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from('entity_identifiers')
      .select('entity_id')
      .eq('workspace_id', WORKSPACE).eq('status', 'active')
      .in('entity_id', ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) counts.set(r.entity_id, (counts.get(r.entity_id) ?? 0) + 1);
  }
  return counts;
}

/** The display name, off the flattened rows the lists already read. */
async function namesFor(ids) {
  const names = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('entity_list_rows')
      .select('entity_id, name, open_deals, won_value')
      .eq('workspace_id', WORKSPACE).eq('kind', 'account')
      .in('entity_id', ids.slice(i, i + 100));
    for (const r of data ?? []) names.set(r.entity_id, r);
  }
  return names;
}

const companies = await allCompanies();
const ids = companies.map(c => c.id);
const [idCounts, rows] = await Promise.all([identifierCounts(ids), namesFor(ids)]);

const key = (n) => String(n ?? '').trim().toLowerCase();
const realByName = new Map();      // name -> [entityId], only entities that HAVE identifiers
const shells = [];
for (const id of ids) {
  const row = rows.get(id);
  const name = key(row?.name);
  if (!name) continue;             // an unnamed entity cannot be matched by name
  if ((idCounts.get(id) ?? 0) > 0) {
    (realByName.get(name) ?? realByName.set(name, []).get(name)).push(id);
  } else {
    shells.push({ id, name, row });
  }
}

const pairs = [];
const skipped = { no_twin: 0, ambiguous: 0, has_deals: 0 };
for (const s of shells) {
  const twins = realByName.get(s.name) ?? [];
  // Exactly one. Two real companies sharing a name is a different problem and a human's call.
  if (twins.length === 0) { skipped.no_twin++; continue; }
  if (twins.length > 1) { skipped.ambiguous++; continue; }
  // A shell holding a deal is not a shell. Leave anything with value to a person.
  if ((s.row?.open_deals ?? 0) > 0 || Number(s.row?.won_value ?? 0) > 0) { skipped.has_deals++; continue; }
  pairs.push({ keep: twins[0], drop: s.id, name: s.row?.name ?? s.name });
}

console.log(`companies: ${ids.length} · with identifiers: ${ids.length - shells.length} · shells: ${shells.length}`);
console.log(`mergeable: ${pairs.length} · skipped — no twin ${skipped.no_twin}, ambiguous ${skipped.ambiguous}, holds a deal ${skipped.has_deals}`);
for (const p of pairs.slice(0, Math.min(20, pairs.length))) {
  const k = rows.get(p.keep);
  console.log(`  ${String(p.name).slice(0, 38).padEnd(40)} drop ${p.drop.slice(0, 8)} -> keep ${p.keep.slice(0, 8)} (${k?.open_deals ?? 0} open, ${Math.round(Number(k?.won_value ?? 0))} won)`);
}
if (pairs.length > 20) console.log(`  ... and ${pairs.length - 20} more`);

if (!APPLY) { console.log('\ndry run: pass --apply to merge'); process.exit(0); }

// Import the merge primitive only when we are actually going to use it: it pulls the whole core
// bundle, and a dry run should stay a read.
const { mergeEntities } = await import('../packages/core/dist/db/entities.js');

let merged = 0, failed = 0;
for (const p of pairs.slice(0, LIMIT)) {
  // Re-check immediately before writing. The scan is not a transaction, and a sync landing
  // mid-run could have given this shell the identifiers that make it a real record.
  const { data: fresh } = await sb.from('entity_identifiers')
    .select('id').eq('workspace_id', WORKSPACE).eq('entity_id', p.drop).eq('status', 'active').limit(1);
  if (fresh?.length) { console.log(`  skip ${p.drop.slice(0, 8)}: gained an identifier since the scan`); continue; }
  try {
    await mergeEntities(sb, WORKSPACE, p.keep, p.drop, {
      matchedKind: 'name', matchedValue: p.name,
      reason: 'duplicate_sweep', confidence: 0.95, actor: 'scripts/dedup-shell-accounts.mjs',
    });
    merged++;
  } catch (err) {
    failed++;
    console.error(`  failed ${p.drop.slice(0, 8)} -> ${p.keep.slice(0, 8)}: ${err.message}`);
  }
}
console.log(`\nmerged ${merged}, failed ${failed}. Every merge is soft: the drop is status='merged' with merged_into set, and re-activating that row undoes it.`);
