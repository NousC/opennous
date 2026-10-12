import { Router } from 'express';
import { getSupabaseClient, resolveFocus, getEntity, ALL_PIPELINE_STAGES } from '@nous/core';
import {
  unknownParams, parsePaging, parseBool, resolveOwnerParam, listPublicDeals, attachOdds, enrichDealPage,
  sortDeals, shapeListDeal, loadWinOdds, resolveDealRef, loadPublicDeal, visibleTo, DEAL_SORTS,
} from '../../lib/publicApi.mjs';
import { sendOutlookList, sendAccountOutlook } from './accounts.mjs';

export const dealsV2Router = Router();

// ─── /v2/deals — the deals themselves ────────────────────────────────────────
// Read-only. A deal is a CRM deal (a `deal` entity, synced from HubSpot / Pipedrive / Attio), or
// the IMPLIED deal of an account that has no CRM deal (`implied: true`, id `implied:<account id>`
// — the one the app opens as "<Account> deal"). See lib/publicApi.mjs.
//
// The per-account outlook these paths used to serve now lives at GET /v2/accounts/outlook and
// GET /v2/accounts/:id/outlook. Older clients still reach it here: ?within_days on the list, and an
// :id that is an account rather than a deal (see below).

export const DEAL_LIST_PARAMS = new Set([
  'account', 'pipeline', 'status', 'stage', 'owner', 'closing_within_days', 'min_amount', 'implied',
  'sort', 'limit', 'offset',
]);
const STATUSES = ['open', 'won', 'lost'];

// @opennous/mcp sends X-Nous-Client: mcp; from 0.76 it also sends X-Nous-Contract: 2.
function isLegacyMcpClient(req) {
  return (req.get('X-Nous-Client') || '').toLowerCase() === 'mcp' && !req.get('X-Nous-Contract');
}

// GET /v2/deals
//   ?account=           the account (entity UUID, domain, email, LinkedIn URL or name) the deals are on
//   ?pipeline=          CRM pipeline id (GET /v2/pipelines)
//   ?status=open|won|lost
//   ?stage=             canonical stage (identified … closed_won, closed_lost, disqualified, churned)
//   ?owner=             CRM owner email (or name)
//   ?closing_within_days=N   open deals whose close date is between today and N days out
//   ?min_amount=        amount >= this (deals with no amount are excluded)
//   ?implied=true|false only implied deals / only CRM deals (default: both)
//   ?sort=last_activity (default) | close_date | amount | win_probability
//   ?limit (default 50, max 200)  ?offset
dealsV2Router.get('/', async (req, res) => {
  // BACKWARD COMPAT: @opennous/mcp before 0.76 asked GET /v2/deals (?within_days=N optional) for
  // the account-ranked outlook. `within_days` means nothing to the deal list, so it can only be that;
  // an MCP client that doesn't announce the v2 contract is one of those too, even with no params.
  if (req.query.within_days != null || isLegacyMcpClient(req)) return sendOutlookList(req, res);
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const qp = req.query;
    const bad = unknownParams(qp, DEAL_LIST_PARAMS);
    if (bad) return res.status(400).json(bad);

    const sortKey = qp.sort != null && String(qp.sort).trim() !== '' ? String(qp.sort) : 'last_activity';
    if (!(sortKey in DEAL_SORTS)) {
      return res.status(400).json({ error: 'unknown_sort', detail: `unsupported sort '${sortKey}'`, supported: Object.keys(DEAL_SORTS) });
    }
    const status = qp.status ? String(qp.status) : null;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', detail: `status must be one of ${STATUSES.join(', ')}` });
    }
    const stage = qp.stage ? String(qp.stage) : null;
    if (stage && !ALL_PIPELINE_STAGES.includes(stage)) {
      return res.status(400).json({ error: 'invalid_stage', detail: `unknown stage '${stage}'`, supported: [...ALL_PIPELINE_STAGES] });
    }
    let closingWithinDays = null;
    if (qp.closing_within_days != null && String(qp.closing_within_days).trim() !== '') {
      closingWithinDays = Number(qp.closing_within_days);
      if (!Number.isInteger(closingWithinDays) || closingWithinDays < 1 || closingWithinDays > 3650) {
        return res.status(400).json({ error: 'invalid_closing_within_days', detail: 'closing_within_days must be a whole number of days, 1-3650' });
      }
    }
    let minAmount = null;
    if (qp.min_amount != null && String(qp.min_amount).trim() !== '') {
      minAmount = Number(qp.min_amount);
      if (!Number.isFinite(minAmount)) return res.status(400).json({ error: 'invalid_min_amount', detail: 'min_amount must be a number' });
    }
    const implied = parseBool(qp.implied);
    if (implied === null) return res.status(400).json({ error: 'invalid_implied', detail: 'implied must be true or false' });
    const { limit, offset } = parsePaging(qp);

    let accountId = null;
    if (qp.account) {
      const r = await resolveFocus(supabase, workspaceId, String(qp.account));
      if (r.status === 'ambiguous') {
        return res.status(400).json({ error: 'ambiguous_account', detail: 'that name matches several records; pass an entity id or a domain', candidates: r.candidates });
      }
      const ent = r.status === 'resolved' ? await getEntity(supabase, workspaceId, r.entity_id) : null;
      // Deals hang off companies; an invisible account is not found, not forbidden.
      if (!ent || ent.type !== 'company' || !(await visibleTo(req, supabase, workspaceId, ent.id))) {
        return res.status(404).json({ error: 'account_not_found' });
      }
      accountId = ent.id;
    }
    const owner = qp.owner ? await resolveOwnerParam(supabase, workspaceId, qp.owner) : null;

    const { deals } = await listPublicDeals(supabase, req, workspaceId, {
      accountId, pipeline: qp.pipeline ? String(qp.pipeline) : null, status, stage, owner,
      closingWithinDays, minAmount, implied,
    });

    // The win odds are one outlook run for the whole workspace — only paid for when an open deal
    // is in the result.
    if (deals.some((d) => d.status === 'open')) attachOdds(deals, await loadWinOdds(supabase, workspaceId));
    const sorted = sortDeals(deals, sortKey);
    const page = await enrichDealPage(supabase, workspaceId, sorted.slice(offset, offset + limit));
    return res.json({ deals: page.map(shapeListDeal), limit, offset, has_more: sorted.length > offset + limit });
  } catch (err) {
    console.error('[GET /v2/deals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/deals/:id — one deal in full, by DEAL id: a CRM deal entity UUID or `implied:<account id>`.
// Everything in the list shape, plus stakeholders, stage_history, activity (attributed calls and
// emails, newest first, max 50), the objections / competitors / budget / timeline claims FILED to
// the deal, close_record, line_items and health_detail.
//
// BACKWARD COMPAT: this path used to take an ACCOUNT (email, domain, LinkedIn URL, UUID or name)
// and return its outlook. An :id that resolves to a company or a person — anything that is not a
// deal id — still gets exactly that response, so older @opennous/mcp clients keep working. New
// callers use GET /v2/accounts/:id/outlook.
dealsV2Router.get('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const id = String(req.params.id);
    const ref = await resolveDealRef(supabase, req, workspaceId, id);
    if (ref.status === 'not_a_deal') return sendAccountOutlook(req, res, id);
    if (ref.status === 'not_found') {
      return res.status(404).json({ error: 'deal_not_found', ...(ref.detail ? { detail: ref.detail } : {}) });
    }
    const deal = await loadPublicDeal(supabase, req, workspaceId, ref, { withOdds: true });
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    return res.json({ deal });
  } catch (err) {
    console.error('[GET /v2/deals/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
