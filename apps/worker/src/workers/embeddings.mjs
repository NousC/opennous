// Embedding worker — fills claim AND observation embeddings so semantic
// search works. Sweeps rows that have no embedding yet, embeds them in
// batches via OpenAI, writes the vectors back. The backfilled rows and
// every new row get embedded within a couple of minutes. No OPENAI_API_KEY
// = no-op (semantic search stays dark; structured retrieval is unaffected).
//
// Observations are append-only, but their `embedding` index column is
// exempt from the immutability guard — see reject_mutation() in the schema.

import { getSupabaseClient, embedBatch, logWorkerRun, lockIsLive, WORKSPACE_WIDE_JOB } from '@nous/core';

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

  // ONLY embed rows that carry searchable meaning — notes (note.*) and, for observations,
  // real interactions (interaction.*). Identity fields (first_name, photo_url), derived
  // pipeline stage, channels, and lead-list field imports are structured data, not semantic
  // signal. Embedding them buried real engagement under ~90% noise in the vector index, so
  // "who should I focus on" ranked cold lead-list rows above replies and meetings.
  // See 2026_07_09_semantic_signal_ranking.sql.
  //
  // Claims used to be exempt, on the reasoning that "the facts corpus filters to note.* at
  // query time". True, and it cost us: one day the claims queue held well over a hundred thousand
  // rows and NONE of them were note.* — mostly `source`, `owner_email`, `first_name` and
  // `lifecycle_stage`. We were paying OpenAI to compute the meaning of a last name, then storing
  // it in a multi-gigabyte index that search throws away on every call. Filtering at
  // query time does not refund the embedding.
  //
  // BOTH filters depend on the partial indexes in 2026_09_21_embedding_queue_indexes.sql
  // (claims_embed_queue, observations_embed_queue). Without them these predicates are scans,
  // not lookups — the claims filter alone measured tens of seconds where no filter measured well
  // under a millisecond, because proving "nothing matches" means reading every row. If you ever remove those
  // indexes, remove these filters in the same change or the sweep dies on the statement timeout.
  query = table === 'observations'
    ? query.or('property.like.note.*,property.like.interaction.*')
    : query.like('property', 'note.%');

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

// The cron fires every two minutes; a sweep is not guaranteed to finish in two minutes. On
// one busy day a run took close to three minutes and two more started behind it, so three sweeps ground the
// same tables at once and all three died on the statement timeout. A cron is a metronome, not a
// queue — it will happily start work that cannot finish before the next beat. One in-process
// flag is enough here because the worker is a single process; if it is ever sharded, this needs
// to become an advisory lock.
let sweeping = false;

/**
 * Is a workspace-wide backfill holding any workspace right now? The sweep is the one writer
 * that never stops (every two minutes, every workspace), so it is the one that has to yield:
 * a backfill that takes the workspace lock gets the disk to itself, and the queue waits — it
 * was waiting anyway (GET-412).
 */
async function anyWorkspaceLocked(supabase) {
  const { data, error } = await supabase.from('backfill_locks').select('workspace_id, holder, expires_at').eq('job', WORKSPACE_WIDE_JOB);
  if (error) return null;                       // no table yet: nothing to yield to
  const live = (data ?? []).filter(r => lockIsLive(r));
  return live.length ? live : null;
}

export async function processEmbeddings() {
  if (sweeping) {
    console.warn('[EMBEDDINGS] previous sweep still running — skipping this tick');
    return;
  }
  sweeping = true;
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  try {
    const held = await anyWorkspaceLocked(supabase);
    if (held) {
      console.log(`[EMBEDDINGS] yielding — ${held.map(h => h.holder).join(', ')} hold${held.length === 1 ? 's' : ''} a workspace`);
      return;
    }
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
  } finally {
    sweeping = false;
  }
}
