import { Router } from 'express';
import { getSupabaseClient, getWorkspaceMemberProfiles, getWorkspaceStages, saveWorkspaceStages } from '@nous/core';
import { captureProductEvent } from '../../lib/productEvents.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { JOB_ROLES } from './me.mjs';
import { getPlanFromSubscription, effectiveWorkspaceLimit, isSelfHosted } from '../../lib/plans.mjs';
import { billingEnabled, setSubscriptionQuantity } from '../../lib/billingHooks.mjs';
import { getCountryFromRequest } from '../../lib/geo.mjs';
import { sanitizeModelPolicy } from '../../lib/model.mjs';
import { accountCountries } from '../../lib/listRows.mjs';
import { recordConnectionRemovals, connectionsOfWorkspaces } from '../../lib/audit.mjs';

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
    captureProductEvent({ distinctId: user.id, event: 'workspace_created', properties: { source: 'manual' }, workspaceId: newWorkspace.id });
    return res.json({ workspace: newWorkspace });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId
// GET /api/workspaces/:workspaceId/stages — the workspace's pipeline-stage vocabulary (the
// labels the board renders). Empty until onboarding captures them. Any member reads.
workspacesRouter.get('/:workspaceId/stages', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    // `?pipelineId=` asks for ONE CRM pipeline's ladder. Without it, the workspace's own —
    // which is what every caller meant before pipelines were a concept. A pipeline we have not
    // adopted falls back to the workspace's rather than to nothing.
    const pipelineRef = String(req.query.pipelineId ?? '').trim() || null;
    const stages = await getWorkspaceStages(supabase, workspaceId, { pipelineRef });
    return res.json({ stages, pipeline_ref: pipelineRef });
  } catch (err) {
    console.error('[GET /api/workspaces/:id/stages]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/workspaces/:workspaceId/stages — replace the stage set (owner/admin). For a
// future Settings editor; the onboarding agent writes via its own tool.
workspacesRouter.put('/:workspaceId/stages', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });
    const stages = Array.isArray(req.body?.stages) ? req.body.stages : null;
    if (!stages) return res.status(400).json({ error: 'stages_required' });
    const saved = await saveWorkspaceStages(supabase, workspaceId, stages);
    return res.json({ ok: true, stages: saved });
  } catch (err) {
    console.error('[PUT /api/workspaces/:id/stages]', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

workspacesRouter.patch('/:workspaceId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { name, icon, company_logo, website, timezone } = req.body;
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
    if (timezone !== undefined) {
      // IANA zone name, validated against Intl — the authority resolveDuePhrase
      // uses. Empty/null clears it back to the env/UTC fallback.
      const tz = typeof timezone === 'string' ? timezone.trim() : '';
      if (tz) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch {
          return res.status(400).json({ error: 'invalid_timezone' });
        }
        updates.timezone = tz;
      } else {
        updates.timezone = null;
      }
    }
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

    // Delete workspace (cascade handles most data). Its connections are recorded as removed (GET-901).
    const cascaded = await connectionsOfWorkspaces(supabase, [workspaceId]);
    const { error } = await supabase.from('workspaces').delete().eq('id', workspaceId);
    if (error) throw error;
    recordConnectionRemovals(supabase, cascaded, { actor: { user_id: user.id, email: req.user?.email ?? null, ip: req.ip ?? null }, via: 'workspace_deleted' });

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
      .select('id, brand_theme, target_audience, design_style, default_language, industry, open_account_visibility, model_policy, focus_country')
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
      open_account_visibility: ws.open_account_visibility === true, // default CLOSED when unset
      model_policy: ws.model_policy ?? null, // null = every model allowed (no policy)
      // The market this workspace works (GET-318). null = everywhere. Sent with the countries the
      // workspace actually has, so the setting offers real choices rather than a list of the world.
      focus_country: ws.focus_country ?? null,
      countries: await accountCountries(supabase, workspaceId).catch(() => []),
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
    const { industry, default_language, design_style, focus_country } = req.body;
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
    // The market the workspace opens on (GET-318). Empty string or null means everywhere; any
    // other value must be a country the workspace actually has, so a typo cannot empty every list.
    if (focus_country !== undefined) {
      const wanted = focus_country === null || focus_country === '' ? null : String(focus_country);
      if (wanted) {
        const known = await accountCountries(supabase, workspaceId).catch(() => []);
        if (!known.some(c => c.country === wanted)) return res.status(400).json({ error: 'unknown_country' });
      }
      updateData.focus_country = wanted;
    }
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'no_fields_to_update' });

    const { data: updated, error } = await supabase.from('workspaces').update(updateData).eq('id', workspaceId).select('industry, default_language, design_style, focus_country').single();
    if (error) throw error;
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/visibility — owner/admin only. Toggle whether
// every member sees all accounts (open) or only the accounts they own (restricted).
workspacesRouter.patch('/:workspaceId/visibility', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { open } = req.body;
    if (typeof open !== 'boolean') return res.status(400).json({ error: 'open_boolean_required' });
    const { user } = await ensureUserAndTeam(req.user);

    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const { error } = await supabase.from('workspaces').update({ open_account_visibility: open }).eq('id', workspaceId);
    if (error) throw error;
    return res.json({ open_account_visibility: open });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/model-policy — owner/admin only. Set which models
// may touch this workspace's data (allowlist) and the org default. Pass a body of
// { allowlist: string[], default?: string } of model keys; an empty/absent allowlist
// CLEARS the policy (every model allowed again). Enforced server-side at the turn.
workspacesRouter.patch('/:workspaceId/model-policy', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: membership } = await supabase
      .from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    // sanitizeModelPolicy drops unknown keys and returns null for an empty allowlist,
    // so a bad or empty payload safely clears the policy rather than locking the workspace.
    const policy = sanitizeModelPolicy(req.body);
    const { error } = await supabase.from('workspaces').update({ model_policy: policy }).eq('id', workspaceId);
    if (error) throw error;
    return res.json({ model_policy: policy });
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

// GET /api/workspaces/:workspaceId/access-log — the ownership & access provenance
// trail: who gained access to which account and how (co-attendance vs a manual
// assignment), and every manual assign / revoke. Read from the tamper-evident
// audit_log. Any workspace member can view their workspace's access log.
workspacesRouter.get('/:workspaceId/access-log', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: self } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!self) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const { data: rows } = await supabase.from('audit_log')
      .select('id, actor_user_id, action, target_id, metadata, created_at')
      .eq('target_workspace_id', workspaceId)
      .in('action', [
        'ownership.assigned', 'ownership.removed', 'access.granted',
        // Credential & integration lifecycle — the security-sensitive events.
        'apikey.created', 'apikey.revoked', 'cli.token_issued',
        'integration.connect', 'integration.disconnect',
        'member.role_changed',
      ])
      .order('created_at', { ascending: false })
      .limit(200);
    const events = rows || [];

    // Resolve people to names + avatars, and accounts to display names.
    const profiles = await getWorkspaceMemberProfiles(supabase, workspaceId);
    const targetIds = [...new Set(events.map(e => e.target_id).filter(Boolean))];
    const nameById = new Map();
    if (targetIds.length) {
      const [cos, cts] = await Promise.all([
        supabase.from('companies').select('id, name').in('id', targetIds),
        supabase.from('contacts').select('id, first_name, last_name, company').in('id', targetIds),
      ]);
      for (const c of cos.data || []) nameById.set(c.id, c.name || null);
      for (const c of cts.data || []) nameById.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || 'Contact');
    }

    const log = events.map(e => {
      // For a role change the affected person is the target user; otherwise it's
      // whichever member the metadata names (ownership / access events).
      const memberId = e.action === 'member.role_changed' ? e.target_id : (e.metadata?.member_user_id ?? null);
      const memberProf = memberId ? profiles.get(memberId) : null;
      const actorProf = e.actor_user_id ? profiles.get(e.actor_user_id) : null;
      return {
        id: e.id,
        action: e.action,
        at: e.created_at,
        via: e.metadata?.via ?? null,   // 'manual' | 'co-attendance'
        actor_name: actorProf?.name ?? (e.actor_user_id ? 'A teammate' : 'Nous'),
        member_name: memberProf?.name ?? null,
        member_avatar: memberProf?.avatar ?? null,
        account_id: e.target_id,
        account_name: nameById.get(e.target_id) ?? null,
        // For credential/integration events: the human label (key name, provider).
        // For a role change: the new role.
        meta_label: e.metadata?.provider ?? e.metadata?.name ?? e.metadata?.role ?? null,
      };
    });
    return res.json({ log });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/workspaces/:workspaceId/governance — the founder control room. Read-only
