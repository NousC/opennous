import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScorecardSignal } from '../types.js';
import type { IcpTier, TierThresholds } from '../db/scorecard.js';
import { icpSignals, listSignals, scoreTier, DEFAULT_TIER_THRESHOLDS, TIER_META } from '../db/scorecard.js';
import { getTierThresholds } from '../db/externalScores.js';
import { scoreLead, modelVersion } from './scorecard.js';
import { hasScoreableFeature } from './predictions.js';

// Backtest the ICP score on closed deals (GET-1074). Forward grading only sees deals
// that close after a prediction, so a workspace with years of closed deals would wait
// months to learn whether its ICP predicts anything. This scores each closed deal the
// way the live scorer would score its account today and grades it on the known outcome.
//
// Each deal is scored by its best-fitting contact (person claims plus the company
// features they inherit, built the way buildEntityFeatures does), under the ICP rules
// only: fit plus exclusions, never timing or engagement, which would leak the outcome.
// A deal with no scoreable feature is counted in coverage, never scored as a hollow 50.
//
// Contact coverage is controlled for. Won accounts carry more contacts in the CRM, so a
// best-of-contacts score gets more chances to match a title rule on a won deal. Every
// lift is therefore also given within contact-count strata (Mantel-Haenszel), and the
// accuracy verdict reads the controlled number, never the raw one.
//
// Honest limit: claims are not dated, so this uses today's titles and firmographics as
// a stand-in for what was true when the deal was open. Fine for slow-moving facts
// (industry, role), wrong for anything that changes because the deal was won.

export interface BacktestDeal {
  id: string;
  outcome: 'won' | 'lost';
  closedAt?: string | null;
  /** One feature map per contact; the company's own features when it has no contacts. */
  contacts: Record<string, unknown>[];
  /** Contacts on file at the account (defaults to contacts.length). */
  contactCount?: number;
}

export interface BacktestRow {
  id: string;
  outcome: 'won' | 'lost';
  closedAt: string | null;
  score: number;
  tier: IcpTier;
  fired: string[];
  contacts: number;
}

export interface BacktestRule {
  key: string;
  label: string;
  weight: number;
  feature: string | null;
  fired_won: number;
  fired_lost: number;
  not_won: number;
  not_lost: number;
  /** winRate(fired) / winRate(not fired); null when either side has no deals or no wins. */
  lift: number | null;
  /** The same, within contact-count strata. */
  controlled_lift: number | null;
  impact: 'positive' | 'none' | 'negative' | 'too_few' | 'no_data';
}

export type AccuracyKey = 'validated' | 'weak' | 'not_validated' | 'insufficient';
export const ACCURACY_LABEL: Record<AccuracyKey, string> = {
  validated: 'Validated', weak: 'Weak', not_validated: 'Not validated', insufficient: 'Insufficient data',
};
export const IMPACT_LABEL: Record<BacktestRule['impact'], string> = {
  positive: 'Positive', none: 'No impact', negative: 'Negative', too_few: 'Too few deals', no_data: 'No data',
};

export interface BacktestResult {
  coverage: { won: { total: number; scored: number }; lost: { total: number; scored: number } };
  rows: BacktestRow[];
  rules: BacktestRule[];
  tiers: { tier: IcpTier; label: string; won: number; lost: number; rate: number | null }[];
  strata: { label: string; fit: { won: number; lost: number; rate: number | null }; rest: { won: number; lost: number; rate: number | null } }[];
  accuracy: {
    key: AccuracyKey; label: string;
    win_rate: number | null; fit_rate: number | null; rest_rate: number | null;
    raw_ratio: number | null; controlled_ratio: number | null;
    median_contacts: { won: number | null; lost: number | null };
  };
  disqualifiers: { key: string; label: string; feature: string | null; capped: number; won: number; status: 'review' | 'working' | 'no_data' }[];
  data_coverage: { key: string; label: string; share: number }[];
  recommendations: { text: string; meta: string }[];
  /** Earliest and latest close among the scored deals. */
  period: { from: string | null; to: string | null };
}

// Contact-count strata. Fixed edges so runs compare over time.
const STRATA: { label: string; max: number }[] = [
  { label: '0–1 contacts', max: 1 }, { label: '2–3 contacts', max: 3 }, { label: '4–7 contacts', max: 7 }, { label: '8+ contacts', max: Infinity },
];
const stratumOf = (n: number) => STRATA.findIndex(s => n <= s.max);

