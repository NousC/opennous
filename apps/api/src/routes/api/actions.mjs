// /api/actions — the approval gate between the agent and the outside world.
//
// The agent proposes; a human disposes. Nothing here can be triggered by the
// model: approving is a POST that only ever arrives from a person clicking a
// button, and it is the ONLY path from a draft to a real LinkedIn send.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { sendProposedAction } from '../../services/linkedinSend.mjs';

export const actionsRouter = Router();

// Everything still waiting on you, newest first.
actionsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, threadId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    let q = supabase
      .from('pending_actions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (threadId) q = q.eq('thread_id', threadId);

    const { data, error } = await q;
    if (error) throw error;
    return res.json({ actions: data ?? [] });
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
    if (action.workspace_id !== req.workspaceId) return res.status(403).json({ error: 'forbidden' });
    // Approving twice must not send twice. The status IS the lock.
    if (action.status !== 'pending') {
      return res.status(409).json({ error: 'already_decided', status: action.status });
    }

    const body = typeof req.body?.body === 'string' && req.body.body.trim()
      ? req.body.body.trim()
      : action.body;

    try {
      const result = await sendProposedAction(supabase, { ...action, body });
      await supabase.from('pending_actions').update({
        status: 'sent', result, body, decided_at: new Date().toISOString(),
      }).eq('id', action.id);
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

actionsRouter.post('/:id/reject', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('pending_actions')
      .update({ status: 'rejected', decided_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('workspace_id', req.workspaceId)
      .eq('status', 'pending');
    if (error) throw error;
    return res.status(204).end();
  } catch (err) {
    console.error('[POST /api/actions/:id/reject]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
