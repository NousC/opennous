import type { SupabaseClient } from '@supabase/supabase-js';
import { STAGE_RANK, DONE_STAGES, isTerminalStage, stageRank } from '../pipeline.js';
import { resolveEntityPredictions, OUTCOME_RESOLVING_TYPES } from '../services/outcomes.js';
import { WON_TYPES, CHURN_TYPES, type ActivityHook } from './activities.js';

// Pipeline stage engine — PRODUCT (context-graph decouple #1). This is Nous's specific sales
// funnel (a fixed ladder + auto-advance rules) and belongs to the product, not the substrate.
// The open context graph is stage-agnostic: it imposes no ladder. This engine registers itself
// onto the substrate's activity-hook seam (registerActivityHook) at api + worker boot, so
// activities.ts never imports the funnel. A different product self-hosting the graph writes its
// own pipeline_stage observations or registers its own hook. See the extraction manifest.

// Type sets that map an activity to a funnel stage. (WON/CHURN live in activities.ts because
// they also feed the substrate lifecycle axis; imported here for stageForType.)
const DISCOVERY_TYPES = new Set(['meeting_held']);
const MEETING_BOOKED_TYPES = new Set(['meeting_scheduled']);
const NEGOTIATION_TYPES = new Set(['proposal_sent', 'proposal_viewed']);
const CONNECTED_TYPES = new Set([
  'linkedin_connected', 'email_reply', 'email_received', 'slack_message',
  'content_download', 'website_revisit', 'website_visit', 'email_opened',
  'linkedin_view', 'social_engagement', 'pricing_page_visit', 'trial_started',
]);
const REPLY_TYPES = new Set(['email_reply', 'email_received', 'slack_message', 'linkedin_message']);
// Someone who signed up for the product, or used it this week (GET-751: the PostHog source writes
// both), has shown interest the way a reply does: on People, and their account on Accounts. The
// nightly decay keeps them there while they keep using it (2026_10_19_product_users_stay_interested).
const PRODUCT_USER_TYPES = new Set(['signed_up', 'product_used']);
const LOST_TYPES = new Set(['deal_lost']);
const DISQUALIFIED_TYPES = new Set(['deal_disqualified']);

const STAGE_ORDER = STAGE_RANK;
// Only a real buying signal revives a dead/churned account; a stray open/visit must not.
const REACTIVATING_MIN_RANK = STAGE_RANK.interested;

// When a stage transition actually happened. The activity that drives the hop already
// carries the true event time (`occurredAt`, threaded from the pollers/webhooks through
// logActivity), so a replayed month of history lands as a month of transitions instead
// of collapsing into the instant the replay ran — which is what every cycle-time and
// survival read depends on.
//
// CLAMPED TO NOW, and that clamp is load-bearing. A meeting observation stores the
// meeting's START time as observed_at (see collapseMeetingDupes in activities.ts), so a
// call booked today for next Tuesday arrives with occurredAt in the FUTURE. The account
// advanced to meeting_booked when they booked it, not when the meeting is due, and a
// future-dated transition would read as negative time-in-stage downstream. Anything
// unparseable falls back to now rather than writing a null into a NOT NULL column.
export function transitionAt(occurredAt: string | undefined | null, nowMs: number): string {
  if (!occurredAt) return new Date(nowMs).toISOString();
  const t = new Date(occurredAt).getTime();
  if (!Number.isFinite(t)) return new Date(nowMs).toISOString();
  return new Date(Math.min(t, nowMs)).toISOString();
}

/**
 * The OUTCOME rungs only: an activity type that ends a deal, or null.
 *
 * Exported because two engines need exactly this mapping and a second copy would
 * drift. The live path reaches it through stageForType below; the batch derivation
 * worker (apps/worker/src/workers/stageDerivation.mjs) needs it standalone, because
 * its ladder rules are windowed to recent activity and an outcome must never be
 * subject to a recency window — a deal that closed last year is still closed.
 */
export function terminalStageForType(type: string): string | null {
  if (WON_TYPES.has(type))            return 'closed_won';
  if (CHURN_TYPES.has(type))          return 'churned';
  if (LOST_TYPES.has(type))           return 'closed_lost';
  if (DISQUALIFIED_TYPES.has(type))   return 'disqualified';
  return null;
}

