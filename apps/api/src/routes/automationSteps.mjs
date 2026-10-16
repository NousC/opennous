// Internal worker→api endpoint for automation steps that need the API's connections (GET-543).
//
// POST /internal/automation-steps/slack        { workspaceId, channel, text, format?, content? } →  { ok, reason? }
// POST /internal/automation-steps/gmail-draft  { workspaceId, userId, to, cc?, subject, body, connectionId? }  →  { status, … }
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
  const { workspaceId, channel, channelId, userId, text, format, content, ...rest } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ ok: false, reason: 'workspace_required' });
  // A Slack layout (GET-858): the step's format and the AI's content; the poster renders the blocks.
  // Its references (runId, stepId, accountId, and any an engine extension adds, GET-910) are short ids.
  const id = (v) => (typeof v === 'string' && v.length <= 80 ? v : null);
  const refs = Object.fromEntries(['runId', 'stepId', 'accountId', ...Object.keys(rest).filter(k => /^[a-z][A-Za-z]{0,30}Id$/.test(k))].map(k => [k, id(rest[k])]));
  const layout = typeof format === 'string' && content && typeof content === 'object' && !Array.isArray(content)
    ? { format: format.slice(0, 20), content, ...refs } : {};
  try {
    return res.json(await postAutomationSlack({ supabase: getSupabaseClient(), workspaceId, channel: String(channel ?? ''), channelId: channelId ?? null, userId: userId ?? null, text, ...layout }));
  } catch (err) {
    console.error('[POST /internal/automation-steps/slack]', err);
    return res.status(500).json({ ok: false, reason: 'internal_error' });
  }
});

/** The worker's gmail-draft body as automationGmailDraft's arguments, Cc included (review 5). Pure. */
export function gmailDraftArgs(b) {
  const { workspaceId, userId, to, cc, subject, body, connectionId } = b ?? {};
  return { workspaceId, userId: userId ?? null, to: to ?? null, cc: cc ?? null, subject, body, connectionId: connectionId ?? null };
}

automationStepsInternalRouter.post('/gmail-draft', async (req, res) => {
  const { workspaceId } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ status: 'failed', error: 'workspace_required' });
  try {
    return res.json(await automationGmailDraft({ supabase: getSupabaseClient(), ...gmailDraftArgs(req.body) }));
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
