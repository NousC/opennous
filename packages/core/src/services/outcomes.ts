import type { SupabaseClient } from '@supabase/supabase-js';

// Outcome resolution — the close-the-loop half of the compound-intelligence
// engine. scoreAndStake() stakes one `icp_fit` prediction per entity; this
// joins each open prediction to what actually happened (reply, pipeline
// advancement, closed-won revenue, explicit loss) and writes the one weighted
// `outcome_value` the learning loop trains on.
//
// This is the SINGLE source of truth for resolution. Two entry points call it:
//   • resolveEntityPredictions() — event-driven, fired the moment a won/lost
//     activity lands (see logActivity). Resolves just that entity, immediately.
//   • resolveOpenPredictions()   — the nightly backstop, scans a batch across
//     all workspaces and also runs the late-revenue upgrade pass.
// Both share resolveOnePrediction() so the disposition logic never forks.

// Pipeline stage ordering — advancement is a rise in rank.
export const STAGE_RANK: Record<string, number> = { identified: 0, aware: 1, interested: 2, evaluating: 3, client: 4 };

// Observation properties that count as a positive reply / engagement signal.
const REPLY_PROPS = [
  'interaction.reply',
  'interaction.email_reply',
  'interaction.linkedin_message',
  'interaction.outbound_positive_reply',
  'interaction.meeting_held',
];

// Observation properties that count as closed-won revenue.
const WON_PROPS = [
  'interaction.deal_won',
  'interaction.payment_received',
  'interaction.proposal_signed',
];

// Observation properties that mark an account explicitly LOST/disqualified — a
// real negative, distinct from going quiet. Resolves immediately, like a win.
const LOST_PROPS = [
  'interaction.deal_lost',
  'interaction.deal_disqualified',
];

// The activity types (without the `interaction.` prefix) whose arrival can
// resolve a prediction immediately — i.e. worth firing event-driven resolution
// for. Won + lost only; replies/meetings only matter at resolution time and are
// picked up by deriveSignals when a won/lost event (or the nightly) fires.
export const OUTCOME_RESOLVING_TYPES = new Set([
  'deal_won', 'payment_received', 'proposal_signed',
  'deal_lost', 'deal_disqualified',
]);

// The bar for an account to count as a real opportunity. Reaching 'interested'
// or higher means it entered a buying motion — so a non-close is a genuine LOSS
// the model should learn from. Below this, going quiet is 'no_opportunity'.
const QUALIFY_RANK = STAGE_RANK.interested; // 2

// Outcome signal weights (design §5). Must sum to 1.
const W_REPLY = 0.25;
const W_PIPELINE = 0.35;
const W_REVENUE = 0.40;

// How long after a prediction we keep watching for late revenue.
const REVENUE_HORIZON_DAYS = 120;

const DAY_MS = 86_400_000;

export interface PredictionRow {
  id: string;
  workspace_id: string;
  entity_id: string;
  predicted_at: string;
  resolution_window_days?: number | null;
  feature_snapshot?: Record<string, { value?: unknown }> | null;
}

export interface ResolvedOutcome {
  id: string;
  workspace_id: string;
  entity_id: string;
  disposition: 'won' | 'lost' | 'no_opportunity';
  score: number;
}

interface DerivedSignals {
  replied: boolean;
  pipelineFrom: string;
  pipelineTo: string;
  won: boolean;
  revenue: number | null;
  observationId: string | null;
  explicitLost: boolean;
  lostObservationId: string | null;
}

// Weighted 0..1 outcome score. Pipeline contributes proportionally to how many
// stages the entity advanced (one stage = 0.25, identified→client = 1.0).
export function computeOutcomeScore({ replied, pipelineFrom, pipelineTo, won }: {
  replied: boolean; pipelineFrom: string; pipelineTo: string; won: boolean;
}): number {
  const replySignal = replied ? 1 : 0;
  const fromRank = STAGE_RANK[pipelineFrom] ?? 0;
  const toRank = STAGE_RANK[pipelineTo] ?? fromRank;
  const pipelineSignal = Math.min(Math.max(toRank - fromRank, 0), 4) / 4;
  const revenueSignal = won ? 1 : 0;
  const score = W_REPLY * replySignal + W_PIPELINE * pipelineSignal + W_REVENUE * revenueSignal;
  return Math.round(score * 1000) / 1000;
}

