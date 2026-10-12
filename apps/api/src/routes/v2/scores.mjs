import { Router } from 'express';
import {
  getSupabaseClient, resolveFocus, getIcpScorer, getTierThresholds, writeExternalScore, normalizeScorerName, ICP_TIERS,
} from '@nous/core';
import { allowQueryParams } from '../../lib/v2Query.mjs';

export const scoresV2Router = Router();

const MAX_BATCH = 500;

// POST /v2/scores — bring your own ICP scorer (GET-586).
//
// The workspace scores its accounts with its own system (its rules, a decision model, a
// spreadsheet) and posts the result here. Each score lands as the account's icp_fit prediction, so
// get_context, get_account, the accounts list, tiers and focus all read it with no change, and it is
// graded against won/lost like any score Nous makes.
//
// Single: { scorer: "acme-v3", identifier: "jane@acme.example", score: 82, tier?: "tier_2", reason?: "..." }
// Batch:  { scorer: "acme-v3", scores: [{ identifier, score, tier?, reason? }, ...] }   (up to 500)
//
// `scorer` names the model; it is stamped on the row as `ext:<scorer>`, so a later version of the
// same model shows up as a model change in the trail. `tier` is optional: left out, it is derived
// from the score with the workspace's bands (GET /v2/icp/tiers; 85 / 70 / 50 by default).
//
// The workspace must score for itself (GET /v2/icp/scorer; the API plan does by default), otherwise
// Nous's scorecard and this endpoint would both write the same record.
//
// identifier accepts an email, domain, LinkedIn URL, or entity UUID. An identifier Nous has never
// seen is reported back, not created: record the account first, then score it.
scoresV2Router.post('/', allowQueryParams([]), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const body = req.body || {};

    const scorer = normalizeScorerName(body.scorer);
    if (!scorer) {
      return res.status(400).json({
        error: 'scorer_required',
        hint: 'name your model, e.g. "acme-v3" (letters, digits, . _ - /, up to 64 chars)',
      });
    }

    const batch = Array.isArray(body.scores);
    const rows = batch ? body.scores : [body];
    if (rows.length === 0) return res.status(400).json({ error: 'scores_empty' });
    if (rows.length > MAX_BATCH) return res.status(400).json({ error: 'batch_too_large', max: MAX_BATCH });

    if (await getIcpScorer(supabase, workspaceId) !== 'external') {
      return res.status(409).json({
        error: 'scorer_not_external',
        hint: "this workspace is scored by Nous; PUT /v2/icp/scorer { scorer: 'external' } first",
      });
    }

    const thresholds = await getTierThresholds(supabase, workspaceId);
    const results = [];
    for (const row of rows) {
      results.push(await writeOne(supabase, workspaceId, scorer, thresholds, row || {}));
    }
    if (!batch) {
      const r = results[0];
      return res.status(r.error ? 400 : 200).json(r);
    }
    return res.json({ scorer, results });
  } catch (err) {
    console.error('[POST /v2/scores]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

async function writeOne(supabase, workspaceId, scorer, thresholds, row) {
  const identifier = String(row.identifier ?? '').trim();
  if (!identifier) return { identifier: null, error: 'identifier_required' };

  const score = Number(row.score);
  if (row.score === null || row.score === undefined || row.score === '' || !Number.isFinite(score) || score < 0 || score > 100) {
    return { identifier, error: 'invalid_score', hint: 'a number from 0 to 100' };
  }
  if (row.tier != null && !ICP_TIERS.includes(row.tier)) {
    return { identifier, error: 'invalid_tier', allowed: ICP_TIERS };
  }
  if (row.reason != null && typeof row.reason !== 'string') {
    return { identifier, error: 'invalid_reason' };
  }

  const resolution = await resolveFocus(supabase, workspaceId, identifier);
  if (resolution.status === 'not_found') return { identifier, resolved: false, reason: 'unknown_identifier' };
  if (resolution.status === 'ambiguous') {
    return { identifier, resolved: false, reason: 'ambiguous', candidates: resolution.candidates };
  }

  const out = await writeExternalScore(supabase, workspaceId, resolution.entity_id, {
    score, tier: row.tier ?? null, reason: row.reason?.slice(0, 500) ?? null, scorer, thresholds,
  });
  return { identifier, resolved: true, entity_id: resolution.entity_id, ...out };
}
