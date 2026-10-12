// The pipeline-stage vocabulary layer.
//
// Custom stages are NOT a new derivation engine — the canonical ladder lives in pipeline.ts
// (identified → … → closed_won + terminals) and stays universal. This module is the
// VOCABULARY on top: each workspace names its own stages, and each maps to a canonical rank.
// The board renders the workspace's labels; derivation keeps writing canonical stages
// underneath; a canonical `closed_won` just DISPLAYS as whatever the workspace calls it.
//
// There is NO default stage set. Stages are 100% per-workspace: pulled from their CRM when
// one is connected (the source of truth), or co-defined with the agent otherwise. The
// suggestions below are only a conversational STARTING POINT the onboarding agent can offer
// — never auto-applied to a workspace.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ALL_PIPELINE_STAGES, PIPELINE_LADDER } from '../pipeline.js';

export type Canonical = typeof ALL_PIPELINE_STAGES[number];

/** The active ladder, in order — terminals live outside it. */
export const CANONICAL_ACTIVE: Canonical[] = [...PIPELINE_LADDER];

export type StageKind = 'active' | 'won' | 'lost' | 'churned';

/** A row of a workspace's own stage vocabulary. */
export interface WorkspaceStage {
  key: string;               // stable slug ('paid', 'closing')
  label: string;             // what the customer sees ('Paid', 'Closing')
  canonical: Canonical;      // the ladder rank it maps to
  sort_order: number;
  kind: StageKind;
  is_signup_default?: boolean;
  source?: 'crm' | 'default' | 'manual';
  external_ref?: string | null; // the CRM stage id, when source='crm'
  /**
   * WHICH CRM PIPELINE this stage belongs to, as the CRM ids it (HubSpot's primary is the literal
   * string `default`). NULL means the workspace's own ladder — what every reader meant before
   * pipelines were a concept, and still the answer when nobody asks for a specific one.
   *
   * Not `workspace_stages.pipeline`, which is the LIFECYCLE PHASE ('sales_pipeline', 'handoff')
   * and a different question entirely.
   */
  pipeline_ref?: string | null;
}

/**
 * Map an arbitrary stage label (from a CRM pipeline, a CSV cell, or the user) onto a
 * canonical ladder stage. ONE heuristic, used by both the CRM-stage import and CSV mapping,
 * so a "Closed Won" always lands on `closed_won` no matter the road.
 *
 * Explicit won/lost/churn flags (which CRMs give us) win first — that's the highest-cost
 * decision and we never want to guess it from text when the source told us. Then keyword
 * matching; then, as a last resort, ordered position across the active ladder.
 */
export function mapToCanonical(
  label: string,
  hints: { order?: number; total?: number; isWon?: boolean; isLost?: boolean; isChurn?: boolean } = {},
): Canonical {
  if (hints.isWon) return 'closed_won';
  if (hints.isLost) return 'closed_lost';
  if (hints.isChurn) return 'churned';

  const s = (label || '').toLowerCase().trim();

  // Terminals by keyword. Stems (churn, cancel, disqualif) are left UNANCHORED at the end
  // so they match inflections ("churned", "cancelled").
  if (/closed[\s_-]?won|\bwon\b|\bpaid\b|\bcustomer\b|\bclient\b|\bsubscriber\b|live account/.test(s)) return 'closed_won';
  if (/closed[\s_-]?lost|\blost\b|\bdead\b|no[\s_-]?deal/.test(s)) return 'closed_lost';
  if (/disqualif|not a fit|bad fit|\bjunk\b/.test(s)) return 'disqualified';
  if (/churn|cancel|former customer|downgrad/.test(s)) return 'churned';

  // Active ladder by keyword, late-funnel first. Proposal/quote fold into negotiation
  // (the new ladder has no proposal stage of its own).
  if (/negotiat|\bclosing\b|\bcontract\b|\bverbal\b|commit|redline|proposal|\bquote\b|\bsow\b/.test(s)) return 'negotiation';
  if (/\bdemo\b/.test(s)) return 'demo';
  if (/discovery|\beval|\btrial\b|\bpoc\b|\bpilot\b|qualified|\bsql\b|needs analysis/.test(s)) return 'discovery';
  if (/meeting|\bbooked\b|\bscheduled\b|\bcall\b/.test(s)) return 'meeting_booked';
  if (/interest|engag|activat|\breplied\b|\bmql\b|nurtur/.test(s)) return 'interested';
  if (/\bconnected\b|contact|reached out|\boutreach\b/.test(s)) return 'connected';
  if (/\bnew\b|\blead\b|prospect|identif|\baware\b|signed[\s_-]?up|free user|top of funnel|\btofu\b/.test(s)) return 'identified';

  // Last resort: ordered position across the active ladder.
  if (typeof hints.order === 'number' && typeof hints.total === 'number' && hints.total > 1) {
    const idx = Math.round((hints.order / (hints.total - 1)) * (CANONICAL_ACTIVE.length - 1));
    return CANONICAL_ACTIVE[Math.max(0, Math.min(CANONICAL_ACTIVE.length - 1, idx))];
  }
  return 'identified';
}

