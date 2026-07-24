// The controlled INSIGHT taxonomy — the mirror image of the claim taxonomy.
//
// A claim is a durable fact ABOUT a contact (their pain, their budget, their
// stack). An insight is a durable fact ABOUT US — what a conversation taught us
// about our own product, positioning, market, or buyer. The claim extractor is
// built to NEVER record our own side of a call; the insight extractor exists to
// capture exactly that side, and route it into the workspace's Insights docs
// instead of onto the contact's account.
//
// Four categories, one per Insights doc. A controlled set is what lets the same
// insight ("reps can't action raw signals") accumulate across many calls into one
// readable doc, instead of scattering as free-form notes.

export interface InsightCategoryDef {
  /** The canonical, queryable key. Lowercase. */
  key: string;
  /** Human label — also the Insights doc title. */
  label: string;
  /** One-line definition, used in the extractor prompt. */
  description: string;
  /** A concrete example, used in the extractor prompt. */
  example: string;
}

export const INSIGHT_CATEGORIES: InsightCategoryDef[] = [
  {
    key: 'product',
    label: 'Product',
    description:
      'A signal about what to build or change in the product itself: a missing capability, a friction, a feature idea, or how the product should behave.',
    example: 'The value is in making the record actionable at the rep\'s level, not in the sophistication of the graph.',
  },
  {
    key: 'positioning',
    label: 'Positioning',
    description:
      'How we should describe, frame, or message the product: what language lands, what to emphasize, what confuses people.',
    example: 'Lead with outcomes for reps, not technical explanations of a "context graph".',
  },
  {
    key: 'market',
    label: 'Market',
    description:
      'A signal about the market, a segment, a wedge, a channel, or a competitor dynamic — where demand is and how to reach it.',
    example: 'GTM and cold-email agencies sitting on high-volume client reply data are an early market for a context layer.',
  },
  {
    key: 'buyer',
    label: 'Buyer',
    description:
      'Who buys and why: the ICP, the pain that drives the purchase, the bottleneck they feel, the trigger to act.',
    example: 'The real bottleneck is the adoption gap — reps have good data but cannot action it because they do not understand the signals.',
  },
];

export const INSIGHT_CATEGORY_KEYS: string[] = INSIGHT_CATEGORIES.map(c => c.key);

const KEY_SET = new Set(INSIGHT_CATEGORY_KEYS);

const ALIASES: Record<string, string> = {
  products: 'product',
  feature: 'product',
  features: 'product',
  messaging: 'positioning',
  position: 'positioning',
  gtm: 'market',
  markets: 'market',
  segment: 'market',
  wedge: 'market',
  channel: 'market',
  competitor: 'market',
  icp: 'buyer',
  buyers: 'buyer',
  persona: 'buyer',
  customer: 'buyer',
};

/** Coerce any input to a canonical insight category key, or null if it isn't one. */
export function normalizeInsightCategory(input?: string | null): string | null {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (KEY_SET.has(raw)) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  return null;
}

export function isValidInsightCategory(input?: string | null): boolean {
  return !!input && KEY_SET.has(String(input).trim().toLowerCase());
}

export function insightCategoryLabel(key: string): string {
  return INSIGHT_CATEGORIES.find(c => c.key === key)?.label ?? key;
}

/**
 * The category block injected into the insight-extractor prompt, generated from
 * the taxonomy so the prompt and the validator never drift.
 */
export function insightCategoryPromptBlock(): string {
  return INSIGHT_CATEGORIES.map(c => `- ${c.key} — ${c.description} e.g. "${c.example}"`).join('\n');
}
