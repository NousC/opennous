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
export interface Stakeholder { entity_id: string; name: string | null; role: string | null; }

export interface AssembledContext {
  entity: { id: string; type: string };
  intent: ContextIntent;
  summary: string;
  claims: ContextClaim[];
  workspace: ContextClaim[];
  timeline: TimelineItem[];
  stakeholders: Stakeholder[];
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
  const rankClaims = usefulClaims.filter(c => !c.property.startsWith('note.'));

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
  const events   = inWindow.length >= MIN_TIMELINE_EVENTS
    ? inWindow
    : observations.slice(0, Math.max(inWindow.length, MIN_TIMELINE_EVENTS));
  // Collapse one meeting seen by two connectors (webhook + calendar mirror).
  const timeline = compressTimeline(collapseMeetingDupes(events));

  // connect: stakeholders via the relationship graph
  const stakeholders = recipe.stakeholders === 'none'
    ? []
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
    claims: claimsOut, workspace: workspaceClaims, timeline, stakeholders, predictions, documents, facts,
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

async function loadStakeholders(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  depth: 'direct' | 'buying_group',
): Promise<Stakeholder[]> {
  // the company this entity works at
  const { data: outRels } = await supabase
    .from('relationships')
    .select('to_entity_id')
    .eq('workspace_id', workspaceId)
    .eq('from_entity_id', entityId)
    .eq('type', 'works_at')
    .is('valid_to', null);
  const companyId = (outRels ?? [])[0]?.to_entity_id as string | undefined;
  if (!companyId) return [];

  let colleagueIds: string[] = [];
  if (depth === 'buying_group') {
    const { data: inRels } = await supabase
      .from('relationships')
      .select('from_entity_id')
      .eq('workspace_id', workspaceId)
      .eq('to_entity_id', companyId)
      .eq('type', 'works_at')
      .is('valid_to', null)
      .limit(12);
    colleagueIds = (inRels ?? []).map(r => r.from_entity_id as string).filter(id => id !== entityId);
  }

  const ids = [companyId, ...colleagueIds];
  const { data: claimRows } = await supabase
    .from('claims')
    .select('entity_id, property, value')
    .eq('workspace_id', workspaceId)
    .in('entity_id', ids)
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

  const stakeholders: Stakeholder[] = [
    { entity_id: companyId, name: nameOf(companyId), role: 'company' },
  ];
  for (const id of colleagueIds) {
    const role = byEntity.get(id)?.job_title;
    stakeholders.push({ entity_id: id, name: nameOf(id), role: (role as string) ?? 'contact' });
  }
  return stakeholders;
}

function buildSummary(
  type: string, claims: ContextClaim[], eventCount: number, intent: ContextIntent,
): string {
  const title = claims.find(c => c.property === 'job_title')?.value;
  const head = [type, title ? String(title) : null].filter(Boolean).join(' · ');
  return `${head} — ${claims.length} known facts, ${eventCount} recent touchpoints. ` +
         `Context assembled for intent: ${intent}.`;
}
