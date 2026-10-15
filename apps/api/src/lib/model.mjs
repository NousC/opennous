// The model seam — QM's Harness shape, thin on purpose.
//
// Today the agent is Anthropic-first. This module is the ONE place model choice lives, so
// swapping or adding a provider is a localized change, not a hunt through the codebase. A
// logical model name resolves to { provider, modelId, effort }; the agent reads that
// instead of hardcoding a string.
//
// What's wired today: Anthropic only (the streaming loop in playgroundAgent.mjs is the
// Anthropic adapter, inline). What a second provider needs, when we add one, is a small
// adapter implementing the same contract the agent uses:
//   - stream(messages, tools, opts) -> async iterator of text/tool-use/usage events
//   - create(messages, tools, opts) -> a single completion
// Extract the current Anthropic calls into `adapters/anthropic.mjs`, add
// `adapters/openai.mjs` etc., and pick the adapter here by `provider`. Until then this
// seam keeps the boundary honest without pretending to support providers we haven't built.

const REGISTRY = {
  // key = logical name callers ask for; value = how to run it + how it's shown in the picker.
  // `thinking` marks the models that support extended thinking + effort (Sonnet/Opus); Haiku
  // and open models don't, so the agent omits those knobs for them. `class` ('frontier'|'open')
  // groups the picker; `label`/`vendor` are display. Credit cost is NOT stored here — it's
  // derived from real model cost in llmUsage (PRICING), so there is one source of truth and a
  // frontier model automatically spends more credits than a cheap one.
  // Anthropic (the streaming loop in playgroundAgent is this adapter, inline):
  'claude-sonnet-5':   { provider: 'anthropic', modelId: 'claude-sonnet-5',            effort: 'medium', thinking: true,  class: 'frontier', label: 'Claude Sonnet 5', vendor: 'Anthropic', context: 200000 },
  'claude-opus-4-8':   { provider: 'anthropic', modelId: 'claude-opus-4-8',            effort: 'high',   thinking: true,  class: 'frontier', label: 'Claude Opus 4.8', vendor: 'Anthropic', context: 200000 },
  // HIDDEN FROM THE CHAT PICKER (2026-09-11) — still the workhorse everywhere else.
  //
  // Haiku is the right model for the background passes and it is genuinely good at them:
  // signal extraction ran 32 calls for four cents. It is not good enough to BE the agent.
  // Tried as the conversation model and the answers were visibly worse than Sonnet's, and
  // the saving that bought was 4.6 cents a turn — which is not a trade worth making on the
  // one surface the whole product is judged by.
  //
  // The real token lever turned out to be payload size, not model choice: cache writes are
  // 75% of a turn's cost and output only 10%, so trimming what the tools return saves more
  // than downgrading the brain, and keeps the brain. See compressClaims in @nous/core.
  //
  // Still reachable by the `draft` and `cheap` TIERS below (which do not go through the
  // picker) and by an org policy that names it explicitly.
  'claude-haiku-4-5':  { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001',  effort: 'low',    thinking: false, class: 'frontier', label: 'Claude Haiku 4.5', vendor: 'Anthropic', context: 200000, hidden: true },

  // HIDDEN FROM THE PICKER (2026-09-10), still runnable if an org policy names one.
  //
  // The OpenAI-compatible path has no extended thinking and populates no sources, so a turn
  // on one of these produces a trace with no reasoning in it and an answer with nothing to
  // cite — the two things the chat is built to show. Rather than offer a model that quietly
  // makes the product worse, the picker is Anthropic-only until the harness can carry both.
  // Flip `hidden` off per model the day it can.
  //
  // Open + local models via the one OpenAI-compatible adapter (lib/harness.mjs). Adding a
  // model is just a line here: a base URL, a model id, and which env var holds the key
  // (none for a local server). Frontier open models handle our tool-heavy agent; small
  // ones will flail, so we curate to the capable ones. `context` is the model's window in
  // tokens — the harness clamps the output budget so input+output can't overflow it (our
  // system prompt + tool schemas alone are ~17k, which a 32k model can't pair with a big
  // output). Use each endpoint's REAL window; when unsure, err low.
  // Refreshed 2026-09-11. The previous list (Llama 3.3, Qwen 2.5, DeepSeek V3, Kimi K2) was
  // a year stale — a generation before open weights became genuinely agentic. These are the
  // current ones that hold up on tool use, which is the only axis that matters for us: this
  // agent hands the model sixty-odd tools and expects it to chain several per turn.
  //
  // Priced per MTok (OpenRouter, Sept 2026). On our real token profile — 35,749 in / 377 out
  // per call — the honest comparison is NOT against Sonnet's list price but against Sonnet
  // WITH prompt caching, because the harness below has none:
  //
  //   Sonnet 5 cached  $0.0553/turn        GLM-5.2 uncached     $0.0180
  //   Haiku 4.5 cached $0.0184             MiniMax M2.5         $0.0100
  //                                        DeepSeek V4 Flash    $0.0051
  //
  // The number that decides this: Sonnet's cache READ is $0.30/MTok and GLM's plain input is
  // $0.4875 — so re-reading our 23k prefix is literally CHEAPER on Sonnet than on the open
  // model. Every bit of the saving comes from the cache-WRITE side (tool payloads), which is
  // exactly what compressClaims and pruneEmpty just shrank. Add caching to the harness and
  // the ranking changes again; GLM is the one that actually returns cached tokens through
  // OpenRouter.
  // Verified against the live OpenRouter catalogue (ids, prices and context windows) rather
  // than written from memory — the first pass had glm-5.2 priced ~25% under, kimi-k2.6 under
  // by a third, and `deepseek/deepseek-v4`, which does not exist. Selecting that would have
  // failed at the first turn.
  //
  // GLM 5.2 is the chat's Low level and the default (GET-212). It stays `hidden` so the
  // provider list and the no-policy allowlist are unchanged; the chat reaches it through
  // MODEL_LEVELS below, not through `hidden`.
  'glm-5.2':      { provider: 'openai-compatible', modelId: 'z-ai/glm-5.2',                baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', effort: null, class: 'open', label: 'GLM 5.2',        vendor: 'Z.ai',        context: 1048576, hidden: true },
  'minimax-m2.5':  { provider: 'openai-compatible', modelId: 'minimax/minimax-m2.5',        baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', effort: null, class: 'open', label: 'MiniMax M2.5',   vendor: 'MiniMax',     context: 204800,  hidden: true },
  'kimi-k2.6':     { provider: 'openai-compatible', modelId: 'moonshotai/kimi-k2.6',        baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', effort: null, class: 'open', label: 'Kimi K2.6',      vendor: 'Moonshot AI', context: 262144,  hidden: true },
  'deepseek-v4':   { provider: 'openai-compatible', modelId: 'deepseek/deepseek-v4-pro',    baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', effort: null, class: 'open', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek',   context: 1048576, hidden: true },
  'qwen3-coder':   { provider: 'openai-compatible', modelId: 'qwen/qwen3-coder',            baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', effort: null, class: 'open', label: 'Qwen3 Coder',    vendor: 'Alibaba',     context: 262144,  hidden: true },
  'local':         { provider: 'openai-compatible', modelId: process.env.NOUS_LOCAL_MODEL || 'qwen2.5:32b', baseURL: process.env.NOUS_LOCAL_BASE_URL || 'http://localhost:11434/v1', apiKeyEnv: null, effort: null, class: 'open', label: 'Local model', vendor: 'Your infra', context: Number(process.env.NOUS_LOCAL_CONTEXT) || 32768 , hidden: true },
};

/** A model key the picker/route can trust. */
export function isKnownModel(key) { return Boolean(key && REGISTRY[key]); }

/**
 * May this model be the CONVERSATION model?
 *
 * `hidden` has meant one thing all along — we have judged that offering this model would
 * quietly make the product worse. The open models are hidden because the harness gives them
 * no thinking and no sources; Haiku is hidden because its answers are not good enough to be
 * the agent. Both are reasons not to hand someone a chat on them.
 *
 * It does NOT mean unusable: the tiers call these by key, and an org policy may still name
 * one deliberately, which applyModelPolicy honours after this check.
 */
export function isChatModel(key) {
  // A level's model is a chat model by ruling, even when `hidden` keeps it off the old
  // provider list (GLM 5.2 is Low). Every other hidden model stays out.
  return isKnownModel(key) && (!REGISTRY[key].hidden || LEVEL_BY_MODEL.has(key));
}

// ── Model LEVELS: the only choice the chat picker offers (GET-212, 2026-09-13) ─────────────
//
// "Keep it simple in the beginning." The operator picks how hard the agent works — Low,
// Medium or High — not a model out of a catalogue. This table is the ONE place a level maps
// to a model: the picker reads it from GET /api/models and sends the level id back, and the
// chat route resolves it here. The frontend never names a model key.
//
// Low is the default for every workspace and every new user.
export const MODEL_LEVELS = Object.freeze([
  Object.freeze({ id: 'low',    model: 'glm-5.2',         label: 'Low' }),
  Object.freeze({ id: 'medium', model: 'claude-sonnet-5', label: 'Medium' }),
  Object.freeze({ id: 'high',   model: 'claude-opus-4-8', label: 'High' }),
]);
export const DEFAULT_LEVEL = 'low';

const LEVEL_BY_ID = new Map(MODEL_LEVELS.map((l) => [l.id, l]));
const LEVEL_BY_MODEL = new Map(MODEL_LEVELS.map((l) => [l.model, l]));

/**
 * The level a picker value stands for. Accepts a level id ('low'|'medium'|'high') or a legacy
 * registry key a stale tab may still send (glm-5.2 → low, claude-sonnet-5 → medium,
 * claude-opus-4-8 → high). Anything else — another model key, a typo, nothing — is Low.
 * Always returns one of MODEL_LEVELS.
 */
export function resolveLevel(levelOrKey) {
  const v = typeof levelOrKey === 'string' ? levelOrKey.trim().toLowerCase() : '';
  return LEVEL_BY_ID.get(v) ?? LEVEL_BY_MODEL.get(v) ?? LEVEL_BY_ID.get(DEFAULT_LEVEL);
}

/** The picker list — each level with the display fields of the model it runs. */
export function listLevels() {
  return MODEL_LEVELS.map((l) => {
    const m = REGISTRY[l.model];
    return {
      id: l.id, label: l.label,
      model: l.model, modelLabel: m.label, modelId: m.modelId, vendor: m.vendor, class: m.class,
    };
  });
}

const DEFAULT = 'claude-sonnet-5';

/**
 * The OpenNous agent's standard model: GLM 5.2, through OpenRouter. Every agent turn that does
 * not ask for a model runs it — scheduled automations, onboarding reports, plays a watch starts,
 * the Slack bot. Until 2026-09-30 an unnamed turn fell to the reason tier (Claude, on our own
 * Anthropic key), so when that account ran out of credit every scheduled automation failed while
 * chat, which names its level, kept answering on GLM. A chat level or tier that names Claude
 * still gets Claude; NOUS_AGENT_MODEL still overrides.
 */
export const STANDARD_AGENT_MODEL = 'glm-5.2';

// Tiers — the tiering pattern. A caller asks for a job class, not a model, so we can point
// each class at the right cost/quality tier and change it in one place (or by env) without
// touching call sites. Defaults are conservative (all Claude); set NOUS_MODEL_CHEAP to an
// open or local model (e.g. 'llama-3.3-70b' or 'local') to run the high-volume path cheaply
// or on your own infra, while hard reasoning stays on Claude.
const TIERS = {
  reason: process.env.NOUS_MODEL_REASON || DEFAULT,             // hard reasoning: planning, judgment
  // Haiku stays here on purpose. It is off the chat picker because it is not good enough to
  // be the agent; it is excellent at the passes nobody reads the prose of, and it is ~3x
  // cheaper per token than Sonnet, which is where that cheapness belongs.
  // GLM 5.2 for drafting (product decision, 2026-09-12). Its plain input price beats Sonnet's CACHE
  // READ, which is the comparison that decides a high-volume path, and a million-token
  // window means a long account history never has to be trimmed to fit.
  //
  // ⚠️ It runs through the OpenAI-compatible adapter and needs OPENROUTER_API_KEY, which is
  // NOT set in production today. `resolveAgentModel` refuses a model whose key is missing
  // and falls back rather than failing the call — so until that key is set this tier quietly
  // stays on Claude instead of erroring on first use.
  draft:  process.env.NOUS_MODEL_DRAFT  || 'glm-5.2',           // medium: drafting outreach, summaries
  cheap:  process.env.NOUS_MODEL_CHEAP  || 'claude-haiku-4-5',  // high-volume mechanical: classify, extract
};

/**
 * Resolve the model to run. `pref` may be a TIER name ('reason'|'draft'|'cheap'), a concrete
 * registry key, or undefined. Undefined uses NOUS_AGENT_MODEL (the global override) or the
 * reason tier. Unknown values fall back to the default rather than failing a turn on a typo.
 */
export function resolveAgentModel(pref) {
  let key;
  if (pref && TIERS[pref]) key = TIERS[pref];
  else if (pref && REGISTRY[pref]) key = pref;
  else key = process.env.NOUS_AGENT_MODEL || STANDARD_AGENT_MODEL;
  const chosen = REGISTRY[key] ?? REGISTRY[DEFAULT];

  // A model nobody can authenticate to is not a choice, it is an outage.
  //
  // Every non-Anthropic entry names the env var holding its key, and the harness reads that
  // var at call time — so pointing a TIER at a model whose key is unset turns the first
  // caller that reaches for it into a failed turn, at whatever hour that happens to be. The
  // registry is a list of models we COULD run; this is the check for the ones we can run
  // right now. Falling back keeps the path alive and degraded rather than dead, and says so
  // once rather than on every call.
  //
  // It says so LOUDLY (GET-212): GLM 5.2 is the Low level and the default for every chat, so a
  // missing OPENROUTER_API_KEY means every default turn is quietly running — and billing —
  // Sonnet. That is an error in the logs, not a warning. The llm_usage row is written with the
  // model that actually ran (the returned config's modelId), so the spend is never mislabelled.
  if (chosen.apiKeyEnv && !process.env[chosen.apiKeyEnv]) {
    if (!warnedMissingKey.has(key)) {
      warnedMissingKey.add(key);
      const level = LEVEL_BY_MODEL.get(key);
      console.error(
        `[MODEL] ${key} needs ${chosen.apiKeyEnv}, which is not set — every turn asking for it runs ${DEFAULT} instead`
        + (level ? ` (the "${level.label}" chat level${level.id === DEFAULT_LEVEL ? ', the default' : ''} is NOT running ${chosen.label})` : '')
        + `. Set ${chosen.apiKeyEnv} to fix. Logged once per process.`,
      );
    }
    return REGISTRY[DEFAULT];
  }
  return chosen;
}
const warnedMissingKey = new Set();

/**
 * The RevBox Job Builder's model (GET-905): JOB_BUILDER_MODEL when it names a Claude model in the
 * registry, else Claude Sonnet 5. Claude only: the builder's tool loop speaks Anthropic's Messages
 * format, served by OpenRouter or Anthropic (whichever key is set).
 */
export const JOB_BUILDER_DEFAULT_MODEL = 'claude-sonnet-5';
export function jobBuilderModel(env = process.env) {
  const want = String(env.JOB_BUILDER_MODEL ?? '').trim();
  const m = want ? REGISTRY[want] ?? Object.values(REGISTRY).find(r => r.modelId === want) : null;
  return m && m.provider === 'anthropic' ? m : REGISTRY[JOB_BUILDER_DEFAULT_MODEL];
}

/** Resolve a tier directly (sugar for callers that think in job classes). */
export function resolveTier(tier) { return resolveAgentModel(tier); }

/** The curated picker list — display fields only (no keys/base URLs the client shouldn't see). */
export function listModels({ includeHidden = false } = {}) {
  return Object.entries(REGISTRY)
    .filter(([, v]) => includeHidden || !v.hidden)
    .map(([key, v]) => ({
      key, label: v.label, vendor: v.vendor, class: v.class, modelId: v.modelId,
    }));
}

// ── A floor for the work that cannot be redone ──────────────────────────────
//
// The model is resolved ONCE, at the start of a turn, before any tool runs. By the time
// `present_document` is called the turn is already streaming, so there is no seam to switch
// at — a report written by a weak model cannot be upgraded halfway through, it can only be
// asked for again.
//
// That asymmetry is the whole argument for a floor. A weak model on a chat turn costs one
// mediocre answer the operator can simply re-ask; a weak model on an eleven-section report
// costs a document somebody forwards to their board. The NUMBERS are safe either way —
// revenue_report_data and win_loss_data are SQL, so no model touches a median — but section
// composition, which block carries which claim, and whether a thesis states a finding are
// exactly what a smaller model does worse.
//
// So a report request lifts an open model to a frontier one for that turn, and nothing else.
//
// NOT applied to a chat LEVEL pick (GET-212): the operator chose Low, and Low runs GLM. The
// floor stays exported for any caller that resolves a model without an explicit choice.

/** True for a model we consider strong enough to compose a document unsupervised. */
export function isFrontierModel(key) { return REGISTRY[key]?.class === 'frontier'; }

/**
 * The model to actually run when the turn is going to produce a REPORT.
 *
 * Returns `key` unchanged when it is already frontier. Otherwise the best frontier model the
 * workspace permits — and if an org policy allows no frontier model at all, `key` is returned
 * untouched. A floor may raise quality; it may never overrule what an org has decided may
 * touch its data.
 */
export function applyReasoningFloor(key, policy) {
  if (isFrontierModel(key)) return key;
  const allow = Array.isArray(policy?.allowlist) ? policy.allowlist.filter(isKnownModel) : null;
  if (allow?.length) {
    const permittedFrontier = allow.find(isFrontierModel);
    return permittedFrontier ?? key;   // policy wins over the floor
  }
  return TIERS.reason && isFrontierModel(TIERS.reason) ? TIERS.reason : DEFAULT;
}

// ── Model choice as org policy (the trust layer) ────────────────────────────
// A workspace may narrow which models touch its data. `policy` is the workspaces
// .model_policy JSONB: { allowlist: string[], default: string } of registry keys.
// Null / empty allowlist = no policy = every model allowed (default behaviour).

/** The subset of a picker list an org policy permits. No policy → the list unchanged. */
export function filterModelsByPolicy(models, policy) {
  const allow = Array.isArray(policy?.allowlist) ? policy.allowlist.filter(isKnownModel) : null;
  if (!allow || !allow.length) return models;
  const set = new Set(allow);
  return models.filter((m) => set.has(m.key));
}

/**
 * Enforce the policy on a user's model choice — the server-side boundary. Returns a model
 * key the workspace permits:
 *   - no policy            → `pref` unchanged (the user's choice, or undefined → global default)
 *   - `pref` is allowed    → `pref`
 *   - `pref` not allowed   → the org default (or the first allowed model) — never a denied one
 * So a user can never run a model outside the allowlist, even by hitting the API directly.
 */
export function applyModelPolicy(pref, policy) {
  const allow = Array.isArray(policy?.allowlist) ? policy.allowlist.filter(isKnownModel) : null;
  if (!allow || !allow.length) return pref;
  if (pref && allow.includes(pref)) return pref;
  return policy.default && allow.includes(policy.default) ? policy.default : allow[0];
}

/** Validate an admin-supplied policy before it's stored. Returns a clean policy or null. */
export function sanitizeModelPolicy(input) {
  if (!input || typeof input !== 'object') return null;
  const allowlist = Array.isArray(input.allowlist) ? [...new Set(input.allowlist.filter(isKnownModel))] : [];
  if (!allowlist.length) return null; // empty allowlist means "no policy", stored as NULL
  const def = isKnownModel(input.default) && allowlist.includes(input.default) ? input.default : allowlist[0];
  return { allowlist, default: def };
}

// ── Providers ───────────────────────────────────────────────────────────────
//
// A brand, not an adapter. `provider` above says HOW we call a model ('anthropic' vs the
// OpenAI-compatible path); `vendor` says WHOSE model it is, and that is the unit an admin
// thinks in: "we're an Anthropic shop", "no Chinese labs on our call transcripts". So the
// admin surface toggles a vendor and the allowlist is derived from it.
//
// The default set — which vendors are on when a workspace has never touched the page — is
// the un-hidden models in the registry. Today that is Anthropic alone, for the reason
// documented on the hidden flags: the OpenAI-compatible path carries no extended thinking
// and populates no sources, so those turns produce a trace with no reasoning and an answer
// with nothing to cite.
const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'DeepSeek', 'Moonshot AI', 'Alibaba', 'Meta', 'Your infra'];

/** Every vendor in the registry with its models and whether the models are on by default. */
export function listProviders() {
  const byVendor = new Map();
  for (const [key, v] of Object.entries(REGISTRY)) {
    const e = byVendor.get(v.vendor) ?? { vendor: v.vendor, models: [] };
    e.models.push({ key, label: v.label, class: v.class, modelId: v.modelId, defaultOn: !v.hidden });
    byVendor.set(v.vendor, e);
  }
  return [...byVendor.values()].sort(
    (a, b) => (PROVIDER_ORDER.indexOf(a.vendor) + 1 || 99) - (PROVIDER_ORDER.indexOf(b.vendor) + 1 || 99)
  );
}

/** Every model key whose vendor ships enabled out of the box — the implicit "no policy" set. */
export function defaultAllowedModels() {
  return Object.entries(REGISTRY).filter(([, v]) => !v.hidden).map(([k]) => k);
}

/**
 * Which vendor a RAW model id belongs to — for reading llm_usage back, where the stored
 * value is the provider's own id ('claude-haiku-4-5-20251001', 'moonshotai/kimi-k2'), not
 * our registry key. Exact match first, then the id prefix a vendor namespaces with, so a
 * model we ran before it was in the registry still lands on the right brand instead of
 * "Unknown".
 */
const VENDOR_BY_ID_PREFIX = [
  ['claude-',      'Anthropic'],
  ['anthropic/',   'Anthropic'],
  ['openai/',      'OpenAI'],
  ['gpt-',         'OpenAI'],
  ['o1',           'OpenAI'],
  ['deepseek',     'DeepSeek'],
  ['moonshotai/',  'Moonshot AI'],
  ['kimi',         'Moonshot AI'],
  ['qwen',         'Alibaba'],
  ['meta-llama/',  'Meta'],
  ['llama',        'Meta'],
  ['mistral',      'Mistral AI'],
  ['gemini',       'Google'],
  ['google/',      'Google'],
  ['z-ai/',        'Z.ai'],
  ['glm',          'Z.ai'],
  ['minimax',      'MiniMax'],
];

/**
 * Labels for models that have LEFT the registry but are still in someone's usage history.
 *
 * Retiring a model from `REGISTRY` is the right call — it should stop being offered — but the
 * rows it wrote do not disappear, and `labelOfModelId` fell back to the raw id. The Usage page
 * went from "Kimi K2" to "kimi-k2" with an unknown-vendor avatar the moment the registry was
 * refreshed, which reads as a data problem rather than a model we retired on purpose.
 *
 * A retired model belongs here, not back in the registry: history stays legible and nothing
 * becomes selectable again.
 */
const RETIRED_LABELS = {
  // Offered briefly, withdrawn on 2026-09-11: the answers were not good enough. Its usage
  // history stays legible here; it is simply not selectable.
  'z-ai/glm-4.7':                      'GLM 4.7',
  'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
  'qwen/qwen-2.5-72b-instruct':        'Qwen 2.5 72B',
  'deepseek/deepseek-chat':            'DeepSeek V3',
  'openai/gpt-oss-120b':               'GPT-OSS 120B',
  'moonshotai/kimi-k2':                'Kimi K2',
};

export function vendorOfModelId(modelId) {
  if (!modelId) return 'Unknown';
  const id = String(modelId).toLowerCase();
  for (const v of Object.values(REGISTRY)) {
    if (String(v.modelId).toLowerCase() === id) return v.vendor;
  }
  for (const [prefix, vendor] of VENDOR_BY_ID_PREFIX) {
    if (id.startsWith(prefix) || id.includes(`/${prefix}`)) return vendor;
  }
  return 'Unknown';
}

/** The display label for a raw model id, falling back to the id itself. */
export function labelOfModelId(modelId) {
  if (!modelId) return 'Unknown';
  const id = String(modelId).toLowerCase();
  for (const v of Object.values(REGISTRY)) {
    if (String(v.modelId).toLowerCase() === id) return v.label;
  }
  // A model we retired still has history; name it properly rather than showing a raw id.
  for (const [rid, label] of Object.entries(RETIRED_LABELS)) {
    if (rid.toLowerCase() === id) return label;
  }
  return String(modelId).split('/').pop();
}