/** Every activity type that ends a deal, as substrate properties (`interaction.<type>`). */
export const TERMINAL_DRIVING_PROPERTIES: readonly string[] = [
  ...WON_TYPES, ...CHURN_TYPES, ...LOST_TYPES, ...DISQUALIFIED_TYPES,
].map(t => `interaction.${t}`);

function stageForType(type: string): string | null {
  const terminal = terminalStageForType(type);
  if (terminal)                       return terminal;
  if (DISCOVERY_TYPES.has(type))      return 'discovery';
  if (MEETING_BOOKED_TYPES.has(type)) return 'meeting_booked';
  if (NEGOTIATION_TYPES.has(type))    return 'negotiation';
  if (PRODUCT_USER_TYPES.has(type))   return 'interested';
  if (CONNECTED_TYPES.has(type))      return 'connected';
  return null;
}

// Every activity type that can produce a stage. Exported so a caller reconstructing history
// can ask the database for exactly these rows instead of pulling an account's whole
// interaction log — the stage-driving events are a small slice of a busy timeline, and the
// difference at workspace scale is large. Derived from the sets above so it cannot fall out
// of step with stageForType.
export const STAGE_DRIVING_TYPES: ReadonlySet<string> = new Set<string>([
  ...WON_TYPES, ...CHURN_TYPES, ...LOST_TYPES, ...DISQUALIFIED_TYPES,
  ...DISCOVERY_TYPES, ...MEETING_BOOKED_TYPES, ...NEGOTIATION_TYPES,
  ...CONNECTED_TYPES, ...REPLY_TYPES, ...PRODUCT_USER_TYPES,
]);

/** The same set as substrate observation properties (`interaction.<type>`). */
export const STAGE_DRIVING_PROPERTIES: readonly string[] =
  [...STAGE_DRIVING_TYPES].map(t => `interaction.${t}`);

// The full activity → stage mapping, including the reply-signal and LinkedIn-direction
// rules that stageForType alone does not cover. Returns null when the activity implies no
// stage at all (an outbound LinkedIn message, a bounce, an auto-reply).
//
// Extracted so the LIVE path (advancePipelineStage, below) and the HISTORICAL path
// (reconstructLadder in services/funnelTimeline.ts, which rebuilds the ladder from past
// interactions) share one definition. Two copies of these rules would drift, and the
// forecast would then be trained on a funnel that disagrees with the one the product runs.
export function targetStageFor(
  type: string,
  opts: { isOutbound?: boolean; replySignal?: string } = {},
): string | null {
  let targetStage = stageForType(type);
  const OPTOUT_REPLY = new Set(['unsubscribe', 'do_not_contact']);
  const NON_ENGAGEMENT_REPLY = new Set(['auto_reply', 'bounce']);
  if (opts.replySignal && OPTOUT_REPLY.has(opts.replySignal)) {
    targetStage = 'disqualified';
  } else if (opts.replySignal && NON_ENGAGEMENT_REPLY.has(opts.replySignal)) {
    return null;
  } else if (opts.replySignal === 'positive' && REPLY_TYPES.has(type)) {
    targetStage = 'interested';
  }
  if (type === 'linkedin_message' && targetStage !== 'disqualified') {
    targetStage = opts.isOutbound === false
      ? (opts.replySignal === 'positive' ? 'interested' : 'connected')
      : null;
  }
  return targetStage;
}

// Service businesses: a client conversion is with the whole COMPANY, so cascade 'closed_won'
// to every non-terminal person at it. Idempotent + advance-only.
async function propagateCompanyClient(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  at: string,
): Promise<void> {
  const { data: ws } = await supabase.from('workspaces').select('business_type').eq('id', workspaceId).maybeSingle();
  if ((ws as { business_type?: string } | null)?.business_type !== 'service') return;
  const { data: self } = await supabase.from('contacts').select('company_id').eq('id', contactId).maybeSingle();
  const companyId = (self as { company_id?: string } | null)?.company_id;
  if (!companyId) return;
  const { data: people } = await supabase.from('contacts')
    .select('id, pipeline_stage').eq('workspace_id', workspaceId).eq('company_id', companyId);
  // The cascade is the SAME event as the win that triggered it, so it carries the win's
  // timestamp — not the instant the cascade loop happened to run.
  const ts = at;
  for (const p of ((people as Array<{ id: string; pipeline_stage: string | null }>) || [])) {
    if (p.id === contactId || DONE_STAGES.has(p.pipeline_stage ?? '')) continue;
    await supabase.from('contacts').update({ pipeline_stage: 'closed_won' }).eq('id', p.id);
    await supabase.from('observations').insert({
      workspace_id: workspaceId, entity_id: p.id, kind: 'state',
      property: 'pipeline_stage', value: 'closed_won', source: 'system', method: 'client_propagation',
      observed_at: ts,
    }).then(() => {}, () => {});
  }
}

