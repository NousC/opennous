// Lifecycle entry rules — proposed, never applied.
//
// ⚠ The one rule this file exists to enforce: **a rule PROPOSES, it does not move an account.**
//
// A stage rename is cosmetic; get it wrong and rename it back. A lifecycle advance is not.
// Each phase is owned by a department (workspace_pipelines.owner_dept), so entering one
// reassigns the account into another team's book and changes whose worklist it appears on. A
// rule that misfires hands someone's account to another team, and they find out when it is
// gone. So every rule here writes an UNACKNOWLEDGED lifecycle_event — "Acme looks ready for
// activation, three seats active since Tuesday" — and a person makes it real with one click.
//
// `lifecycle_events.acknowledged_at` already modelled exactly this. Nothing new was needed;
// the rules just had to be built on the honest side of it.
//
// ── The feature vocabulary ──
//
// Deliberately SHORT. A rule language that half-works is worse than five conditions that
// always mean what they say, because the failure of a DSL is silent: the rule looks right and
// never fires. Every feature below is something the graph genuinely computes today.

import { getSupabaseClient, getWorkspacePipelines } from '@nous/core';

/**
 * What a condition may test. Adding one means adding its resolver below — there is no generic
 * path, on purpose.
 */
export const RULE_FEATURES = {
  pipeline_stage:        'The account\'s current canonical stage, e.g. "closed_won".',
  days_since_activity:   'Days since anything was observed on the account.',
  contacts:              'How many people we know at the account.',
  deal_value:            'Deal value in dollars, when the record carries one.',
  has_meeting:           'Whether any call or meeting has ever been observed.',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** One condition against one account's resolved facts. */
function holds(cond, facts) {
  const actual = facts[cond.feature];
  switch (cond.op) {
    case 'exists':  return actual !== null && actual !== undefined && actual !== '';
    case 'absent':  return actual === null || actual === undefined || actual === '';
    case 'is':      return String(actual ?? '').toLowerCase() === String(cond.value ?? '').toLowerCase();
    case 'is_not':  return String(actual ?? '').toLowerCase() !== String(cond.value ?? '').toLowerCase();
    case 'gte':     { const a = num(actual), b = num(cond.value); return a !== null && b !== null && a >= b; }
    case 'lte':     { const a = num(actual), b = num(cond.value); return a !== null && b !== null && a <= b; }
    default:        return false;
  }
}

/** Why it fired, in the words a person reads on the proposal. */
function explain(cond, facts) {
  const actual = facts[cond.feature];
  const label = cond.feature.replace(/_/g, ' ');
  if (cond.op === 'exists') return `${label} present`;
  if (cond.op === 'absent') return `no ${label}`;
  if (cond.op === 'gte')    return `${label} ${actual} (needs ${cond.value}+)`;
  if (cond.op === 'lte')    return `${label} ${actual} (needs ${cond.value} or less)`;
  if (cond.op === 'is_not') return `${label} is not ${cond.value}`;
  return `${label} is ${actual}`;
}

/**
 * Resolve the facts a rule can test, for a set of accounts, in a handful of queries rather
 * than per account.
 */
async function resolveFacts(supabase, workspaceId, companyIds) {
  const facts = new Map(companyIds.map(id => [id, {}]));

  const [{ data: contacts }, { data: obs }] = await Promise.all([
    supabase.from('contacts')
      .select('company_id, pipeline_stage, deal_value')
      .eq('workspace_id', workspaceId).in('company_id', companyIds).limit(20000)
      .then(r => r, () => ({ data: [] })),
    supabase.from('observations')
      .select('entity_id, kind, source, observed_at')
      .eq('workspace_id', workspaceId).in('entity_id', companyIds).limit(50000)
      .then(r => r, () => ({ data: [] })),
  ]);

  for (const c of contacts ?? []) {
    const f = facts.get(c.company_id); if (!f) continue;
    f.contacts = (f.contacts ?? 0) + 1;
    // The furthest-along contact speaks for the account: one person at "closed won" means the
    // account is won, whatever the other five say.
    if (!f.pipeline_stage || String(c.pipeline_stage ?? '').includes('closed')) {
      f.pipeline_stage = c.pipeline_stage ?? f.pipeline_stage;
    }
    const v = num(c.deal_value);
    if (v !== null) f.deal_value = Math.max(f.deal_value ?? 0, v);
  }

  const now = Date.now();
  for (const o of obs ?? []) {
    const f = facts.get(o.entity_id); if (!f) continue;
    const t = new Date(o.observed_at ?? 0).getTime();
    if (Number.isFinite(t) && t > 0) {
      const days = Math.floor((now - t) / 86400000);
      f.days_since_activity = Math.min(f.days_since_activity ?? Infinity, days);
    }
    if (/meeting|call|transcript|fireflies|fathom|granola|fellow|ringcentral/i.test(`${o.source ?? ''} ${o.kind ?? ''}`)) {
      f.has_meeting = 'yes';
    }
  }
  for (const [, f] of facts) {
    f.contacts = f.contacts ?? 0;
    f.has_meeting = f.has_meeting ?? 'no';
    if (f.days_since_activity === Infinity) f.days_since_activity = null;
  }
  return facts;
}

/**
 * Evaluate every phase's entry rule and PROPOSE the moves that qualify.
 *
 * Returns what it proposed. `dryRun` evaluates and reports without writing, which is how you
 * check a rule before it starts appearing on someone's worklist.
 */
export async function proposeLifecycleMoves(workspaceId, {
  supabase = getSupabaseClient(),
  dryRun = false,
  limit = 500,
} = {}) {
  const { pipelines, configured } = await getWorkspacePipelines(supabase, workspaceId);
  const ruled = pipelines.filter(p => p.entry_rule?.mode === 'rule' && p.entry_rule.all?.length);
  if (!ruled.length) {
    return {
      status: 'no_rules',
      configured,
      // Not a failure. Every phase being manual is the honest default, and it is what every
      // workspace starts on.
      note: 'No phase has an entry rule — every move is a person\'s call. That is the default.',
    };
  }

  // Where each account is now. A proposal to move an account to the phase it is already in is
  // noise on a worklist, which is how people learn to ignore a worklist.
  const { data: companies } = await supabase
    .from('companies').select('id, name').eq('workspace_id', workspaceId).limit(limit);
  const companyIds = (companies ?? []).map(c => c.id);
  if (!companyIds.length) return { status: 'no_accounts', configured };

  const { data: events } = await supabase
    .from('lifecycle_events')
    .select('company_id, to_stage, created_at')
    .eq('workspace_id', workspaceId).in('company_id', companyIds)
    .order('created_at', { ascending: false }).limit(20000)
    .then(r => r, () => ({ data: [] }));
  const currentPhase = new Map();
  for (const e of events ?? []) if (!currentPhase.has(e.company_id)) currentPhase.set(e.company_id, e.to_stage);

  const facts = await resolveFacts(supabase, workspaceId, companyIds);
  const nameById = new Map((companies ?? []).map(c => [c.id, c.name]));
  const phaseByKey = new Map(pipelines.map(p => [p.key, p]));

  const proposals = [];
  for (const phase of ruled) {
    for (const id of companyIds) {
      const from = currentPhase.get(id) ?? 'sales_pipeline';
      if (from === phase.key) continue;                       // already there
      const f = facts.get(id) ?? {};
      const conds = phase.entry_rule.all;
      if (!conds.every(c => holds(c, f))) continue;

      proposals.push({
        company_id: id,
        company: nameById.get(id) ?? null,
        from_stage: from,
        to_stage: phase.key,
        from_dept: phaseByKey.get(from)?.owner_dept ?? 'sales',
        to_dept: phase.owner_dept,
        // The evidence, in the words the receiving team reads. A proposal without its reason
        // is a demand.
        reason: `rule:${phase.key}`,
        note: `${phase.label}: ${conds.map(c => explain(c, f)).join(', ')}`,
      });
    }
  }

  if (dryRun) return { status: 'preview', configured, rules: ruled.length, proposals };

  // Unacknowledged, always. This is a suggestion on a worklist, not a move.
  let written = 0;
  for (let i = 0; i < proposals.length; i += 200) {
    // `company` is the display name we carried for the response; it is not a column.
    const chunk = proposals.slice(i, i + 200).map(({ company, ...p }) => ({ workspace_id: workspaceId, ...p }));
    const { error } = await supabase.from('lifecycle_events').insert(chunk);
    if (error) console.error('[LIFECYCLE_RULES] insert failed:', error.message);
    else written += chunk.length;
  }

  return { status: 'proposed', configured, rules: ruled.length, proposed: written, proposals: proposals.slice(0, 50) };
}
