import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Triggers — outbound webhooks. Nous tells the user's workflow ("n8n, Claude
// routine, custom backend") that something happened on the Account Record.
//
// V1 scope is interactions only (charter decision). Six event types. The
// catalog is the contract; do not rename without a migration.

export const TRIGGER_EVENTS = [
  'interaction.email_received',          // a reply landed (Instantly/Smartlead/EmailBison/Lemlist)
  'interaction.email_bounced',           // bounce or unsubscribe
  'interaction.linkedin_connection_accepted',
  'interaction.linkedin_message_received',
  'interaction.meeting_scheduled',       // Calendly / Cal.com
  'interaction.meeting_held',            // Fireflies / Fathom
] as const;
export type TriggerEvent = typeof TRIGGER_EVENTS[number];

// Activity-type → event-type map. logActivity stores property as
// `interaction.<type>`; we trigger when <type> matches one of these. The
// LinkedIn integration uses `linkedin_message` directly, not the HeyReach
// `linkedin_message_received` form — both are accepted, both fire the same
// trigger event so subscribers don't have to know the source.
const TRIGGERED_ACTIVITY_TYPES: Record<string, TriggerEvent> = {
  email_received:                'interaction.email_received',
  email_bounced:                 'interaction.email_bounced',
  linkedin_connection_accepted:  'interaction.linkedin_connection_accepted',
  // Every accept-detection path (new_relation webhook, message-inferred,
  // invite-poll + full sync) logs the activity type `linkedin_connected` — so
  // that is the type that must map to the accept event, not the catalog name.
  linkedin_connected:            'interaction.linkedin_connection_accepted',
  linkedin_message_received:     'interaction.linkedin_message_received',
  linkedin_message:              'interaction.linkedin_message_received',
  meeting_scheduled:             'interaction.meeting_scheduled',
  meeting_held:                  'interaction.meeting_held',
};

/** Returns the trigger event for an activity type, or null if not triggered. */
export function triggerEventForActivity(activityType: string): TriggerEvent | null {
  return TRIGGERED_ACTIVITY_TYPES[activityType] ?? null;
}

// ── Subscription CRUD ───────────────────────────────────────────────────────

export interface TriggerSubscription {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  events: TriggerEvent[];
  signing_secret: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// signing_secret is returned to authenticated workspace members. The dashboard
// shows it on demand (a "Show secret" toggle on each row) so users don't have
// to think about secrets unless they explicitly need to verify signatures.
const SUB_COLUMNS = 'id, workspace_id, name, url, events, signing_secret, active, created_at, updated_at';

function generateSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('base64url');
}

function validateUrl(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('invalid_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid_url_protocol');
}

function validateEvents(events: unknown): TriggerEvent[] {
  if (!Array.isArray(events) || events.length === 0) throw new Error('events_required');
  const allowed = new Set<string>(TRIGGER_EVENTS);
  const out: TriggerEvent[] = [];
  for (const e of events) {
    if (typeof e !== 'string') throw new Error('invalid_event');
    if (!allowed.has(e)) throw new Error(`unknown_event:${e}`);
    if (!out.includes(e as TriggerEvent)) out.push(e as TriggerEvent);
  }
  return out;
}

export interface CreateTriggerParams {
  name: string;
  url: string;
  events: TriggerEvent[];
}

/** Returns the row PLUS the plaintext secret (only here — never stored). */
export async function createTrigger(
  supabase: SupabaseClient,
  workspaceId: string,
  params: CreateTriggerParams,
): Promise<{ subscription: TriggerSubscription; secret: string }> {
  if (!params.name?.trim()) throw new Error('name_required');
  validateUrl(params.url);
  const events = validateEvents(params.events);

  const secret = generateSecret();
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .insert({
      workspace_id: workspaceId,
      name:         params.name.trim(),
      url:          params.url,
      events,
      signing_secret: secret,
      active:       true,
    })
    .select(SUB_COLUMNS)
    .single();
  if (error) throw new Error(`failed to create trigger: ${error.message}`);
  return { subscription: data as TriggerSubscription, secret };
}

