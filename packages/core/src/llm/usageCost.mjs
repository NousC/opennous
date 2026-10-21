// What a model call cost, and the llm_usage rows that record it (GET-957).
//
// The price table used to live twice: apps/api/src/lib/llmUsage.mjs and a "keep in sync" mirror
// in the worker's utils/meterLLM.mjs that held only the Claude models. Neither had the model that
// does most of our reading (deepseek-v4.1-flash), so any call whose router cost was missing
// recorded $0. One table here, read by both apps and by the door.

import { claudeIdFromOpenRouter } from './claudeRoute.mjs';

// $ per 1M tokens. Claude per Anthropic's published pricing. Cached input is a tenth of the
// uncached rate, and writing to the cache is 1.25x.
//
// Open models are read off the LIVE OpenRouter catalogue (openrouter.ai/api/v1/models), not
// written from memory: the first pass had glm-5.2 about 25% under and kimi-k2.6 under by a third.
// cacheWrite equals input: the automatic-caching providers charge nothing extra to populate a
// cache. `computeCost` prefers the router's own reported cost anyway; this is the fallback.
//
// An unknown model costs 0, which silently under-reports rather than guessing — so a model added
// to config MUST be added here in the same change, or its spend disappears.
export const PRICING = {
  'claude-opus-4-8':           { in: 5, out: 25, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-5':           { in: 3, out: 15, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5':          { in: 1, out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5,  cacheWrite: 1.25,  cacheRead: 0.10 },
  // Read 2026-10-18 (GET-957): the extraction model, and glm-5.2 moved from 0.60/2.00.
  'deepseek/deepseek-v4.1-flash':      { in: 0.04, out: 0.144, cacheWrite: 0.04, cacheRead: 0.0016 },
  'z-ai/glm-5.2':                      { in: 0.62, out: 2.42, cacheWrite: 0.62, cacheRead: 0.14 },
  'z-ai/glm-4.7':                      { in: 0.40, out: 1.75, cacheWrite: 0.40, cacheRead: 0.08 },
  'minimax/minimax-m2.5':              { in: 0.30, out: 1.20, cacheWrite: 0.30, cacheRead: 0.03 },
  'moonshotai/kimi-k2.6':              { in: 0.95, out: 4.00, cacheWrite: 0.95, cacheRead: 0.16 },
  'deepseek/deepseek-v4-pro':          { in: 0.84, out: 1.68, cacheWrite: 0.84, cacheRead: 0.08 },
  'qwen/qwen3-coder':                  { in: 0.30, out: 1.00, cacheWrite: 0.30, cacheRead: 0.10 },
  // A local model is absent on purpose: it runs on the operator's infra and costs us $0.
};

/** The price row for a model id, Claude through OpenRouter (anthropic/claude-haiku-4.5) included. */
export function priceFor(model) {
  return PRICING[model] ?? PRICING[claudeIdFromOpenRouter(model)] ?? null;
}

/**
 * Cost of one model call, in dollars. The router's reported cost wins (`usage.cost`, or
 * `cost_usd` on a door response); else the table. An unknown model returns 0 rather than a guess.
 */
export function computeCost(model, usage, reportedUsd = null) {
  for (const r of [reportedUsd, usage?.cost]) {
    const n = Number(r);
    if (r != null && Number.isFinite(n) && n > 0) return n;
  }
  const p = priceFor(model);
  if (!p) return 0;

  const input   = usage?.input_tokens ?? 0;
  const output  = usage?.output_tokens ?? 0;
  const read    = usage?.cache_read_input_tokens ?? 0;

  // Cache writes are priced by TTL: 1.25x base for the default 5 minutes, 2x for the 1-hour one
  // the agent uses on its stable system prefix. Without the breakdown, the 5-minute rate (the
  // meter under-reports rather than over-charging).
  const breakdown = usage?.cache_creation ?? null;
  const write5m = breakdown?.ephemeral_5m_input_tokens ?? null;
  const write1h = breakdown?.ephemeral_1h_input_tokens ?? null;
  const written = usage?.cache_creation_input_tokens ?? 0;
  const writeCost = (write5m !== null || write1h !== null)
    ? ((write5m ?? 0) / 1e6) * p.cacheWrite + ((write1h ?? 0) / 1e6) * (p.in * 2)
    : (written / 1e6) * p.cacheWrite;

  return (input / 1e6) * p.in + (output / 1e6) * p.out + writeCost + (read / 1e6) * p.cacheRead;
}

/** One llm_usage row. Pure. */
export function usageRow({ workspaceId = null, userId = null, feature, model, usage, costUsd = null, requestId = null }) {
  return {
    workspace_id:          workspaceId,
    user_id:               userId,
    feature,
    model:                 model || 'unknown',
    input_tokens:          usage?.input_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_tokens:     usage?.cache_read_input_tokens ?? 0,
    output_tokens:         usage?.output_tokens ?? 0,
    cost_usd:              computeCost(model, usage, costUsd),
    request_id:            requestId,
  };
}

/**
 * The rows one door response stands for: the answer, plus each attempt the fallback replaced that
 * was billed (an outage bills nothing). Pure.
 */
export function usageRowsFor(msg, { workspaceId = null, userId = null, feature, requestId = null }) {
  if (!msg) return [];
  const rows = [usageRow({ workspaceId, userId, feature, model: msg.model, usage: msg.usage, costUsd: msg.cost_usd ?? null, requestId })];
  for (const f of msg.failed_attempts ?? []) {
    if (!f?.usage && !(Number(f?.cost_usd) > 0)) continue;
    rows.push(usageRow({ workspaceId, userId, feature, model: f.model, usage: f.usage, costUsd: f.cost_usd ?? null, requestId }));
  }
  return rows;
}
