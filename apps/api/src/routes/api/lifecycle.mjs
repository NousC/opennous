import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';
import { LIFECYCLE_STAGES, LIFECYCLE_OWNER, ownerDeptOf, isLifecycleStage, ROLE_DEPT } from '../../lib/lifecycle.mjs';
import { getWorkspacePipelines, saveWorkspacePipelines } from '@nous/core';
import { proposeLifecycleMoves } from '../../lib/lifecycleRules.mjs';

// The revenue lifecycle — handoffs between departments as an account travels the journey.
// lifecycle_events is the source of truth: an account's current override stage is its
// latest event's to_stage (pre-sale accounts have no events and derive from the sales
// ladder client-side). Every crossing is a handoff card in Home → Needs attention.
export const lifecycleApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The latest event per company for a workspace → { companyId: { to_stage, id } }. Exported
// so /api/companies/list can fold the override stage into each card in one place.
export async function latestStages(supabase, workspaceId, companyIds = null) {
  let q = supabase.from('lifecycle_events')
    .select('company_id, to_stage, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (companyIds && companyIds.length) q = q.in('company_id', companyIds);
  const { data, error } = await q;
  if (error) { console.error('[lifecycle.latestStages]', error.message); return new Map(); }
  const seen = new Map();
  for (const r of data ?? []) if (!seen.has(r.company_id)) seen.set(r.company_id, r.to_stage);
  return seen;
}

// The viewer's department, from their workspace_members.job_role.
async function viewerDept(supabase, workspaceId, userId) {
  const { data } = await supabase.from('workspace_members')
    .select('job_role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return ROLE_DEPT[data?.job_role ?? ''] ?? null;
}

// The lifecycle visibility scope for a viewer: which department's accounts they may see.
// Leadership (workspace owner/admin, or job_role=founder) and unroled members return null
// = see everything. A sales/CS member returns their department, and the accounts endpoint
// hides accounts the OTHER department currently owns.
export async function lifecycleDeptScope(supabase, workspaceId, userId) {
  const { data } = await supabase.from('workspace_members')
    .select('role, job_role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  const wsRole = String(data?.role ?? '').toLowerCase();
  const jobRole = data?.job_role ?? '';
  if (['owner', 'admin'].includes(wsRole) || jobRole === 'founder') return null; // leadership sees all
  return ROLE_DEPT[jobRole] ?? null; // a department, or null (unroled → see all)
}

// The set of company ids that have reached a won stage (client/closed_won), so the scope
// filter can route them to Customer Success even before an explicit handoff event exists.
export async function wonCompanyIds(supabase, workspaceId) {
  const { data } = await supabase.from('contacts')
    .select('company_id').eq('workspace_id', workspaceId)
    .in('pipeline_stage', ['closed_won', 'client']).not('company_id', 'is', null);
  return new Set((data ?? []).map((r) => r.company_id));
}

// Which department owns an account right now: an explicit override event wins; else a won
// account belongs to CS (pending/through handoff); everything else is the sales book.
export function ownerDeptForCompany(overrideStage, isWon) {
  if (overrideStage) return ownerDeptOf(overrideStage);
  return isWon ? 'customer_success' : 'sales';
}

// Names for a set of company ids, from the companies view.
async function companyNames(supabase, workspaceId, ids) {
  if (!ids.length) return new Map();
  const { data } = await supabase.from('companies')
    .select('id, name, domain').eq('workspace_id', workspaceId).in('id', ids);
  return new Map((data ?? []).map((c) => [c.id, { name: c.name, domain: c.domain }]));
}

// POST /api/lifecycle/advance — move an account to a new lifecycle stage. This is the
// handoff: it logs from→to and the departments on each side, so the receiving role sees it.
lifecycleApiRouter.post('/advance', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, companyId, stage, note, reason } = req.body || {};
    if (!workspaceId || !companyId || !stage) return res.status(400).json({ error: 'workspaceId, companyId, stage required' });
    if (!UUID.test(companyId)) return res.status(400).json({ error: 'invalid_company' });
    if (!isLifecycleStage(stage)) return res.status(400).json({ error: 'invalid_stage', valid: LIFECYCLE_STAGES });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) return res.status(404).json({ error: 'not_found' });

    const prior = await latestStages(supabase, workspaceId, [companyId]);
    const fromStage = prior.get(companyId) ?? null; // null = it was in sales_pipeline (derived)
    const fromDept = fromStage ? ownerDeptOf(fromStage) : 'sales';
    const toDept = ownerDeptOf(stage);
    if (fromStage === stage) return res.status(200).json({ ok: true, unchanged: true });

    const { data, error } = await supabase.from('lifecycle_events').insert({
      workspace_id: workspaceId, company_id: companyId,
      from_stage: fromStage ?? 'sales_pipeline', to_stage: stage,
      from_dept: fromDept, to_dept: toDept,
      reason: reason ?? 'manual', note: note ?? null, created_by: req.internalUserId,
    }).select('*').single();
    if (error) throw error;
    return res.json({ event: data });
  } catch (err) {
    console.error('[POST /api/lifecycle/advance]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/lifecycle/handoffs?workspaceId=&scope=mine|all — the handoff worklist for Home.
// First reconciles: any account that has reached closed_won but never entered the lifecycle
// gets an automatic sales→CS handoff event (idempotent), so a freshly-closed deal shows up
// as a pending handoff without anyone clicking. Then returns recent events, unacked first,
// scoped to the viewer's department when scope=mine.
lifecycleApiRouter.get('/handoffs', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, scope } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) return res.status(404).json({ error: 'not_found' });

    // ── reconcile closed-won → handoff (once per account) ──
    // Won deals cross into the lifecycle — the data uses both 'closed_won' and 'client'.
    const { data: wonContacts } = await supabase.from('contacts')
      .select('company_id').eq('workspace_id', workspaceId).in('pipeline_stage', ['closed_won', 'client']).not('company_id', 'is', null);
    const wonCompanyIds = [...new Set((wonContacts ?? []).map((c) => c.company_id))];
    if (wonCompanyIds.length) {
      const existing = await latestStages(supabase, workspaceId, wonCompanyIds);
      const fresh = wonCompanyIds.filter((id) => !existing.has(id));
      if (fresh.length) {
        await supabase.from('lifecycle_events').insert(fresh.map((company_id) => ({
          workspace_id: workspaceId, company_id,
          from_stage: 'sales_pipeline', to_stage: 'handoff',
          from_dept: 'sales', to_dept: 'customer_success',
          reason: 'closed_won',
        })));
      }
    }

    // ── the worklist ──
    // Two sources write here: the closed-won reconcile above, and the daily CS snapshot job
    // (apps/worker/src/workers/csSnapshots.mjs), which files `reason: 'cs_owner_change'` when the
    // CRM's CS owner on a customer changes or is first set, naming both people in from_owner /
    // to_owner. Those columns arrive with 2026_10_02_cs_metric_snapshots.sql, applied by hand, so
    // a database without them is read without them rather than failing Home's worklist.
    const read = (cols) => supabase.from('lifecycle_events')
      .select(cols)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(100);
    const BASE = 'id, company_id, from_stage, to_stage, from_dept, to_dept, reason, note, created_at, acknowledged_at';
    let { data: events, error } = await read(`${BASE}, from_owner, to_owner`);
    if (error && /from_owner|to_owner|42703|does not exist/i.test(`${error.message} ${error.code ?? ''}`)) {
      ({ data: events, error } = await read(BASE));
    }
    if (error) throw error;

    let rows = events ?? [];
    if (scope === 'mine') {
      const dept = await viewerDept(supabase, workspaceId, req.internalUserId);
      if (dept) rows = rows.filter((e) => e.to_dept === dept);
    }
    const names = await companyNames(supabase, workspaceId, [...new Set(rows.map((e) => e.company_id))]);
    const handoffs = rows.map((e) => ({
      ...e,
      company_name: names.get(e.company_id)?.name ?? 'Account',
      company_domain: names.get(e.company_id)?.domain ?? null,
    }));
    return res.json({ handoffs, unacknowledged: handoffs.filter((h) => !h.acknowledged_at).length });
  } catch (err) {
    console.error('[GET /api/lifecycle/handoffs]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/lifecycle/handoffs/:id — acknowledge a handoff (clears it from the worklist).
lifecycleApiRouter.patch('/handoffs/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.body || {};
    const { id } = req.params;
    if (!workspaceId || !UUID.test(id)) return res.status(400).json({ error: 'workspaceId and valid id required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) return res.status(404).json({ error: 'not_found' });
    const { error } = await supabase.from('lifecycle_events')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', id).eq('workspace_id', workspaceId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/lifecycle/handoffs/:id]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export { LIFECYCLE_OWNER };

// ── The team's own lifecycle phases ─────────────────────────────────────────
//
// GET returns their phases (or our defaults, flagged); PUT replaces the set; POST /propose
// runs the entry rules. Everything the agent can do here, a UI can do too — one definition
// underneath both, which is the arrangement stages already have.

// GET /api/lifecycle/pipelines?workspaceId=
lifecycleApiRouter.get('/pipelines', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) return res.status(404).json({ error: 'not_found' });
    return res.json(await getWorkspacePipelines(supabase, workspaceId));
  } catch (err) {
    console.error('[GET /api/lifecycle/pipelines]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/lifecycle/pipelines — owner/admin. The full ordered set replaces the old one.
lifecycleApiRouter.put('/pipelines', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, pipelines } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: m } = await supabase.from('workspace_members')
      .select('role').eq('workspace_id', workspaceId).eq('user_id', req.internalUserId).maybeSingle();
    if (!['owner', 'admin'].includes(String(m?.role ?? '').toLowerCase())) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }
    return res.json({ pipelines: await saveWorkspacePipelines(supabase, workspaceId, pipelines ?? []) });
  } catch (err) {
    console.error('[PUT /api/lifecycle/pipelines]', err?.message || err);
    return res.status(400).json({ error: 'save_failed', detail: String(err?.message ?? err) });
  }
});

// POST /api/lifecycle/propose — run the entry rules.
//
// Writes UNACKNOWLEDGED events only: a suggestion on the owning team's worklist, never a
// move. `dryRun` evaluates without writing, which is how you check a rule before it starts
// appearing on someone's list.
lifecycleApiRouter.post('/propose', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, dryRun } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: m } = await supabase.from('workspace_members')
      .select('role').eq('workspace_id', workspaceId).eq('user_id', req.internalUserId).maybeSingle();
    if (!['owner', 'admin'].includes(String(m?.role ?? '').toLowerCase())) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }
    return res.json(await proposeLifecycleMoves(workspaceId, { supabase, dryRun: dryRun === true }));
  } catch (err) {
    console.error('[POST /api/lifecycle/propose]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message ?? err) });
  }
});
