import type { SupabaseClient } from '@supabase/supabase-js';
import { getClaims } from './db/claims.js';
import { getObservations, type Observation } from './db/observations.js';
import { collapseMeetingDupes } from './db/activities.js';
import { listNotes } from './db/notes.js';
import type { ReadContext } from './db/readContext.js';

// The Context API's assembly layer. assembleContext() runs the pipeline —
// retrieve → rank → connect → compress → tag → budget — and returns an
// intent-shaped, epistemics-tagged context block for one entity.
// See docs/context-api-spec.md.

export type ContextIntent =
  | 'draft_email' | 'follow_up' | 'meeting_prep' | 'call_prep' | 'account_review';

interface Recipe {
  themes: string[];                          // property substrings to rank up; [] = no preference
  timelineWindowDays: number;
  stakeholders: 'none' | 'direct' | 'buying_group';
  includePredictions: boolean;
  budgetTokens: number;
}

// Intent recipes — declarative. A new intent is a new entry, not new pipeline code.
const RECIPES: Record<ContextIntent, Recipe> = {
  draft_email: {
    themes: ['industry', 'employee_count', 'seniority', 'department', 'job_title', 'tech_stack', 'icp'],
    timelineWindowDays: 90, stakeholders: 'direct', includePredictions: true, budgetTokens: 1200,
  },
  follow_up: {
    // Follow-up is most often used precisely BECAUSE a contact has gone
    // quiet — a 30-day window was too narrow (a 37-day-silent prospect would
    // return zero timeline events). 90d matches account_review; the
    // minimum-N fallback below ensures we still surface the last few touches
    // even when the contact has been silent longer than the window.
    themes: ['deal', 'note', 'objection', 'commitment', 'timing', 'budget', 'job_title'],
    timelineWindowDays: 90, stakeholders: 'buying_group', includePredictions: true, budgetTokens: 1500,
  },
  meeting_prep: {
    themes: ['deal', 'note', 'job_title', 'seniority', 'timing'],
    timelineWindowDays: 60, stakeholders: 'buying_group', includePredictions: true, budgetTokens: 1800,
  },
  call_prep: {
    themes: ['deal', 'note', 'job_title', 'seniority', 'timing'],
    timelineWindowDays: 60, stakeholders: 'buying_group', includePredictions: true, budgetTokens: 1800,
  },
  account_review: {
    themes: [], timelineWindowDays: 90, stakeholders: 'buying_group', includePredictions: true, budgetTokens: 2000,
  },
};

export const CONTEXT_INTENTS = Object.keys(RECIPES) as ContextIntent[];

const DAY = 86_400_000;

// Legacy v1 columns that were claim-ified during the Phase-4 cutover and now
// leak into the agent-facing context as stale zeros and "manual"/"none"
// constants. They're not facts an agent should reason on — surfacing
// `interaction_count: 0` next to 19 real LinkedIn messages was actively
// misleading the model. They stay in the substrate (claims_total still
// counts them); we just don't expose them to /v2/context consumers.
const LEGACY_CONTEXT_NOISE = new Set([
  'interaction_count',
  'incoming_contacts_count',
  'total_documents_count',
  'total_income_source',
  'enrichment_status',
  'channels',
  'tags',
  'pipeline_stage_source',
  'pipeline_stage_updated_at',
  'first_seen_at',
  'source',
  'deal_health_score',          // stale 0 by default until the score worker fills it
]);

export interface ContextClaim {
  property: string; value: unknown; confidence: number;
  freshness: string; epistemic_class: string; last_observed_at: string | null;
}
export interface TimelineItem {
  when: string; type: string; tier: 'full' | 'brief' | 'count';
  summary?: string | null; count?: number;
}
export interface Stakeholder {
  entity_id: string;
  name: string | null;
  role: string | null;                 // job title
  committee_role?: string | null;      // champion | economic_buyer | decision_maker | blocker | technical | contact
  engaged?: boolean;                   // do we have any interaction with them
  confirmed?: boolean;                 // works_at (true) vs mention-derived / unconfirmed (false)
  relationships?: string[];            // human-readable, e.g. "reports to Michael", "owns the budget"
}

