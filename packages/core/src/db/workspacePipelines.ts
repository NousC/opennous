// The revenue LIFECYCLE, as a team's own thing.
//
// Two axes, and confusing them is the mistake this file exists to prevent:
//
//   The LADDER (workspace_stages)   where a DEAL sits: Lead → Qualification → Closed Won.
//   The LIFECYCLE (this)            what an ACCOUNT becomes once it is won: Handoff →
//                                   Activation → Active Customer → Expansion.
//
// Putting "Upsell Opportunity" on the ladder next to "Closed Won" makes a win look like
// something you pass through on the way somewhere else, and quietly breaks every win-rate
// number that keys on the terminal stage. They stay apart.
//
// Each phase is OWNED by a department, so crossing a boundary moves the account into someone
// else's book — which is the whole reason an entry rule may only ever propose.

import type { SupabaseClient } from '@supabase/supabase-js';

export type OwnerDept = 'sales' | 'customer_success';

/** A condition over one account. Deliberately a SHORT list — see lifecycleRules.mjs. */
export interface RuleCondition {
  feature: string;
  op: 'is' | 'is_not' | 'gte' | 'lte' | 'exists' | 'absent';
  value?: string | number | null;
}

export type EntryRule =
  /** Structural: the ladder itself puts them here. A win is a win. */
  | { mode: 'derived'; from_stage_kind: 'won' | 'lost' | 'churned' }
  /** Measurable: every condition must hold. PROPOSES only. */
  | { mode: 'rule'; all: RuleCondition[] }
  /** A person decides. The honest default for anything judgement-shaped. */
  | { mode: 'manual' };

export interface WorkspacePipeline {
  key: string;
  label: string;
  sort_order: number;
  owner_dept: OwnerDept;
  entry_rule?: EntryRule | null;
  is_terminal?: boolean;
  source?: 'default' | 'manual';
}

/**
 * What a workspace gets before it has said anything — the phases that were hardcoded in the
 * frontend, now written down as data so a team can rename, reorder, re-own and re-rule them.
 *
 * Only ONE of these carries a real entry rule. `handoff` is derived, because a closed-won deal
 * entering the handoff phase is not a judgement call. The rest are `manual`, which is the
 * honest description of what actually happens today: a person clicks. A rule that fires
 * wrongly here reassigns someone's account, so shipping guesses as rules would be worse than
 * shipping nothing.
 */
export function defaultPipelines(): WorkspacePipeline[] {
  return [
    { key: 'sales_pipeline',  label: 'Sales Pipeline',  sort_order: 0, owner_dept: 'sales',
      entry_rule: { mode: 'manual' }, source: 'default' },
    { key: 'handoff',         label: 'Handoff',         sort_order: 1, owner_dept: 'customer_success',
      entry_rule: { mode: 'derived', from_stage_kind: 'won' }, source: 'default' },
    { key: 'activation',      label: 'Activation',      sort_order: 2, owner_dept: 'customer_success',
      entry_rule: { mode: 'manual' }, source: 'default' },
    { key: 'active_customer', label: 'Active Customer', sort_order: 3, owner_dept: 'customer_success',
      entry_rule: { mode: 'manual' }, source: 'default' },
    { key: 'expansion',       label: 'Expansion',       sort_order: 4, owner_dept: 'sales',
      entry_rule: { mode: 'manual' }, source: 'default' },
  ];
}

const KEY_RE = /[^a-z0-9]+/g;
export function pipelineKeyFromLabel(label: string): string {
  return (label || '').toLowerCase().trim().replace(KEY_RE, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'phase';
}

/**
 * The workspace's phases. Falls back to the defaults rather than returning nothing, because
 * every caller wants a lifecycle and a workspace that never configured one still HAS one —
 * it just hasn't renamed it. `configured` says which it got.
 */
export async function getWorkspacePipelines(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ pipelines: WorkspacePipeline[]; configured: boolean }> {
  const { data, error } = await supabase
    .from('workspace_pipelines')
    .select('key, label, sort_order, owner_dept, entry_rule, is_terminal, source')
    .eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  if (!data?.length) return { pipelines: defaultPipelines(), configured: false };
  return { pipelines: data as WorkspacePipeline[], configured: true };
}

const DEPTS = new Set<OwnerDept>(['sales', 'customer_success']);
const OPS = new Set(['is', 'is_not', 'gte', 'lte', 'exists', 'absent']);

/** Drop anything malformed rather than storing a rule that can never fire. */
function cleanRule(rule: unknown): EntryRule | null {
  const r = rule as { mode?: string; all?: unknown; from_stage_kind?: string } | null;
  if (!r || typeof r !== 'object') return null;
  if (r.mode === 'manual') return { mode: 'manual' };
  if (r.mode === 'derived') {
    const k = r.from_stage_kind;
    return k === 'won' || k === 'lost' || k === 'churned' ? { mode: 'derived', from_stage_kind: k } : null;
  }
  if (r.mode === 'rule') {
    const all = (Array.isArray(r.all) ? r.all : [])
      .map((c) => c as RuleCondition)
      .filter((c) => c && typeof c.feature === 'string' && c.feature.trim() && OPS.has(c.op))
      .slice(0, 6);   // six conditions is already a rule nobody can debug
    return all.length ? { mode: 'rule', all } : null;
  }
  return null;
}

/**
 * Replace the phase set. The full ordered list, like stages — a partial update of an ordered
 * thing is how two callers end up disagreeing about what comes third.
 *
 * Terminal-safety: a set with no phase at all would leave every account nowhere, so an empty
 * list is refused rather than obeyed.
 */
export async function saveWorkspacePipelines(
  supabase: SupabaseClient,
  workspaceId: string,
  pipelines: WorkspacePipeline[],
): Promise<WorkspacePipeline[]> {
  const clean = (pipelines ?? [])
    .filter((p) => p && typeof p.label === 'string' && p.label.trim())
    .map((p, i) => ({
      workspace_id: workspaceId,
      key: (p.key && p.key.trim()) ? pipelineKeyFromLabel(p.key) : pipelineKeyFromLabel(p.label),
      label: p.label.trim().slice(0, 60),
      sort_order: typeof p.sort_order === 'number' ? p.sort_order : i,
      owner_dept: DEPTS.has(p.owner_dept) ? p.owner_dept : 'sales',
      entry_rule: cleanRule(p.entry_rule),
      is_terminal: p.is_terminal === true,
      source: 'manual' as const,
      updated_at: new Date().toISOString(),
    }));

  if (!clean.length) throw new Error('A workspace needs at least one lifecycle phase.');

  // Anything they dropped goes; anything they kept is upserted. Done in that order so a
  // rename (new key, old key removed) can't collide with itself.
  const keep = clean.map((p) => p.key);
  await supabase.from('workspace_pipelines')
    .delete().eq('workspace_id', workspaceId).not('key', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`);

  const { data, error } = await supabase
    .from('workspace_pipelines')
    .upsert(clean, { onConflict: 'workspace_id,key' })
    .select('key, label, sort_order, owner_dept, entry_rule, is_terminal, source');
  if (error) throw error;
  return (data ?? []) as WorkspacePipeline[];
}
