import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';

// Agent-facing playbooks (the policy layer). Auth is the pk_ API key (verifyApiKey
// sets req.workspaceId), so MCP tools can read the rules before acting and push file
// edits back. The four foundations: voice, outreach, icp, positioning.
export const playbooksV2Router = Router();

const KINDS = ['voice', 'outreach', 'icp', 'positioning'];
const TITLES = { voice: 'Voice & Tone', outreach: 'Outreach', icp: 'ICP', positioning: 'Positioning' };

// GET /v2/playbooks?kind= — read a playbook (with body). Omit kind to list all.
playbooksV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { kind } = req.query;
    let q = supabase.from('playbooks')
      .select('kind, title, body_md, source, file_path, version, synced_at, updated_at, content_hash')
      .eq('workspace_id', req.workspaceId);
    if (kind) q = q.eq('kind', kind);
    const { data, error } = await q.order('kind', { ascending: true });
    if (error) throw error;
    return res.json({ playbooks: data || [] });
  } catch (err) {
    console.error('[GET /v2/playbooks]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/playbooks/:kind — sync a (Claude Code) file up into the graph.
// Body: { body_md, file_path?, title?, content_hash? }. Bumps version, stamps synced_at.
playbooksV2Router.post('/:kind', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { kind } = req.params;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    const { body_md, file_path, title, content_hash } = req.body || {};
    if (typeof body_md !== 'string') return res.status(400).json({ error: 'body_md_required' });

    const { data: existing } = await supabase.from('playbooks')
      .select('version').eq('workspace_id', req.workspaceId).eq('kind', kind).maybeSingle();
    const now = new Date().toISOString();
    const row = {
      workspace_id: req.workspaceId,
      kind,
      title: title ?? TITLES[kind],
      body_md,
      source: file_path ? 'claude_code' : 'nous',
      file_path: file_path ?? null,
      content_hash: content_hash ?? null,
      version: existing ? existing.version + 1 : 1,
      synced_at: now,
      updated_at: now,
    };
    const { data, error } = await supabase.from('playbooks')
      .upsert(row, { onConflict: 'workspace_id,kind' }).select('*').single();
    if (error) throw error;
    return res.json({ playbook: data });
  } catch (err) {
    console.error('[POST /v2/playbooks/:kind]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
