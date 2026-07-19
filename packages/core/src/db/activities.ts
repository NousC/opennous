import type { SupabaseClient } from '@supabase/supabase-js';
import {
  triggerEventForActivity, enqueueOutboundEvent,
  buildPersonSnapshot, buildInteractionPayload,
} from './triggers.js';
import { resolveEntityPredictions, OUTCOME_RESOLVING_TYPES } from '../services/outcomes.js';
import type { ReadContext } from './readContext.js';

// Activities — the v2 connector ingestion path.
//
// Every connector "activity" (email, reply, meeting, message, payment, …) is
// recorded as a kind='event' observation with property 'interaction.<type>'.
// The append-only spine; recompute fires on insert via the DB trigger.
// `logActivity` is the single entry point; `listActivities` reads them back
// in a backward-compatible shape so the v1 contact_activity_log readers don't
// have to know the storage swapped underneath them.

export interface LogActivityParams {
  workspaceId: string;
  /** v2 entity id. Under the migration convention, contact.id == entity.id. */
  contactId: string;
  /** Optional override — for company-scoped events (e.g. Signalbase). */
  entityId?: string;
  companyId?: string | null;
  type: string;
  source: string;
  externalId?: string | null;
  occurredAt?: string;
  description?: string | null;
  summary?: string | null;
  rawData?: Record<string, unknown> | null;
  /** The team member this raw touch came through (the owning rep). Null = a
   *  system/derived/shared observation, not a private conversation. Drives the
   *  per-member read scope (see PRIVACY_MODEL.md). */
  ownerUserId?: string | null;
  /** Skip the inline per-activity pipeline-stage advance. Bulk backfills set this so
   *  a 5,000-activity import doesn't fire 5,000 stage reads/writes; the hourly
   *  stageDerivation worker recomputes stages from the logged activities afterwards. */
  skipStageAdvance?: boolean;
}

// Activity types that advance pipeline stage.
// NOTE: linkedin_message is intentionally NOT an interested-trigger. A message we
// SENT must not mark a cold prospect "interested" (that would trip the CRM
// create-gate on outbound). Message-driven staging is owned by the stageDerivation
// worker, which requires a real two-way conversation (≥3 messages or a reply).
const CLIENT_TYPES     = new Set(['proposal_signed', 'deal_won', 'payment_received']);
const EVALUATING_TYPES = new Set(['meeting_held', 'pricing_page_visit', 'proposal_sent', 'proposal_viewed', 'trial_started', 'meeting_scheduled']);
const INTERESTED_TYPES = new Set(['email_reply', 'email_received', 'slack_message', 'content_download', 'website_revisit']);
const CONNECTED_TYPES  = new Set(['linkedin_connected']);
const AWARE_TYPES      = new Set(['website_visit', 'email_opened', 'linkedin_view', 'social_engagement']);
// Terminal exits. These leave the active ladder: a dead deal (lost), a bad-fit we
// ruled out (disqualified), or a former customer who left (churned). They never
// decay — the decay job only demotes aware/interested/evaluating — and the stage
// worker never auto-advances out of them. Only an explicit re-engagement revives
// one (see advancePipelineStage).
const LOST_TYPES         = new Set(['deal_lost']);
const DISQUALIFIED_TYPES = new Set(['deal_disqualified']);
const CHURN_TYPES        = new Set(['deal_churned', 'subscription_canceled', 'subscription_cancelled']);

// Ladder ranks. Terminal exits sit ABOVE the ladder so the rank-gated advance can
// never step a ladder signal onto — or out of — a terminal stage; terminal
// transitions and reactivation are handled explicitly below, not by rank.
const STAGE_ORDER: Record<string, number> = {
  identified: 0, aware: 1, connected: 2, interested: 3, evaluating: 4, client: 5,
  lost: 6, disqualified: 6, churned: 7,
};

const TERMINAL_STAGES = new Set(['lost', 'disqualified', 'churned']);
// Only a real buying signal — a two-way conversation or deeper — revives a dead or
// churned account. A stray open / visit must not resurrect it.
const REACTIVATING_STAGES = new Set(['interested', 'evaluating', 'client']);

