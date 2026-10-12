// Stated preferences — what a person told us, or what one correction made obvious (GET-189).
//
// The sibling of ri_observations, and the distinction between them is the point:
//
//   ri_observations  patterns MINED from outcomes. Needs n before it means anything.
//   ri_preferences   what someone SAID. n is 1 and that is fine — the human told us.
//
// Putting a stated preference behind a statistical floor means ignoring somebody who has
// already spoken. Letting a mined pattern through at n=1 means acting on noise. They end up in
// the same context block and must never share a bar.

const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/**
 * Record a preference, or strengthen one we already hold.
 *
 * Repeating yourself does not create a second row — it raises `observed_count`, because three
 * separate edits pointing the same way is a materially stronger signal than one offhand remark
 * and the difference is worth keeping.
 */
export async function addPreference(supabase, workspaceId, input = {}) {
  const statement = clip(input.statement, 500);
  if (!statement) throw new Error('statement_required');
  const scope = input.scope === 'workspace' ? 'workspace' : 'person';
  // A person preference with nobody to bind to would reshape everyone's output. Same failure
  // direction as constraints, same refusal.
  if (scope === 'person' && !input.user_id) throw new Error('user_id_required_for_person_scope');

  const { data: prior } = await supabase.from('ri_preferences')
    .select('id, observed_count, evidence_ids')
    .eq('workspace_id', workspaceId).eq('scope', scope)
    .eq('user_id', scope === 'person' ? input.user_id : null)
    .eq('statement', statement)
    .maybeSingle();

  const evidence = [...new Set([...(prior?.evidence_ids ?? []), ...(input.evidence_ids ?? [])])].slice(0, 25);
  const row = {
    workspace_id: workspaceId,
    scope,
    user_id: scope === 'person' ? input.user_id : null,
    statement,
    applies_to: clip(input.applies_to, 40),
    source: input.source === 'inferred' ? 'inferred' : 'stated',
    evidence_ids: evidence,
    observed_count: (prior?.observed_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
    // Re-stating a preference someone had lifted brings it back. They changed their mind, and
    // holding the old removal against them would be the system arguing with its user.
    removed_at: null,
    removed_by: null,
  };
  const { data, error } = await supabase.from('ri_preferences')
    .upsert(row, { onConflict: 'workspace_id,scope,user_id,statement' })
    .select('*').single();
  if (error) throw error;
  return data;
}

/** What shapes this operator's output right now — their own, plus the workspace's. */
export async function listPreferences(supabase, workspaceId, { userId = null, appliesTo = null } = {}) {
  const { data, error } = await supabase.from('ri_preferences').select('*')
    .eq('workspace_id', workspaceId)
    .is('removed_at', null)
    .order('observed_count', { ascending: false });
  if (error) { console.error('[preferences] read failed:', error.message); return []; }
  return (data ?? [])
    .filter((p) => p.scope === 'workspace' || !userId || p.user_id === userId)
    // An unnarrowed preference governs everything. Someone who said "write shorter" without
    // qualifying it meant it, and dropping it because the caller passed a type would be us
    // deciding we knew better.
    .filter((p) => !appliesTo || !p.applies_to || p.applies_to === appliesTo);
}

export async function removePreference(supabase, workspaceId, id, removedBy = null) {
  const { data, error } = await supabase.from('ri_preferences')
    .update({ removed_at: new Date().toISOString(), removed_by: removedBy })
    .eq('workspace_id', workspaceId).eq('id', id)
    .select('*').maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Preferences as lines for a prompt.
 *
 * Deliberately weaker in tone than a constraint and stronger than a mined rule. This is what
 * the person asked for, so it is not up for statistical debate — but it is a preference about
 * shape, not a prohibition, and an agent that treats "write shorter" as inviolable will
 * produce something useless when the situation genuinely needs length.
 */
export function renderPreferences(preferences) {
  if (!preferences?.length) return '';
  return [
    'HOW THIS OPERATOR WANTS THINGS',
    'Said outright, or made obvious by what they changed. Follow them unless the situation',
    'clearly calls for something else, and say why when you depart from one.',
    '',
    ...preferences.map((p) => {
      const seen = p.observed_count > 1 ? ` (${p.observed_count}×)` : '';
      const where = p.applies_to ? ` [${p.applies_to}]` : '';
      return `- ${p.statement}${where}${seen}`;
    }),
  ].join('\n');
}
