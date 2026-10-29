// The learned ICP scorer's door in the API — GET-754 slice 8.
//
// A workspace's accounts are scored by Nous's learned scorecard or by the workspace's own model,
// posted to POST /v2/scores (GET-586). The learned half is Nous Cloud's: building the scorecard
// from the ICP (cloud/lib/scorecardSeed.mjs), learning from closed deals, the learned-model export
// (lib/icpModel.mjs, whose code is open source since 2026-10-29), and the POST /v2/score verb
// (cloud/lib/scoreIdentifier.mjs). Public
// routes that offer those reach them through learnedIcpModel(), which is null on an open-source
// build; there they answer cloudOnlyIcp() or skip the step, and the workspace scores for itself.
// Core's half (staking, re-scoring) has its own door: packages/core/src/services/icpScorer.ts.
import { loadCloud } from './cloud.mjs';

/** The learned ICP model's API half (cloud/index.mjs `icpModel`), or null without src/cloud/. */
export async function learnedIcpModel() {
  return (await loadCloud())?.icpModel ?? null;
}

/** 403 for a route that needs the learned scorer, on a build without it. */
export function cloudOnlyIcp(res) {
  return res.status(403).json({
    error: 'cloud_only_feature',
    feature: 'icpScoring',
    message: "Nous's learned ICP scorer is available on Nous Cloud only. Score accounts with your own model and post the results to POST /v2/scores.",
  });
}
