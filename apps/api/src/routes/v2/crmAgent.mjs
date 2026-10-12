import { Router } from 'express';
import { getSupabaseClient, listCrmAgentQueue, answerCrmAgentDecision, dismissCrmAgentDecision } from '@nous/core';

// /v2/crm-agent — the human-in-the-loop queue for deal attribution.
//
// After a call, email or message Nous ingested itself lands on an account with open deals,
// the CRM agent (core/services/crmAgent) proposes which deal it was about, or asks when it
// cannot tell. This is where a rep (or an agent acting for one) answers. The answer records
// a verdict in the decision loop, files the attribution (observation_deals), and puts
// everyone on the activity onto the chosen deal. It does NOT write to the CRM: that is the
// push path, gated separately. Same shape as /v2/unresolved: list, act, dismiss.
export const crmAgentV2Router = Router();

// GET /v2/crm-agent?limit=50&entity=<company id>&all=1 — pending questions, newest first.
crmAgentV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const rows = await listCrmAgentQueue(supabase, req.workspaceId, {
      limit: Math.min(Number(req.query.limit) || 50, 200),
      entityId: req.query.entity ? String(req.query.entity) : null,
      includeAnswered: req.query.all === '1' || req.query.all === 'true',
    });
    res.json({ decisions: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /v2/crm-agent/:decisionId/answer  { answer: 'deal' | 'both' | 'neither', deal_entity_ids?: [], note? }
// `deal` needs deal_entity_ids (one or more of the proposed candidates); `both` takes every
// candidate; `neither` files nothing. The verdict written is the learning label: accepted
// (took the top pick), edited (chose differently), rejected (none).
crmAgentV2Router.post('/:decisionId/answer', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { answer, deal_entity_ids: dealEntityIds, note } = req.body || {};
    if (!['deal', 'both', 'neither'].includes(answer)) {
      return res.status(400).json({ error: 'answer_required', allowed: ['deal', 'both', 'neither'] });
    }
    const r = await answerCrmAgentDecision(supabase, req.workspaceId, req.params.decisionId, {
      answer,
      dealEntityIds: Array.isArray(dealEntityIds) ? dealEntityIds.map(String) : [],
      userId: req.userId ?? null,
      note: typeof note === 'string' ? note : null,
    });
    if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error });
    res.json({ ok: true, verdict: r.verdict, linked: r.linked, stakeholders: r.stakeholders, written_to_crm: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /v2/crm-agent/:decisionId/dismiss  { note? } — not now. No attribution, graph untouched.
crmAgentV2Router.post('/:decisionId/dismiss', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const ok = await dismissCrmAgentDecision(supabase, req.workspaceId, req.params.decisionId,
      typeof req.body?.note === 'string' ? req.body.note : null);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