export async function listTriggers(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<TriggerSubscription[]> {
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .select(SUB_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`failed to list triggers: ${error.message}`);
  return (data ?? []) as TriggerSubscription[];
}

export async function getTrigger(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<TriggerSubscription | null> {
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .select(SUB_COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`failed to get trigger: ${error.message}`);
  return (data as TriggerSubscription) ?? null;
}

export interface UpdateTriggerParams {
  name?: string;
  url?: string;
  events?: TriggerEvent[];
  active?: boolean;
  rotate_secret?: boolean;
}

export async function updateTrigger(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  params: UpdateTriggerParams,
): Promise<{ subscription: TriggerSubscription; secret?: string } | null> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) {
    if (!params.name.trim()) throw new Error('name_required');
    updates.name = params.name.trim();
  }
  if (params.url !== undefined) {
    validateUrl(params.url);
    updates.url = params.url;
  }
  if (params.events !== undefined) updates.events = validateEvents(params.events);
  if (params.active !== undefined) updates.active = !!params.active;

  let secret: string | undefined;
  if (params.rotate_secret) {
    secret = generateSecret();
    updates.signing_secret = secret;
  }

  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(SUB_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`failed to update trigger: ${error.message}`);
  if (!data) return null;
  return { subscription: data as TriggerSubscription, secret };
}

export async function deleteTrigger(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const { error, count } = await supabase
    .from('trigger_subscriptions')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`failed to delete trigger: ${error.message}`);
  return (count ?? 0) > 0;
}

// ── Outbound event enqueue (the fan-out point) ──────────────────────────────

export interface EnqueueEventParams {
  workspaceId: string;
  entityId: string | null;
  eventType: TriggerEvent;
  payload: Record<string, unknown>;
  occurredAt?: string;
  /**
   * Deterministic dedup key for the OUTBOUND fire (distinct from the
   * observation/activity external_id inside the payload). When set, at most one
   * row per (workspace, subscription, externalId) is ever enqueued — so a
   * re-sync, a Unipile re-fire, or the two firing paths (activity + claim
   * transition) all collapse to a single delivery. Omit to keep the
   * insert-always behaviour (every event a new row), which is correct for
   * genuine per-event triggers like email_received.
   */
  externalId?: string;
}

/**
 * Fan out one event to every active subscription that listens for it. One
 * outbound_events row per (event, subscription). Returns the number of rows
 * enqueued (0 if no subscriber cares — silent no-op, which is fine).
 *
 * Best-effort. Errors are swallowed so the caller (logActivity) never fails
 * just because the trigger system is unhealthy.
 */
export async function enqueueOutboundEvent(
  supabase: SupabaseClient,
  params: EnqueueEventParams,
): Promise<number> {
  try {
    const { data: subs, error: subsErr } = await supabase
      .from('trigger_subscriptions')
      .select('id')
      .eq('workspace_id', params.workspaceId)
      .eq('active', true)
      .contains('events', [params.eventType]);
    if (subsErr) {
      console.warn('[triggers] subscription lookup failed:', subsErr.message);
      return 0;
    }
    if (!subs || subs.length === 0) return 0;

    const now = params.occurredAt ?? new Date().toISOString();
    const base = subs.map(s => ({
      workspace_id:    params.workspaceId,
      subscription_id: (s as { id: string }).id,
      entity_id:       params.entityId,
      event_type:      params.eventType,
      payload:         params.payload,
      occurred_at:     now,
    }));
    // With a dedup key: stamp external_id and upsert-ignore so a repeat fire
    // (re-sync / both firing paths) is a server-side no-op. Without one: plain
    // insert with no reference to the external_id column at all — so the
    // unchanged event types keep working even if the dedup migration lags.
    const { error: insErr } = params.externalId
      ? await supabase
          .from('outbound_events')
          .upsert(base.map(r => ({ ...r, external_id: params.externalId })),
                  { onConflict: 'workspace_id,subscription_id,external_id', ignoreDuplicates: true })
      : await supabase.from('outbound_events').insert(base);
    if (insErr) {
      console.warn('[triggers] enqueue insert failed:', insErr.message);
      return 0;
    }
    return base.length;
  } catch (err) {
    console.warn('[triggers] enqueue threw:', (err as Error).message);
    return 0;
  }
}

// ── Standard interaction payload (shared by both firing paths) ───────────────
// The connector-activity path and the claim state-transition path both emit the
// SAME payload shape so subscribers see one contract regardless of how the event
// was detected. Builders live here, the trigger module, and are reused from
// activities.ts (logActivity) and claims.ts (recomputeClaim).

export interface PersonSnapshot {
  entity_id: string;
  email: string | null;
  linkedin_url: string | null;
  name: string | null;
  job_title: unknown;
  company: unknown;
}

