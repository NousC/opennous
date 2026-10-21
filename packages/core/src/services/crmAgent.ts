// The CRM agent: which deal was this activity about?
//
// Deals are born in the CRM; progress is handled by Nous. When a call, email or message
// Nous ingested itself lands on an account, the account may have several open deals, and
// the CRM will want to know which one the activity belongs to. HubSpot cannot answer that
// (it was not on the call). Nous was. So: rank the open deals on what the activity shows,
// PROPOSE when there is one candidate, ASK when there are several, and stay silent when
// there is nothing to file against. A human answers; the answer is written to the CRM and
// read back as truth. Nothing here ever writes to a CRM on its own.
//
// The decision table (see docs, "One Account, Two Deals"):
//
//   activity came from a CRM             → silent. Mirrored elsewhere; the rep already chose.
//   workspace has not switched the agent on, or the activity predates the CRM baseline
//                                        → silent. History is taken on trust, never questioned.
//   account has no open deal             → silent. The absence of an attribution IS the flag.
//   account has one open deal            → propose it (mode 'confirm'). One click.
//   account has two or more open deals   → rank and ask (mode 'ask'). The real queue.
//
// One question per activity, not per attendee: a meeting logs one observation per person in
// the room, and they all fold into a single decision keyed on the meeting, not the person.
//
// Storage is the decision loop (ri_decisions): the proposal, the human's verdict, and the
// payload carrying the ranked candidates. Every correction a rep makes is therefore a
// labelled example, which is how the ranking gets better on that customer's own answers.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityHook } from '../db/activities.js';
import { notifyCrmPushNow } from '../db/activities.js';
import { proposeDecision, recordVerdict } from '../db/decisions.mjs';
import { linkObservationToDeals } from '../db/observationDeals.js';
import { crmDealState, type CrmDealState } from './dealRollup.js';
import { stageEnteredAt, type DealStageObservation } from '../integrations/crm/index.js';

type HookCtx = Parameters<ActivityHook>[0];

// ─── Ranking (pure) ──────────────────────────────────────────────────────────

export interface DealCandidate {
  dealEntityId: string;
  name: string | null;
  stage: string | null;
  stageId: string | null;
  status: 'open' | 'won' | 'lost' | null;
  value: number | null;
  closeDate: string | null;
  ownerEmail: string | null;
  /** Person entity ids on the deal (stakeholder_of). */
  roster: string[];
  /** Line-item product names on the deal. */
  products: string[];
  lastStageChangeAt: string | null;
}

export interface ActivityForRanking {
  /** Person entity ids the activity involved (attendees, sender). */
  personEntityIds: string[];
  ownerEmail?: string | null;
  /** Title + summary + description, whatever the source gave us. */
  text: string;
  occurredAt?: string | null;
}

export interface RankedDeal {
  dealEntityId: string;
  score: number;
  /** Share of the total signal, so the ranked set sums to 1. */
  confidence: number;
  reasons: string[];
}

export interface RankingResult {
  ranked: RankedDeal[];
  /** True when the top two cannot be told apart, or nothing separated anyone. */
  ambiguous: boolean;
}

const W_ROSTER = 2;      // an attendee sits on this deal
const W_OWNER = 1.5;     // the rep who owns this deal ran the activity
const W_NAME = 2;        // the deal's own name appears in the text
const W_PRODUCT = 1.5;   // a product on the deal appears in the text (capped at two)
const W_RECENCY = 0.5;   // tiebreaker: the deal that moved most recently
const AMBIGUOUS_RATIO = 0.85;
const STOPWORDS = new Set(['deal', 'the', 'and', 'for', 'with', 'new', 'inc', 'llc', 'ltd', 'corp', 'company', 'group']);

const tokens = (s: string | null | undefined): string[] =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));

