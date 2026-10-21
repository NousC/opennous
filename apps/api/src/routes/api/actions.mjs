// /api/actions — the approval gate between the agent and the outside world.
//
// The agent proposes; a human disposes. Nothing here can be triggered by the
// model: approving is a POST that only ever arrives from a person clicking a
// button, and it is the ONLY path from a draft to a real LinkedIn send.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';
import { sendProposedAction } from '../../services/actionSend.mjs';
import { recordVerdict, confirmDecision } from '@nous/core';
import { withOrigins } from '../../lib/actionOrigin.mjs';
import { SIGNAL_REC_KEYS } from '../../lib/detectorDrafts.mjs';
import { sendableMailboxes, chosenMailbox } from '../../lib/automationMailboxes.mjs';

export const actionsRouter = Router();

// Everything still waiting on you, newest first.
//
// Optional, additive (GET-681, the Priorities inbox):
//   status=pending  only the drafts still waiting (the default stays every status)
//   scope=mine      only drafts that send as the caller (or as nobody in particular)
//   include=origin  each action gains `origin` (which automation / play / conversation wrote it,
//                   when and why — lib/actionOrigin.mjs) and `account` (the company it is for)
// GET /api/actions/mailboxes?workspaceId= — the Gmail accounts you can send a draft from (GET-745),
// for the From picker on every draft. Your own only.
actionsRouter.get('/mailboxes', verifySupabaseAuth, async (req, res) => {
  try {
    const ws = req.query.workspaceId;
    if (!ws || !(await isWorkspaceMember(getSupabaseClient(), ws, req.internalUserId))) return res.status(403).json({ error: 'forbidden' });
    const mailboxes = await sendableMailboxes(getSupabaseClient(), ws, req.internalUserId);
    return res.json({ mailboxes, default_id: mailboxes[0]?.id ?? null });
  } catch (err) {
    console.error('[GET /api/actions/mailboxes]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

actionsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, threadId, status, scope, include } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    let q = supabase
      .from('pending_actions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (threadId) q = q.eq('thread_id', threadId);
    if (status === 'pending') q = q.eq('status', 'pending');
    if (scope === 'mine' && req.internalUserId) q = q.or(`user_id.eq.${req.internalUserId},user_id.is.null`);

    const { data, error } = await q;
    if (error) throw error;
    let actions = data ?? [];
    if (String(include ?? '').split(',').includes('origin')) {
      // Best-effort: the drafts are what matter; a trail that fails to load leaves them unlabelled.
      actions = await withOrigins(supabase, workspaceId, actions).catch((e) => {
        console.error('[GET /api/actions] origin lookup failed:', e?.message);
        return actions;
      });
    }
    return res.json({ actions });
  } catch (err) {
    console.error('[GET /api/actions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Approve and send.
//
// The body may carry an edited `body` — you should be able to fix a word without
// going back to the agent, and the thing that gets sent must be the thing you
// actually read and approved, not what the model wrote a minute earlier.
actionsRouter.post('/:id/approve', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: action } = await supabase
      .from('pending_actions').select('*').eq('id', req.params.id).maybeSingle();

    if (!action) return res.status(404).json({ error: 'not_found' });
    // Authorize off the ACTION's workspace + the user's membership — the approve/reject
    // buttons don't pass a workspaceId, so req.workspaceId can be undefined.
    if (!(await isWorkspaceMember(supabase, action.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // Approving twice must not send twice. The status IS the lock.
    if (action.status !== 'pending') {
      return res.status(409).json({ error: 'already_decided', status: action.status });
    }

    const body = typeof req.body?.body === 'string' && req.body.body.trim()
      ? req.body.body.trim()
      : action.body;
    // Email drafts can also have their subject and recipient edited before sending.
    const subject = typeof req.body?.subject === 'string'
      ? req.body.subject.trim()
      : action.subject;
    const recipientEmail = typeof req.body?.to === 'string' && req.body.to.includes('@')
      ? req.body.to.trim()
      : action.recipient_email;

    // From (GET-745): a mailbox the approver picked, only ever one of their own; else their own Gmail.
    let connectionId = null;
    if (action.kind === 'email') {
      const picked = await chosenMailbox(supabase, action.workspace_id, req.internalUserId, req.body?.from ?? null);
      if (picked === false) return res.status(403).json({ error: 'mailbox_not_yours', message: 'You can only send from your own mailbox.' });
      connectionId = picked?.id ?? (await sendableMailboxes(supabase, action.workspace_id, req.internalUserId))[0]?.id ?? null;
    }

    try {
      const result = await sendProposedAction(supabase, { ...action, body, subject, recipient_email: recipientEmail, connection_id: connectionId });
      await supabase.from('pending_actions').update({
        status: 'sent', result, body, subject, recipient_email: recipientEmail,
        decided_at: new Date().toISOString(),
      }).eq('id', action.id);
      // Close the decision loop for the app surface. This handler is the one place in the
      // product that holds BOTH versions of the message — what we drafted (action.body) and
      // what the human actually sent (body) — so accepted-vs-edited is measured here, not
      // guessed. Best-effort by design: the message is already gone, and failing the
      // response now would tell the user it wasn't.
      try {
        await recordVerdict(supabase, action.workspace_id, `app:${action.id}`, {
          verdict: 'accepted', drafted_body: action.body, sent_body: body,
        });
        await confirmDecision(supabase, action.workspace_id, `app:${action.id}`, {
          confirmed_via: 'app',
          provider: action.kind === 'email' ? 'gmail' : 'unipile',
          provider_message_id: result?.message_id ?? result?.id ?? null,
        });
      } catch (e) {
        console.error('[actions.approve] decision loop write failed:', e.message);
      }
      return res.json({ status: 'sent', result });
    } catch (err) {
      // A failed send stays visible and stays actionable. Silently swallowing it
      // would leave you believing a message went out that never did.
      await supabase.from('pending_actions').update({
        status: 'failed', error: String(err.message ?? err).slice(0, 500),
      }).eq('id', action.id);
      return res.status(502).json({ error: 'send_failed', detail: String(err.message ?? err) });
    }
  } catch (err) {
    console.error('[POST /api/actions/:id/approve]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/actions/:id/snooze { days } — a signal's draft leaves the inbox for a few days (GET-944).
// The draft stays pending; the snooze is written on the ledger row it came from (rec_id), with the
// draft's id, and the origin reads it back (snoozed_until) for that draft only, so the inbox leaves
// it out until then.
export const SNOOZE_DAYS = [1, 3, 7];
actionsRouter.post('/:id/snooze', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const days = Number(req.body?.days ?? 3);
    if (!SNOOZE_DAYS.includes(days)) return res.status(400).json({ error: 'invalid_days', allowed: SNOOZE_DAYS });
    const { data: action } = await supabase
      .from('pending_actions').select('workspace_id, rec_id, status').eq('id', req.params.id).maybeSingle();
    if (!action) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, action.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (action.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
    if (!action.rec_id) return res.status(409).json({ error: 'not_snoozable' });
    const { data: rec, error: re } = await supabase.from('ri_recommendations')
      .select('id, rec_key, evidence').eq('id', action.rec_id).eq('workspace_id', action.workspace_id).maybeSingle();
    if (re) throw re;
    // Only a signal's next move snoozes (the From signals group, GET-953); other drafts are sent or skipped.
    if (!rec || !SIGNAL_REC_KEYS.has(rec.rec_key)) return res.status(409).json({ error: 'not_snoozable' });
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    const { error } = await supabase.from('ri_recommendations')
      .update({ evidence: { ...(rec.evidence ?? {}), snoozed_until: until, snoozed_action_id: req.params.id }, updated_at: new Date().toISOString() })
      .eq('id', rec.id);
    if (error) throw error;
    return res.json({ snoozed_until: until });
  } catch (err) {
    console.error('[POST /api/actions/:id/snooze]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

actionsRouter.post('/:id/reject', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: action } = await supabase
      .from('pending_actions').select('workspace_id').eq('id', req.params.id).maybeSingle();
    if (!action) return res.status(404).json({ error: 'not_found' });
    // Authorize off the action's workspace (the button doesn't pass a workspaceId).
    if (!(await isWorkspaceMember(supabase, action.workspace_id, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // A rejection is data. Recording it is what lets the engine learn which of its
    // recommendations experienced operators throw away — the signal is lost entirely if
    // we only ever write down the drafts that got sent.
    try {
      await recordVerdict(supabase, action.workspace_id, `app:${req.params.id}`, {
        verdict: 'rejected', verdict_note: typeof req.body?.reason === 'string' ? req.body.reason : null,
      });
    } catch (e) {
      console.error('[actions.reject] decision loop write failed:', e.message);
    }

    const { error } = await supabase
      .from('pending_actions')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', 'pending');
    if (error) throw error;
    return res.status(204).end();
  } catch (err) {
    console.error('[POST /api/actions/:id/reject]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
