import { seatsWithAfterCallWebhook } from './managedWebhooks.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// GitHub repository_dispatch queue — the server side of the plugin's automation
// layer (GET-73 / GET-74). When an automation-relevant interaction lands (v1:
// meeting_held), we enqueue one dispatch per automation-enabled seat repo. The
// worker (apps/worker/src/workers/githubDispatch.mjs) drains it and POSTs a
// repository_dispatch to GitHub using that seat's stored fine-grained token, so
// the seat's GitHub Action runs the plugin headlessly (the `after-call` skill)
// on their OWN tokens. Durable + retried + dead-lettered, mirroring the
// outbound_events trigger delivery — but the sink is GitHub, not an arbitrary URL.

export interface DispatchRow {
  id: string;
  workspace_id: string;
  user_id: string;
  repo: string;
  event_type: string;
  dedup_key: string;
  client_payload: Record<string, unknown>;
  entity_id: string | null;
  occurred_at: string;
  delivered_at: string | null;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  dead_lettered_at: string | null;
}

export interface DispatchEnqueueParams {
  workspaceId: string;
  eventType: string;                        // e.g. 'interaction.meeting_held'
  entityId: string | null;                  // the contact the interaction is about
  occurredAt: string;
  dedupKey: string;                         // collapses re-fires (external id, else entity:occurred_at)
  clientPayload: Record<string, unknown>;   // small — GitHub caps client_payload
}

/**
 * Fan out a repository_dispatch enqueue to every automation-enabled seat repo in
 * the workspace that subscribes to this event. One deduped row per seat. Best
 * effort — the caller wraps this so an unhealthy automation layer never fails the
 * activity write. Returns how many rows were enqueued.
 */
export async function enqueueGithubDispatches(
  supabase: SupabaseClient,
  p: DispatchEnqueueParams,
): Promise<number> {
  const { data: seats } = await supabase
    .from('personal_workspaces')
    .select('user_id, github_repo, automation_events')
    .eq('workspace_id', p.workspaceId)
    .eq('source_type', 'github')
    .eq('automation_enabled', true)
    .not('github_repo', 'is', null);

  if (!seats?.length) return 0;

  // A seat whose after-call now runs through its webhook (GET-672) is skipped here, so the move to
  // webhooks never runs a call twice and never drops one: until the webhook exists, this queue keeps it.
  const moved = await seatsWithAfterCallWebhook(supabase, p.workspaceId);

  let n = 0;
  for (const s of seats as Array<{ user_id: string; github_repo: string; automation_events: string[] | null }>) {
    if (moved.has(s.user_id)) continue;
    const events = Array.isArray(s.automation_events) && s.automation_events.length
      ? s.automation_events
      : ['interaction.meeting_held'];
    if (!events.includes(p.eventType)) continue;

    // Idempotent on (workspace, seat, event, dedup_key): a duplicate fire of the
    // same interaction collapses to the existing row instead of a second Action run.
    const { error } = await supabase
      .from('github_dispatches')
      .upsert(
        {
          workspace_id: p.workspaceId,
          user_id: s.user_id,
          repo: s.github_repo,
          event_type: p.eventType,
          dedup_key: p.dedupKey,
          client_payload: p.clientPayload,
          entity_id: p.entityId,
          occurred_at: p.occurredAt,
        },
        { onConflict: 'workspace_id,user_id,event_type,dedup_key', ignoreDuplicates: true },
      );
    if (!error) n++;
  }
  return n;
}

// ── Drain side (worker) ──────────────────────────────────────────────────────

/** Pending, ready-to-send dispatches, oldest first. */
export async function fetchPendingDispatches(
  supabase: SupabaseClient,
  limit = 50,
): Promise<DispatchRow[]> {
  const { data } = await supabase
    .from('github_dispatches')
    .select('*')
    .is('delivered_at', null)
    .is('dead_lettered_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  return (data as DispatchRow[]) ?? [];
}

export async function markDispatchDelivered(
  supabase: SupabaseClient,
  id: string,
  attempts: number,
  statusCode: number,
): Promise<void> {
  await supabase.from('github_dispatches').update({
    delivered_at: new Date().toISOString(),
    attempts: attempts + 1,
    last_status_code: statusCode,
    last_error: null,
  }).eq('id', id);
}

// 0 · 1m · 5m · 15m · 1h · 3h. attempts >= MAX (or the 99 sentinel for a permanent
// client error) dead-letters the row so it stops retrying.
const BACKOFF_MS = [0, 60_000, 300_000, 900_000, 3_600_000, 10_800_000];
const MAX_ATTEMPTS = 6;

export async function markDispatchFailure(
  supabase: SupabaseClient,
  id: string,
  attempts: number,
  statusCode: number | null,
  error: string | null,
): Promise<void> {
  const next = attempts + 1;
  const dead = next >= MAX_ATTEMPTS || attempts >= 99;
  const delayMs = BACKOFF_MS[Math.min(next, BACKOFF_MS.length - 1)];
  await supabase.from('github_dispatches').update({
    attempts: next,
    last_status_code: statusCode,
    last_error: (error ?? '').slice(0, 500),
    next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
    dead_lettered_at: dead ? new Date().toISOString() : null,
  }).eq('id', id);
}
