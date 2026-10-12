// One-off runner for the intelligence engine. Verification + backfill only; not a
// cron. Usage inside the worker container:
//   node src/intelligence/run-once.mjs <workspaceId>
// Runs behavior extraction, every learning cadence, and recommendation matching for
// the given workspace, then prints the counts.

import { runIntelligenceOnce } from './index.mjs';

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error('usage: node src/intelligence/run-once.mjs <workspaceId>');
  process.exit(1);
}

runIntelligenceOnce(workspaceId)
  .then((r) => { console.log('[ri.run-once]', JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('[ri.run-once] failed:', e); process.exit(1); });
