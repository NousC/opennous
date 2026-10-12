import {
  getSupabaseClient,
  fetchPendingDispatches,
  markDispatchDelivered,
  markDispatchFailure,
} from '@nous/core';
import { decrypt } from '../utils/encryption.mjs';

// Drains github_dispatches (filled by logActivity → enqueueGithubDispatches for
// automation-enabled seats). For each row, reads that seat's encrypted
// fine-grained GitHub token and POSTs a repository_dispatch to their repo, so
// their GitHub Action fires and runs the plugin headlessly (the after-call /
// weekly runner). Cron'd every 30s by the worker entrypoint. Mirrors
// triggerDelivery: retry with backoff, dead-letter after MAX attempts.
//
// GitHub contract: POST /repos/{owner}/{repo}/dispatches, Bearer token,
//   { event_type, client_payload }  → 204 No Content on success. The token
// needs Contents:write (which a fine-grained PAT already has for raw push).

const TIMEOUT_MS = 10_000;
const BATCH_SIZE = 50;

let isRunning = false;

export async function deliverGithubDispatches() {
  if (isRunning) return;
  isRunning = true;
  try {
    const supabase = getSupabaseClient();
    const pending = await fetchPendingDispatches(supabase, BATCH_SIZE);
    if (pending.length === 0) return;

    console.log(`[GH-DISPATCH] delivering ${pending.length} dispatch(es)`);
    // Sequential — a slow/hanging GitHub call shouldn't monopolise the loop.
    for (const d of pending) await deliverOne(supabase, d);
  } catch (err) {
    console.error('[GH-DISPATCH] loop error:', err?.message ?? err);
  } finally {
    isRunning = false;
  }
}

async function deliverOne(supabase, d) {
  // Read the seat's token fresh — never stored on the queue row. Also re-check
  // that automation is still on and the repo still connected: either may have
  // been turned off between enqueue and delivery.
  const { data: seat } = await supabase
    .from('personal_workspaces')
    .select('github_token_enc, github_repo, automation_enabled, source_type')
    .eq('workspace_id', d.workspace_id)
    .eq('user_id', d.user_id)
    .maybeSingle();

  if (!seat || seat.source_type !== 'github' || !seat.automation_enabled) {
    await markDispatchFailure(supabase, d.id, 99, null, 'automation_off_or_disconnected');
    return;
  }

  let token = null;
  try { token = seat.github_token_enc ? decrypt(seat.github_token_enc) : null; } catch { token = null; }
  if (!token) { await markDispatchFailure(supabase, d.id, 99, null, 'no_token'); return; }

  const repo = seat.github_repo || d.repo; // prefer the current repo over the snapshot
  // interaction.meeting_held → nous.meeting_held (what the workflow listens for)
  const eventType = `nous.${String(d.event_type).replace(/^interaction\./, '')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization':        `Bearer ${token}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':         'application/json',
        'User-Agent':           'Nous-Automation/1.0',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: d.client_payload }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 204 || (res.status >= 200 && res.status < 300)) {
      await markDispatchDelivered(supabase, d.id, d.attempts, res.status);
    } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // Permanent client error (bad token, repo gone, no dispatch permission) — don't retry.
      const text = await safeReadText(res);
      await markDispatchFailure(supabase, d.id, 99, res.status, text || `http_${res.status}`);
    } else {
      // 5xx, 408, 429, network — retry with backoff.
      const text = await safeReadText(res);
      await markDispatchFailure(supabase, d.id, d.attempts, res.status, text || `http_${res.status}`);
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'network_error');
    await markDispatchFailure(supabase, d.id, d.attempts, null, msg);
  }
}

async function safeReadText(res) {
  try { return (await res.text()).slice(0, 500); } catch { return null; }
}
