import type { SupabaseClient } from '@supabase/supabase-js';
import {
  triggerEventForActivity, enqueueOutboundEvent,
  buildPersonSnapshot, buildInteractionPayload,
} from './triggers.js';
import type { ReadContext } from './readContext.js';
import { isPrivateMessageType, applyMessagePrivacyToActivities, loadMessageViewer, TEAM_VIEWER } from '../privacy/messagePrivacy.mjs';
import { recordObservation, deriveSourceRef, hashRaw } from './observations.js';
import { EVIDENCE_SNAPSHOT_TYPES } from '../services/engagement.mjs';

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
  /** Event-validity (0..1) for the customer-lifecycle signal this activity emits. A
   *  recurring/active payment is ground truth (1.0); a one-off charge is weaker (~0.75)
   *  so a later churn or CRM signal can out-compete it. Rides in as the lifecycle
   *  observation's source_confidence (see deriveAuthoritativeClaim). Ignored unless the
   *  type maps to a lifecycle value. Defaults to 1.0. */
  lifecycleValidity?: number;
}

// ── activity → downstream hooks (context-graph decouple #1) ──────────────────────────────────
// The substrate records the event; WHAT happens next (advance a pipeline stage, resolve an
// outcome) is PRODUCT-specific and registered as a hook. The open context graph is stage-agnostic:
// it imposes no ladder. Nous registers its funnel via registerActivityHook (see db/pipelineStage.ts)
// at api + worker boot. The substrate never imports the product; it just invokes the hooks.

// Won/churn type sets stay here (substrate): they feed the customer-lifecycle axis (auto-reconcile),
// which is revenue-native OPEN core — NOT the sales funnel (that's pipelineStage.ts, product).
export const WON_TYPES = new Set(['proposal_signed', 'deal_won', 'payment_received']);
export const CHURN_TYPES = new Set(['deal_churned', 'subscription_canceled', 'subscription_cancelled']);

export interface ActivityHookCtx {
  supabase: SupabaseClient;
  workspaceId: string;
  entityId: string;
  contactId?: string | null;
  type: string;
  rawData?: Record<string, unknown> | null;
  skipStageAdvance?: boolean;
  occurredAt?: string;
  // Carried through so evidence/side-channel hooks can file the raw touch under the
  // resolved entity in the owning member's vault (evidence layer).
  source?: string;
  externalId?: string | null;
  ownerUserId?: string | null;
  companyId?: string | null;
  summary?: string | null;
  description?: string | null;
  // The observation row this activity became. Null on a dedup (the row already existed)
  // or a failed insert. The CRM agent files its deal attribution against this id.
  observationId?: string | null;
}
export type ActivityHook = (ctx: ActivityHookCtx) => void | Promise<void>;
const activityHooks: ActivityHook[] = [];
/** Register a post-activity hook (product concern: stage advance, outcome resolution, …). Called
 *  at api + worker boot. If none is registered, activities still record — stages just don't move. */
export function registerActivityHook(fn: ActivityHook): void { activityHooks.push(fn); }
let warnedNoHook = false;


/**
 * Record one connector activity as an event observation. Returns the
 * observation id (the v1 contact_activity_log.id replacement), or null if a
 * dup or write failure.
 */
