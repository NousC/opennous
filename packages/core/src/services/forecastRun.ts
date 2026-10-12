import type { SupabaseClient } from '@supabase/supabase-js';
import { PIPELINE_LADDER, STAGE_RANK, DONE_STAGES, isTerminalStage } from '../pipeline.js';
import { STAGE_DRIVING_PROPERTIES } from '../db/pipelineStage.js';
import { getInternalEntityIds } from '../db/teamMembers.js';
import { getPersonalEntityIds } from '../db/relationship.js';
import { readIntentBand, INTENT_BAND_ORDER } from '../intentBand.js';
import {
  reconstructLadder, timeToWinRows, stageOccupancies, kaplanMeierCurve, kaplanMeierMedian,
  type FunnelHop,
} from './funnelTimeline.js';
import {
  buildConversionRates, winProbabilityByStage, forecastPipeline,
  type ForecastResult, type ConversionRate,
} from './forecast.js';
import {
  DEFAULT_WIN_COEFFS, WIN_FEATURE_VERSION,
  encodeWinFeatures, explainWinProbability, type WinDriver,
} from './winModel.js';
import { INBOUND_TYPES } from './pipelineFeatures.js';

// The forecast run — assembly + computation for one workspace, extracted from the /v2
// route so the API stays a thin shell (per the layer rules) and so the worker's weekly
// snapshot cron and the win-model fit job run EXACTLY the same forecast a caller sees.
// Three consumers, one implementation; a snapshot that ran different code from the live
// endpoint would grade a forecast nobody was ever shown.

const DAY = 86_400_000;

/** Bump when the forecast's behaviour changes — stamped on every snapshot row. */
export const FORECAST_MODEL_VERSION = '3.0.0';

export interface ForecastPeriod {
  start: Date;
  end: Date;
  label: string;
}

// The period being forecast. Defaults to the rest of the current calendar month.
//
// Calendar, not fiscal: workspaces.fiscal_year_start_month does not exist yet, so
// pretending to honour a fiscal calendar would quietly give a Feb-start company the wrong
// quarter. Callers can always pass explicit dates.
export function resolvePeriod(
  body: { period_start?: string; period_end?: string; period?: string } = {},
  now: Date = new Date(),
): ForecastPeriod {
  if (body.period_start && body.period_end) {
    const start = new Date(body.period_start), end = new Date(body.period_end);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start) {
      return { start, end, label: 'custom' };
    }
  }
  const kind = body.period === 'quarter' ? 'quarter' : 'month';
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = kind === 'quarter'
    ? new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + 3, 0, 23, 59, 59))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  const start = kind === 'quarter'
    ? new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1))
    : monthStart;
  return { start, end, label: kind };
}

// ─── assembly: the substrate reads every forecast consumer shares ────────────

export interface AccountState {
  entityId: string;
  stage: string;
  enteredAt: string;
  /** Merged interaction timestamps across the account's contacts, ascending. */
  activityTimes: string[];
  /** Distinct contacts with any activity. */
  stakeholderCount: number;
  /** Distinct contacts active in the last 45 days (the portfolio's "engaged" window). */
  engagedCount: number;
  /** The account's earliest stage-driving activity — inbound detection reads this. */
  firstTouchType: string | null;
}

export interface ForecastAssembly {
  rates: ConversionRate[];
  winByStage: Record<string, number>;
  curvesByStage: Record<string, ReturnType<typeof kaplanMeierCurve>>;
  /** Median days spent in each rung (censoring-aware); null when unknowable. */
  medianDaysByStage: Record<string, number | null>;
  winRowsByStage: Record<string, Array<{ days: number; censored: boolean }>>;
  accounts: Map<string, AccountState>;
  /** contact entity id -> company entity id (or null). */
  contactCompany: Map<string, string | null>;
  /** Per-account reconstructed ladders, keyed like `accounts` (merged across contacts). */
  laddersByAccount: Map<string, FunnelHop[]>;
  /** account -> contact -> that contact's activity timestamps. The fit job reads this to
   *  count stakeholders AS OF a past date (AccountState only carries today's counts). */
  contactTimesByAccount: Map<string, Map<string, string[]>>;
  /** account -> its raw stage-driving activities (ascending). Discovery's pipeline
   *  features read real event types from here rather than reconstructed stand-ins. */
  activitiesByAccount: Map<string, Array<{ entity_id: string; property: string; observed_at: string; raw: Record<string, unknown> | null }>>;
}

