// What happens to ICP scoring when a context file is marked ICP (GET-875).
//
// The ICP scorecard is built from prose by the learned model's seed (cloud scorecardSeed.mjs,
// seedScorecardFromMemory), which reads the marked ICP file through core workspaceIcpContext.
//   - Marking a file (or editing the marked file) never re-scores silently. If the workspace has no
//     scorecard yet, the first one is built from the file (force: false: what set_icp does), so
//     accounts are scored against it from then on. An existing scorecard is left alone.
//   - "Rebuild scoring from this ICP" (POST .../icp-rebuild, owners/admins) rebuilds the scorecard
//     from the file (force: true). New accounts score against it at once; existing open scores move
//     when their account changes, or on the nightly scorecard loop for workspaces it runs for.
// On an open-source build there is no learned model; the file is kept and the answer says so.
import { workspaceIcpContext } from '@nous/core';
import { learnedIcpModel } from './icpScorer.mjs';
import { writeIcp } from './icp.mjs';

/**
 * Mirror the marked ICP file into the workspace ICP (writeIcp: the `foundations` row, the ICP note
 * and workspaces.icp_text), so everything else that reads the ICP reads the same text: readIcp and
 * query { foundation: 'icp' } (agents), and the per-contact ICP scorers (enrichment.mjs scoreICP,
 * worker enrichContact.mjs), which read the ICP notes. Called when a file is marked ICP and when the
 * ICP file is edited. With no ICP file (unmarked) it does nothing: the last text stays. Unchanged
 * text writes nothing (writeIcp would add another ICP note). A repo-authored ICP (source
 * 'claude_code') keeps its source and file path, so the next sync writes the new text back.
 * -> { status: 'mirrored' | 'unchanged' | 'no_icp_file' | 'failed' }
 */
export async function mirrorIcpFile(sb, ws, { icp = workspaceIcpContext, write = writeIcp } = {}) {
  try {
    const file = await icp(sb, ws);
    const text = String(file?.text ?? '').trim();
    if (!text) return { status: 'no_icp_file' };
    const { data: current } = await sb.from('foundations').select('body_md, source, file_path').eq('workspace_id', ws).eq('kind', 'icp').maybeSingle();
    if (String(current?.body_md ?? '').trim() === text) return { status: 'unchanged' };
    await write(sb, ws, { body_md: text, source: current?.source ?? 'nous', file_path: current?.file_path ?? null });
    return { status: 'mirrored' };
  } catch (e) {
    console.error('[icp-context-file] ICP foundation mirror failed:', e?.message || e);
    return { status: 'failed' };
  }
}

/**
 * -> { status: 'created' | 'exists' | 'external_scorer' | 'no_icp_memory' | 'translation_failed' |
 *      'not_available' | 'build_failed', signals?: number }
 */
export async function icpScoringFromFile(sb, ws, { rebuild = false, model = undefined } = {}) {
  const m = model === undefined ? await learnedIcpModel() : model;
  if (!m?.seedScorecardFromMemory) return { status: 'not_available' };
  try {
    const out = await m.seedScorecardFromMemory(sb, ws, { force: !!rebuild });
    return { status: out?.status ?? 'build_failed', signals: Array.isArray(out?.signals) ? out.signals.length : 0 };
  } catch (e) {
    console.error('[icp-context-file] scorecard build failed:', e?.message || e);
    return { status: 'build_failed' };
  }
}
