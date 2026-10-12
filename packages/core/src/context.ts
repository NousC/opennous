import type { SupabaseClient } from '@supabase/supabase-js';
import { getClaims, type Freshness } from './db/claims.js';
import { shapeContextFacts, type TechStackGroup, type Replacement } from './db/claimTime.js';
import { getObservations, type Observation } from './db/observations.js';
import { collapseMeetingDupes } from './db/activities.js';
import { listDealScopeNotes, listRecentlyReplaced } from './db/notes.js';
import { documentPreviews } from './db/documents.js';
import type { ReadContext } from './db/readContext.js';
import { loadBuyingCommittee, type Stakeholder, type Committee } from './services/committee.js';

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
  property: string; value: unknown;
  /** Present ONLY when there is something to flag — see slimClaim. A claim given as just
   *  property + value is observed, current and confident. */
  confidence?: number; freshness?: string; basis?: string; since?: string;
}

// A context claim, at the size it is worth. Same rule as compressClaims in evidence.ts: a
// claim that is current, confident and observed is just its property and value — the four
// metadata fields say nothing in that case and cost ~20 tokens each time. A claim with
// something wrong with it carries exactly what is wrong. Measured on real traffic, claims
// were the single biggest line in a get_account payload; get_context ships them too.
const CONTEXT_LOW_CONFIDENCE = 0.5;

function slimClaim(c: {
  property: string; value: unknown; confidence: number;
  freshness: string; epistemic_class: string; last_observed_at: string | null;
}): ContextClaim {
  const out: any = { property: c.property, value: c.value };
  let flagged = false;
  if (typeof c.confidence === 'number' && c.confidence < CONTEXT_LOW_CONFIDENCE) {
    out.confidence = Math.round(c.confidence * 100) / 100; flagged = true;
  }
  if (c.freshness && c.freshness !== 'fresh') { out.freshness = c.freshness; flagged = true; }
  if (c.epistemic_class && c.epistemic_class !== 'observed') { out.basis = c.epistemic_class; flagged = true; }
  // The date only, and only when something is already off — "when" is noise on a current fact.
  if (flagged && c.last_observed_at) out.since = String(c.last_observed_at).slice(0, 10);
  return out as ContextClaim;
}

export interface TimelineItem {
  when: string; type: string; tier: 'full' | 'brief' | 'count';
  summary?: string | null; count?: number;
  /** On a company read, whose interaction this was (an id in `stakeholders`). */
  entity_id?: string;
}
export interface ContextFact {
  category: string; content: string;
  /** When it was SAID (the source's date), not when it was written (GET-770). */
  date: string | null;
  /** How current it is now, from what it is and when it was said (claimTime.ts). */
  freshness: Freshness;
  /** The verbatim line that produced this fact, and who said it. Absent on
   *  facts with nothing quotable (attendee lists, CRM fields) and on every
   *  fact recorded before evidence capture shipped. */
  quote?: string; speaker?: string; source?: string;
  /** A blocker's status (open | resolved), and a tech_stack fact's tool (GET-798). */
  status?: string; tool?: string;
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
  facts: ContextFact[];
  /** Where the DEAL stands right now (GET-770, GET-798): the newest fresh-or-aging fact per deal
   *  topic (DEAL_POSITION_CATEGORIES) plus every open blocker and live requirement, read across
   *  the account (a person's read includes their company's). Lead with this; `facts` is the rest,
   *  current-first, and older facts are history rather than news. */
  current_position: ContextFact[];
  /** The stack, one entry per tool: its dated facts and the newest one as the summary (GET-798). */
  tech_stack: TechStackGroup<ContextFact>[];
  /** Claims a newer claim replaced in the last 60 days, newest first, both sides readable (GET-798). */
  recently_replaced: Replacement[];
  meta: {
    token_estimate: number; claims_total: number; claims_returned: number;
    /** How many facts the account HAS, vs how many this read returned. When they differ the
     *  caller is looking at a window, not the record — say so rather than letting the gap read
     *  as absence (GET-371). */
    facts_total: number; facts_returned: number;
    timeline_events: number;
  };
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

  // ctx scopes the raw timeline + documents to the viewer, and drops what was derived from a
  // message they can't read (GET-253).
  // The notes are the deal scope (GET-798): a person's own plus their company's deal and stack
  // facts; a company's own plus its people's deal facts. Documents stay the entity's own.
  const [claims, observations, scope] = await Promise.all([
    getClaims(supabase, workspaceId, entityId, ctx),
    entity.type === 'company'
      ? accountObservations(supabase, workspaceId, entityId, ctx)
      : getObservations(supabase, workspaceId, entityId, { kind: 'event', limit: 300 }, ctx),
    listDealScopeNotes(supabase, workspaceId, entity, { limit: 100 }, ctx),
  ]);
  const notes = scope.own;

