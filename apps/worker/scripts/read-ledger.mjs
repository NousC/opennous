#!/usr/bin/env node
// The read ledger (workers/readLedger.mjs) for one workspace, on demand — e.g. to record the reads
// a backfill made before the ledger existed. Writes one noema.read per meeting or call; no model.
//   docker compose exec worker node apps/worker/scripts/read-ledger.mjs --workspace <uuid> [--since 2026-08-01]
import '../src/bootEnv.mjs';
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const workspaceId = val('workspace');
if (!workspaceId) { console.error('Usage: node apps/worker/scripts/read-ledger.mjs --workspace <uuid> [--since ISO]'); process.exit(1); }
const { getSupabaseClient } = await import('@nous/core');
const { sweepWorkspace, repriceMeetings } = await import('../src/workers/readLedger.mjs');
if (args.includes('--reprice')) {
  // Meeting reads recorded at the 30-minute median, moved to their real length where the meeting
  // record has one (GET-516).
  const n = await repriceMeetings(getSupabaseClient(), workspaceId, { since: val('since') ?? new Date(Date.now() - 60 * 86400000).toISOString() });
  console.log(`[READ_LEDGER] ${workspaceId} ${n} meeting read(s) repriced`);
} else {
  const n = await sweepWorkspace(getSupabaseClient(), workspaceId, { since: val('since') });
  console.log(`[READ_LEDGER] ${workspaceId} ${n} read(s) recorded`);
}
process.exit(0);
