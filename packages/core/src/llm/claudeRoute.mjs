// Where Claude calls go (GET-885): OpenRouter by default, Anthropic direct only when OpenRouter
// is not configured.
//
// The Anthropic console account is not topped up any more; OpenRouter is the one bill. Every
// Claude call in the codebase speaks Anthropic's Messages format (tool_use / tool_result blocks,
// cache_control, thinking, output_config.effort), and OpenRouter serves that format natively at
// https://openrouter.ai/api/v1/messages. So nothing is translated: the same @anthropic-ai/sdk
// client is pointed at OpenRouter (baseURL https://openrouter.ai/api, the SDK appends
// /v1/messages), authenticated with the OpenRouter key as a bearer token, and asked for the
// OpenRouter id of the same model (claude-sonnet-5 -> anthropic/claude-sonnet-5).
//
// Env (names only; values are never logged): OPENROUTER_API_KEY, else LLM_API_KEY when the
// OpenAI-compatible endpoint is OpenRouter (modelDoor's rule); ANTHROPIC_API_KEY as the optional
// direct path; CLAUDE_PROVIDER=anthropic|openrouter to prefer one when both keys are set.

export const OPENROUTER_MESSAGES_BASE = 'https://openrouter.ai/api';

const trim = (v) => String(v ?? '').trim();

/** claude-sonnet-5 -> anthropic/claude-sonnet-5, claude-haiku-4-5-20251001 -> anthropic/claude-haiku-4.5. */
export function openRouterClaudeId(id) {
  const s = trim(id);
  if (!s.startsWith('claude-')) return s;
  return `anthropic/${s.replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

/** The reverse, for the price table: anthropic/claude-opus-4.8 -> claude-opus-4-8; a dated id loses its date. */
export function claudeIdFromOpenRouter(id) {
  if (id == null) return null;
  const s = trim(id).replace(/^anthropic\//, '');
  if (!s.startsWith('claude-')) return s;
  return s.replace(/-\d{8}$/, '').replace(/-(\d+)\.(\d+)$/, '-$1-$2');
}

function openRouterKey(env) {
  if (trim(env.OPENROUTER_API_KEY)) return trim(env.OPENROUTER_API_KEY);
  const base = trim(env.LLM_BASE_URL);
  const isOpenRouter = !base || /(^|\/\/)([^/]*\.)?openrouter\.ai(\/|$)/i.test(base);
  return isOpenRouter && trim(env.LLM_API_KEY) ? trim(env.LLM_API_KEY) : null;
}

/** 'openrouter' | 'anthropic' | null (no key for either). */
export function claudeProvider(env = process.env) {
  const or = !!openRouterKey(env);
  const direct = !!trim(env.ANTHROPIC_API_KEY);
  const pref = trim(env.CLAUDE_PROVIDER).toLowerCase();
  if (pref === 'anthropic' && direct) return 'anthropic';
  if (or) return 'openrouter';
  return direct ? 'anthropic' : null;
}

/**
 * Constructor options for an @anthropic-ai/sdk (or useleak) client -> { provider, options }, or
 * null when no key is set. `headers` are Anthropic-only extras (the extended-cache-ttl beta): sent
 * direct, dropped for OpenRouter, which takes cache_control.ttl in the body.
 */
export function claudeClientOptions({ env = process.env, headers = null } = {}) {
  const provider = claudeProvider(env);
  if (provider === 'openrouter') {
    return { provider, options: {
      // apiKey must be null, not absent: the SDK would read ANTHROPIC_API_KEY and send it as x-api-key.
      apiKey: null, authToken: openRouterKey(env), baseURL: OPENROUTER_MESSAGES_BASE,
      defaultHeaders: { 'X-Title': 'opennous' },
    } };
  }
  if (provider === 'anthropic') {
    return { provider, options: { apiKey: trim(env.ANTHROPIC_API_KEY), ...(headers ? { defaultHeaders: { ...headers } } : {}) } };
  }
  return null;
}

/**
 * A client whose messages.create / messages.stream take this codebase's Claude ids and send the
 * provider's. Everything else in the request passes through as given.
 */
export function routeClaudeClient(client, provider) {
  const map = (p) => (provider === 'openrouter' && p?.model ? { ...p, model: openRouterClaudeId(p.model) } : p);
  return {
    provider,
    raw: client,
    messages: {
      create: (params, opts) => (opts === undefined ? client.messages.create(map(params)) : client.messages.create(map(params), opts)),
      stream: (params, opts) => (opts === undefined ? client.messages.stream(map(params)) : client.messages.stream(map(params), opts)),
    },
  };
}
