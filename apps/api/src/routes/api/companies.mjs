import { Router } from 'express';
import {
  getSupabaseClient, listNotes, listActivities,
  getAccountRecord, fetchEntityOverlays, applyCompanyOverlay,
  redactActivitiesForViewer, readContextFromReq, inTouchEntityIds,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { enrichCompany } from '../../services/enrichment.mjs';
import { icpFit } from '../../lib/icpFit.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';

export const companiesApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/companies/list
companiesApiRouter.get('/list', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: companies, error } = await supabase
      .from('companies')
      .select('id, name, domain, industry, employee_count, location, revenue_range, enrichment_status, deal_health_score, icp_score')
      .eq('workspace_id', workspaceId)
      .order('name');
    if (error) throw error;
    return res.json({ companies: companies || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/by-domain
companiesApiRouter.get('/by-domain', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { domain, workspaceId } = req.query;
    if (!domain || !workspaceId) return res.status(400).json({ error: 'domain and workspaceId required' });

    const normalized = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().trim();
    const { data: company } = await supabase.from('companies').select('*').eq('workspace_id', workspaceId).eq('domain', normalized).maybeSingle();
    if (!company) return res.json({ company: null });

    const { count } = await supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('company_id', company.id);
    return res.json({ company: { ...company, contactCount: count || 0 } });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/companies/:id
companiesApiRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    const allowed = ['name', 'industry', 'employee_count', 'location', 'revenue_range', 'domain'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key] === '' ? null : req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_fields' });
    updates.updated_at = new Date().toISOString();

    // Resolve the company's workspace and confirm the caller belongs to it — this
    // route takes no workspaceId, so the middleware couldn't check membership.
    const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', id).single();
    if (!company) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, company.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

    const { data, error } = await supabase.from('companies').update(updates).eq('id', id).eq('workspace_id', company.workspace_id).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ company: data });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/companies/enrich
companiesApiRouter.post('/enrich', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { domain, workspaceId, companyId } = req.body;
    if (!domain || !workspaceId) return res.status(400).json({ error: 'domain and workspaceId required' });

    const company = await enrichCompany(supabase, workspaceId, domain);
    if (!company) return res.json({ enriched: false, message: 'No data found for this domain' });

    // If a companyId was passed, merge the enriched data back onto it
    if (companyId && UUID.test(companyId)) {
      const { data: merged } = await supabase
        .from('companies')
        .update({
          name: company.name, industry: company.industry,
          employee_count: company.employee_count, location: company.location,
          tech_stack: company.tech_stack, enrichment_status: 'complete',
          enriched_at: new Date().toISOString(),
        })
        .eq('id', companyId)
        .eq('workspace_id', workspaceId)
        .select('*')
        .single();
      return res.json({ enriched: true, company: merged || company });
    }

    return res.json({ enriched: true, company });
  } catch (err) {
    if (err.code === 'enrichment_not_configured') {
      return res.status(503).json({
        error: 'enrichment_not_configured',
        message: 'Company enrichment requires PROSPERO_API_KEY. Add it to enable this feature.',
      });
    }
    console.error('[POST /api/companies/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/activity-and-memory
companiesApiRouter.get('/:id/activity-and-memory', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    const { data: contacts } = await supabase.from('contacts').select('id').eq('workspace_id', workspaceId).eq('company_id', id);
    const contactIds = (contacts || []).map(c => c.id);

    let activities = [], memories = [];
    if (contactIds.length) {
      // Same per-member privacy as the People page: on accounts you're in touch
      // with, the whole conversation is readable; elsewhere another rep's email /
      // LinkedIn bodies are redacted (header + timing stay). Notes stay shared.
      const ctx = readContextFromReq(req);
      const inTouch = await inTouchEntityIds(supabase, workspaceId, ctx.viewerUserId);
      activities = redactActivitiesForViewer(await listActivities(supabase, { contactIds, limit: 50 }), ctx, inTouch);
      memories = await listNotes(supabase, workspaceId, { entityIds: contactIds, limit: 20 });
    }

    return res.json({ activities, memories });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/graph
companiesApiRouter.get('/:id/graph', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    const { data: company } = await supabase.from('companies').select('id, name, domain, deal_health_score, icp_score, icp_fit').eq('id', id).eq('workspace_id', workspaceId).single();
    if (!company) return res.status(404).json({ error: 'not_found' });

    const { data: contacts } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title, seniority, pipeline_stage, deal_health_score, last_activity_at').eq('workspace_id', workspaceId).eq('company_id', id).order('deal_health_score', { ascending: false, nullsLast: true });

    const contactIds = (contacts || []).map(c => c.id);
    let signals = [], memories = [];
    if (contactIds.length) {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const acts = await listActivities(supabase, { contactIds, since: cutoff, limit: contactIds.length * 4 });
      const counts = {};
      signals = acts.filter(a => { counts[a.contact_id] = (counts[a.contact_id] || 0) + 1; return counts[a.contact_id] <= 4; });

      // Latest 2 notes per contact — entity_id == contact_id in v2.
      const memResults = await Promise.all(contactIds.map(cid =>
        listNotes(supabase, workspaceId, { entityId: cid, limit: 2 }),
      ));
      memories = memResults.flatMap((notes, i) =>
        notes.map(m => ({ ...m, contact_id: contactIds[i] })),
      );
    }

    return res.json({ company, contacts: contacts || [], signals, memories });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/detail — the account-record briefing for the company
// detail page. One call returns everything the page renders, so the frontend
// stops fetching contacts one-by-one:
//   company   — the v1 row with the v2 substrate overlaid (tech_stack, claims)
//   icp       — the latest ICP fit prediction for the account
//   stakeholders — contacts ranked by deal health, each with seniority, stage,
//                  ICP fit, and a recent-signal count (the stakeholder map)
//   edges     — workspace_graph_edges touching those contacts (how they relate)
//   activity  — the merged recent activity feed across all the company's contacts
//   facts     — the entity's claims with their epistemics (confidence, freshness,
//               observation_count, last_observed_at). companies.id IS the entity
//               id, so this is the same record get_account returns to an agent.
companiesApiRouter.get('/:id/detail', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    const { data: companyRow } = await supabase
      .from('companies')
      .select('*')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single();
    if (!companyRow) return res.status(404).json({ error: 'not_found' });

    const { data: contactRows } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email, job_title, seniority, department, pipeline_stage, deal_health_score, last_activity_at')
      .eq('workspace_id', workspaceId)
      .eq('company_id', id)
      .order('deal_health_score', { ascending: false, nullsLast: true });
    const contacts = contactRows || [];
    const contactIds = contacts.map(c => c.id);

    // Overlays carry the v2 substrate: the company's claims/tech_stack and each
    // contact's latest ICP-fit prediction. One batched call for the whole set.
    const overlays = await fetchEntityOverlays(supabase, [id, ...contactIds]);
    const company = applyCompanyOverlay(companyRow, overlays.get(id));

    // Recent activity across every contact + a per-contact signal count (90d) so
    // the stakeholder map can flag who's engaged and who's gone quiet.
    let activity = [];
    const signalCount = {};
    if (contactIds.length) {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      // Per-member privacy: redact another rep's message bodies, except on the
      // accounts this viewer is in touch with (see People page).
      const ctx = readContextFromReq(req);
      const inTouch = await inTouchEntityIds(supabase, workspaceId, ctx.viewerUserId);
      activity = redactActivitiesForViewer(await listActivities(supabase, { contactIds, since: cutoff, limit: 100 }), ctx, inTouch);
      const nameById = Object.fromEntries(
        contacts.map(c => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email]),
      );
      for (const a of activity) {
        signalCount[a.contact_id] = (signalCount[a.contact_id] || 0) + 1;
        a.contactName = nameById[a.contact_id] || null;
      }
    }

    // Relationships between the company's people — how they relate to each other.
    let edges = [];
    if (contactIds.length) {
      const { data } = await supabase
        .from('workspace_graph_edges')
        .select('subject_type, subject_id, subject_label, relationship, object_type, object_id, object_label, confidence')
        .eq('workspace_id', workspaceId)
        .in('subject_id', contactIds);
      edges = data || [];
    }

    const stakeholders = contacts.map(c => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
      title: c.job_title || null,
      seniority: c.seniority || null,
      department: c.department || null,
      pipeline_stage: c.pipeline_stage || 'identified',
      deal_health_score: c.deal_health_score ?? null,
      icp_score: overlays.get(c.id)?.prediction?.score ?? null,
      last_activity_at: c.last_activity_at || null,
      signal_count: signalCount[c.id] || 0,
    }));

    const [account, icp] = await Promise.all([
      // ctx scopes recent_observations to the viewer (claims/facts stay shared).
      getAccountRecord(supabase, workspaceId, id, readContextFromReq(req)),
      icpFit(supabase, workspaceId, id),
    ]);

    // Buying signals — signal.* state claims on the company entity (signal-scan /
    // record_signal write these). Companies are entities too, so the same query
    // the contact endpoint uses works here. Signals are company-level by nature,
    // so they belong on the company record, not only the person.
    const { data: sigRows } = await supabase.from('claims')
      .select('property, value, computed_at')
      .eq('entity_id', id).like('property', 'signal.%')
      .is('invalid_at', null)
      .order('computed_at', { ascending: false });
    const signals = (sigRows || []).map(s => ({
      signal_class: (s.property || '').replace(/^signal\./, ''),
      detected:   s.value?.detected ?? null,
      implies:    s.value?.implies ?? null,
      score:      s.value?.score ?? null,
      approach:   s.value?.approach ?? null,
      angle:      s.value?.angle ?? null,
      updated_at: s.computed_at,
    }));

    // Notes/documents saved ON the company entity (signal-scan briefs, research,
    // meeting notes). companies.id IS the entity id, so listNotes by entityId
    // returns the same docs save_note writes to the account.
    const notes = await listNotes(supabase, workspaceId, { entityId: id, limit: 50 });

    return res.json({
      company,
      icp: icp || null,
      stakeholders,
      edges,
      activity,
      facts: account ? Object.values(account.claims) : [],
      signals,
      notes: notes || [],
      recent_observations: account?.recent_observations ?? [],
    });
  } catch (err) {
    console.error('[GET /api/companies/:id/detail]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/graph-edges — all workspace_graph_edges for the Mind view
companiesApiRouter.get('/graph-edges', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: edges } = await supabase
      .from('workspace_graph_edges')
      .select('subject_type, subject_id, subject_label, relationship, object_type, object_id, object_label, confidence')
      .eq('workspace_id', workspaceId)
      .limit(2000);
    return res.json({ edges: edges ?? [] });
  } catch (err) {
    console.error('[GET /api/companies/graph-edges]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/companies/:id
companiesApiRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_company_id' });
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: company } = await supabase.from('companies').select('id').eq('id', id).eq('workspace_id', workspaceId).single();
    if (!company) return res.status(404).json({ error: 'company_not_found' });
    await supabase.from('companies').delete().eq('id', id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/companies/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/contact-graph
companiesApiRouter.get('/contact-graph', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { ids, workspaceId, companyName } = req.query;
    if (!ids || !workspaceId) return res.status(400).json({ error: 'ids and workspaceId required' });

    const contactIds = String(ids).split(',').filter(id => UUID.test(id.trim())).map(id => id.trim());
    if (!contactIds.length) return res.status(400).json({ error: 'no valid ids' });

    const { data: contacts } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title, pipeline_stage, deal_health_score, last_activity_at').eq('workspace_id', workspaceId).in('id', contactIds);

    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const acts = await listActivities(supabase, { contactIds, since: cutoff, limit: contactIds.length * 4 });
    const counts = {};
    const signals = acts.filter(a => { counts[a.contact_id] = (counts[a.contact_id] || 0) + 1; return counts[a.contact_id] <= 4; });

    const synthetic = { id: 'synthetic', name: companyName || 'Company', deal_health_score: null };
    return res.json({ company: synthetic, contacts: contacts || [], signals, memories: [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
