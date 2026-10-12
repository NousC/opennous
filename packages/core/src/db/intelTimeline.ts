// The intel timeline (GET-794): an account's facts on a time axis by when they were SAID, in topic
// lanes, with each retired fact linked to the fact that replaced it.
//
// Since GET-770 a claim is never edited in place when the buyer changes position: the old one gets
// `invalid_at` and `metadata.superseded_by`, the new one `metadata.supersedes`. The account page
// otherwise only ever shows the live end of that chain. Here the retired end stays on the chart,
// faded, so "needs another couple of months" → "ready to present to the other stakeholders" reads as
// one line across time. A claim retired with NO successor (a deleted note, a correction) is not
// history of a position and stays off.
//
// Reads go through listNotes, so the member-scope document rule and the derived-fact viewer filter
// (GET-253) apply exactly as they do on listAccountNotes.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReadContext } from './readContext.js';
import { listNotes, type Note } from './notes.js';
import { normalizeClaimCategory, ACCOUNT_ROLLUP_CATEGORIES } from './claimCategories.js';

export interface TimelineLane { key: string; label: string; categories: string[] }

/** Lane order is the chart's top-to-bottom order. */
export const TIMELINE_LANES: readonly TimelineLane[] = [
  { key: 'buying', label: 'Buying signals', categories: ['buying_signal', 'expansion_signal'] },
  { key: 'blockers', label: 'Blockers', categories: ['blocker'] },
  { key: 'objections', label: 'Objections', categories: ['objection'] },
  { key: 'timeline', label: 'Timeline & budget', categories: ['timeline', 'budget', 'requirement'] },
  { key: 'stakeholders', label: 'Stakeholders', categories: ['authority', 'staff_change', 'relationship'] },
  { key: 'tech', label: 'Tech stack', categories: ['tech_stack'] },
  { key: 'risks', label: 'Risks', categories: ['risk_signal'] },
];

const LANE_OF = new Map<string, string>(TIMELINE_LANES.flatMap(l => l.categories.map(c => [c, l.key] as [string, string])));
// A person's facts reach the account in the deal categories, plus the stakeholder moves a lane asks for.
const PEOPLE_CATEGORIES = new Set<string>([...ACCOUNT_ROLLUP_CATEGORIES, ...LANE_OF.keys()]);

export interface TimelineFact {
  id: string;
  category: string;
  lane: string;
  label: string | null;
  content: string;
  said_at: string;
  /** False once retired: drawn faded, as history. */
  live: boolean;
  superseded_by: string | null;
  supersedes: string | null;
  /** A blocker's or objection's status as extracted ('open' | 'resolved' | 'addressed'), else null. */
  status: string | null;
  quote: string | null;
  speaker: string | null;
  /** The contact who voiced it, when known. */
  voiced_by_contact_id: string | null;
  entity_id: string;
}

export interface IntelTimeline {
  lanes: (TimelineLane & { count: number })[];
  /** Oldest first. */
  facts: TimelineFact[];
  /** old → new, only where both ends are on the timeline. */
  links: { from: string; to: string }[];
  /** The window's start, or null for all time. */
  since: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function toFact(n: Note, lane: string, category: string): TimelineFact {
  const m = n.metadata ?? {};
  return {
    id: n.id,
    category,
    lane,
    label: n.label,
    content: n.content,
    said_at: n.said_at,
    live: n.is_active,
    superseded_by: n.superseded_by,
    supersedes: str(m.supersedes),
    status: str(m.status),
    quote: str(m.quote),
    speaker: str(m.speaker),
    voiced_by_contact_id: str(m.voiced_by_contact_id) ?? null,
    entity_id: n.entity_id,
  };
}

export async function accountIntelTimeline(
  supabase: SupabaseClient,
  workspaceId: string,
  companyId: string,
  contactIds: string[],
  opts: { sinceDays?: number | null } = {},
  ctx?: ReadContext,
): Promise<IntelTimeline> {
  const since = opts.sinceDays && opts.sinceDays > 0
    ? new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString()
    : null;
  const base = { includeInactive: true, ...(since ? { since } : {}) };
  // 1000 is PostgREST's row cap; inactive rows ride along, so the company read gets the same room.
  const [own, people] = await Promise.all([
    listNotes(supabase, workspaceId, { ...base, entityId: companyId, limit: 1000 }, ctx),
    contactIds.length
      ? listNotes(supabase, workspaceId, { ...base, entityIds: contactIds, limit: 1000 }, ctx)
      : Promise.resolve([] as Note[]),
  ]);

  const facts: TimelineFact[] = [];
  const seen = new Set<string>();
  const take = (n: Note, fromPerson: boolean) => {
    if (seen.has(n.id) || !n.intel || n.metadata?.doc_type) return;
    // Retired with nothing replacing it: a deletion, not a change of position.
    if (!n.is_active && !n.superseded_by) return;
    const category = normalizeClaimCategory(n.category);
    const lane = LANE_OF.get(category);
    if (!lane) return;
    if (fromPerson && !PEOPLE_CATEGORIES.has(category)) return;
    seen.add(n.id);
    const f = toFact(n, lane, category);
    if (fromPerson && !f.voiced_by_contact_id) f.voiced_by_contact_id = n.entity_id;
    facts.push(f);
  };
  for (const n of own) take(n, false);
  for (const n of people) take(n, true);
  facts.sort((a, b) => (a.said_at ?? '').localeCompare(b.said_at ?? ''));

  const ids = new Set(facts.map(f => f.id));
  const linkKeys = new Set<string>();
  const links: { from: string; to: string }[] = [];
  const link = (from: string | null, to: string | null) => {
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) return;
    const k = `${from}>${to}`;
    if (linkKeys.has(k)) return;
    linkKeys.add(k);
    links.push({ from, to });
  };
  for (const f of facts) { link(f.id, f.superseded_by); link(f.supersedes, f.id); }

  const counts = new Map<string, number>();
  for (const f of facts) counts.set(f.lane, (counts.get(f.lane) ?? 0) + 1);
  return {
    lanes: TIMELINE_LANES.map(l => ({ ...l, categories: [...l.categories], count: counts.get(l.key) ?? 0 })),
    facts,
    links,
    since,
  };
}
