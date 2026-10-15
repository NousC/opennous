// The one door for every single-turn model call, in the API and the worker (GET-242).
//
// On 2026-09-12 the Anthropic account ran out of credit. The extraction pipeline had just been
// moved behind a door (the worker's lib/llm.mjs) and switched to open models, so it kept
// working. About forty other calls did not: reply classification, the action-item judge,
// objections, coaching, headline parsing, thread titles, Studio drafts, the revenue report,
// memory extraction, insights. Each built its own `new Anthropic()` with a hardcoded Claude
// model, each caught its own error, and each returned nothing — silently, for days. The day a
// model changes, a door is one place; forty call sites are forty places and the ones you miss
// fail quietly.
//
// So there is one door, here in @nous/core where both apps can reach it:
//
//   createMessage({ feature, tier, model, max_tokens, system, messages, accept, fallback })
//
// Anthropic-shaped in and out — `content[0].text`, `usage.input_tokens` / `output_tokens`,
// `model` — so a call site changes one line. Routing is by model id: `claude-*` goes out in
// Anthropic's Messages format (to OpenRouter's Messages endpoint when OPENROUTER_API_KEY is set,
// else to Anthropic direct; GET-885); anything else is an OpenRouter id sent through its
// OpenAI-compatible API.
//
// Which model is config, per TIER, never a string at the call site:
//   tier 'extraction' (default)  EXTRACTION_MODEL        → EXTRACTION_FALLBACK_MODEL
//     classify, extract, judge, label — short structured answers, high volume.
//   tier 'writing'               WRITING_MODEL           → WRITING_FALLBACK_MODEL
//     prose a person reads: drafts, reports, coaching. Defaults to GLM 5.2 → EXTRACTION_MODEL.
// A call site may still pass `model` for a deliberate override (an eval, an env-configured
// feature); the tier's fallback still applies unless `fallback: false`.
//
// Serving hosts are pinned per model (EXTRACTION_PROVIDER, EXTRACTION_FALLBACK_PROVIDER,
// WRITING_PROVIDER): one open model is served by many hosts, some quantised, and an eval only
// holds on the host it ran on.

import AnthropicSDK from '@anthropic-ai/sdk';
import { claudeClientOptions, claudeProvider, routeClaudeClient } from './claudeRoute.mjs';
import { classifyProviderError } from './providerError.mjs';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_WRITING_MODEL = 'z-ai/glm-5.2';

// Reasoning models spend max_tokens on thinking BEFORE the answer. A budget sized for a
// 12-fact JSON array can be eaten entirely by reasoning and return an empty answer. Open
// models get this much on top of what the call site asked for (GET-185: 6,000 was too little).
const DEFAULT_REASONING_HEADROOM = 16_000;

// A hung connection must not hold a job forever. Past two minutes the fallback is the faster
// route to an answer.
const DEFAULT_TIMEOUT_MS = 120_000;

// ── Claude client ────────────────────────────────────────────────────────────────
// Each app registers its own instrumented client at boot (both use `useleak`, which tracks
// spend per `feature`). Without one the plain SDK is used and `feature` is stripped.
//
// `claude-*` ids speak Anthropic's Messages format, served by OpenRouter by default and by
// Anthropic direct only when OpenRouter is not configured (GET-885, claudeRoute.mjs). The app
// builds its client with claudeClientOptions() and says which `provider` it points at; the door
// then sends the provider's model id.
let anthropicClient = null;
let anthropicAcceptsFeature = false;

/** Register the Claude client the door uses for `claude-*` models. `provider`: 'openrouter' | 'anthropic'. */
export function registerAnthropicClient(client, { acceptsFeature = true, provider = null } = {}) {
  anthropicClient = client && provider ? routeClaudeClient(client, provider) : client;
  anthropicAcceptsFeature = acceptsFeature;
}

function anthropic() {
  if (!anthropicClient) {
    const route = claudeClientOptions();
    // No key at all: the plain SDK, whose first call fails as unavailable (as before).
    anthropicClient = route ? routeClaudeClient(new AnthropicSDK(route.options), route.provider) : new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY });
    anthropicAcceptsFeature = false;
  }
  return anthropicClient;
}

// ── Model config ─────────────────────────────────────────────────────────────────

const env = (k) => (process.env[k] || '').trim();

/** The extraction tier's model. Read per call so a config change needs no rebuild. */
export function pipelineModel() {
  return env('EXTRACTION_MODEL') || DEFAULT_MODEL;
}