/**
 * Rebuild every account's funnel state from the stage-driving interactions. The
 * pipeline_stage rows are a lossy copy (pre-fix rows carry write time, backfills write no
 * rows, derivation keeps only the top rung) — the interactions have always carried the
 * provider's real event time, so everything here derives from them.
 */
export async function assembleForecast(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { now?: number } = {},
): Promise<ForecastAssembly> {
  const now = opts.now ?? Date.now();

  const acts: Array<{ entity_id: string; property: string; observed_at: string; raw: Record<string, unknown> | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('observations')
      .select('entity_id, property, observed_at, raw')
      .eq('workspace_id', workspaceId)
      .in('property', STAGE_DRIVING_PROPERTIES as string[])
      // observed_at is NOT unique (a closed-deal import stamps a whole account's rows with
      // one midnight), so it alone is not a total order and OFFSET pages could overlap or
      // skip inside a tie block. The id tiebreaker makes pagination deterministic — a
      // silently dropped terminal row would leave a dead deal counted as open pipeline.
      .order('observed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    acts.push(...(data as typeof acts));
    if (data.length < 1000) break;
  }

  // People only, and not our own team. A teammate is not a deal.
  const allIds = [...new Set(acts.map(o => o.entity_id).filter(Boolean))];
  const contactCompany = new Map<string, string | null>();
  for (let i = 0; i < allIds.length; i += 100) {
    const { data } = await supabase.from('contacts')
      .select('id, company_id').in('id', allIds.slice(i, i + 100));
    for (const c of (data as Array<{ id: string; company_id: string | null }>) || []) {
      contactCompany.set(c.id, c.company_id ?? null);
    }
  }
  const [internalIds, personalIds] = await Promise.all([
    getInternalEntityIds(supabase, workspaceId),
    getPersonalEntityIds(supabase, workspaceId),
  ]);
  const skip = new Set([...internalIds, ...personalIds]);

  // Group activities per ACCOUNT (company where linked, else the contact itself). The
  // account is the deal: merging its contacts' events and reconstructing one ladder gives
  // the deal-level funnel — a terminal recorded on any of its people closes the deal.
  const actsByAccount = new Map<string, typeof acts>();
  const contactsByAccount = new Map<string, Map<string, string[]>>(); // account -> contact -> times
  for (const o of acts) {
    if (!contactCompany.has(o.entity_id) || skip.has(o.entity_id)) continue;
    const key = contactCompany.get(o.entity_id) || o.entity_id;
    (actsByAccount.get(key) ?? actsByAccount.set(key, []).get(key)!).push(o);
    const perContact = contactsByAccount.get(key) ?? contactsByAccount.set(key, new Map()).get(key)!;
    (perContact.get(o.entity_id) ?? perContact.set(o.entity_id, []).get(o.entity_id)!).push(o.observed_at);
  }

  const everReached: Record<string, number> = {};
  for (const s of PIPELINE_LADDER) everReached[s] = 0;
  const winRowsByStage: Record<string, Array<{ days: number; censored: boolean }>> = {};
  const occByStage: Record<string, Array<{ days: number; censored: boolean }>> = {};
  const accounts = new Map<string, AccountState>();
  const laddersByAccount = new Map<string, FunnelHop[]>();

  for (const [accountId, accountActs] of actsByAccount) {
    const hops = reconstructLadder(accountActs, { now });
    if (!hops.length) continue;
    laddersByAccount.set(accountId, hops);

    let top = -1;
    for (const h of hops) if (!isTerminalStage(h.stage)) top = Math.max(top, STAGE_RANK[h.stage] ?? 0);
    for (const s of PIPELINE_LADDER) if (STAGE_RANK[s] <= top) everReached[s]++;

    for (const row of timeToWinRows(hops, { now })) {
      (winRowsByStage[row.stage] ||= []).push({ days: row.days, censored: row.censored });
    }
    for (const occ of stageOccupancies(hops, { now })) {
      (occByStage[occ.stage] ||= []).push({ days: occ.days, censored: occ.censored });
    }

    const last = hops[hops.length - 1];
    const perContact = contactsByAccount.get(accountId) ?? new Map<string, string[]>();
    let engaged = 0;
    for (const times of perContact.values()) {
      if (times.some(t => now - Date.parse(t) <= 45 * DAY)) engaged++;
    }
    accounts.set(accountId, {
      entityId: accountId,
      stage: last.stage,
      enteredAt: last.at,
      activityTimes: accountActs.map(o => o.observed_at),
      stakeholderCount: perContact.size,
      engagedCount: engaged,
      firstTouchType: accountActs.length
        ? accountActs[0].property.replace(/^interaction\./, '')
        : null,
    });
  }

  const rates = buildConversionRates(
    PIPELINE_LADDER.slice(0, -1).map((from, i) => ({
      from, to: PIPELINE_LADDER[i + 1],
      reached_from: everReached[from] || 0,
      reached_to: everReached[PIPELINE_LADDER[i + 1]] || 0,
    })),
  );
  const curvesByStage: ForecastAssembly['curvesByStage'] = {};
  for (const [stage, rows] of Object.entries(winRowsByStage)) curvesByStage[stage] = kaplanMeierCurve(rows);
  const medianDaysByStage: Record<string, number | null> = {};
  for (const s of PIPELINE_LADDER) medianDaysByStage[s] = kaplanMeierMedian(occByStage[s] || []);

  return {
    rates,
    winByStage: winProbabilityByStage(rates),
    curvesByStage,
    medianDaysByStage,
    winRowsByStage,
    accounts,
    contactCompany,
    laddersByAccount,
    contactTimesByAccount: contactsByAccount,
    activitiesByAccount: actsByAccount,
  };
}

// ─── the run: layer 1 + 2 + 3 for one workspace ──────────────────────────────

export interface RunForecastOptions {
  period?: { period_start?: string; period_end?: string; period?: string };
  now?: number;
}

export interface WinModelRow {
  coefficients: Record<string, number>;
  basis: 'default' | 'fitted';
  beats_baseline: boolean;
  training_wins: number;
  training_losses: number;
  feature_version: string;
  fitted_at: string;
}

export type ForecastRunResult = ForecastResult & {
  period: { start: string; end: string; label: string; days_remaining: number; calendar: 'calendar' };
  intent_coverage: { with_band: number; accounts: number };
  timing_sample: Record<string, { total: number; wins: number }>;
  win_model: {
    basis: 'default' | 'fitted';
    applied: boolean;
    feature_version: string;
    fitted_at?: string;
    training?: { wins: number; losses: number };
  };
  model_version: string;
};

const isInboundTouch = (type: string | null): boolean =>
  !!type && INBOUND_TYPES.some(t => type.includes(t));

/** The facts about one open deal that the win model reads, raw (before encoding). */
export interface DealFacts {
  daysQuiet: number | null;
  engagementTrend: string;
  stakeholderCount: number;
  engagedCount: number;
  openObjections: number;
  competitorPresent: boolean;
  inbound: boolean;
  icpFit: number | null;
  icpPain: number | null;
  icpAbility: number | null;
  intentScore: number | null;
}

/** One open deal scored by layers 1 and 3: the stage base, the adjusted P(win), and what moved it. */
export interface ScoredDeal {
  entityId: string;
  name: string | null;
  amount: number | null;
  stage: string;
  daysInStage: number;
  /** Typical days at this stage (censoring-aware median). Null when unknowable. */
  medianDaysInStage: number | null;
  intentBand: string | null;
  pWinBase: number;
  pWin: number;
  drivers: WinDriver[];
  facts: DealFacts;
}

export interface ScoredPipeline {
  asm: ForecastAssembly;
  deals: ScoredDeal[];
  winModel: ForecastRunResult['win_model'];
}

/**
 * Every open deal in the workspace, scored — the one read behind BOTH the forecast and the
 * per-deal outlook, so "how likely is Acme to close" can never disagree with the P(win) Acme
 * carries in the forecast.
 */
export async function scoreOpenDeals(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { now?: number } = {},
): Promise<ScoredPipeline> {
  const now = opts.now ?? Date.now();
  const asm = await assembleForecast(supabase, workspaceId, { now });
  const openAccounts = [...asm.accounts.values()]
    .filter(a => !DONE_STAGES.has(a.stage) && !isTerminalStage(a.stage));
  const openIds = openAccounts.map(a => a.entityId);
  const contactIds = [...asm.contactCompany.keys()];

  // ── amounts + names ──
  // deal_value is LIVE pipeline (won_deal_value is banked history and must never be
  // forecast). Written by the CRM rollup; absent without a CRM, in which case the deal is
  // reported with no amount rather than silently valued at zero.
  const amountByEntity = new Map<string, number>();
  const nameByEntity = new Map<string, string | null>();
  for (let i = 0; i < openIds.length; i += 100) {
    const slice = openIds.slice(i, i + 100);
    const [{ data: claims }, { data: companies }] = await Promise.all([
      supabase.from('claims').select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('property', 'deal_value').is('invalid_at', null).in('entity_id', slice),
      supabase.from('companies').select('id, name, domain').in('id', slice),
    ]);
    for (const c of (claims as Array<{ entity_id: string; value: unknown }>) || []) {
      const v = c.value as { value?: unknown } | number | string;
      const n = Number(typeof v === 'object' && v !== null ? (v as { value?: unknown }).value : v);
      if (Number.isFinite(n) && n > 0) amountByEntity.set(c.entity_id, n);
    }
    for (const c of (companies as Array<{ id: string; name: string | null; domain: string | null }>) || []) {
      nameByEntity.set(c.id, c.name || c.domain || null);
    }
  }
  // An account with no company on record IS the person — name the deal after them, so it never
  // reads as unnamed just because nobody linked a company.
  const unnamed = openIds.filter(id => !nameByEntity.get(id));
  for (let i = 0; i < unnamed.length; i += 100) {
    const { data: people } = await supabase.from('contacts')
      .select('id, first_name, last_name, email, company')
      .in('id', unnamed.slice(i, i + 100));
    type Person = { id: string; first_name: string | null; last_name: string | null; email: string | null; company: string | null };
    for (const p of (people as Person[]) || []) {
      const person = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || null;
      const label = person && p.company ? `${person} (${p.company})` : person || p.company || null;
      if (label) nameByEntity.set(p.id, label);
    }
  }

  // ── intent (band for the timing multiplier, score for the layer-3 feature) ──
  // Bands/scores live on the CONTACTS; an account takes the hottest among its people.
  const BAND_ORDER = INTENT_BAND_ORDER;   // canonical ranking — see intentBand.ts
  const intentBandByAccount = new Map<string, string>();
  const intentScoreByAccount = new Map<string, number>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const { data: rows } = await supabase.from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('property', ['intent_band', 'intent_score'])
      .is('invalid_at', null)
      .in('entity_id', contactIds.slice(i, i + 100));
    for (const r of (rows as Array<{ entity_id: string; property: string; value: unknown }>) || []) {
      const key = asm.contactCompany.get(r.entity_id) || r.entity_id;
      if (r.property === 'intent_band') {
        // Both stored shapes, read in one place — see core/intentBand.ts.
        const band = readIntentBand(r.value);
        if (band === null) continue;
        const cur = intentBandByAccount.get(key);
        if (!cur || (BAND_ORDER[band] ?? -1) > (BAND_ORDER[cur] ?? -1)) intentBandByAccount.set(key, band);
      } else {
        const n = Number(r.value);
        if (!Number.isFinite(n)) continue;
        if ((intentScoreByAccount.get(key) ?? -1) < n) intentScoreByAccount.set(key, n);
      }
    }
  }

  // ── layer-3 account facts: objections, competitors, ICP layers ──
  // note.% claims live on contacts AND companies; both roll up to the account key. The
  // open-objection read mirrors the portfolio's exactly: metadata.status, default 'open'.
  const openObjectionsByAccount = new Map<string, number>();
  const competitorByAccount = new Map<string, boolean>();
  {
    const rows: Array<{ entity_id: string; value: { category?: string; metadata?: { status?: string } } }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('claims')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId)
        .like('property', 'note.%')
        .is('invalid_at', null)
        .or('value->>category.eq.objection,value->>category.eq.competitor')
        // Unordered LIMIT/OFFSET pages can overlap or skip rows — order by the PK.
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) break;   // best-effort — a failed read leaves the features neutral
      if (!data?.length) break;
      rows.push(...(data as typeof rows));
      if (data.length < 1000) break;
    }
    for (const r of rows) {
      const key = asm.contactCompany.get(r.entity_id) || r.entity_id;
      const cat = r.value?.category;
      if (cat === 'objection') {
        if ((r.value?.metadata?.status || 'open') === 'open') {
          openObjectionsByAccount.set(key, (openObjectionsByAccount.get(key) ?? 0) + 1);
        }
      } else if (cat === 'competitor') {
        competitorByAccount.set(key, true);
      }
    }
  }

  const icpByAccount = new Map<string, { fit?: number; pain?: number; ability?: number }>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const { data: rows } = await supabase.from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', workspaceId)
      .in('property', ['icp.fit', 'icp.pain', 'icp.ability'])
      .is('invalid_at', null)
      .in('entity_id', contactIds.slice(i, i + 100));
    for (const r of (rows as Array<{ entity_id: string; property: string; value: unknown }>) || []) {
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      const key = asm.contactCompany.get(r.entity_id) || r.entity_id;
      const cur = icpByAccount.get(key) ?? {};
      const layer = r.property.replace('icp.', '') as 'fit' | 'pain' | 'ability';
      // Best-fit person represents the account — consistent with the hottest-intent rule.
      if ((cur[layer] ?? -1) < n) cur[layer] = n;
      icpByAccount.set(key, cur);
    }
  }

  // ── the win model: fitted when it earned it, hand-set defaults otherwise ──
  let model: WinModelRow | null = null;
  try {
    const { data } = await supabase.from('win_models')
      .select('coefficients, basis, beats_baseline, training_wins, training_losses, feature_version, fitted_at')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    model = (data as WinModelRow) ?? null;
  } catch { /* table may not exist yet on self-host — defaults apply */ }

  // A fitted model is only APPLIED when it beat the stage-only baseline out-of-sample and
  // was fitted against the current feature vector. Anything else falls back to the
  // hand-set defaults — the product's stated behaviour, never a silently stale fit.
  const useFitted = !!model
    && model.basis === 'fitted'
    && model.beats_baseline === true
    && model.feature_version === WIN_FEATURE_VERSION;
  const coeffs = useFitted ? model!.coefficients : DEFAULT_WIN_COEFFS;

  const deals: ScoredDeal[] = openAccounts.map(a => {
    const daysInStage = Math.max(0, (now - Date.parse(a.enteredAt)) / DAY);
    const median = asm.medianDaysByStage[a.stage] ?? null;
    const icp = icpByAccount.get(a.entityId) ?? {};
    const facts: DealFacts = {
      daysQuiet: a.activityTimes.length
        ? Math.max(0, (now - Math.max(...a.activityTimes.map(t => Date.parse(t)))) / DAY)
        : null,
      engagementTrend: trendOf(a.activityTimes, now),
      stakeholderCount: a.stakeholderCount,
      engagedCount: a.engagedCount,
      openObjections: openObjectionsByAccount.get(a.entityId) ?? 0,
      competitorPresent: competitorByAccount.get(a.entityId) === true,
      inbound: isInboundTouch(a.firstTouchType),
      icpFit: icp.fit ?? null,
      icpPain: icp.pain ?? null,
      icpAbility: icp.ability ?? null,
      intentScore: intentScoreByAccount.get(a.entityId) ?? null,
    };
    const features = encodeWinFeatures({
      ageRatio: median != null && median > 0 ? daysInStage / median : null,
      daysQuiet: facts.daysQuiet,
      engagementTrend: facts.engagementTrend,
      icpFit: facts.icpFit,
      icpPain: facts.icpPain,
      icpAbility: facts.icpAbility,
      intentScore: facts.intentScore,
      stakeholderCount: a.stakeholderCount || null,
      singleThreaded: a.engagedCount <= 1,
      openObjections: facts.openObjections,
      competitorPresent: facts.competitorPresent,
      inbound: facts.inbound,
    });
    const pStage = asm.winByStage[a.stage] ?? 0;
    const { pWin, drivers } = explainWinProbability(pStage, features, coeffs);
    return {
      entityId: a.entityId,
      name: nameByEntity.get(a.entityId) ?? null,
      amount: amountByEntity.get(a.entityId) ?? null,
      stage: a.stage,
      daysInStage,
      medianDaysInStage: median,
      intentBand: intentBandByAccount.get(a.entityId) ?? null,
      pWinBase: pStage,
      pWin,
      drivers,
      facts,
    };
  });

  return {
    asm,
    deals,
    winModel: {
      basis: useFitted ? 'fitted' : 'default',
      applied: true,
      feature_version: WIN_FEATURE_VERSION,
      ...(useFitted ? {
        fitted_at: model!.fitted_at,
        training: { wins: model!.training_wins, losses: model!.training_losses },
      } : {}),
    },
  };
}

