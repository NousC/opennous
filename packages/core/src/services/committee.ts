import type { SupabaseClient } from '@supabase/supabase-js';

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
  relationships?: string[];            // human-readable, e.g. "reports to Michael", "owns the budget"
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
  'REPORTS_TO', 'DEFERS_TO_TECHNICAL', 'DEFERS_TO_BUDGET',
  'DECISION_MAKER_AT', 'BUDGET_HOLDER_AT', 'CHAMPIONS', 'BLOCKS', 'EVALUATING',
]);
const DM_TITLE = /founder|co-?founder|ceo|owner|chief|president|\bvp\b|vice president|head of|director|partner|principal|cxo|coo|cfo|cmo|cto/i;

export async function loadBuyingCommittee(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  depth: 'direct' | 'buying_group',
): Promise<{ stakeholders: Stakeholder[]; committee: Committee | null }> {
  // the company this entity works at
  const { data: outRels } = await supabase
    .from('relationships')
    .select('to_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('from_entity_id', entityId)
    .eq('type', 'works_at')
    .is('valid_to', null);
  const companyId = (outRels ?? [])[0]?.to_entity_id as string | undefined;
  if (!companyId) return { stakeholders: [], committee: null };

  // Committee members = confirmed colleagues (works_at) + mention-derived ties
  // (MENTIONED_AT), so a person named in a meeting joins the committee even before
  // enrichment confirms them. `confirmed` distinguishes the two.
  const confirmed = new Map<string, boolean>();
  if (depth === 'buying_group') {
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
  const people = [entityId, ...colleagueIds];

  const { data: claimRows } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('entity_id', [companyId, ...people])
    .in('property', ['name', 'first_name', 'last_name', 'job_title']);

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
    if (roleByPerson.has(id)) return roleByPerson.get(id)!;
    if (DM_TITLE.test(String(byEntity.get(id)?.job_title ?? ''))) return 'decision_maker';
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
  const single_threaded = colleagueIds.length > 0 && engagedColleagues.length === 0;
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
