import type { SupabaseClient } from '@supabase/supabase-js';

// Campaign message copy — the email text per (campaign, step, variant).
// Keyed by the sequencer's campaign id so it joins to the email_sent / reply
// observation attribution (rawData.campaign_id / step / variant). This is how
// "which email earned the reply" becomes answerable AND showable. See
// supabase/migrations/2026_05_29_campaign_messages.sql.

export interface CampaignMessage {
  id: string;
  workspace_id: string;
  provider: string;
  campaign_id: string;
  campaign_name: string | null;
  step: string;
  variant: string;
  subject: string | null;
  body: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertCampaignMessageParams {
  provider?: string;
  campaignId: string;
  campaignName?: string | null;
  step?: string | number | null;
  variant?: string | number | null;
  subject?: string | null;
  body?: string | null;
  source?: string;
}

// step / variant are stored as '' (never NULL) so the unique key is stable.
const norm = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? '' : String(v).trim();

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').toString().trim();
  return t.length ? t : null;
};

/**
 * Store or merge the copy for one (campaign, step, variant). Never clobbers an
 * existing subject/body with null — a sent webhook often carries only the
 * subject, and the sequencer API or the campaign writer fills the body later.
 */
export async function upsertCampaignMessage(
  supabase: SupabaseClient,
  workspaceId: string,
  params: UpsertCampaignMessageParams,
): Promise<CampaignMessage | null> {
  if (!params.campaignId) return null;
  const key = {
    workspace_id: workspaceId,
    provider: params.provider || 'unknown',
    campaign_id: String(params.campaignId),
    step: norm(params.step),
    variant: norm(params.variant),
  };
  const subject = clean(params.subject);
  const body = clean(params.body);
  const campaign_name = clean(params.campaignName);

  const { data: existing } = await supabase
    .from('campaign_messages')
    .select('id, subject, body, campaign_name')
    .eq('workspace_id', key.workspace_id)
    .eq('provider', key.provider)
    .eq('campaign_id', key.campaign_id)
    .eq('step', key.step)
    .eq('variant', key.variant)
    .maybeSingle();

  if (existing) {
    const ex = existing as { id: string; subject: string | null; body: string | null; campaign_name: string | null };
    const patch: Record<string, unknown> = {};
    if (subject && subject !== ex.subject) patch.subject = subject;
    if (body && body !== ex.body) patch.body = body;
    if (campaign_name && campaign_name !== ex.campaign_name) patch.campaign_name = campaign_name;
    if (Object.keys(patch).length === 0) return ex as unknown as CampaignMessage;
    const { data, error } = await supabase
      .from('campaign_messages')
      .update(patch)
      .eq('id', ex.id)
      .select()
      .single();
    if (error) throw error;
    return data as unknown as CampaignMessage;
  }

  const { data, error } = await supabase
    .from('campaign_messages')
    .insert({ ...key, campaign_name, subject, body, source: params.source || 'webhook' })
    .select()
    .single();
  if (error) throw error;
  return data as unknown as CampaignMessage;
}

export interface GetCampaignMessageQuery {
  provider?: string;
  campaignId: string;
  step?: string | number | null;
  variant?: string | number | null;
}

/** Look up the copy for one (campaign, step, variant). */
export async function getCampaignMessage(
  supabase: SupabaseClient,
  workspaceId: string,
  q: GetCampaignMessageQuery,
): Promise<CampaignMessage | null> {
  const { data } = await supabase
    .from('campaign_messages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider', q.provider || 'unknown')
    .eq('campaign_id', String(q.campaignId))
    .eq('step', norm(q.step))
    .eq('variant', norm(q.variant))
    .maybeSingle();
  return (data as unknown as CampaignMessage) ?? null;
}

/** All stored copy for a workspace, optionally scoped to one campaign. */
export async function listCampaignMessages(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { campaignId?: string } = {},
): Promise<CampaignMessage[]> {
  let qb = supabase
    .from('campaign_messages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (opts.campaignId) qb = qb.eq('campaign_id', String(opts.campaignId));
  const { data, error } = await qb;
  if (error) throw error;
  return (data || []) as unknown as CampaignMessage[];
}
