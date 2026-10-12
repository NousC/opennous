#!/usr/bin/env node
// Name the owner on email tasks that were written without one.
//
// The email reader looked for the sender among the workspace's seats only. A client's team works
// the inbox without logging in, so on a customer workspace hundreds of open email tasks were filed with no owner and
// the Tasks page gave every one of them to the founder. The CRM had the answer all along: each
// HubSpot email carries owner_email / owner_name, and a sent message its `from`. This reads the
// thread the task came from and writes that person onto the task. No model call.
//
// Run (in the worker container):
//   docker compose exec worker node apps/worker/scripts/task-owners.mjs --workspace <uuid> --dry-run
//   docker compose exec worker node apps/worker/scripts/task-owners.mjs --workspace <uuid>

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
  console.error('Usage: node apps/worker/scripts/task-owners.mjs --workspace <uuid> [--dry-run]');
  process.exit(1);
}
const dryRun = flag('dry-run');
const { getSupabaseClient } = await import('@nous/core');
const supabase = getSupabaseClient();
const PAGE = 1000;

const tasks = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from('claims').select('id, value')
    .eq('workspace_id', workspaceId).like('property', 'action_item.%').is('invalid_at', null)
    .eq('value->>source_type', 'email').is('value->>owner_email', null)
    .order('id').range(from, from + PAGE - 1);
  if (error) throw error;
  tasks.push(...data.filter(t => t.value?.owner_kind !== 'prospect' && t.value?.source_id && !String(t.value.source_id).startsWith('subj-')));
  if (data.length < PAGE) break;
}
console.log(`[TASK_OWNERS] ${tasks.length} email tasks with no owner`);

// One thread lookup per thread, not per task.
const ownerOfThread = new Map();
async function threadOwner(threadId) {
  if (ownerOfThread.has(threadId)) return ownerOfThread.get(threadId);
  const { data } = await supabase.from('observations').select('raw')
    .eq('workspace_id', workspaceId).eq('raw->>thread_id', threadId).limit(20);
  let found = null;
  for (const o of data ?? []) {
    const raw = o.raw ?? {};
    const email = String(raw.owner_email || (raw.direction === 'EMAIL' ? raw.from : '') || '').trim().toLowerCase();
    if (email.includes('@')) { found = { email, name: raw.owner_name || null }; break; }
  }
  ownerOfThread.set(threadId, found);
  return found;
}

const tally = { named: 0, unknown: 0, failed: 0 };
const who = new Map();
for (const t of tasks) {
  const owner = await threadOwner(String(t.value.source_id));
  if (!owner) { tally.unknown++; continue; }
  who.set(owner.email, (who.get(owner.email) ?? 0) + 1);
  tally.named++;
  if (dryRun) continue;
  const { error } = await supabase.from('claims')
    .update({ value: { ...t.value, owner_email: owner.email, owner_name: t.value.owner_name ?? owner.name } })
    .eq('id', t.id).eq('workspace_id', workspaceId);
  if (error) { tally.failed++; console.warn(`[TASK_OWNERS] ${t.id}: ${error.message}`); }
}
console.log('[TASK_OWNERS]', dryRun ? 'dry run —' : 'done —', tally, Object.fromEntries(who));
process.exit(tally.failed ? 1 : 0);