export async function runForecast(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: RunForecastOptions = {},
): Promise<ForecastRunResult> {
  const now = opts.now ?? Date.now();
  const nowDate = new Date(now);
  const period = resolvePeriod(opts.period ?? {}, nowDate);
  // Horizon is measured from TODAY, not the period start. A forecast made on the 20th for
  // "this month" is asking about the eleven days that are left, not about thirty.
  const horizonDays = Math.max(0, (period.end.getTime() - now) / DAY);

  const { asm, deals: scored, winModel } = await scoreOpenDeals(supabase, workspaceId, { now });
  const deals = scored.map(d => ({
    entityId: d.entityId,
    name: d.name,
    amount: d.amount,
    stage: d.stage,
    daysInStage: d.daysInStage,
    amountBasis: d.amount != null ? 'crm' : 'none',
    intentBand: d.intentBand,
    pWin: d.pWin,
  }));

  const result = forecastPipeline(deals,
    { rates: asm.rates, winByStage: asm.winByStage, curvesByStage: asm.curvesByStage },
    { horizonDays },
  );

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      label: period.label,
      days_remaining: Math.round(horizonDays),
      calendar: 'calendar',
    },
    ...result,
    intent_coverage: {
      with_band: scored.filter(d => d.intentBand != null).length,
      accounts: scored.length,
    },
    timing_sample: Object.fromEntries(
      PIPELINE_LADDER.map(s => {
        const rows = asm.winRowsByStage[s] || [];
        return [s, { total: rows.length, wins: rows.filter(r => !r.censored).length }];
      }),
    ),
    win_model: winModel,
    model_version: FORECAST_MODEL_VERSION,
  };
}

