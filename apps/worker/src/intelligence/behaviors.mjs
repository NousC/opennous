// The behavior-extraction runner. Runs every registered extractor for a workspace
// and writes the behaviors it produces. Extractors are pure functions of the graph
// at time T, so this is safe to re-run and safe to backfill — the DB unique key
// makes writes idempotent.

import { getExtractors } from './registry.mjs';
import { upsertBehaviors, recordRun } from './db.mjs';

export async function runBehaviorExtractors(supabase, workspaceId) {
  const extractors = getExtractors();
  if (!extractors.length) return { extractors: 0, behaviors: 0 };

  let written = 0;
  for (const ex of extractors) {
    try {
      const ctx = { supabase, workspaceId, extractor: ex };
      const behaviors = (await ex.extract(ctx)) ?? [];
      // Stamp the extractor's key + version onto each behavior it forgot to set.
      const stamped = behaviors.map((b) => ({
        ...b,
        key: b.key ?? ex.key,
        subjectType: b.subjectType ?? ex.subjectType,
        extractorVersion: b.extractorVersion ?? ex.version ?? 1,
      }));
      written += await upsertBehaviors(supabase, workspaceId, stamped);
    } catch (err) {
      console.warn(`[ri.behaviors] ${ex.key} failed:`, err?.message);
    }
  }
  await recordRun(supabase, 'behaviors', workspaceId, { extractors: extractors.length, behaviors: written });
  return { extractors: extractors.length, behaviors: written };
}
