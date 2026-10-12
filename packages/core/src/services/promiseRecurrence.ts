// A promise made twice is a different fact from two promises.
//
// "I'll send the export fix" said on three consecutive calls is the loudest churn signal a CS org
// can produce, and we filed it as three unrelated tasks. Commitments carry the deterministic
// property `action_item.meeting_<meetingId>_<i>`, so re-running the SAME meeting overwrites —
// that part was right. But the same promise restated on the NEXT call is a different meeting,
// so it became a second independent row and nothing counted the recurrence.
//
// No extractor will ever catch this. The model sees one call; recurrence only exists across
// calls. So it is code.
//
// It is also deliberately NOT a model call. A model asked "are these the same promise" says yes
// to anything adjacent, and the count is the entire product — a recurrence number that drifts
// with the weather is worse than no number, because people act on it.

/** Words that carry no promise-identity. Deliberately small: over-stripping merges distinct promises. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'on', 'in', 'at', 'by', 'with', 'from', 'over', 'up',
  'and', 'or', 'but', 'that', 'this', 'it', 'them', 'him', 'her', 'us', 'we', 'i', 'you', 'he',
  'she', 'they', 'my', 'our', 'your', 'their', 'his', 'its', 'be', 'is', 'are', 'was', 'will',
  'would', 'can', 'could', 'should', 'do', 'does', 'did', 'have', 'has', 'had', 'get', 'got',
  'go', 'going', 'll', 'ill', 'want', 'need', 'make', 'sure', 'please', 'also', 'back', 'out',
]);

/**
 * Crude suffix stemming, on purpose. "send" / "sending" / "sends" / "sent" must collapse, and a
 * real stemmer buys accuracy we cannot measure here at the cost of a dependency we would then
 * have to keep in step with whatever the extractor emits.
 */
function stem(word: string): string {
  if (word === 'sent') return 'send';
  if (word === 'sending') return 'send';
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The content words a promise is actually about, stemmed and de-duplicated. */
export function promiseTokens(title: string | null | undefined): Set<string> {
  const words = String(title ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length > 1 && !STOPWORDS.has(s)) out.add(s);
  }
  return out;
}

/**
 * Two tokens are the same word when one is a prefix of the other and the shorter is long enough
 * to mean something. Suffix stemming alone leaves "sign" and "signature" apart, and prod has
 * "Send NDA to sign" sitting next to "Send NDA to user for signature" — plainly one promise.
 * The 4-character floor is what stops "app" matching "approval".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) for (const u of b) if (sameWord(t, u)) { n++; break; }
  return n;
}

/** Jaccard over content tokens. Symmetric, bounded, and explainable to someone disputing a count. */
export function promiseSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const shared = sharedCount(a, b);
  return shared / (a.size + b.size - shared);
}

/**
 * How much of the SHORTER promise the longer one contains.
 *
 * Jaccard alone is the wrong shape for this data. A restatement almost always ADDS detail rather
 * than replacing it — "Sign NDA" becomes "Sign NDA before getting access" — and Jaccard punishes
 * the addition, scoring a plain restatement 0.5 while a human reads it as identical.
 */
export function promiseContainment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  return sharedCount(a, b) / Math.min(a.size, b.size);
}

/**
 * 0.6 keeps "send the export fix" with "send over the export fix to Bram" and splits "send the deck"
 * from "send the contract". Tunable against rows, which is the point of it being a number.
 */
export const PROMISE_MATCH_THRESHOLD = 0.6;

/**
 * Containment needs a higher bar AND at least two shared words, because containment is 1.0 for
 * any single word inside a longer title — "Send" would otherwise swallow everything sent.
 */
export const PROMISE_CONTAINMENT_THRESHOLD = 0.8;
const MIN_SHARED_FOR_CONTAINMENT = 2;

/** One promise restating another: either broadly the same words, or wholly inside them. */
export function promiseMatch(a: Set<string>, b: Set<string>, threshold: number): boolean {
  if (promiseSimilarity(a, b) >= threshold) return true;
  return sharedCount(a, b) >= MIN_SHARED_FOR_CONTAINMENT
    && promiseContainment(a, b) >= PROMISE_CONTAINMENT_THRESHOLD;
}

export interface PromiseItem {
  /** What was promised. */
  title: string;
  /** Who owes it. Two people promising the same thing is two promises, not a repeat. */
  owner_kind?: string | null;
  /** When it was promised, ISO. Orders the cluster so "first said" and "last said" are real. */
  at?: string | null;
  /** Anything the caller wants back on the other side. */
  ref?: unknown;
}

export interface PromiseCluster {
  /** A stable, readable label: the tokens the cluster agrees on. */
  key: string;
  /** How many times it was promised. 1 means it was said once. */
  count: number;
  first_at: string | null;
  last_at: string | null;
  items: PromiseItem[];
}

/**
 * Greedy single-link clustering, oldest first. Greedy is right here: the alternative is to
 * optimise a global assignment, and a promise's identity is not a global property — it is
 * "did this restate something already on the table".
 */
export function clusterPromises(
  items: PromiseItem[],
  threshold: number = PROMISE_MATCH_THRESHOLD,
): PromiseCluster[] {
  const withTokens = items
    .map(it => ({ it, tokens: promiseTokens(it.title) }))
    .filter(x => x.tokens.size > 0)   // a title with no content words cannot be matched on
    .sort((a, b) => String(a.it.at ?? '').localeCompare(String(b.it.at ?? '')));

  const clusters: Array<{ tokens: Set<string>; items: PromiseItem[] }> = [];
  for (const { it, tokens } of withTokens) {
    let best: { c: typeof clusters[number]; score: number } | null = null;
    for (const c of clusters) {
      // An owner boundary is hard: what we owe and what they owe are different obligations
      // even when the words are identical.
      if ((c.items[0].owner_kind ?? null) !== (it.owner_kind ?? null)) continue;
      if (!promiseMatch(tokens, c.tokens, threshold)) continue;
      // Rank candidates by plain similarity so the closest cluster wins when several match.
      const score = promiseSimilarity(tokens, c.tokens);
      if (!best || score > best.score) best = { c, score };
    }
    if (best) best.c.items.push(it);
    else clusters.push({ tokens, items: [it] });
  }

  return clusters.map(c => {
    const dates = c.items.map(i => i.at).filter(Boolean) as string[];
    dates.sort();
    return {
      key: [...c.tokens].sort().join(' '),
      count: c.items.length,
      first_at: dates[0] ?? null,
      last_at: dates[dates.length - 1] ?? null,
      items: c.items,
    };
  });
}

/**
 * How many distinct promises were made more than once.
 *
 * Counts CLUSTERS, not rows: one thing promised three times is one broken promise, not three.
 * Deliberately counts a promise that was closed and then promised again — that is the worst
 * version of this, not an error, and the naive "only look at open rows" reading misses it
 * exactly when it matters most.
 */
export function countRepeatedPromises(
  items: PromiseItem[],
  threshold: number = PROMISE_MATCH_THRESHOLD,
): number {
  return clusterPromises(items, threshold).filter(c => c.count > 1).length;
}