// ─── the deal outlook: one deal at a time, no roll-up ────────────────────────
//
// The forecast answers "how much lands this period". The outlook answers what a rep asks
// about a DEAL: how likely is it to close, how likely inside the next N days, and why. Same
// scoring as the forecast (scoreOpenDeals), no amounts, no totals.

/**
 * Won deals a stage's timing curve needs before "within N days" is said at all. Below it the
 * Kaplan-Meier curve is a handful of anecdotes: four wins that all closed inside three weeks
 * would declare a 55% negotiation deal 0% likely to close this month.
 */
export const MIN_TIMING_WINS = 5;

// Steps exist only at win times, so the last step is the latest win the curve has seen.
const lastWinDay = (curve: ForecastAssembly['curvesByStage'][string] | undefined): number | null =>
  curve?.length ? curve[curve.length - 1].t : null;

/**
 * judged        enough won deals from this stage, and the deal is inside the ages they cover
 * too_few_wins  some won deals, not enough to learn timing from
 * no_history    no won deals from this stage at all
 * past_history  the deal has sat at this stage longer than any deal that went on to win. The
 *               curve is flat past its last win, so it would read 0% for ANY window — that is
 *               the edge of the data, not evidence the deal won't close.
 */
export type TimingBasis = 'judged' | 'too_few_wins' | 'no_history' | 'past_history';

