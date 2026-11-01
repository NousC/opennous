// After a no-card trial ends, every key call stops until they subscribe (GET-1087): MCP, API, CLI,
// reads included. A clear 402, not a 500 or an empty list, so an agent can say what to do. The data
// is kept and answers again the moment they pay. Browsers are not gated here: the app draws a
// subscribe screen, and billing and admin stay reachable. Only /v2/usage passes, so a key can still
// read where it stands. Free rows, paid plans and self-host never match. Fails open, like the meters.
import { trialHasLapsed, getSupabaseClient } from '@nous/core';
import { isSelfHosted } from './plans.mjs';

const TTL_MS = 15_000;   // short: paying has to bring the key back at once
const memo = new Map();

async function subscriptionOf(workspaceId) {
  const hit = memo.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.sub;
  const supabase = getSupabaseClient();
  const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  const { data: sub } = ws?.team_id
    ? await supabase.from('subscriptions').select('status, trial_ends_at, stripe_subscription_id, is_comp').eq('team_id', ws.team_id).maybeSingle()
    : { data: null };
  memo.set(workspaceId, { sub, at: Date.now() });
  return sub;
}

export const TRIAL_ENDED_BODY = {
  error: 'subscribe_required',
  reason: 'trial_ended',
  message: 'Your OpenNous trial has ended, so everything has stopped. Subscribe to continue: your data is kept and comes back the moment you do.',
  subscribe_url: '/billing?upgrade=1',
};

export async function trialEndedGate(req, res, next, { subscription = subscriptionOf, selfHosted = isSelfHosted() } = {}) {
  if (selfHosted || !req.workspaceId || String(req.baseUrl ?? '').startsWith('/v2/usage')) return next();
  try {
    if (trialHasLapsed(await subscription(req.workspaceId))) return res.status(402).json(TRIAL_ENDED_BODY);
  } catch (err) {
    console.warn('[trialEndedGate] fail-open:', err?.message);
  }
  return next();
}
