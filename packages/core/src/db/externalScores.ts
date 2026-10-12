import type { SupabaseClient } from '@supabase/supabase-js';
import { scoreTier, DEFAULT_TIER_THRESHOLDS, type IcpTier, type TierThresholds } from './scorecard.js';
import { buildEntityFeatures } from './predictions.js';
import { hasLearnedIcpScorer } from '../services/icpScorer.js';

// Bring-your-own ICP scorer (GET-586).
//
// A workspace either lets Nous score its accounts ('nous', the learned scorecard) or scores them
// itself and posts the numbers in ('external'). It is one or the other, never both: two scorers
// writing the same open prediction would each overwrite the other on every pass, and the trail
// would read as noise.
//
// An external score is an ordinary icp_fit prediction. Everything that reads a fit (get_context,
// get_account, the accounts list, tiers, focus) reads the same row it always did, and resolution
// grades it against won/lost exactly like ours. That last part is the point: the customer keeps
// their model, and Nous tells them whether it predicts revenue.
//
// What marks the row as theirs is the model_version prefix. Every path that recomputes a score
// (rescore on model change, rescore on new evidence, the fired-signals backfill) skips an `ext:`
// row, so even a workspace switched back to 'nous' keeps the external scores it already has until
// they resolve.
//
// 'nous' needs the learned scorer, which is Nous Cloud's (src/cloud/, GET-754 slice 8). An
// open-source build has none, so there every workspace scores for itself: the setting reads
// 'external' whatever is stored, and PUT /v2/icp/scorer refuses 'nous'.

export type IcpScorer = 'nous' | 'external';
export const EXTERNAL_MODEL_PREFIX = 'ext:';
export const ICP_TIERS: IcpTier[] = ['tier_1', 'tier_2', 'tier_3', 'not_icp'];

export function isExternalModelVersion(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(EXTERNAL_MODEL_PREFIX);
}

// Plan ids that resolve to Custom (mirrors LEGACY_PLAN_IDS + PLAN_IDS in apps/api/src/lib/plans.mjs).
// Custom is the operated, run-it-for-you plan, so Nous scores for it. Everything else is the
// self-serve API plan, which brings its own scorer. A dead subscription falls to the API plan, the
// same way getPlanFromSubscription does.
const CUSTOM_PLAN_IDS = new Set(['custom', 'growth', 'headless', 'enterprise', 'workspace']);
const DEAD_STATUSES = new Set(['canceled', 'incomplete_expired', 'past_due']);

export function planDefaultScorer(sub: { plan_id?: string | null; status?: string | null } | null): IcpScorer {
  if (!sub || DEAD_STATUSES.has(String(sub.status ?? ''))) return 'external';
  return CUSTOM_PLAN_IDS.has(String(sub.plan_id ?? '').toLowerCase()) ? 'nous' : 'external';
}

export interface IcpScorerSetting { scorer: IcpScorer; source: 'workspace' | 'plan'; }

const asScorer = (v: unknown): IcpScorer | null => (v === 'nous' || v === 'external' ? v : null);

/**
 * Which scorer this workspace uses, and whether the workspace chose it or its plan did.
 * A missing column (migration not applied) reads as 'nous' from the workspace, i.e. today's behaviour.
 */
export async function getIcpScorerSetting(supabase: SupabaseClient, workspaceId: string): Promise<IcpScorerSetting> {
  if (!hasLearnedIcpScorer()) return { scorer: 'external', source: 'plan' };
  const { data, error } = await supabase
    .from('workspaces').select('icp_scorer, team_id').eq('id', workspaceId).maybeSingle();
  if (error) {
    if (error.code === '42703') return { scorer: 'nous', source: 'workspace' };
    throw new Error(`failed to read icp_scorer: ${error.message}`);
  }
  const row = data as { icp_scorer?: string | null; team_id?: string | null } | null;
  const chosen = asScorer(row?.icp_scorer);
  if (chosen) return { scorer: chosen, source: 'workspace' };
  if (!row?.team_id) return { scorer: 'nous', source: 'plan' };
  const { data: sub, error: e } = await supabase
    .from('subscriptions').select('plan_id, status').eq('team_id', row.team_id).maybeSingle();
  if (e) throw new Error(`failed to read subscription: ${e.message}`);
  return { scorer: planDefaultScorer(sub as { plan_id?: string; status?: string } | null), source: 'plan' };
}

