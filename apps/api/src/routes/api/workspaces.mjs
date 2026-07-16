import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { getPlanFromSubscription, effectiveWorkspaceLimit, isSelfHosted } from '../../lib/plans.mjs';
import { billingEnabled, setSubscriptionQuantity } from '../../lib/stripe.mjs';
import { getCountryFromRequest } from '../../lib/geo.mjs';

export const workspacesRouter = Router();

// GET /api/workspaces
workspacesRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { user } = await ensureUserAndTeam(req.user);
    const { data: memberships, error } = await supabase
      .from('workspace_members')
      .select('workspaces:workspace_id(*)')
      .eq('user_id', user.id);
    if (error) throw error;
    return res.json({ workspaces: memberships.map(m => m.workspaces).filter(Boolean) });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/workspaces
workspacesRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { name, icon } = req.body;
    const { user, team } = await ensureUserAndTeam(req.user);
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    if (isSelfHosted()) {
      const { count } = await supabase
        .from('workspaces')
        .select('id', { count: 'exact', head: true })
        .eq('team_id', team.id);
      if ((count || 0) >= 1) {
        return res.status(403).json({ error: 'self_hosted_workspace_limit', message: 'Self-hosted installations support one workspace.' });
      }
    } else {
      // Cloud: enforce the team's effective workspace limit. Flat plans use the
      // static limit (Free/Start/Pro 1, Growth 3); Partner uses its purchased
      // Stripe quantity (clients bought, base 5), so paying for more lifts it.
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_id, status, quantity')
        .eq('team_id', team.id)
        .maybeSingle();
      const plan = getPlanFromSubscription(subscription);
      const limit = effectiveWorkspaceLimit(plan, subscription);
      if (limit !== null) {
        const { count } = await supabase
          .from('workspaces')
          .select('id', { count: 'exact', head: true })
          .eq('team_id', team.id);
        if ((count || 0) >= limit) {
          // Partner is per-client: at the limit you ADD a client (+$ per month),
          // you don't "upgrade a tier". Everyone else upgrades.
          const partner = !!plan.perWorkspaceUsd;
          return res.status(402).json({
            error: partner ? 'add_client_required' : 'workspace_limit_reached',
            current_plan: plan.id,
            limit,
            per_workspace_usd: plan.perWorkspaceUsd ?? null,
            message: partner
              ? `You're using all ${limit} client workspaces on Partner. Each additional client is $${plan.perWorkspaceUsd}/mo — add one from billing.`
              : `Your ${plan.name} plan includes ${limit} workspace${limit === 1 ? '' : 's'}. Upgrade for more.`,
            upgrade_url: '/settings?section=billing',
          });
        }
      }
    }

    // Defensive insert — try with `country` first; if the migration hasn't
    // been applied yet, retry without it so workspace creation still works.
    const country = getCountryFromRequest(req);
    const baseInsert = { team_id: team.id, name: name.trim(), icon: icon || null };
    let { data: newWorkspace, error: wsError } = await supabase
      .from('workspaces')
      .insert(country ? { ...baseInsert, country } : baseInsert)
      .select()
      .single();
    if (wsError && country && /column.*country/i.test(wsError.message || '')) {
      const retry = await supabase.from('workspaces').insert(baseInsert).select().single();
      newWorkspace = retry.data;
      wsError = retry.error;
    }
    if (wsError) throw wsError;

    await supabase.from('workspace_members').insert({ workspace_id: newWorkspace.id, user_id: user.id, role: 'owner' });
    return res.json({ workspace: newWorkspace });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId
workspacesRouter.patch('/:workspaceId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { name, icon, company_logo, website } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(workspaceId)) return res.status(400).json({ error: 'invalid workspaceId format' });

    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      updates.name = name.trim();
    }
    if (website !== undefined) updates.website = website?.trim() || null;
    if (icon !== undefined) updates.icon = icon;
    if (company_logo !== undefined) {
      const { data: cw } = await supabase.from('workspaces').select('brand_theme').eq('id', workspaceId).single();
      updates.brand_theme = { ...(cw?.brand_theme || {}), logo_url: company_logo };
    }

    const { data: workspace, error } = await supabase.from('workspaces').update(updates).eq('id', workspaceId).select().single();
    if (error) throw error;
    return res.json({ workspace });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/workspaces/:workspaceId