/** Does `phrase` (multi-word) appear in `text`, token-wise? All of its tokens must be present. */
function phraseIn(phrase: string | null | undefined, textTokens: Set<string>): boolean {
  const ts = tokens(phrase);
  return ts.length > 0 && ts.every(t => textTokens.has(t));
}

export function rankDealCandidates(activity: ActivityForRanking, candidates: DealCandidate[]): RankingResult {
  const open = candidates.filter(c => c.status === 'open' || c.status == null);
  if (!open.length) return { ranked: [], ambiguous: false };

  const people = new Set(activity.personEntityIds);
  const owner = (activity.ownerEmail ?? '').trim().toLowerCase();
  const textTokens = new Set(tokens(activity.text));
  const newestChange = open.reduce<number>((m, c) => Math.max(m, Date.parse(c.lastStageChangeAt ?? '') || 0), 0);

  const scored = open.map(c => {
    let score = 0;
    const reasons: string[] = [];
    if (c.roster.some(p => people.has(p))) { score += W_ROSTER; reasons.push('an attendee is on this deal\'s roster'); }
    if (owner && c.ownerEmail && c.ownerEmail.trim().toLowerCase() === owner) { score += W_OWNER; reasons.push('the deal owner ran this activity'); }
    if (phraseIn(c.name, textTokens)) { score += W_NAME; reasons.push(`the deal name "${c.name}" is mentioned`); }
    const hits = c.products.filter(p => phraseIn(p, textTokens)).slice(0, 2);
    for (const p of hits) { score += W_PRODUCT; reasons.push(`the product "${p}" is mentioned`); }
    const changedAt = Date.parse(c.lastStageChangeAt ?? '') || 0;
    if (newestChange > 0 && changedAt === newestChange && open.length > 1) { score += W_RECENCY; reasons.push('the most recently moved deal'); }
    return { dealEntityId: c.dealEntityId, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const total = scored.reduce((s, x) => s + x.score, 0);
  const ranked: RankedDeal[] = scored.map(x => ({
    ...x,
    confidence: open.length === 1 ? 0.9 : total > 0 ? x.score / total : 1 / open.length,
  }));

  const ambiguous = open.length > 1 && (
    ranked[0].score === 0 ||
    ranked[1].score >= AMBIGUOUS_RATIO * ranked[0].score
  );
  return { ranked, ambiguous };
}

// ─── Loading the candidates ───────────────────────────────────────────────────

const unwrap = (v: unknown): unknown => (v && typeof v === 'object' && 'value' in (v as object)) ? (v as { value: unknown }).value : v;
const str = (v: unknown): string | null => (v == null ? null : String(unwrap(v)));
const num = (v: unknown): number | null => { const n = Number(unwrap(v)); return Number.isFinite(n) ? n : null; };

/**
 * Open/won/lost from the deal's own claims: the provider's verdict first, else the label.
 * crmDealState is the ONE reading of a deal's outcome (the ledger, the Deals UI and the
 * workspace deal list use it too), so this defers to it rather than keeping its own regex.
 */
function statusOf(status: unknown, stage: unknown): DealCandidate['status'] {
  const s = unwrap(status);
  const label = unwrap(stage);
  if ((s == null || s === '') && !label) return null;
  return crmDealState({ status: s == null ? null : String(s), stage: label == null ? null : String(label) });
}

/**
 * Every row of a query, 1000 at a time. PostgREST stops at 1000 without saying so, and an
 * account with a hundred-plus deals has more than 1000 deal claims — the ranker would have seen deals
 * with no name or stage and never known why.
 */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/**
 * Every CRM deal in the workspace, boiled down to which outcomes each account holds:
 * company entity id -> the set of 'open' | 'won' | 'lost' across its deals. The open book reads
 * this so an account whose CRM deals are all closed stops counting as an open deal (GET-835).
 * An account with no CRM deal isn't in the map at all. Outcome is crmDealState, same as the
 * workspace deal list, so a deal is never closed on one screen and open in the forecast.
 */
export async function loadCrmDealStatesByAccount(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, Set<CrmDealState>>> {
  const out = new Map<string, Set<CrmDealState>>();
  const ents = await readAll<{ id: string }>((from, to) => supabase.from('entities').select('id')
    .eq('workspace_id', workspaceId).eq('type', 'deal').order('id').range(from, to));
  const ids = ents.map(e => e.id);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const [claimRows, edges] = await Promise.all([
      readAll<{ entity_id: string; property: string; value: unknown }>((from, to) => supabase.from('claims')
        .select('entity_id, property, value')
        .eq('workspace_id', workspaceId).in('entity_id', batch).in('property', ['status', 'stage']).is('invalid_at', null)
        .order('id').range(from, to)),
      readAll<{ from_entity_id: string; to_entity_id: string }>((from, to) => supabase.from('relationships')
        .select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'belongs_to').in('from_entity_id', batch).is('valid_to', null)
        .order('id').range(from, to)),
    ]);
    const status = new Map<string, string | null>();
    const stage = new Map<string, string | null>();
    for (const c of claimRows) (c.property === 'status' ? status : stage).set(c.entity_id, str(c.value));
    for (const e of edges) {
      // No status and no stage reads as open, like the deal list: missing data never closes a deal.
      const state = crmDealState({ status: status.get(e.from_entity_id) ?? null, stage: stage.get(e.from_entity_id) ?? null });
      (out.get(e.to_entity_id) ?? out.set(e.to_entity_id, new Set()).get(e.to_entity_id)!).add(state);
    }
  }
  return out;
}

/** Every deal on the account with what the ranker needs. Four reads, batched over the deals. */
export async function loadDealCandidates(
  supabase: SupabaseClient,
  workspaceId: string,
  companyEntityId: string,
): Promise<DealCandidate[]> {
  const rels = await readAll<{ from_entity_id: string }>((from, to) => supabase.from('relationships').select('from_entity_id')
    .eq('workspace_id', workspaceId).eq('to_entity_id', companyEntityId).eq('type', 'belongs_to').is('valid_to', null)
    .order('from_entity_id').range(from, to));
  const dealIds = [...new Set(rels.map(r => r.from_entity_id))];
  if (!dealIds.length) return [];

  const [claimsRows, rosterRows, itemsRes, stageRes] = await Promise.all([
    readAll<{ entity_id: string; property: string; value: unknown }>((from, to) => supabase.from('claims').select('entity_id, property, value')
      .eq('workspace_id', workspaceId).in('entity_id', dealIds).is('invalid_at', null)
      .in('property', ['name', 'stage', 'stage_id', 'status', 'value', 'close_date', 'owner_email'])
      .order('id').range(from, to)),
    readAll<{ from_entity_id: string; to_entity_id: string }>((from, to) => supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'stakeholder_of').in('to_entity_id', dealIds).is('valid_to', null)
      .order('id').range(from, to)),
    supabase.from('observations').select('entity_id, value')
      .eq('workspace_id', workspaceId).in('entity_id', dealIds).like('property', 'line_item.%').limit(2000),
    // Every stage row, paged: the sync re-writes the current stage on each CRM touch, so a busy
    // deal carries dozens, and a flat cap cut off exactly the history that dates the stage entry.
    readAll<DealStageObservation & { entity_id: string }>((from, to) => supabase.from('observations')
      .select('entity_id, value, raw, observed_at')
      .eq('workspace_id', workspaceId).in('entity_id', dealIds).eq('property', 'stage')
      .order('id').range(from, to)),
  ]);

  const byId = new Map<string, DealCandidate>(dealIds.map(id => [id, {
    dealEntityId: id, name: null, stage: null, stageId: null, status: null, value: null,
    closeDate: null, ownerEmail: null, roster: [], products: [], lastStageChangeAt: null,
  }]));
  const rawStatus = new Map<string, unknown>();
  for (const c of claimsRows) {
    const d = byId.get(c.entity_id); if (!d) continue;
    switch (c.property) {
      case 'name': d.name = str(c.value); break;
      case 'stage': d.stage = str(c.value); break;
      case 'stage_id': d.stageId = str(c.value); break;
      case 'status': rawStatus.set(c.entity_id, c.value); break;
      case 'value': d.value = num(c.value); break;
      case 'close_date': d.closeDate = str(c.value); break;
      case 'owner_email': d.ownerEmail = str(c.value); break;
    }
  }
  for (const d of byId.values()) d.status = statusOf(rawStatus.get(d.dealEntityId), d.stage);
  for (const r of rosterRows) {
    byId.get(r.to_entity_id)?.roster.push(r.from_entity_id);
  }
  for (const o of (itemsRes.data ?? []) as Array<{ entity_id: string; value: { name?: unknown } | null }>) {
    const name = o.value && typeof o.value === 'object' ? str(o.value.name) : null;
    const d = byId.get(o.entity_id);
    if (d && name && !d.products.includes(name)) d.products.push(name);
  }
  // When the deal entered its current stage, not when it was last edited (see stageEnteredAt).
  const stageObs = new Map<string, DealStageObservation[]>();
  for (const o of stageRes) {
    const list = stageObs.get(o.entity_id) ?? [];
    list.push(o);
    stageObs.set(o.entity_id, list);
  }
  for (const [id, obs] of stageObs) {
    const d = byId.get(id);
    if (d) d.lastStageChangeAt = stageEnteredAt(obs);
  }
  return [...byId.values()];
}

// ─── The hook ────────────────────────────────────────────────────────────────

/** Activity sources that ARE a CRM. Their engagements are mirrored, never questioned. */
export const CRM_SOURCES = new Set(['hubspot', 'pipedrive', 'attio', 'salesforce']);

/** Activity types worth filing against a deal. Enrichment runs, score updates and the like are not. */
export const CRM_AGENT_ACTIVITY_TYPES = new Set([
  'meeting_held', 'meeting_scheduled', 'call', 'call_held',
  'email_received', 'email_reply', 'email_sent',
  'linkedin_message', 'linkedin_replied', 'linkedin_reply',
  'slack_message', 'slack_dm', 'note',
]);

export const CRM_AGENT_CATEGORY = 'deal_attribution';

/** One decision per activity, not per attendee: the meeting/thread id when the source gives one. */
export function activityGroupKey(ctx: Pick<HookCtx, 'rawData' | 'externalId' | 'entityId'>): string | null {
  const r = (ctx.rawData ?? {}) as Record<string, unknown>;
  const k = r.note_id ?? r.meeting_id ?? r.recording_id ?? r.thread_id ?? r.message_id ?? r.event_id ?? null;
  if (k) return String(k);
  if (ctx.externalId) {
    // Connector external ids are `<source>_<record>_<contactId>`; strip the per-contact tail.
    const m = String(ctx.externalId).match(/^(.*)_([0-9a-f-]{36})$/i);
    return m ? m[1] : String(ctx.externalId);
  }
  return null;
}

interface AgentConfig { enabled: boolean; baselineAt: string | null }

/** Is the agent on for this workspace, and since when. Missing columns (migration not applied) read as off. */
async function agentConfig(supabase: SupabaseClient, workspaceId: string): Promise<AgentConfig> {
  try {
    const { data, error } = await supabase.from('crm_sync_configs')
      .select('crm_agent_enabled, baseline_completed_at')
      .eq('workspace_id', workspaceId);
    if (error) return { enabled: false, baselineAt: null };
    const rows = (data ?? []) as Array<{ crm_agent_enabled: boolean | null; baseline_completed_at: string | null }>;
    const on = rows.filter(r => r.crm_agent_enabled && r.baseline_completed_at);
    if (!on.length) return { enabled: false, baselineAt: null };
    // Several CRMs: the earliest baseline is the one that matters.
    const baselineAt = on.map(r => r.baseline_completed_at!).sort()[0];
    return { enabled: true, baselineAt };
  } catch { return { enabled: false, baselineAt: null }; }
}

async function accountOf(supabase: SupabaseClient, workspaceId: string, ctx: HookCtx): Promise<string | null> {
  if (ctx.companyId) return ctx.companyId;
  const { data } = await supabase.from('relationships').select('to_entity_id')
    .eq('workspace_id', workspaceId).eq('from_entity_id', ctx.entityId).eq('type', 'works_at').is('valid_to', null).limit(1);
  return (data?.[0] as { to_entity_id: string } | undefined)?.to_entity_id ?? null;
}

export interface CrmAgentPayload {
  mode: 'confirm' | 'ask';
  activity: {
    group_key: string; type: string; source: string | null; occurred_at: string | null;
    title: string | null; observation_ids: string[]; person_entity_ids: string[];
  };
  candidates: Array<{
    deal_entity_id: string; name: string | null; stage: string | null; value: number | null;
    close_date: string | null; confidence: number; reasons: string[];
  }>;
  ambiguous: boolean;
  /** Set by the human's answer (see answerCrmAgentDecision). */
  chosen?: { deal_entity_ids: string[]; answer: 'deal' | 'both' | 'neither' } | null;
}

/**
 * The decision the agent writes, or null when the table says stay silent. Exposed apart from
 * the hook so it can be exercised without the activity seam.
 */
export async function proposeDealAttribution(supabase: SupabaseClient, ctx: HookCtx): Promise<{ decision_id: string; mode: 'confirm' | 'ask' } | null> {
  const { workspaceId } = ctx;
  if (!ctx.source || CRM_SOURCES.has(ctx.source)) return null;
  if (!CRM_AGENT_ACTIVITY_TYPES.has(ctx.type)) return null;
  if (!ctx.observationId) return null;                          // dedup or failed insert: nothing new to file

  const cfg = await agentConfig(supabase, workspaceId);
  if (!cfg.enabled) return null;
  const at = ctx.occurredAt ?? new Date().toISOString();
  if (cfg.baselineAt && at < cfg.baselineAt) return null;      // pre-baseline: taken on trust

  const companyId = await accountOf(supabase, workspaceId, ctx);
  if (!companyId) return null;

  const candidates = (await loadDealCandidates(supabase, workspaceId, companyId)).filter(c => c.status === 'open');
  if (!candidates.length) return null;                          // no deal: the absence is the flag

  const groupKey = activityGroupKey(ctx) ?? ctx.observationId;
  const decisionId = `crm_agent:${groupKey}`.slice(0, 120);

  // Fold this attendee into an existing decision for the same meeting/thread, and never
  // reopen one a human has already answered.
  const { data: prior } = await supabase.from('ri_decisions').select('verdict, payload')
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId).maybeSingle();
  const priorPayload = (prior as { verdict: string; payload: CrmAgentPayload | null } | null)?.payload ?? null;
  if (prior && (prior as { verdict: string }).verdict !== 'pending') return null;

  const personIds = [...new Set([...(priorPayload?.activity.person_entity_ids ?? []), ctx.entityId])];
  const observationIds = [...new Set([...(priorPayload?.activity.observation_ids ?? []), ctx.observationId])];
  const r = (ctx.rawData ?? {}) as Record<string, unknown>;
  const title = (typeof r.title === 'string' && r.title) || ctx.description || null;
  const text = [title, ctx.summary, ctx.description].filter(Boolean).join('\n');

  const ranking = rankDealCandidates({ personEntityIds: personIds, ownerEmail: null, text, occurredAt: at }, candidates);
  if (!ranking.ranked.length) return null;
  const byId = new Map(candidates.map(c => [c.dealEntityId, c]));
  const mode: 'confirm' | 'ask' = candidates.length === 1 ? 'confirm' : 'ask';

  const payload: CrmAgentPayload = {
    mode,
    activity: { group_key: groupKey, type: ctx.type, source: ctx.source, occurred_at: at, title, observation_ids: observationIds, person_entity_ids: personIds },
    candidates: ranking.ranked.map(x => {
      const c = byId.get(x.dealEntityId)!;
      return { deal_entity_id: c.dealEntityId, name: c.name, stage: c.stage, value: c.value, close_date: c.closeDate, confidence: x.confidence, reasons: x.reasons };
    }),
    ambiguous: ranking.ambiguous,
    chosen: null,
  };

  const top = payload.candidates[0];
  const label = (c: CrmAgentPayload['candidates'][number]) => `${c.name ?? 'Untitled deal'}${c.stage ? ` · ${c.stage}` : ''}`;
  const proposal = mode === 'confirm'
    ? `File "${title ?? ctx.type}" against ${label(top)}?`
    : `Which deal was "${title ?? ctx.type}" about? ${payload.candidates.map(label).join(' / ')}`;
  const rationale = top.reasons.length ? top.reasons.join('; ') : (mode === 'ask' ? 'nothing in the activity separates these deals' : 'the only open deal on the account');

  await proposeDecision(supabase, workspaceId, {
    decision_id: decisionId,
    entity_id: companyId,
    surface: 'app',
    agent: 'crm-agent',
    category: CRM_AGENT_CATEGORY,
    action_type: 'file_activity',
    proposal,
    rationale,
    evidence_ids: observationIds,
    payload,
  });
  return { decision_id: decisionId, mode };
}

