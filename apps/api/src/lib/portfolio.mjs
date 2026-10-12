// buildPortfolio — one compact, LLM-legible view of the whole account portfolio, so the
// agent can answer pipeline questions ("who to re-engage", "where's competitive risk",
// "what's slipping", "the funnel") from a single tool call instead of stitching queries.
// Shared by the in-app agent (playgroundAgent) and the MCP `pipeline` tool.

// The funnel comes from @nous/core (packages/core/src/pipeline.ts) — never a local copy.
// The old local list carried a phantom 'onboarding' stage and no terminals at all, so a
// lost or churned account ranked -1 and reported itself as 'identified'.
import { PIPELINE_LADDER, TERMINAL_STAGES, STAGE_RANK, DEFAULT_STAGE, normalizeStage, isTerminalStage,
  engagementTrend, isEngagementEvent, ENGAGEMENT_DEFS, countRepeatedPromises } from '@nous/core';

const bandOf = (h) => (h == null ? 'unknown' : h >= 90 ? 'won' : h >= 70 ? 'healthy' : h >= 40 ? 'needs_attention' : 'at_risk');
const DAY = 86_400_000;

// The semantic layer: what each field MEANS. Returned alongside the data so the model
// reasons correctly (the "agree on metric definitions first" lesson).
export const PORTFOLIO_METRIC_DEFS = {
  health: 'contextual deal-health 0-100 (won>=90, healthy 70-89, needs_attention 40-69, at_risk<40)',
  icp: 'ICP fit 0-100, learned from won deals',
  // Both lists are interpolated, never typed out: this string is what the model treats
  // as the definition of the field, so a hand-copied stage here would quietly start
  // lying the moment core renames one.
  stage: `furthest pipeline stage across the account contacts (${PIPELINE_LADDER.join(' > ')}); a terminal (${TERMINAL_STAGES.join(', ')}) only shows when no contact is still on the ladder`,
  days_quiet: 'days since last activity (high = going cold)',
  flags: 'open re-engagement flags: fit_cold, buying_signal, went_dark, objection_resolved',
  open_objections: 'count of unresolved objections',
  open_risks: 'live churn risks the customer raised on a call, within their 120-day window; the CS half of attention, absent from deal health',
  departures: 'people who LEFT this account in the last 120 days — the classic churn signal, since the person who chose us is gone',
  commitments_owed: 'open promises WE made to them and have not kept; extracted from calls and closed automatically when the record shows they were kept',
  commitments_overdue: 'of those, the ones past their stated due date — the most actionable thing on this row',
  commitments_repeated: 'distinct promises made to them MORE THAN ONCE across calls, counted over every commitment whether open or closed; one thing promised three times counts once, and a promise closed then made again still counts',
  competitors: 'live/incumbent competitors in play (fired past vendors excluded)',
  ...ENGAGEMENT_DEFS,
};

