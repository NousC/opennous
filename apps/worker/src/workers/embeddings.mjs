// Embedding worker — fills claim AND observation embeddings so semantic
// search works. Sweeps rows that have no embedding yet, embeds them in
// batches via OpenAI, writes the vectors back. The backfilled rows and
// every new row get embedded within a couple of minutes. No OPENAI_API_KEY
// = no-op (semantic search stays dark; structured retrieval is unaffected).
//
// Observations are append-only, but their `embedding` index column is
// exempt from the immutability guard — see reject_mutation() in the schema.

import { getSupabaseClient, embedBatch, logWorkerRun } from '@nous/core';

const BATCH = 96;

function rowText(r) {
  const v = r.value;
  // Notes & documents (asserted `note.*` claims) embed their HUMAN content, not
  // the JSON envelope — and documents (briefs / transcripts / meeting notes) get
  // a larger budget so semantic search can actually find what's inside them.
  if (typeof r.property === 'string' && r.property.startsWith('note.') && v && typeof v === 'object') {
    const meta = v.metadata || {};
    const head = meta.title || v.category || 'note';
    const cap = meta.doc_type ? 8000 : 2000;
    return `${head}\n${v.content ?? ''}`.slice(0, cap);
  }
  let s = v;
  if (s && typeof s === 'object') s = JSON.stringify(s);
  return `${r.property}: ${s ?? ''}`.slice(0, 2000);
}

async function sweep(supabase, table) {
  // Pull the candidate batch first — keep the join cheap.
  let query = supabase
    .from(table)
    .select('id, property, value, entity_id')
    .is('embedding', null);

  // Observations: ONLY embed rows that carry searchable meaning — notes (note.*)
  // and real interactions (interaction.*). Identity fields (first_name, photo_url),
  // derived pipeline stage, channels, and lead-list field imports are structured
  // data, not semantic signal. Embedding them buried real engagement under ~90%
  // noise in the vector index, so "who should I focus on" ranked cold lead-list
  // rows above replies and meetings. Claims are left as-is (the facts corpus
  // filters to note.* at query time). See 2026_07_09_semantic_signal_ranking.sql.
  if (table === 'observations') {
    query = query.or('property.like.note.*,property.like.interaction.*');
  }

  const { data: rows, error } = await query.limit(BATCH);

  if (error?.code === '42P01' || error?.code === 'PGRST205') return 0;
  if (error) throw error;
  if (!rows?.length) return 0;

  // Skip rows whose entity is archived — Phase 5 introduced `archived` status
  // for retired cold prospects so we stop paying the embedding cost on them.
  const entityIds = [...new Set(rows.map(r => r.entity_id))];
  const { data: ents } = await supabase
    .from('entities')
    .select('id, status')
    .in('id', entityIds);
  const archived = new Set((ents ?? []).filter(e => e.status === 'archived').map(e => e.id));
  if (archived.size) {
    rows.splice(0, rows.length, ...rows.filter(r => !archived.has(r.entity_id)));
    if (!rows.length) return 0;
  }

  const vectors = await embedBatch(rows.map(rowText));
  if (!vectors) return 0;   // no OPENAI_API_KEY, or the call failed — retry next sweep

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    const { error: upErr } = await supabase
      .from(table)
      .update({ embedding: JSON.stringify(vec) })
      .eq('id', rows[i].id);
    if (!upErr) embedded++;
  }
  return embedded;
}

export async function processEmbeddings() {
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  try {
    const claims = await sweep(supabase, 'claims');
    const observations = await sweep(supabase, 'observations');
    if (claims || observations) {
      console.log(`[EMBEDDINGS] embedded ${claims} claims, ${observations} observations`);
      await logWorkerRun(supabase, {
        worker: 'embeddings',
        status: 'success',
        summary: `embedded ${claims} claim(s), ${observations} observation(s)`,
        details: { claims, observations },
        startedAt,
      });
    }
  } catch (err) {
    console.error('[EMBEDDINGS] sweep error:', err.message);
    await logWorkerRun(supabase, {
      worker: 'embeddings',
      status: 'error',
      summary: 'sweep failed',
      error: err.message,
      startedAt,
    });
  }
}
