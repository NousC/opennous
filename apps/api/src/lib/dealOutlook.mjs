// Deal outlook — deal HEALTH next to how LIKELY a deal is to close, and why. For one deal, or
// for the open book ranked by "most likely to close in the next N days".
//
// Two numbers from two engines, on purpose, kept side by side rather than blended:
//   health      @nous/core computeDealHealth — how the deal is going right now (competitors, blockers,
//               urgency, buy-in, engagement). A state, not odds.
//   likelihood  @nous/core runDealOutlook — the stage base rate moved by the win model's facts,
//               each fact a driver with its size, plus the timing half for "within N days".
//               The same scoring the forecast uses, so the two can never disagree.
//
// No amounts and no totals: this is not the forecast.

import { runDealOutlook, loadAccountHealth } from '@nous/core';
import { explainIcp } from './icpExplain.mjs';


export const DEFAULT_WITHIN_DAYS = 30;
const MAX_LIST = 25;
const HEALTH_CONCURRENCY = 4;

export function clampWithinDays(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : DEFAULT_WITHIN_DAYS;
}

/** A probability as a readable percent: whole numbers, one decimal under 1%. */
export function toPct(p) {
  if (p == null || !Number.isFinite(p)) return null;
  const v = p * 100;
  return v < 1 ? Math.round(v * 10) / 10 : Math.round(v);
}

const stageLabel = (s) => String(s || '').replace(/_/g, ' ');
const whole = (n) => Math.round(Number(n) || 0);

/** The plain-language fact behind one win-model driver. */
export function driverLabel(key, deal) {
  const f = deal.facts || {};
  switch (key) {
    case 'age_ratio':
      return deal.medianDaysInStage != null
        ? `${whole(deal.daysInStage)}d in ${stageLabel(deal.stage)} (typical ${whole(deal.medianDaysInStage)}d)`
        : `${whole(deal.daysInStage)}d in ${stageLabel(deal.stage)}`;
    case 'days_quiet':         return `quiet ${whole(f.daysQuiet)} days`;
    case 'engagement_trend':   return `engagement ${f.engagementTrend}`;
    case 'icp_fit':            return `ICP fit ${whole(f.icpFit)}`;
    case 'icp_pain':           return `pain ${whole(f.icpPain)}/100`;
    case 'icp_ability':        return `ability to buy ${whole(f.icpAbility)}/100`;
    case 'intent':             return `intent ${whole(f.intentScore)}`;
    case 'stakeholders':       return `${f.stakeholderCount} people involved`;
    case 'single_threaded':    return f.engagedCount === 0 ? 'nobody engaged in the last 45 days' : 'single-threaded (one person engaged)';
    case 'open_objections':    return `${f.openObjections} open objection${f.openObjections === 1 ? '' : 's'}`;
    case 'competitor_present': return 'competitor in play';
    case 'inbound':            return 'came in inbound';
    default:                   return String(key).replace(/_/g, ' ');
  }
}

/** "+6 pts ICP fit 88" — direction, size in points of P(win), and the fact. Biggest first. */
export function describeDrivers(deal, max = 5) {
  return (deal.drivers || []).slice(0, max).map((d) => {
    const abs = Math.abs(d.pts);
    const size = abs >= 1 ? String(Math.round(abs)) : abs >= 0.1 ? String(abs) : '<0.1';
    return `${d.logit > 0 ? '+' : '-'}${size} pts ${driverLabel(d.key, deal)}`;
  });
}

/**
 * Health for an answer. The list wants the score and only what is NOT fine (the "watch" lines);
 * one account wants all four signals and the engagement read.
 */
export function shapeHealth(dh, { full = false } = {}) {
  if (!dh) return null;
  const smart = dh.smart || [];
  if (!full) {
    return {
      score: dh.score, band: dh.band,
      watch: smart.filter((s) => s.tone !== 'good').map((s) => `${s.label} ${s.level}: ${s.reason}`),
    };
  }
  return {
    score: dh.score, band: dh.band,
    signals: smart.map((s) => ({ signal: s.label, level: s.level, reason: s.reason })),
    engagement: Object.fromEntries((dh.numeric || []).map((n) => [n.key, n.value])),
  };
}