workspacesRouter.delete('/:workspaceId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user, team } = await ensureUserAndTeam(req.user);

    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (membership.role !== 'owner') return res.status(403).json({ error: 'only_owner_can_delete' });

    // Delete workspace (cascade handles most data)
    const { error } = await supabase.from('workspaces').delete().eq('id', workspaceId);
    if (error) throw error;

    // Keep Partner billing in sync: the quantity tracks the client-workspace count,
    // so removing a client should drop the bill (floored at the base). Best-effort —
    // the workspace is already gone, so a Stripe hiccup just logs (never errors the
    // delete). Stripe knows nothing about workspaces, so this coupling is on us.
    if (billingEnabled() && !isSelfHosted()) {
      try {
        const { data: subscription } = await supabase
          .from('subscriptions').select('*').eq('team_id', team.id).maybeSingle();
        const plan = getPlanFromSubscription(subscription);
        if (plan.perWorkspaceUsd && subscription?.status === 'active' && subscription.stripe_subscription_id) {
          const { count } = await supabase
            .from('workspaces').select('id', { count: 'exact', head: true }).eq('team_id', team.id);
          const base = plan.baseWorkspaces ?? plan.workspaceLimit;
          const desiredQty = Math.max(base, count || 0);
          if (desiredQty < (Number(subscription.quantity) || base)) {
            await setSubscriptionQuantity(supabase, subscription, desiredQty);
          }
        }
      } catch (e) {
        console.error('[workspace delete] Partner quantity sync failed (workspace deleted, billing unchanged):', e?.message);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/workspaces/:workspaceId/settings
workspacesRouter.get('/:workspaceId/settings', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: membership } = await supabase
      .from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const { data: ws, error } = await supabase
      .from('workspaces')
      .select('id, brand_theme, target_audience, design_style, default_language, industry, notification_settings')
      .eq('id', workspaceId)
      .single();

    if (error || !ws) return res.status(404).json({ error: 'workspace_not_found' });

    let targetAudience = ws.target_audience || {};
    if (!targetAudience.company_name || !targetAudience.company_website) {
      const { data: up } = await supabase.from('users').select('company_name, website_url').eq('id', user.id).single();
      if (up) {
        targetAudience = {
          ...targetAudience,
          company_name: targetAudience.company_name || up.company_name || '',
          company_website: targetAudience.company_website || up.website_url || '',
        };
      }
    }

    return res.json({
      brand_theme: ws.brand_theme || {},
      target_audience: targetAudience,
      design_style: ws.design_style || 'corporate',
      default_language: ws.default_language || 'en',
      industry: ws.industry || 'agency',
      notification_settings: ws.notification_settings || {},
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/settings
workspacesRouter.patch('/:workspaceId/settings', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { industry, default_language, design_style } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const updateData = {};
    if (industry !== undefined) {
      if (!['agency', 'startup', 'software', 'consultancy'].includes(industry)) return res.status(400).json({ error: 'invalid_industry' });
      updateData.industry = industry;
    }
    if (default_language !== undefined) updateData.default_language = default_language;
    if (design_style !== undefined) updateData.design_style = design_style;
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'no_fields_to_update' });

    const { data: updated, error } = await supabase.from('workspaces').update(updateData).eq('id', workspaceId).select('industry, default_language, design_style').single();
    if (error) throw error;
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/settings/brand-theme
workspacesRouter.patch('/:workspaceId/settings/brand-theme', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { brand_theme } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!brand_theme || typeof brand_theme !== 'object') return res.status(400).json({ error: 'brand_theme is required' });
    const { data: membership } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: current } = await supabase.from('workspaces').select('brand_theme').eq('id', workspaceId).single();
    const { data: updated, error } = await supabase.from('workspaces')
      .update({ brand_theme: { ...(current?.brand_theme || {}), ...brand_theme } })
      .eq('id', workspaceId).select('brand_theme').single();
    if (error) throw error;
    return res.json({ brand_theme: updated.brand_theme });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/settings/target-audience
workspacesRouter.patch('/:workspaceId/settings/target-audience', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { target_audience } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!target_audience || typeof target_audience !== 'object') return res.status(400).json({ error: 'target_audience is required' });
    const { data: membership } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: current } = await supabase.from('workspaces').select('target_audience').eq('id', workspaceId).single();
    const { data: updated, error } = await supabase.from('workspaces')
      .update({ target_audience: { ...(current?.target_audience || {}), ...target_audience } })
      .eq('id', workspaceId).select('target_audience').single();
    if (error) throw error;
    return res.json({ target_audience: updated.target_audience });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/workspaces/:workspaceId/members
workspacesRouter.get('/:workspaceId/members', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: self } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!self) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const { data: members } = await supabase.from('workspace_members')
      .select('*, users:user_id(id, name, email, profile_picture_url)')
      .eq('workspace_id', workspaceId);
    return res.json({ members: members || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/workspaces/:workspaceId/members — grant access
workspacesRouter.post('/:workspaceId/members', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user_id, role = 'member' } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).single();
    if (!ws) return res.status(404).json({ error: 'workspace_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership || !['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: existing } = await supabase.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('user_id', user_id).maybeSingle();
    if (existing) return res.status(400).json({ error: 'user_already_has_access' });

    const { data: newAccess, error } = await supabase.from('workspace_members')
      .insert({ workspace_id: workspaceId, user_id, role }).select().single();
    if (error) throw error;
    return res.json({ workspace_member: newAccess });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/workspaces/:workspaceId/members/:userId
workspacesRouter.delete('/:workspaceId/members/:userId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, userId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).single();
    if (!ws) return res.status(404).json({ error: 'workspace_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership || !['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const { data: wm } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
    if (wm?.role === 'owner') return res.status(400).json({ error: 'cannot_revoke_owner_access' });

    await supabase.from('workspace_members').delete().eq('workspace_id', workspaceId).eq('user_id', userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