export async function logActivity(
  supabase: SupabaseClient,
  params: LogActivityParams,
): Promise<{ id: string } | null> {
  const { workspaceId, contactId, type, source, externalId, occurredAt, description, summary, rawData, ownerUserId, skipStageAdvance, lifecycleValidity } = params;
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
      // ⭐ THE ROOT CAUSE OF UNCITABLE EVIDENCE, fixed at the writer.
      //
      // This insert builds its row by hand instead of going through `toRow`, so it never got
      // the `source_ref` derivation every other observation writer has had since Phase 0.
      // Every interaction ever logged — every meeting, every email, every message — landed
      // with a NULL pointer. Verified in production: 0 of the last 60 days of Fireflies
      // meeting observations carried one, while their external_id held the meeting id the
      // whole time.
      //
      // Nothing downstream could fix that. The insight extractor could not say which call it
      // read, the citation panel had nothing to open, and `resolveRaw` had no row to find —
      // all of it looking like separate bugs, all of it this one missing line.
      source_ref:   deriveSourceRef(source, externalId),
      content_hash: hashRaw(rawData),
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

  // Feed the customer-lifecycle axis (auto-reconcile). A won/paid activity asserts
  // 'customer', a churn asserts 'churned', each tagged with the connector's source so the
  // authority engine can reconcile e.g. Stripe(paid) vs a CRM(churned) — the "see every
  // conflict, resolved" case. The DB trigger recomputes the `lifecycle` claim + conflict.
  // Best-effort; distinct property from pipeline_stage, so the sales funnel is untouched.
  const lifecycleValue = WON_TYPES.has(type) ? 'customer' : CHURN_TYPES.has(type) ? 'churned' : null;
  if (lifecycleValue) {
    // Churn is definitive (validity 1.0). A 'customer' signal carries the caller's
    // event-validity (recurring payment 1.0, one-off ~0.75) so a stale/one-off payment
    // can be out-competed by a fresh churn or CRM signal. deriveAuthoritativeClaim reads
    // this from source_confidence: effective = authority × freshness × event_validity.
    const validity = lifecycleValue === 'churned' ? 1.0 : (typeof lifecycleValidity === 'number' ? lifecycleValidity : 1.0);
    await recordObservation(supabase, {
      workspaceId, entityId, kind: 'state', property: 'lifecycle', value: lifecycleValue,
      source, method: 'inference', observedAt: occurredAt || new Date().toISOString(),
      sourceConfidence: validity,
      externalId: externalId ? `lifecycle:${externalId}` : undefined,
    }).catch(() => {});
  }

  // Run registered product hooks (pipeline-stage advance, outcome resolution, …). The substrate
  // is stage-agnostic; Nous registers its funnel via registerActivityHook at boot. If nothing is
  // registered, activities still record — stages just won't move (warn once so a missed boot
  // registration is loud, never silent).
  if (activityHooks.length === 0 && contactId && !skipStageAdvance && !warnedNoHook) {
    warnedNoHook = true;
    console.warn('[ACTIVITY] no activity hook registered — pipeline stages will NOT advance. Did the product register its hook at boot (registerActivityHook)?');
  }
  for (const hook of activityHooks) {
    try {
      await hook({ supabase, workspaceId, entityId, contactId, type, rawData, skipStageAdvance, occurredAt,
        source, externalId: externalId ?? null, ownerUserId: ownerUserId ?? null, companyId: params.companyId ?? null, summary: summary ?? null, description: description ?? null,
        observationId: (data as { id: string } | null)?.id ?? null });
    } catch (err) {
      console.warn('[ACTIVITY] activity hook failed:', (err as Error)?.message || err);
    }
  }

  // Fire-and-forget: push this activity to every enabled CRM connection.
  void notifyCrmPush({
    workspaceId,
    contactId: contactId || entityId,
    activityType: type,
    source,
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
    // NB: the after-call GitHub dispatch is NOT enqueued here. It fires *after the call is scored*
    // (apps/worker/src/signals/callScore.mjs → enqueueGithubDispatches), so the after-call run always
    // reads a ready scorecard rather than racing the scorer that runs moments after meeting_held.
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
  /** Scope to one workspace. Readers serving a request must pass it — entity ids alone are not a boundary. */
  workspaceId?: string;
}

/** v1-shape activities from observations. Filters on the `interaction.*` spine.
 *  This reader exposes `raw` (full email/DM body) — the most sensitive surface. With a NAMED
 *  viewer (ctx.viewerUserId), message content follows the participant rule (GET-244,
 *  privacy/messagePrivacy.mjs): rows stay, content is redacted for anyone who was not on the
 *  message. A member still does not receive another rep's non-message rows. No ctx = a system
 *  job, which sees everything. */
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
    // A conversation snapshot is provenance a finding cites, not something that happened: it is
    // never a timeline row (GET-976). New snapshots are filed outside interaction.*; this keeps
    // the ones written before that off every timeline too.
    q = q.like('property', 'interaction.%')
      .not('property', 'in', `(${EVIDENCE_SNAPSHOT_TYPES.map(t => `interaction.${t}`).join(',')})`);
  }
  if (opts.contactId) q = q.eq('entity_id', opts.contactId);
  if (opts.contactIds?.length) q = q.in('entity_id', opts.contactIds);
  if (opts.source) q = q.eq('source', opts.source);
  if (opts.since) q = q.gte('observed_at', opts.since);
  if (opts.ingestedSince) q = q.gte('ingested_at', opts.ingestedSince);
  if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId);

  q = q.order('observed_at', { ascending: false });
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw error;
  let rows = (data ?? []).map(o => fromObservation(o as Record<string, unknown>));
  if (ctx && ctx.teamOnly) {
    // Written for the whole team (a summary): message content only where every member may read it.
    rows = applyMessagePrivacyToActivities(rows, TEAM_VIEWER) as ActivityRow[];
  } else if (ctx && ctx.viewerUserId) {
    const viewerUserId = ctx.viewerUserId;
    if (ctx.viewerScope === 'member') {
      rows = rows.filter(r => isPrivateMessageType(r.activity_type) || r.owner_user_id == null || r.owner_user_id === viewerUserId);
    }
    const viewer = await loadMessageViewer(supabase, ctx.workspaceId || opts.workspaceId || '', viewerUserId);
    rows = applyMessagePrivacyToActivities(rows, viewer) as ActivityRow[];
  }
  return rows;
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