function stageForType(type: string): string | null {
  if (CLIENT_TYPES.has(type))       return 'client';
  if (CHURN_TYPES.has(type))        return 'churned';
  if (LOST_TYPES.has(type))         return 'lost';
  if (DISQUALIFIED_TYPES.has(type)) return 'disqualified';
  if (EVALUATING_TYPES.has(type))   return 'evaluating';
  if (INTERESTED_TYPES.has(type))   return 'interested';
  if (CONNECTED_TYPES.has(type))    return 'connected';
  if (AWARE_TYPES.has(type))        return 'aware';
  return null;
}

async function advancePipelineStage(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  type: string,
  opts: { isOutbound?: boolean } = {},
): Promise<void> {
  let targetStage = stageForType(type);
  // A LinkedIn message only advances stage when it's INBOUND — i.e. they replied.
  // An inbound reply is a real two-way conversation, so it lands on 'interested'
  // (same as an email reply). Outbound messages never advance: messaging a cold
  // prospect must not mark them interested or surface them on the People page.
  if (type === 'linkedin_message') {
    targetStage = opts.isOutbound === false ? 'interested' : null;
  }
  if (!targetStage) return;

  // Read pipeline_stage + stage_locked from the claims substrate directly, NOT the
  // `contacts` view. The view (a) no longer exposes stage_locked — selecting it
  // errored and silently aborted every advancement — and (b) filters out
  // not-yet-graduated entities (e.g. a fresh connection), so reading through it
  // could never advance the very contacts this is meant to move (e.g. to
  // 'connected'). Claims exist per-entity regardless of People-page visibility.
  const { data: stageClaims } = await supabase
    .from('claims')
    .select('property, value')
    .eq('entity_id', contactId)
    .in('property', ['pipeline_stage', 'stage_locked'])
    .is('invalid_at', null);

  const locked = stageClaims?.find(c => c.property === 'stage_locked')?.value;
  if (locked === true) return;

  const rawCurrent = stageClaims?.find(c => c.property === 'pipeline_stage')?.value;
  const current = typeof rawCurrent === 'string' ? rawCurrent : 'identified';

  // Persist a transition: pin the v1 column (still read by the Contacts UI; Phase 4
  // retires it) AND append a v2 state observation so the pipeline_stage claim
  // recomputes from the substrate.
  const writeStage = async (next: string): Promise<void> => {
    await supabase.from('contacts').update({ pipeline_stage: next }).eq('id', contactId);
    await supabase.from('observations').insert({
      workspace_id: workspaceId,
      entity_id: contactId,
      kind: 'state',
      property: 'pipeline_stage',
      value: next,
      source: 'system',
      method: 'inference',
      observed_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error && !['23505', '42P01', 'PGRST205'].includes(error.code ?? '')) {
        console.warn('[ACTIVITY] pipeline_stage observation failed:', error.message);
      }
    });
  };

  // ── Terminal transition (lost / disqualified / churned) ───────────────────────
  // A close-lost, disqualification or churn is an authoritative state change, not a
  // ladder climb, so it skips the rank gate. Guards: 'churned' only applies to an
  // account that actually became a client, and we never flip one terminal into
  // another (a lost deal isn't "churned").
  if (TERMINAL_STAGES.has(targetStage)) {
    if (current === targetStage || TERMINAL_STAGES.has(current)) return;
    if (targetStage === 'churned' && current !== 'client') return;
    return writeStage(targetStage);
  }

  // ── Reactivation ──────────────────────────────────────────────────────────────
  // A dead or churned account that shows fresh real intent comes back into the
  // funnel at the signal's stage. Weak passive pings (opens, visits) don't revive.
  if (TERMINAL_STAGES.has(current)) {
    if (!REACTIVATING_STAGES.has(targetStage)) return;
    return writeStage(targetStage);
  }

  // ── Normal ladder advance (advancement only — never downgrade) ────────────────
  if ((STAGE_ORDER[targetStage] ?? 0) <= (STAGE_ORDER[current] ?? 0)) return;
  return writeStage(targetStage);
}

/**
 * Record one connector activity as an event observation. Returns the
 * observation id (the v1 contact_activity_log.id replacement), or null if a
 * dup or write failure.
 */