/** One open deal's outlook. `pWinWithin[N]` = P(won within N days); null = timing not judged. */
export interface DealOutlook extends ScoredDeal {
  pWinWithin: Record<number, number | null>;
  timingBasis: TimingBasis;
  /** Won deals behind this stage's timing curve; null when the caller did not supply counts. */
  timingWins: number | null;
  /** Days-in-stage of the latest win the curve has seen; null when it has none. */
  timingLastWinDay: number | null;
  /** The intent multiplier the timing half applied for the first horizon (1 = none). */
  intentMultiplier: number;
}

export interface DealOutlookResult {
  /** Open deals, most likely to be won within the FIRST horizon first. */
  deals: DealOutlook[];
  horizons: number[];
  /** How much the stage conversion rates rest on assumption rather than this workspace's history. */
  stageRatesBasis: ForecastResult['basis'];
  winModel: ForecastRunResult['win_model'];
  /** Stage of every account with a reconstructed ladder, open or closed. */
  stageByAccount: Map<string, string>;
}

/**
 * Pure. P(won within N days) = P(win) x P(closes within N | still open at its current age) —
 * the same product the forecast weights an amount by, without the amount — said only when the
 * stage has MIN_TIMING_WINS won deals behind its curve (when `timingWinsByStage` is supplied).
 *
 * Ranked by P(won within the first window). A deal whose timing can't be judged ranks by its
 * P(win) — the most its windowed chance could be — so a strong deal is never buried under weak
 * ones just because its stage lacks timing history. Every deal says which basis it has.
 */