/** Minimal person snapshot — just enough that a subscriber knows WHO an event
 *  is about without an immediate re-fetch. One identifiers read + one claims read. */
export async function buildPersonSnapshot(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
): Promise<PersonSnapshot> {
  const [{ data: identifiers }, { data: claims }] = await Promise.all([
    supabase.from('entity_identifiers')
      .select('kind, value')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .eq('status', 'active')
      .in('kind', ['email', 'linkedin_url']),
    supabase.from('claims')
      .select('property, value')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .is('invalid_at', null)
      .in('property', ['first_name', 'last_name', 'name', 'job_title', 'company']),
  ]);

  const idMap = new Map<string, string>();
  for (const i of (identifiers ?? []) as { kind: string; value: string }[]) idMap.set(i.kind, i.value);
  const claimMap = new Map<string, unknown>();
  for (const c of (claims ?? []) as { property: string; value: unknown }[]) claimMap.set(c.property, c.value);

  const name = claimMap.get('name')
    ?? [claimMap.get('first_name'), claimMap.get('last_name')].filter(Boolean).join(' ')
    ?? null;

  return {
    entity_id:    entityId,
    email:        idMap.get('email') ?? null,
    linkedin_url: idMap.get('linkedin_url') ?? null,
    name:         (name && String(name).trim()) || null,
    job_title:    claimMap.get('job_title') ?? null,
    company:      claimMap.get('company') ?? null,
  };
}

export interface InteractionPayloadParams {
  workspaceId: string;
  entityId: string;
  eventType: TriggerEvent;
  occurredAt: string;
  source: string;
  summary?: string | null;
  description?: string | null;
  /** The source observation/activity external_id, passed through to consumers. */
  externalId?: string | null;
  /** How the state was discovered: 'realtime' | 'unipile_sync' | 'state_transition' | … */
  detectedVia?: string | null;
  person: PersonSnapshot;
}

/** The canonical outbound payload object. */
export function buildInteractionPayload(p: InteractionPayloadParams): Record<string, unknown> {
  return {
    event_id:     crypto.randomUUID(),
    event_type:   p.eventType,
    occurred_at:  p.occurredAt,
    workspace_id: p.workspaceId,
    entity_id:    p.entityId,
    person:       p.person,
    event_data: {
      source:       p.source,
      summary:      p.summary ?? null,
      description:  p.description ?? null,
      external_id:  p.externalId ?? null,
      detected_via: p.detectedVia ?? null,
    },
  };
}

// ── Claim state-transition triggers ──────────────────────────────────────────
// Some interaction events are really STATE transitions, not discrete events: a
// connection is "accepted" the moment channels.linkedin.state becomes
// 'connected', however that state was written. Firing here — as a side effect of
// the claim recompute — catches EVERY writer (real-time webhook, periodic sync,
// manual/API import), not just the ones that also log an activity. The
// per-entity dedup key (li-accept:<entity>) means this never double-fires with
// the activity path: whichever path lands first wins, the other is a no-op.

export interface ClaimTransition {
  eventType: TriggerEvent;
  /** Deterministic per-entity dedup key for the outbound fire. */
  externalId: string;
}

function linkedinState(channels: unknown): string | null {
  const li = (channels as { linkedin?: { state?: unknown } } | null | undefined)?.linkedin;
  return typeof li?.state === 'string' ? li.state : null;
}

/**
 * Which trigger events a (property, before→after) change should fire. Extensible
 * by design; today only the LinkedIn connection accept on the `channels` claim is
 * wired — `linkedin_message_received` and `email_bounced` already fire correctly
 * from the activity path, so adding them here would only duplicate deliveries.
 */
export function detectClaimTransitions(
  property: string,
  before: unknown,
  after: unknown,
  entityId: string,
): ClaimTransition[] {
  const out: ClaimTransition[] = [];
  if (property === 'channels') {
    // Only a transition INTO 'connected' fires. A reverse (connected → other)
    // intentionally fires nothing — there is no accept to report.
    if (linkedinState(before) !== 'connected' && linkedinState(after) === 'connected') {
      out.push({ eventType: 'interaction.linkedin_connection_accepted', externalId: `li-accept:${entityId}` });
    }
  }
  return out;
}

export interface FireClaimTransitionParams {
  workspaceId: string;
  entityId: string;
  property: string;
  before: unknown;
  after: unknown;
  /** Source of the observation that drove the change, for attribution. */
  source: string;
  occurredAt: string;
}

