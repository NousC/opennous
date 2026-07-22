// Entity dedup sweep — collapse duplicate PERSON entities in a workspace.
//
// The identity resolution now PREVENTS new duplicates (resolveEntity + the contacts
// fallback + resolvePersonByNameFallback), but historical dupes remain — the same
// person under two entity ids (we saw it on Jack, and each Georgi appears twice).
// This sweeps them.
//
// CONSERVATIVE BY DESIGN:
//   - AUTO-MERGES only entities that share a HARD identifier (same email or LinkedIn
//     URL). That is unambiguous — one person, two records — so it's safe to collapse.
//   - REPORTS name-only matches (same full name, no shared identifier) for review, and
//     never merges them: two real people can share a name. A human/LinkedIn confirms.
//
// Merges are lossless + reversible (mergeEntities soft-merges: drop → status=merged,
// merged_into=keep). SAFE BY DEFAULT: dry-run. Pass --apply to commit.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/dedupEntities.mjs --workspace <uuid>
//   docker compose exec -T worker node apps/worker/src/dedupEntities.mjs --workspace <uuid> --apply

import './bootEnv.mjs';
import { getSupabaseClient, mergeEntities } from '@nous/core';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workspaceId = arg('--workspace', process.env.WS_ID);
  if (!workspaceId) { console.error('pass --workspace <uuid>'); process.exit(1); }
  const supabase = getSupabaseClient();

  // Active person entities in the workspace.
  const { data: ents, error } = await supabase
    .from('entities').select('id, created_at')
    .eq('workspace_id', workspaceId).eq('type', 'person').eq('status', 'active');
  if (error) { console.error('list entities failed:', error.message); process.exit(1); }
  const ids = (ents || []).map(e => e.id);
  if (!ids.length) { console.log('no person entities'); return; }

  // Their active identifiers → group entities that share a (kind, value).
  const idents = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('entity_identifiers')
      .select('entity_id, kind, value')
      .eq('workspace_id', workspaceId).eq('status', 'active')
      .in('entity_id', ids.slice(i, i + 200));
    idents.push(...(data || []));
  }
  const byKey = new Map();
  for (const r of idents) {
    const k = `${r.kind}|${String(r.value).toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(r.entity_id);
  }

  // Union-find: entities sharing ANY identifier collapse into one group (transitive).
  const parent = new Map(ids.map(id => [id, id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const set of byKey.values()) { const a = [...set]; for (let i = 1; i < a.length; i++) union(a[0], a[i]); }
  const groups = new Map();
  for (const id of ids) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);

  // Names/context for display + name-only detection.
  const contacts = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('contacts')
      .select('id, first_name, last_name, company, email').in('id', ids.slice(i, i + 200));
    contacts.push(...(data || []));
  }
  const cById = new Map(contacts.map(c => [c.id, c]));
  const nm = (id) => { const c = cById.get(id); return c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || id) : id; };

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${ids.length} people, ${dupGroups.length} shared-identifier dup group(s)\n`);

  let merged = 0;
  for (const g of dupGroups) {
    // Survivor = the record with the most history (observations); tie → keep all, pick first.
    const counts = {};
    for (const id of g) {
      const { count } = await supabase.from('observations').select('id', { count: 'exact', head: true }).eq('entity_id', id);
      counts[id] = count || 0;
    }
    const survivor = g.slice().sort((a, b) => counts[b] - counts[a])[0];
    const drops = g.filter(id => id !== survivor);
    console.log(`GROUP: keep ${nm(survivor)} [${survivor}] (${counts[survivor]} obs)`);
    for (const d of drops) {
      console.log(`   ${apply ? 'merging' : 'would merge'} ${nm(d)} [${d}] (${counts[d]} obs)`);
      if (apply) {
        try { await mergeEntities(supabase, workspaceId, survivor, d); merged++; }
        catch (e) { console.log(`     ! ${e.message}`); }
      } else merged++;
    }
  }

  // Name-only candidates (same full name, NOT already merged by a shared id) — REPORT ONLY.
  const inGroup = new Set(dupGroups.flat());
  const byName = new Map();
  for (const id of ids) {
    if (inGroup.has(id)) continue;
    const c = cById.get(id);
    const n = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim().toLowerCase();
    if (n.length < 3) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(id);
  }
  const nameCands = [...byName.entries()].filter(([, v]) => v.length > 1);
  if (nameCands.length) {
    console.log(`\nNAME-ONLY candidates (review — NOT auto-merged; two people can share a name):`);
    for (const [n, v] of nameCands) {
      console.log(`   "${n}" × ${v.length}:`);
      for (const id of v) { const c = cById.get(id); console.log(`       [${id}] ${c?.company || c?.email || 'no detail'}`); }
    }
  }

  console.log(`\n${apply ? 'DONE' : 'DRY-RUN COMPLETE'} — ${apply ? 'merged' : 'would merge'} ${merged}, ${nameCands.length} name-only group(s) to review`);
  if (!apply) console.log('Re-run with --apply to merge the shared-identifier groups.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
