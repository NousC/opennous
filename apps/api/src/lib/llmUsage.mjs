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
};

/**
 * Cost of one model call, in dollars. An unknown model returns 0 rather than a
 * guess — a wrong number here would quietly corrupt the unit economics, and a
 * zero is at least visibly wrong.
 */
export function computeCost(model, usage) {
  const p = PRICING[model];
  if (!p) return 0;

  const input   = usage?.input_tokens ?? 0;
  const output  = usage?.output_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const read    = usage?.cache_read_input_tokens ?? 0;

  return (
    (input   / 1e6) * p.in +
    (output  / 1e6) * p.out +
    (written / 1e6) * p.cacheWrite +
    (read    / 1e6) * p.cacheRead
  );
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
