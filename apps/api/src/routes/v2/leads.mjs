import { Router } from 'express';
import {
  getSupabaseClient,
  insertLeads,
  updateLead,
  getLeadList,
} from '@nous/core';
import { fetchIcpByEntity, fetchIntentByEntity } from '../../lib/icpFit.mjs';

export const leadsV2Router = Router();

// ─── /v2/leads — deterministic CRUD over rows in a lead list ────────────────
// The REST shape n8n / Make / custom workflows call when they need to add to a
// list, update a row mid-loop ("we just sent another email — mark it"), or
// pull the next batch with a filter. Agents semantically exploring the same
// data should still use /v2/query.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 1000;
const MAX_BULK  = 1000;

const LEAD_COLUMNS =
  'id, lead_list_id, workspace_id, email, name, company, linkedin_url, ' +
  'sent_at, send_variant, is_repeat_contact, features, fields, scorecard_score, ' +
  'reply_outcome, replied_at, status, contact_id, created_at, updated_at';

function parseDuration(input) {
  if (input == null) return null;
  const m = String(input).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * ms;
}

// ─── GET /v2/leads — filtered list across all lists in the workspace ────────
// Filters: list_id, status, reply_outcome, has_replied, has_email,
// sent_within, sent_before, score_gte, limit, offset, sort
leadsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const {
      list_id,
      status,
      reply_outcome,
      has_replied,
      has_email,
      sent_within,
      sent_before,
      score_gte,
      sort,
      limit,
      offset,
    } = req.query;

    let q = supabase.from('leads').select(LEAD_COLUMNS).eq('workspace_id', workspaceId);

    if (list_id) {
      if (!UUID.test(String(list_id))) return res.status(400).json({ error: 'invalid_list_id' });
      q = q.eq('lead_list_id', list_id);
    }
    if (status)        q = q.eq('status', status);
    if (reply_outcome) q = q.eq('reply_outcome', reply_outcome);

    if (has_replied === 'true')  q = q.not('replied_at', 'is', null);
    if (has_replied === 'false') q = q.is('replied_at', null);
    if (has_email === 'true')    q = q.not('email', 'is', null);
    if (has_email === 'false')   q = q.is('email', null);

    const withinMs = parseDuration(sent_within);
    if (withinMs != null) {
      q = q.gte('sent_at', new Date(Date.now() - withinMs).toISOString());
    }
    const beforeMs = parseDuration(sent_before);
    if (beforeMs != null) {
      const cutoff = new Date(Date.now() - beforeMs).toISOString();
      // "we haven't reached out in N" — either never sent, or last send before cutoff.
      q = q.or(`sent_at.is.null,sent_at.lt.${cutoff}`);
    }

    if (score_gte != null && score_gte !== '') {
      const v = parseFloat(score_gte);
      if (!Number.isNaN(v)) q = q.gte('scorecard_score', v);
    }

    q = sort === 'created_asc'
      ? q.order('created_at', { ascending: true })
      : sort === 'score_desc'
        ? q.order('scorecard_score', { ascending: false, nullsFirst: false })
        : q.order('created_at', { ascending: false });

    const lim = Math.min(parseInt(limit, 10) || 100, MAX_LIMIT);
    const off = parseInt(offset, 10) || 0;
    q = q.range(off, off + lim - 1);

    const { data, error } = await q;
    if (error) throw error;
    const leads = data ?? [];
    if (leads.length) {
      const ids = leads.map((l) => l.id);
      // Attach email_found_by — the enrichment provider that resolved the email
      // (from the enrichment observation's source), in one batched query.
      const { data: obs } = await supabase.from('observations')
        .select('entity_id, source, observed_at')
        .eq('workspace_id', workspaceId)
        .in('entity_id', ids)
        .in('source', ['prospeo', 'apollo', 'findymail', 'leadmagic', 'aiark', 'blitz'])
        .order('observed_at', { ascending: false });
      const foundBy = new Map();
      for (const o of obs || []) if (!foundBy.has(o.entity_id)) foundBy.set(o.entity_id, o.source);
      for (const l of leads) if (l.email && foundBy.has(l.id)) l.email_found_by = foundBy.get(l.id);

      // Overlay the ICP tier+score and the intent band+score from the SAME shared
      // readers the People page and internal lead-list use — so the tier always
      // travels WITH the ICP fit, and no surface ever disagrees on either axis.
      const [icpMap, intentMap] = await Promise.all([
        fetchIcpByEntity(supabase, workspaceId, ids),
        fetchIntentByEntity(supabase, workspaceId, ids),
      ]);
      for (const l of leads) {
        const ov = icpMap.get(l.id);
        if (ov) {
          l.tier = ov.tier;                                      // tier_1 | tier_2 | tier_3 | not_icp
          if (l.icp_score == null) l.icp_score = ov.score;
          l.fields = { ...(l.fields || {}), icp_score: ov.score, icp_tier: ov.tier };
        }
        const iv = intentMap.get(l.id);
        l.intent_score = iv?.score ?? 0;
        l.intent_band = iv?.band ?? 'Dormant';
        l.fields = { ...(l.fields || {}), intent_score: l.intent_score, intent_band: l.intent_band };
      }
    }
    return res.json({ leads, limit: lim, offset: off });
  } catch (err) {
    console.error('[GET /v2/leads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /v2/leads — single create (form intake hook, etc.) ────────────────
// Body: { list_id, email?, name?, company?, linkedin_url?, send_variant?,
//         is_repeat_contact?, features?, fields? }
// Workspace-wide dedup on email + normalized linkedin_url is on by default;
// pass importDuplicates: true to force-insert.
leadsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { list_id, importDuplicates, ...row } = req.body ?? {};

    if (!list_id || !UUID.test(String(list_id))) {
      return res.status(400).json({ error: 'list_id_required' });
    }
    const list = await getLeadList(supabase, workspaceId, list_id);
    if (!list) return res.status(404).json({ error: 'list_not_found' });
    if (!row.email && !row.linkedin_url) {
      return res.status(400).json({ error: 'identifier_required', detail: 'email or linkedin_url required' });
    }

    const result = await insertLeads(supabase, workspaceId, list_id, [row], { importDuplicates: !!importDuplicates });
    return res.status(201).json(result);
  } catch (err) {
    console.error('[POST /v2/leads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /v2/leads/bulk — up to 1000 rows in one call ──────────────────────
// Same dedup behavior as POST /v2/leads.
leadsV2Router.post('/bulk', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { list_id, leads, importDuplicates } = req.body ?? {};

    if (!list_id || !UUID.test(String(list_id))) {
      return res.status(400).json({ error: 'list_id_required' });
    }
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads_array_required' });
    }
    if (leads.length > MAX_BULK) {
      return res.status(413).json({ error: 'too_many', detail: `max ${MAX_BULK} per request` });
    }

    const list = await getLeadList(supabase, workspaceId, list_id);
    if (!list) return res.status(404).json({ error: 'list_not_found' });

    const result = await insertLeads(supabase, workspaceId, list_id, leads, { importDuplicates: !!importDuplicates });
    return res.status(201).json(result);
  } catch (err) {
    console.error('[POST /v2/leads/bulk]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── PATCH /v2/leads/:id — update a lead row mid-loop ────────────────────────
// The morning-loop fix: when n8n sends a follow-up email it should immediately
// PATCH `sent_at: now` so the next iteration's filter excludes the row. The
// async webhook from Smartlead/Gmail will arrive later — dedup on the
// observation external_id keeps the activity log clean.
leadsV2Router.patch('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });

    const allowed = {};
    for (const k of ['status', 'reply_outcome', 'replied_at', 'sent_at',
                     'send_variant', 'scorecard_score', 'contact_id',
                     'features', 'fields']) {
      if (req.body && k in req.body) allowed[k] = req.body[k];
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: 'no_updatable_fields' });
    }

    const lead = await updateLead(supabase, workspaceId, req.params.id, allowed);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    return res.json({ lead });
  } catch (err) {
    console.error('[PATCH /v2/leads/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
