// One-time (GET-1049): give every competitor and tech_stack claim already on file its market entity,
// so the insight engine and the battlecards file count "Hubspot", "HubSpot's" and "Hub Spot" once.
//
// New claims resolve on write (saveNote with resolveMarketEntity). This reads one workspace's live
// competitor / tech_stack claims that have no metadata.market_entity_id yet and groups their names
// with the same matcher (packages/core/src/db/marketEntities.ts). The most-said spelling of a group
// becomes its canonical name. A dry run (the default) prints the groups it would make and the pairs
// it would leave for a decision ('ask': created as their own entity with a pending proposal). With
// --write it resolves each claim (creating entities, aliases, counts) and stamps market_entity_id
// into the claim's metadata; nothing else on a claim changes. A re-run skips claims already stamped.
//
//   node apps/worker/scripts/backfillMarketEntities.mjs --workspace=UUID [--dry-run] [--write]
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and the migration
// supabase/migrations/2026_10_27_market_entities.sql applied (for --write).
import { getSupabaseClient, decideEntity, normalizeEntityName, marketEntityFieldFor, resolveMarketEntity } from '@nous/core';

const CATEGORIES = ['competitor', 'tech_stack'];

/**
 * The groups a set of claims makes, per kind, without touching the database. Pure.
 * claims: [{ id, category, name }]. Spellings are taken most-said first (ties: alphabetical), so a
 * group's canonical name is its most common spelling, as the write pass will create it.
 * -> { [kind]: { groups: [{ canonical, variants: [{ name, count }], claims }], asks: [{ name, of, score, reason }] } }
 */
export function planGroups(claims) {
  const out = {};
  const byKind = new Map();
  for (const c of claims) {
    const f = marketEntityFieldFor(c.category);
    const key = normalizeEntityName(c.name);
    if (!f || !key) continue;
    if (!byKind.has(f.kind)) byKind.set(f.kind, new Map());
    const spellings = byKind.get(f.kind);
    const name = String(c.name).trim().replace(/\s+/g, ' ');
    spellings.set(name, (spellings.get(name) ?? 0) + 1);
  }
  for (const [kind, spellings] of byKind) {
    const order = [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const groups = [];
    const asks = [];
    for (const [name, count] of order) {
      const d = decideEntity(name, groups.map((g, i) => ({ id: String(i), name: g.canonical, aliases: g.variants.map(v => v.name) })));
      if (d.action === 'same') {
        const g = groups[Number(d.entityId)];
        g.variants.push({ name, count }); g.claims += count;
        continue;
      }
      if (d.action === 'ask') asks.push({ name, of: groups[Number(d.entityId)].canonical, score: d.score, reason: d.reason });
      groups.push({ canonical: name, variants: [{ name, count }], claims: count });
    }
    groups.sort((a, b) => b.claims - a.claims || a.canonical.localeCompare(b.canonical));
    out[kind] = { groups, asks };
  }
  return out;
}

/** The plan as lines to print. Pure. */
export function renderPlan(plan) {
  const lines = [];
  for (const [kind, { groups, asks }] of Object.entries(plan)) {
    const merged = groups.filter(g => g.variants.length > 1);
    lines.push(`\n${kind}: ${groups.length} entities from ${groups.reduce((n, g) => n + g.claims, 0)} claims; ${merged.length} with more than one spelling`);
    for (const g of merged) lines.push(`  ${g.canonical} (${g.claims}) ← ${g.variants.map(v => `${v.name} ×${v.count}`).join(', ')}`);
    if (asks.length) lines.push(`  to decide (kept apart for now, proposal recorded):`);
    for (const a of asks) lines.push(`    ${a.name} ~ ${a.of} (${a.reason}, ${a.score})`);
  }
  return lines;
}

async function loadClaims(supabase, ws) {
  const out = [];
  for (const category of CATEGORIES) {
    const field = marketEntityFieldFor(category).field;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('claims').select('id, value, valid_from')
        .eq('workspace_id', ws).like('property', 'note.%').is('invalid_at', null).eq('value->>category', category)
        .order('id').range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) {
        const meta = r.value?.metadata ?? {};
        if (meta.market_entity_id || typeof meta[field] !== 'string' || !meta[field].trim()) continue;
        out.push({ id: r.id, category, name: meta[field], value: r.value, at: r.valid_from });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n) => (argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
  const WS = arg('workspace');
  const WRITE = argv.includes('--write') && !argv.includes('--dry-run');
  if (!WS) { console.error('--workspace=<uuid> is required'); process.exit(1); }
  const supabase = getSupabaseClient();
  const claims = await loadClaims(supabase, WS);
  const plan = planGroups(claims);
  console.log(`${claims.length} competitor / tech_stack claims without a market entity in ${WS}`);
  for (const l of renderPlan(plan)) console.log(l);
  if (!WRITE) { console.log('\nDry run: nothing written. Pass --write to apply.'); process.exit(0); }

  // Most-said spelling first, so it is the one each entity is created with.
  const freq = new Map();
  for (const c of claims) freq.set(c.name.trim(), (freq.get(c.name.trim()) ?? 0) + 1);
  claims.sort((a, b) => freq.get(b.name.trim()) - freq.get(a.name.trim()) || String(a.at).localeCompare(String(b.at)));
  let stamped = 0;
  for (const c of claims) {
    const r = await resolveMarketEntity(supabase, WS, marketEntityFieldFor(c.category).kind, c.name, { seenAt: c.at ?? undefined });
    if (!r) continue;
    const value = { ...c.value, metadata: { ...(c.value.metadata ?? {}), market_entity_id: r.entityId } };
    const { error } = await supabase.from('claims').update({ value }).eq('workspace_id', WS).eq('id', c.id);
    if (error) throw error;
    stamped++;
  }
  console.log(`\nStamped ${stamped} claims.`);
}