// aggregates over data that already exists: the estate at a glance (accounts, people,
// observations), the connected sources, and per-member ownership (accounts owned,
// accounts they're in touch with, observations attributed). Any workspace member may
// view it. Counts are head-only, so we never ship the underlying rows.
workspacesRouter.get('/:workspaceId/governance', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);

    const { data: self } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!self) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const countOf = async (table) => {
      const { count } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
      return count || 0;
    };

    // "Accounts" = companies where we have a REAL contact (engaged), not every company ever
    // created. Cold lead-list imports (Sales Nav / Lookalike / engager scrapes) spin up a
    // company per lead but you've never talked to them — those are prospecting leads, not
    // accounts, and they must not inflate the estate. A company earns account status the
    // moment someone there becomes a contact; cold companies (no contact) never count.
    // Self-maintaining: no marking, no cleanup — engagement promotes, cold stays out.
    const countEngagedAccounts = async () => {
      const { data } = await supabase.from('contacts')
        .select('company_id').eq('workspace_id', workspaceId).not('company_id', 'is', null);
      return new Set((data || []).map((r) => r.company_id)).size;
    };

    // ── Connected sources ──
    const srcP = supabase
      .from('workflow_provider_connections')
      .select('id, name, provider_id, is_verified, created_at, last_used_at, owner_user_id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true });

    // ── Every relationship_owner claim, read once and tallied per member ──
    const relP = supabase
      .from('claims').select('value')
      .eq('workspace_id', workspaceId).eq('property', 'relationship_owner').is('invalid_at', null);

    const [accounts, people, observations, profiles, memRes, srcRes, relRes] = await Promise.all([
      countEngagedAccounts(),
      countOf('contacts'),
      countOf('observations'),
      getWorkspaceMemberProfiles(supabase, workspaceId),
      supabase.from('workspace_members').select('user_id, role').eq('workspace_id', workspaceId),
      srcP,
      relP,
    ]);

    const memberList = memRes.data || [];

    // Real "last activity" per source: last_used_at is never populated, so derive it
    // from the most recent observation that came from this provider. The provider's
    // slug (gmail_oauth, fireflies, cal_com, apify…) prefix-matches observations.source
    // (gmail, fireflies, cal_com, apify_linkedin…). Providers that produce no timeline
    // data (Stripe, NeverBounce, Apollo…) simply have no match — we show the connect date.
    const connRows = srcRes.data || [];
    const provIds = [...new Set(connRows.map(s => s.provider_id).filter(Boolean))];
    const { data: provRows } = provIds.length
      ? await supabase.from('workflow_providers').select('id, name').in('id', provIds)
      : { data: [] };
    const slugById = new Map((provRows || []).map(p => [p.id, String(p.name || '').toLowerCase()]));
    const keyByConn = new Map();      // connection id -> source prefix
    for (const s of connRows) {
      const slug = slugById.get(s.provider_id);
      if (slug) keyByConn.set(s.id, slug.replace(/_oauth$/, '')); // gmail_oauth -> gmail
    }
    // "When did this source last bring something in?" — one row, and it used to cost a full
    // sequential scan of `observations` PER CONNECTED SOURCE, in parallel. Measured: 26 seconds
    // and a million rows read for a single timestamp, or more often death at the 8s statement
    // timeout, which is why this page hung.
    //
    // The cause was `ILIKE`: `~~*` cannot use a btree index, so no index could ever have helped.
    // Nearly every source is stored as an exact slug ('hubspot', 'gmail', 'fellow'), so an equality
    // match answers almost every case from observations_ws_source_ingested. The prefix match stays
    // as a fallback for the handful of sources whose stored value is decorated — 'LinkedIn
    // Sequencer' against a provider slug of 'linkedin' is a real row in production — so the page
    // still shows the same answer it always did, it just stops paying for it every time.
    const lastActiveByKey = new Map();
    await Promise.all([...new Set(keyByConn.values())].map(async (k) => {
      const newest = () => supabase
        .from('observations')
        .select('ingested_at')
        .eq('workspace_id', workspaceId)
        .order('ingested_at', { ascending: false })
        .limit(1);
      let { data } = await newest().eq('source', k);
      if (!data?.length) ({ data } = await newest().ilike('source', `${k}%`));
      if (data && data[0]) lastActiveByKey.set(k, data[0].ingested_at);
    }));

    const sources = connRows.map(s => {
      const k = keyByConn.get(s.id);
      return {
        id: s.id, name: s.name, verified: !!s.is_verified,
        owner_user_id: s.owner_user_id ?? null,
        provider: slugById.get(s.provider_id) ?? null,
        connected_at: s.created_at,
        last_active: s.last_used_at || (k ? lastActiveByKey.get(k) : null) || null,
      };
    });

    // owner = whoever the account is attributed to (assigned owner, else primary);
    // in-touch = everyone who appears in the account's members list.
    const owned = new Map();
    const inTouch = new Map();
    const bump = (map, id) => { if (id) map.set(id, (map.get(id) || 0) + 1); };
    for (const row of relRes.data || []) {
      const v = row.value || {};
      bump(owned, v.assigned ?? v.primary ?? null);
      for (const m of Array.isArray(v.members) ? v.members : []) bump(inTouch, m.user_id);
    }

    // Observations attributed to each member (owner_user_id) — one head-count each.
    const obsByMember = new Map();
    await Promise.all(memberList.map(async (m) => {
      const { count } = await supabase
        .from('observations').select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('owner_user_id', m.user_id);
      obsByMember.set(m.user_id, count || 0);
    }));

    const members = memberList.map(m => {
      const p = profiles.get(m.user_id);
      return {
        user_id: m.user_id,
        name: p?.name ?? 'Unknown',
        avatar: p?.avatar ?? null,
        role: m.role,
        accounts_owned: owned.get(m.user_id) || 0,
        accounts_in_touch: inTouch.get(m.user_id) || 0,
        observations: obsByMember.get(m.user_id) || 0,
      };
    }).sort((a, b) => b.accounts_owned - a.accounts_owned || b.observations - a.observations);

    return res.json({
      estate: { accounts, people, observations, sources: sources.length, members: members.length },
      sources,
      members,
    });
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

// GET /api/workspaces/:workspaceId/member-roles — each member's assigned role(s), keyed by
// user id. Used by the Members page and the role-scoped surfaces. Any member may read.
workspacesRouter.get('/:workspaceId/member-roles', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const { data: self } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!self) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    const { data: rows } = await supabase.from('workspace_members')
      .select('user_id, job_role, job_roles').eq('workspace_id', workspaceId);
    const roles = {};
    for (const r of rows ?? []) {
      roles[r.user_id] = Array.isArray(r.job_roles) && r.job_roles.length ? r.job_roles : (r.job_role ? [r.job_role] : []);
    }
    return res.json({ roles });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/workspaces/:workspaceId/members/:userId/roles — the founder assigns a member's
// role(s). Owner/admin only. Writes the multi-role array; job_role (singular) mirrors the
// primary so older reads still work.
workspacesRouter.patch('/:workspaceId/members/:userId/roles', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, userId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    const { data: membership } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership || !['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'insufficient_permissions' });

    const incoming = Array.isArray(req.body?.roles) ? req.body.roles : [];
    const roles = [...new Set(incoming.filter((r) => JOB_ROLES.includes(r)))];
    const { error } = await supabase.from('workspace_members')
      .update({ job_roles: roles, job_role: roles[0] ?? null })
      .eq('workspace_id', workspaceId).eq('user_id', userId);
    if (error) throw error;
    return res.json({ ok: true, roles });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
