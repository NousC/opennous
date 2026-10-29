// /v2/intelligence — the workspace's Intelligence files, for agents (GET-1042). The MCP's
// read_intelligence reads it: the Objection playbook, Battlecards, Win/loss and the ICP's learned
// block, whole within a budget, each point ending in its id. For one account's cut, get_context
// (POST /v2/context) already carries it.
//
// Same reader as every other surface (@nous/core intelligenceFor). The workspace is the key's.
import { Router } from 'express';
import { getSupabaseClient, intelligenceFor } from '@nous/core';
import { allowQueryParams } from '../../lib/v2Query.mjs';

export const intelligenceV2Router = Router();

const AGENT_BUDGET = 12_000;

// GET /v2/intelligence → { text, used } (text null when nothing has been learned yet).
intelligenceV2Router.get('/', allowQueryParams([]), async (req, res) => {
  try {
    const out = await intelligenceFor(getSupabaseClient(), req.workspaceId, { purpose: 'agent', budget: AGENT_BUDGET });
    return res.json({ text: out?.text ?? null, used: out?.used ?? [] });
  } catch (err) {
    console.error('[GET /v2/intelligence]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
