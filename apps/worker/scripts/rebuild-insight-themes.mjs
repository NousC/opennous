#!/usr/bin/env node
// Rebuild a workspace's insight themes under the per-category engine. RUN ONCE, at deploy.
//
// WHY THIS EXISTS
//
// Themes created before 2026-09-20 came out of a single pass that clustered all four
// categories together under a shared budget of twelve, and let the model re-decide each
// theme's category. The result was tabs that bore no relation to the insights under them:
// on 2026-09-20 one workspace's Market tab held one theme covering dozens of insights from
// separate calls, while Product held five. A customer workspace with over a thousand insights held
// none at all, so its Product tab was rendering hundreds of raw cards.
//
// Routing cannot repair that shape: it only ever adds to the themes that exist. The old
// themes have to be released and clustered again, once, per category. After this run the
// nightly job routes and never rebuilds, so this script is not something to reach for
// again. If you find yourself running it a second time, the question to ask is why the
// router refused the insights, not whether to re-cluster.
//
// WHAT IT DOES. Per category: hands every insight back to the unclustered pool, retires
// (does NOT delete) the old themes so any status row pointing at one still resolves, then
// clusters from scratch. Old themes are retired, so statuses attached to them do not
// survive — on 2026-09-20 every status row in the DB was already orphaned by the previous
// engine, so there is nothing live to lose, but check before running on a workspace that
// has been curating themes since the fix.
//
// Run (in the worker container, where @nous/core and the job already live):
//   docker compose exec worker node apps/worker/scripts/rebuild-insight-themes.mjs --all
//   docker compose exec worker node apps/worker/scripts/rebuild-insight-themes.mjs --workspace <uuid>
//   docker compose exec worker node apps/worker/scripts/rebuild-insight-themes.mjs --all --dry-run
//
// It lives under apps/worker/ and not the repo's top-level scripts/ for one reason: the
// worker image copies apps/worker and packages/core and nothing else, so a script in
// scripts/ is simply not in the container it needs to run in.
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and the model-door keys in the env, the
// same as the worker. Apply supabase/migrations/2026_09_20_insight_theme_durability.sql
// first — without insight_items.theme_id this exits rather than half-running.

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
const all = flag('all');
if (!workspaceId && !all) {
  console.error('Usage: node apps/worker/scripts/rebuild-insight-themes.mjs --workspace <uuid> | --all [--dry-run]');
  process.exit(1);
}

const { getSupabaseClient } = await import('@nous/core');
const supabase = getSupabaseClient();

// Refuse to run against a schema that has not been migrated: a half-run leaves themes
// retired and nothing rebuilt, which is strictly worse than not starting.
{
  const { error } = await supabase.from('insight_items').select('theme_id').limit(1);
  if (error) {
    console.error('insight_items.theme_id is missing — apply supabase/migrations/2026_09_20_insight_theme_durability.sql first.');
    console.error(error.message);
    process.exit(1);
  }
}

if (flag('dry-run')) {
  const q = supabase.from('insight_items').select('workspace_id, category, source', { count: 'exact' }).eq('source', 'external');
  const { data } = workspaceId ? await q.eq('workspace_id', workspaceId).range(0, 4999) : await q.range(0, 4999);
  const byWs = new Map();
  for (const r of data || []) {
    if (!byWs.has(r.workspace_id)) byWs.set(r.workspace_id, {});
    const b = byWs.get(r.workspace_id);
    b[r.category] = (b[r.category] || 0) + 1;
  }
  for (const [ws, b] of byWs) console.log(ws, JSON.stringify(b));
  console.log('\nDry run — nothing written. Drop --dry-run to rebuild.');
  process.exit(0);
}

const { runInsightThemes } = await import('../src/workers/insightThemes.mjs');
const stats = await runInsightThemes({ ...(workspaceId ? { workspaceId } : {}), rebuild: true, force: true });
console.log('\nDone:', JSON.stringify(stats, null, 2));
process.exit(0);