/**
 * A STARTING SUGGESTION the onboarding agent offers when there is no CRM to copy — NOT a
 * default that gets seeded. Nothing is saved until the operator has renamed, reordered,
 * added and removed, and said yes. Every real workspace ends up with its own set.
 *
 * Deliberately SHORT. A five-rung ladder someone actually keeps current beats a nine-rung
 * one they stop updating in week three, and a team that wants more will say so — adding a
 * stage is one sentence to the agent. Erring long is the mistake that makes a pipeline a
 * chore.
 *
 * Software (product-led) and service (sales-led) look nothing alike, so it keys off
 * business_type.
 *
 * NOTE ON WHAT HAPPENS AFTER THE CLOSE. Handoff, activation and expansion are NOT stages in
 * this ladder — they are lifecycle phases an account enters once it is won, and they live on
 * a separate axis (config/lifecycle). Mixing them in would put "Closed Won" and "Upsell" on
 * the same list, which makes a win look like something you pass through on the way to
 * somewhere else, and quietly breaks every win-rate number that keys on the terminal stage.
 */
export function suggestStages(businessType?: string | null): WorkspaceStage[] {
  if (businessType === 'software') {
    return [
      { key: 'signed_up', label: 'Signed Up',  canonical: 'identified',  sort_order: 0, kind: 'active', is_signup_default: true, source: 'default' },
      { key: 'activated', label: 'Activated',  canonical: 'interested',  sort_order: 1, kind: 'active', source: 'default' },
      { key: 'trial',     label: 'Trial',      canonical: 'discovery',   sort_order: 2, kind: 'active', source: 'default' },
      { key: 'paid',      label: 'Paid',       canonical: 'closed_won',  sort_order: 3, kind: 'won',    source: 'default' },
      { key: 'churned',   label: 'Churned',    canonical: 'churned',     sort_order: 4, kind: 'churned', source: 'default' },
    ];
  }
  return [
    { key: 'lead',         label: 'Lead',          canonical: 'identified',  sort_order: 0, kind: 'active', is_signup_default: true, source: 'default' },
    { key: 'qualification', label: 'Qualification', canonical: 'discovery',   sort_order: 1, kind: 'active', source: 'default' },
    { key: 'negotiation',  label: 'Negotiation',   canonical: 'negotiation', sort_order: 2, kind: 'active', source: 'default' },
    { key: 'closed_won',   label: 'Closed Won',    canonical: 'closed_won',  sort_order: 3, kind: 'won',    source: 'default' },
    { key: 'closed_lost',  label: 'Closed Lost',   canonical: 'closed_lost', sort_order: 4, kind: 'lost',   source: 'default' },
  ];
}