export function dealOutlookFromScores(
  deals: ScoredDeal[],
  model: {
    rates: ConversionRate[];
    winByStage: Record<string, number>;
    curvesByStage: ForecastAssembly['curvesByStage'];
    timingWinsByStage?: Record<string, number>;
  },
  horizons: number[],
): { deals: DealOutlook[]; horizons: number[]; stageRatesBasis: ForecastResult['basis'] } {
  const hs = [...new Set((horizons?.length ? horizons : [30]).map(h => Math.max(1, Math.round(h))))];
  const byId = new Map<string, DealOutlook>(
    deals.map(d => [d.entityId, {
      ...d, pWinWithin: {}, timingBasis: 'no_history' as TimingBasis,
      timingWins: model.timingWinsByStage ? (model.timingWinsByStage[d.stage] ?? 0) : null,
      timingLastWinDay: lastWinDay(model.curvesByStage[d.stage]),
      intentMultiplier: 1,
    }]),
  );
  let stageRatesBasis: ForecastResult['basis'] = 'prior';
  hs.forEach((h, i) => {
    const res = forecastPipeline(
      deals.map(d => ({
        entityId: d.entityId, amount: null, stage: d.stage,
        daysInStage: d.daysInStage, intentBand: d.intentBand, pWin: d.pWin,
      })),
      model,
      { horizonDays: h },
    );
    stageRatesBasis = res.basis;
    for (const r of res.deals) {
      const o = byId.get(r.entityId);
      if (!o) continue;
      const basis: TimingBasis = r.pClose === null ? 'no_history'
        : o.timingWins !== null && o.timingWins < MIN_TIMING_WINS ? 'too_few_wins'
        : o.timingLastWinDay !== null && o.daysInStage >= o.timingLastWinDay ? 'past_history'
        : 'judged';
      o.pWinWithin[h] = basis === 'judged' ? r.pWin * (r.pClose as number) : null;
      if (i === 0) { o.timingBasis = basis; o.intentMultiplier = r.intentMultiplier; }
    }
  });
  const first = hs[0];
  const rankKey = (d: DealOutlook) => d.pWinWithin[first] ?? d.pWin;
  const sorted = [...byId.values()].sort((a, b) => (rankKey(b) - rankKey(a)) || (b.pWin - a.pWin));
  return { deals: sorted, horizons: hs, stageRatesBasis };
}