/** The Insights board's model: sorting insights, naming topics, recommendations. Its own setting,
 *  Haiku unless INSIGHT_BOARD_MODEL says otherwise. The board's calls are short, structured JSON:
 *  a model that reasons first spent ~5,500 output tokens a call on them and sometimes ran out
 *  before answering, where Haiku answered in ~700 for the same price per call. Through OpenRouter
 *  (not a `claude-` id, which goes to the Anthropic key), so it bills where the pipeline bills. */
export const INSIGHT_BOARD_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
export function insightBoardModel() {
  if (env('INSIGHT_BOARD_MODEL')) return env('INSIGHT_BOARD_MODEL');
  // The default is an OpenRouter id. An install with no OpenRouter key (a self-hosted one on its
  // Anthropic key alone) would have a board that never answers: it runs on the reading model.
  return env('OPENROUTER_API_KEY') || env('LLM_API_KEY') || env('LLM_BASE_URL') ? INSIGHT_BOARD_DEFAULT_MODEL : pipelineModel();
}

/** The extraction tier's fallback, or null when none is set. */
export function pipelineFallbackModel() {
  const m = env('EXTRACTION_FALLBACK_MODEL');
  return m && m !== pipelineModel() ? m : null;
}

/** The writing tier's model. */
export function writingModel() {
  return env('WRITING_MODEL') || DEFAULT_WRITING_MODEL;
}

/** The writing tier's fallback: WRITING_FALLBACK_MODEL, else the extraction model. */
export function writingFallbackModel() {
  const m = env('WRITING_FALLBACK_MODEL') || pipelineModel();
  return m && m !== writingModel() ? m : null;
}

/**
 * Where every non-`claude-` model goes: an OpenAI-compatible chat-completions server (GET-837).
 * OpenRouter unless LLM_BASE_URL names another (OpenAI, Groq, Together, a local Ollama), keyed by
 * LLM_API_KEY, else OPENROUTER_API_KEY. A local server may need no key at all.
 */
export function modelEndpoint() {
  const base = (env('LLM_BASE_URL') || OPENROUTER_BASE).replace(/\/+$/, '');
  const openRouter = /(^|\/\/)([^/]*\.)?openrouter\.ai(\/|$)/i.test(base);
  return {
    url: `${base}/chat/completions`,
    host: base.replace(/^https?:\/\//, '').split('/')[0],
    key: env('LLM_API_KEY') || env('OPENROUTER_API_KEY') || null,
    openRouter,
    local: /^https?:\/\/(localhost|127\.|\[::1\]|host\.docker\.internal|ollama)([:/]|$)/i.test(base),
  };
}

/** A key that could be real: not an example value ("sk-ant-...", "placeholder", "your-key"),
 *  and long enough (provider keys are dozens of characters). For Instance setup, never auth. */
export function looksLikeKey(v) {
  const s = String(v ?? '').trim();
  return s.length >= 20 && !/placeholder|\.\.\.|…|^your[-_ ]|changeme|[<>]/i.test(s);
}

/** How a model id is served: `claude-*` on the Anthropic key, everything else on the endpoint. */
export function modelRoute(model) {
  return String(model || '').startsWith('claude-') ? 'anthropic' : 'openai_compatible';
}

/**
 * What runs each job and whether it can (Settings → Instance setup). Only whether keys are set,
 * never their values.
 */
export function modelSetupStatus() {
  const ep = modelEndpoint();
  // Claude runs on OpenRouter's key when it is set, else on the Anthropic key (GET-885).
  const claudeVia = claudeProvider();
  const anthropicKey = looksLikeKey(env('ANTHROPIC_API_KEY'));
  const claudeReady = claudeVia === 'openrouter' ? looksLikeKey(env('OPENROUTER_API_KEY') || env('LLM_API_KEY')) : anthropicKey;
  const compatible = looksLikeKey(ep.key) || (!!env('LLM_BASE_URL') && !ep.openRouter);
  const ready = (m) => (modelRoute(m) === 'anthropic' ? claudeReady : compatible);
  const job = (tier, label, model, fallback) => ({
    tier, label, model, route: modelRoute(model), ready: ready(model),
    fallback: fallback || null, fallbackReady: fallback ? ready(fallback) : null,
  });
  return {
    providers: { anthropic: anthropicKey, claudeVia, openaiCompatible: compatible, endpoint: ep.host, openRouter: ep.openRouter, local: ep.local },
    jobs: [
      job('extraction', 'Reading calls and email', pipelineModel(), pipelineFallbackModel()),
      job('writing', 'Writing summaries and reports', writingModel(), writingFallbackModel()),
      job('insights', 'Insights board', insightBoardModel(), null),
    ],
  };
}

/** [primary, fallback] for a tier. */
export function tierModels(tier = 'extraction') {
  return tier === 'writing'
    ? [writingModel(), writingFallbackModel()]
    : [pipelineModel(), pipelineFallbackModel()];
}

// The host pin for a model id. The extraction fallback model uses EXTRACTION_FALLBACK_PROVIDER;
// a writing model with its own WRITING_PROVIDER uses that; everything else uses
// EXTRACTION_PROVIDER — the rule the worker's door had, kept exactly.
function providerPinFor(model) {
  const list = (varName) => env(varName).split(',').map(s => s.trim()).filter(Boolean);
  // The board's own model is pinned only by its own setting. Inheriting EXTRACTION_PROVIDER pinned
  // Haiku to the pipeline's host, which does not serve it: OpenRouter answered "no endpoints".
  if (model === insightBoardModel() && model !== pipelineModel()) return list('INSIGHT_BOARD_PROVIDER');
  if (model === pipelineFallbackModel()) return list('EXTRACTION_FALLBACK_PROVIDER');
  if (model === writingModel() && list('WRITING_PROVIDER').length) return list('WRITING_PROVIDER');
  return list('EXTRACTION_PROVIDER');
}

/**
 * The model could not be reached — auth, credit, rate limit, provider outage, network.
 * Distinct from "the model answered and found nothing": callers that must not confuse the two
 * (repair sweeps, evals, pre-flights) check for this type.
 */
export class ModelUnavailableError extends Error {
  constructor(message, { status = null, model = null } = {}) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.status = status;
    this.model = model;
  }
}

