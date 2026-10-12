/**
 * Is a webhook actually wired up for this workspace?
 *
 * ONE answer, because there used to be two. The Webhooks page calls a source "Live" off
 * real inbound deliveries logged in workspace_system_log, while the setup checklist
 * counted rows in workspace_webhook_subscriptions — a table only the "add by hand" button
 * on that page ever writes. So the honest path through the product failed the checklist:
 * connect Fireflies in Integrations, paste the inbound URL into Fireflies, watch four
 * deliveries arrive and the page badge them "Live · 1h ago", and the banner still read
 * "Finish setting up Nous 1/3 · Add a webhook".
 *
 * A delivery we logged is the strongest proof there is that the webhook exists and points
 * at us, so it wins. A hand-added subscription still counts — that's the user saying "I
 * wired this" for a source with no integration behind it (RB2B) — so nothing that passed
 * before fails now.
 *
 * Note what is deliberately NOT proof: a connected integration. The Webhooks page shows a
 * row for every connected webhook-capable provider so the URL is there to copy, but until
 * something is actually delivered that URL is sitting in our UI and nowhere else.
 */

/** The workspace_system_log event types that mean "an inbound webhook reached us". */
export const WEBHOOK_EVENT_TYPES = ['webhook_received', 'webhook_unknown_event'];

/**
 * True when this workspace has a webhook in play. Every read degrades to "no" on failure
 * (either table can be absent on a fresh install) rather than rejecting — callers use this
 * inside the onboarding gate, which must never 500 on an additive field.
 */
export async function hasLiveWebhook(supabase, workspaceId) {
  if (!workspaceId) return false;

  const [delivered, subscribed] = await Promise.all([
    supabase.from('workspace_system_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .in('event_type', WEBHOOK_EVENT_TYPES)
      .then(r => r.count ?? 0, () => 0),
    supabase.from('workspace_webhook_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .neq('status', 'removed')
      .then(r => r.count ?? 0, () => 0),
  ]);

  return delivered > 0 || subscribed > 0;
}
