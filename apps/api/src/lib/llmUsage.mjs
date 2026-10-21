// What a workspace costs us to serve.
//
// leakTrack ships spend to an external dashboard with no workspace_id, so it can
// answer "what did Nous spend this month" and nothing narrower. This writes the
// same call to our own table WITH the workspace on it, which is the difference
// between a company total and a unit cost.
//
// Both run. leakTrack stays for the ops view; this is the billing view.

import { MODEL_PRICING, computeCost } from '@nous/core';

// The price table and computeCost live in @nous/core (llm/usageCost.mjs, GET-957), shared with the
// worker and the model door, which meters most calls itself now. Re-exported for the callers here.
export { computeCost };

/** The output $/1M rate for a model — a simple relative-cost signal for the picker so the
 *  user can see a frontier model costs more credits than a cheap one. 0 = free (e.g. local). */
export function modelOutputRate(modelId) {
  return MODEL_PRICING[modelId]?.out ?? 0;
}

// ── Credits ─────────────────────────────────────────────────────────────────
//
// The revenue agent is the first thing in Nous that burns model tokens per use,
// so it's the first thing with a variable per-answer cost. Credits are how a
// team's spend on it is capped. A credit is denominated in raw model cost — one
// credit is AI_CREDIT_USD of what the answer cost us — so a heavier brief spends
// more credits than a one-line lookup. That makes the meter usage-proportional
// without inventing a second pricing table: llm_usage already has the cost.
//
// The plan price is where the margin lives, not this number. $199 buys 2,000
// credits ≈ $40 of raw AI at this rate; the spread is the product.
export const AI_CREDIT_USD = 0.02;

// NOT THE BILLED LIST ANY MORE. Credits are counted by conversationCredits in
// packages/core/src/db/conversationCredits.ts, and the work a person asks for is billed
// from REQUESTED_FEATURES there (GET-516). Nothing reads this array to bill; it stays as
// a record of what was once metered. To bill a new AI surface, add its feature name to
// REQUESTED_FEATURES — not here.
//
// ── To make a new AI surface cost credits (e.g. Studio drafts, a Sequence step) ──
//   1. Call requireAiCredits(supabase, workspaceId) BEFORE the model runs, and bail
//      with its 402 body when it says stop — that's the hard block.
//   2. Record the call with trackLlmUsage(supabase, { workspaceId, userId, feature,
//      model, usage }) using your feature name.
//   3. Add that feature name to REQUESTED_FEATURES in packages/core/src/db/conversationCredits.ts.
// Nothing else — the credit count picks it up from there.
//
// ── What is deliberately NOT here ──
//   • Graph-building — extraction, enrichment, insights synthesis, ICP scoring. That
//     is the product filling its own graph, and the ACTIVE-ACCOUNTS meter already
//     prices it. Billing it here too would charge the customer twice for one unit of
//     work. Leave every '…-extract', '…-signals', 'icp-…', 'insight-…', 'scorecard-…',
//     enrichment and 'signal.…' feature off this list.
//   • Our telemetry — the Haiku turn-classifier (home-agent-classify). Not the
//     customer's answer, so not their cost. Tracked for visibility, never billed.
export const AI_CREDIT_FEATURES = [
  // The revenue agent — answers, and the email/LinkedIn drafts it composes inline.
  'home-agent-turn',       // each tool-loop turn of a streamed answer
  'home-agent-close',      // the closing-turn fallback
  'playground-agent-turn', // the non-streaming path

  // Studio — on-demand drafting the operator triggers on a person or account.
  // Pre-registered: these bill the moment the Studio call sites record them, so
  // wiring Studio is steps 1–2 above with no further billing change.
  'studio-email-draft',
  'studio-linkedin-draft',   // on-demand LinkedIn message draft
  'studio-email-brief',
  'studio-campaign-brief',   // on-demand campaign optimization brief

  // Sequences / Workflows — an AI step inside an automated sequence.
  'sequence-ai-step',

  // The built-in detector automations (Stale deal, Deal risk, Expansion signals) drafting the
  // follow-up they promise (GET-685, lib/detectorDrafts.mjs). Capped per workspace per day.
  'automation-email-draft',
  // Who a stakeholder signal named, looked up on the web for the Deal signals play (GET-944).
  'signal-research',

  // A canvas automation's run (GET-710): the write-up its OpenNous or AI step makes. About a credit.
  'automation-handoff',

];

// Our own telemetry — never a customer's billable work (the Haiku turn-classifier).
// The API plan meters ALL other model work (backfill, extraction, enrichment, ICP
// scoring, stage derivation) as credits, since it has no active-accounts meter to
// price graph-building — so it bills everything EXCEPT this list. (2026-08-16.)
export const AI_TELEMETRY_FEATURES = ['home-agent-classify'];

/**
 * Dollars of model cost → credits, always rounded up so a fractional-cent answer
 * still costs at least one credit (you never get compute for free, and the round
 * keeps the number a clean integer the UI can show).
 */
export function costToCredits(costUsd) {
  const c = Number(costUsd) || 0;
  if (c <= 0) return 0;
  return Math.ceil(c / AI_CREDIT_USD);
}

/**
 * Record one model call against a workspace. Fire-and-forget: a metering failure
 * must never surface to the user mid-chat, and must never take down the thing it
 * is measuring.
 */
export function trackLlmUsage(supabase, { workspaceId, userId = null, feature, model, usage, requestId = null }) {
  if (!supabase || !workspaceId) return;

  const row = {
    workspace_id:          workspaceId,
    user_id:               userId,
    feature,
    model,
    input_tokens:          usage?.input_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_tokens:     usage?.cache_read_input_tokens ?? 0,
    output_tokens:         usage?.output_tokens ?? 0,
    cost_usd:              computeCost(model, usage),
    request_id:            requestId,
  };

  supabase
    .from('llm_usage')
    .insert(row)
    .then(({ error }) => {
      if (error) console.warn('[llm_usage] insert failed:', error.message);
    }, () => { /* never block on metering */ });
}
