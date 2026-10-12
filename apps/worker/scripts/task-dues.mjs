#!/usr/bin/env node
// Give a date to tasks whose due phrase never became one.
//
// The resolver read English only, so a task said in French ("dès la fin de la réunion", "le 12
// novembre") or promised "after this call" kept its words and no date — and the board showed the
// words. It reads those now; this re-reads every open task that has a phrase and no date, against
// the moment it was said, in the workspace's time zone. No model call.
//
// Run (in the worker container):
//   docker compose exec worker node apps/worker/scripts/task-dues.mjs --workspace <uuid> --dry-run
//   docker compose exec worker node apps/worker/scripts/task-dues.mjs --workspace <uuid>

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
  console.error('Usage: node apps/worker/scripts/task-dues.mjs --workspace <uuid> [--dry-run]');
  process.exit(1);
}
const dryRun = flag('dry-run');
const { getSupabaseClient, resolveDuePhrase, dueDateAgreeingWith, getWorkspaceTimezone } = await import('@nous/core');
const supabase = getSupabaseClient();
const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
const PAGE = 1000;

const tasks = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from('claims').select('id, value, valid_from, computed_at')
    .eq('workspace_id', workspaceId).like('property', 'action_item.%').is('invalid_at', null)
    .is('value->>due_at', null).not('value->>due_phrase', 'is', null)
    .order('id').range(from, from + PAGE - 1);
  if (error) throw error;
  tasks.push(...data.filter(t => (t.value?.status ?? 'open') === 'open'));
  if (data.length < PAGE) break;
}
console.log(`[TASK_DUES] ${tasks.length} open tasks with a phrase and no date`);

const tally = { dated: 0, still_undated: 0, failed: 0 };
const samples = [];
for (const t of tasks) {
  const v = t.value;
  // When it was said: the first real timestamp on the row. A row can carry a null or zero
  // occurred_at, which read as 1 January 1970 and dated "after the meeting" fifty years back.
  const anchor = [v.occurred_at, v.recorded_at, t.valid_from, t.computed_at]
    .map(x => (x ? new Date(x) : null))
    .find(d => d && !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2015);
  if (!anchor) { tally.still_undated++; continue; }
  const due = dueDateAgreeingWith(resolveDuePhrase(v.due_phrase, anchor, timeZone), v.title);
  if (!due) { tally.still_undated++; continue; }
  tally.dated++;
  if (samples.length < 15) samples.push(`${v.due_phrase} → ${due}`);
  if (dryRun) continue;
  const { error } = await supabase.from('claims').update({ value: { ...v, due_at: due } })
    .eq('id', t.id).eq('workspace_id', workspaceId);
  if (error) { tally.failed++; console.warn(`[TASK_DUES] ${t.id}: ${error.message}`); }
}
console.log('[TASK_DUES]', dryRun ? 'dry run —' : 'done —', JSON.stringify(tally));
for (const s of samples) console.log('  ', s);
process.exit(tally.failed ? 1 : 0);
