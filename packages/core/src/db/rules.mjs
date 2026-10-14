// Rules — what a rep said their deals must do, said once (GET-846).
//
// The sibling of ri_preferences and ri_constraints, and the difference is what happens next:
//
//   ri_preferences  how they want things WRITTEN. Reaches the agent, nothing checks it.
//   ri_constraints  what they do NOT do. A filter on what we generate.
//   ri_rules        what has to HAPPEN on their deals. A guidance rule reaches the agent; a
//                   checked rule is mapped onto a check (services/ruleChecks.ts) and the worker
//                   evaluates it in the background — a broken one becomes a flag and a task.
//
// Personal for now: every rule belongs to one person. No frontend: rules are written and read
// over /v2/rules and the MCP `rules` tool, and reach the agent with its instructions.

import { normalizeCheck, RULE_WEIGHTS } from '../services/ruleChecks.js';

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);

/** The row a stated rule becomes. Pure; throws on what cannot be a rule. */
export function buildRuleRow(workspaceId, input = {}) {
  const statement = clip(input.statement, 500);
  if (!statement) throw new Error('statement_required');
  // Team rules come later (GET-847). Until then a rule binds exactly one person, and a rule with
  // nobody to bind to would silently apply to everyone.
  if (!input.user_id) throw new Error('user_id_required');
  const check = input.check ? normalizeCheck(input.check.type, input.check.params) : null;
  return {
    workspace_id: workspaceId,
    scope: 'person',
    user_id: input.user_id,
    statement,
    kind: check ? 'checked' : 'guidance',
    check_type: check?.check_type ?? null,
    params: check?.params ?? {},
    weight: RULE_WEIGHTS.includes(input.weight) ? input.weight : 'normal',
    status: 'active',
    source: input.source === 'proposed' ? 'proposed' : 'stated',
  };
}

/** Record a rule. Saying the same rule again updates it (its check, its weight) and brings back a removed one. */
export async function addRule(supabase, workspaceId, input = {}) {
  const row = { ...buildRuleRow(workspaceId, input), updated_at: new Date().toISOString(), removed_at: null };
  const { data, error } = await supabase.from('ri_rules')
    .upsert(row, { onConflict: 'workspace_id,scope,user_id,statement' })
    .select('*').single();
  if (error) throw error;
  return data;
}

/** A person's rules (or every rule in the workspace when userId is null — the worker's read). */
export async function listRules(supabase, workspaceId, { userId = null, includePaused = true, checkedOnly = false } = {}) {
  let q = supabase.from('ri_rules').select('*').eq('workspace_id', workspaceId).is('removed_at', null);
  if (userId) q = q.eq('user_id', userId);
  if (!includePaused) q = q.eq('status', 'active');
  if (checkedOnly) q = q.eq('kind', 'checked');
  const { data, error } = await q.order('created_at', { ascending: true });
  if (error) { console.error('[rules] read failed:', error.message); return []; }
  return data ?? [];
}

/** Pause, resume, reweight or re-check one of a person's rules. Null when it is not theirs. */
export async function updateRule(supabase, workspaceId, id, userId, patch = {}) {
  const set = { updated_at: new Date().toISOString() };
  if (patch.status === 'active' || patch.status === 'paused') set.status = patch.status;
  if (RULE_WEIGHTS.includes(patch.weight)) set.weight = patch.weight;
  if (patch.check !== undefined) {
    const check = patch.check ? normalizeCheck(patch.check.type, patch.check.params) : null;
    set.kind = check ? 'checked' : 'guidance';
    set.check_type = check?.check_type ?? null;
    set.params = check?.params ?? {};
  }
  const { data, error } = await supabase.from('ri_rules').update(set)
    .eq('workspace_id', workspaceId).eq('id', id).eq('user_id', userId).is('removed_at', null)
    .select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/** Soft remove: the row stays so "why did this stop flagging" has an answer. */
export async function removeRule(supabase, workspaceId, id, userId) {
  const { data, error } = await supabase.from('ri_rules')
    .update({ removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', id).eq('user_id', userId).is('removed_at', null)
    .select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Active rules as lines for the agent. Stronger than a preference: the rep set these for their own
 * deals. A checked rule is marked, so the agent knows the engine will hold them to it.
 */
export function renderRules(rules) {
  const live = (rules ?? []).filter((r) => (r.status ?? 'active') === 'active' && !r.removed_at);
  if (!live.length) return '';
  return [
    "THIS OPERATOR'S RULES",
    'Rules they set for their own deals. Apply them to what you suggest and draft; when one is',
    'not met on the account in front of you, say so and propose the step that meets it.',
    '',
    ...live.map((r) => `- ${r.statement}${r.kind === 'checked' ? ' (checked)' : ''}`),
  ].join('\n');
}
