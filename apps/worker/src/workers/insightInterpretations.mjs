// GTM insights, nightly (GET-1006): our interpretation of every insight that has reached 5 accounts.
//
// The insight engine (workers/insightPatterns.mjs) counts and titles insights hourly; this writes
// what each one means for us (packages/core/src/db/insightInterpretation.mjs). An insight is skipped
// until it reaches the next step (10, 15, 20… accounts), so a quiet night costs a few reads and no
// model call. Capped per workspace per night; what is left waits for tomorrow.
//
// On Cloud it is the API plan's (no other plan pays for an interpretation it cannot see); a
// self-hosted install interprets every workspace.
//
//   node apps/worker/src/workers/insightInterpretations.mjs [--workspace=UUID]   (one run, by hand)

import { getSupabaseClient, insightBoardModel, patternsToInterpret, interpretPattern } from '@nous/core';
import { createMessage, messageText } from '../lib/llm.mjs';
import { isApiPlanWorkspace } from '../lib/evidence/writeEvidence.mjs';
import { isSelfHosted, loadCloud } from '../lib/cloud.mjs';

const PER_WORKSPACE = 20;
const PAGE = 1000;

export async function runInsightInterpretations(opts = {}) {
  const supabase = getSupabaseClient();
  const stats = { workspaces: 0, written: 0, skipped: 0, failed: 0 };
  // Workspaces with an insight over its bar, paged so none is cut off.
  const wsIds = new Set(opts.workspaceId ? [opts.workspaceId] : []);
  if (!opts.workspaceId) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('insight_patterns').select('workspace_id').eq('at_bar', true)
        .order('workspace_id').range(from, from + PAGE - 1);
      if (error) { console.error('[INSIGHT_INTERPRET] scan failed:', error.message); return stats; }
      for (const r of data ?? []) wsIds.add(r.workspace_id);
      if (!data || data.length < PAGE) break;
    }
  }
  for (const ws of wsIds) {
    if (!isSelfHosted() && !(await isApiPlanWorkspace(supabase, ws))) continue;
    const ask = async (prompt) => messageText(await createMessage({
      meter: { workspaceId: ws }, feature: 'gtm-insight-interpretation', max_tokens: 1200, model: insightBoardModel(),
      accept: (t) => /\{[\s\S]*\}/.test(t), messages: [{ role: 'user', content: prompt }],
    })) || '';
    let due;
    try { due = await patternsToInterpret(supabase, ws); } catch (e) { stats.failed++; console.warn('[INSIGHT_INTERPRET]', ws, e.message); continue; }
    if (due === null) { console.warn('[INSIGHT_INTERPRET] interpretation columns missing — apply supabase/migrations/2026_10_22_insight_pattern_interpretations.sql'); return stats; }
    stats.workspaces++;
    let calls = 0;
    for (const { id } of due) {
      if (calls >= PER_WORKSPACE) break;
      try {
        const r = await interpretPattern(supabase, ws, id, { ask });
        if (r.status === 'not_set_up') { console.warn('[INSIGHT_INTERPRET] interpretation columns missing'); return stats; }
        if (r.status === 'no_context') { stats.skipped++; break; }   // nothing to read it against: same for every insight
        if (r.status === 'written') { stats.written++; calls++; }
        else { stats.skipped++; if (r.status === 'unusable' || r.status === 'model_unavailable') calls++; }
      } catch (e) { stats.failed++; calls++; console.warn('[INSIGHT_INTERPRET]', ws, id, e.message); }
    }
  }
  console.log('[INSIGHT_INTERPRET]', JSON.stringify(stats));
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ws = (process.argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
  await loadCloud();   // on Cloud, registers the context library as part of who we are
  await runInsightInterpretations({ workspaceId: ws });
  process.exit(0);
}