export async function getIcpScorer(supabase: SupabaseClient, workspaceId: string): Promise<IcpScorer> {
  return (await getIcpScorerSetting(supabase, workspaceId)).scorer;
}

/** null clears the workspace's choice, so it follows its plan again. */
export async function setIcpScorer(supabase: SupabaseClient, workspaceId: string, scorer: IcpScorer | null): Promise<void> {
  const { error } = await supabase.from('workspaces').update({ icp_scorer: scorer }).eq('id', workspaceId);
  if (error) throw new Error(`failed to set icp_scorer: ${error.message}`);
}

/** Every workspace that scores for itself, so a sweep can skip them in one pass. */
export async function externalScorerWorkspaces(supabase: SupabaseClient): Promise<Set<string>> {
  const { data: wss, error } = await supabase.from('workspaces').select('id, team_id, icp_scorer');
  // Without the learned scorer every workspace scores for itself, whatever the query says.
  if (!hasLearnedIcpScorer()) {
    if (error && error.code !== '42703') throw new Error(`failed to list workspace scorers: ${error.message}`);
    return new Set(((wss ?? []) as { id: string }[]).map(w => w.id));
  }
  if (error) {
    if (error.code === '42703') return new Set();
    throw new Error(`failed to list workspace scorers: ${error.message}`);
  }
  const { data: subs, error: e } = await supabase.from('subscriptions').select('team_id, plan_id, status');
  if (e) throw new Error(`failed to list subscriptions: ${e.message}`);
  const subByTeam = new Map((subs ?? []).map(r => [(r as { team_id: string }).team_id, r as { plan_id?: string; status?: string }]));
  const out = new Set<string>();
  for (const w of (wss ?? []) as { id: string; team_id: string | null; icp_scorer?: string | null }[]) {
    const scorer = asScorer(w.icp_scorer) ?? (w.team_id ? planDefaultScorer(subByTeam.get(w.team_id) ?? null) : 'nous');
    if (scorer === 'external') out.add(w.id);
  }
  return out;
}

// ── Tier cut-offs ────────────────────────────────────────────────────────────────────────────────

/** A valid override is three integers, 1–100, strictly descending. Anything else is not one. */
export function normalizeTierThresholds(v: unknown): TierThresholds | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const t = { tier_1: Number(o.tier_1), tier_2: Number(o.tier_2), tier_3: Number(o.tier_3) };
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;
  if (!ok(t.tier_1) || !ok(t.tier_2) || !ok(t.tier_3)) return null;
  if (!(t.tier_1 > t.tier_2 && t.tier_2 > t.tier_3)) return null;
  return t;
}

/** The workspace's tier cut-offs, or the defaults. */
export async function getTierThresholds(supabase: SupabaseClient, workspaceId: string): Promise<TierThresholds> {
  const { data, error } = await supabase
    .from('workspaces').select('icp_tier_thresholds').eq('id', workspaceId).maybeSingle();
  if (error) {
    if (error.code === '42703') return DEFAULT_TIER_THRESHOLDS;
    throw new Error(`failed to read tier thresholds: ${error.message}`);
  }
  return normalizeTierThresholds((data as { icp_tier_thresholds?: unknown } | null)?.icp_tier_thresholds) ?? DEFAULT_TIER_THRESHOLDS;
}