  // workspace-level grounding — the agent's own ICP / product / positioning,
  // held as claims on the workspace entity. get_context self-grounds; there
  // is no separate "get_memories" call.
  const { data: wsEntity } = await supabase
    .from('entities').select('id')
    .eq('workspace_id', workspaceId).eq('type', 'workspace').maybeSingle();
  const wsRaw = wsEntity ? await getClaims(supabase, workspaceId, wsEntity.id, ctx) : [];
  //
  // This block is meant to be GROUNDING — the company's ICP, product and positioning — and
  // it had no filter and no cap, which made it the single biggest thing in a get_context
  // payload: thousands of tokens, most of the call. Measured on a real workspace, all but one
  // of its claims were `note.*` (saved briefs and documents, one of them thousands of tokens on
  // its own) and exactly ONE was a grounding fact.
  //
  // The entity claim stream already decided this question: notes are dropped from it and
  // surfaced as documents with a 200-character snippet, because a saved document is
  // something to know EXISTS, not something to re-read on every call. The same reasoning
  // applies here, so the same treatment does — but bounded rather than dropped, because
  // losing grounding is worse than paying for it. Detail is deferred, not discarded: the
  // agent can read any of them in full through the tools that own documents.
  const WS_CLAIM_CAP = 12;
  const WS_VALUE_PREVIEW = 300;
  const previewValue = (v: unknown): unknown =>
    typeof v === 'string' && v.length > WS_VALUE_PREVIEW
      ? `${v.slice(0, WS_VALUE_PREVIEW)}… [truncated — read the document in full if you need it]`
      : v;

  const workspaceClaims: ContextClaim[] = wsRaw
    .filter(c => !LEGACY_CONTEXT_NOISE.has(c.property))
    // Real grounding first; a saved note is only worth its headline here.
    .sort((a, b) => Number(a.property.startsWith('note.')) - Number(b.property.startsWith('note.')))
    .slice(0, WS_CLAIM_CAP)
    .map(c => ({ ...slimClaim(c), value: previewValue(c.value) }));

  // Drop legacy v1 bookkeeping claims before ranking — see LEGACY_CONTEXT_NOISE.
  const usefulClaims = claims.filter(c => !LEGACY_CONTEXT_NOISE.has(c.property));

  // Documents (briefs / notes / transcripts) and atomic facts both come from the
  // notes layer, read via listNotes — which returns ACTIVE notes only. The raw
  // claim stream (getClaims) still contains soft-deleted note.* rows, so deriving
  // facts from it would resurface purged/deduped facts. Full bodies would blow the
  // budget, so documents are a compact list (agent fetches a full body with
  // get_account); all note.* claims are dropped from the ranked-claim stream.
  const written = await documentPreviews(supabase, workspaceId, entityId).catch(() => []);
  const documents = [
    // The documents the agent wrote (GET-197) live in `documents`, not in notes.
    ...written,
    ...notes
      .filter(n => (n.metadata as { doc_type?: string })?.doc_type)
      .map(n => {
        const meta = n.metadata as { doc_type?: string; title?: string; date?: string };
        const text = String(n.content ?? '').replace(/\s+/g, ' ').trim();
        return {
          type: meta.doc_type ?? 'note',
          title: meta.title ?? null,
          date: meta.date ?? n.created_at ?? null,
          snippet: text.length > 200 ? text.slice(0, 200) + '…' : text,
          document_id: n.id,
        };
      }),
  ]
    .sort((a, b) => +new Date(b.date ?? 0) - +new Date(a.date ?? 0))
    .slice(0, 10);
  const eligibleFacts = [...notes, ...scope.related]
    // Facts, not bookkeeping: documents, health summaries and speaker-link notes live on the
    // same shelf and are not facts (GET-417, isIntelClaim).
    .filter(n => n.intel !== false && !(n.metadata as { doc_type?: string })?.doc_type && n.content.trim())
    .map(n => {
      const m = (n.metadata ?? {}) as {
        quote?: string; speaker?: string; extraction_source?: string; status?: string; tool?: string;
      };
      return {
        category: n.category, content: n.content, date: n.created_at,
        ...(m.quote ? { quote: m.quote } : {}),
        ...(m.speaker ? { speaker: m.speaker } : {}),
        ...(m.extraction_source ? { source: m.extraction_source } : {}),
        ...(n.category === 'blocker' && m.status ? { status: m.status } : {}),
        ...(n.category === 'tech_stack' && m.tool ? { tool: m.tool } : {}),
      };
    });
  // Newest 15, because a read has a token budget. The TOTAL travels with them, because a
  // truncation that does not announce itself reads as absence: an agent filed 21 facts, read
  // the account back to check, could not find three of them, concluded the write had been
  // refused, and refiled those three under fresh external_ids — two permanent duplicates on a
  // live account, and there is no delete tool (GET-371).
  // Current-first, not newest-written (GET-770): a fact is ordered by how current it is (its
  // category's clock against when it was said), and the current position per topic leads.
  // GET-798: the position is the DEAL's (every open blocker and live requirement), the stack is
  // grouped by tool, and `facts` is the rest, so nothing shown above is paid for twice.
  const { facts, current_position, tech_stack, total: factsTotal } = shapeContextFacts(eligibleFacts, { cap: 15 });
  const recently_replaced = await listRecentlyReplaced(supabase, workspaceId, {
    entityId, relatedIds: scope.relatedIds, relatedCategories: scope.relatedCategories,
  }, ctx).catch(() => [] as Replacement[]);
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
  const claimsOut: ContextClaim[] = ranked.slice(0, maxClaims).map(slimClaim);

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
  const timeline = compressTimeline(collapseMeetingDupes(events), entityId);

