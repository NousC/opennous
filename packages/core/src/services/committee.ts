import type { SupabaseClient } from '@supabase/supabase-js';
import { readTitle } from './titleRead.js';

// The buying committee, read as a STRUCTURE — who is at the account, how they relate,
// and where the gaps are — so an agent reasons about the whole account, not one
// person. Shared by get_context (context.ts) and get_account (getAccountRecord).

export interface Stakeholder {
  entity_id: string;
  name: string | null;
  role: string | null;                 // job title
  committee_role?: string | null;      // champion | economic_buyer | decision_maker | blocker | technical | contact
  engaged?: boolean;                   // do we have any interaction with them
  confirmed?: boolean;                 // works_at (true) vs mention-derived / unconfirmed (false)
  relationships?: string[];            // human-readable, e.g. "reports to Corin", "owns the budget"
}

export interface Committee {
  company: string | null;
  size: number;                        // people we know of at the account (incl. the focal person)
  engaged: number;                     // how many of them we've actually talked to
  single_threaded: boolean;            // known colleagues exist but only the focal person is engaged
  has_engaged_decision_maker: boolean; // is an economic-buyer/decision-maker actually in the conversation
  champion: string | null;
  gaps: string[];                      // next-move flags: "single-threaded", "no economic buyer engaged"
}

// Committee-internal relationships we read from the graph edges to give each member a
// role and a one-line "how they relate". Kept in step with extractGraphEdgesBatch.
const COMMITTEE_RELS = new Set([
  // Employment is deliberately NOT here. It lives in `relationships` as `works_at`, with
  // valid_from/valid_to, and contacts.company_id is a projection of the current one. Adding a
  // WORKS_AT graph edge would be a second store for one fact, and the two would drift.
  'REPORTS_TO', 'DEFERS_TO_TECHNICAL', 'DEFERS_TO_BUDGET',
  'DECISION_MAKER_AT', 'BUDGET_HOLDER_AT', 'CHAMPIONS', 'BLOCKS', 'EVALUATING',
]);

// ── Roles someone SAID out loud ──────────────────────────────────────────────
//
// titleRead.ts opens by stating the rule: "Anything evidence-based (a CHAMPIONS edge, a
// budget-holder statement) always wins over the title." The edge half was wired. The
// budget-holder statement was not — and `authority` is the one category whose entire
// definition is "Buying role and decision power: champion, blocker, economic buyer, or end
// user". So people had their decision power stated on a call and were still labelled by a
// regex on their job title, or not at all.
//
// The role rides on the claim as `metadata.role`, from the closed set below, for the same
// reason `staff_change` carries `change`: prose cannot be acted on. "Osric Talmadge is the signing
// authority", "Osric signs off on anything over 10k" and "nothing moves without Osric" are one
// fact and three strings — and a regex over them reads "the directors would have to do it"
// as the person in front of it being a decision maker, when the claim says the opposite.
//
// The vocabulary is exactly the set the org chart can badge. A role nothing can display is
// a role nobody will ever act on.
export const COMMITTEE_ROLE_RANK: Record<string, number> = {
  champion: 4, blocker: 3, economic_buyer: 2, decision_maker: 1, technical: 0,
};

/** One rule, so the account API and the committee reader cannot drift apart. */
export function roleFromAuthorityClaims(
  claims: Array<{ value?: any } | null | undefined>,
): string | null {
  let best: string | null = null;
  for (const c of claims) {
    const role = c?.value?.metadata?.role;
    if (typeof role !== 'string' || !(role in COMMITTEE_ROLE_RANK)) continue;
    if (best === null || COMMITTEE_ROLE_RANK[role] > COMMITTEE_ROLE_RANK[best]) best = role;
  }
  return best;
}

