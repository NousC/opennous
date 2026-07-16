// Put a team on a plan by hand.
//
// Custom is sold on a call, not through Stripe Checkout. Somebody talks to Bennet,
// they agree a price, and then this is what actually turns the product on for them:
// a comped subscription row with plan_id='custom'. No Stripe object, no Price ID,
// no self-serve path — deliberately, because the number is negotiated per customer
// and the whole point of Custom is that we price it against what they really use.
//
// It is also the undo. Downgrade back to 'free' and the team layer disappears the
// moment they reload.
//
// Admin-only (ADMIN_EMAILS). Mounted with verifySupabaseAuth + requireAdmin.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { PLANS, PLAN_IDS, getPlan } from '../../lib/plans.mjs';

export const adminPlanRouter = Router();

/** Resolve an email to its team. The user is the handle Bennet actually has. */
async function findTeamByEmail(supabase, email) {
  const { data: user } = await supabase
    .from('users')
    .select('id, email')
    .ilike('email', email.trim())
    .maybeSingle();
  if (!user) return { error: 'no_user_with_that_email' };

  const { data: member } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member?.team_id) return { error: 'user_has_no_team' };

  const { data: team } = await supabase
    .from('teams')
    .select('id, name')
    .eq('id', member.team_id)
    .maybeSingle();

  return { user, team };
}

/**
 * GET /api/admin/plan?email=someone@company.com
 * What is this team on right now, and how big are they? Check before you flip.
 */
adminPlanRouter.get('/', async (req, res) => {
  try {
    const email = String(req.query.email ?? '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });

    const supabase = getSupabaseClient();
    const found = await findTeamByEmail(supabase, email);
    if (found.error) return res.status(404).json({ error: found.error });

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('team_id', found.team.id)
      .maybeSingle();

    const plan = getPlan(subscription?.plan_id ?? 'free');

    const { data: workspaces } = await supabase
      .from('workspaces').select('id').eq('team_id', found.team.id);
    const wsIds = (workspaces ?? []).map(w => w.id);

    let activeAccounts = 0;
    if (wsIds.length) {
      const { data } = await supabase.rpc('team_active_accounts', { ws_ids: wsIds });
      activeAccounts = Number(data) || 0;
    }

    return res.json({
      user: found.user.email,
      team: { id: found.team.id, name: found.team.name },
      plan: plan.id,
      planName: plan.name,
      isComp: subscription?.is_comp === true,
      hasStripe: Boolean(subscription?.stripe_subscription_id),
      activeAccounts: {
        used: activeAccounts,
        included: plan.activeAccountsLimit, // null = unlimited
      },
    });
  } catch (err) {
    console.error('[GET /api/admin/plan]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /api/admin/plan  { email, plan }
 *
 * Flip a team onto a plan. The real use is 'custom' after a sales call: it turns on
 * the agent, Adoption, Playbooks, Tasks, Skills, Salesforce/HubSpot/Slack, and drops
 * the active-account cap.
 */
adminPlanRouter.post('/', async (req, res) => {
  try {
    const email = String(req.body?.email ?? '').trim();
    const planId = String(req.body?.plan ?? '').trim().toLowerCase();

    if (!email) return res.status(400).json({ error: 'email required' });
    if (!PLAN_IDS.includes(planId)) {
      return res.status(400).json({ error: 'unknown_plan', valid: PLAN_IDS });
    }
    if (PLANS[planId].retired) {
      return res.status(400).json({
        error: 'plan_retired',
        message: `${PLANS[planId].name} is grandfathered for existing subscribers and cannot be assigned to anyone new.`,
      });
    }

    const supabase = getSupabaseClient();
    const found = await findTeamByEmail(supabase, email);
    if (found.error) return res.status(404).json({ error: found.error });

    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id, stripe_subscription_id')
      .eq('team_id', found.team.id)
      .maybeSingle();

    // A team on a real Stripe subscription must be changed in Stripe, not here —
    // rewriting plan_id underneath a live subscription would leave us charging one
    // amount and serving another, and the divergence would be invisible.
    if (existing?.stripe_subscription_id) {
      return res.status(409).json({
        error: 'has_stripe_subscription',
        message: 'This team pays through Stripe. Change the plan in Stripe, or cancel it first — do not rewrite plan_id underneath a live subscription.',
      });
    }

    const now = new Date().toISOString();
    const row = {
      team_id:   found.team.id,
      plan_id:   planId,
      plan_name: PLANS[planId].name,
      status:    'active',
      // Comped: entitlement without a Stripe object. Custom is invoiced out of band.
      is_comp:   planId !== 'free',
      updated_at: now,
    };

    const { error } = existing
      ? await supabase.from('subscriptions').update(row).eq('id', existing.id)
      : await supabase.from('subscriptions').insert({ ...row, created_at: now });

    if (error) {
      console.error('[POST /api/admin/plan] write failed:', error.message);
      return res.status(500).json({ error: 'write_failed', detail: error.message });
    }

    const plan = PLANS[planId];
    return res.json({
      ok: true,
      user: found.user.email,
      team: found.team.name,
      plan: plan.id,
      planName: plan.name,
      unlocked: Object.entries(plan.features)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
      activeAccountsLimit: plan.activeAccountsLimit, // null = unlimited
      note: 'They see it on next reload. Billing is invoiced out of band — no Stripe object exists for this.',
    });
  } catch (err) {
    console.error('[POST /api/admin/plan]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
