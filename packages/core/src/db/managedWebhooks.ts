import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// The "After every call" automation as a real webhook (GET-672).
//
// The Settings → Automations toggle used to set a flag on the seat (personal_workspaces) that a
// separate queue, github_dispatches, read. Now the toggle owns a GitHub webhook in
// trigger_subscriptions: one per seat, managed_by 'after_call', pointed at the seat's connected repo
// with the seat's own token. It is visible on the Webhooks page like any other, with the same
// delivery log, retries and test send.
//
// It listens for conversation.call_ended, which fires at the same moment the old dispatch did:
// after the call is reviewed, once per call. It sends event_type nous.meeting_held, the name every
// after-call workflow already installed listens for, so nothing in anyone's repo has to change.
//
// The seat stays the source of truth (the toggle flag, the repo, the token); this module only makes
// the webhook match it. syncAfterCallWebhook runs on every toggle and repo connect/disconnect, and
// the worker runs reconcileAfterCallWebhooks every few minutes, which is also how seats that were
// already on get their webhook the first time the new code runs.

export const AFTER_CALL_MANAGED = 'after_call';
export const AFTER_CALL_SEAT_EVENT = 'interaction.meeting_held';      // the flag the toggle sets
export const AFTER_CALL_WEBHOOK_EVENT = 'conversation.call_ended';     // what the webhook listens for
export const AFTER_CALL_GITHUB_EVENT_TYPE = 'nous.meeting_held';      // what installed workflows expect

interface Seat {
  workspace_id: string;
  user_id: string;
  source_type: string | null;
  github_repo: string | null;
  github_token_enc: string | null;
  automation_enabled: boolean | null;
  automation_events: string[] | null;
}

const SEAT_COLUMNS = 'workspace_id, user_id, source_type, github_repo, github_token_enc, automation_enabled, automation_events';

/** Does this seat want an after-call webhook, and can it have one (repo connected, token held)? */
export function seatWantsAfterCall(seat: Seat | null): boolean {
  if (!seat?.automation_enabled) return false;
  // An empty list means meeting_held: that is how the old queue read it (githubDispatch.ts).
  const events = seat.automation_events?.length ? seat.automation_events : [AFTER_CALL_SEAT_EVENT];
  if (!events.includes(AFTER_CALL_SEAT_EVENT)) return false;
  return seat.source_type === 'github' && !!seat.github_repo && !!seat.github_token_enc;
}

export type AfterCallSync = 'created' | 'updated' | 'unchanged' | 'removed' | 'none';

async function managedFor(supabase: SupabaseClient, workspaceId: string, userId: string) {
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .select('id, github_repo, github_token_enc, events, active, github_event_type')
    .eq('workspace_id', workspaceId).eq('owner_user_id', userId).eq('managed_by', AFTER_CALL_MANAGED)
    .maybeSingle();
  if (error) throw new Error(`failed to read managed webhook: ${error.message}`);
  return data as { id: string; github_repo: string | null; github_token_enc: string | null; events: string[]; active: boolean; github_event_type: string | null } | null;
}

/** Make one seat's after-call webhook match its toggle and repo. Idempotent. */
export async function syncAfterCallWebhook(supabase: SupabaseClient, workspaceId: string, userId: string, seatIn?: Seat | null): Promise<AfterCallSync> {
  let seat = seatIn;
  if (seat === undefined) {
    const { data, error } = await supabase.from('personal_workspaces').select(SEAT_COLUMNS)
      .eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(`failed to read seat: ${error.message}`);
    seat = data as Seat | null;
  }
  const existing = await managedFor(supabase, workspaceId, userId);
  const want = seatWantsAfterCall(seat ?? null);

  if (!want) {
    if (!existing) return 'none';
    const { error } = await supabase.from('trigger_subscriptions').delete().eq('id', existing.id);
    if (error) throw new Error(`failed to remove managed webhook: ${error.message}`);
    return 'removed';
  }

  const fields = {
    destination_type: 'github',
    url: null,
    github_repo: seat!.github_repo,
    github_token_enc: seat!.github_token_enc,
    github_event_type: AFTER_CALL_GITHUB_EVENT_TYPE,
    events: [AFTER_CALL_WEBHOOK_EVENT],
    active: true,
  };
  if (!existing) {
    const { error } = await supabase.from('trigger_subscriptions').insert({
      workspace_id: workspaceId,
      owner_user_id: userId,
      managed_by: AFTER_CALL_MANAGED,
      name: 'After every call',
      // GitHub never sees it; the column is NOT NULL and a URL edit would need one.
      signing_secret: 'whsec_' + crypto.randomBytes(24).toString('base64url'),
      ...fields,
    });
    // A concurrent sync won the unique index: the webhook exists, which is all we wanted.
    if (error && error.code !== '23505') throw new Error(`failed to create managed webhook: ${error.message}`);
    return 'created';
  }

  const same = existing.github_repo === fields.github_repo && existing.github_token_enc === fields.github_token_enc
    && existing.active && existing.github_event_type === fields.github_event_type
    && existing.events.length === 1 && existing.events[0] === AFTER_CALL_WEBHOOK_EVENT;
  if (same) return 'unchanged';
  const { error } = await supabase.from('trigger_subscriptions')
    .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', existing.id);
  if (error) throw new Error(`failed to update managed webhook: ${error.message}`);
  return 'updated';
}