export async function runDealOutlook(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { now?: number; horizons?: number[] } = {},
): Promise<DealOutlookResult> {
  const now = opts.now ?? Date.now();
  const { asm, deals, winModel } = await scoreOpenDeals(supabase, workspaceId, { now });
  const timingWinsByStage: Record<string, number> = {};
  for (const [stage, rows] of Object.entries(asm.winRowsByStage)) {
    timingWinsByStage[stage] = rows.filter(r => !r.censored).length;
  }
  const out = dealOutlookFromScores(deals,
    { rates: asm.rates, winByStage: asm.winByStage, curvesByStage: asm.curvesByStage, timingWinsByStage },
    opts.horizons ?? [30],
  );
  const stageByAccount = new Map<string, string>();
  for (const a of asm.accounts.values()) stageByAccount.set(a.entityId, a.stage);
  return { ...out, winModel, stageByAccount };
}

// Local trend (kept here rather than importing the winModel helper to avoid a cycle —
// same thresholds as engagementTrendAt / the portfolio).
function trendOf(times: string[], nowMs: number): string {
  let recent = 0, prior = 0;
  for (const iso of times || []) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (t > nowMs - 30 * DAY) recent++;
    else if (t > nowMs - 60 * DAY) prior++;
  }
  if (recent === 0) return 'cold';
  if (prior === 0) return 'rising';
  if (recent > prior * 1.25) return 'rising';
  if (recent < prior * 0.75) return 'cooling';
  return 'steady';
}