export async function buildPortfolio(supabase, workspaceId, opts = {}) {
  const { data: contactRows } = await supabase.from('contacts')
    .select('id, company_id, pipeline_stage, last_activity_at')
    .eq('workspace_id', workspaceId).not('company_id', 'is', null);
  const companyIds = [...new Set((contactRows || []).map(r => r.company_id))];
  if (!companyIds.length) return { accounts: [], stage_counts: {}, total: 0, metric_defs: PORTFOLIO_METRIC_DEFS };
  const personCompany = new Map((contactRows || []).map(r => [r.id, r.company_id]));

  const engCutoff = new Date(Date.now() - 60 * DAY).toISOString();
  const [{ data: companies }, { data: flagRows }, { data: claimRows }, { data: evRows }, { data: taskRows }] = await Promise.all([
    supabase.from('companies').select('id, name, domain, deal_health_score, icp_score').in('id', companyIds),
    supabase.from('flags').select('entity_id, flag_type').eq('workspace_id', workspaceId).eq('status', 'open'),
    // Objections and competitors are the sales half. `risk_signal` is the customer half — what
    // they said on a business review, a training call, or an inbound email — and `staff_change`
    // because a departure is the classic churn signal (GET-290, GET-327). The category, not the
    // `health_risk` tag, since GET-401: a cancellation Noema pulls out of a Gmail thread carries
    // no tag and must count here too (GET-402).
    supabase.from('claims').select('entity_id, value').eq('workspace_id', workspaceId)
      .like('property', 'note.%').is('invalid_at', null)
      .in('value->>category', ['objection', 'competitor', 'staff_change', 'risk_signal']),
    // 60d of interaction events for the engagement trend (recent 30 vs prior 30).
    supabase.from('observations').select('entity_id, property, observed_at')
      .eq('workspace_id', workspaceId).eq('kind', 'event').gte('observed_at', engCutoff).limit(20000),
    // What we still owe them. A commitment extracted from a call is a task (GET-193), and an
    // account you owe something is an account needing attention — a fact this view could not see.
    // observed_at is selected because recurrence needs an ORDER: a cluster's "first said" and
    // "last said" are meaningless without one. callScore writes the CALL's date here, not the
    // run's, so a backfilled meeting orders where it actually happened.
    supabase.from('observations').select('entity_id, value, observed_at')
      .eq('workspace_id', workspaceId).eq('kind', 'state')
      .like('property', 'action_item.%').limit(20000),
  ]);

  const now = Date.now();
  const g = new Map();
  // r/s = best rank + stage on the ladder, tr/ts = the same for terminal exits. They are
  // tracked apart on purpose: see the read-out below.
  const ensure = (id) => { if (!g.has(id)) g.set(id, { r: -1, s: null, tr: -1, ts: null, last: null, f: new Set(), obj: 0, c: new Set(), total: 0, engaged: 0, recent: 0, prior: 0, risk: 0, dep: 0, owed: 0, overdue: 0, promises: [] }); return g.get(id); };
  for (const c of contactRows || []) {
    const x = ensure(c.company_id);
    // Rows have not been migrated yet, so they still hold aware/evaluating/proposal/client.
    // normalizeStage maps those onto the current funnel; anything unreadable is a new contact.
    const st = normalizeStage(c.pipeline_stage) || DEFAULT_STAGE;
    const r = STAGE_RANK[st];
    if (isTerminalStage(st)) { if (r > x.tr) { x.tr = r; x.ts = st; } }
    else if (r > x.r) { x.r = r; x.s = st; }
    if (c.last_activity_at && (!x.last || new Date(c.last_activity_at) > new Date(x.last))) x.last = c.last_activity_at;
    x.total++;
    if (c.last_activity_at && (now - new Date(c.last_activity_at).getTime()) / DAY <= 45) x.engaged++;
  }
  // Engagement trend: tally recent-30 vs prior-30 interaction events per company.
  for (const ev of evRows || []) {
    const type = String(ev.property || '').replace(/^interaction\./, '');
    if (!isEngagementEvent(type)) continue;
    const compId = companyIds.includes(ev.entity_id) ? ev.entity_id : personCompany.get(ev.entity_id);
    if (!compId) continue;
    const x = ensure(compId);
    const age = (now - new Date(ev.observed_at).getTime()) / DAY;
    if (age <= 30) x.recent++; else if (age <= 60) x.prior++;
  }
  for (const f of flagRows || []) { const x = g.get(f.entity_id); if (x) x.f.add(f.flag_type); }
  // Only what WE owe and have not done. Theirs is worth knowing and is not our follow-up.
  for (const t of taskRows || []) {
    const v = t.value ?? {};
    const cid = companyIds.includes(t.entity_id) ? t.entity_id : personCompany.get(t.entity_id);
    if (!cid) continue;
    const x = ensure(cid);
    // Recurrence is counted over EVERY commitment, open or closed. A promise we closed and
    // then made again is the worst version of this, not an error — and "only look at the open
    // ones" misses it exactly when it matters most.
    if (v.title) x.promises.push({ title: v.title, owner_kind: v.owner_kind ?? null, at: v.recorded_at ?? t.observed_at ?? null });
    if (v.status !== 'open' || v.owner_kind === 'prospect') continue;
    x.owed++;
    if (v.due_at && Date.parse(v.due_at) < now) x.overdue++;
  }
  for (const cl of claimRows || []) {
    const cat = (cl.value?.category || '').toLowerCase();
    const cid = companyIds.includes(cl.entity_id) ? cl.entity_id : personCompany.get(cl.entity_id);
    if (!cid) continue;
    const x = ensure(cid);
    const meta = cl.value?.metadata ?? {};
    if (cat === 'objection' && (meta.status || 'open') === 'open') x.obj++;
    else if (cat === 'competitor' && meta.stance !== 'past_failure' && meta.entity) x.c.add(meta.entity);
    // A risk decays on its own window (120d, accountHealthState) — one nobody has repeated in four
    // months is history, and an attention list carrying January's churn scare stops being read.
    else if (cat === 'risk_signal') {
      const at = Date.parse(meta.occurred_at ?? '') || 0;
      if (at && (now - at) / DAY <= 120) x.risk++;
    }
    else if (cat === 'staff_change' && meta.change === 'left') {
      const at = Date.parse(meta.occurred_at ?? '') || 0;
      if (at && (now - at) / DAY <= 120) x.dep++;
    }
  }

  const stage_counts = {};
  const accounts = (companies || []).map(co => {
    const x = g.get(co.id) || {};
    // A live rung beats an exit: one disqualified contact must not bury an account that
    // still has a deal moving. Fall back to the exit only when nothing is past the floor,
    // so a wholly lost/churned account reports that instead of pretending to be new.
    const stage = (x.r > 0 ? x.s : null) || x.ts || DEFAULT_STAGE;
    stage_counts[stage] = (stage_counts[stage] || 0) + 1;
    return {
      id: co.id, name: co.name, domain: co.domain || null,
      health: co.deal_health_score ?? null, band: bandOf(co.deal_health_score),
      icp: co.icp_score ?? null, stage,
      days_quiet: x.last ? Math.round((now - new Date(x.last).getTime()) / DAY) : null,
      flags: [...(x.f || [])], open_objections: x.obj || 0, competitors: [...(x.c || [])],
      engagement_trend: engagementTrend(x.recent || 0, x.prior || 0),
      engaged_contacts: x.engaged || 0, total_contacts: x.total || 0,
      single_threaded: (x.engaged || 0) <= 1,
      // The customer half. Every field above answers "is this deal moving"; these answer "is this
      // customer in trouble, and do we owe them anything" — which this view could not see at all,
      // so an account whose champion had left and who was owed two things looked healthy.
      open_risks: x.risk || 0,
      departures: x.dep || 0,
      commitments_owed: x.owed || 0,
      commitments_overdue: x.overdue || 0,
      commitments_repeated: countRepeatedPromises(x.promises),
    };
  });
  // Most-actionable first. An overdue promise and a live churn risk outrank a middling deal score:
  // they are things a person can act on today, and the score is a summary of things they cannot.
  // Deal health still breaks the tie, so nothing that used to sort sensibly stops doing so.
  //
  // A promise made twice sorts above one that is merely late. Late is a scheduling problem;
  // said-again is the customer telling you, a second time, that you did not do the thing.
  accounts.sort((a, b) =>
    (b.commitments_repeated - a.commitments_repeated) ||
    (b.commitments_overdue - a.commitments_overdue) ||
    ((b.open_risks + b.departures) - (a.open_risks + a.departures)) ||
    ((a.health ?? 999) - (b.health ?? 999)) ||
    ((b.days_quiet ?? 0) - (a.days_quiet ?? 0)));
  const limited = opts.limit ? accounts.slice(0, opts.limit) : accounts;
  return { accounts: limited, stage_counts, total: accounts.length, metric_defs: PORTFOLIO_METRIC_DEFS };
}
