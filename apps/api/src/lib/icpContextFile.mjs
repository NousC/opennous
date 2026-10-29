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
//
// Who scores (GET-878, decided 2026-10-14): a workspace with a marked ICP file is scored by Nous from
// it (workspaces.icp_scorer = 'nous'); External applies only when there is no ICP file. Marking a
// file (or rebuilding from it) on a workspace whose scorer is 'external' is confirmed first
// (markIcpFile: 409 icp_scorer_switch_required, nothing written), then switches the workspace to
// 'nous' and builds the scorecard from the file (force: the old scorecard was not in use). Scores
// already posted from outside (ext:) stay until they resolve. Unmarking never switches back; going
// to External is the separate PUT /v2/icp/scorer. An open-source build never switches.
import { getIcpScorer, setIcpScorer, workspaceIcpContext } from '@nous/core';
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
  if (!m?.seedScorecardFromMemory) return { status: 'not_available', message: ICP_NOT_AVAILABLE_MESSAGE };
  try {
    const out = await m.seedScorecardFromMemory(sb, ws, { force: !!rebuild });
    return { status: out?.status ?? 'build_failed', signals: Array.isArray(out?.signals) ? out.signals.length : 0 };
  } catch (e) {
    console.error('[icp-context-file] scorecard build failed:', e?.message || e);
    return { status: 'build_failed' };
  }
}

export const ICP_SCORER_SWITCH_CODE = 'icp_scorer_switch_required';
export const ICP_SCORER_SWITCH_MESSAGE = "Nous will score this workspace's accounts from this file from now on. Scores already posted from outside stay until they resolve.";
export const ICP_NOT_AVAILABLE_MESSAGE = "The file is saved. Nous's learned ICP scorer is available on Nous Cloud only, so this workspace scores its own accounts: post them to POST /v2/scores.";

/**
 * Mark a file ICP, or rebuild scoring from the ICP file, with the scorer switch (GET-878).
 * `write` does the marking (createContextFile / updateContextFile; a no-op for a rebuild) and runs
 * only after the confirmation check, so a refused request writes nothing. `admin`: the caller is a
 * workspace owner/admin; anyone else is not asked to confirm and `write` refuses them.
 *   - scorer 'external' (with a learned scorer) and no `confirm`: 409 { code: icp_scorer_switch_required }.
 *   - 'external' with `confirm`: write, setIcpScorer('nous'), mirror, scorecard from the file (force).
 *   - 'nous': write, mirror, scorecard (force only for a rebuild): today's behaviour.
 *   - no learned scorer (open-source): write, mirror, { status: 'not_available', message }; no switch.
 * -> { result: <write's result>, icp: { status, signals?, message?, foundation, scorer_switched? } }
 */
export async function markIcpFile(sb, ws, { confirm = false, rebuild = false, admin = true } = {}, write = async () => null, deps = {}) {
  const model = deps.model === undefined ? await learnedIcpModel() : deps.model;
  const { scorer = getIcpScorer, setScorer = setIcpScorer, mirror = mirrorIcpFile } = deps;
  const switching = admin && !!model?.seedScorecardFromMemory && (await scorer(sb, ws)) === 'external';
  if (switching && !confirm) {
    throw Object.assign(new Error(ICP_SCORER_SWITCH_MESSAGE), { status: 409, reply: { code: ICP_SCORER_SWITCH_CODE, scorer: 'external' } });
  }
  const result = await write();
  if (switching) await setScorer(sb, ws, 'nous');
  const foundation = (await mirror(sb, ws)).status;
  const scoring = await icpScoringFromFile(sb, ws, { rebuild: rebuild || switching, model });
  return { result, icp: { ...scoring, foundation, ...(switching ? { scorer: 'nous', scorer_switched: true } : {}) } };
}
