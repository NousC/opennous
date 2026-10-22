// One-time (GET-969): copy the insights the separate insight read filed into claims about us, so
// the insight engine (GET-971) has history on day one.
//
// From the cutover on, the claim read files claims about us itself. Before it, only insight_items
// held them. This copies the customer ones (source external), filed before --before, that are not
// hidden (HIDDEN_INSIGHT_STATUSES: duplicate, source removed) and that the board did not sort out as "not an insight". Each row
// keeps its insight_items id (legacy_item_id), so a re-run copies nothing twice, and the board's
// first tag becomes `what`, the field the engine groups on. Words from a mailbox, a DM or an unknown
// source stay private. Nothing in insight_items changes.
//
//   node apps/worker/scripts/backfillAboutUsClaims.mjs --before=ISO [--write] [--workspace=UUID]
//
// --before is the moment the claim read started filing claims about us (the deploy). Required:
// an insight filed after it was also read by the claim read, and copying it would count it twice.
//
// Dry run by default: prints what it would copy. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// OPENAI_API_KEY (embeddings).
import { getSupabaseClient, embedBatch, HIDDEN_INSIGHT_STATUSES, normalizeAboutUsKind } from '@nous/core';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const arg = (n) => (argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const BEFORE = arg('before');
const WORKSPACE = arg('workspace');

// The insight read's own labels, read as a kind: its product `kind`, else its category.
const FROM_ITEM_KIND = { bug: 'bug', request: 'feature', improvement: 'friction', praise: 'praise' };
const PRIVATE_SYSTEMS = new Set(['gmail', 'outlook', 'email', 'linkedin', 'slack_dm']);
const FROM_CATEGORY = { product: 'feature', positioning: 'pitch', market: 'partners', buyer: 'buyers' };

/** The claim about us an insight item stands for, or null for one the board sorted out. Pure. */
export function rowFromItem(it, tagName) {
  if (!it.subtype && it.sorted_at) return null;   // sorted as "not an insight" (NOT_AN_INSIGHT)
  const kind = it.subtype ?? FROM_ITEM_KIND[it.kind] ?? FROM_CATEGORY[it.category] ?? null;
  const home = ['market', 'buyer'].includes(it.category) || ['partners', 'buyers'].includes(kind) ? 'market' : 'our_product';
  return {
    workspace_id: it.workspace_id, company_id: it.company_id ?? null, contact_id: it.contact_id ?? null,
    home, kind: normalizeAboutUsKind(kind, home), content: it.statement, quote: it.quote ?? null, speaker: it.speaker ?? null,
    what: tagName ?? null, source_ref: it.source_ref ?? null, source_system: it.source_system ?? null,
    occurred_at: it.occurred_at ?? it.created_at ?? null, origin: 'insight_read', legacy_item_id: it.id,
    quote_private: quoteIsPrivate(it),
  };
}

/** Read out of someone's mailbox or DMs: the words stay private (GET-985). So do the words of an
 *  item with no source on record (filed before the insight read kept one): it may be an email. */
function quoteIsPrivate(it) {
  const system = String(it.source_system ?? '').toLowerCase();
  if (!system) return true;
  if (PRIVATE_SYSTEMS.has(system)) return true;
  // slack://<team>/<channel>/…: a D… channel is a DM, a G… one a group DM.
  return system === 'slack' && /\/slack\/[^/]+\/[DG]/.test(String(it.source_ref ?? ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!BEFORE || Number.isNaN(Date.parse(BEFORE))) { console.error('--before=<ISO time of the deploy> is required'); process.exit(1); }
  const supabase = getSupabaseClient();
  const items = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('insight_items')
      .select('id, workspace_id, category, kind, subtype, sorted_at, tag_ids, statement, quote, speaker, contact_id, company_id, occurred_at, source_ref, source_system, created_at')
      .eq('source', 'external').lt('created_at', BEFORE)
      .not('status', 'in', `(${HIDDEN_INSIGHT_STATUSES.join(',')})`).order('id').range(from, from + 999);
    if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
    const { data, error } = await q;
    if (error) throw error;
    items.push(...data);
    if (data.length < 1000) break;
  }
  const tagIds = [...new Set(items.map(i => i.tag_ids?.[0]).filter(Boolean))];
  const tags = new Map();
  for (let i = 0; i < tagIds.length; i += 200) {
    const { data, error } = await supabase.from('insight_tags').select('id, name').in('id', tagIds.slice(i, i + 200));
    if (error) throw error;
    for (const t of data) tags.set(t.id, t.name);
  }
  const copied = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('about_us_claims').select('legacy_item_id').not('legacy_item_id', 'is', null).order('legacy_item_id').range(from, from + 999);
    if (error) throw error;
    for (const r of data) copied.add(r.legacy_item_id);
    if (data.length < 1000) break;
  }
  const rows = items.filter(i => !copied.has(i.id)).map(i => rowFromItem(i, tags.get(i.tag_ids?.[0]))).filter(Boolean);
  const byKind = rows.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
  console.log(`[BACKFILL_ABOUT_US] ${items.length} insight items before ${BEFORE} · ${copied.size} already copied · ${rows.length} to copy${WRITE ? '' : ' (dry run)'} · ${JSON.stringify(byKind)}`);

  if (WRITE) {
    let written = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const vecs = await embedBatch(batch.map(r => r.content));
      if (!vecs) throw new Error(`embeddings unavailable: stopped after ${written}`);
      const { error } = await supabase.from('about_us_claims')
        .upsert(batch.map((r, j) => ({ ...r, embedding: JSON.stringify(vecs[j]) })), { onConflict: 'legacy_item_id', ignoreDuplicates: true });
      if (error) throw error;
      written += batch.length;
    }
    console.log(`[BACKFILL_ABOUT_US] copied ${written}`);
  }
  process.exit(0);
}
