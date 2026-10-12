import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { writeIcp } from '../../lib/icp.mjs';
import { markWorkspaceActivated } from '../../lib/onboardingState.mjs';
import { learnedIcpModel } from '../../lib/icpScorer.mjs';

// Agent-facing foundations (the policy layer). Auth is the pk_ API key (verifyApiKey
// sets req.workspaceId), so MCP tools can read the rules before acting and push file
// edits back. The one foundation Nous keeps: icp.
export const foundationsV2Router = Router();

// ICP-only (2026-08-22). Nous holds the ICP and nothing else — positioning, voice,
// outreach and the rest are not foundations Nous tracks.
const KINDS = ['icp'];
const TITLES = { icp: 'ICP' };

/** Foundations for a workspace (one kind, or all). Also read by GET /v2/icp. */
export async function readFoundations(supabase, workspaceId, kind = null) {
  let q = supabase.from('foundations')
    .select('kind, title, body_md, source, file_path, version, synced_at, updated_at, content_hash')
    .eq('workspace_id', workspaceId);
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q.order('kind', { ascending: true });
  if (error) throw error;
  return data || [];
}

// GET /v2/foundations?kind= — read a foundation (with body). Omit kind to list all.
foundationsV2Router.get('/', async (req, res) => {
  try {
    return res.json({ foundations: await readFoundations(getSupabaseClient(), req.workspaceId, req.query.kind) });
  } catch (err) {
    console.error('[GET /v2/foundations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Write a foundation (today: the ICP) and build the scoring model from it. The one write behind
 * POST /v2/foundations/:kind and PUT /v2/icp. Returns { foundation, model } or { error }.
 */
export async function writeFoundation(supabase, workspaceId, kind, body) {
  const { body_md, file_path } = body;
  if (typeof body_md !== 'string' || !body_md.trim()) return { error: 'body_md_required' };

  // Write via writeIcp — NOT a bare foundations upsert. writeIcp also saves the
  // category:'ICP' note that seedScorecardFromMemory reads, plus the icp_text cache.
  // A direct foundations write stores text the SCORER never sees (the note is the
  // only thing it reads), which is why set_icp used to leave score at 0/10.
  // Same finish line as record_closed_deals: a hypothesis ICP written during plugin
  // onboarding still means this workspace has been set up by somebody.
  await markWorkspaceActivated(supabase, workspaceId, 'plugin:set_icp');
  await writeIcp(supabase, workspaceId, {
    body_md,
    source: file_path ? 'claude_code' : 'nous',
    file_path: file_path ?? null,
  });

  // Build the scoring model NOW so `score` works the moment the ICP is set. Without
  // this the ICP is just text and the scorecard is empty. force:false builds when no
  // model exists (the fix) and no-ops if one already exists, so a re-sync never wipes
  // signals the learning loop trained. Best-effort — never fail set_icp on a build error.
  // The scoring model is the learned ICP scorer's, Nous Cloud's (GET-754 slice 8): without it
  // `model` stays null and the workspace scores its accounts itself (POST /v2/scores).
  let model = null;
  const learned = await learnedIcpModel();
  if (learned) {
    try {
      model = await learned.seedScorecardFromMemory(supabase, workspaceId, { force: false });
    } catch (e) {
      console.error('[POST /v2/foundations/icp] model build failed:', e.message);
      model = { status: 'build_failed', message: e.message };
    }
  }

  const { data } = await supabase.from('foundations')
    .select('*').eq('workspace_id', workspaceId).eq('kind', kind).maybeSingle();
  return { foundation: data, model };
}

// POST /v2/foundations/:kind — sync a (Claude Code) file up into the graph.
// Body: { body_md, file_path?, title?, content_hash? }. Bumps version, stamps synced_at.
foundationsV2Router.post('/:kind', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { kind } = req.params;
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    const out = await writeFoundation(supabase, req.workspaceId, kind, req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json(out);
  } catch (err) {
    console.error('[POST /v2/foundations/:kind]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