// How the odds are said (GET-832). A percentage is only shown once the win model is fitted on this
// workspace's own closed deals. Before that it is the stage priors times hand-set nudges: every
// early-stage deal lands near 10-15% whatever its health, and "8% to win" next to "health 79"
// reads as nonsense. So until then the odds are a RANK among the open deals ("3rd of 12"), which
// is all the number can honestly support, with what is helping and hurting in plain words.
export const oddsBasis = (out) => (out?.winModel?.basis === 'fitted' ? 'percent' : 'rank');

const ORD = { 1: 'st', 2: 'nd', 3: 'rd' };
/** 1 → "1st", 12 → "12th", 23 → "23rd". */
export function ordinal(n) {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? 'th' : ORD[n % 10] ?? 'th'}`;
}

/** The drivers as plain facts, no points: what is helping the deal close, what is hurting it. */
export function splitDrivers(deal, max = 4) {
  const helping = [], hurting = [];
  for (const d of deal.drivers || []) {
    if (Math.abs(d.pts) < 0.5) continue; // too small to be worth saying
    (d.logit > 0 ? helping : hurting).push(driverLabel(d.key, deal));
  }
  return { helping: helping.slice(0, max), hurting: hurting.slice(0, max) };
}

/** What the percentages rest on, said plainly so an assumption never reads like evidence. */
export function modelNotes({ winModel, stageRatesBasis }) {
  const notes = [];
  if (winModel?.basis !== 'fitted') {
    // No percentage is shown on default weights (see oddsBasis), so the note says why there isn't one.
    return ["Odds are a rank among the open deals, not a percentage: a percentage only means something once it is learned from this workspace's own won and lost deals, and there are not enough of those yet."];
  }
  if (stageRatesBasis === 'prior') notes.push('Stage conversion rates are mostly assumed; there is little closed history per stage yet.');
  else if (stageRatesBasis === 'blended') notes.push("Stage conversion rates blend this workspace's own history with assumed rates.");
  return notes;
}

/** Whether "within N days" could be judged for this deal, in words. */
export function timingLabel(d) {
  if (d.timingBasis === 'judged') return 'judged';
  if (d.timingBasis === 'too_few_wins') {
    return `not judged: only ${d.timingWins} won deal${d.timingWins === 1 ? '' : 's'} from ${stageLabel(d.stage)} to learn timing from`;
  }
  if (d.timingBasis === 'past_history') {
    return `not judged: every won deal here closed within ${whole(d.timingLastWinDay)}d of reaching ${stageLabel(d.stage)}, and this one has been there ${whole(d.daysInStage)}d`;
  }
  return `not judged: no won deals from ${stageLabel(d.stage)} to learn timing from`;
}

function shapeDeal(d, horizons, { maxDrivers, odds = 'percent', rank = null, of = null }) {
  const base = {
    entity_id: d.entityId,
    name: d.name,
    stage: d.stage,
    days_in_stage: whole(d.daysInStage),
    typical_days_in_stage: d.medianDaysInStage != null ? whole(d.medianDaysInStage) : null,
    odds,
    rank,
    of,
    ...(d.amount != null ? { amount: d.amount } : {}),
  };
  // No percentages at all on default weights: an agent handed one will say it.
  if (odds === 'rank') return { ...base, ...splitDrivers(d, Math.min(maxDrivers, 4)) };
  const within = {};
  for (const h of horizons) within[h] = toPct(d.pWinWithin[h]);
  return {
    ...base,
    win_pct: toPct(d.pWin),
    stage_only_win_pct: toPct(d.pWinBase),
    // Keyed by days. null = timing not judged (see `timing`), so "within N days" cannot be
    // said — never read it as 0.
    close_within_pct: within,
    timing: timingLabel(d),
    why: describeDrivers(d, maxDrivers),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The open book, ranked by chance of closing within N days. `visible` is the viewer's
 * viewerVisibleAccountSet — a restricted member only sees deals in their own book.
 */
export async function dealOutlookList(supabase, workspaceId, { withinDays, limit, visible, persistHealth = true } = {}) {
  const within = clampWithinDays(withinDays);
  const cap = Math.min(Math.max(Math.round(Number(limit)) || 10, 1), MAX_LIST);
  const out = await runDealOutlook(supabase, workspaceId, { horizons: [within] });

  const open = visible && visible.unrestricted === false
    ? out.deals.filter((d) => visible.ids.has(d.entityId))
    : out.deals;
  const top = open.slice(0, cap);
  const health = await mapLimit(top, HEALTH_CONCURRENCY,
    (d) => loadAccountHealth(supabase, workspaceId, d.entityId, { persist: persistHealth }).catch(() => null));
  const timingKnown = open.filter((d) => d.pWinWithin[within] != null).length;
  const odds = oddsBasis(out);

  return {
    within_days: within,
    odds,
    ranked_by: odds === 'rank'
      ? 'how likely each is to close, compared with the other open deals (stage, time in stage, engagement, objections, fit)'
      : timingKnown
      ? `chance of closing within ${within} days; a deal whose timing can't be judged ranks by its overall chance to win, the most its ${within}-day chance could be`
      : `overall chance to win: no stage has enough won deals yet to judge timing within ${within} days`,
    open_deals: open.length,
    timing_known: timingKnown,
    deals: top.map((d, i) => ({
      ...shapeDeal(d, [within], { maxDrivers: 4, odds, rank: i + 1, of: open.length }),
      health: shapeHealth(health[i]),
    })),
    model: { win_weights: out.winModel.basis, stage_rates: out.stageRatesBasis, notes: modelNotes(out) },
  };
}