export async function logActivity(
  supabase: SupabaseClient,
  params: LogActivityParams,
): Promise<{ id: string } | null> {
  const { workspaceId, contactId, type, source, externalId, occurredAt, description, summary, rawData, ownerUserId, skipStageAdvance } = params;
  const entityId = params.entityId ?? contactId;
  if (!entityId) return null;

  // Ensure the entity exists (id == v1 row id, per migration convention).
  await supabase.from('entities').upsert(
    { id: entityId, workspace_id: workspaceId, type: 'person', status: 'active' },
    { onConflict: 'id', ignoreDuplicates: true },
  );

  const { data, error } = await supabase
    .from('observations')
    .insert({
      workspace_id: workspaceId,
      entity_id:    entityId,
      kind:         'event',
      property:     `interaction.${type}`,
      value:        { description: description ?? null, summary: summary ?? null },
      source,
      method:       'connector',
      observed_at:  occurredAt || new Date().toISOString(),
      external_id:  externalId || null,
      raw:          rawData || null,
      owner_user_id: ownerUserId ?? null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      console.log(`[ACTIVITY] Dedup skip: ${source}/${externalId}`);
      return null;
    }
    console.error('[ACTIVITY] insert failed:', error.message, { source, type, entityId });
    return null;
  }

  // Advance pipeline stage based on signal type (best-effort, contact-only).
  // Pass message direction so an inbound LinkedIn reply advances but an outbound
  // one doesn't (rawData.is_outbound is set true on every message WE send).
  if (contactId && !skipStageAdvance) {
    await advancePipelineStage(supabase, workspaceId, contactId, type, {
      isOutbound: rawData?.is_outbound === true,
    }).catch(() => {});
  }

  // Event-driven outcome resolution: the moment a won/lost activity lands,
  // resolve this entity's open ICP prediction(s) instead of waiting for the
  // nightly poll. Fire-and-forget; the deal_won/deal_lost observation is already
  // written above, so deriveSignals sees it. Gated to outcome-resolving types
  // so ordinary activity (opens, visits) doesn't trigger a needless scan.
  if (OUTCOME_RESOLVING_TYPES.has(type)) {
    void resolveEntityPredictions(supabase, { workspaceId, entityId })
      .catch(err => console.warn('[ACTIVITY] outcome resolution failed:', err?.message || err));
  }

  // Fire-and-forget: push this activity to every enabled CRM connection.
  void notifyCrmPush({
    workspaceId,
    contactId: contactId || entityId,
    activityType: type,
    activityId: (data as { id: string } | null)?.id,
    occurredAt,
    summary,
    description,
    rawData,
  });

  // Fire-and-forget: enqueue an outbound trigger event if any subscriber
  // listens for this interaction. Building person snapshot is cheap (one
  // claims read); failures are swallowed inside enqueueOutboundEvent.
  void maybeEnqueueTrigger(supabase, {
    workspaceId,
    entityId,
    activityType: type,
    source,
    summary,
    description,
    externalId: externalId ?? null,
    occurredAt: occurredAt || new Date().toISOString(),
    rawData: rawData ?? null,
  });

  return data as { id: string };
}

// ── Trigger emit ────────────────────────────────────────────────────────────
// Bridge from logActivity into the triggers outbox. Pulls a minimal person
// snapshot so subscribers don't immediately have to re-fetch.

interface EmitParams {
  workspaceId: string;
  entityId: string;
  activityType: string;
  source: string;
  summary?: string | null;
  description?: string | null;
  externalId: string | null;
  occurredAt: string;
  rawData: Record<string, unknown> | null;
}

async function maybeEnqueueTrigger(supabase: SupabaseClient, p: EmitParams): Promise<void> {
  try {
    const eventType = triggerEventForActivity(p.activityType);
    if (!eventType) return;

    // The direct LinkedIn (Unipile) integration writes ALL messages — both
    // inbound and outbound — as activityType=linkedin_message with the
    // direction stashed in rawData. The trigger is "message received", so
    // skip outbound. HeyReach's linkedin_message_received is already
    // inbound-only and never hits this branch.
    if (p.activityType === 'linkedin_message' && p.rawData?.is_outbound === true) return;

    const person = await buildPersonSnapshot(supabase, p.workspaceId, p.entityId);

    // Connection-accepted is a state transition, not a discrete event. Give it a
    // per-entity dedup key so this activity-path fire and the claim-transition
    // fire (recomputeClaim → fireClaimTransitionTriggers) collapse to a single
    // delivery. detected_via surfaces realtime-vs-sync attribution for operators.
    const isAccept = eventType === 'interaction.linkedin_connection_accepted';
    const dedupExternalId = isAccept ? `li-accept:${p.entityId}` : undefined;
    const detectedVia = isAccept
      ? (typeof p.rawData?.detected_by === 'string' ? p.rawData.detected_by : 'realtime')
      : null;

    await enqueueOutboundEvent(supabase, {
      workspaceId: p.workspaceId,
      entityId:    p.entityId,
      eventType,
      occurredAt:  p.occurredAt,
      externalId:  dedupExternalId,
      payload: buildInteractionPayload({
        workspaceId: p.workspaceId,
        entityId:    p.entityId,
        eventType,
        occurredAt:  p.occurredAt,
        source:      p.source,
        summary:     p.summary,
        description: p.description,
        externalId:  p.externalId,
        detectedVia,
        person,
      }),
    });
  } catch {
    // never fail the activity write because the trigger system is unhealthy
  }
}

