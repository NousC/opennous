import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallScore, CallType, DimensionScore } from '../services/callScoring.js';
import type { CallRecording } from '../services/callPage.js';

// Coaching v2 (GET-83): the scorecard store. One row per call. Written by the worker's scorer,
// read by the Coaching page (trends/radar) and — via get_account/get_context (GET-84) — the
// after-call skill. Idempotent per (workspace, meeting): a re-score replaces.

export interface ScorecardInput {
  workspaceId: string;
  meetingId: string;
  source?: string | null;
  entityId?: string | null;
  repUserId?: string | null;
  rubricRole?: string | null;
  rubricVersion?: number | null;
  overall: number;           // 1–10, one decimal
  scores: DimensionScore[];
  nextStepSecured: boolean;
  occurredAt: string;
  // The page text from the same review pass (GET-236), so a scorecard can be re-read whole.
  callType?: string | null;
  summary?: string | null;
  verdict?: string | null;
  wentWell?: string | null;
  improve?: string | null;
  // GET-246: every teammate on the call gets Coaching credit; every recording of it is listed.
  teamUserIds?: string[];
  recordings?: CallRecording[];
}

export interface ScorecardRow extends ScorecardInput {
  id: string;
  createdAt: string;
}

export async function upsertScorecard(supabase: SupabaseClient, s: ScorecardInput): Promise<void> {
  await supabase.from('call_scorecards').upsert(
    {
      workspace_id:      s.workspaceId,
      meeting_id:        s.meetingId,
      source:            s.source ?? null,
      entity_id:         s.entityId ?? null,
      rep_user_id:       s.repUserId ?? null,
      rubric_role:       s.rubricRole ?? null,
      rubric_version:    s.rubricVersion ?? null,
      overall:           s.overall,
      scores:            s.scores,
      next_step_secured: s.nextStepSecured,
      occurred_at:       s.occurredAt,
      call_type:         s.callType ?? null,
      summary:           s.summary ?? null,
      verdict:           s.verdict ?? null,
      went_well:         s.wentWell ?? null,
      improve:           s.improve ?? null,
      team_user_ids:     [...new Set((s.teamUserIds ?? []).filter(Boolean))],
      recordings:        s.recordings ?? [],
    },
    { onConflict: 'workspace_id,meeting_id' },
  );
}

/** The stored columns of a scorecard, as the scorer reads them back. */
export interface ScorecardStored {
  meeting_id: string;
  source: string | null;
  entity_id: string | null;
  rep_user_id: string | null;
  rubric_role: string | null;
  rubric_version: number | null;
  overall: number | string;
  scores: DimensionScore[];
  next_step_secured: boolean | null;
  occurred_at: string;
  call_type: string | null;
  summary: string | null;
  verdict: string | null;
  went_well: string | null;
  improve: string | null;
  document_id: string | null;
  team_user_ids: string[] | null;
  recordings: CallRecording[] | null;
}

/**
 * The scorecard of a call already reviewed from ANOTHER recording (GET-246): two teammates each
 * record the same meeting with their own note-taker. Same people on it, within a few hours, and a
 * different recording id. Null when this is the first recording of the call.
 */
export async function findScorecardForCall(
  supabase: SupabaseClient,
  workspaceId: string,
  call: { contactIds: string[]; occurredAt: string; meetingId: string; windowHours?: number },
): Promise<ScorecardStored | null> {
  const t = Date.parse(call.occurredAt);
  if (!call.contactIds.length || !Number.isFinite(t)) return null;
  const w = (call.windowHours ?? 3) * 3600_000;
  const { data } = await supabase.from('call_scorecards')
    .select('meeting_id, source, entity_id, rep_user_id, rubric_role, rubric_version, overall, scores, next_step_secured, occurred_at, call_type, summary, verdict, went_well, improve, document_id, team_user_ids, recordings')
    .eq('workspace_id', workspaceId)
    .in('entity_id', call.contactIds)
    .gte('occurred_at', new Date(t - w).toISOString())
    .lte('occurred_at', new Date(t + w).toISOString())
    .neq('meeting_id', call.meetingId)
    .order('occurred_at', { ascending: true })
    .limit(1);
  return ((data ?? [])[0] as ScorecardStored | undefined) ?? null;
}

/** A stored scorecard as the CallScore the page is built from — re-laying a page costs no model call. */
export function callScoreFromStored(row: ScorecardStored): CallScore {
  return {
    call_type: (row.call_type as CallType) || 'sales',
    summary: row.summary ?? '',
    verdict: row.verdict ?? '',
    went_well: row.went_well ?? '',
    improve: row.improve ?? '',
    scores: row.scores ?? [],
    next_step_secured: !!row.next_step_secured,
    overall: Number(row.overall) || 0,
  };
}

/** Point a scorecard at the call page it produced, so Coaching can open the call. */
export async function linkScorecardDocument(
  supabase: SupabaseClient,
  workspaceId: string,
  meetingId: string,
  documentId: string,
): Promise<void> {
  await supabase.from('call_scorecards')
    .update({ document_id: documentId })
    .eq('workspace_id', workspaceId)
    .eq('meeting_id', meetingId);
}

/** The most recent scorecard for an account — what the after-call skill / account view reads. */
export async function getLatestScorecard(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('call_scorecards')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** A rep's scorecards over a window — the raw material for the trend + radar. */
export async function listScorecardsForRep(
  supabase: SupabaseClient,
  workspaceId: string,
  repUserId: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const { data } = await supabase
    .from('call_scorecards')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('rep_user_id', repUserId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}
