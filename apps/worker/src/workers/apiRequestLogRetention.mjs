// Retention for the per-key request log (API plan C1, GET-623).
//
// api_request_log keeps 90 days: the dashboard reads 14, the by-key view at most 90, and older
// rows answer no question the product asks. prune_api_request_log() (migration
// 2026_10_03_api_request_log.sql) deletes in bounded batches so one call never runs into the
// statement timeout; this loops until a batch comes back short. Daily, off-peak.

import { getSupabaseClient } from '@nous/core';

export const RETAIN_DAYS = 90;
const BATCH = 20_000;
// A runaway guard: 50 batches is a million rows, far more than a day's worth.
const MAX_BATCHES = 50;

const isMissing = (e) => /42P01|42883|PGRST20[2-5]|does not exist|Could not find the/i
  .test(`${e?.message ?? e} ${e?.code ?? ''}`);

export async function runApiRequestLogRetention({ supabase = getSupabaseClient(), retainDays = RETAIN_DAYS } = {}) {
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await supabase.rpc('prune_api_request_log', { p_retain_days: retainDays, p_batch: BATCH });
    if (error) {
      // The hand-applied migration has not landed yet: nothing to prune, nothing to shout about.
      if (isMissing(error)) return { deleted, skipped: 'not_migrated' };
      throw new Error(`prune_api_request_log: ${error.message}`);
    }
    const n = Number(data ?? 0);
    deleted += n;
    if (n < BATCH) break;
  }
  if (deleted) console.log('[API_REQUEST_LOG] pruned %d rows older than %d days', deleted, retainDays);
  return { deleted };
}
