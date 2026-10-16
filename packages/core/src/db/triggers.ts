import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GITHUB_REPO_RE } from './webhookDeliveries.js';

// Triggers — outbound webhooks. Nous tells the user's workflow ("n8n, Claude
// routine, custom backend") that something happened on the Account Record.
//
// V1 was interactions only: six thin events carrying a person snapshot. The
// record events (GET-559) carry the whole identity-resolved record instead —
// account, people, deal and the evidence behind it — so a receiver can act
// without calling back. The catalog is the contract; do not rename without a
// migration.

export const TRIGGER_EVENTS = [
  'interaction.email_received',          // a reply landed (Instantly/Smartlead/EmailBison/Lemlist)
  'interaction.email_bounced',           // bounce or unsubscribe
  'interaction.linkedin_connection_accepted',
  'interaction.linkedin_message_received',
  'interaction.meeting_scheduled',       // Calendly / Cal.com
  'interaction.meeting_held',            // Fireflies / Fathom
  // Record events (GET-559) — emitted through emitEvent (services/events.mjs).
  'conversation.call_ended',
  'conversation.reply_received',
  'deal.won',
  'deal.lost',
  'deal.stage_changed',
  // ICP events (GET-588): any writer's score — Nous's own or a workspace's scorer via /v2/scores.
  'icp.score_changed',
  'icp.tier_changed',
  // New people, batched hourly (GET-588): a backfill adds thousands at once, and one event each
  // would start thousands of Action runs.
  'people.added',
  // Account signals (GET-686): a fact worth acting on, as it lands in a call or an email.
  'signal.objection_raised',
  'signal.objection_resolved',
  'signal.competitor_mentioned',
  'signal.competitor_evaluating',
  'signal.stakeholder_identified',
  'signal.stakeholder_joined',
  'signal.stakeholder_left',
  'signal.budget_discussed',
  'signal.buying_signal',
  'signal.next_step',
  'signal.expansion_signal',
  'signal.expansion_declined',
  'signal.churn_risk',
  'automation.approval_requested',
] as const;

/** What each event means, for the catalog endpoint and the docs. */
export const EVENT_CATALOG: { type: TriggerEvent; description: string; record: boolean }[] = [
  { type: 'conversation.call_ended',     record: true,  description: 'A customer call was recorded and reviewed. Carries the call, its score and the account record.' },
  { type: 'conversation.reply_received', record: true,  description: 'Someone replied to an email you sent. Carries the message and the account record.' },
  { type: 'deal.won',                    record: true,  description: 'A deal closed won. Checked hourly; deals reach the ledger after the CRM records the close.' },
  { type: 'deal.lost',                   record: true,  description: 'A deal closed lost. Same timing as deal.won.' },
  { type: 'deal.stage_changed',          record: true,  description: "An account's pipeline stage moved. Checked hourly." },
  { type: 'icp.score_changed',           record: true,  description: "Someone's ICP score moved, or they were scored for the first time. Carries from and to, the scorer and its reason. Checked hourly." },
  { type: 'icp.tier_changed',            record: true,  description: 'An ICP score crossed a tier (Tier 1, 2, 3, Not ICP). Same timing as icp.score_changed.' },

  { type: 'signal.objection_raised', record: true, description: 'An objection was raised on a call or email: what they pushed back on, in their words, and who said it.' },
  { type: 'signal.objection_resolved', record: true, description: 'An open objection was marked resolved or addressed.' },
  { type: 'signal.competitor_mentioned', record: true, description: 'A competitor came up: who, and in what stance (incumbent, mentioned, past failure).' },
  { type: 'signal.competitor_evaluating', record: true, description: 'A competitor is being actively evaluated, newly or escalated from a mention.' },
  { type: 'signal.stakeholder_identified', record: true, description: 'A buying role was named: champion, economic buyer, decision maker or blocker.' },
  { type: 'signal.stakeholder_joined', record: true, description: "Someone new joined the account's team." },
  { type: 'signal.stakeholder_left', record: true, description: "Someone left the account's team." },
  { type: 'signal.budget_discussed', record: true, description: 'Budget, procurement or a commercial constraint came up.' },
  { type: 'signal.buying_signal', record: true, description: 'A buying signal: intent to buy, a request for pricing or a proposal.' },
  { type: 'signal.next_step', record: true, description: 'A next step was agreed: what, for whom, and when it is due.' },
  { type: 'signal.expansion_signal', record: true, description: 'They asked about, or are considering, more: a product, seats, a team.' },
  { type: 'signal.expansion_declined', record: true, description: 'They declined more of a product.' },
  { type: 'signal.churn_risk', record: true, description: 'A churn risk: stated churn, at risk, or friction.' },
  { type: 'automation.approval_requested', record: true, description: 'An automation step waits for approval: the run id, the automation, the step and what it would do. Decide it with POST /v2/approvals/:runId/approve or /reject.' },
  { type: 'people.added',                record: false, description: 'New people landed in the workspace. At most one an hour: the count and up to 100 person ids, so a scorer can score them.' },
  { type: 'interaction.email_received',  record: false, description: 'An email arrived from a contact (sequencing tools). Person snapshot only.' },
  { type: 'interaction.email_bounced',   record: false, description: 'An email bounced or the contact unsubscribed. Person snapshot only.' },
  { type: 'interaction.linkedin_connection_accepted', record: false, description: 'A LinkedIn connection request was accepted. Person snapshot only.' },
  { type: 'interaction.linkedin_message_received',    record: false, description: 'A LinkedIn message arrived. Person snapshot only.' },
  { type: 'interaction.meeting_scheduled', record: false, description: 'A meeting was booked. Person snapshot only.' },
  { type: 'interaction.meeting_held',      record: false, description: 'A meeting took place. Person snapshot only.' },
];
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