// The latest closed-won observation any time after the prediction. Revenue is
// slow, so this is deliberately not window-bounded.
async function deriveRevenue(supabase: SupabaseClient, entityId: string, since: string) {
  const { data: won } = await supabase
    .from('observations')
    .select('id, value, raw')
    .eq('entity_id', entityId)
    .in('property', WON_PROPS)
    .gte('observed_at', since)
    .order('observed_at', { ascending: false })
    .limit(1);

  if (!won?.length) return { won: false, revenue: null as number | null, observationId: null as string | null };

  const value = (won[0].value as Record<string, unknown>) || {};
  const raw = (won[0].raw as Record<string, unknown>) || {};
  const amount = Number(
    value.amount ?? value.value ?? raw.amount ?? raw.value ?? raw.deal_value ?? 0,
  ) || null;
  return { won: true, revenue: amount, observationId: won[0].id as string };
}

// Derive every outcome signal for one prediction: reply (inside the resolution
// window), pipeline movement (the stage claim vs the prediction's snapshot),
// and revenue / explicit loss (any time after the prediction).
export async function deriveSignals(supabase: SupabaseClient, p: PredictionRow): Promise<DerivedSignals> {
  const since = p.predicted_at;
  const windowDays = p.resolution_window_days ?? 30;
  const until = new Date(new Date(since).getTime() + windowDays * DAY_MS).toISOString();

  const { data: replies } = await supabase
    .from('observations')
    .select('id')
    .eq('entity_id', p.entity_id)
    .in('property', REPLY_PROPS)
    .gte('observed_at', since)
    .lte('observed_at', until)
    .limit(1);
  const replied = (replies?.length ?? 0) > 0;

  const { data: stageClaim } = await supabase
    .from('claims')
    .select('value')
    .eq('entity_id', p.entity_id)
    .eq('property', 'pipeline_stage')
    .maybeSingle();
  const pipelineFrom = (p.feature_snapshot?.pipeline_stage?.value as string) ?? 'identified';
  const pipelineTo = (stageClaim?.value as string) ?? pipelineFrom;

  const rev = await deriveRevenue(supabase, p.entity_id, since);

  const { data: lostObs } = await supabase
    .from('observations')
    .select('id')
    .eq('entity_id', p.entity_id)
    .in('property', LOST_PROPS)
    .gte('observed_at', since)
    .order('observed_at', { ascending: false })
    .limit(1);

  // Closed-won: an explicit revenue observation, or reaching the `client`
  // pipeline stage (this CRM's closed-won state). Either fires immediately.
  const wonByStage = pipelineTo === 'client';
  return {
    replied,
    pipelineFrom,
    pipelineTo,
    won: rev.won || wonByStage,
    revenue: rev.revenue,
    observationId: rev.observationId,
    explicitLost: (lostObs?.length ?? 0) > 0,
    lostObservationId: (lostObs?.[0]?.id as string) ?? null,
  };
}