/** Normalize a free-text label into a stable slug for the `key` column. */
export function stageKeyFromLabel(label: string): string {
  return (label || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'stage';
}

const STAGE_KINDS = new Set<StageKind>(['active', 'won', 'lost', 'churned']);

/**
 * Clean an incoming stage set into what the table will accept: valid canonical + kind,
 * unique slugs, sequential sort_order, and EXACTLY ONE signup default. Pure — the agent and
 * the REST endpoint both run it before saving.
 */
export function normalizeStageSet(stages: WorkspaceStage[]): WorkspaceStage[] {
  const seen = new Set<string>();
  const out: WorkspaceStage[] = [];

  (stages || []).forEach((s, i) => {
    const label = String(s?.label ?? '').trim();
    if (!label) return;
    const canonical: Canonical = (ALL_PIPELINE_STAGES as readonly string[]).includes(s.canonical)
      ? s.canonical
      : mapToCanonical(label, { order: i, total: stages.length });
    let key = stageKeyFromLabel((s.key && String(s.key).trim()) ? s.key : label);
    let candidate = key, n = 2;
    while (seen.has(candidate)) candidate = `${key}_${n++}`;
    key = candidate; seen.add(key);

    const kind: StageKind = STAGE_KINDS.has(s.kind as StageKind)
      ? (s.kind as StageKind)
      : canonical === 'closed_won' ? 'won'
      : (canonical === 'closed_lost' || canonical === 'disqualified') ? 'lost'
      : canonical === 'churned' ? 'churned'
      : 'active';

    out.push({
      key, label, canonical, sort_order: out.length, kind,
      is_signup_default: !!s.is_signup_default,
      source: s.source ?? 'manual',
      external_ref: s.external_ref ?? null,
      pipeline_ref: s.pipeline_ref ?? null,
    });
  });

  const defaults = out.filter(s => s.is_signup_default);
  if (defaults.length !== 1) {
    out.forEach(s => { s.is_signup_default = false; });
    const first = out.find(s => s.kind === 'active') ?? out[0];
    if (first) first.is_signup_default = true;
  }
  return out;
}

/** Read a workspace's stage vocabulary, in display order. */
export async function getWorkspaceStages(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { pipelineRef?: string | null } = {},
): Promise<WorkspaceStage[]> {
  const cols = 'key, label, canonical, sort_order, kind, is_signup_default, source, external_ref, pipeline_ref';
  const read = async (ref: string | null) => {
    const q = supabase.from('workspace_stages').select(cols).eq('workspace_id', workspaceId);
    const { data, error } = await (ref == null ? q.is('pipeline_ref', null) : q.eq('pipeline_ref', ref))
      .order('sort_order', { ascending: true });
    // The column is applied by hand like the rest of these. Until it exists the filter is a 400,
    // and a workspace with a ladder must not read as a workspace with none.
    if (error) {
      const { data: legacy } = await supabase.from('workspace_stages')
        .select('key, label, canonical, sort_order, kind, is_signup_default, source, external_ref')
        .eq('workspace_id', workspaceId).order('sort_order', { ascending: true });
      return (legacy ?? []) as WorkspaceStage[];
    }
    return (data ?? []) as WorkspaceStage[];
  };

  const asked = opts.pipelineRef ?? null;
  const own = await read(asked);
  // A pipeline we have never adopted falls back to the workspace's ladder rather than to nothing:
  // showing a deal against the wrong stage names is bad, showing it against none is worse.
  if (asked != null && own.length === 0) return await read(null);
  return own;
}

/**
 * Replace a workspace's stage vocabulary with `stages` (the full ordered set). Normalizes
 * first, then swaps (delete + insert, small set). Returns the saved rows.
 */
export async function saveWorkspaceStages(
  supabase: SupabaseClient,
  workspaceId: string,
  stages: WorkspaceStage[],
  opts: { pipelineRef?: string | null } = {},
): Promise<WorkspaceStage[]> {
  const ref = opts.pipelineRef ?? null;
  const norm = normalizeStageSet(stages).map(s => ({ ...s, pipeline_ref: ref }));
  // Scoped to ONE pipeline. Deleting the whole workspace's rows here would mean adopting the
  // second pipeline erased the first, which is how a workspace ends up with a board labelled in
  // a funnel nobody runs.
  const del = supabase.from('workspace_stages').delete().eq('workspace_id', workspaceId);
  const { error: delErr } = await (ref == null ? del.is('pipeline_ref', null) : del.eq('pipeline_ref', ref));
  // Pre-migration the scoped delete is a 400; fall back to the old workspace-wide swap so a
  // hand-edit still saves.
  if (delErr) await supabase.from('workspace_stages').delete().eq('workspace_id', workspaceId);
  if (norm.length) {
    const rows = norm.map(s => ({ workspace_id: workspaceId, ...s }));
    const { error } = await supabase.from('workspace_stages').insert(rows);
    if (error) {
      const { error: legacyErr } = await supabase.from('workspace_stages')
        .insert(rows.map(({ pipeline_ref, ...rest }) => rest));
      if (legacyErr) throw new Error(legacyErr.message);
    }
  }
  return norm;
}