export async function loadBuyingCommittee(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  depth: 'direct' | 'buying_group',
  opts: { entityType?: string } = {},
): Promise<{ stakeholders: Stakeholder[]; committee: Committee | null }> {
  // A company read (a domain focus) IS the account: its people are the committee, at any depth,
  // and there is no focal person. A person read starts from the company they work at.
  const companyRead = opts.entityType === 'company';
  let companyId: string | undefined;
  if (companyRead) {
    companyId = entityId;
  } else {
    const { data: outRels } = await supabase
      .from('relationships')
      .select('to_entity_id')
      .eq('workspace_id', workspaceId)
      .eq('from_entity_id', entityId)
      .eq('type', 'works_at')
      .is('valid_to', null);
    companyId = (outRels ?? [])[0]?.to_entity_id as string | undefined;
  }
  if (!companyId) return { stakeholders: [], committee: null };

  // Committee members = confirmed colleagues (works_at) + mention-derived ties
  // (MENTIONED_AT), so a person named in a meeting joins the committee even before
  // enrichment confirms them. `confirmed` distinguishes the two.
  const confirmed = new Map<string, boolean>();
  if (depth === 'buying_group' || companyRead) {
    const { data: inRels } = await supabase
      .from('relationships')
      .select('from_entity_id')
      .eq('workspace_id', workspaceId)
      .eq('to_entity_id', companyId)
      .eq('type', 'works_at')
      .is('valid_to', null)
      .limit(20);
    for (const r of inRels ?? []) {
      const id = r.from_entity_id as string;
      if (id !== entityId) confirmed.set(id, true);
    }
    const { data: mentioned } = await supabase
      .from('workspace_graph_edges')
      .select('subject_id')
      .eq('workspace_id', workspaceId)
      .eq('relationship', 'MENTIONED_AT')
      .eq('object_id', companyId)
      .limit(20);
    for (const e of mentioned ?? []) {
      const id = e.subject_id as string | null;
      if (id && id !== entityId && !confirmed.has(id)) confirmed.set(id, false);
    }
  }
  const colleagueIds = [...confirmed.keys()];
  const people = companyRead ? colleagueIds : [entityId, ...colleagueIds];

  const { data: claimRows } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('entity_id', [companyId, ...people])
    .in('property', ['name', 'first_name', 'last_name', 'job_title']);

  // What someone SAID about each person's decision power. A separate query because these are
  // extracted note.* claims, not the structured ones above.
  const authorityByPerson = new Map<string, string>();
  {
    const { data: authRows } = await supabase
      .from('claims')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId)
      .in('entity_id', people)
      .like('property', 'note.%')
      .is('invalid_at', null)
      .eq('value->>category', 'authority');
    const rowsByPerson = new Map<string, Array<{ value?: any }>>();
    for (const r of authRows ?? []) {
      if (!rowsByPerson.has(r.entity_id)) rowsByPerson.set(r.entity_id, []);
      rowsByPerson.get(r.entity_id)!.push(r);
    }
    for (const [id, rows] of rowsByPerson) {
      const role = roleFromAuthorityClaims(rows);
      if (role) authorityByPerson.set(id, role);
    }
  }

  const byEntity = new Map<string, Record<string, unknown>>();
  for (const c of claimRows ?? []) {
    const m = byEntity.get(c.entity_id) ?? {};
    m[c.property] = c.value;
    byEntity.set(c.entity_id, m);
  }
  const nameOf = (id: string): string | null => {
    const m = byEntity.get(id) ?? {};
    if (m.name) return String(m.name);
    const fn = [m.first_name, m.last_name].filter(Boolean).join(' ');
    return fn || null;
  };

  // Typed relationships among the committee + who we've actually engaged.
  const relsByPerson = new Map<string, string[]>();
  const roleByPerson = new Map<string, string>();
  const engaged = new Set<string>();
  if (people.length) {
    const [{ data: edges }, { data: acts }] = await Promise.all([
      supabase.from('workspace_graph_edges')
        .select('subject_id, relationship, object_id, object_label')
        .eq('workspace_id', workspaceId).in('subject_id', people),
      supabase.from('observations')
        .select('entity_id').eq('workspace_id', workspaceId)
        .like('property', 'interaction.%').in('entity_id', people),
    ]);
    for (const a of acts ?? []) engaged.add(a.entity_id as string);
    for (const e of edges ?? []) {
      const rel = e.relationship as string;
      if (!COMMITTEE_RELS.has(rel)) continue;
      const subj = e.subject_id as string;
      const objName = (e.object_label as string) || (e.object_id ? nameOf(e.object_id as string) : null) || 'the company';
      const phrase: Record<string, string> = {
        REPORTS_TO: `reports to ${objName}`,
        DEFERS_TO_TECHNICAL: `defers to ${objName} technically`,
        DEFERS_TO_BUDGET: `defers to ${objName} on budget`,
        DECISION_MAKER_AT: `decision-maker at ${objName}`,
        BUDGET_HOLDER_AT: `owns the budget at ${objName}`,
        CHAMPIONS: `champions us`,
        BLOCKS: `blocking`,
        EVALUATING: `evaluating`,
      };
      if (!relsByPerson.has(subj)) relsByPerson.set(subj, []);
      relsByPerson.get(subj)!.push(phrase[rel] ?? rel.toLowerCase());
      if (rel === 'CHAMPIONS') roleByPerson.set(subj, 'champion');
      else if (rel === 'BLOCKS') roleByPerson.set(subj, 'blocker');
      else if (rel === 'BUDGET_HOLDER_AT' || rel === 'DEFERS_TO_BUDGET') roleByPerson.set(subj, 'economic_buyer');
      else if (rel === 'DECISION_MAKER_AT' && !roleByPerson.has(subj)) roleByPerson.set(subj, 'decision_maker');
    }
  }
  const committeeRole = (id: string): string => {
    // Two evidence sources, ranked against each other: a CHAMPIONS edge outranks a
    // decision_maker someone mentioned. Only then does the title regex get a turn.
    const fromEdge = roleByPerson.get(id), fromClaim = authorityByPerson.get(id);
    if (fromEdge && fromClaim) {
      return COMMITTEE_ROLE_RANK[fromClaim] > COMMITTEE_ROLE_RANK[fromEdge] ? fromClaim : fromEdge;
    }
    if (fromEdge || fromClaim) return (fromEdge ?? fromClaim)!;
    const fromTitle = readTitle(String(byEntity.get(id)?.job_title ?? "")).role;   // one title rule (titleRead.ts)
    if (fromTitle) return fromTitle;
    return 'contact';
  };

  const stakeholders: Stakeholder[] = [
    { entity_id: companyId, name: nameOf(companyId), role: 'company' },
  ];
  for (const id of colleagueIds) {
    stakeholders.push({
      entity_id: id,
      name: nameOf(id),
      role: (byEntity.get(id)?.job_title as string) ?? null,
      committee_role: committeeRole(id),
      engaged: engaged.has(id),
      confirmed: confirmed.get(id) ?? true,
      relationships: relsByPerson.get(id) ?? [],
    });
  }

  // Committee-health flags — the "what's my next move on this account" layer.
  const engagedColleagues = colleagueIds.filter(id => engaged.has(id));
  const buyers = people.filter(id => ['economic_buyer', 'decision_maker'].includes(committeeRole(id)));
  const championId = people.find(id => committeeRole(id) === 'champion');
  // A person read: the focal person is the one thread, so no engaged colleague is single-threaded.
  // A company read has no focal person: single-threaded is exactly one engaged among several.
  const single_threaded = companyRead
    ? colleagueIds.length > 1 && engagedColleagues.length === 1
    : colleagueIds.length > 0 && engagedColleagues.length === 0;
  const has_engaged_decision_maker = buyers.some(id => (id === entityId ? true : engaged.has(id)));
  const gaps: string[] = [];
  if (single_threaded) gaps.push('single-threaded — only one person engaged; multithread to the committee');
  if (colleagueIds.length > 0 && buyers.filter(id => engaged.has(id) || id === entityId).length === 0) {
    gaps.push('no economic buyer / decision-maker engaged');
  }
  const committee: Committee = {
    company: nameOf(companyId),
    size: people.length,
    engaged: people.filter(id => id === entityId || engaged.has(id)).length,
    single_threaded,
    has_engaged_decision_maker,
    champion: championId ? nameOf(championId) : null,
    gaps,
  };

  return { stakeholders, committee };
}
