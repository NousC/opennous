#!/usr/bin/env node
// The nightly email read (workers/emailThreadsDaily.mjs), on demand for one workspace — to see how
// much is waiting, or to catch up after a gap.
//
// Run (in the worker container):
//   docker compose exec worker node apps/worker/scripts/email-daily.mjs --workspace <uuid> --count            # what is due; no model calls
//   docker compose exec worker node apps/worker/scripts/email-daily.mjs --workspace <uuid> --days 6 --max 500 # read it
//   … --days 60 --max 5000 --mark-skips   record why threads were skipped, read nothing (no model calls)

import '../src/bootEnv.mjs';

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const workspaceId = val('workspace');
if (!workspaceId) {
  console.error('Usage: node apps/worker/scripts/email-daily.mjs --workspace <uuid> [--days 2] [--max 300] [--count]');
  process.exit(1);
}
const days = Number(val('days') ?? 3);
const { runEmailThreadsDaily } = await import('../src/workers/emailThreadsDaily.mjs');
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(sig, async () => {
    const { releaseHeldLocks } = await import('@nous/core');
    await releaseHeldLocks().catch(() => {});
    process.exit(1);
  });
}
await runEmailThreadsDaily({ workspaceId, days, maxThreads: Number(val('max') ?? 400), concurrency: Number(val('concurrency') ?? 4), dryRun: args.includes('--count'), markSkipsOnly: args.includes('--mark-skips') });
process.exit(0);
