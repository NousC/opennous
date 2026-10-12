// /v2/icp — the ICP in one place: the written definition, the learned model's status, and the
// two ways to change them. Every handler here is one the API already had; this is the address.
//
//   GET  /v2/icp                → { icp, model }          (GET /v2/foundations?kind=icp + GET /v2/workspace/icp/model)
//   PUT  /v2/icp                { body_md, file_path? }   (POST /v2/foundations/icp)
//   POST /v2/icp/closed-deals   { won[], lost[] }         (POST /v2/workspace/closed-deals — same handler)
//   GET  /v2/icp/scorer         → { scorer, source }      who scores this workspace's accounts (GET-586)
//   PUT  /v2/icp/scorer         { scorer: 'nous' | 'external' | null }   null = follow the plan
//   GET  /v2/icp/tiers          → { tier_1, tier_2, tier_3, source }
//   PUT  /v2/icp/tiers          { tier_1, tier_2, tier_3 } | null        null = the default bands

import { Router } from 'express';
import {
  getSupabaseClient, getIcpScorerSetting, setIcpScorer, getTierThresholds, setTierThresholds, normalizeTierThresholds,
  hasLearnedIcpScorer,
} from '@nous/core';
import { readFoundations, writeFoundation } from './foundations.mjs';
import { readIcpModel, recordClosedDeals } from './workspaceStatus.mjs';
import { allowQueryParams } from '../../lib/v2Query.mjs';

export const icpV2Router = Router();

const modelStatus = (m) => ({
  has_model: m.has_model,
  has_outcomes: m.has_outcomes,
  model_version: m.model_version ?? null,
  target_path: m.target_path ?? null,
  signals: m.signals ?? [],
  calibration: m.calibration ?? null,
});

const icpOut = (f) => (f ? {
  body_md: f.body_md,
  title: f.title ?? null,
  source: f.source ?? null,
  file_path: f.file_path ?? null,
  version: f.version ?? null,
  synced_at: f.synced_at ?? null,
  updated_at: f.updated_at ?? null,
} : null);

// GET /v2/icp — { icp: {...} | null, model: { has_model, has_outcomes, model_version, target_path, signals, calibration } }
icpV2Router.get('/', allowQueryParams([]), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const [foundations, model, scorer] = await Promise.all([
      readFoundations(supabase, req.workspaceId, 'icp'),
      readIcpModel(supabase, req.workspaceId),
      getIcpScorerSetting(supabase, req.workspaceId),
    ]);
    return res.json({ icp: icpOut(foundations[0]), model: { ...modelStatus(model), scorer: scorer.scorer } });
  } catch (err) {
    console.error('[GET /v2/icp]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /v2/icp { body_md, file_path? } — { icp, model: { status, ... } }
icpV2Router.put('/', allowQueryParams([]), async (req, res) => {
  try {
    const out = await writeFoundation(getSupabaseClient(), req.workspaceId, 'icp', req.body || {});
    if (out.error) return res.status(400).json({ error: out.error });
    // A build failure is reported, never its internal message.
    const model = out.model?.status === 'build_failed' ? { status: 'build_failed' } : out.model;
    return res.json({ icp: icpOut(out.foundation), model });
  } catch (err) {
    console.error('[PUT /v2/icp]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/icp/closed-deals { won: [domain], lost: [domain] } — the record_closed_deals handler.
icpV2Router.post('/closed-deals', allowQueryParams([]), recordClosedDeals);

// Who scores this workspace's accounts (GET-586). 'nous' is the learned scorecard; 'external' means
// the workspace runs its own scorer and posts results to POST /v2/scores, and Nous stops staking,
// re-scoring and learning for it. Unset, the plan decides: Custom is scored by Nous, the self-serve
// API plan brings its own. Switching back to 'nous' leaves existing external scores in place until
// they resolve; new accounts are scored by the scorecard again.
//
// The learned scorecard is Nous Cloud's (GET-754 slice 8). On an open-source build every workspace
// scores for itself: GET reads 'external', and PUT { scorer: 'nous' } is refused with 403
// cloud_only_feature rather than switching on a scorer the build does not have.
icpV2Router.get('/scorer', allowQueryParams([]), async (req, res) => {
  try {
    return res.json(await getIcpScorerSetting(getSupabaseClient(), req.workspaceId));
  } catch (err) {
    console.error('[GET /v2/icp/scorer]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

icpV2Router.put('/scorer', allowQueryParams([]), async (req, res) => {
  try {
    const scorer = req.body?.scorer;
    if (scorer !== 'nous' && scorer !== 'external' && scorer !== null) {
      return res.status(400).json({ error: 'invalid_scorer', allowed: ['nous', 'external', null] });
    }
    if (scorer === 'nous' && !hasLearnedIcpScorer()) {
      return res.status(403).json({
        error: 'cloud_only_feature',
        feature: 'icpScoring',
        message: "Nous's learned ICP scorer is available on Nous Cloud only. This workspace scores its own accounts: post them to POST /v2/scores.",
        allowed: ['external', null],
      });
    }
    const supabase = getSupabaseClient();
    await setIcpScorer(supabase, req.workspaceId, scorer);
    return res.json(await getIcpScorerSetting(supabase, req.workspaceId));
  } catch (err) {
    console.error('[PUT /v2/icp/scorer]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Where this workspace's tiers cut. Applies to every tier Nous derives: its own scores, and an
// external score posted without a tier. Already-written tiers move on the account's next re-score.
icpV2Router.get('/tiers', allowQueryParams([]), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const t = await getTierThresholds(supabase, req.workspaceId);
    const { data } = await supabase.from('workspaces').select('icp_tier_thresholds').eq('id', req.workspaceId).maybeSingle();
    return res.json({ ...t, source: normalizeTierThresholds(data?.icp_tier_thresholds) ? 'workspace' : 'default' });
  } catch (err) {
    console.error('[GET /v2/icp/tiers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

icpV2Router.put('/tiers', allowQueryParams([]), async (req, res) => {
  try {
    const body = req.body;
    const reset = body === null || body?.reset === true;
    const t = reset ? null : normalizeTierThresholds(body);
    if (!reset && !t) {
      return res.status(400).json({
        error: 'invalid_tiers',
        hint: 'tier_1 > tier_2 > tier_3, whole numbers from 1 to 100; send { "reset": true } for the defaults',
      });
    }
    const supabase = getSupabaseClient();
    await setTierThresholds(supabase, req.workspaceId, t);
    return res.json({ ...(await getTierThresholds(supabase, req.workspaceId)), source: t ? 'workspace' : 'default' });
  } catch (err) {
    console.error('[PUT /v2/icp/tiers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