// ── Reads: v1-compatible activity shape, sourced from observations ───────────

export interface ActivityRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  company_id: string | null;
  activity_type: string;
  description: string | null;
  summary: string | null;
  source: string;
  occurred_at: string;
  raw_data: unknown;
  owner_user_id?: string | null;
  redacted?: boolean;
}

function fromObservation(o: Record<string, unknown>): ActivityRow {
  const value = (o.value as Record<string, unknown> | null) ?? {};
  return {
    id: o.id as string,
    workspace_id: o.workspace_id as string,
    contact_id: o.entity_id as string,
    company_id: null,           // events aren't double-tagged in v2
    activity_type: String(o.property ?? '').replace(/^interaction\./, ''),
    description: (value.description as string | null) ?? null,
    summary: (value.summary as string | null) ?? null,
    source: o.source as string,
    occurred_at: o.observed_at as string,
    raw_data: o.raw ?? null,
    owner_user_id: (o.owner_user_id as string | null) ?? null,
  };
}

export interface ListActivitiesOpts {
  contactId?: string;
  contactIds?: string[];
  types?: string[];                 // activity_type values (without the 'interaction.' prefix)
  source?: string;
  since?: string;                   // ISO; filters on observed_at
  ingestedSince?: string;           // ISO; filters on ingested_at (≈ v1 created_at)
  limit?: number;
}

/** v1-shape activities from observations. Filters on the `interaction.*` spine.
 *  This reader exposes `raw` (full email/DM body) — the most sensitive surface —
 *  so with a member-scoped ctx it drops other reps' raw rows at the DB level.
 *  See PRIVACY_MODEL.md. */
export async function listActivities(
  supabase: SupabaseClient,
  opts: ListActivitiesOpts = {},
  ctx?: ReadContext,
): Promise<ActivityRow[]> {
  let q = supabase
    .from('observations')
    .select('id, workspace_id, entity_id, property, value, source, observed_at, ingested_at, raw, owner_user_id');

  if (opts.types?.length) {
    q = q.in('property', opts.types.map(t => `interaction.${t}`));
  } else {
    q = q.like('property', 'interaction.%');
  }
  if (opts.contactId) q = q.eq('entity_id', opts.contactId);
  if (opts.contactIds?.length) q = q.in('entity_id', opts.contactIds);
  if (opts.source) q = q.eq('source', opts.source);
  if (opts.since) q = q.gte('observed_at', opts.since);
  if (opts.ingestedSince) q = q.gte('ingested_at', opts.ingestedSince);
  if (ctx && ctx.viewerScope === 'member') {
    q = q.or(`owner_user_id.is.null,owner_user_id.eq.${ctx.viewerUserId}`);
  }

  q = q.order('observed_at', { ascending: false });
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(o => fromObservation(o as Record<string, unknown>));
}

/** Count activities for an entity (or set) — `{ count: number }` for head() compat. */
export async function countActivities(
  supabase: SupabaseClient,
  opts: { contactId?: string; types?: string[]; source?: string; since?: string } = {},
): Promise<number> {
  let q = supabase
    .from('observations')
    .select('id', { count: 'exact', head: true });

  if (opts.types?.length) {
    q = q.in('property', opts.types.map(t => `interaction.${t}`));
  } else {
    q = q.like('property', 'interaction.%');
  }
  if (opts.contactId) q = q.eq('entity_id', opts.contactId);
  if (opts.source) q = q.eq('source', opts.source);
  if (opts.since) q = q.gte('observed_at', opts.since);

  const { count } = await q;
  return count ?? 0;
}

