// Is the AI provider answering? (GET-852)
//
// A Read that cannot reach the model records a pipeline_events row of kind `unavailable` and moves
// on (noema/read.mjs, signals/index.mjs). For one call that is right: an outage is not a bad answer.
// For a backfill it is wrong: an account out of credit or a revoked key turns every remaining read
// into a silent skip, and the history stays unread with nothing to say why. So the backfill job asks
// between its phases whether the provider has kept failing since it started, and pauses with the
// provider's own words when it has. A tiny probe call decides when it may continue.

/** Unavailable reads since the job (re)started before it pauses. One or two can be a blip. */
export const PROVIDER_FAIL_THRESHOLD = 3;
/** How often a paused job asks the provider again. */
export const PROBE_EVERY_MS = 5 * 60_000;

export class ProviderUnavailable extends Error {
  constructor(phase, failure) {
    super(`AI provider unavailable${phase ? ` (after ${phase})` : ''}: ${failure?.message ?? 'unknown error'}`);
    this.name = 'ProviderUnavailable';
    this.phase = phase ?? null;
    this.failure = failure ?? null;
  }
}

/**
 * What kind of failure an error message is, for the operator: out of credit, a bad key, a rate
 * limit, or the provider being down. Order matters: "insufficient credits" arrives as a 402 on
 * OpenRouter and as a 400 "credit balance is too low" on Anthropic.
 */
export function classifyProviderError(message) {
  const m = String(message ?? '');
  if (/\b402\b|insufficient|credit|balance|quota|billing|payment|top.?up/i.test(m)) return 'credit';
  if (/\b40[13]\b|api.?key|unauthori[sz]ed|forbidden|authentication|invalid.*key/i.test(m)) return 'auth';
  if (/\b429\b|rate.?limit|too many requests/i.test(m)) return 'rate_limit';
  return 'outage';
}

/** Unavailable reads for a workspace since `sinceIso`: how many, and the newest one's words. */
export async function providerFailures(supabase, workspaceId, sinceIso) {
  const { data, error } = await supabase
    .from('pipeline_events')
    .select('occurred_at, detail')
    .eq('workspace_id', workspaceId)
    .eq('kind', 'unavailable')
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false })
    .limit(50);
  if (error || !data?.length) return { count: 0, last: null };
  const message = String(data[0]?.detail?.error ?? 'The AI provider did not answer.').slice(0, 300);
  return { count: data.length, last: { message, reason: classifyProviderError(message), at: data[0].occurred_at } };
}

/** One tiny call on the reading model, no fallback: does the provider answer now? */
export async function probeProvider(createMessage) {
  try {
    await createMessage({
      feature: 'provider-probe', tier: 'extraction', max_tokens: 8, fallback: false,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      accept: () => true,
    });
    return { ok: true };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    return { ok: false, message, reason: classifyProviderError(message) };
  }
}

/** The operator-facing sentence for a pause, by kind. */
export function providerPauseLine(reason, provider = 'your AI provider') {
  switch (reason) {
    case 'credit': return `${provider} says your account is out of credit.`;
    case 'auth': return `${provider} rejected the API key.`;
    case 'rate_limit': return `${provider} is rate-limiting this install.`;
    default: return `${provider} is not answering.`;
  }
}
