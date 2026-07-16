import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { linkedinWebhookUrl } from '../../services/linkedin.mjs';

export const linkedinRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

linkedinRouter.get('/status', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId || !UUID.test(workspaceId))
      return res.status(400).json({ error: 'invalid_workspace_id' });

    const { data } = await supabase
      .from('workspace_linkedin_connections')
      .select('id, linkedin_name, linkedin_headline, linkedin_profile_url, connected_at')
      .eq('workspace_id', workspaceId)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // A row with no profile URL means the LinkedIn link never captured (or went
    // stale on Unipile's side) — it's not usefully connected, so surface it as
    // "needs reconnect" rather than "connected" so the Connect button shows.
    const connected = !!(data && data.linkedin_profile_url);
    return res.json({
      connected,
      needs_reconnect: !!(data && !data.linkedin_profile_url),
      connection: data || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Is this workspace allowed to RUN the engagement scrape? Mirrors the worker's
// isEligible: self-host always, cloud needs an active Pro/Growth/Partner plan
// (internal id 'scale' = Partner), or the allowlist.
async function engagementEligible(supabase, workspaceId) {
  if (process.env.SELF_HOSTED === 'true') return { ok: true };
  const allow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
    .split(',').map(s => s.trim()).filter(Boolean));
  if (allow.has(workspaceId)) return { ok: true };
  const { data: ws } = await supabase
    .from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  if (!ws?.team_id) return { ok: false, reason: 'no_team' };
  const { data: sub } = await supabase
    .from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle();
  const dead = !sub || ['canceled', 'incomplete_expired', 'past_due'].includes(sub.status);
  const paid = sub && ['pro', 'growth', 'scale'].includes(sub.plan_id);
  if (dead || !paid) return { ok: false, reason: 'needs_plan' };
  return { ok: true };
}

// Manage panel for the auto-managed "LinkedIn Engagers" list: schedule, what it
// reads from, last run, the on/off state, and whether it's even available here.
linkedinRouter.get('/engagement', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId || !UUID.test(workspaceId))
      return res.status(400).json({ error: 'invalid_workspace_id' });

    // A workspace can have several connected LinkedIn accounts (one per rep) —
    // aggregate across all of them for the single workspace-level panel.
    const { data: conns } = await supabase
      .from('workspace_linkedin_connections')
      .select('linkedin_name, linkedin_profile_url, engagement_enabled, last_engagement_scrape_at')
      .eq('workspace_id', workspaceId);
    const usable = (conns || []).filter(c => c.linkedin_profile_url);

    // BYOK: the scrape runs on the workspace's own Apify key. On Cloud that key
    // MUST be connected (pure BYOK); self-host falls back to the APIFY_TOKEN env,
    // and the dogfood/pilot allowlist may use the shared env key too.
    const byokAllow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
      .split(',').map(s => s.trim()).filter(Boolean));
    let configured = (process.env.SELF_HOSTED === 'true' || byokAllow.has(workspaceId)) && !!process.env.APIFY_TOKEN;
    if (!configured) {
      const { data: provider } = await supabase
        .from('workflow_providers').select('id').eq('name', 'apify').maybeSingle();
      if (provider?.id) {
        const { data: pc } = await supabase
          .from('workflow_provider_connections')
          .select('id').eq('workspace_id', workspaceId).eq('provider_id', provider.id)
          .eq('is_verified', true).limit(1).maybeSingle();
        configured = !!pc;
      }
    }

    const connected = usable.length > 0;
    const elig = connected ? await engagementEligible(supabase, workspaceId) : { ok: false, reason: 'not_connected' };
    const reason = !connected ? 'not_connected'
      : !configured ? 'no_apify_key'
      : elig.ok ? null : elig.reason;
    // Enabled if any connected account is actively scraping; the toggle flips them all.
    const enabled = connected ? usable.some(c => c.engagement_enabled !== false) : true;
    const readsFrom = usable.map(c => c.linkedin_name || c.linkedin_profile_url).filter(Boolean).join(', ') || null;

    // Last on-demand/cron scrape across this workspace's accounts + a suggested
    // backfill window (days since that scrape, capped) so the UI/agent can offer
    // "it's been N days — backfill that window".
    const lastScrapedAt = usable
      .map(c => c.last_engagement_scrape_at).filter(Boolean).sort().slice(-1)[0] || null;
    const suggestedBackfillDays = lastScrapedAt
      ? Math.min(120, Math.max(7, Math.ceil((Date.now() - new Date(lastScrapedAt).getTime()) / 86400000)))
      : null;

    const { data: last } = await supabase
      .from('workspace_system_log')
      .select('summary, occurred_at, metadata')
      .eq('workspace_id', workspaceId).eq('source', 'linkedin_engagement').eq('event_type', 'run')
      .order('occurred_at', { ascending: false }).limit(1).maybeSingle();

    return res.json({
      available: configured && connected && elig.ok,
      reason,                                   // null when available; else why not
      enabled,
      reads_from: readsFrom,
      schedule: 'Weekly · Mondays',
      window: { posts: Number(process.env.ENGAGEMENT_MAX_POSTS || 5), days: Number(process.env.ENGAGEMENT_WINDOW_DAYS || 7) },
      self_host: process.env.SELF_HOSTED === 'true',
      byok: true,
      last_scraped_at: lastScrapedAt,
      suggested_backfill_days: suggestedBackfillDays,
      last_run: last ? { summary: last.summary, at: last.occurred_at, metadata: last.metadata } : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Toggle the weekly scrape on/off for this workspace.
linkedinRouter.patch('/engagement', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, enabled } = req.body || {};
    if (!workspaceId || !UUID.test(workspaceId))
      return res.status(400).json({ error: 'invalid_workspace_id' });
    if (typeof enabled !== 'boolean')
      return res.status(400).json({ error: 'enabled_must_be_boolean' });

    const { error } = await supabase
      .from('workspace_linkedin_connections')
      .update({ engagement_enabled: enabled })
      .eq('workspace_id', workspaceId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, enabled });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

linkedinRouter.get('/connect', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId || !UUID.test(workspaceId))
      return res.status(400).json({ error: 'invalid_workspace_id' });

    if (!process.env.UNIPILE_API_KEY || !process.env.UNIPILE_DSN)
      return res.status(503).json({ error: 'linkedin_not_configured' });

    const dsn = process.env.UNIPILE_DSN;
    const apiKey = process.env.UNIPILE_API_KEY;
    const baseUrl = `https://${dsn}`;

    const response = await fetch(`${baseUrl}/api/v1/hosted/accounts/link`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'create',
        providers: ['LINKEDIN'],
        api_url: `${process.env.APP_URL}/api/linkedin/callback?workspace_id=${workspaceId}`,
        success_redirect_url: `${process.env.APP_URL}/api/linkedin/callback?workspace_id=${workspaceId}`,
        failure_redirect_url: `${process.env.APP_URL}/integrations?linkedin=error`,
        notify_url: linkedinWebhookUrl(workspaceId),
      }),
    });
    const data = await response.json();
    if (!data.url) return res.status(500).json({ error: 'failed_to_create_auth_link' });
    return res.json({ url: data.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

linkedinRouter.get('/disconnect', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    await supabase.from('workspace_linkedin_connections').delete().eq('workspace_id', workspaceId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
