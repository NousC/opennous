// /api/icp/evidence — the instrument, not the model.
//
// Phase 1 of fitting the ICP scoring model to outcomes instead of prose. It rebuilds the
// labelled dataset from the graph and reports what predicted a win, with how much evidence is
// behind each line. It changes NO scoring: the point is to look at the numbers on real
// workspaces before betting anything on them, because on most workspaces the honest answer
// will be "not enough closed deals yet" and that has to be visible rather than papered over.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { buildOutcomeLedger } from '../../lib/outcomeLedger.mjs';
import { icpEvidence } from '../../lib/icpEvidence.mjs';
import { blendScorecardWithEvidence, provenanceLine } from '../../lib/icpShrinkage.mjs';
import { seedPainFromInsights } from '../../lib/painFromInsights.mjs';

export const icpEvidenceRouter = Router();

/** Owner/admin only. This is the whole company's win/loss history in one response. */
async function requireAdmin(supabase, workspaceId, userId) {
  const { data } = await supabase
    .from('workspace_members').select('role')
    .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return ['owner', 'admin'].includes(String(data?.role ?? '').toLowerCase());
}

// GET /api/icp/evidence?workspaceId=…[&rebuild=1]
//
// `rebuild=1` re-derives the ledger from the graph first. It is not the default: the
// derivation walks every pipeline_stage claim the workspace has ever had, and a page refresh
// should not pay for that.
icpEvidenceRouter.get('/evidence', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    if (!(await requireAdmin(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }

    let built = null;
    if (req.query.rebuild === '1') built = await buildOutcomeLedger(workspaceId, { supabase });

    const evidence = await icpEvidence(workspaceId, {
      supabase,
      minDeals: Math.max(1, Math.min(Number(req.query.minDeals) || 3, 50)),
    });
    return res.json({ built, ...evidence });
  } catch (err) {
    console.error('[GET /api/icp/evidence]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message ?? err) });
  }
});

// POST /api/icp/evidence/rebuild — re-derive the ledger and report the counts only.
icpEvidenceRouter.post('/evidence/rebuild', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    if (!(await requireAdmin(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }
    return res.json(await buildOutcomeLedger(workspaceId, { supabase }));
  } catch (err) {
    console.error('[POST /api/icp/evidence/rebuild]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message ?? err) });
  }
});

// POST /api/icp/blend — update the scoring model with what the deals say.
//
// Not a switch from the website model to a "real" one: the website model is the PRIOR, and
// this shrinks it toward the evidence in proportion to how much evidence there is. A
// workspace with no closed deals is unchanged by design.
//
// `dryRun` returns exactly what would move without moving it, because a weight changing under
// someone is the fastest way to lose their trust in the score.
icpEvidenceRouter.post('/blend', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    if (!(await requireAdmin(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }

    const result = await blendScorecardWithEvidence(workspaceId, {
      supabase,
      dryRun: req.body?.dryRun === true,
      ...(Number(req.body?.pseudoCount) > 0 ? { pseudoCount: Number(req.body.pseudoCount) } : {}),
    });
    return res.json({ ...result, provenance: provenanceLine(result) });
  } catch (err) {
    console.error('[POST /api/icp/blend]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message ?? err) });
  }
});

// POST /api/icp/pain — build the Pain layer from what buyers said on calls.
//
// The layer that can be real months before any deal closes, and the one that was emptiest:
// a live workspace had 94 Fit signals and 11 Pain ones, most of them inferred from the ICP
// paragraph. Insights are the language buyers actually used, which is exactly what a keyword
// rule wants.
//
// Prevalence, not outcome. `dryRun` shows what would be written.
icpEvidenceRouter.post('/pain', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    if (!(await requireAdmin(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'insufficient_permissions' });
    }
    return res.json(await seedPainFromInsights(workspaceId, {
      supabase, dryRun: req.body?.dryRun === true,
    }));
  } catch (err) {
    console.error('[POST /api/icp/pain]', err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message ?? err) });
  }
});
