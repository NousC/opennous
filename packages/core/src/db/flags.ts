import type { SupabaseClient } from '@supabase/supabase-js';

// Flags — the persisted, deduped re-engagement worklist. One live row per
// (workspace, entity, flag_type). See docs/accounts-flagging-brief.md. The CRUD lives
// here so the worker (sweep) and the API (list + status) share one implementation.

export type FlagStatus = 'open' | 'snoozed' | 'dismissed' | 'acted' | 'resolved';

export interface Flag {
  id: string;
  workspace_id: string;
  entity_id: string;
  flag_type: string;
  reason: string | null;
  evidence: Record<string, unknown>;
  fit_score: number | null;
  momentum_score: number | null;
  priority: number;
  status: FlagStatus;
  owner_user_id: string | null;
  source: string;
  created_at: string;
  last_fired_at: string;
  snoozed_until: string | null;
  resolved_at: string | null;
}

export interface UpsertFlagParams {
  entityId: string;
  flagType: string;
  reason?: string | null;
  evidence?: Record<string, unknown>;
  fitScore?: number | null;
  momentumScore?: number | null;
  priority?: number;
  ownerUserId?: string | null;
  source?: string;
}

const COLUMNS =
  'id, workspace_id, entity_id, flag_type, reason, evidence, fit_score, momentum_score, ' +
  'priority, status, owner_user_id, source, created_at, last_fired_at, snoozed_until, resolved_at';

/**
 * Create or refresh a flag. Respects rep trust: a DISMISSED flag stays dismissed, and a
 * SNOOZED one stays quiet until its snooze expires — the sweep never re-nags. Otherwise it
 * (re)opens the flag and refreshes its reason/evidence/scores. Returns the flag, or null if
 * suppressed by dismiss/snooze.
 */
export async function upsertFlag(
  supabase: SupabaseClient,
  workspaceId: string,
  p: UpsertFlagParams,
): Promise<Flag | null> {
  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from('flags')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entity_id', p.entityId)
    .eq('flag_type', p.flagType)
    .maybeSingle();

  const e = existing as unknown as Flag | null;
  if (e) {
    if (e.status === 'dismissed') return null;
    if (e.status === 'snoozed' && e.snoozed_until && new Date(e.snoozed_until).getTime() > Date.now()) return null;
    const { data } = await supabase
      .from('flags')
      .update({
        reason: p.reason ?? e.reason,
        evidence: p.evidence ?? e.evidence,
        fit_score: p.fitScore ?? e.fit_score,
        momentum_score: p.momentumScore ?? e.momentum_score,
        priority: p.priority ?? e.priority,
        owner_user_id: p.ownerUserId ?? e.owner_user_id,
        status: 'open',
        last_fired_at: now,
        resolved_at: null,
      })
      .eq('id', e.id)
      .select(COLUMNS)
      .single();
    return (data as unknown as Flag) ?? null;
  }

  const { data } = await supabase
    .from('flags')
    .insert({
      workspace_id: workspaceId,
      entity_id: p.entityId,
      flag_type: p.flagType,
      reason: p.reason ?? null,
      evidence: p.evidence ?? {},
      fit_score: p.fitScore ?? null,
      momentum_score: p.momentumScore ?? null,
      priority: p.priority ?? 0,
      owner_user_id: p.ownerUserId ?? null,
      source: p.source ?? 'sweep',
      status: 'open',
      created_at: now,
      last_fired_at: now,
    })
    .select(COLUMNS)
    .single();
  return (data as unknown as Flag) ?? null;
}

/** Auto-clear: an OPEN flag whose condition no longer holds becomes 'resolved'. Leaves
 *  snoozed/dismissed/acted alone. No-op if there's no open flag for this (entity, type). */
export async function resolveFlagIfOpen(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  flagType: string,
): Promise<void> {
  await supabase
    .from('flags')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('flag_type', flagType)
    .eq('status', 'open');
}

/** The worklist — open (and optionally other statuses) flags, most urgent first. */
export async function listFlags(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { statuses?: FlagStatus[]; limit?: number } = {},
): Promise<Flag[]> {
  let q = supabase
    .from('flags')
    .select(COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('status', opts.statuses ?? ['open'])
    .order('priority', { ascending: false })
    .order('last_fired_at', { ascending: false });
  if (opts.limit != null) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data as unknown as Flag[]) ?? [];
}

export async function setFlagStatus(
  supabase: SupabaseClient,
  flagId: string,
  status: FlagStatus,
  opts: { snoozedUntil?: string | null } = {},
): Promise<Flag | null> {
  const patch: Record<string, unknown> = { status };
  if (status === 'snoozed') patch.snoozed_until = opts.snoozedUntil ?? null;
  if (status === 'acted' || status === 'resolved' || status === 'dismissed') patch.resolved_at = new Date().toISOString();
  const { data } = await supabase.from('flags').update(patch).eq('id', flagId).select(COLUMNS).single();
  return (data as unknown as Flag) ?? null;
}