// ── The door ─────────────────────────────────────────────────────────────────────

/**
 * Anthropic-shaped message create, routed by model id, with one fallback.
 *
 *   feature    usage label (metering, OpenRouter X-Title)
 *   tier       'extraction' (default) | 'writing' — picks the model pair from config
 *   model      explicit primary model; overrides the tier's primary
 *   system     string, or Anthropic text blocks
 *   accept     (text) => false when the answer is unusable to this caller. Without it an empty
 *              answer, or one cut off at the token limit, counts as unusable.
 *   fallback   false → exactly one model; a model id → that fallback; default → the tier's.
 *   temperature optional; open models default to 0
 *
 * When the fallback answers, the response carries `failed_attempts` (model, host, reason, cost)
 * so metering can charge the replaced call. When every model fails with an outage it throws
 * ModelUnavailableError; an unusable answer is returned as-is so the caller's own parse
 * handling runs.
 */
export async function createMessage({
  feature, tier = 'extraction', model, max_tokens, system, messages,
  accept = null, fallback = undefined, temperature,
}) {
  const [tierPrimary, tierFallback] = tierModels(tier);
  const primary = model || tierPrimary;
  const second = fallback === false ? null
    : (typeof fallback === 'string' ? fallback : tierFallback);
  const chain = second && second !== primary ? [primary, second] : [primary];

  const failed = [];
  let lastMsg = null, lastErr = null;
  for (const m of chain) {
    try {
      const msg = await callModel({ feature, model: m, max_tokens, system, messages, temperature });
      const text = msg.content?.find?.(b => b.type === 'text')?.text ?? '';
      const usable = text.trim() !== ''
        && (accept ? accept(text) !== false : msg.finish_reason !== 'length' && msg.stop_reason !== 'max_tokens');
      if (usable) {
        if (failed.length) {
          msg.failed_attempts = failed;
          console.warn(`[LLM_FALLBACK] ${feature || 'pipeline'}: ${failed.map(f => `${f.model} ${f.reason}`).join('; ')} → answered by ${m}`);
        }
        return msg;
      }
      failed.push({
        model: m, provider: msg.provider ?? null, cost_usd: msg.cost_usd ?? null, usage: msg.usage ?? null,
        reason: text.trim() === '' ? `empty answer (finish: ${msg.finish_reason ?? msg.stop_reason ?? 'unknown'})` : 'unusable answer',
      });
      lastMsg = msg; lastErr = null;
    } catch (err) {
      if (!(err instanceof ModelUnavailableError)) throw err;
      failed.push({ model: m, provider: null, cost_usd: null, usage: null, reason: `unavailable: ${err.message}` });
      lastErr = err;
    }
  }
  if (chain.length > 1) {
    console.error(`[LLM_FALLBACK_EXHAUSTED] ${feature || 'pipeline'}: ${failed.map(f => `${f.model} ${f.reason}`).join('; ')}`);
  }
  if (lastMsg) {
    lastMsg.failed_attempts = failed.filter(f => f.model !== lastMsg.model);
    return lastMsg;
  }
  throw lastErr;
}

