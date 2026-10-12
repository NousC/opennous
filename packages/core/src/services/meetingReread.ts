// A re-read of a meeting replaces what the previous read wrote — it does not add beside it.
//
// Measured on one account, 2026-09-21, after a `--force` re-read of three calls: more live tasks
// than commitments, and the old rows from earlier reads untouched. Two reasons, both structural:
//
//   1. `deriveClaim` lets the newest `observed_at` win, and both reads stamped the CALL's date.
//      A tie, so the first value stayed. The re-read's provenance never surfaced.
//   2. Tasks are keyed `action_item.meeting_<id>_<n>`, and the model does not number commitments
//      the same way twice. `_3` on the first read was Bastien's; on the second it was Ines's. Both
//      live, one of them stale, and "reach out to Hollis" now open twice under two titles.
//
// The health signals had the same shape: nothing invalidated the previous read's risks and
// expansion signals for the meeting, so they doubled. And with the semantic dedup timing out on
// four facts ("NOTE_DEDUP_BLIND"), the fact notes doubled too.
//
// So: the previous read is the thing to supersede, explicitly, keyed on the meeting. The writers
// call `previousMeetingTasks` before filing (so a task someone closed by hand stays closed),
// stamp the re-read's observations with the time of the READ (the call's date lives in
// `occurred_at`), then `retirePreviousMeetingTasks` for every key the new read did not rewrite.
// Notes are claims written directly, so `retireMeetingNotes` invalidates them by meeting.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface PreviousTask {
  id: string;
  entity_id: string;
  property: string;
  value: Record<string, unknown>;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The live tasks the last read of this meeting produced, on any entity. */
export async function previousMeetingTasks(
  supabase: SupabaseClient,
  workspaceId: string,
  meetingId: string,
): Promise<PreviousTask[]> {
  const [lo, hi] = meetingTaskKeyRange(meetingId);
  const { data, error } = await supabase
    .from('claims')
    .select('id, entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .gte('property', lo)
    .lt('property', hi)
    .is('invalid_at', null)
    .limit(200);
  // A failed read must not look like an empty one: "nothing there" files beside, "could not
  // look" is the caller's to log. Returning [] here is exactly what added a third layer of tasks
  // to one account on 2026-09-21.
  if (error) throw new Error(`previousMeetingTasks: ${error.message}`);
  return (data ?? []) as PreviousTask[];
}

/**
 * The half-open range that is exactly one meeting's task keys, `action_item.meeting_<id>_<n>`.
 *
 * The upper bound is a LETTER, not '~'. The keys end in digits, and digits sort before letters
 * in every collation that matters — bytes, glibc, ICU. '~' does not: under ICU (this database)
 * symbols sort BEFORE digits, so `< '…_~'` matched nothing and the previous read was never found.
 * Measured on prod 2026-09-21: no rows with '~', every row with a letter, same keys.
 */
export function meetingTaskKeyRange(meetingId: string): [string, string] {
  const prefix = `action_item.meeting_${meetingId}_`;
  return [prefix, `${prefix}a`];
}

/**
 * What a re-read must carry over from the previous task, or nothing.
 *
 * A task someone closed — by hand or by the closer on evidence — is not reopened because the
 * model read the call again. Matched on the same key and entity first, then on the same title
 * anywhere (the numbering moves; the promise does not).
 */
export function carriedOver(
  previous: PreviousTask[],
  entityId: string,
  property: string,
  title: string,
): Record<string, unknown> {
  const t = norm(title);
  const hit = previous.find(p => p.entity_id === entityId && p.property === property)
    ?? previous.find(p => norm(p.value?.title) === t);
  if (!hit) return {};
  const v = hit.value ?? {};
  const out: Record<string, unknown> = {};
  if (v.status === 'done') {
    out.status = 'done';
    for (const k of ['completed_at', 'completed_reason', 'completed_by', 'completed_evidence']) if (v[k] != null) out[k] = v[k];
  }
  if (v.reopened_at) out.reopened_at = v.reopened_at;
  // A date a PERSON set (snooze / reschedule) beats the one the model reads again: the re-read
  // would otherwise put a snoozed task straight back on the date it was moved off.
  if (v.due_set_by === 'user') { out.due_at = v.due_at ?? null; out.due_phrase = null; out.due_set_by = 'user'; }
  return out;
}

/**
 * Invalidate the previous read's tasks that the new read did not rewrite.
 *
 * `written` is the (entity, property) set the new read filed. Anything else from the last read
 * of this meeting is stale — a renumbered key, or a commitment the model no longer finds — and
 * is retired. Direct `invalid_at`: a claim recompute upserts the value and never clears it.
 */
export async function retirePreviousMeetingTasks(
  supabase: SupabaseClient,
  previous: PreviousTask[],
  written: { entityId: string; property: string }[],
): Promise<number> {
  const keep = new Set(written.map(w => `${w.entityId}|${w.property}`));
  const stale = previous.filter(p => !keep.has(`${p.entity_id}|${p.property}`));
  if (!stale.length) return 0;
  const { error } = await supabase
    .from('claims')
    .update({ invalid_at: new Date().toISOString() })
    .in('id', stale.map(p => p.id));
  if (error) throw new Error(`retirePreviousMeetingTasks: ${error.message}`);
  return stale.length;
}

/**
 * Invalidate the notes a previous read of this meeting wrote on these entities.
 *
 * Health signals carry `metadata.meeting_id`; extracted facts carry a `source_ref` that names the
 * note id (`source://fellow/<id>` or `source://fellow/fellow_<id>_<contact>`). Both are matched
 * here, entity-scoped so the read stays small. `sources` narrows to the writer re-running
 * (`fellow:health` for the health read) so a fact read is not retired by a health read.
 */
export async function retireMeetingNotes(
  supabase: SupabaseClient,
  workspaceId: string,
  { entityIds, meetingId, sources }: { entityIds: string[]; meetingId: string; sources?: string[] },
): Promise<number> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (!ids.length || !meetingId) return 0;
  const { data, error } = await supabase
    .from('claims')
    .select('id, value')
    .eq('workspace_id', workspaceId)
    .in('entity_id', ids)
    .gte('property', 'note.')
    .lt('property', 'note/')
    .is('invalid_at', null)
    .limit(2000);
  if (error) throw new Error(`retireMeetingNotes: ${error.message}`);
  if (!data) return 0;
  const stale = (data as { id: string; value: Record<string, any> }[]).filter(({ value: v }) => {
    const meta = v?.metadata ?? {};
    const ref = String(meta.source_ref ?? '');
    const byMeeting = String(meta.meeting_id ?? '') === meetingId
      || ref === `source://fellow/${meetingId}`
      || ref.includes(`/${meetingId}_`) || ref.includes(`_${meetingId}_`) || ref.endsWith(`/${meetingId}`);
    if (!byMeeting) return false;
    return !sources || sources.includes(String(v?.source ?? ''));
  });
  if (!stale.length) return 0;
  const { error: upErr } = await supabase
    .from('claims')
    .update({ invalid_at: new Date().toISOString() })
    .in('id', stale.map(s => s.id));
  if (upErr) throw new Error(`retireMeetingNotes: ${upErr.message}`);
  return stale.length;
}