export type DestinationType = 'url' | 'github' | 'slack';

export interface TriggerSubscription {
  id: string;
  workspace_id: string;
  name: string;
  /** Set for a URL webhook; null for a GitHub one. */
  url: string | null;
  /** Where events go (GET-670, GET-941): POST to `url`, a repository_dispatch to `github_repo`, or a Slack message to the incoming webhook in `url`. */
  destination_type: DestinationType;
  github_repo: string | null;
  /** 'after_call' when the Settings → Automations toggle owns this webhook (GET-672); null if made by hand. */
  managed_by?: string | null;
  events: TriggerEvent[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

// signing_secret is never read back. It is returned once, by createTrigger and by
// updateTrigger({ rotate_secret }), and otherwise lives only in the worker's delivery path —
// a list readable by every workspace member must not hand out the key that forges deliveries.
// github_token_enc is never read back either: only the delivery path selects it.
export const TRIGGER_SUB_COLUMNS = 'id, workspace_id, name, url, destination_type, github_repo, managed_by, events, active, created_at, updated_at';

function generateSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('base64url');
}

// Reject obvious internal targets at trigger-creation time (loopback/private/link-local IP
// literals + internal names). Static only — a public name that RESOLVES private, redirects, or
// DNS-rebinds at delivery time is not caught here; that needs a resolve-and-connect-pin guard in
// the worker delivery path (tracked as a follow-up). This blocks the direct http://127.0.0.1 /
// http://169.254.169.254 / http://redis:6379 cases.
function isStaticInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local') || !h.includes('.')) return true;
  // IPv4 literal in a private/reserved range
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;                 // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                                // multicast/reserved
  }
  if (h === '::1' || h === '::' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/** A Slack incoming webhook URL, and nothing else: the only host a Slack destination may post to. */
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9_\-/]+$/;