/** Has an event with this external_id already been recorded for this source? */
export async function hasActivityWithExternalId(
  supabase: SupabaseClient,
  workspaceId: string,
  source: string,
  externalId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('observations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source', source)
    .eq('external_id', externalId)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ── cross-source meeting de-duplication (read-time) ──────────────────────────
// One real meeting can be observed by several connectors — Cal.com/Calendly via
// webhook ("Booked: …") AND the Google Calendar poller ("… (Scheduled)"). They
// share the same person (entity) and start time but a different source +
// external_id, so the DB's (workspace, source, external_id) unique index never
// collapses them. Observations are append-only, so we collapse at read-time in
// the timeline / attention / context views: one meeting = entity + start-minute,
// keep the most authoritative source. The booking connectors win over the
// calendar mirror; if only the mirror saw it, the mirror is kept.

const MEETING_PROPS = new Set([
  'interaction.meeting_scheduled',
  'interaction.meeting_held',
  'interaction.meeting_cancelled',
]);

// Lower rank survives a collision. Booking connectors are authoritative; the
// google_calendar poller is a mirror, so it loses ties. Unknown sources sit in
// the middle so a real connector still beats the mirror.
const MEETING_SOURCE_RANK: Record<string, number> = {
  calendly: 0, cal_com: 0, calcom: 0, instantly: 1, fathom: 2, fireflies: 2,
  google_calendar: 9, gcal: 9,
};
const sourceRank = (s?: string | null) => MEETING_SOURCE_RANK[s ?? ''] ?? 5;

// Bucket the start time to the minute so connectors that format the timestamp
// differently (Z vs +00:00, millis vs none) still land on the same slot.
function meetingSlotKey(o: { entity_id?: string | null; observed_at?: string | null }): string {
  const t = o.observed_at ? Math.floor(new Date(o.observed_at).getTime() / 60_000) : 0;
  return `${o.entity_id ?? ''}|${t}`;
}

const meetingLabel = (o: { value?: unknown }): string => {
  const v = o.value as { description?: string; summary?: string } | null | undefined;
  return String(v?.summary || v?.description || '');
};

// Normalise a contact's meeting observations for display. Three jobs, all at
// read-time (observations stay append-only):
//   1. Supersede dead slots — a slot (entity + start-minute) is OFF if it has a
//      meeting_cancelled (a real cancel OR the marker a reschedule drops on the
//      OLD start) or a scheduled row whose label carries "(Declined)/(Cancelled)".
//      A scheduled meeting in an OFF slot is dropped — it's no longer live.
//   2. Collapse cross-source dupes — one real meeting seen by two connectors
//      (Cal.com webhook + Calendar poller) keeps the most authoritative source.
//   3. Hide reschedule markers — the "Rescheduled: …" cancellation exists only to
//      kill the old slot; the live booking already shows, so don't render it.
// Non-meeting observations pass through untouched, in their original order.
export function collapseMeetingDupes<
  T extends { id?: string | null; property?: string | null; source?: string | null; observed_at?: string | null; entity_id?: string | null; value?: unknown },
>(observations: T[]): T[] {
  const off = new Set<string>();   // slots that are no longer a live booking
  for (const o of observations) {
    const prop = o.property ?? '';
    if (prop === 'interaction.meeting_cancelled') { off.add(meetingSlotKey(o)); continue; }
    if (prop === 'interaction.meeting_scheduled' && /\((declined|cancell?ed)\)/i.test(meetingLabel(o))) {
      off.add(meetingSlotKey(o));
    }
  }

  // Among still-live scheduled meetings, keep the best source per slot.
  const winner = new Map<string, { id: string; rank: number }>();
  for (const o of observations) {
    if (o.property !== 'interaction.meeting_scheduled' || !o.id) continue;
    const key = meetingSlotKey(o);
    if (off.has(key)) continue;
    const rank = sourceRank(o.source);
    const cur = winner.get(key);
    if (!cur || rank < cur.rank) winner.set(key, { id: o.id, rank });
  }
  const keep = new Set([...winner.values()].map(w => w.id));

  return observations.filter(o => {
    const prop = o.property ?? '';
    // a reschedule marker only exists to supersede the old slot — never shown
    if (prop === 'interaction.meeting_cancelled' && /^rescheduled/i.test(meetingLabel(o))) return false;
    // a scheduled meeting survives only as the chosen live row for its slot
    if (prop === 'interaction.meeting_scheduled') return o.id ? keep.has(o.id) : true;
    return true;   // genuine cancellations, held meetings, everything else
  });
}

// ── CRM push side-channel ────────────────────────────────────────────────────
// Resolved lazily so packages/core stays free of any apps/* dependency. The
// API process registers a handler at startup; other consumers (CLI, tests) are no-ops.

type CrmPushHandler = (evt: {
  workspaceId: string; contactId: string; activityType: string;
  activityId?: string | null;
  occurredAt?: string; summary?: string | null; description?: string | null;
  rawData?: Record<string, unknown> | null;
}) => Promise<void> | void;

let crmPushHandler: CrmPushHandler | null = null;

export function registerCrmPushHandler(fn: CrmPushHandler) {
  crmPushHandler = fn;
}

function notifyCrmPush(evt: Parameters<CrmPushHandler>[0]) {
  if (!crmPushHandler) return;
  try {
    const out = crmPushHandler(evt);
    if (out && typeof (out as Promise<void>).catch === 'function') {
      (out as Promise<void>).catch(err => console.error('[CRM_PUSH_HANDLER]', err?.message || err));
    }
  } catch (err: any) {
    console.error('[CRM_PUSH_HANDLER]', err?.message || err);
  }
}

// ── Per-member privacy: redact another rep's message bodies ──────────────────
// A member viewing an account they don't own should see WHAT happened and WHEN
// (the row + its header) but not the CONTENT of another rep's email / LinkedIn
// messages. This keeps the row and a clean header, and strips the body. Their
// own + shared (null-owner) rows pass through untouched; admin/owner see all.
// Shared by the People and Company timelines so both behave identically.
// See PRIVACY_MODEL.md.
const REDACTABLE_LINKEDIN_MSG = new Set([
  'linkedin_message', 'linkedin_message_sent', 'linkedin_message_received',
  'linkedin_inmail', 'linkedin_inmail_sent', 'linkedin_inmail_received',
]);

function isRedactableActivity(type: string): boolean {
  return type.startsWith('email_') || REDACTABLE_LINKEDIN_MSG.has(type);
}

/** Sent or received?
 *
 *  LinkedIn messages are all written under ONE type, `linkedin_message` — the
 *  direction lives in the payload. Deriving it from a `_sent` suffix (which a
 *  LinkedIn row never has) labelled every redacted message "received", including
 *  ones the viewer had sent themselves. Read the payload; fall back to the "You:"
 *  prefix the writer stamps on outbound summaries. */
function activityDirection(r: ActivityRow): 'sent' | 'received' {
  if (r.activity_type.endsWith('_sent')) return 'sent';
  if (r.activity_type.endsWith('_received')) return 'received';
  const raw = (r.raw_data as { is_outbound?: boolean; is_sender?: boolean } | null) ?? null;
  const outbound = raw?.is_outbound ?? raw?.is_sender;
  if (typeof outbound === 'boolean') return outbound ? 'sent' : 'received';
  if (/^you:\s*/i.test(r.summary ?? '')) return 'sent';
  return 'received';
}

/** Redact the bodies of another rep's email/LinkedIn messages for a member viewer.
 *  Returns a new array; non-redacted rows are returned as-is.
 *
 *  `inTouchWith` is the set of accounts this viewer is themselves in touch with
 *  (see relationshipOwner.inTouchEntityIds). On those accounts the relationship is
 *  shared, so the whole conversation is readable — a rep who can see half a thread
 *  and not the other half is worse off than one who sees none of it. Everywhere
 *  else, a teammate's message body stays private. */
export function redactActivitiesForViewer(
  rows: ActivityRow[],
  ctx?: ReadContext,
  inTouchWith?: Set<string>,
): ActivityRow[] {
  // Ownership-based, NOT role-based: outside the accounts you're on, raw message
  // content is private to its owning rep — even the founder doesn't see a
  // teammate's conversations. A caller with no viewer id (a system/service
  // process) sees everything.
  if (!ctx || !ctx.viewerUserId) return rows;
  return rows.map(r => {
    const ownsIt = r.owner_user_id == null || r.owner_user_id === ctx.viewerUserId;
    const sharedAccount = !!inTouchWith?.has(r.contact_id);
    if (ownsIt || sharedAccount || !isRedactableActivity(r.activity_type)) return r;
    const dir = activityDirection(r);
    const raw = (r.raw_data as { subject?: string } | null) ?? null;
    const header = r.activity_type.startsWith('email_')
      ? `Email ${dir}${raw?.subject ? `: ${raw.subject}` : ''}`
      : `LinkedIn message ${dir}`;
    return { ...r, description: header, summary: null, raw_data: null, redacted: true };
  });
}
