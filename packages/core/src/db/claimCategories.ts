// The controlled GTM claim taxonomy.
//
// Every extracted or asserted Intel claim carries exactly one of these category
// keys plus an `about` (person or company). A controlled taxonomy is what turns
// claims from pretty notes into queryable patterns across accounts: "every
// account whose pain is fragmented tooling", "every champion who prefers
// LinkedIn". Free-form LLM categories cannot roll up; these can.
//
// Two kinds of claims live in the graph. Structured claims (job_title, industry)
// are DERIVED from observations by the claim engine. The claims below are
// EXTRACTED from a contact's own words in conversations and carry one of these
// categories. Signals (scoring features: hiring, funding, tech-stack, intent)
// are a SEPARATE system that feeds the ICP and intent scores; they are not
// claims and are not in this taxonomy. Preferences are ONE category here, not a
// system of their own.

export interface ClaimCategoryDef {
  /** The canonical, queryable key. Lowercase, snake_case. */
  key: string;
  /** Human label for display. */
  label: string;
  /** Whether the claim is usually about the person, the company, or either. */
  about: 'person' | 'company' | 'either';
  /** One-line definition, used in the extractor prompt. */
  description: string;
  /** A concrete example, used in the extractor prompt. */
  example: string;
}

export const CLAIM_CATEGORIES: ClaimCategoryDef[] = [
  {
    key: 'status_quo',
    label: 'Status Quo',
    about: 'either',
    description: 'How they work today: the current tools, vendor, process, or stack they have in place.',
    example: 'Acme runs outbound on Apollo and Instantly today.',
  },
  {
    key: 'goal',
    label: 'Goal',
    about: 'either',
    description: 'An initiative, priority, or outcome they are trying to achieve.',
    example: 'Wants to consolidate enrichment vendors before end of Q3.',
  },
  {
    key: 'pain',
    label: 'Pain',
    about: 'either',
    description: 'A stated problem or frustration, with the concrete reason why.',
    example: "Clay's list-building is bottlenecked by manual work.",
  },
  {
    key: 'objection',
    label: 'Objection',
    about: 'either',
    description: 'A concern, pushback, or challenge to us — price, security, timing, switching cost, competitor loyalty, or skepticism that we are meaningfully different from the alternatives. Applies even when the person is a peer or advisor, not a buyer.',
    example: 'Questioned how we differ from memory tools like Fireflies that already sync notes to the CRM.',
  },
  {
    key: 'authority',
    label: 'Authority',
    about: 'person',
    description: 'Buying role and decision power: champion, blocker, economic buyer, or end user.',
    example: 'Owns the GTM-tooling budget; spend over $50k needs VP sign-off.',
  },
  {
    key: 'budget',
    label: 'Budget',
    about: 'either',
    description: 'Budget size, procurement process, or a commercial constraint.',
    example: 'Has roughly $30k a year earmarked for GTM data tooling.',
  },
  {
    key: 'timeline',
    label: 'Timeline',
    about: 'either',
    description: 'A buying or project timeline tied to a business reason. Never a meeting time.',
    example: 'Evaluating vendors this quarter, driven by a budget review.',
  },
  {
    key: 'preference',
    label: 'Preference',
    about: 'person',
    description: 'How to work with them: channel, cadence, communication style, or format.',
    example: 'Strongly prefers tools with a native API over no-code builders.',
  },
  {
    key: 'competitor',
    label: 'Competitor',
    about: 'either',
    description: 'A competing tool they use or evaluated, why, and how loyal they are to it.',
    example: 'Currently on Clay and frustrated with its pricing at scale.',
  },
  {
    // How the relationship began. Its own category because a content-led / inbound
    // GTM lives or dies on knowing WHICH content, channel, or referral actually
    // brought a real person in — that is the feedback loop, and it has no home in
    // any "what they are/do" category. About the RELATIONSHIP, not the prospect's
    // own world.
    key: 'discovery',
    label: 'Discovery',
    about: 'person',
    description: 'How this relationship began — the content, channel, post, referral, or event that brought them to us, and why they reached out. The origin of the relationship, not a fact about their own company.',
    example: 'Found us through our YouTube video on open-source GTM and reached out on LinkedIn.',
  },
  {
    // Key stays 'relationship' (existing claims are tagged with it); the label is
    // "Connections" because this is the network layer — who they know, who they run
    // with, the shared/mutual contacts that open a warm path. Named people captured
    // here also feed the graph as KNOWS/WORKS_WITH edges (see extractGraphEdgesBatch),
    // which is what turns "he mentioned Georgi" into "Georgi is a common connection".
    key: 'relationship',
    label: 'Connections',
    about: 'person',
    description: 'A durable connection to another person or org — reports-to, referred-by, a shared or mutual connection, a community they run or belong to, a specific person they name knowing, OR an offer to introduce or connect us to specific people, communities, or organizations.',
    example: 'Offered to introduce us to seed- and YC-stage founders in his network.',
  },
  {
    key: 'general',
    label: 'General',
    about: 'either',
    description: 'Durable, decision-relevant context that fits none of the above.',
    example: 'Plans to hire 2 SDRs once the team passes $50k MRR.',
  },
];

