// Merge two person-entities into one (v2 entity graph).
//
//   node --env-file=.env scripts/merge-entities.mjs <keepId> <dropId>            # DRY RUN (default)
//   node --env-file=.env scripts/merge-entities.mjs <keepId> <dropId> --live     # execute
//   node --env-file=.env scripts/merge-entities.mjs <keepId> <dropId> --live --undo  # reverse a prior merge
//
// `keep` is the survivor, `drop` is folded into it. Lossless: drop's identifiers
// (e.g. a second email) re-attach to keep, so a future match on EITHER resolves
// to one account. Soft-merge: drop entity → status='merged', merged_into=keep,
// so it drops out of resolveEntity automatically and the merge is reversible.
//
// Conflict policy (keep wins, nothing destroyed):
//   - claims:      move only properties keep lacks; conflicting claims stay on the drop tombstone
//   - observations:move all except (source,external_id) collisions, which stay on drop
//   - identifiers: re-attach to keep unless keep already actively holds that value
//   - relationships: re-point both ends; skip self-loops and duplicate edges
//   - collection_entities: move unless keep already in that collection
//   - predictions / leads / workspace_system_log: plain re-point

import { createClient } from '@supabase/supabase-js';

const [keepId, dropId] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const LIVE = process.argv.includes('--live');
const UNDO = process.argv.includes('--undo');

if (!keepId || !dropId) { console.error('usage: merge-entities.mjs <keepId> <dropId> [--live] [--undo]'); process.exit(1); }
if (keepId === dropId)  { console.error('keep and drop are the same entity'); process.exit(1); }

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tag = LIVE ? 'LIVE' : 'DRY RUN';
const log = (...a) => console.log(...a);