/**
 * Every seat that has, or should have, an after-call webhook, brought into line. The worker runs it
 * on a schedule; the first run after deploy is the migration of seats that were already on.
 */
export async function reconcileAfterCallWebhooks(supabase: SupabaseClient): Promise<Record<AfterCallSync, number>> {
  const out: Record<AfterCallSync, number> = { created: 0, updated: 0, unchanged: 0, removed: 0, none: 0 };
  const [{ data: seats, error: e1 }, { data: managed, error: e2 }] = await Promise.all([
    supabase.from('personal_workspaces').select(SEAT_COLUMNS).eq('automation_enabled', true),
    supabase.from('trigger_subscriptions').select('workspace_id, owner_user_id').eq('managed_by', AFTER_CALL_MANAGED),
  ]);
  if (e1) throw new Error(`failed to list seats: ${e1.message}`);
  if (e2) throw new Error(`failed to list managed webhooks: ${e2.message}`);

  const seen = new Set<string>();
  for (const seat of (seats ?? []) as Seat[]) {
    seen.add(`${seat.workspace_id}:${seat.user_id}`);
    try { out[await syncAfterCallWebhook(supabase, seat.workspace_id, seat.user_id, seat)]++; }
    catch (err) { console.warn('[after-call webhooks] sync failed', seat.workspace_id, seat.user_id, (err as Error).message); }
  }
  // A managed webhook whose seat turned automation off entirely: remove it.
  for (const m of (managed ?? []) as { workspace_id: string; owner_user_id: string }[]) {
    if (seen.has(`${m.workspace_id}:${m.owner_user_id}`)) continue;
    try { out[await syncAfterCallWebhook(supabase, m.workspace_id, m.owner_user_id)]++; }
    catch (err) { console.warn('[after-call webhooks] cleanup failed', m.workspace_id, m.owner_user_id, (err as Error).message); }
  }
  return out;
}

/** Seats in a workspace whose after-call already runs through a webhook: the old queue skips them. */
export async function seatsWithAfterCallWebhook(supabase: SupabaseClient, workspaceId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('trigger_subscriptions').select('owner_user_id')
    .eq('workspace_id', workspaceId).eq('managed_by', AFTER_CALL_MANAGED).eq('active', true);
  // Columns not there yet (migration lag): nobody has moved, the old queue keeps everyone.
  if (error) return new Set();
  return new Set((data ?? []).map(r => (r as { owner_user_id: string }).owner_user_id));
}

export type ConnectedRepoSource = 'personal' | 'company';

async function connectedRow(supabase: SupabaseClient, workspaceId: string, userId: string | null, source: ConnectedRepoSource) {
  const q = source === 'company'
    ? supabase.from('company_workspaces').select('source_type, github_repo, github_token_enc').eq('workspace_id', workspaceId)
    : supabase.from('personal_workspaces').select('source_type, github_repo, github_token_enc').eq('workspace_id', workspaceId).eq('user_id', userId ?? '');
  const { data, error } = await q.maybeSingle();
  // company_workspaces may not exist on an older database: no company repo, not an error.
  if (error) {
    if (source === 'company' && (error.code === '42P01' || error.code === 'PGRST205')) return null;
    throw new Error(`failed to read ${source} repo: ${error.message}`);
  }
  const s = data as { source_type: string | null; github_repo: string | null; github_token_enc: string | null } | null;
  if (!s || s.source_type !== 'github' || !s.github_repo || !s.github_token_enc) return null;
  return s;
}

/**
 * The repos already connected in Settings that a webhook can deliver to, without their tokens: the
 * person's own (Settings → Repo) and the workspace's company repo. GET-674.
 */
export async function connectedRepos(supabase: SupabaseClient, workspaceId: string, userId: string | null): Promise<{ source: ConnectedRepoSource; repo: string }[]> {
  const out: { source: ConnectedRepoSource; repo: string }[] = [];
  if (userId) {
    const p = await connectedRow(supabase, workspaceId, userId, 'personal');
    if (p) out.push({ source: 'personal', repo: p.github_repo! });
  }
  const c = await connectedRow(supabase, workspaceId, null, 'company');
  if (c) out.push({ source: 'company', repo: c.github_repo! });
  return out;
}

/** A connected repo as a webhook destination, for { destination: { type: 'github', connected_repo } }. */
export async function connectedRepoDestination(
  supabase: SupabaseClient, workspaceId: string, userId: string | null, source: ConnectedRepoSource = 'personal',
): Promise<{ type: 'github'; repo: string; tokenEnc: string } | null> {
  const s = await connectedRow(supabase, workspaceId, userId, source);
  return s ? { type: 'github', repo: s.github_repo!, tokenEnc: s.github_token_enc! } : null;
}

