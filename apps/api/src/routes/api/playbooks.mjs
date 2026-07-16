import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const playbooksApiRouter = Router();

// Playbooks are the policy layer: versioned rule-docs that govern agent behavior
// (voice, outreach, icp, positioning), as opposed to facts. Agents read them before
// acting. One per kind per workspace. Stored as markdown; the page opens each as a
// raw .md (like notes/reports). Nous is the durable home; a row can mirror a Claude
// Code file (source='claude_code') or be authored here (source='nous').

const KINDS = ['voice', 'outreach', 'icp', 'positioning'];
const TITLES = { voice: 'Voice & Tone', outreach: 'Outreach', icp: 'ICP', positioning: 'Positioning' };

// GET /api/playbooks?workspaceId= — the workspace's playbooks (no body, for the list).
playbooksApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const { data, error } = await supabase.from('playbooks')
      .select('id, kind, title, source, file_path, version, synced_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('kind', { ascending: true });
    if (error) throw error;
    return res.json({ playbooks: data || [] });
  } catch (err) {
    console.error('[GET /api/playbooks]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/playbooks/:id?workspaceId= — one playbook with its markdown body.
playbooksApiRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const { data, error } = await supabase.from('playbooks')
      .select('*').eq('id', req.params.id).eq('workspace_id', workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'playbook_not_found' });
    return res.json({ playbook: data });
  } catch (err) {
    console.error('[GET /api/playbooks/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/playbooks/:kind?workspaceId= — upsert one playbook by kind (create or edit).
// Body: { title?, body_md, source?, file_path? }. Bumps version, stamps updated_at,
// and synced_at when the source is a Claude Code file.
playbooksApiRouter.put('/:kind', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    const { kind } = req.params;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });

    const { title, body_md, source, file_path } = req.body || {};
    const { data: existing } = await supabase.from('playbooks')
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

    const { data, error } = await supabase.from('playbooks')
      .upsert(row, { onConflict: 'workspace_id,kind' })
      .select('*').single();
    if (error) throw error;
    return res.json({ playbook: data });
  } catch (err) {
    console.error('[PUT /api/playbooks/:kind]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
