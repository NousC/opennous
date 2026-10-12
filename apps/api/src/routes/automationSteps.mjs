// Internal worker→api endpoint for automation steps that need the API's connections (GET-543).
//
// POST /internal/automation-steps/slack        { workspaceId, channel, text }             →  { ok, reason? }
// POST /internal/automation-steps/gmail-draft  { workspaceId, userId, to, subject, body }  →  { status, … }
//
// Mounted unauthenticated and guarded by WORKER_SECRET, like /internal/detector-drafts.
import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { postAutomationSlack, automationGmailDraft, meterAutomation, automationSmtpSend } from '../lib/automationSteps.mjs';

export const automationStepsInternalRouter = Router();

automationStepsInternalRouter.use((req, res, next) => {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return res.status(404).json({ error: 'not_found' });
  if (req.get('x-worker-secret') !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
});

automationStepsInternalRouter.post('/slack', async (req, res) => {
  const { workspaceId, channel, channelId, userId, text } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ ok: false, reason: 'workspace_required' });
  try {
    return res.json(await postAutomationSlack({ supabase: getSupabaseClient(), workspaceId, channel: String(channel ?? ''), channelId: channelId ?? null, userId: userId ?? null, text }));
  } catch (err) {
    console.error('[POST /internal/automation-steps/slack]', err);
    return res.status(500).json({ ok: false, reason: 'internal_error' });
  }
});

automationStepsInternalRouter.post('/gmail-draft', async (req, res) => {
  const { workspaceId, userId, to, subject, body, connectionId } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ status: 'failed', error: 'workspace_required' });
  try {
    return res.json(await automationGmailDraft({ supabase: getSupabaseClient(), workspaceId, userId: userId ?? null, to: to ?? null, subject, body, connectionId: connectionId ?? null }));
  } catch (err) {
    console.error('[POST /internal/automation-steps/gmail-draft]', err);
    return res.status(500).json({ status: 'failed', error: 'internal_error' });
  }
});

automationStepsInternalRouter.post('/meter', async (req, res) => {
  const { workspaceId, feature, model, usage, requestId } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ ok: false });
  meterAutomation({ supabase: getSupabaseClient(), workspaceId, feature, model, usage, requestId: typeof requestId === 'string' ? requestId.slice(0, 200) : null });
  return res.json({ ok: true });
});

automationStepsInternalRouter.post('/smtp-send', async (req, res) => {
  const { workspaceId, connectionId, to, subject, body } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ ok: false, reason: 'workspace_required' });
  try {
    return res.json(await automationSmtpSend({ supabase: getSupabaseClient(), workspaceId, connectionId, to, subject, body }));
  } catch (err) {
    console.error('[POST /internal/automation-steps/smtp-send]', err);
    return res.status(500).json({ ok: false, reason: 'internal_error' });
  }
});
