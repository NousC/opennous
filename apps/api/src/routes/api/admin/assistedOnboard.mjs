// Assisted onboarding — the sales-led setup for a Custom workspace.
//
// A Custom customer is an internal GTM team that does NOT have an agent of their own (that
// is what they're buying). So they can't do the reconcile-your-repo flow the operator road
// uses — there's no repo and no agent. After the sales call, an admin runs this: it hands
// the intake answers, the company website, and their best-customer domains to
// runOnboardingAgent, which drafts the ICP/positioning/voice foundations and seeds the
// scoring model from those real closed-won examples.
//
// Learning the ICP from a customer's actual best customers is the single strongest signal
// in the product, and this is the one path that uses it — which is exactly why it was worth
// keeping when the agency track it was built for got cut.
//
// Admin-authed (verifySupabaseAuth + requireAdmin at the mount), so this is Bennet running
// setup for a real account, not a self-serve surface.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { runOnboardingAgent } from '../../../lib/onboardingAgent.mjs';
import { resolveTeamAndPlan, hasFeature } from '../../../lib/access.mjs';

export const assistedOnboardRouter = Router();

// POST /api/admin/assisted-onboard
//   body: { workspace_id, company_name?, website?, offer?, icp?, positioning?, voice?,
//           example_customers?: string[] }
//   → 200 { ok, built: { foundations, scorecard, business_type, example_customers, errors } }
assistedOnboardRouter.post('/', async (req, res) => {
  try {
    const {
      workspace_id, company_name, website, offer, icp, positioning, voice, example_customers,
    } = req.body || {};
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const supabase = getSupabaseClient();

    // Guard rail: assisted onboarding is the Custom motion. Running it on a self-serve plan
    // would seed the expensive assisted setup for someone who is meant to onboard through
    // their own agent — and would quietly imply we support a thing we don't sell. Resolve
    // the plan by workspace via resolveTeamAndPlan's API-key branch (it keys off workspaceId).
    const plan = await resolveTeamAndPlan({ workspaceId: workspace_id })
      .then((r) => r.plan)
      .catch(() => null);
    if (plan && !hasFeature(plan.id, 'inAppAgent')) {
      return res.status(409).json({
        error: 'not_a_custom_workspace',
        message: `Workspace is on ${plan.id}. Move it to Custom before running assisted onboarding.`,
      });
    }

    const built = await runOnboardingAgent(supabase, workspace_id, {
      company_name, website, offer, icp, positioning, voice, example_customers,
    });
    return res.json({ ok: true, built });
  } catch (err) {
    console.error('[admin/assisted-onboard]', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message });
  }
});