// ─── snapshots: the weekly materialisation ───────────────────────────────────

/** Cap stored per-deal detail so a 5k-account workspace does not write megabyte rows. */
const SNAPSHOT_DEAL_CAP = 200;

/**
 * Shape a forecast result into a snapshot row. Pure — testable without a database.
 * Deals are already sorted biggest-contributor-first by forecastPipeline; the cap keeps
 * the ones that explain the number.
 */
export function snapshotFromForecast(
  workspaceId: string,
  run: ForecastRunResult,
): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    period_start: run.period.start.slice(0, 10),
    period_end: run.period.end.slice(0, 10),
    model_version: run.model_version,
    basis: run.basis,
    expected: run.expected,
    p10: run.bands.p10,
    p50: run.bands.p50,
    p90: run.bands.p90,
    deal_count: run.dealCount,
    open_pipeline: run.openPipeline,
    deals: run.deals.slice(0, SNAPSHOT_DEAL_CAP).map(d => ({
      entityId: d.entityId,
      name: d.name ?? null,
      amount: d.amount,
      stage: d.stage,
      pWinBase: +d.pWinBase.toFixed(4),
      pWin: +d.pWin.toFixed(4),
      pClose: d.pClose === null ? null : +d.pClose.toFixed(4),
      contribution: Math.round(d.contribution),
      intentBand: d.intentBand ?? null,
    })),
  };
}

/**
 * Persist one snapshot row. Best-effort by design: a failed snapshot must never fail the
 * forecast (or the cron run) that produced it — but the failure is returned so the caller
 * can log it, because a silently missing week defeats the whole point of the history.
 */
export async function writeForecastSnapshot(
  supabase: SupabaseClient,
  workspaceId: string,
  run: ForecastRunResult,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('forecast_snapshots')
      .insert(snapshotFromForecast(workspaceId, run));
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
