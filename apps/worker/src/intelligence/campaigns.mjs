// The campaign view the outbound jobs read — provider funnel per sequence from the
// stored campaign_stats (refreshed on read + by the daily campaign cron). Reply and
// opportunity rates are the behaviors outbound intelligence reasons over.

// Which provider statuses count as ACTIVE (a running campaign worth optimizing). A
// paused / completed / draft campaign gets no "optimize" rec — you don't rework
// something that isn't sending. Instantly: 1 active, 4 running subsequences (2 paused,
// 3 completed, 0 draft). Unknown providers default to active, so we never hide theirs.
const ACTIVE_STATUS = { instantly: new Set([1, 4]) };
export function isCampaignActive(c) {
  const set = ACTIVE_STATUS[String(c.provider ?? '').toLowerCase()];
  return set ? set.has(c.status) : true;
}

export async function listCampaigns(supabase, workspaceId) {
  const { data } = await supabase.from('campaign_stats')
    .select('campaign_id, campaign_name, provider, status, contacted_count, reply_count, opportunity_count')
    .eq('workspace_id', workspaceId);
  return (data ?? []).map((c) => {
    const contacted = c.contacted_count || 0;
    return {
      campaignId: c.campaign_id,
      name: c.campaign_name || c.campaign_id,
      provider: c.provider ?? null,
      status: c.status ?? null,
      contacted,
      replies: c.reply_count || 0,
      opportunities: c.opportunity_count || 0,
      replyRate: contacted > 0 ? (c.reply_count || 0) / contacted : null,
      oppRate: contacted > 0 ? (c.opportunity_count || 0) / contacted : null,
    };
  });
}
