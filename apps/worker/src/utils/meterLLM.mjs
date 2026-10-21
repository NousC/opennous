// Worker-side LLM metering. The heavy AI work (backfill fact-extraction, concept/pattern
// building, transcript intel, enrichment, sentiment, insights) runs here, and until now it
// recorded NO usage — so the credit wallet stayed at zero while we ate the model cost. This
// records each worker model call into llm_usage, exactly like the API's trackLlmUsage, so
// the wallet (getTeamAiCredits) reflects real Nous-side spend.
//
// Prices come from @nous/core (llm/usageCost.mjs, GET-957), one table for both apps and the model
// door, which meters most calls itself now; this is for the call sites that record their own usage
// (a different label, a write-only path). Fail-safe: metering must never break a job.

import { recordPipelineEvent } from '../lib/pipelineEvents.mjs';
import { computeCost } from '@nous/core';

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