/** The text of a door response (the first text block), or ''. */
export function messageText(msg) {
  return msg?.content?.find?.(b => b.type === 'text')?.text ?? msg?.content?.[0]?.text ?? '';
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(b => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n');
  return String(system);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  return String(content ?? '');
}

async function callModel({ feature, model: m, max_tokens, system, messages, temperature }) {
  if (m.startsWith('claude-')) {
    try {
      const params = { model: m, max_tokens, messages, ...(system ? { system } : {}), ...(temperature != null ? { temperature } : {}) };
      if (anthropicAcceptsFeature && feature) params.feature = feature;
      const msg = await anthropic().messages.create(params);
      // The id we asked for, not the provider's spelling (OpenRouter answers anthropic/...): the
      // price table, metering and fallback logs are keyed by it.
      msg.model = m;
      // OpenRouter returns what the call cost; meterLLM prefers it to the price table.
      if (typeof msg.usage?.cost === 'number' && msg.cost_usd == null) msg.cost_usd = msg.usage.cost;
      return msg;
    } catch (err) {
      const status = err?.status ?? null;
      // 400 is usually a bad request, but "credit balance is too low" is also a 400 — and it is
      // the outage this door exists for (classifyProviderError, GET-885).
      const unavailable = status == null || status >= 500 || classifyProviderError(err).kind !== 'other'
        || /credit balance|api key|authentication/i.test(err?.message || '');
      if (unavailable) throw new ModelUnavailableError(err?.message || 'anthropic call failed', { status, model: m });
      throw err;
    }
  }
  return openRouterMessage({ feature, model: m, max_tokens, system, messages, temperature });
}

async function openRouterMessage({ feature, model, max_tokens, system, messages, temperature }) {
  // OpenRouter by default; any OpenAI-compatible server when LLM_BASE_URL says so (GET-837).
  const ep = modelEndpoint();
  if (!ep.key && ep.openRouter) throw new ModelUnavailableError('OPENROUTER_API_KEY (or LLM_API_KEY) is not set', { model });
  const label = ep.openRouter ? 'openrouter' : ep.host;

  const sys = systemText(system);
  // Reasoning headroom is OpenRouter's default (its open models think before answering); on another
  // server only an explicit EXTRACTION_REASONING_HEADROOM adds it, since e.g. OpenAI caps output.
  const headroom = Number(process.env.EXTRACTION_REASONING_HEADROOM) || (ep.openRouter ? DEFAULT_REASONING_HEADROOM : 0);
  const body = {
    model,
    messages: [
      ...(sys ? [{ role: 'system', content: sys }] : []),
      ...messages.map(msg => ({ role: msg.role, content: contentText(msg.content) })),
    ],
    max_tokens: (max_tokens || 1024) + headroom,
    temperature: temperature ?? 0,
  };
  // OpenRouter-only fields: other servers reject parameters they do not know.
  if (ep.openRouter) {
    body.usage = { include: true };   // OpenRouter returns the real billed cost per call
    const pin = providerPinFor(model);
    if (pin.length) body.provider = { order: pin, allow_fallbacks: false };
  }

  const started = Date.now();
  const timeoutMs = Number(process.env.EXTRACTION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ep.url, {
      signal: abort.signal,
      method: 'POST',
      headers: {
        ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
        'Content-Type': 'application/json',
        ...(ep.openRouter ? { 'X-Title': `opennous:${feature || 'pipeline'}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new ModelUnavailableError(`${label} timed out after ${timeoutMs}ms`, { status: 'timeout', model });
    }
    throw new ModelUnavailableError(`${label} network error: ${err.message}`, { model });
  }
  const data = await res.json().catch(() => ({}));
  clearTimeout(timer);
  if (!res.ok || data?.error) {
    const status = data?.error?.code ?? res.status;
    throw new ModelUnavailableError(`${label} ${status}: ${data?.error?.message || res.statusText}`, { status, model });
  }

  const choice = data.choices?.[0];
  const u = data.usage || {};
  const cost = typeof u.cost === 'number' ? u.cost : null;
  return {
    id: data.id ?? null,
    model,
    provider: data.provider ?? null,
    latency_ms: Date.now() - started,
    finish_reason: choice?.finish_reason ?? null,
    content: [{ type: 'text', text: choice?.message?.content ?? '' }],
    usage: {
      input_tokens:  u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,            // includes reasoning tokens
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
      // The API's computeCost reads usage.cost; the worker's meterLLM reads msg.cost_usd.
      ...(cost != null ? { cost } : {}),
    },
    cost_usd: cost,
  };
}

/**
 * Parse the JSON array an extraction prompt asks for. Returns the array, or null when the
 * output holds no parseable array — a failure, not an empty answer. A bare `[]` returns [].
 */
export function parseJsonArray(text) {
  const t = String(text ?? '').trim();
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s === -1 || e === -1 || e < s) return null;
  try {
    const parsed = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
