// /v2/lead-lists — read + create + delete a workspace's lead lists for API-key
// callers (e.g. Partner OS operating an agency's own workspace). verifyApiKey
// populates req.workspaceId.
import { Router } from 'express';
import { getSupabaseClient, listLeadLists, createLeadList, deleteLeadList, selectLeadIdsByFilter, insertLeads } from '@nous/core';
import { scoreIdentifier } from '../../lib/scoreIdentifier.mjs';
import { enrichContact, getApolloEnrichmentKey, getFindymailEnrichmentKey, getProspeoEnrichmentKey } from '../../services/enrichment.mjs';
import { getVerifier, listConnectedVerifiers, verifyLead } from '../../services/verification.mjs';
import { estimateCost } from '../../lib/providerPricing.mjs';

export const leadListsV2Router = Router();

const MAX = 1000, MAX_RUN = 200, STALE = 90 * 86400000;

// leads in URL-safe chunks
async function fetchLeadsByIds(supabase, ws, listId, ids, columns) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('leads').select(columns).eq('workspace_id', ws).eq('lead_list_id', listId).in('id', ids.slice(i, i + 200));
    if (data) out.push(...data);
  }
  return out;
}
// latest run timestamp per entity for a method ('enrichment'|'verification')
async function lastRunByEntity(supabase, ws, method, entityIds) {
  const map = new Map();
  for (let i = 0; i < entityIds.length; i += 200) {
    const { data } = await supabase.from('observations').select('entity_id, observed_at').eq('workspace_id', ws).eq('method', method).in('entity_id', entityIds.slice(i, i + 200)).order('observed_at', { ascending: false });
    for (const o of data || []) if (!map.has(o.entity_id)) map.set(o.entity_id, o.observed_at);
  }
  return map;
}
async function resolveIds(supabase, ws, listId, body) {
  let ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX) : [];
  if (ids.length === 0 && body.filter && typeof body.filter === 'object') ids = await selectLeadIdsByFilter(supabase, ws, listId, body.filter, MAX);
  return ids;
}