// The account's buying committee, read as a structure (who + how they relate + where
// the gaps are) rather than a flat colleague list — so the agent reasons about the
// whole account, not one person.
export interface Committee {
  company: string | null;
  size: number;                        // people we know of at the account (incl. the focal person)
  engaged: number;                     // how many of them we've actually talked to
  single_threaded: boolean;            // known colleagues exist but only the focal person is engaged
  has_engaged_decision_maker: boolean; // is an economic-buyer/decision-maker actually in the conversation
  champion: string | null;
  gaps: string[];                      // next-move flags: "single-threaded", "no economic buyer engaged"
}

export interface AssembledContext {
  entity: { id: string; type: string };
  intent: ContextIntent;
  summary: string;
  claims: ContextClaim[];
  workspace: ContextClaim[];
  timeline: TimelineItem[];
  stakeholders: Stakeholder[];
  committee: Committee | null;
  predictions: { kind: string; value: unknown; confidence: number }[];
  /** Long-form documents kept on the contact (meeting briefs, notes, transcripts).
   *  Compact list only — fetch a full body with get_account. */
  documents: { type: string; title: string | null; date: string | null; snippet: string }[];
  /** Atomic facts — the account's durable, decision-relevant memory (note.*
   *  asserted claims, newest first). Surfaced as a clean section so the agent
   *  reads them inline instead of from opaque note.<uuid> claims. */
  facts: { category: string; content: string; date: string | null }[];
  meta: { token_estimate: number; claims_total: number; claims_returned: number; timeline_events: number };
}

// ── pipeline ─────────────────────────────────────────────────────────────────

