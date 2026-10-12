// Keep knowing which people are the workspace's own (GET-291).
//
// The one-off resolution answered "who is this customer?" once. This keeps the answer true: staff are
// hired, addresses appear in a transcript for the first time, a second brand gets connected. The
// count moved by one in the minutes between the dry run and the write, because live ingest met
// somebody new — so a fact resolved once is already out of date.
//
// It matters beyond meetings. Every backfill that resolves people — Gmail, the CRM import, calendar
// — creates contacts, and each one is a chance to file a colleague as a customer. Marking them from
// the domain makes `isEntityInternal` right for all of them at once, rather than each ingest path
// learning the same lesson separately.
//
// One implementation, used by the cron and by scripts/resolveOwnDomains.mjs. The rule that decides
// who counts as staff must not exist twice.

import { recogniseOwnPeople } from '@nous/core';

/**
 * Resolve the workspace's own domains and mark its people internal.
 *
 * The rule itself lives in @nous/core (recogniseOwnPeople), because connect runs it too and the
 * question of who counts as staff must not be answered in two places — that duplication is what
 * produced four separate bugs on 2026-09-17. This wrapper adds the one thing only the worker can
 * do: ask a note-taker whose key it holds, which is the second source of evidence.
 */
export async function resolveAndMarkOwnPeople(supabase, workspaceId, opts = {}) {
  try {
    const { getFellowConnections, fellowAccountEmail } = await import('../webhooks/handlers/fellow.mjs');
    for (const conn of await getFellowConnections(supabase, workspaceId)) {
      await fellowAccountEmail(supabase, conn).catch(() => null);
    }
  } catch { /* a workspace with no Fellow connection is not an error */ }

  return recogniseOwnPeople(supabase, workspaceId, opts);
}

/**
 * Every workspace that could have an answer — one that holds a connected source or more than one
 * seat. Run hourly; almost always a no-op, and the exception is a person who just joined.
 */
export async function sweepOwnDomains(supabase) {
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('workspace_id')
    .eq('is_verified', true);
  const workspaceIds = [...new Set((data ?? []).map(r => r.workspace_id).filter(Boolean))];
  let touched = 0;
  for (const ws of workspaceIds) {
    try {
      const r = await resolveAndMarkOwnPeople(supabase, ws);
      if (r.marked) { touched += r.marked; console.log(`[OWN_DOMAINS] ws=${ws} marked ${r.marked} new internal person(s)`); }
    } catch (err) {
      console.warn(`[OWN_DOMAINS] ws=${ws} sweep failed: ${err?.message || err}`);
    }
  }
  return { workspaces: workspaceIds.length, marked: touched };
}
