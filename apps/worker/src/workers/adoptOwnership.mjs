// Nightly: give every member the company-source records their own address already names (GET-284).
//
// Joining runs this once, which covers the common case. It is not enough on its own: a rep connects
// their mailbox a week later (a new address), an admin adds a seat by hand, a CRM re-sync brings in
// deals for a rep who joined yesterday. Each of those leaves records addressed to somebody who is
// now here, still waiting. So it runs again every night, for every workspace that has a CRM or a
// company note-taker connected.
//
// Cheap when there is nothing to do: one query per member per address, matching on an indexed
// equality, and nothing is written unless a row has no owner at all.

import { getSupabaseClient, adoptCrmOwnership } from '@nous/core';

export async function runAdoptOwnership() {
  const supabase = getSupabaseClient();
  // Workspaces where a company source could have left records addressed to a person: a CRM sync
  // config, or any connection at all (the note-taker's rows carry a host email too).
  const { data: configs } = await supabase.from('crm_sync_configs').select('workspace_id');
  const ids = [...new Set((configs ?? []).map(c => c.workspace_id))];
  let claimedActivities = 0, claimedAccounts = 0;

  for (const workspaceId of ids) {
    const { data: members } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId);
    for (const m of members ?? []) {
      try {
        const r = await adoptCrmOwnership(supabase, workspaceId, m.user_id);
        claimedActivities += r.activities;
        claimedAccounts += r.accounts;
      } catch (e) {
        console.warn('[ADOPT_OWNERSHIP] ws=%s user=%s %s', workspaceId, m.user_id, e?.message || e);
      }
    }
  }
  if (claimedActivities || claimedAccounts) {
    console.log(`[ADOPT_OWNERSHIP] claimed ${claimedActivities} conversations and ${claimedAccounts} accounts across ${ids.length} workspaces`);
  }
}