export async function assembleContext(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  intent: ContextIntent = 'account_review',
  budgetTokens?: number,
  ctx?: ReadContext,
): Promise<AssembledContext | null> {
  const recipe = RECIPES[intent] ?? RECIPES.account_review;
  const budget = budgetTokens ?? recipe.budgetTokens;

  const { data: entity } = await supabase
    .from('entities').select('id, type')
    .eq('id', entityId).eq('workspace_id', workspaceId).maybeSingle();
  if (!entity) return null;

  // ctx scopes the raw timeline + documents to the viewer; claims stay shared.
  const [claims, observations, notes] = await Promise.all([
    getClaims(supabase, workspaceId, entityId),
    getObservations(supabase, workspaceId, entityId, { kind: 'event', limit: 300 }, ctx),
    listNotes(supabase, workspaceId, { entityId, limit: 100 }, ctx),
  ]);

  // workspace-level grounding — the agent's own ICP / product / positioning,
  // held as claims on the workspace entity. get_context self-grounds; there
  // is no separate "get_memories" call.
  const { data: wsEntity } = await supabase
    .from('entities').select('id')
    .eq('workspace_id', workspaceId).eq('type', 'workspace').maybeSingle();
  const wsRaw = wsEntity ? await getClaims(supabase, workspaceId, wsEntity.id) : [];
  const workspaceClaims: ContextClaim[] = wsRaw.map(c => ({
    property: c.property, value: c.value, confidence: c.confidence,
    freshness: c.freshness, epistemic_class: c.epistemic_class,
    last_observed_at: c.last_observed_at,
  }));

  // Drop legacy v1 bookkeeping claims before ranking — see LEGACY_CONTEXT_NOISE.
  const usefulClaims = claims.filter(c => !LEGACY_CONTEXT_NOISE.has(c.property));

  // Documents (briefs / notes / transcripts) and atomic facts both come from the
  // notes layer, read via listNotes — which returns ACTIVE notes only. The raw
  // claim stream (getClaims) still contains soft-deleted note.* rows, so deriving
  // facts from it would resurface purged/deduped facts. Full bodies would blow the
  // budget, so documents are a compact list (agent fetches a full body with
  // get_account); all note.* claims are dropped from the ranked-claim stream.
  const documents = notes
    .filter(n => (n.metadata as { doc_type?: string })?.doc_type)
    .map(n => {
      const meta = n.metadata as { doc_type?: string; title?: string; date?: string };
      const text = String(n.content ?? '').replace(/\s+/g, ' ').trim();
      return {
        type: meta.doc_type ?? 'note',
        title: meta.title ?? null,
        date: meta.date ?? n.created_at ?? null,
        snippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
      };
    })
    .sort((a, b) => +new Date(b.date ?? 0) - +new Date(a.date ?? 0))
    .slice(0, 8);
  const facts = notes
    .filter(n => !(n.metadata as { doc_type?: string })?.doc_type && n.content.trim())
    .map(n => ({ category: n.category, content: n.content, date: n.created_at }))
    .slice(0, 15);
  const rankClaims = usefulClaims.filter(c => {
    if (c.property.startsWith('note.')) return false;
    // An action item that's been closed (a booked meeting discharged the "schedule
    // a chat", the deck was sent) is no longer live work — don't surface it as an
    // open task in a brief or context read. Only status:'open' items are current.
    if (c.property.startsWith('action_item.')) {
      const status = (c.value as { status?: string } | null)?.status ?? 'open';
      return status === 'open';
    }
    return true;
  });

  // rank claims: on-theme first, then confidence, then recency — then budget-cap
  const ranked = [...rankClaims].sort((a, b) => {
    const t = themeRank(a.property, recipe.themes) - themeRank(b.property, recipe.themes);
    if (t !== 0) return t;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return +new Date(b.last_observed_at ?? 0) - +new Date(a.last_observed_at ?? 0);
  });
  const maxClaims = Math.max(6, Math.floor((budget * 0.5) / 25));   // ~25 tokens/claim
  const claimsOut: ContextClaim[] = ranked.slice(0, maxClaims).map(c => ({
    property: c.property, value: c.value, confidence: c.confidence,
    freshness: c.freshness, epistemic_class: c.epistemic_class,
    last_observed_at: c.last_observed_at,
  }));

  // timeline: window + temporal tiering, with a minimum-N safety net.
  //
  // If a contact has been silent longer than the recipe's window, a naive
  // filter would return zero events and the agent would infer "never been
  // touched" — even when the substrate holds 19 real interactions. The
  // freshness epistemic on each timeline item already tells the agent how
  // stale a touch is; the agent doesn't need us to censor by age too.
  //
  // Rule: keep everything in the window, AND backfill from the most-recent
  // observations until we have at least MIN_TIMELINE_EVENTS (or run out).
  // Observations are returned newest-first by getObservations, so slice()
  // gives us the most recent.
  const MIN_TIMELINE_EVENTS = 8;
  const cutoff   = Date.now() - recipe.timelineWindowDays * DAY;
  const inWindow = observations.filter(o => +new Date(o.observed_at) >= cutoff);
  const windowed = inWindow.length >= MIN_TIMELINE_EVENTS
    ? inWindow
    : observations.slice(0, Math.max(inWindow.length, MIN_TIMELINE_EVENTS));
  // High-signal lifecycle events (meetings, calls, demos, signups, connection,
  // positive replies) must ALWAYS surface — even outside the window or crowded out by
  // a burst of chat. A meeting held last month is exactly what the next reply needs to
  // know, yet a naive window drops it. Merge them in, dedupe by id, keep newest-first.
  const NOTABLE_EVENT = /meeting|call|demo|sign(ed)?_?up|invite_accepted|linkedin_connected|positive_reply|welcome/i;
  const notable = observations.filter(o => NOTABLE_EVENT.test(String(o.property || '')));
  const byId = new Map<string, typeof observations[number]>();
  for (const o of [...notable, ...windowed]) if (o?.id) byId.set(o.id, o);
  const events = [...byId.values()].sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at));
  // Collapse one meeting seen by two connectors (webhook + calendar mirror).
  const timeline = compressTimeline(collapseMeetingDupes(events));

  // connect: the buying committee — who else is at the account and how they relate
  const { stakeholders, committee } = recipe.stakeholders === 'none'
    ? { stakeholders: [] as Stakeholder[], committee: null }
    : await loadStakeholders(supabase, workspaceId, entityId, recipe.stakeholders);

  // predictions (open only)
  let predictions: AssembledContext['predictions'] = [];
  if (recipe.includePredictions) {
    const { data } = await supabase
      .from('predictions')
      .select('kind, predicted_value, predicted_confidence')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId)
      .is('resolved_at', null)
      .order('predicted_at', { ascending: false }).limit(5);
    predictions = (data ?? []).map(p => ({
      kind: p.kind, value: p.predicted_value, confidence: p.predicted_confidence,
    }));
  }

  const result: AssembledContext = {
    entity: { id: entity.id, type: entity.type },
    intent,
    summary: buildSummary(entity.type, claimsOut, events.length, intent),
    claims: claimsOut, workspace: workspaceClaims, timeline, stakeholders, committee, predictions, documents, facts,
    meta: {
      token_estimate: 0,
      claims_total: claims.length, claims_returned: claimsOut.length,
      timeline_events: events.length,
    },
  };
  result.meta.token_estimate = Math.ceil(JSON.stringify(result).length / 4);
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function themeRank(property: string, themes: string[]): number {
  if (themes.length === 0) return 0;
  return themes.some(t => property.includes(t)) ? 0 : 1;   // 0 = on-theme, sorts first
}

