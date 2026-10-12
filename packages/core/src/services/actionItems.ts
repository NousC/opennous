import type { SupabaseClient } from '@supabase/supabase-js';

// Closing a commitment the MOMENT the conversation proves it was kept.
//
// An action item is discharged at a knowable point in the thread, and the evidence
// is the next activity that lands:
//   - "schedule a chat" / "hop on a call"  → closed when a MEETING is booked/held.
//   - "join the call"                       → closed when the meeting is HELD.
//   - "I'll follow up" / "send the deck"    → closed when WE send them something after.
// These are DETERMINISTIC: the type of the activity that just landed tells us the
// commitment is done, no LLM needed. So instead of waiting for someone to open the
// Tasks page, the worker calls this on every new activity (see utils/activity.mjs),
// and the item closes in real time — which is why a booked call no longer leaves
// "schedule a chat" nagging, and a brief read right after sees it already closed.
//
// Ownership: a meeting EXISTING is objective evidence that discharges a scheduling
// commitment for EITHER side (whoever proposed it). A delivery ("I'll send X") is
// only discharged by the person who owed it acting — us — so it closes only on OUR
// outbound touch, and only for our own (owner_kind:'user') items.
//
// The fuzzy cases a type can't judge ("thanks for the deck you sent" in a later
// message) still fall to the LLM tier in apps/api/src/lib/actionItems.mjs, which
// reads the evidence and must quote it. This file is the cheap, certain first pass.

/**
 * A promise to BOOK a meeting (GET-786): "Book the Friday session with Dana", "Schedule the
 * follow-up call". Only a meeting discharges it. Its title often says "follow-up" too, which the
 * delivery rule reads as "we will contact them", and the recap email sent right after the call
 * closed it before anyone had booked anything.
 */
export const BOOKING_TITLE = /^\s*(?:\w+\s+to\s+)?(?:book|schedule|set ?up (?:a |the )?(?:\w+\s+)?(?:call|meeting|session|chat))\b/i;

interface CloseRule {
  kind: 'scheduling' | 'meeting' | 'delivery';
  /** The commitment titles this rule can close. */
  title: RegExp;
  /** Activity types whose arrival discharges the commitment. */
  closedBy: Set<string>;
  /** Scheduling/meeting close for either side; delivery only for our own items. */
  ownerAgnostic: boolean;
  /** Delivery items close only on an OUTBOUND touch (we acted). */
  requiresOutbound: boolean;
  reason: string;
}

const CLOSE_RULES: CloseRule[] = [
  {
    kind: 'scheduling',
    title: /schedule|book|invite|set ?up (?:a )?(?:call|meeting|chat)|calendar|hop on|jump on|quick (?:call|chat)|get (?:a )?(?:call|chat)/i,
    closedBy: new Set(['meeting_scheduled', 'meeting_held']),
    ownerAgnostic: true,
    requiresOutbound: false,
    reason: 'a meeting was booked',
  },
  {
    kind: 'meeting',
    title: /join|attend|hop on|jump on|conduct .*(?:call|meeting)/i,
    closedBy: new Set(['meeting_held']),
    ownerAgnostic: true,
    requiresOutbound: false,
    reason: 'the meeting was held',
  },
  {
    kind: 'delivery',
    title: /email|follow[- ]?up|send|reply|respond|reach out|share .*(?:link|doc|deck|notes|recording)/i,
    closedBy: new Set(['email_sent', 'email_reply', 'linkedin_message', 'message_sent']),
    ownerAgnostic: false,
    requiresOutbound: true,
    reason: 'you contacted them after making this commitment',
  },
];

/**
 * Did this meeting come AFTER the promise to book one (GET-786)? "Book the Friday follow-up" is
 * said ON a call, and that call's own meeting_held lands on the same record minutes later: without
 * this the promise closed itself, as "a meeting was booked", before anyone booked anything. A
 * meeting counts only when it is stamped more than an hour after the task was said, which no
 * activity of the source call is. A task or an activity with no time keeps the old rule.
 */
export function meetingCameAfter(saidAt: unknown, meetingAt: string | null | undefined): boolean {
  const said = typeof saidAt === 'string' ? Date.parse(saidAt) : NaN;
  const met = meetingAt ? Date.parse(meetingAt) : NaN;
  if (Number.isNaN(said) || Number.isNaN(met)) return true;
  return met - said > 60 * 60 * 1000;
}

/**
 * Close open action items on an entity that the JUST-LANDED activity discharges.
 * Deterministic (rule-based), owner-aware, auditable. Returns the number closed.
 * Best-effort and safe to call fire-and-forget from the ingest path on every
 * activity — it no-ops cheaply when nothing matches.
 */
export async function closeActionItemsForActivity(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  activity: { activityType: string; isOutbound?: boolean; occurredAt?: string | null },
): Promise<number> {
  if (!entityId || !activity?.activityType) return 0;

  // Which rules could even fire for this activity type? If none, don't touch the DB.
  const applicable = CLOSE_RULES.filter(r => r.closedBy.has(activity.activityType));
  if (!applicable.length) return 0;

  const { data: rows, error } = await supabase
    .from('claims')
    .select('id, value')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .like('property', 'action_item.%')
    .is('invalid_at', null);
  if (error || !rows?.length) return 0;

  const now = new Date().toISOString();
  let closed = 0;

  for (const row of rows) {
    const v = (row.value ?? {}) as { title?: string; status?: string; owner_kind?: string; [k: string]: unknown };
    if (!v.title || (v.status ?? 'open') !== 'open') continue;
    const owner = v.owner_kind ?? 'user';

    const rule = applicable.find(r => {
      if (!r.title.test(v.title as string)) return false;
      if (r.kind === 'scheduling' && !meetingCameAfter(v.occurred_at, activity.occurredAt)) return false;
      if (r.kind === 'delivery' && BOOKING_TITLE.test(v.title as string)) return false;
      if (r.requiresOutbound && activity.isOutbound !== true) return false;
      if (!r.ownerAgnostic && owner !== 'user') return false;
      return true;
    });
    if (!rule) continue;

    const next = {
      ...v,
      status: 'done',
      completed_at: now,
      completed_reason: rule.reason,
      completed_by: 'auto',
    };
    const { error: upErr } = await supabase.from('claims').update({ value: next }).eq('id', row.id);
    if (!upErr) closed++;
  }

  return closed;
}