// Resolve ONE open prediction if reality has decided it. Returns the resolved
// outcome, or null if it isn't ready (no win/loss yet and the window — when
// enforced — hasn't elapsed). `requireWindow` gates the time-based
// 'no_opportunity'/qualified-lost resolution: event-driven calls pass false (a
// won/lost just happened), the nightly backstop passes true.
async function resolveOnePrediction(
  supabase: SupabaseClient,
  p: PredictionRow,
  opts: { now: number; requireWindow: boolean },
): Promise<ResolvedOutcome | null> {
  const windowMs = (p.resolution_window_days ?? 30) * DAY_MS;
  const windowElapsed = opts.now >= new Date(p.predicted_at).getTime() + windowMs;

  const s = await deriveSignals(supabase, p);

  // Definitive: a win or an explicit loss resolves immediately, always.
  // Otherwise only the nightly backstop (requireWindow) closes it out once the
  // window has elapsed — an event-driven call leaves it open to keep watching.
  const timeOut = opts.requireWindow && windowElapsed;
  if (!s.won && !s.explicitLost && !timeOut) return null;

  const reachedRank = Math.max(STAGE_RANK[s.pipelineFrom] ?? 0, STAGE_RANK[s.pipelineTo] ?? 0);
  const qualified = reachedRank >= QUALIFY_RANK;
  const disposition: ResolvedOutcome['disposition'] = s.won ? 'won'
    : s.explicitLost ? 'lost'
    : qualified ? 'lost'
    : 'no_opportunity';

  const score = computeOutcomeScore(s);
  await supabase
    .from('predictions')
    .update({
      outcome_value: {
        replied: s.replied,
        pipeline_from: s.pipelineFrom,
        pipeline_to: s.pipelineTo,
        revenue: s.revenue,
        disposition,
        score,
      },
      outcome_observation_id: s.observationId ?? s.lostObservationId,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', p.id);

  return { id: p.id, workspace_id: p.workspace_id, entity_id: p.entity_id, disposition, score };
}

/**
 * Event-driven resolution for ONE entity. Called the moment a won/lost activity
 * is recorded (logActivity), so a closed deal resolves its prediction right
 * away instead of waiting for the nightly poll. Only resolves on a definitive
 * win/loss — never times anything out (that stays the nightly's job).
 */
export async function resolveEntityPredictions(
  supabase: SupabaseClient,
  args: { workspaceId: string; entityId: string; now?: number },
): Promise<ResolvedOutcome[]> {
  const { data: open, error } = await supabase
    .from('predictions')
    .select('id, workspace_id, entity_id, predicted_at, resolution_window_days, feature_snapshot')
    .eq('workspace_id', args.workspaceId)
    .eq('entity_id', args.entityId)
    .eq('kind', 'icp_fit')
    .is('resolved_at', null)
    .limit(10);

  // Tables not yet applied, or nothing open — nothing to do.
  if (error || !open?.length) return [];

  const now = args.now ?? Date.now();
  const out: ResolvedOutcome[] = [];
  for (const p of open as PredictionRow[]) {
    const r = await resolveOnePrediction(supabase, p, { now, requireWindow: false });
    if (r) out.push(r);
  }
  return out;
}

export interface BatchResolveResult {
  resolved: number;
  upgraded: number;
  openScanned: number;
  perWorkspace: Map<string, { resolved: number; upgraded: number }>;
  /** Present only when the predictions tables aren't applied yet. */
  skipped?: boolean;
}

/**
 * The nightly backstop: scan a batch of open predictions across all workspaces
 * and resolve any that reality has decided (win/loss, or window-elapsed), then
 * upgrade already-resolved predictions whose revenue landed late. Idempotent —
 * only touches predictions whose state actually changed.
 */
export async function resolveOpenPredictions(
  supabase: SupabaseClient,
  opts: { now?: number; batch?: number } = {},
): Promise<BatchResolveResult> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? 200;
  const perWorkspace = new Map<string, { resolved: number; upgraded: number }>();
  const bump = (wsId: string | undefined, field: 'resolved' | 'upgraded') => {
    if (!wsId) return;
    const row = perWorkspace.get(wsId) || { resolved: 0, upgraded: 0 };
    row[field]++;
    perWorkspace.set(wsId, row);
  };
  let resolved = 0;
  let upgraded = 0;

  // ── Pass 1: resolve open predictions ──────────────────────────────────────
  const { data: open, error } = await supabase
    .from('predictions')
    .select('id, workspace_id, entity_id, predicted_at, resolution_window_days, feature_snapshot')
    .is('resolved_at', null)
    .eq('kind', 'icp_fit')
    .order('predicted_at', { ascending: true })
    .limit(batch);

  if (error?.code === '42P01' || error?.code === 'PGRST205') {
    return { resolved: 0, upgraded: 0, openScanned: 0, perWorkspace, skipped: true };
  }
  if (error) throw error;

  for (const p of (open || []) as PredictionRow[]) {
    const r = await resolveOnePrediction(supabase, p, { now, requireWindow: true });
    if (r) { resolved++; bump(r.workspace_id, 'resolved'); }
  }

  // ── Pass 2: late-revenue upgrade ──────────────────────────────────────────
  const horizonCutoff = new Date(now - REVENUE_HORIZON_DAYS * DAY_MS).toISOString();
  const { data: resolvedRecent } = await supabase
    .from('predictions')
    .select('id, workspace_id, entity_id, predicted_at, outcome_value')
    .not('resolved_at', 'is', null)
    .eq('kind', 'icp_fit')
    .gte('predicted_at', horizonCutoff)
    .limit(batch);

  for (const p of resolvedRecent || []) {
    const ov = (p.outcome_value as Record<string, unknown>) || {};
    if (ov.revenue != null) continue;

    const rev = await deriveRevenue(supabase, p.entity_id as string, p.predicted_at as string);
    if (!rev.won) continue;

    const score = computeOutcomeScore({
      replied: Boolean(ov.replied),
      pipelineFrom: ov.pipeline_from as string,
      pipelineTo: ov.pipeline_to as string,
      won: true,
    });
    await supabase
      .from('predictions')
      .update({
        outcome_value: { ...ov, revenue: rev.revenue, score },
        outcome_observation_id: rev.observationId,
      })
      .eq('id', p.id as string);
    upgraded++;
    bump(p.workspace_id as string, 'upgraded');
  }

  return { resolved, upgraded, openScanned: open?.length ?? 0, perWorkspace };
}
