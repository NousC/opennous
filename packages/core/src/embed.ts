// Text embeddings via OpenAI (text-embedding-3-small — 1536-dim, matching the
// vector(1536) columns on observations and claims). Returns null if
// OPENAI_API_KEY is unset or the call fails — callers degrade gracefully to
// structured retrieval, never crash.

const MODEL = 'text-embedding-3-small';

export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || texts.length === 0) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: texts }),
    });
    if (!res.ok) {
      console.error('[EMBED] OpenAI error', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json: any = await res.json();
    // OpenAI may return out of order — sort by index to preserve input order.
    return (json.data ?? [])
      .slice()
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding as number[]);
  } catch (err: any) {
    console.error('[EMBED]', err?.message || err);
    return null;
  }
}

export async function embed(text: string): Promise<number[] | null> {
  const out = await embedBatch([text]);
  return out?.[0] ?? null;
}