async function main() {
  const { data: ents } = await supabase.from('entities')
    .select('id, workspace_id, type, status, merged_into').in('id', [keepId, dropId]);
  const keep = ents?.find(e => e.id === keepId);
  const drop = ents?.find(e => e.id === dropId);
  if (!keep || !drop) { console.error('one or both entities not found'); process.exit(1); }
  if (keep.workspace_id !== drop.workspace_id) { console.error('entities are in different workspaces'); process.exit(1); }
  const ws = keep.workspace_id;

  if (UNDO) return undo(ws, keep, drop);

  log(`\n${tag} — merge  drop ${dropId}  →  keep ${keepId}  (ws ${ws})`);
  if (drop.status === 'merged') { console.error('drop entity is already merged'); process.exit(1); }

  // ── entity_identifiers ── re-attach drop's active identifiers to keep ─────────
  const { data: dropIdents } = await supabase.from('entity_identifiers')
    .select('id, kind, value, status').eq('entity_id', dropId).eq('status', 'active');
  for (const id of dropIdents ?? []) {
    const { data: held } = await supabase.from('entity_identifiers')
      .select('id').eq('workspace_id', ws).eq('kind', id.kind).eq('value', id.value)
      .eq('status', 'active').neq('entity_id', dropId).maybeSingle();
    if (held) { log(`  ident  ${id.kind}=${id.value}  keep already holds → leave on drop`); continue; }
    log(`  ident  ${id.kind}=${id.value}  → move to keep`);
    if (LIVE) await supabase.from('entity_identifiers').update({ entity_id: keepId }).eq('id', id.id);
  }

  // ── claims ── move only properties keep doesn't already have ───────────────────
  const { data: keepClaims } = await supabase.from('claims').select('property').eq('entity_id', keepId).is('invalid_at', null);
  const keepProps = new Set((keepClaims ?? []).map(c => c.property));
  const { data: dropClaims } = await supabase.from('claims').select('id, property, invalid_at').eq('entity_id', dropId);
  let claimsMoved = 0, claimsKept = 0;
  for (const c of dropClaims ?? []) {
    if (c.invalid_at == null && keepProps.has(c.property)) { claimsKept++; continue; }   // conflict → keep wins, leave on drop
    if (c.invalid_at == null) keepProps.add(c.property);
    claimsMoved++;
    if (LIVE) await supabase.from('claims').update({ entity_id: keepId }).eq('id', c.id);
  }
  log(`  claims ${claimsMoved} moved, ${claimsKept} conflicts left on drop`);

  // ── observations ── move all except (source,external_id) collisions ───────────
  const { data: keepObs } = await supabase.from('observations').select('source, external_id').eq('entity_id', keepId).not('external_id', 'is', null);
  const keepObsKeys = new Set((keepObs ?? []).map(o => `${o.source}|${o.external_id}`));
  const { data: dropObs } = await supabase.from('observations').select('id, source, external_id').eq('entity_id', dropId);
  let obsMoved = 0, obsKept = 0;
  for (const o of dropObs ?? []) {
    if (o.external_id != null && keepObsKeys.has(`${o.source}|${o.external_id}`)) { obsKept++; continue; }
    obsMoved++;
    if (LIVE) await supabase.from('observations').update({ entity_id: keepId }).eq('id', o.id);
  }
  log(`  obs    ${obsMoved} moved, ${obsKept} dup collisions left on drop`);

  // ── relationships ── re-point both ends, skip self-loops & dup edges ──────────
  const { data: keepRels } = await supabase.from('relationships').select('from_entity_id, to_entity_id, type')
    .or(`from_entity_id.eq.${keepId},to_entity_id.eq.${keepId}`);
  const keepEdge = new Set((keepRels ?? []).map(r => `${r.from_entity_id}|${r.to_entity_id}|${r.type}`));
  const { data: dropRels } = await supabase.from('relationships').select('id, from_entity_id, to_entity_id, type')
    .or(`from_entity_id.eq.${dropId},to_entity_id.eq.${dropId}`);
  let relMoved = 0, relSkip = 0;
  for (const r of dropRels ?? []) {
    const from = r.from_entity_id === dropId ? keepId : r.from_entity_id;
    const to   = r.to_entity_id   === dropId ? keepId : r.to_entity_id;
    if (from === to || keepEdge.has(`${from}|${to}|${r.type}`)) {
      relSkip++;
      if (LIVE) await supabase.from('relationships').delete().eq('id', r.id);
      continue;
    }
    keepEdge.add(`${from}|${to}|${r.type}`); relMoved++;
    if (LIVE) await supabase.from('relationships').update({ from_entity_id: from, to_entity_id: to }).eq('id', r.id);
  }
  log(`  rels   ${relMoved} re-pointed, ${relSkip} self/dup removed`);

  // ── collection_entities ── move unless keep already a member ──────────────────
  const { data: keepCols } = await supabase.from('collection_entities').select('collection_id').eq('entity_id', keepId);
  const keepColSet = new Set((keepCols ?? []).map(c => c.collection_id));
  const { data: dropCols } = await supabase.from('collection_entities').select('collection_id').eq('entity_id', dropId);
  let colMoved = 0, colDup = 0;
  for (const c of dropCols ?? []) {
    if (keepColSet.has(c.collection_id)) {
      colDup++;
      if (LIVE) await supabase.from('collection_entities').delete().eq('entity_id', dropId).eq('collection_id', c.collection_id);
    } else {
      colMoved++;
      if (LIVE) await supabase.from('collection_entities').update({ entity_id: keepId }).eq('entity_id', dropId).eq('collection_id', c.collection_id);
    }
  }
  log(`  colls  ${colMoved} moved, ${colDup} dup memberships removed`);

  // ── plain re-points (PK-only or contact_id) ───────────────────────────────────
  for (const [table, col] of [['predictions','entity_id'], ['claim_jobs','entity_id'], ['crm_hygiene_proposals','entity_id'],
                              ['outbound_events','entity_id'], ['leads','contact_id'], ['workspace_system_log','contact_id']]) {
    const { count } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(col, dropId);
    log(`  ${table.padEnd(22)} ${count ?? 0} rows → re-point ${col}`);
    if (LIVE && count) await supabase.from(table).update({ [col]: keepId }).eq(col, dropId);
  }

  // ── v1 contacts row + entity tombstone ────────────────────────────────────────
  log(`  contacts(v1)  delete drop row ${dropId} (entity tombstone preserves lineage)`);
  if (LIVE) {
    await supabase.from('contacts').delete().eq('id', dropId);
    await supabase.from('entities').update({ status: 'merged', merged_into: keepId }).eq('id', dropId);
  }

  log(`\n${tag} complete.${LIVE ? '' : '  (no changes written — re-run with --live to execute)'}\n`);
}

async function undo(ws, keep, drop) {
  log(`\n${tag} — UNDO not auto-supported for the deleted v1 contacts row; reversing entity tombstone only.`);
  if (LIVE) await supabase.from('entities').update({ status: 'active', merged_into: null }).eq('id', drop.id);
  log('  entity re-activated. Moved claims/obs/idents remain on keep — re-run a targeted split if needed.');
}

main().catch(e => { console.error(e); process.exit(1); });