  // connect: the buying committee — who else is at the account and how they relate
  const { stakeholders, committee } = recipe.stakeholders === 'none'
    ? { stakeholders: [] as Stakeholder[], committee: null }
    : await loadBuyingCommittee(supabase, workspaceId, entityId, recipe.stakeholders, { entityType: entity.type });

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
    claims: claimsOut, workspace: workspaceClaims, timeline, stakeholders, committee, predictions, documents, facts, current_position,
    tech_stack, recently_replaced,
    meta: {
      token_estimate: 0,
      claims_total: claims.length, claims_returned: claimsOut.length,
      facts_total: factsTotal, facts_returned: facts.length,
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

// A company holds no interactions of its own: they are filed on its people. So a company read
// (a domain focus) takes the account's timeline from the people who work there, each read under
// the same viewer scope as everywhere else, newest first, capped like a person read.
async function accountObservations(
  supabase: SupabaseClient, workspaceId: string, companyId: string, ctx?: ReadContext,
): Promise<Observation[]> {
  const { data: rels } = await supabase
    .from('relationships')
    .select('from_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('to_entity_id', companyId)
    .eq('type', 'works_at')
    .is('valid_to', null)
    .limit(25);
  const ids = [companyId, ...new Set((rels ?? []).map(r => r.from_entity_id as string))];
  const lists = await Promise.all(ids.map(id =>
    getObservations(supabase, workspaceId, id, { kind: 'event', limit: id === companyId ? 300 : 60 }, ctx)));
  return lists.flat()
    .sort((a, b) => +new Date(b.observed_at) - +new Date(a.observed_at))
    .slice(0, 300);
}

function compressTimeline(events: Observation[], focusId?: string): TimelineItem[] {
  const now = Date.now();
  const items: TimelineItem[] = [];
  const olderCounts: Record<string, number> = {};
  const who = (o: Observation) => (focusId && o.entity_id && o.entity_id !== focusId ? { entity_id: o.entity_id } : {});
  for (const o of events) {
    const age = now - +new Date(o.observed_at);
    const type = (o.property || '').replace(/^interaction\./, '');
    if (age < 7 * DAY) {
      const v = o.value as { description?: string; summary?: string } | null;
      items.push({ when: o.observed_at, type, tier: 'full', summary: v?.description || v?.summary || null, ...who(o) });
    } else if (age < 30 * DAY) {
      items.push({ when: o.observed_at, type, tier: 'brief', ...who(o) });
    } else {
      olderCounts[type] = (olderCounts[type] || 0) + 1;
    }
  }
  for (const [type, count] of Object.entries(olderCounts)) {
    items.push({ when: '', type, tier: 'count', count });
  }
  return items;
}

function buildSummary(
  type: string, claims: ContextClaim[], eventCount: number, intent: ContextIntent,
): string {
  const title = claims.find(c => c.property === 'job_title')?.value;
  const head = [type, title ? String(title) : null].filter(Boolean).join(' · ');
  return `${head} — ${claims.length} known facts, ${eventCount} recent touchpoints. ` +
         `Context assembled for intent: ${intent}.`;
}
