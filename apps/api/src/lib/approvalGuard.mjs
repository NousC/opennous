// Who may approve a paused automation (GET-1062). An approval is a person standing behind a step,
// so a key with no person can't give one, and a key can't approve a run it started: that would be
// an agent signing off its own work. Reject stays open, since stopping a run is never the risk.
// Every route that decides a run goes through this; /v2/approvals and /api/automations both take keys.

/** Who decided, for the run's log. */
export const decidedBy = (req) => (req.noContent ? null : req.memberUserId ?? req.internalUserId ?? null);

/** Refuse an approval this caller can't give. Returns whether it answered. */
export async function refuseApproval(supabase, req, res, runId) {
  if (!req.isApiKeyAuth) return false;
  if (req.noContent) {
    res.status(403).json({ error: 'approver_must_be_person', message: 'An approval needs a person. Use a member key, or approve it in OpenNous.' });
    return true;
  }
  const { data: run } = await supabase.from('agent_routine_runs').select('started_by_key')
    .eq('workspace_id', req.workspaceId).eq('id', runId).maybeSingle();
  if (!run?.started_by_key) return false;
  // The person, not just the key: a rotated key or their second connector is still them. A revoked
  // key keeps its row, so its owner can be read after rotation.
  const { data: starter } = await supabase.from('api_keys').select('owner_user_id')
    .eq('id', run.started_by_key).maybeSingle();
  if (run.started_by_key === req.apiKeyId || (starter?.owner_user_id && starter.owner_user_id === req.memberUserId)) {
    res.status(403).json({ error: 'cannot_approve_own_run', message: 'The agent that started this run can\'t approve it. Approve it in OpenNous.' });
    return true;
  }
  return false;
}

/** Note which key started a run, once it has a row. A run started by a person or a trigger has none. */
export async function stampRunStarter(supabase, req, runId) {
  if (!req.apiKeyId || !runId) return;
  await supabase.from('agent_routine_runs').update({ started_by_key: req.apiKeyId }).eq('id', runId);
}
