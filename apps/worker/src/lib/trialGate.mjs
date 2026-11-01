// The worker's side of a lapsed trial (GET-1087): every pull asks here. Remembered for a few
// minutes so a sweep over many connections costs one read a workspace. Fails open, like the credit
// gate: a lookup glitch must not stop a paying workspace's sync. Self-host has no trial.
import { trialHasLapsed } from '@nous/core';
import { isSelfHosted } from './cloud.mjs';

const TTL_MS = 5 * 60_000;
const memo = new Map();

export async function workspaceTrialLapsed(supabase, workspaceId, { fresh = false } = {}) {
  if (!workspaceId || isSelfHosted()) return false;
  const hit = memo.get(workspaceId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.lapsed;
  try {
    const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
    const { data: sub } = ws?.team_id
      ? await supabase.from('subscriptions').select('status, trial_ends_at, stripe_subscription_id, is_comp').eq('team_id', ws.team_id).maybeSingle()
      : { data: null };
    const lapsed = trialHasLapsed(sub);
    memo.set(workspaceId, { lapsed, at: Date.now() });
    return lapsed;
  } catch {
    return false;
  }
}

/** The connections a sweep may read: everything but a lapsed trial's. */
export async function withoutLapsedTrials(supabase, connections) {
  const kept = [];
  for (const c of connections ?? []) {
    if (!(await workspaceTrialLapsed(supabase, c.workspace_id ?? c.workspaceId))) kept.push(c);
  }
  return kept;
}

export class TrialEnded extends Error {
  constructor() { super('trial ended'); this.name = 'TrialEnded'; }
}