function validateUrl(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('invalid_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid_url_protocol');
  if (isStaticInternalHost(u.hostname)) throw new Error('blocked_internal_host');
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

/**
 * Where a webhook delivers. The GitHub token arrives ALREADY ENCRYPTED: core holds no key, so the
 * API encrypts it (providers/crypto.mjs) before it gets here.
 */
export type TriggerDestination =
  | { type: 'url'; url: string }
  | { type: 'github'; repo: string; tokenEnc: string }
  // A Slack incoming webhook (GET-941): each event posted to the channel it was made for.
  | { type: 'slack'; url: string };

export interface CreateTriggerParams {
  name: string;
  /** Shorthand for { destination: { type: 'url', url } }, which every existing caller passes. */
  url?: string;
  destination?: TriggerDestination;
  events: TriggerEvent[];
}

/** The columns a destination writes. Switching type clears the other type's fields. */
function destinationColumns(d: TriggerDestination): Record<string, unknown> {
  if (d.type === 'github') {
    const repo = String(d.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!GITHUB_REPO_RE.test(repo)) throw new Error('invalid_github_repo');
    if (!d.tokenEnc) throw new Error('github_token_required');
    return { destination_type: 'github', github_repo: repo, github_token_enc: d.tokenEnc, url: null };
  }
  if (d.type === 'slack') {
    const url = String(d.url ?? '').trim();
    if (!SLACK_WEBHOOK_RE.test(url)) throw new Error('invalid_slack_webhook');
    return { destination_type: 'slack', url, github_repo: null, github_token_enc: null };
  }
  validateUrl(d.url);
  return { destination_type: 'url', url: d.url, github_repo: null, github_token_enc: null };
}

function destinationOf(params: { url?: string; destination?: TriggerDestination }): TriggerDestination {
  if (params.destination) return params.destination;
  if (params.url) return { type: 'url', url: params.url };
  throw new Error('destination_required');
}

/** Returns the row PLUS the plaintext secret (only here — never stored). */
export async function createTrigger(
  supabase: SupabaseClient,
  workspaceId: string,
  params: CreateTriggerParams,
): Promise<{ subscription: TriggerSubscription; secret: string }> {
  if (!params.name?.trim()) throw new Error('name_required');
  const dest = destinationColumns(destinationOf(params));
  const events = validateEvents(params.events);

  const secret = generateSecret();
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .insert({
      workspace_id: workspaceId,
      name:         params.name.trim(),
      ...dest,
      events,
      signing_secret: secret,
      active:       true,
    })
    .select(TRIGGER_SUB_COLUMNS)
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
    .select(TRIGGER_SUB_COLUMNS)
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
    .select(TRIGGER_SUB_COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`failed to get trigger: ${error.message}`);
  return (data as TriggerSubscription) ?? null;
}

export interface UpdateTriggerParams {
  name?: string;
  url?: string;
  destination?: TriggerDestination;
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
  if (params.destination !== undefined) Object.assign(updates, destinationColumns(params.destination));
  else if (params.url !== undefined) Object.assign(updates, destinationColumns({ type: 'url', url: params.url }));
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
    .select(TRIGGER_SUB_COLUMNS)
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

/** The active subscriptions listening for one event, with when each was created. */
export async function subscribersFor(
  supabase: SupabaseClient,
  workspaceId: string,
  eventType: TriggerEvent,
): Promise<{ id: string; created_at: string }[]> {
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .select('id, created_at')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .contains('events', [eventType]);
  if (error) throw new Error(`subscription lookup failed: ${error.message}`);
  return (data ?? []) as { id: string; created_at: string }[];
}

/** Which workspaces have at least one active subscription to any of these events. */
export async function workspacesSubscribedTo(
  supabase: SupabaseClient,
  eventTypes: TriggerEvent[],
): Promise<string[]> {
  const { data, error } = await supabase
    .from('trigger_subscriptions')
    .select('workspace_id')
    .eq('active', true)
    .overlaps('events', eventTypes);
  if (error) throw new Error(`subscription lookup failed: ${error.message}`);
  return [...new Set((data ?? []).map(r => (r as { workspace_id: string }).workspace_id))];
}

/** One subscription's recent deliveries — the delivery log. */
export async function listDeliveries(
  supabase: SupabaseClient,
  workspaceId: string,
  subscriptionId: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('outbound_events')
    .select('id, event_type, occurred_at, delivered_at, attempts, next_attempt_at, last_status_code, last_error, dead_lettered_at')
    .eq('workspace_id', workspaceId)
    .eq('subscription_id', subscriptionId)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(`failed to list deliveries: ${error.message}`);
  return (data ?? []).map(r => {
    const row = r as Record<string, unknown>;
    const status = row.delivered_at ? 'delivered' : row.dead_lettered_at ? 'failed' : 'pending';
    return { ...row, status };
  });
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
  url: string | null;
  signing_secret: string;
  active: boolean;
  destination_type: DestinationType;
  github_repo: string | null;
  github_token_enc: string | null;
  github_event_type: string | null;
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
      trigger_subscriptions!inner(url, signing_secret, active, destination_type, github_repo, github_token_enc, github_event_type)
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
    const sub = row.trigger_subscriptions as {
      url: string | null; signing_secret: string; active: boolean;
      destination_type?: DestinationType | null; github_repo?: string | null; github_token_enc?: string | null;
      github_event_type?: string | null;
    };
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
      destination_type: sub.destination_type ?? 'url',
      github_repo:     sub.github_repo ?? null,
      github_token_enc: sub.github_token_enc ?? null,
      github_event_type: sub.github_event_type ?? null,
    };
  });
}

// Six tries over about nine hours: a receiver that is down for a deploy or a bad afternoon
// still gets the event. Three tries over 36 minutes dead-lettered anything that met an outage.
const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];  // 1m, 5m, 30m, 2h, 6h
const MAX_ATTEMPTS = 6;

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
