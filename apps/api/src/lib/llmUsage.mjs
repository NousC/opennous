// What a workspace costs us to serve.
//
// leakTrack ships spend to an external dashboard with no workspace_id, so it can
// answer "what did Nous spend this month" and nothing narrower. This writes the
// same call to our own table WITH the workspace on it, which is the difference
// between a company total and a unit cost.
//
// Both run. leakTrack stays for the ops view; this is the billing view.

// $ per 1M tokens, per Anthropic's published pricing.
//
// Cached input is a tenth of the uncached rate, and writing to the cache is 1.25x.
// That spread is the whole reason prompt caching is worth doing: the agent re-sends
// a ~4,300-token static prefix plus every prior tool_result on each loop, and
// before caching it paid full price for all of it, every time.
const PRICING = {
  'claude-opus-4-8':           { in: 5, out: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-5':           { in: 3, out: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':          { in: 1, out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  // Open models — read off the LIVE OpenRouter catalogue, not written from memory. The first
  // pass had glm-5.2 about 25% under and kimi-k2.6 under by a third, which would have made
  // every open model look cheaper than it is in exactly the comparison we were using them for.
  // (`computeCost` prefers the router's own reported cost anyway; this is the fallback.)
  // Keyed by
  // modelId like the rest. The harness DOES cache now, so cacheRead is real on the providers
  // that honour it — priced at 0.1x input, the rate the ones that publish a cached rate use.
  // cacheWrite is set equal to input: the automatic-caching providers charge nothing extra to
  // populate a cache, and pretending otherwise would overstate their cost.
  //
  // An unknown model costs 0, which silently under-reports rather than guessing — so a model
  // added to lib/model.mjs MUST be added here in the same change, or its spend disappears.
  'z-ai/glm-5.2':                      { in: 0.60, out: 2.00, cacheWrite: 0.60, cacheRead: 0.15 },
  'z-ai/glm-4.7':                      { in: 0.40, out: 1.75, cacheWrite: 0.40, cacheRead: 0.08 },
  'minimax/minimax-m2.5':              { in: 0.30, out: 1.20, cacheWrite: 0.30, cacheRead: 0.03 },
  'moonshotai/kimi-k2.6':              { in: 0.95, out: 4.00, cacheWrite: 0.95, cacheRead: 0.16 },
  'deepseek/deepseek-v4-pro':          { in: 0.84, out: 1.68, cacheWrite: 0.84, cacheRead: 0.08 },
  'qwen/qwen3-coder':                  { in: 0.30, out: 1.00, cacheWrite: 0.30, cacheRead: 0.10 },
  // A local model is absent on purpose: it runs on the operator's infra and costs us $0.
};

/**
 * Cost of one model call, in dollars. An unknown model returns 0 rather than a
 * guess — a wrong number here would quietly corrupt the unit economics, and a
 * zero is at least visibly wrong.
 */
/** The output $/1M rate for a model — a simple relative-cost signal for the picker so the
 *  user can see a frontier model costs more credits than a cheap one. 0 = free (e.g. local). */
export function modelOutputRate(modelId) {
  return PRICING[modelId]?.out ?? 0;
}

export function computeCost(model, usage) {
  // OpenRouter returns what the call ACTUALLY cost, in dollars, on every response. When it
  // does, use it: a router that prices the call is a better source than a table we maintain
  // by hand, it stays right when a provider changes its rates, and it removes the footgun
  // where adding a model to lib/model.mjs but not to PRICING makes its spend vanish silently.
  // Guarded on a finite positive number so a zero or a missing field falls through to the
  // table rather than recording a free call.
  const reported = Number(usage?.cost);
  if (Number.isFinite(reported) && reported > 0) return reported;

  const p = PRICING[model];
  if (!p) return 0;

  const input   = usage?.input_tokens ?? 0;
  const output  = usage?.output_tokens ?? 0;
  const read    = usage?.cache_read_input_tokens ?? 0;

  // Cache writes are priced by TTL: 1.25x base for the default 5 minutes, 2x for the 1-hour
  // one the agent uses on its stable system prefix. When the API breaks the write down by
  // TTL, price each bucket properly; otherwise fall back to the 5-minute rate, which is the
  // conservative direction for a meter (it under-reports rather than over-charging).
  const breakdown = usage?.cache_creation ?? null;
  const write5m = breakdown?.ephemeral_5m_input_tokens ?? null;
  const write1h = breakdown?.ephemeral_1h_input_tokens ?? null;
  const written = usage?.cache_creation_input_tokens ?? 0;

  const writeCost = (write5m !== null || write1h !== null)
    ? ((write5m ?? 0) / 1e6) * p.cacheWrite + ((write1h ?? 0) / 1e6) * (p.in * 2)
    : (written / 1e6) * p.cacheWrite;

  return (
    (input   / 1e6) * p.in +
    (output  / 1e6) * p.out +
    writeCost +
    (read    / 1e6) * p.cacheRead
  );
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
