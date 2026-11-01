// Which enabled routines may start at all (GET-1087). Asked by every pass over agent_routines. A
// lapsed trial runs nothing until it pays, and a personal RevPlay stops with its owner: it runs as
// them, so it has no one to run as once they leave the workspace. Both read nothing but ids and
// fail open on a lookup that returns nothing, like the credit gate.
import { trialHasLapsed } from './trialGate.mjs';

export async function dropStoppedRoutines(supabase, rows) {
  try { return await dropping(supabase, rows ?? []); } catch { return rows ?? []; }
}

async function dropping(supabase, list) {
  const ids = [...new Set(list.map(r => r.workspace_id).filter(Boolean))];
  if (!ids.length) return list;
  const { data: spaces } = await supabase.from('workspaces').select('id, team_id').in('id', ids);
  const teams = [...new Set((spaces ?? []).map(w => w.team_id).filter(Boolean))];
  const { data: subs } = teams.length
    ? await supabase.from('subscriptions').select('team_id, status, trial_ends_at, stripe_subscription_id, is_comp').in('team_id', teams)
    : { data: [] };
  const lapsedTeams = new Set((subs ?? []).filter(s => trialHasLapsed(s)).map(s => s.team_id));
  const lapsed = new Set((spaces ?? []).filter(w => lapsedTeams.has(w.team_id)).map(w => w.id));
  const personal = list.filter(r => r.visibility === 'personal');
  let members = null;
  if (personal.length) {
    const { data } = await supabase.from('workspace_members').select('workspace_id, user_id')
      .in('workspace_id', [...new Set(personal.map(r => r.workspace_id))]);
    if (data) members = new Set(data.map(m => `${m.workspace_id}:${m.user_id}`));
  }
  return list.filter(r => !lapsed.has(r.workspace_id)
    && (r.visibility !== 'personal' || !members || members.has(`${r.workspace_id}:${r.user_id}`)));
}
