// The ICP — one write path, because it used to have four homes and they disagreed.
//
// Before this file existed the ICP could land in any of these, depending on which road
// the user walked in on:
//
//   playbooks (kind='icp')  — what the Vault renders and what get_playbook serves to an
//                             agent before it acts. Written by sync_playbook and the
//                             partner onboarding agent.
//   notes (category='ICP')  — what seedScorecardFromMemory reads. It is the ONLY input to
//                             the scoring model. Written by set_workspace_profile.
//   workspaces.icp_text     — written by the in-app onboarding road, and read by nothing
//                             except the gate that asked whether onboarding was done.
//
// So a human who finished the in-app road wrote `icp_text`, which meant: the Vault showed
// nothing, their agent got nothing from get_playbook, and the scoring model was never
// seeded. The gate flipped to "onboarded" and the workspace was exactly as empty as before.
//
// Hence: ONE function. Every road calls it, it writes every home, and the playbook is the
// authority. An ICP that doesn't reach the scorecard is decoration, so writing the note is
// not optional and not a separate step someone can forget.
//
// See internal/ONBOARDING.md §4.

import { saveNote } from '@nous/core';

/** Never let a bookkeeping write take down the caller. */
async function safe(fn) {
  try { return await fn(); } catch (err) {
    console.error('[icp] non-fatal write failed:', err?.message || err);
    return null;
  }
}

/**
 * Write the workspace's ICP. The playbook row is the authority; the note is what the
 * scoring model learns from; `icp_text` is kept as a cache for the surfaces that still
 * read it (GET /api/mind/icp).
 *
 * @param {object}  supabase
 * @param {string}  workspaceId
 * @param {object}  opts
 * @param {string}  opts.body_md    the ICP itself, markdown
 * @param {'nous'|'claude_code'} [opts.source='nous']
 *        Who authors it. 'claude_code' means a file in THEIR repo is the author and we are
 *        the mirror — so an edit made in the Vault has to land back in that file on the next
 *        sync, which is why file_path travels with it.
 * @param {string|null} [opts.file_path=null]  required in spirit when source is claude_code
 */
export async function writeIcp(supabase, workspaceId, { body_md, source = 'nous', file_path = null }) {
  const text = String(body_md ?? '').trim();
  if (!workspaceId) throw new Error('writeIcp: workspaceId required');
  if (!text) throw new Error('writeIcp: body_md required');

  // 1. The playbook. This is the ICP — the Vault reads it, get_playbook serves it, and
  //    /api/onboarding/status gates on its existence.
  const { data: existing } = await supabase
    .from('playbooks')
    .select('version')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'icp')
    .maybeSingle();

  const now = new Date().toISOString();
  const { error } = await supabase.from('playbooks').upsert({
    workspace_id: workspaceId,
    kind: 'icp',
    title: 'ICP',
    body_md: text,
    source,
    file_path,
    content_hash: null,
    version: existing ? existing.version + 1 : 1,
    synced_at: now,
    updated_at: now,
  }, { onConflict: 'workspace_id,kind' });
  if (error) throw new Error(`writeIcp: playbook upsert failed — ${error.message}`);

  // 2. The note. seedScorecardFromMemory reads THIS and nothing else, so an ICP that skips
  //    it never reaches scoring — which is the whole reason this function exists.
  await safe(() => saveNote(supabase, workspaceId, {
    category: 'ICP',
    content: text,
    source: 'onboarding',
  }));

  // 3. The cache. GET /api/mind/icp still reads the column; keeping it in step costs one
  //    write and saves a class of "the app shows a different ICP than the agent does" bug.
  //    It is NOT the authority and nothing gates on it any more.
  await safe(() => supabase.from('workspaces').update({ icp_text: text }).eq('id', workspaceId));

  return { ok: true, version: existing ? existing.version + 1 : 1 };
}

/**
 * Does this workspace have an ICP? The single definition of "onboarded".
 *
 * The playbook row, and only the playbook row. Not business_type (a label the agent happened
 * to set on its way past), not icp_text (which fed nothing). A workspace with a business_type
 * and no ICP is not set up, it just looks like it is.
 */
export async function hasIcp(supabase, workspaceId) {
  if (!workspaceId) return false;
  const { data } = await supabase
    .from('playbooks')
    .select('body_md')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'icp')
    .maybeSingle();
  return !!(data?.body_md && data.body_md.trim());
}