export const CLAIM_CATEGORY_KEYS: string[] = CLAIM_CATEGORIES.map(c => c.key);

const KEY_SET = new Set(CLAIM_CATEGORY_KEYS);

// Legacy and natural-language aliases mapped onto the canonical keys, so old
// rows (Title-Case labels) and loose LLM output still normalize cleanly.
const ALIASES: Record<string, string> = {
  'pain points': 'pain',
  'painpoints': 'pain',
  'painpoint': 'pain',
  'objections': 'objection',
  'concern': 'objection',
  'pushback': 'objection',
  'discovered': 'discovery',
  'origin': 'discovery',
  'inbound': 'discovery',
  'found us': 'discovery',
  'source': 'discovery',
  'intro': 'relationship',
  'introduction': 'relationship',
  'offer': 'relationship',
  'preferences': 'preference',
  'relationships': 'relationship',
  'connection': 'relationship',
  'connections': 'relationship',
  'network': 'relationship',
  'networking': 'relationship',
  'knows': 'relationship',
  'mutual': 'relationship',
  'budgets': 'budget',
  'timelines': 'timeline',
  'competitors': 'competitor',
  'competition': 'competitor',
  'goals': 'goal',
  'initiative': 'goal',
  'initiatives': 'goal',
  'status quo': 'status_quo',
  'current state': 'status_quo',
  'current stack': 'status_quo',
  'stack': 'status_quo',
  'tools': 'status_quo',
  'role': 'authority',
  'buying role': 'authority',
};

/** Coerce any input to a canonical category key. Unknown values fall back to 'general'. */
export function normalizeClaimCategory(input?: string | null): string {
  if (!input) return 'general';
  const raw = String(input).trim().toLowerCase();
  if (KEY_SET.has(raw)) return raw;
  const underscored = raw.replace(/\s+/g, '_');
  if (KEY_SET.has(underscored)) return underscored;
  if (ALIASES[raw]) return ALIASES[raw];
  return 'general';
}

/** Coerce any input to a canonical `about` value. Defaults to 'person'. */
export function normalizeClaimAbout(input?: string | null): 'person' | 'company' {
  return String(input ?? '').trim().toLowerCase() === 'company' ? 'company' : 'person';
}

export function isValidClaimCategory(input?: string | null): boolean {
  return !!input && KEY_SET.has(String(input).trim().toLowerCase());
}

export function claimCategoryLabel(key: string): string {
  return CLAIM_CATEGORIES.find(c => c.key === key)?.label ?? 'General';
}

/**
 * The category block injected into the extractor prompt, generated from the
 * taxonomy so the prompt and the validator never drift. One line per category:
 * `- key — description e.g. "example"`.
 */
export function claimCategoryPromptBlock(): string {
  return CLAIM_CATEGORIES.map(c => `- ${c.key} — ${c.description} e.g. "${c.example}"`).join('\n');
}
