import { Router } from 'express';
import {
  getSupabaseClient, getOrCreateEntity, detectIdentifier,
  proposeDecision, recordVerdict, confirmDecision, confirmByAction, listDecisions, summarizeDecisions,
  learnedInstructions, renderInstructions, instructionsVersion,
  listConstraints, removeConstraint,
} from '@nous/core';

// /v2/decisions — the recommendation-to-outcome write door for EVERY surface.
//
// Deliberately plain HTTP rather than MCP-only. The confirmation lane is a PostToolUse
// hook — a shell script that saw a send tool return — and a hook cannot call an MCP tool.
// Keeping the substrate at HTTP is also what makes this agent-agnostic: Claude Code's hook,
// a Codex hook, a CI job, or our own app all speak the same four calls. `record` carries
// the same writes for agents that would rather stay on the one MCP write door
// (property:'decision.proposed' etc. — see routes/v2/observations.mjs).
export const decisionsV2Router = Router();

// Resolve an account reference the same way the write door does, so a proposal made about
// a person we have not met yet still lands on a real record instead of floating free.
async function resolveEntity(supabase, workspaceId, body) {
  if (body.entity_id) return body.entity_id;
  if (!body.focus) return null;
  const ident = detectIdentifier(String(body.focus));
  if (!ident) return null;
  if (ident.kind === 'entity_id') return ident.value;
  if (ident.kind === 'domain') {
    return getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: ident.value }]);
  }
  return getOrCreateEntity(supabase, workspaceId, 'person', [{ kind: ident.kind, value: ident.value }]);
}

// POST /v2/decisions — write down what was recommended, before anyone acts.
// Body: { decision_id, proposal, focus?|entity_id?, category?, action_type?, surface?,
//         agent?, rec_id?, proposal_ref?, proposal_hash?|proposal_body? }
decisionsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const entityId = await resolveEntity(supabase, workspaceId, req.body ?? {});
    const decision = await proposeDecision(supabase, workspaceId, { ...req.body, entity_id: entityId });
    return res.json({ status: 'proposed', decision_id: decision.decision_id, entity_id: decision.entity_id });
  } catch (err) {
    if (['decision_id_required', 'proposal_required'].includes(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[POST /v2/decisions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/decisions/:decisionId/verdict — what the human decided.
// Pass drafted_body + sent_body and the edit label is DERIVED, not taken on trust.
decisionsV2Router.post('/:decisionId/verdict', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const decision = await recordVerdict(supabase, req.workspaceId, req.params.decisionId, req.body ?? {});
    if (!decision) return res.status(404).json({ error: 'decision_not_found' });
    return res.json({
      status: 'recorded',
      verdict: decision.verdict,
      edit_distance: decision.edit_distance,
      edit_ratio: decision.edit_ratio,
    });
  } catch (err) {
    console.error('[POST /v2/decisions/:id/verdict]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/decisions/:decisionId/confirm — the action actually fired. This is the hook's
// endpoint. It must stay boring and forgiving: the message has already gone out by the time
// we are called, so a confirmation is never worth an error the caller has to handle.
decisionsV2Router.post('/:decisionId/confirm', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const decision = await confirmDecision(supabase, req.workspaceId, req.params.decisionId, {
      ...req.body, confirmed_via: req.body?.confirmed_via ?? 'hook',
    });
    // A confirmation for a decision we never saw proposed is a real state, not an error:
    // the agent acted without writing down its recommendation first. Say so plainly so the
    // caller can fix its skill, but never fail the call.
    if (!decision) return res.json({ status: 'unmatched', decision_id: req.params.decisionId });
    return res.json({ status: 'confirmed', decision_id: decision.decision_id });
  } catch (err) {
    console.error('[POST /v2/decisions/:id/confirm]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/decisions/confirm-by-action — confirmation from a caller that has no decision_id.
// The plugin's PostToolUse hook posts here: it saw a send tool return, it knows who the
// message went to and what the provider called it, and the server finds the proposal. This
// is the lane that does not depend on the agent choosing to report anything.
// Body: { recipient, provider?, provider_message_id?, sent_at?, sent_hash?, action_type? }
decisionsV2Router.post('/confirm-by-action', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const result = await confirmByAction(supabase, req.workspaceId, req.body ?? {});
    return res.json(result);
  } catch (err) {
    console.error('[POST /v2/decisions/confirm-by-action]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/decisions/instructions — what this workspace has learned, as guidance.
//
// The closing move of the loop: everything else records and grades, this changes what the
// agent says next. Read by the plugin's SessionStart hook (which injects it into context), by
// get_context, and by the app's drafting prompt, so all three give the same advice for the
// same reason.
//
// ?format=text returns the rendered block for a hook to cat directly; the default JSON keeps
// each rule's n and confidence so a UI can show where a rule came from.
decisionsV2Router.get('/instructions', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const block = await learnedInstructions(supabase, req.workspaceId, {
      userId: req.memberUserId ?? req.internalUserId ?? null,
    });
    if (req.query.format === 'text') {
      res.type('text/plain');
      return res.send(renderInstructions(block));
    }
    return res.json({ ...block, version: instructionsVersion(block) });
  } catch (err) {
    // Never fail the caller. A session start that breaks because we had nothing useful to add
    // is a far worse outcome than a session that simply starts without the extra context.
    console.error('[GET /v2/decisions/instructions]', err);
    return res.json({ rules: [], as_of: null, source_count: 0 });
  }
});

// GET /v2/decisions/constraints — the things this operator has ruled out.
// Visible and reversible, because a constraint the user cannot see is indistinguishable from
// a bug, and an inferred one is us concluding "never" from three refusals.
decisionsV2Router.get('/constraints', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const constraints = await listConstraints(supabase, req.workspaceId, {
      userId: req.memberUserId ?? req.internalUserId ?? null,
    });
    return res.json({ constraints, count: constraints.length });
  } catch (err) {
    console.error('[GET /v2/decisions/constraints]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /v2/decisions/constraints/:id — lift one.
// Soft, because the removal is itself a signal that we inferred wrongly, and deleting the row
// would throw away the correction along with the mistake.
decisionsV2Router.delete('/constraints/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const removed = await removeConstraint(supabase, req.workspaceId, req.params.id,
      req.memberUserId ?? req.internalUserId ?? null);
    if (!removed) return res.status(404).json({ error: 'constraint_not_found' });
    return res.json({ status: 'removed', id: removed.id });
  } catch (err) {
    console.error('[DELETE /v2/decisions/constraints/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/decisions/summary — the inspection surface behind Settings → Decision loop.
// Mounted before the list route so the literal path wins over nothing; ?days= widens the window.
decisionsV2Router.get('/summary', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    return res.json(await summarizeDecisions(supabase, req.workspaceId, { days }));
  } catch (err) {
    console.error('[GET /v2/decisions/summary]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/decisions — read the loop back. ?entity_id= ?status= ?verdict= ?limit=
decisionsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const decisions = await listDecisions(supabase, req.workspaceId, {
      entityId: req.query.entity_id,
      status: req.query.status,
      verdict: req.query.verdict,
      limit: req.query.limit,
    });
    return res.json({ decisions, count: decisions.length });
  } catch (err) {
    console.error('[GET /v2/decisions]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
