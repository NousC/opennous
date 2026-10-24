import type { SupabaseClient } from '@supabase/supabase-js';

// A personal mark skips everything its person says (extraction returns nothing for them), and a
// Slack conversation read while the mark was on is still recorded as read, so it is never read
// again (GET-1024). Unmarking puts those conversations back in the queue: clearing a read's
// fingerprint is what makes the next Slack pass read it again. Only reads finished while the mark
// was on are touched; the pass's own invalidation keeps a re-read from duplicating anything.

const SLACK_REF = /^source:\/\/slack\/([^/]+)\/([^/]+)\/([^/]+)\//;

/** The Slack conversations a source ref points into, deduplicated. Pure. */
export function slackConversations(refs: unknown[]): { teamId: string; channelId: string; conversationId: string }[] {
  const seen = new Map<string, { teamId: string; channelId: string; conversationId: string }>();
  for (const ref of refs) {
    const m = typeof ref === 'string' ? ref.match(SLACK_REF) : null;
    if (m) seen.set(`${m[1]}/${m[2]}/${m[3]}`, { teamId: m[1], channelId: m[2], conversationId: m[3] });
  }
  return [...seen.values()];
}

/**
 * Queue a fresh read of every Slack conversation that carried a message from `entityId` (or, for a
 * company, from its people) and was read since `since`, when the mark went on. Best-effort: returns
 * the number of conversations queued, 0 on any failure.
 */
export async function rereadSlackSince(
  supabase: SupabaseClient, workspaceId: string, entityId: string, since: string,
): Promise<number> {
  try {
    const { data: people } = await supabase.from('entity_list_rows').select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', 'person').eq('company_id', entityId);
    const ids = [entityId, ...(people ?? []).map((p: any) => p.entity_id)];
    const { data: msgs, error } = await supabase.from('observations').select('raw')
      .eq('workspace_id', workspaceId).in('entity_id', ids)
      .in('property', ['interaction.slack_message', 'interaction.slack_dm'])
      .gte('created_at', since).limit(1000);
    if (error) throw error;
    let queued = 0;
    for (const c of slackConversations((msgs ?? []).map((m: any) => m.raw?.source_ref))) {
      const { data: src } = await supabase.from('slack_ingestion_sources').select('id')
        .eq('workspace_id', workspaceId).eq('slack_team_id', c.teamId).eq('slack_channel_id', c.channelId);
      for (const s of src ?? []) {
        const { data: done } = await supabase.from('slack_ingestion_reads').update({ fingerprint: null })
          .eq('source_id', (s as any).id).eq('conversation_id', c.conversationId).gte('processed_at', since)
          .select('conversation_id');
        queued += done?.length ?? 0;
      }
    }
    return queued;
  } catch (err: any) {
    console.warn('[PERSONAL] Slack re-read failed:', err?.message ?? err);
    return 0;
  }
}
