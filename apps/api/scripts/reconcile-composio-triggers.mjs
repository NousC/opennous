#!/usr/bin/env node
/**
 * Reconcile Composio triggers with our connection rows (GET-234).
 *
 * For every Composio-managed connection: make sure its account holds the provider's triggers
 * and the row lists the ids Composio actually has. Then list the triggers in the Composio
 * project whose connected account NO row holds — each one delivers webhooks the worker drops
 * as 'unknown_connection'.
 *
 * USAGE (inside the api container, from /app/apps/api):
 *   node scripts/reconcile-composio-triggers.mjs                     # plan only: prints what it would do
 *   node scripts/reconcile-composio-triggers.mjs --apply             # create missing triggers, fix row ids
 *   node scripts/reconcile-composio-triggers.mjs --apply --delete-orphans   # also delete orphan triggers
 *
 * Idempotent. Read-only without --apply.
 */

import { getSupabaseClient } from '@nous/core';
import { loadComposioConfig, getComposioClient, reconcileComposioTriggers, PROVIDER_MAP } from '../src/providers/composio.mjs';

const APPLY = process.argv.includes('--apply');
const DELETE_ORPHANS = process.argv.includes('--delete-orphans');

const supabase = getSupabaseClient();
const { data: conns, error } = await supabase
  .from('workflow_provider_connections')
  .select('id, workspace_id, owner_user_id, account_email, composio_connection_id, composio_trigger_ids, workflow_providers!inner(name)')
  .eq('managed_by', 'composio')
  .not('composio_connection_id', 'is', null);
if (error) { console.error(error.message); process.exit(1); }

const known = new Set((conns || []).map(c => c.composio_connection_id));
const slugOf = (t) => String(t.triggerName || t.trigger_slug || t.triggerSlug || '').toUpperCase();
const caOf = (t) => t.connectedAccountId || t.connected_account_id || null;

let composioForProject = null;
for (const conn of conns || []) {
  const provider = conn.workflow_providers?.name;
  const cfg = await loadComposioConfig(supabase, conn.workspace_id);
  const composio = getComposioClient(cfg.apiKey, cfg.baseUrl);
  composioForProject ||= composio;

  const list = await composio.triggers.listActive({ connectedAccountIds: [conn.composio_connection_id] }).catch(() => ({ items: [] }));
  const have = (list?.items || []).map(slugOf);
  const missing = (PROVIDER_MAP[provider]?.triggerSlugs || []).filter(s => !have.includes(s));
  console.log(`${conn.id} ${provider} ${conn.composio_connection_id} has=[${have}] missing=[${missing}] row=[${conn.composio_trigger_ids || []}]`);

  if (APPLY) {
    const r = await reconcileComposioTriggers({ supabase, composio, connection: conn, provider });
    console.log(`  → ids=[${r.ids}] created=[${r.created}]`);
  }
}

if (composioForProject) {
  const all = await composioForProject.triggers.listActive({}).catch(() => ({ items: [] }));
  const orphans = (all?.items || []).filter(t => caOf(t) && !known.has(caOf(t)));
  for (const t of orphans) {
    console.log(`orphan trigger ${t.id} ${slugOf(t)} on ${caOf(t)}${APPLY && DELETE_ORPHANS ? ' → deleting' : ''}`);
    if (APPLY && DELETE_ORPHANS) await composioForProject.triggers.delete(t.id).catch(e => console.warn('  delete failed:', e.message));
  }
}
process.exit(0);
