// The automation steps that need the API's own connections (GET-543). The step runner lives in
// core and runs in the worker as well as here; Slack's bot token is decrypted only here. So the API
// registers the handler for itself at boot, and the worker reaches the same handler through
// POST /internal/automation-steps/slack (routes/automationSteps.mjs). Slack itself is Cloud's.
import { createFollowUpDraft } from '../services/gmailDraft.mjs';
import { sendGmailEmail, deleteGmailDraft } from '../services/gmailSend.mjs';
import { trackLlmUsage } from './llmUsage.mjs';
export { sendFromSmtp as automationSmtpSend } from './automationMailboxes.mjs';

/** Record an automation run's model use against the workspace's credits. */
export function meterAutomation({ supabase, workspaceId, feature, model, usage, requestId = null }) {
  if (!model || !usage) return;
  trackLlmUsage(supabase, { workspaceId, feature: feature || 'automation-handoff', model, usage, requestId });
}

/** A real draft in the automation owner's own Gmail. Never sent. { status: created | no_gmail | failed }. */
export function automationGmailDraft({ supabase, workspaceId, userId, to, cc = null, subject, body, connectionId = null }) {
  const list = String(to ?? '').split(',').map(x => x.trim()).filter(Boolean);
  return createFollowUpDraft(supabase, { workspaceId, userId, to: list, cc, subject, body, connectionId });
}

/** Send from the same Gmail, after a person approved it with Send in Approvals (GET-731). */
export function automationGmailSend({ supabase, workspaceId, userId, to, cc = null, subject, body, connectionId = null }) {
  return sendGmailEmail(supabase, { workspaceId, userId, to, cc, subject, body, connectionId });
}

/** Remove the draft an edited send replaced. */
export function automationGmailDeleteDraft({ supabase, workspaceId, userId, draftId, connectionId = null }) {
  return deleteGmailDraft(supabase, { workspaceId, userId, draftId, connectionId });
}

// Slack is Cloud's (GET-754): cloud/lib/automationSlack.mjs posts with the workspace's bot and
// registers itself here at boot, for POST /internal/automation-steps/slack. Without it the step
// stops with the same reason the step runner gives when no Slack handler exists.
let slackPoster = null;
export function registerAutomationSlack(fn) { slackPoster = fn; }

/** Post an automation's message to a channel with the workspace's Slack bot, when this build has Slack. */
export async function postAutomationSlack(args) {
  if (!slackPoster) return { ok: false, reason: 'slack_not_available_here' };
  return slackPoster(args);
}
