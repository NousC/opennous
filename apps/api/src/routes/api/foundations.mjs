import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const foundationsApiRouter = Router();

// The ICP, and nothing else. This route is the last surviving piece of the Vault-era
// "policy layer" (voice / outreach / positioning rule-docs, table renamed from
// playbooks 2026-07-24). The Vault UI retired 2026-07-31, the company vault was cut
// 2026-08-30, and /v2/foundations went ICP-only 2026-08-22 — this was the one write
// path still able to mint a legacy kind, so it is closed now. Company knowledge lives
// in the company repo; what buyers tell us lives in `insights` (a different table,
// written by record_insight, which powers the founder reporting). Do not confuse the
// two: `insights.category = 'positioning'` is live and unrelated to the dead kind here.

const KINDS = ['icp'];
const TITLES = { icp: 'ICP' };

// GET /api/foundations?workspaceId= — the workspace's foundations (no body, for the list).
foundationsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const [{ data, error }, { data: ws }] = await Promise.all([
      supabase.from('foundations')
        .select('id, kind, title, source, file_path, version, synced_at, updated_at')
        .eq('workspace_id', workspaceId)
        .order('kind', { ascending: true }),
      // The workspace domain — drives the logo-by-domain header shown on the ICP doc,
      // so the agent-onboarded (and every) user sees their own mark on top of their ICP.
      supabase.from('workspaces').select('website').eq('id', workspaceId).maybeSingle(),
    ]);
    if (error) throw error;
    const website = ws?.website ? String(ws.website).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').split('?')[0].toLowerCase() : null;
    return res.json({ foundations: data || [], website });
  } catch (err) {
    console.error('[GET /api/foundations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/foundations/:id?workspaceId= — one foundation with its markdown body.
foundationsApiRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const { data, error } = await supabase.from('foundations')
      .select('*').eq('id', req.params.id).eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'foundation_not_found' });
    return res.json({ foundation: data });
  } catch (err) {
    console.error('[GET /api/foundations/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/foundations/:kind?workspaceId= — upsert one foundation by kind (create or edit).
// Body: { title?, body_md, source?, file_path? }. Bumps version, stamps updated_at,
// and synced_at when the source is a Claude Code file.
foundationsApiRouter.put('/:kind', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    const { kind } = req.params;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });

    const { title, body_md, source, file_path } = req.body || {};
    const { data: existing } = await supabase.from('foundations')
      .select('version').eq('workspace_id', workspaceId).eq('kind', kind).maybeSingle();

    const now = new Date().toISOString();
    const row = {
      workspace_id: workspaceId,
      kind,
      title: title ?? TITLES[kind],
      body_md: body_md ?? '',
      source: source === 'claude_code' ? 'claude_code' : 'nous',
      file_path: file_path ?? null,
      version: existing ? existing.version + 1 : 1,
      synced_at: source === 'claude_code' ? now : null,
      updated_at: now,
    };

    const { data, error } = await supabase.from('foundations')
      .upsert(row, { onConflict: 'workspace_id,kind' })
      .select('*').single();
    if (error) throw error;
    return res.json({ foundation: data });
  } catch (err) {
    console.error('[PUT /api/foundations/:kind]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