export async function advancePipelineStage(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
  type: string,
  opts: { isOutbound?: boolean; replySignal?: string; occurredAt?: string; now?: number } = {},
): Promise<void> {
  // `now` is injectable so the clamp is testable without freezing the system clock.
  const at = transitionAt(opts.occurredAt, opts.now ?? Date.now());
  const targetStage = targetStageFor(type, opts);
  if (!targetStage) return;

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

  if (targetStage === 'disqualified' && stageRank(current) >= STAGE_RANK.meeting_booked) return;

  const writeStage = async (next: string): Promise<void> => {
    await supabase.from('contacts').update({ pipeline_stage: next }).eq('id', contactId);
    if (stageRank(next) >= STAGE_RANK.connected && !isTerminalStage(next)) {
      await supabase.from('entities').update({ status: 'active' })
        .eq('id', contactId).eq('status', 'parked')
        .then(() => {}, () => {});
    }
    await supabase.from('observations').insert({
      workspace_id: workspaceId,
      entity_id: contactId,
      kind: 'state',
      property: 'pipeline_stage',
      value: next,
      source: 'system',
      method: 'inference',
      observed_at: at,
    }).then(({ error }) => {
      if (error && !['23505', '42P01', 'PGRST205'].includes(error.code ?? '')) {
        console.warn('[ACTIVITY] pipeline_stage observation failed:', error.message);
      }
    });
    if (next === 'closed_won') await propagateCompanyClient(supabase, workspaceId, contactId, at);
  };

  // Terminal transition (lost / disqualified / churned) — authoritative, skips the rank gate.
  if (isTerminalStage(targetStage)) {
    if (current === targetStage || isTerminalStage(current)) return;
    if (targetStage === 'churned' && current !== 'closed_won') return;
    return writeStage(targetStage);
  }

  // Reactivation — a dead/churned account showing fresh real intent re-enters the funnel.
  if (isTerminalStage(current)) {
    if (stageRank(targetStage) < REACTIVATING_MIN_RANK || isTerminalStage(targetStage)) return;
    return writeStage(targetStage);
  }

  // Normal ladder advance (advancement only — never downgrade).
  if ((STAGE_ORDER[targetStage] ?? 0) <= (STAGE_ORDER[current] ?? 0)) return;
  return writeStage(targetStage);
}

// The hook Nous registers onto the substrate at boot: advance the funnel stage, then resolve
// any open ICP prediction the moment a won/lost activity lands. Registered via
// registerActivityHook(pipelineStageHook) in apps/api + apps/worker boot.
export const pipelineStageHook: ActivityHook = async ({ supabase, workspaceId, entityId, contactId, type, rawData, skipStageAdvance, occurredAt }) => {
  if (contactId && !skipStageAdvance) {
    await advancePipelineStage(supabase, workspaceId, contactId, type, {
      isOutbound: rawData?.is_outbound === true,
      replySignal: (rawData?.provider_signal ?? rawData?.reply_signal) as string | undefined,
      // The activity's true event time, already carried on the hook context and until
      // now dropped on the floor — which stamped every transition with the ingest
      // instant and flattened replayed history into a single point.
      occurredAt,
    }).catch(() => {});
  }
  if (OUTCOME_RESOLVING_TYPES.has(type)) {
    void resolveEntityPredictions(supabase, { workspaceId, entityId })
      .catch(err => console.warn('[ACTIVITY] outcome resolution failed:', (err as Error)?.message || err));
  }
};