/** Resolve the existing observation on an idempotent connector retry. */
export async function activityByExternalId(supabase: SupabaseClient, workspaceId: string, source: string, externalId: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase.from('observations').select('id')
    .eq('workspace_id', workspaceId).eq('source', source).eq('external_id', externalId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Reconcile a still-current connector message after its conversation version changes. */
export async function refreshActivityEvidence(supabase: SupabaseClient, workspaceId: string, source: string, externalId: string,
  evidence: { summary: string; rawData: Record<string, unknown> }): Promise<void> {
  const { error } = await supabase.from('observations').update({
    raw: evidence.rawData, content_hash: hashRaw(evidence.rawData),
    value: { summary: evidence.summary, description: evidence.summary },
  }).eq('workspace_id', workspaceId).eq('source', source).eq('external_id', externalId);
  if (error) throw error;
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
  /** The activity's source connector, so the push layer can skip the CRM it came from. */
  source?: string;
  /** Nous deal entity ids this activity was about (a human's answer, or a mirrored
   *  association). The push layer associates the engagement to these deals in the CRM. */
  dealIds?: string[];
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

/**
 * Push an activity AFTER the fact: the CRM agent's answer path, where the deal was not
 * known when the activity was logged. Same handler, same no-op when none is registered.
 */
export function notifyCrmPushNow(evt: Parameters<CrmPushHandler>[0]): void {
  notifyCrmPush(evt);
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
export function activityDirection(r: ActivityRow): 'sent' | 'received' {
  if (r.activity_type.endsWith('_sent')) return 'sent';
  if (r.activity_type.endsWith('_received')) return 'received';
  const raw = (r.raw_data as { is_outbound?: boolean; is_sender?: boolean } | null) ?? null;
  const outbound = raw?.is_outbound ?? raw?.is_sender;
  if (typeof outbound === 'boolean') return outbound ? 'sent' : 'received';
  if (/^you:\s*/i.test(r.summary ?? '')) return 'sent';
  return 'received';
}

/** Redact other people's message content for a viewer — the synchronous, conservative form.
 *
 *  Prefer `applyMessagePrivacyToActivities(rows, await loadMessageViewer(...))`, which also lets a
 *  viewer read messages they were a participant on. Without the viewer's addresses this can only
 *  honour ownership and mailbox copies, so it under-shares rather than guessing.
 *
 *  GET-244 removed two things this used to do: the "in touch" exception (anyone who had ever
 *  touched an account read every teammate's email with it) and the subject in the redacted
 *  header. `inTouchWith` is accepted for old callers and ignored. */
export function redactActivitiesForViewer(
  rows: ActivityRow[],
  ctx?: ReadContext,
  _inTouchWith?: Set<string>,
): ActivityRow[] {
  if (!ctx || !ctx.viewerUserId) return rows;
  return applyMessagePrivacyToActivities(rows, { userId: ctx.viewerUserId, emails: new Set<string>() }) as ActivityRow[];
}
