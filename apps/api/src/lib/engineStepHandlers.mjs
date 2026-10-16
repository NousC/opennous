// The automation engine's step handlers that need the API's own guards (GET-858, GET-868). The
// engine lives in core, so the API hands it both; the worker registers the same two
// (apps/worker/src/lib/engineStepHandlers.mjs). Registered when this module is imported.
//   visible_accounts  the accounts a routine's owner may see (viewerVisibleAccountSet): null for every
//                     account, else a Set of ids. A Test on a deal reads it, and so does anything a
//                     run reads about an account on its owner's behalf.
//   safe_fetch        the SSRF guard every webhook a run posts to goes through.
import { registerStepHandler } from '@nous/core';
import { viewerVisibleAccountSet } from './visibility.mjs';
import { safeFetch } from './ssrf.mjs';

registerStepHandler('visible_accounts', async ({ supabase, workspaceId, userId }) => {
  if (!userId) return new Set();
  const { data: member, error } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const set = await viewerVisibleAccountSet(supabase, workspaceId, userId, { isAdmin: ['admin', 'owner'].includes(member?.role) });
  return set.unrestricted ? null : set.ids;
});
// safe_fetch(url, init, { maxRedirects, timeoutMs }) (pre-ship finding 4, GET-858): asking for nothing
// follows no redirect and gives up after 8s; an automation's webhook step asks for 4 redirects and
// 30s, as before the guard. Every hop is re-checked; the asks are clamped (0-4, 1-30s). The worker mirrors it.
registerStepHandler('safe_fetch', (url, init, opts = {}) => {
  const r = Number(opts?.maxRedirects), t = Number(opts?.timeoutMs);
  return safeFetch(url, init, {
    maxRedirects: Number.isFinite(r) ? Math.min(4, Math.max(0, Math.floor(r))) : 0,
    timeoutMs: Number.isFinite(t) ? Math.min(30_000, Math.max(1_000, Math.floor(t))) : 8_000,
  });
});