// GET /v2/lead-lists — all lists with counts.
leadListsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const lead_lists = await listLeadLists(supabase, req.workspaceId);
    return res.json({ lead_lists });
  } catch (err) {
    console.error('[GET /v2/lead-lists]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/lead-lists — create a list. Body: { name, source? }.
leadListsV2Router.post('/', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const supabase = getSupabaseClient();
    const created = await createLeadList(supabase, req.workspaceId, { name, source: req.body?.source || 'manual' });
    return res.status(201).json({ lead_list: { ...created, lead_count: 0 } });
  } catch (err) {
    console.error('[POST /v2/lead-lists]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/lead-lists/attach — the batch scoring path for a list the user built
// ELSEWHERE (a Google Sheet, a CRM export, a Clay table). In ONE call: create (or
// reuse) a Nous lead list, ingest the rows (resolving/creating each entity via the
// identity waterfall, workspace-deduped), and score every row against the live ICP
// model + intent axis so the judgment lands in the graph for agents to read.
//
// The list stays where the user built it; this just gives Nous the roster so the
// scores can be kept fresh by the scoring cron and read back via score / get_context
// / query. Rows with no scoreable claims yet come back `awaiting_enrichment` — run
// an enrichment pass (signal-scan / a lead-builder) then re-attach or re-score.
//
// Body: { name, source?, rows: [{ email?, linkedin_url?, company?, domain?, name?, fields? }], import_duplicates? }
//   or:  { lead_list_id, rows: [...] }  to add to an existing list.
// Each row needs an email OR a linkedin_url (else it can't be resolved and is dropped).
const ATTACH_MAX = 200;
leadListsV2Router.post('/attach', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { name, source, rows, import_duplicates } = req.body || {};
    let listId = req.body?.lead_list_id || null;

    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows_required' });
    if (rows.length > ATTACH_MAX) return res.status(400).json({ error: 'batch_too_large', max: ATTACH_MAX });

    // Reuse an existing list, or create one. Default source marks it as externally-owned.
    if (!listId) {
      const listName = (name || '').trim();
      if (!listName) return res.status(400).json({ error: 'name_or_lead_list_id_required' });
      const created = await createLeadList(supabase, workspaceId, { name: listName, source: source || 'external' });
      listId = created.id;
    }

    const ins = await insertLeads(supabase, workspaceId, listId, rows, {
      importDuplicates: !!import_duplicates,
      defaultSource: source || 'external',
    });

    // Score every row we can resolve — inserted OR dedup-skipped (the entity exists
    // either way). We score by the row's own identifier so a just-created entity
    // resolves cleanly. Stakes the icp_fit prediction as a side effect.
    let scored = 0, awaiting = 0, unresolved = 0;
    const results = [];
    for (const r of rows) {
      const id = r.email || r.linkedin_url || r.domain;
      if (!id) { unresolved++; continue; }
      const s = await scoreIdentifier(supabase, workspaceId, String(id));
      if (s.scored) scored++;
      else if (s.reason === 'awaiting_enrichment') awaiting++;
      else unresolved++;
      results.push({ identifier: id, ...s });
    }

    return res.status(201).json({
      lead_list_id: listId,
      inserted: ins.inserted,
      duplicate_skipped: ins.duplicate_skipped ?? 0,
      skipped: ins.skipped,
      scored,
      awaiting_enrichment: awaiting,
      unresolved,
      results,
    });
  } catch (err) {
    console.error('[POST /v2/lead-lists/attach]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /v2/lead-lists/:id — delete a list (and its leads).
leadListsV2Router.delete('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const deleted = await deleteLeadList(supabase, req.workspaceId, req.params.id);
    return res.json({ deleted: !!deleted });
  } catch (err) {
    console.error('[DELETE /v2/lead-lists/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/lead-lists/:id/enrich — find emails for the given lead ids (or filter).
// { preview:true } returns the cost breakdown without spending. Same reuse-gate,
// waterfall and pricing as the web enrich, so the agent + Partner OS get parity.
leadListsV2Router.post('/:id/enrich', async (req, res) => {
  try {
    const supabase = getSupabaseClient(); const ws = req.workspaceId;
    const ids = await resolveIds(supabase, ws, req.params.id, req.body || {});
    if (ids.length === 0) return res.status(400).json({ error: 'ids array or filter required' });
    const leads = await fetchLeadsByIds(supabase, ws, req.params.id, ids, 'id, workspace_id, email, linkedin_url, name, company, domain, email_status');
    const staleBefore = Date.now() - STALE;
    const last = await lastRunByEntity(supabase, ws, 'enrichment', leads.map((l) => l.id));
    const hasKey = (l) => Boolean(l.email || l.linkedin_url || ((l.name || '').trim().split(/\s+/).length >= 2 && l.domain));
    const classify = (l) => !hasKey(l) ? 'no_identifier' : (l.email && l.email_status && last.get(l.id) && new Date(last.get(l.id)).getTime() >= staleBefore ? 'reused' : 'chargeable');
    const [apolloK, findymailK, prospeoK] = await Promise.all([getApolloEnrichmentKey(supabase, ws), getFindymailEnrichmentKey(supabase, ws), getProspeoEnrichmentKey(supabase, ws)]);
    const provider = apolloK ? 'apollo' : findymailK ? 'findymail' : prospeoK ? 'prospeo' : 'prospeo';
    if (req.body.preview) {
      let chargeable = 0, reused = 0, noId = 0;
      for (const l of leads) { const c = classify(l); c === 'chargeable' ? chargeable++ : c === 'reused' ? reused++ : noId++; }
      return res.json({ preview: true, total: ids.length, chargeable, reused, no_identifier: noId, provider, cost: estimateCost(provider, chargeable) });
    }
    let enriched = 0, skippedNoId = 0, skippedReused = 0;
    for (const l of leads) {
      const c = classify(l);
      if (c === 'no_identifier') { skippedNoId++; continue; }
      if (c === 'reused') { skippedReused++; continue; }
      if (enriched >= MAX_RUN) break;
      const [first, ...rest] = (l.name || '').trim().split(' ');
      try { await enrichContact(supabase, { id: l.id, workspace_id: l.workspace_id, email: l.email, linkedin_url: l.linkedin_url, first_name: first || null, last_name: rest.join(' ') || null, company: l.company || null, domain: l.domain || null }); enriched++; } catch (e) { console.warn('[v2 enrich]', l.id, e.message); }
    }
    return res.json({ enriched, skipped_no_identifier: skippedNoId, skipped_already_verified: skippedReused, requested: ids.length, provider });
  } catch (err) {
    console.error('[POST /v2/lead-lists/:id/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/lead-lists/:id/verify — validate deliverability of emails on the given
// leads via the workspace's connected verifier. { preview:true } for the estimate.
leadListsV2Router.post('/:id/verify', async (req, res) => {
  try {
    const supabase = getSupabaseClient(); const ws = req.workspaceId;
    const ids = await resolveIds(supabase, ws, req.params.id, req.body || {});
    if (ids.length === 0) return res.status(400).json({ error: 'ids array or filter required' });
    const connected = await listConnectedVerifiers(supabase, ws);
    if (connected.length === 0) return res.status(409).json({ error: 'no_verifier_connected' });
    const leads = await fetchLeadsByIds(supabase, ws, req.params.id, ids, 'id, workspace_id, email, name');
    const staleBefore = Date.now() - STALE;
    const last = await lastRunByEntity(supabase, ws, 'verification', leads.map((l) => l.id));
    const classify = (l) => !l.email ? 'no_email' : (last.get(l.id) && new Date(last.get(l.id)).getTime() >= staleBefore ? 'reused' : 'chargeable');
    const provider = connected.includes(req.body.provider) ? req.body.provider : connected[0];
    if (req.body.preview) {
      let chargeable = 0, reused = 0, noEmail = 0;
      for (const l of leads) { const c = classify(l); c === 'chargeable' ? chargeable++ : c === 'reused' ? reused++ : noEmail++; }
      return res.json({ preview: true, total: ids.length, chargeable, reused, no_email: noEmail, connected_verifiers: connected, provider, cost: estimateCost(provider, chargeable) });
    }
    const verifier = await getVerifier(supabase, ws, req.body.provider);
    if (!verifier) return res.status(409).json({ error: 'no_verifier_connected' });
    let verified = 0, skippedNoEmail = 0, skippedReused = 0;
    for (const l of leads) {
      const c = classify(l);
      if (c === 'no_email') { skippedNoEmail++; continue; }
      if (c === 'reused') { skippedReused++; continue; }
      if (verified >= MAX_RUN) break;
      try { await verifyLead(supabase, verifier, l); verified++; } catch (e) { console.warn('[v2 verify]', l.id, e.message); }
    }
    return res.json({ verified, skipped_no_email: skippedNoEmail, skipped_recent: skippedReused, requested: ids.length, provider });
  } catch (err) {
    console.error('[POST /v2/lead-lists/:id/verify]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