/** null resets to the defaults. */
export async function setTierThresholds(supabase: SupabaseClient, workspaceId: string, t: TierThresholds | null): Promise<void> {
  const { error } = await supabase.from('workspaces').update({ icp_tier_thresholds: t }).eq('id', workspaceId);
  if (error) throw new Error(`failed to set tier thresholds: ${error.message}`);
}

/** A scorer name the caller chose, trimmed to something safe to stamp on a row. */
export function normalizeScorerName(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/.test(s)) return null;
  return s;
}

export interface ExternalScoreInput {
  score: number;
  tier?: IcpTier | null;
  reason?: string | null;
  scorer: string;
  /** The workspace's cut-offs, when the caller already loaded them for a batch. */
  thresholds?: TierThresholds;
  now?: number;
}

export interface ExternalScoreResult {
  status: 'staked' | 'updated' | 'unchanged';
  prediction_id: string;
  score: number;
  tier: IcpTier;
  from?: number | null;
}

/**
 * Write a caller-computed score onto an entity's open icp_fit prediction, or stake one.
 *
 * Same discipline as rescore.ts: a moved score pushes the prior head into `history`, an unmoved
 * one changes nothing, and a resolved bet is never touched. The feature snapshot is taken at
 * staking time because resolution reads the pipeline stage from it to grade the bet.
 */
export async function writeExternalScore(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  input: ExternalScoreInput,
): Promise<ExternalScoreResult> {
  const score = Math.round(input.score);
  const bands = input.thresholds ?? await getTierThresholds(supabase, workspaceId);
  const tier = input.tier ?? scoreTier(score, bands)!;
  const fit = score >= bands.tier_2;
  const reason = input.reason?.trim() || `Scored by ${input.scorer}`;
  const version = `${EXTERNAL_MODEL_PREFIX}${input.scorer}`;
  const nowIso = new Date(input.now ?? Date.now()).toISOString();

  const { data: openRows, error } = await supabase
    .from('predictions')
    .select('id, predicted_value, predicted_at, model_version')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .eq('kind', 'icp_fit')
    .is('resolved_at', null)
    .order('predicted_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`failed to read open prediction: ${error.message}`);
  const open = openRows?.[0];

  if (!open) {
    const built = await buildEntityFeatures(supabase, workspaceId, entityId);
    const { data, error: e } = await supabase
      .from('predictions')
      .insert({
        workspace_id: workspaceId,
        entity_id: entityId,
        kind: 'icp_fit',
        predicted_value: { score, fit, reason, tier },
        predicted_confidence: score / 100,
        feature_snapshot: built?.snapshot ?? {},
        model_version: version,
      })
      .select('id')
      .single();
    if (e) throw new Error(`failed to stake external score: ${e.message}`);
    return { status: 'staked', prediction_id: (data as { id: string }).id, score, tier };
  }

  const prev = (open.predicted_value as Record<string, any>) || {};
  if (prev.score === score && prev.tier === tier && prev.reason === reason && open.model_version === version) {
    return { status: 'unchanged', prediction_id: open.id, score, tier, from: prev.score ?? null };
  }

  const priorHistory = Array.isArray(prev.history) ? prev.history : [];
  const moved = prev.score !== score || prev.tier !== tier;
  const history = moved
    ? [{
        score: prev.score ?? null,
        fit: prev.fit ?? null,
        tier: prev.tier ?? null,
        reason: prev.reason ?? null,
        at: prev.rescored_at || open.predicted_at,
        model_version: open.model_version ?? null,
      }, ...priorHistory]
    : priorHistory;

  const { error: e } = await supabase
    .from('predictions')
    .update({
      predicted_value: { score, fit, reason, tier, rescored_at: nowIso, history },
      predicted_confidence: score / 100,
      model_version: version,
    })
    .eq('id', open.id);
  if (e) throw new Error(`failed to update external score: ${e.message}`);
  return { status: 'updated', prediction_id: open.id, score, tier, from: prev.score ?? null };
}
