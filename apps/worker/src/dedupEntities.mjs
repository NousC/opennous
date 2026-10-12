// Entity dedup sweep — collapse duplicate PERSON entities in a workspace.
//
// The identity resolution now PREVENTS new duplicates (resolveEntity + the contacts
// fallback + resolvePersonByNameFallback), but historical dupes remain — the same
// person under two entity ids (seen in practice, sometimes twice for one name).
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
import { getSupabaseClient, mergeEntities, isFreeEmailDomain } from '@nous/core';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workspaceId = arg('--workspace', process.env.WS_ID);
  if (!workspaceId) { console.error('pass --workspace <uuid>'); process.exit(1); }
  const supabase = getSupabaseClient();

  // Active person entities in the workspace. PostgREST caps a response at 1000 rows
  // regardless of .limit(), so page through — a large workspace has far more, and the
  // duplicates we're hunting are often past the first page.
  const PAGE = 1000;
  const ids = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await supabase
      .from('entities').select('id')
      .eq('workspace_id', workspaceId).eq('type', 'person').eq('status', 'active')
      .range(from, from + PAGE - 1);
    if (error) { console.error('list entities failed:', error.message); process.exit(1); }
    if (!data?.length) break;
    ids.push(...data.map(e => e.id));
    if (data.length < PAGE) break;
  }
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

  // Some entities carry their name as first_name/last_name CLAIMS (LinkedIn-scraped)
  // with no contacts row — contacts alone misses them. Pull claim-names too and merge.
  const claimName = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId).in('property', ['first_name', 'last_name']).is('invalid_at', null)
      .in('entity_id', ids.slice(i, i + 200));
    for (const c of (data || [])) {
      const m = claimName.get(c.entity_id) || {};
      if (c.property === 'first_name') m.first = String(c.value ?? '');
      else m.last = String(c.value ?? '');
      claimName.set(c.entity_id, m);
    }
  }
  const nameOf = (id) => {
    const c = cById.get(id);
    if (c && (c.first_name || c.last_name)) return [c.first_name, c.last_name].filter(Boolean).join(' ');
    const m = claimName.get(id);
    if (m && (m.first || m.last)) return [m.first, m.last].filter(Boolean).join(' ');
    return '';
  };
  const nm = (id) => nameOf(id) || id;

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
    const n = nameOf(id).trim().toLowerCase();
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

  // ── COMPANY dedup ───────────────────────────────────────────────────────────
  // Companies fork when one is created by NAME with no domain while the same
  // company also exists domain-keyed (the "Brightwell" vs "Brightwell.io" split — same
  // brightwell.example people, two company records). Two safe rules:
  //   (a) companies sharing a domain identifier → merge.
  //   (b) a name-only company (no domain) → fold into the domain-keyed company
  //       that its OWN people's unique work-email domain points at.
  const cIds = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data } = await supabase.from('entities').select('id')
      .eq('workspace_id', workspaceId).eq('type', 'company').eq('status', 'active')
      .range(from, from + PAGE - 1);
    if (!data?.length) break;
    cIds.push(...data.map(e => e.id));
    if (data.length < PAGE) break;
  }
  const domainByCompany = new Map();
  const companiesByDomain = new Map();
  const cNameById = new Map();
  for (let i = 0; i < cIds.length; i += 200) {
    const slice = cIds.slice(i, i + 200);
    const [{ data: doms }, { data: names }] = await Promise.all([
      supabase.from('entity_identifiers').select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('kind', 'domain').eq('status', 'active').in('entity_id', slice),
      supabase.from('claims').select('entity_id, value')
        .eq('workspace_id', workspaceId).in('property', ['name', 'company_name']).is('invalid_at', null).in('entity_id', slice),
    ]);
    for (const r of (doms || [])) {
      const dom = String(r.value).toLowerCase();
      domainByCompany.set(r.entity_id, dom);
      if (!companiesByDomain.has(dom)) companiesByDomain.set(dom, []);
      companiesByDomain.get(dom).push(r.entity_id);
    }
    for (const r of (names || [])) if (!cNameById.has(r.entity_id)) cNameById.set(r.entity_id, String(r.value ?? ''));
  }
  const cObs = async (id) => (await supabase.from('observations').select('id', { count: 'exact', head: true }).eq('entity_id', id)).count || 0;
  const cnm = (id) => cNameById.get(id) || id;

  const companyPairs = []; // [keep, drop, reason]
  // (a) same-domain companies
  for (const [, list] of companiesByDomain) {
    if (list.length < 2) continue;
    const counts = {};
    for (const id of list) counts[id] = await cObs(id);
    const keep = list.slice().sort((a, b) => counts[b] - counts[a])[0];
    for (const d of list) if (d !== keep) companyPairs.push([keep, d, 'same-domain']);
  }
  // (b) name-only company → domain company via its people's work-email domain
  const nameOnly = cIds.filter(id => !domainByCompany.has(id));
  if (nameOnly.length) {
    const { data: edges } = await supabase.from('relationships')
      .select('from_entity_id, to_entity_id').eq('workspace_id', workspaceId).eq('type', 'works_at')
      .in('to_entity_id', nameOnly);
    const peopleByCompany = new Map();
    for (const e of (edges || [])) {
      if (!peopleByCompany.has(e.to_entity_id)) peopleByCompany.set(e.to_entity_id, []);
      peopleByCompany.get(e.to_entity_id).push(e.from_entity_id);
    }
    for (const [companyId, people] of peopleByCompany) {
      const { data: emails } = await supabase.from('entity_identifiers')
        .select('value').eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active')
        .in('entity_id', people);
      const domains = new Set();
      for (const r of (emails || [])) {
        const at = String(r.value).lastIndexOf('@');
        if (at > -1) { const d = r.value.slice(at + 1).toLowerCase(); if (!isFreeEmailDomain(d)) domains.add(d); }
      }
      const targets = [...new Set([...domains].filter(d => companiesByDomain.has(d)).flatMap(d => companiesByDomain.get(d)))];
      if (targets.length === 1 && targets[0] !== companyId) companyPairs.push([targets[0], companyId, 'name-only→domain']);
    }
  }

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${cIds.length} companies, ${companyPairs.length} company merge(s)`);
  let cMerged = 0;
  for (const [keep, drop, reason] of companyPairs) {
    console.log(`   ${apply ? 'merging' : 'would merge'} company "${cnm(drop)}" [${drop}] → "${cnm(keep)}" [${keep}]  (${reason})`);
    if (apply) { try { await mergeEntities(supabase, workspaceId, keep, drop); cMerged++; } catch (e) { console.log(`     ! ${e.message}`); } }
    else cMerged++;
  }

  console.log(`\n${apply ? 'DONE' : 'DRY-RUN COMPLETE'} — persons: ${apply ? 'merged' : 'would merge'} ${merged} (${nameCands.length} name-only to review); companies: ${apply ? 'merged' : 'would merge'} ${cMerged}`);
  if (!apply) console.log('Re-run with --apply to merge the shared-identifier + company groups.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