function compressTimeline(events: Observation[]): TimelineItem[] {
  const now = Date.now();
  const items: TimelineItem[] = [];
  const olderCounts: Record<string, number> = {};
  for (const o of events) {
    const age = now - +new Date(o.observed_at);
    const type = (o.property || '').replace(/^interaction\./, '');
    if (age < 7 * DAY) {
      const v = o.value as { description?: string; summary?: string } | null;
      items.push({ when: o.observed_at, type, tier: 'full', summary: v?.description || v?.summary || null });
    } else if (age < 30 * DAY) {
      items.push({ when: o.observed_at, type, tier: 'brief' });
    } else {
      olderCounts[type] = (olderCounts[type] || 0) + 1;
    }
  }
  for (const [type, count] of Object.entries(olderCounts)) {
    items.push({ when: '', type, tier: 'count', count });
  }
  return items;
}

// Committee-internal relationships we read from the graph edges to give each member
// a role and a one-line "how they relate". Kept in step with extractGraphEdgesBatch.
const COMMITTEE_RELS = new Set([
  'REPORTS_TO', 'DEFERS_TO_TECHNICAL', 'DEFERS_TO_BUDGET',
  'DECISION_MAKER_AT', 'BUDGET_HOLDER_AT', 'CHAMPIONS', 'BLOCKS', 'EVALUATING',
]);
const DM_TITLE = /founder|co-?founder|ceo|owner|chief|president|\bvp\b|vice president|head of|director|partner|principal|cxo|coo|cfo|cmo|cto/i;

async function loadStakeholders(
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
      (relsByPerson.get(subj) ?? relsByPerson.set(subj, []).get(subj)!).push(phrase[rel] ?? rel.toLowerCase());
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
  const has_engaged_decision_maker = buyers.some(id => id === entityId ? engaged.has(id) || true : engaged.has(id));
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

function buildSummary(
  type: string, claims: ContextClaim[], eventCount: number, intent: ContextIntent,
): string {
  const title = claims.find(c => c.property === 'job_title')?.value;
  const head = [type, title ? String(title) : null].filter(Boolean).join(' · ');
  return `${head} — ${claims.length} known facts, ${eventCount} recent touchpoints. ` +
         `Context assembled for intent: ${intent}.`;
}