async function accountName(supabase, workspaceId, accountId) {
  const { data: co } = await supabase.from('companies')
    .select('name, domain').eq('workspace_id', workspaceId).eq('id', accountId).maybeSingle();
  if (co) return co.name || co.domain || null;
  const { data: p } = await supabase.from('contacts')
    .select('first_name, last_name, email').eq('workspace_id', workspaceId).eq('id', accountId).maybeSingle();
  if (!p) return null;
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || null;
}

/**
 * One account: its health in full, and — when it has an open deal — how likely it is to close
 * overall, within N days and within 90, with every driver. The deal lives on the COMPANY a
 * person belongs to, so a person resolves up to their company first.
 */
export async function dealOutlookForAccount(supabase, workspaceId, entityId, { withinDays, persistHealth = true } = {}) {
  const within = clampWithinDays(withinDays);
  const horizons = [...new Set([within, 90])];

  const { data: person } = await supabase.from('contacts')
    .select('company_id').eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();
  const accountId = person?.company_id || entityId;

  const [out, dh, icp] = await Promise.all([
    runDealOutlook(supabase, workspaceId, { horizons }),
    loadAccountHealth(supabase, workspaceId, accountId, { persist: persistHealth }).catch(() => null),
    // "Why does it score that?" is the other half of the question, and the answer lives in a
    // different engine — so it comes back in the same call rather than sending the agent hunting.
    explainIcp(supabase, workspaceId, accountId).catch(() => null),
  ]);
  const base = { entity_id: accountId, ...(accountId !== entityId ? { via_person: entityId } : {}) };
  const model = { win_weights: out.winModel.basis, stage_rates: out.stageRatesBasis, notes: modelNotes(out) };

  const idx = out.deals.findIndex((d) => d.entityId === accountId);
  if (idx >= 0) {
    return {
      ...base,
      status: 'open',
      ...shapeDeal(out.deals[idx], horizons, { maxDrivers: 12, odds: oddsBasis(out), rank: idx + 1, of: out.deals.length }),
      health: shapeHealth(dh, { full: true }),
      icp,
      model,
    };
  }

  const name = await accountName(supabase, workspaceId, accountId);
  const stage = out.stageByAccount.get(accountId) ?? null;
  const health = shapeHealth(dh, { full: true });
  if (stage === 'closed_won') {
    return { ...base, name, status: 'won', stage, health, note: 'Already won, so there is nothing left to forecast.' };
  }
  if (stage) {
    return { ...base, name, status: 'closed', stage, health, note: `The deal is closed (${stageLabel(stage)}), so there is no close likelihood.` };
  }
  return {
    ...base, name, status: 'no_deal', health,
    note: 'No stage-driving activity (a reply, a meeting, a proposal) is recorded on this account, so there is no open deal to judge yet.',
  };
}
