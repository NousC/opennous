// /api/slack/channels — read/write the channel<->account bindings from the app.
//
// The /nous slash command writes the same slack_channel_map rows from inside
// Slack; this router is the in-app equivalent, so a future Settings UI can list
// a team's channels and bind each to an account without leaving Nous.
//
// Workspace-scoped and auth'd like the rest of /api. Slack tokens never touch
// this surface — it only manages the mapping rows.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const slackChannelsRouter = Router();

// GET /api/slack/channels?workspaceId=…  — list this workspace's bindings
slackChannelsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('slack_channel_map')
      .select('id, slack_channel_id, slack_channel_name, account_ref, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return res.json({ channels: data || [] });
  } catch (err) {
    console.error('[GET /api/slack/channels]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/slack/channels  { workspaceId, slackChannelId, slackChannelName?, accountRef }
slackChannelsRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, slackChannelId, slackChannelName, accountRef } = req.body || {};
    if (!workspaceId || !slackChannelId || !accountRef) {
      return res.status(400).json({ error: 'workspaceId_slackChannelId_accountRef_required' });
    }
    const supabase = getSupabaseClient();
    // team_id comes from the workspace's Slack connection, so a mapping can't be
    // written for a workspace that hasn't connected Slack.
    const { data: provider } = await supabase
      .from('workflow_providers').select('id').eq('name', 'slack').maybeSingle();
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials')
      .eq('workspace_id', workspaceId)
      .eq('provider_id', provider?.id)
      .maybeSingle();
    const teamId = conn?.encrypted_credentials?.slack_team_id;
    if (!teamId) return res.status(409).json({ error: 'slack_not_connected' });

    const { data, error } = await supabase
      .from('slack_channel_map')
      .upsert(
        {
          workspace_id: workspaceId,
          slack_team_id: teamId,
          slack_channel_id: slackChannelId,
          slack_channel_name: slackChannelName || null,
          account_ref: accountRef,
          created_by: req.internalUserId ?? null,
        },
        { onConflict: 'workspace_id,slack_channel_id' },
      )
      .select('id, slack_channel_id, slack_channel_name, account_ref')
      .single();
    if (error) throw error;
    return res.status(201).json({ channel: data });
  } catch (err) {
    console.error('[POST /api/slack/channels]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/slack/channels/:id?workspaceId=…
slackChannelsRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    await supabase
      .from('slack_channel_map')
      .delete()
      .eq('id', id)
      .eq('workspace_id', workspaceId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/slack/channels/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
