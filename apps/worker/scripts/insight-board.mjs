#!/usr/bin/env node
// Place a workspace's existing insights on the Insights board: the one-time extraction pass over
// insights already in Supabase. Nothing is pulled from the client's systems (that is a backfill).
//
// The nightly job (apps/worker/src/workers/insightBoard.mjs) places whatever is unplaced, so on a
// workspace that has never been through it, the first night does this pass over all its insights. This script runs that
// same job on demand, for one workspace, so it can be watched, previewed and paid for knowingly.
//
// What it does, per workspace (all on Haiku through the model door, under the one-writer lock in backfill_locks):
//   - proposes the workspace's first tag list from its own insights, if it has none
//   - gives every unplaced insight one board button and 1-3 tags, and ties it to its account
//   - writes a headline, concrete problems and three quotes for each row raised by 3+ accounts
//
// Measured in a sandbox on a customer workspace (a couple of thousand insights): well under a dollar
// to place and summarise, on Haiku. Transcripts are never re-read; this reads the stored insights.
//
// Run (in the worker container, where @nous/core and the job already live):
//   docker compose exec worker node apps/worker/scripts/insight-board.mjs --workspace <uuid> --dry-run
//   docker compose exec worker node apps/worker/scripts/insight-board.mjs --workspace <uuid>
//   docker compose exec worker node apps/worker/scripts/insight-board.mjs --workspace <uuid> --all   # also rewrite every row
//
// --dry-run asks the model and prints what it would write, and writes nothing (it still costs the
// model calls). Apply supabase/migrations/2026_09_24_insight_board.sql first — without it the job
// says so and places nothing.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const envPath = val('env') || '.env';
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* env may already be in the process (worker host) */ }

const workspaceId = val('workspace');
if (!workspaceId) {
  console.error('Usage: node apps/worker/scripts/insight-board.mjs --workspace <uuid> [--dry-run] [--all] [--resort] [--retag] [--limit N]');
  process.exit(1);
}

const { runInsightBoard } = await import('../src/workers/insightBoard.mjs');
// Stopped mid-run (a deploy, ctrl-c): give the workspace lock back so the next run is not locked out.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(sig, async () => {
    const { releaseHeldLocks } = await import('@nous/core');
    await releaseHeldLocks().catch(() => {});
    console.log(`[INSIGHT_BOARD] ${sig}: lock released, stopping; the next run continues from here`);
    process.exit(1);
  });
}
const stats = await runInsightBoard({
  workspaceId,
  dryRun: flag('dry-run'),
  all: flag('all'),
  // Sort everything again under the current buttons and rules (and rename every row).
  resort: flag('resort'),
  // Also rebuild the model's tag list first (implies --resort).
  retag: flag('retag'),
  limit: val('limit') ? Number(val('limit')) : undefined,
});
process.exit(stats.failed ? 1 : 0);
