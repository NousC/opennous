// Campaign message copy — the email text per (campaign, step, variant).
// Read for the People timeline body-fill + the campaign-performance view;
// written by the campaign-writer skill or a sequencer-API sync.
// See packages/core/src/db/campaignMessages.ts.

import { Router } from 'express';
import {
  getSupabaseClient,
  listCampaignMessages,
  upsertCampaignMessage,
} from '@nous/core';

export const campaignMessagesRouter = Router();

// GET /api/campaign-messages?workspaceId=&campaignId= — stored copy.
campaignMessagesRouter.get('/', async (req, res) => {
  try {
    const { workspaceId, campaignId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const messages = await listCampaignMessages(getSupabaseClient(), workspaceId, {
      campaignId: campaignId || undefined,
    });
    return res.json({ messages });
  } catch (err) {
    console.error('[GET /api/campaign-messages]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/campaign-messages — store/merge copy for a (campaign, step, variant).
// Body: { workspaceId?, provider?, campaignId, campaignName?, step?, variant?, subject?, body?, source? }.
// `workspaceId` is optional under API-key auth (the key implies the workspace).
campaignMessagesRouter.post('/', async (req, res) => {
  try {
    const workspaceId = req.body.workspaceId || req.workspaceId;
    const { provider, campaignId, campaignName, step, variant, subject, body, source } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
    const message = await upsertCampaignMessage(getSupabaseClient(), workspaceId, {
      provider, campaignId, campaignName, step, variant, subject, body, source: source || 'api',
    });
    return res.status(201).json({ message });
  } catch (err) {
    console.error('[POST /api/campaign-messages]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
