import type { SupabaseClient } from '@supabase/supabase-js';

// Which Linear issue an Insights topic went to (supabase/migrations/2026_10_09_linear_issue_links.sql).
//
// The row doubles as the send's lock. A send first CLAIMS the topic (a 'pending' row; the primary
// key on workspace + topic means only one claim can exist), then fills in the issue the moment it
// exists ('linked'), so a failure after that can never file a second issue. A claim older than
// CLAIM_STALE_MS is one a crashed send left behind and may be taken over.

export const CLAIM_STALE_MS = 2 * 60_000;

export interface LinearIssueLink {
  workspace_id: string; topic_key: string; status: 'pending' | 'linked';
  linear_issue_id: string | null; identifier: string | null; url: string | null; team_id: string | null;
  sent_item_ids: string[] | null; claimed_at: string | null;
}

const COLS = 'workspace_id, topic_key, status, linear_issue_id, identifier, url, team_id, sent_item_ids, claimed_at';

export async function getLinearIssueLink(supabase: SupabaseClient, workspaceId: string, topicKey: string): Promise<LinearIssueLink | null> {
  const { data, error } = await supabase.from('linear_issue_links').select(COLS)
    .eq('workspace_id', workspaceId).eq('topic_key', topicKey).maybeSingle();
  if (error) throw error;
  return (data as LinearIssueLink | null) ?? null;
}

/**
 * Take the topic for one send. Returns the link to work from (a linked row keeps its issue), or
 * null when another send holds a fresh claim.
 */
export async function claimLinearIssueLink(supabase: SupabaseClient, workspaceId: string, topicKey: string): Promise<LinearIssueLink | null> {
  const now = new Date().toISOString();
  const existing = await getLinearIssueLink(supabase, workspaceId, topicKey);
  if (!existing) {
    // INSERT … ON CONFLICT DO NOTHING: of two sends racing for a new topic, one gets the row.
    const { data, error } = await supabase.from('linear_issue_links').upsert({
      workspace_id: workspaceId, topic_key: topicKey, status: 'pending', claimed_at: now, sent_item_ids: [],
    }, { onConflict: 'workspace_id,topic_key', ignoreDuplicates: true }).select(COLS);
    if (error) throw error;
    return ((data as LinearIssueLink[] | null) ?? [])[0] ?? null;
  }
  const fresh = existing.claimed_at && Date.now() - Date.parse(existing.claimed_at) < CLAIM_STALE_MS;
  if (fresh) return null;
  // Stale or released: take it, guarded on the claim we read so two takers cannot both win.
  let q = supabase.from('linear_issue_links').update({ claimed_at: now })
    .eq('workspace_id', workspaceId).eq('topic_key', topicKey);
  q = existing.claimed_at ? q.eq('claimed_at', existing.claimed_at) : q.is('claimed_at', null);
  const { data, error } = await q.select(COLS);
  if (error) throw error;
  return ((data as LinearIssueLink[] | null) ?? [])[0] ?? null;
}

export async function linkLinearIssue(
  supabase: SupabaseClient, workspaceId: string, topicKey: string,
  issue: { id: string; identifier: string; url: string }, teamId: string | null,
): Promise<void> {
  const { error } = await supabase.from('linear_issue_links').update({
    status: 'linked', linear_issue_id: issue.id, identifier: issue.identifier, url: issue.url, team_id: teamId,
  }).eq('workspace_id', workspaceId).eq('topic_key', topicKey);
  if (error) throw error;
}

/** Record what this send filed and let go of the claim. */
export async function finishLinearIssueLink(
  supabase: SupabaseClient, workspaceId: string, topicKey: string, sentItemIds: string[], userId: string | null,
): Promise<void> {
  const { error } = await supabase.from('linear_issue_links').update({
    sent_item_ids: sentItemIds, last_sent_at: new Date().toISOString(), last_sent_by: userId, claimed_at: null,
  }).eq('workspace_id', workspaceId).eq('topic_key', topicKey);
  if (error) throw error;
}

/** A send that failed before any issue existed: drop its pending row so the next send starts clean. */
export async function releaseLinearIssueClaim(supabase: SupabaseClient, workspaceId: string, topicKey: string): Promise<void> {
  await supabase.from('linear_issue_links').delete()
    .eq('workspace_id', workspaceId).eq('topic_key', topicKey).eq('status', 'pending');
}
