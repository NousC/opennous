// Worker-side LLM metering. The heavy AI work (backfill fact-extraction, concept/pattern
// building, transcript intel, enrichment, sentiment, insights) runs here, and until now it
// recorded NO usage — so the credit wallet stayed at zero while we ate the model cost. This
// records each worker model call into llm_usage, exactly like the API's trackLlmUsage, so
// the wallet (getTeamAiCredits) reflects real Nous-side spend.
//
// The worker can't import apps/api/src/lib/llmUsage.mjs, so the PRICING table is mirrored
// here — KEEP IT IN SYNC with that file. Fail-safe: metering must never break a job.

import { recordPipelineEvent } from '../lib/pipelineEvents.mjs';

const PRICING = {
  'claude-opus-4-8':           { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-sonnet-5':           { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5':          { in: 1, out: 5,  cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5,  cacheWrite: 1.25, cacheRead: 0.10 },
};

function computeCost(model, usage) {
  const p = PRICING[model];
  if (!p) return 0; // unknown model → 0, matching the API (a wrong number corrupts unit economics)
  const input   = usage?.input_tokens ?? 0;
  const output  = usage?.output_tokens ?? 0;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const read    = usage?.cache_read_input_tokens ?? 0;
  return (input / 1e6) * p.in + (output / 1e6) * p.out
       + (written / 1e6) * p.cacheWrite + (read / 1e6) * p.cacheRead;
}

// Record one worker model call. `msg` is the Anthropic response (has .usage + .model).
// Pass `model` explicitly when the response doesn't echo it. No-op without a workspaceId.
export async function meterLLM(supabase, workspaceId, feature, msg, model = null) {
  if (!supabase || !workspaceId || !msg) return;
  try {
    const m = model || msg.model || 'unknown';
    const usage = msg.usage || {};
    await supabase.from('llm_usage').insert({
      workspace_id: workspaceId,
      feature,
      model: m,
      input_tokens:          usage.input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens:     usage.cache_read_input_tokens ?? 0,
      output_tokens:         usage.output_tokens ?? 0,
      // OpenRouter returns the real billed cost of each call (lib/llm.mjs surfaces it as
      // msg.cost_usd), which beats any mirrored price table and covers every open model —
      // none of which are in PRICING, so they would otherwise all record $0.
      cost_usd:              typeof msg.cost_usd === 'number' ? msg.cost_usd : computeCost(m, usage),
    });
    // A call the fallback model replaced (lib/llm.mjs) was still billed. Record it under
    // its own model so the spend per model stays true.
    for (const f of msg.failed_attempts ?? []) {
      // Every replaced call is a fallback event, billed or not (an outage bills nothing).
      await recordPipelineEvent(supabase, {
        workspaceId, kind: 'fallback', feature, model: f.model,
        detail: { reason: f.reason, provider: f.provider ?? null, answered_by: m },
      });
      if (typeof f.cost_usd !== 'number' || f.cost_usd <= 0) continue;
      await supabase.from('llm_usage').insert({
        workspace_id: workspaceId, feature, model: f.model,
        input_tokens: f.usage?.input_tokens ?? 0, cache_creation_tokens: 0,
        cache_read_tokens: f.usage?.cache_read_input_tokens ?? 0, output_tokens: f.usage?.output_tokens ?? 0,
        cost_usd: f.cost_usd,
      });
    }
  } catch (e) {
    console.warn(`[meterLLM] ${feature} record failed:`, e?.message || e);
  }
}