/** Registered at boot next to pipelineStageHook. Never throws into logActivity. */
export const crmAgentHook: ActivityHook = async (ctx) => {
  try {
    await proposeDealAttribution(ctx.supabase, ctx);
  } catch (err) {
    console.warn('[CRM_AGENT] propose failed:', (err as Error)?.message || err);
  }
};

// ─── The queue, and the human's answer ───────────────────────────────────────

export type CrmAgentAnswer = 'deal' | 'both' | 'neither';

/**
 * The verdict the decision loop should record for an answer. Pure, and the learning label:
 * `accepted` means the human took the agent's top pick exactly; `edited` means they chose
 * differently (a different deal, or more than one); `rejected` means none of them. This is
 * what lets the ranking be graded on the customer's own corrections.
 */
export function verdictForAnswer(topDealId: string | null, answer: CrmAgentAnswer, chosen: string[]): 'accepted' | 'edited' | 'rejected' {
  if (answer === 'neither' || !chosen.length) return 'rejected';
  if (chosen.length === 1 && topDealId && chosen[0] === topDealId) return 'accepted';
  return 'edited';
}

/** Pending questions for a workspace, newest first. Only the agent's own category. */
export async function listCrmAgentQueue(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { limit?: number; entityId?: string | null; includeAnswered?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  let q = supabase.from('ri_decisions').select('*')
    .eq('workspace_id', workspaceId).eq('category', CRM_AGENT_CATEGORY)
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 100, 500));
  if (!opts.includeAnswered) q = q.eq('verdict', 'pending');
  if (opts.entityId) q = q.eq('entity_id', opts.entityId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/**
 * The human answered. Records the verdict, files the attribution (observation_deals,
 * source 'human'), and lets everyone on the activity inherit the deal (stakeholder_of), so
 * a new decision maker who joined the call is on the deal without a second question.
 *
 * Does NOT write to the CRM: that is the push path's job, gated separately, and off today.
 * The answer is the ground truth Nous holds until the CRM has it.
 */
export async function answerCrmAgentDecision(
  supabase: SupabaseClient,
  workspaceId: string,
  decisionId: string,
  input: { answer: CrmAgentAnswer; dealEntityIds?: string[]; userId?: string | null; note?: string | null },
): Promise<{ ok: true; verdict: string; linked: number; stakeholders: number } | { ok: false; error: string }> {
  const { data: row } = await supabase.from('ri_decisions').select('id, verdict, payload')
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId).maybeSingle();
  if (!row) return { ok: false, error: 'not_found' };
  const payload = ((row as { payload: CrmAgentPayload | null }).payload ?? null) as CrmAgentPayload | null;
  if (!payload?.candidates) return { ok: false, error: 'not_a_crm_agent_decision' };

  const allowed = new Set(payload.candidates.map(c => c.deal_entity_id));
  let chosen: string[];
  if (input.answer === 'neither') chosen = [];
  else if (input.answer === 'both') chosen = payload.candidates.map(c => c.deal_entity_id);
  else chosen = [...new Set((input.dealEntityIds ?? []).filter(id => allowed.has(id)))];
  if (input.answer === 'deal' && !chosen.length) return { ok: false, error: 'deal_entity_ids_required' };

  const verdict = verdictForAnswer(payload.candidates[0]?.deal_entity_id ?? null, input.answer, chosen);
  await recordVerdict(supabase, workspaceId, decisionId, { verdict, verdict_note: input.note ?? null });

  const nextPayload: CrmAgentPayload = { ...payload, chosen: { deal_entity_ids: chosen, answer: input.answer } };
  await supabase.from('ri_decisions').update({ payload: nextPayload, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('decision_id', decisionId);

  let linked = 0, stakeholders = 0;
  if (chosen.length) {
    for (const obsId of payload.activity.observation_ids) {
      const ok = await linkObservationToDeals(supabase, workspaceId, obsId, chosen, 'human', { decidedBy: input.userId ?? null });
      if (ok) linked += chosen.length;
    }
    // Attribution flows through the activity: everyone on it is now on the deal.
    const rows = chosen.flatMap(dealId => payload.activity.person_entity_ids.map(pid => ({
      workspace_id: workspaceId, from_entity_id: pid, to_entity_id: dealId, type: 'stakeholder_of',
      valid_from: payload.activity.occurred_at ?? new Date().toISOString(),
    })));
    if (rows.length) {
      const { error } = await supabase.from('relationships').upsert(rows,
        { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true });
      if (!error) stakeholders = rows.length;
    }
  }
  // Now that the deal is known, hand the activity to the push path with its deals attached.
  // A no-op while no push handler is registered (write-back is off), and never the answer's
  // problem if it fails: the attribution is already recorded above.
  if (chosen.length) {
    const { data: obs } = await supabase.from('observations')
      .select('id, property, value, observed_at, source, raw')
      .eq('workspace_id', workspaceId).in('id', payload.activity.observation_ids);
    for (const o of (obs ?? []) as Array<{ id: string; property: string; value: { description?: string | null; summary?: string | null } | null; observed_at: string; source: string; raw: Record<string, unknown> | null }>) {
      const personId = payload.activity.person_entity_ids[0];
      if (!personId) break;
      notifyCrmPushNow({
        workspaceId, contactId: personId,
        activityType: o.property.replace(/^interaction\./, ''),
        source: o.source, activityId: o.id, occurredAt: o.observed_at,
        summary: o.value?.summary ?? null, description: o.value?.description ?? null,
        rawData: o.raw, dealIds: chosen,
      });
    }
  }
  return { ok: true, verdict, linked, stakeholders };
}

/** "Not now": the question goes away without an attribution and without touching the graph. */
export async function dismissCrmAgentDecision(
  supabase: SupabaseClient,
  workspaceId: string,
  decisionId: string,
  note?: string | null,
): Promise<boolean> {
  const r = await recordVerdict(supabase, workspaceId, decisionId, { verdict: 'rejected', verdict_note: note ?? 'dismissed' });
  return !!r;
}
