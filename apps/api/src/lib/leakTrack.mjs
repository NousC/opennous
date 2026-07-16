// Usage reporting for streamed Anthropic calls.
//
// The `useleak` wrapper only instruments `messages.create` — it awaits the full
// response, reads `usage`, and posts to Leak. Streaming has to go through the
// raw @anthropic-ai/sdk client (`wrapper.getClient()`), which bypasses that
// instrumentation entirely. This mirrors useleak's ingest payload so streamed
// turns still land in Leak alongside everything else.
//
// If useleak ever ships a streaming wrapper, delete this and use it.

const DEFAULT_INGEST_URL = 'https://useleak.cloud/api/ingest';

// $ per 1M tokens, per Anthropic's published pricing. Keep in sync with the
// models we actually call — an unknown model reports cost 0 rather than a guess.
const PRICING = {
  'claude-opus-4-8':          { in: 5,  out: 25 },
  'claude-sonnet-5':          { in: 3,  out: 15 },
  'claude-haiku-4-5':         { in: 1,  out: 5  },
  'claude-haiku-4-5-20251001':{ in: 1,  out: 5  },
};

const computeCost = (model, tokensIn, tokensOut) => {
  const p = PRICING[model];
  if (!p) return 0;
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
};

/**
 * Report one streamed model call to Leak. Fire-and-forget — a tracking failure
 * must never surface to the user mid-chat.
 */
export function leakTrack({ model, feature, user, usage, requestId }) {
  const key = process.env.LEAK_KEY;
  if (!key) return;
  const url = process.env.LEAK_URL || DEFAULT_INGEST_URL;

  const tokensIn  = usage?.input_tokens  ?? 0;
  const tokensOut = usage?.output_tokens ?? 0;

  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nous-api/streaming',
    },
    body: JSON.stringify({
      provider:   'anthropic',
      model,
      feature,
      user:       typeof user === 'string' ? user : user?.id,
      user_email: typeof user === 'object' ? user?.email : undefined,
      tokens_in:  tokensIn,
      tokens_out: tokensOut,
      cost:       computeCost(model, tokensIn, tokensOut),
      request_id: requestId,
    }),
    keepalive: true,
  }).catch(() => { /* never block the chat on telemetry */ });
}