/** Fire any outbound triggers implied by a claim value change. Best-effort —
 *  the claim recompute must never fail because the trigger system is unhealthy. */
export async function fireClaimTransitionTriggers(
  supabase: SupabaseClient,
  p: FireClaimTransitionParams,
): Promise<void> {
  try {
    const transitions = detectClaimTransitions(p.property, p.before, p.after, p.entityId);
    if (!transitions.length) return;

    const person = await buildPersonSnapshot(supabase, p.workspaceId, p.entityId);
    for (const t of transitions) {
      await enqueueOutboundEvent(supabase, {
        workspaceId: p.workspaceId,
        entityId:    p.entityId,
        eventType:   t.eventType,
        occurredAt:  p.occurredAt,
        externalId:  t.externalId,
        payload: buildInteractionPayload({
          workspaceId: p.workspaceId,
          entityId:    p.entityId,
          eventType:   t.eventType,
          occurredAt:  p.occurredAt,
          source:      p.source,
          detectedVia: 'state_transition',
          externalId:  t.externalId,
          person,
        }),
      });
    }
  } catch {
    // swallow — derivation must not fail on a trigger error
  }
}

// ── Delivery helpers (used by the worker) ───────────────────────────────────

export interface PendingDelivery {
  id: string;
  workspace_id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  // joined from trigger_subscriptions
  url: string;
  signing_secret: string;
  active: boolean;
}

/** Drain up to `limit` pending deliveries that are due now. */
export async function fetchPendingDeliveries(
  supabase: SupabaseClient,
  limit = 50,
): Promise<PendingDelivery[]> {
  const { data, error } = await supabase
    .from('outbound_events')
    .select(`
      id, workspace_id, subscription_id, event_type, payload, attempts,
      trigger_subscriptions!inner(url, signing_secret, active)
    `)
    .is('delivered_at', null)
    .is('dead_lettered_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`failed to fetch pending deliveries: ${error.message}`);

  // Supabase returns the join nested — flatten.
  return (data ?? []).map(r => {
    const row = r as Record<string, unknown>;
    const sub = row.trigger_subscriptions as { url: string; signing_secret: string; active: boolean };
    return {
      id:              row.id as string,
      workspace_id:    row.workspace_id as string,
      subscription_id: row.subscription_id as string,
      event_type:      row.event_type as string,
      payload:         row.payload as Record<string, unknown>,
      attempts:        row.attempts as number,
      url:             sub.url,
      signing_secret:  sub.signing_secret,
      active:          sub.active,
    };
  });
}

const RETRY_BACKOFF_SECONDS = [60, 300, 1800];  // 1m, 5m, 30m
const MAX_ATTEMPTS = 3;

export async function markDelivered(
  supabase: SupabaseClient,
  id: string,
  attempts: number,
  statusCode: number,
): Promise<void> {
  await supabase
    .from('outbound_events')
    .update({
      delivered_at:     new Date().toISOString(),
      last_status_code: statusCode,
      attempts:         attempts + 1,
    })
    .eq('id', id);
}

export async function markFailure(
  supabase: SupabaseClient,
  id: string,
  attempts: number,
  statusCode: number | null,
  errorMessage: string,
): Promise<void> {
  const nextAttempts = attempts + 1;
  const isDead = nextAttempts >= MAX_ATTEMPTS;
  const backoff = RETRY_BACKOFF_SECONDS[Math.min(nextAttempts - 1, RETRY_BACKOFF_SECONDS.length - 1)];
  const nextAt = new Date(Date.now() + backoff * 1000).toISOString();

  await supabase
    .from('outbound_events')
    .update({
      attempts:         nextAttempts,
      last_status_code: statusCode,
      last_error:       errorMessage.slice(0, 1000),
      // next_attempt_at is NOT NULL. Writing null here (the old "it's dead, so it
      // has no next attempt" instinct) made the whole UPDATE fail, which meant
      // dead_lettered_at never landed either — so the row stayed pending, came
      // straight back out of fetchPendingDeliveries, failed, and tried to die
      // again, forever. A dead row is already excluded by dead_lettered_at; it
      // does not also need a null timestamp.
      next_attempt_at:  nextAt,
      dead_lettered_at: isDead ? new Date().toISOString() : null,
    })
    .eq('id', id);
}