const MIN_DEALS = 20, MIN_WON = 5, MIN_FIRES = 10;
// A ratio with no wins on the unexposed side is unbounded: the strongest result, not a missing
// one. It is reported at this cap (read as "10× or more"); only 0/0 is null.
export const RATIO_CAP = 10;
const ratio = (a: number, b: number) => (b > 0 ? Math.min(RATIO_CAP, round1(a / b)) : a > 0 ? RATIO_CAP : null);
const round1 = (x: number) => Math.round(x * 10) / 10;
const rate = (w: number, l: number) => (w + l ? Math.round((w / (w + l)) * 1000) / 1000 : null);
const isFit = (t: IcpTier) => t === 'tier_1' || t === 'tier_2';
const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** Mantel-Haenszel risk ratio of winning, exposed vs not, across contact strata. */
function mhRatio(rows: BacktestRow[], exposed: (r: BacktestRow) => boolean): number | null {
  let num = 0, den = 0;
  for (let i = 0; i < STRATA.length; i++) {
    const s = rows.filter(r => stratumOf(r.contacts) === i);
    const e = s.filter(exposed), u = s.filter(r => !exposed(r));
    if (!e.length || !u.length) continue;
    const a = e.filter(r => r.outcome === 'won').length, c = u.filter(r => r.outcome === 'won').length;
    num += (a * u.length) / s.length;
    den += (c * e.length) / s.length;
  }
  return ratio(num, den);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Feature → the words a VP Sales would use for it.
const FEATURE_LABEL: Record<string, string> = {
  job_title: 'Contact job title', seniority: 'Seniority', department: 'Department',
  industry: 'Industry', employee_count: 'Company size', keywords: 'Company keywords',
  description: 'Company description', country: 'Country',
};
const coverageKey = (f: string) => (f.startsWith('exclusion.') ? 'website_review' : f.startsWith('signal.') ? 'buying_signals' : f);
const coverageLabel = (k: string) => (k === 'website_review' ? 'Website review' : k === 'buying_signals' ? 'Buying signals' : FEATURE_LABEL[k] ?? k.replace(/[._]/g, ' '));

export function backtestIcp(
  deals: BacktestDeal[],
  signals: ScorecardSignal[],
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): BacktestResult {
  const rules = icpSignals(signals.filter(s => s.active));
  const coverage = { won: { total: 0, scored: 0 }, lost: { total: 0, scored: 0 } };
  const rows: BacktestRow[] = [];
  const seen = new Map<string, number>();   // coverage key -> deals with it on file

  for (const d of deals) {
    coverage[d.outcome].total++;
    const keys = new Set<string>();
    for (const f of d.contacts) for (const [k, v] of Object.entries(f)) if (present(v)) keys.add(coverageKey(k));
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);

    let best: { score: number; fired: string[] } | null = null;
    for (const features of d.contacts) {
      if (!hasScoreableFeature(features)) continue;
      const r = scoreLead(features, rules);
      if (!best || r.score > best.score) best = { score: r.score, fired: r.fired.map(f => f.key) };
    }
    if (!best) continue;
    coverage[d.outcome].scored++;
    rows.push({
      id: d.id, outcome: d.outcome, closedAt: d.closedAt ?? null, score: best.score,
      tier: scoreTier(best.score, thresholds)!, fired: best.fired, contacts: d.contactCount ?? d.contacts.length,
    });
  }

  const won = rows.filter(r => r.outcome === 'won').length, lost = rows.length - won;

  const ruleStats: BacktestRule[] = rules.filter(s => !s.rule?.disqualify).map(s => {
    const st = { fired_won: 0, fired_lost: 0, not_won: 0, not_lost: 0 };
    for (const row of rows) {
      const on = row.fired.includes(s.key);
      if (row.outcome === 'won') on ? st.fired_won++ : st.not_won++;
      else on ? st.fired_lost++ : st.not_lost++;
    }
    const a = rate(st.fired_won, st.fired_lost), b = rate(st.not_won, st.not_lost);
    const lift = a != null && b != null ? ratio(a, b) : null;
    const fires = st.fired_won + st.fired_lost;
    const controlled = fires ? mhRatio(rows, r => r.fired.includes(s.key)) : null;
    const impact: BacktestRule['impact'] = fires === 0 ? 'no_data'
      : fires < MIN_FIRES || controlled == null ? 'too_few'
      : controlled >= 1.2 ? 'positive' : controlled <= 0.85 ? 'negative' : 'none';
    return { key: s.key, label: s.label, weight: s.weight, feature: s.rule?.feature ?? null, ...st, lift, controlled_lift: controlled, impact };
  });

  const tiers = (['tier_1', 'tier_2', 'tier_3', 'not_icp'] as IcpTier[]).map(t => {
    const w = rows.filter(r => r.tier === t && r.outcome === 'won').length;
    const l = rows.filter(r => r.tier === t && r.outcome === 'lost').length;
    return { tier: t, label: TIER_META[t].label, won: w, lost: l, rate: rate(w, l) };
  });

  const side = (rs: BacktestRow[]) => { const w = rs.filter(r => r.outcome === 'won').length; return { won: w, lost: rs.length - w, rate: rate(w, rs.length - w) }; };
  const strata = STRATA.map((s, i) => {
    const inS = rows.filter(r => stratumOf(r.contacts) === i);
    return { label: s.label, fit: side(inS.filter(r => isFit(r.tier))), rest: side(inS.filter(r => !isFit(r.tier))) };
  });

  const fit = side(rows.filter(r => isFit(r.tier))), rest = side(rows.filter(r => !isFit(r.tier)));
  const raw = fit.rate != null && rest.rate != null ? ratio(fit.rate, rest.rate) : null;
  const controlled = mhRatio(rows, r => isFit(r.tier));
  const key: AccuracyKey = rows.length < MIN_DEALS || won < MIN_WON || controlled == null ? 'insufficient'
    : controlled >= 1.5 ? 'validated' : controlled > 1.1 ? 'weak' : 'not_validated';
  const accuracy = {
    key, label: ACCURACY_LABEL[key], win_rate: rate(won, lost), fit_rate: fit.rate, rest_rate: rest.rate,
    raw_ratio: raw, controlled_ratio: controlled,
    median_contacts: { won: median(rows.filter(r => r.outcome === 'won').map(r => r.contacts)), lost: median(rows.filter(r => r.outcome === 'lost').map(r => r.contacts)) },
  };

  const overall = rate(won, lost) ?? 0;
  const disqualifiers = rules.filter(s => s.rule?.disqualify).map(s => {
    const capped = rows.filter(r => r.fired.includes(s.key));
    const w = capped.filter(r => r.outcome === 'won').length;
    const status: 'review' | 'working' | 'no_data' = !capped.length ? 'no_data'
      : capped.length >= MIN_FIRES && w > 0 && w / capped.length >= overall * 0.8 ? 'review' : 'working';
    return { key: s.key, label: s.label, feature: s.rule?.feature ?? null, capped: capped.length, won: w, status };
  });

  const featureKeys = [...new Set(rules.map(s => s.rule?.feature).filter((f): f is string => !!f).map(coverageKey))];
  const data_coverage = featureKeys
    .map(k => ({ key: k, label: coverageLabel(k), share: deals.length ? Math.round(((seen.get(k) ?? 0) / deals.length) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.share - a.share);

  const recommendations: { text: string; meta: string }[] = [];
  const missing = new Map<string, number>();
  for (const r of [...ruleStats, ...disqualifiers]) {
    if (!r.feature) continue;
    const k = coverageKey(r.feature);
    if ((data_coverage.find(c => c.key === k)?.share ?? 0) < 0.05) missing.set(k, (missing.get(k) ?? 0) + 1);
  }
  if (missing.size) {
    const n = [...missing.values()].reduce((a, b) => a + b, 0);
    const what = [...missing.keys()].map(k => coverageLabel(k).toLowerCase()).slice(0, 3).join(', ');
    recommendations.push({ text: `Capture ${what} in account research`, meta: `${n} criteria unlocked` });
  }
  for (const r of ruleStats) {
    if (r.weight > 0 && r.impact === 'negative') recommendations.push({ text: `Reduce weight: ${r.label}`, meta: 'Negative impact' });
    if (r.weight < 0 && r.impact === 'positive') recommendations.push({ text: `Review weight: ${r.label}`, meta: 'Positive impact' });
  }
  for (const d of disqualifiers) if (d.status === 'review') recommendations.push({ text: `Review disqualifier: ${d.label}`, meta: `${d.won} won deals capped` });

  const dates = rows.map(r => r.closedAt).filter((d): d is string => !!d).sort();
  const period = { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };

  return { coverage, rows, rules: ruleStats, tiers, strata, accuracy, disqualifiers, data_coverage, recommendations, period };
}

// ── Loading, saving, reading ──────────────────────────────────────────────────

// The same features the live path builds (db/predictions.ts buildEntityFeatures).
const COMPANY_FEATURES = ['industry', 'employee_count', 'keywords', 'description'];
const SCOREABLE = ['job_title', 'seniority', 'department', 'industry', 'employee_count'];
const DEALS_SHOWN = 50;

type Row = Record<string, any>;
const chunks = <T>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function all(build: () => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

export interface IcpBacktestDealRow {
  id: string; entity_id: string; account: string | null; domain: string | null;
  contacts: string[]; contacts_total: number; outcome: 'won' | 'lost';
  tier: IcpTier; score: number; matched: string[]; value_usd: number | null; closed_at: string;
}

export interface IcpBacktestRun {
  workspace_id: string;
  model_version: string;
  ran_at: string;
  result: Omit<BacktestResult, 'rows'> & { deals: IcpBacktestDealRow[] };
}

/** Load every won/lost deal, build each account's contacts the live way, and backtest. Read-only. */
export async function runIcpBacktest(supabase: SupabaseClient, ws: string, { now = new Date() } = {}): Promise<IcpBacktestRun | null> {
  const signals = await listSignals(supabase, ws, { activeOnly: true });
  if (!signals.length) return null;
  const thresholds = await getTierThresholds(supabase, ws);

  const deals = await all(() => supabase.from('deal_outcomes').select('id, entity_id, outcome, closed_at, value_usd')
    .eq('workspace_id', ws).in('outcome', ['won', 'lost']));
  if (!deals.length) return null;

  // Deal entity → its company (belongs_to); a company-level deal is its own company.
  const companyOf = new Map<string, string>(deals.map(d => [d.entity_id, d.entity_id]));
  for (const grp of chunks([...companyOf.keys()], 200)) {
    const rels = await all(() => supabase.from('relationships').select('id, from_entity_id, to_entity_id')
      .eq('workspace_id', ws).eq('type', 'belongs_to').is('valid_to', null).in('from_entity_id', grp));
    for (const r of rels) companyOf.set(r.from_entity_id, r.to_entity_id);
  }
  const companies = [...new Set(companyOf.values())];

  const peopleOf = new Map<string, string[]>();
  for (const grp of chunks(companies, 200)) {
    const rels = await all(() => supabase.from('relationships').select('id, from_entity_id, to_entity_id')
      .eq('workspace_id', ws).eq('type', 'works_at').is('valid_to', null).in('to_entity_id', grp));
    for (const r of rels) (peopleOf.get(r.to_entity_id) ?? peopleOf.set(r.to_entity_id, []).get(r.to_entity_id)!).push(r.from_entity_id);
  }

  const claimsFor = async (ids: string[], filter: (q: any) => any) => {
    const by = new Map<string, Row[]>();
    for (const grp of chunks(ids, 200)) {
      const rows = await all(() => filter(supabase.from('claims').select('id, entity_id, property, value')
        .eq('workspace_id', ws).in('entity_id', grp).is('invalid_at', null)));
      for (const c of rows) (by.get(c.entity_id) ?? by.set(c.entity_id, []).get(c.entity_id)!).push(c);
    }
    return by;
  };
  const personProps = [...new Set([...signals.map(s => s.rule?.feature).filter((f): f is string => !!f), ...SCOREABLE])];
  const companyClaims = await claimsFor(companies, q => q.or(
    `property.in.(${COMPANY_FEATURES.join(',')}),property.like.signal.%,property.like.exclusion.%`));
  const personClaims = await claimsFor([...new Set([...peopleOf.values()].flat())], q => q.in('property', personProps));

  // Company features a person inherits, built like buildEntityFeatures.
  const inherited = (companyId: string) => {
    const f: Record<string, unknown> = {};
    for (const c of companyClaims.get(companyId) || []) {
      if (COMPANY_FEATURES.includes(c.property)) f[c.property] = c.value;
      else if (c.property.startsWith('signal.')) { if (typeof c.value?.score === 'number') f[c.property] = c.value.score; }
      else if (c.property.startsWith('exclusion.')) { if (c.value?.matched !== false) f[c.property] = c.value ?? true; }
    }
    return f;
  };

  const input: BacktestDeal[] = deals.map(d => {
    const company = companyOf.get(d.entity_id)!;
    const base = inherited(company);
    const people = peopleOf.get(company) || [];
    const contacts = people.length
      ? people.map(p => { const f: Record<string, unknown> = {}; for (const c of personClaims.get(p) || []) f[c.property] = c.value; return { ...f, ...base }; })
      : [base];
    return { id: d.id, outcome: d.outcome, closedAt: d.closed_at, contacts, contactCount: people.length };
  });

  const { rows, ...result } = backtestIcp(input, signals, thresholds);

  // The most recent closes, named, for the page's table.
  const byId = new Map(deals.map(d => [d.id, d]));
  const recent = [...rows].sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, DEALS_SHOWN);
  const shownCompanies = [...new Set(recent.map(r => companyOf.get(byId.get(r.id)!.entity_id)!))];
  const names = new Map<string, Row>();
  const contactNames = new Map<string, string[]>();
  // entity_list_rows has no `id`; page it by entity_id.
  const listRows = async (build: () => any): Promise<Row[]> => {
    const out: Row[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().order('entity_id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  };
  for (const grp of chunks(shownCompanies, 200)) {
    for (const a of await listRows(() => supabase.from('entity_list_rows').select('entity_id, name, domain').eq('workspace_id', ws).in('entity_id', grp))) names.set(a.entity_id, a);
    for (const p of await listRows(() => supabase.from('entity_list_rows').select('entity_id, name, company_id').eq('workspace_id', ws).eq('kind', 'person').in('company_id', grp))) {
      if (p.name) (contactNames.get(p.company_id) ?? contactNames.set(p.company_id, []).get(p.company_id)!).push(p.name);
    }
  }
  const labelOf = new Map(signals.map(s => [s.key, s.label]));
  const shown: IcpBacktestDealRow[] = recent.map(r => {
    const d = byId.get(r.id)!;
    const company = companyOf.get(d.entity_id)!;
    const a = names.get(company);
    const people = contactNames.get(company) ?? [];
    return {
      id: r.id, entity_id: company, account: a?.name ?? null, domain: a?.domain ?? null,
      contacts: people.slice(0, 3), contacts_total: people.length, outcome: r.outcome,
      tier: r.tier, score: r.score, matched: r.fired.map(k => labelOf.get(k) ?? k),
      value_usd: d.value_usd == null ? null : Number(d.value_usd), closed_at: d.closed_at,
    };
  });

  return { workspace_id: ws, model_version: modelVersion(signals), ran_at: now.toISOString(), result: { ...result, deals: shown } };
}

export async function saveIcpBacktest(supabase: SupabaseClient, run: IcpBacktestRun): Promise<void> {
  const { error } = await supabase.from('icp_backtests').insert({
    workspace_id: run.workspace_id, model_version: run.model_version, ran_at: run.ran_at, result: run.result,
  });
  if (error) throw new Error(`failed to save ICP backtest: ${error.message}`);
}

export async function latestIcpBacktest(supabase: SupabaseClient, ws: string): Promise<IcpBacktestRun | null> {
  const { data } = await supabase.from('icp_backtests').select('workspace_id, model_version, ran_at, result')
    .eq('workspace_id', ws).order('ran_at', { ascending: false }).limit(1);
  return (data?.[0] as IcpBacktestRun | undefined) ?? null;
}

/** Workspaces with closed deals and an ICP scorecard: the ones worth backtesting. */
export async function workspacesToBacktest(supabase: SupabaseClient): Promise<string[]> {
  const rows = await all(() => supabase.from('deal_outcomes').select('id, workspace_id').in('outcome', ['won', 'lost']));
  return [...new Set(rows.map(r => r.workspace_id as string))];
}
