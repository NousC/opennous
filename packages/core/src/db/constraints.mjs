// Constraints — the things this operator does not do (GET-190).
//
// "I don't send breakup emails." "I never ask for a call on a first touch." Today we suggest
// it, they refuse, and we suggest it again next week.
//
// The design claim of this module is one line: A CONSTRAINT IS A FILTER, NOT A REQUEST. A
// prohibition written into a prompt competes with a hundred other instructions and holds most
// of the time. The exception is the moment someone stops trusting the system — and they will
// not tell you it happened, they will just start ignoring what you suggest. So wherever we
// generate, we check before generating rather than asking the model nicely.
//
// Honest limit: in the plugin the agent generates on the user's own machine, so there is
// nothing for us to filter. There we instruct, as forcefully as the context allows, and record
// the violation when a constraint is broken — which at least makes the gap between "enforced"
// and "requested" a number rather than an assumption.

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/**
 * Record a constraint. Idempotent on the statement within a scope, so an operator repeating
 * themselves does not produce three rows saying the same thing.
 *
 * `source` matters and should be carried through to how it is shown. 'explicit' is the person
 * telling us. 'inferred' is us concluding it from repeat refusals, which is a weaker claim
 * built on sparse evidence and needs to be presented — and undone — as one.
 */
export async function addConstraint(supabase, workspaceId, input = {}) {
  const statement = clip(input.statement, 500);
  if (!statement) throw new Error('statement_required');
  const scope = input.scope === 'workspace' ? 'workspace' : 'person';
  // A person-scoped constraint with nobody to bind to would silently apply to everyone, which
  // is the one direction this must never fail in.
  if (scope === 'person' && !input.user_id) throw new Error('user_id_required_for_person_scope');

  const row = {
    workspace_id: workspaceId,
    scope,
    user_id: scope === 'person' ? input.user_id : null,
    statement,
    action_type: clip(input.action_type, 40),
    category: clip(input.category, 40),
    source: input.source === 'inferred' ? 'inferred' : 'explicit',
    evidence_ids: Array.isArray(input.evidence_ids) ? input.evidence_ids.slice(0, 25) : [],
    removed_at: null,
    removed_by: null,
  };
  const { data, error } = await supabase.from('ri_constraints')
    .upsert(row, { onConflict: 'workspace_id,scope,user_id,statement' })
    .select('*').single();
  if (error) throw error;
  return data;
}

/** What binds for this operator right now — their own, plus the workspace's. */
export async function listConstraints(supabase, workspaceId, { userId = null, includeRemoved = false } = {}) {
  let q = supabase.from('ri_constraints').select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (!includeRemoved) q = q.is('removed_at', null);
  const { data, error } = await q;
  if (error) { console.error('[constraints] read failed:', error.message); return []; }
  // Workspace constraints bind everyone; person constraints bind only their owner. Filtering
  // here rather than in SQL keeps the one query cheap and cacheable per workspace.
  return (data ?? []).filter((c) => c.scope === 'workspace' || !userId || c.user_id === userId);
}

/**
 * Lift a constraint. Soft, because the removal is itself a signal — we inferred wrongly — and
 * deleting the row would throw away the correction along with the mistake.
 */
export async function removeConstraint(supabase, workspaceId, id, removedBy = null) {
  const { data, error } = await supabase.from('ri_constraints')
    .update({ removed_at: new Date().toISOString(), removed_by: removedBy })
    .eq('workspace_id', workspaceId).eq('id', id)
    .select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/** Does this constraint apply to the action about to be taken? */
export function applies(constraint, { actionType = null, category = null } = {}) {
  // An unnarrowed constraint binds everything. "I don't do breakup emails" was said about
  // outreach in general, and refusing to apply it because the caller forgot to pass a type
  // would defeat the point.
  if (constraint.action_type && actionType && constraint.action_type !== actionType) return false;
  if (constraint.category && category && constraint.category !== category) return false;
  return true;
}

/**
 * The filter. Call BEFORE generating, not after.
 *
 * Returns the constraints that bind this action so the caller can refuse and say why. It
 * deliberately does not inspect the draft text — a constraint is about what we are about to
 * do, and a system that generates a breakup email and then decides whether to show it has
 * already spent the tokens and already made the mistake internally.
 */
export async function bindingConstraints(supabase, workspaceId, { userId = null, actionType = null, category = null } = {}) {
  const all = await listConstraints(supabase, workspaceId, { userId });
  return all.filter((c) => applies(c, { actionType, category }));
}

/**
 * The constraints as absolute lines for a prompt, for the surfaces we cannot filter.
 *
 * Worded harder than a learned rule on purpose. A rule is a tendency the agent should weigh
 * against what it sees; a constraint is not up for weighing, and the two must not read alike
 * in the same context block or the stronger one gets averaged into the weaker.
 */
export function renderConstraints(constraints) {
  if (!constraints?.length) return '';
  return [
    'THINGS THIS OPERATOR DOES NOT DO',
    'These are not preferences to weigh. Do not produce them, do not suggest them, and do not',
    'argue for them. If one blocks the obvious move, say so plainly and offer something else.',
    '',
    ...constraints.map((c) => `- ${c.statement}${c.source === 'inferred' ? ' (inferred from repeated refusals — say so if it seems wrong)' : ''}`),
  ].join('\n');
}
