import { Router } from 'express';
import { getSupabaseClient, cachedConversationCredits } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { resolveRequestTeam } from '../../lib/access.mjs';
import { costToCredits, AI_TELEMETRY_FEATURES } from '../../lib/llmUsage.mjs';
import { vendorOfModelId, labelOfModelId } from '../../lib/model.mjs';
import { isSelfHosted, periodStartFor, RETRIEVAL_EVENT_TYPES, backfillWindowsFor } from '../../lib/plans.mjs';
import { loadTeamUsage } from '../../lib/usageSummary.mjs';
import { usageByKeyHandler } from './apiKeyUsage.mjs';
import { activityHandler, activityCallsHandler } from './apiActivity.mjs';

export const usageRouter = Router();

// GET /api/usage
// Ops-only usage for the current team. Ops are summed from the live op log
// (workspace_system_log.billable_ops) over the current billing period.
// The billing panel, as it stood a moment ago (GET-312).
//
// Every page in the app asks for this on every navigation, and answering it costs a dozen round
// trips — subscription, four meters, an all-time ops RPC, a legacy count, the workspace list. On a
// database that takes ~130ms to answer anything, that was 2.2 seconds in front of every screen.
//
// None of it changes second to second: a plan, a period, an account count. Fifteen seconds of
// memory removes the repeat cost for the burst of calls one navigation makes, while a real change
// (an upgrade, an account crossing the limit) still lands within a page or two. Per team AND per
// workspace, because the answer names a workspace.
const usageCache = new Map();
const USAGE_TTL_MS = 15_000;

/**
 * The billing panel's body for one team. The meters come from loadTeamUsage (lib/usageSummary.mjs),
 * the same read behind GET /v2/usage and whoami's budget line, so the three cannot disagree.
 */
export async function apiUsageBody(supabase, team, reqWorkspaceId) {
  const { subscription, plan, ops, enrichments, accounts, aiCredits } = await loadTeamUsage(supabase, team);

  // All-time ops total — the Mind-page lifetime counter. Sums billable_ops
  // from the live op log, PLUS the legacy memory_ops_log rows (each = 1 op)
  // written by the pre-Billing-v2 app, so the lifetime figure stays
  // continuous. This is display-only — billing uses getTeamOpsUsage above,
  // which is period-scoped and never counts these legacy rows.
  const [{ data: allTimeData }, legacyRes] = await Promise.all([
    supabase.rpc('team_ops_used', { p_team_id: team.id, p_since: '1970-01-01T00:00:00Z' }),
    supabase.from('memory_ops_log').select('id', { count: 'exact', head: true }).eq('team_id', team.id),
  ]);
  const allTimeOps = Number(allTimeData ?? 0) + Number(legacyRes?.count ?? 0);

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .eq('team_id', team.id);
  const workspaceCount = workspaces?.length || 0;
  const workspaceId = reqWorkspaceId || workspaces?.[0]?.id;

  return {
    plan: plan.id,
    planName: plan.name,
    // Self-host has no plans. The frontend uses this to stop gating anything —
    // an operator running their own instance can do everything, which mirrors
    // isSelfHosted() on the API side.
    selfHosted: isSelfHosted(),
    subscription: subscription
      ? {
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: subscription.cancel_at_period_end,
          stripe_subscription_id: subscription.stripe_subscription_id,
        }
      : null,
    // THE meter. Companies we've actually had a conversation with — the only
    // thing that costs us money, so the only thing we charge for.
    // `included: null` = unlimited (Custom, self-host).
    activeAccounts: {
      used:       accounts.used,
      included:   accounts.included,
      remaining:  accounts.remaining === Infinity ? null : accounts.remaining,
      percentUsed: accounts.percentUsed,
      state:      accounts.state,     // ok | warn | grace | restricted
      graceUntil: accounts.graceUntil,
      graceDays:  accounts.graceDays,
    },
    // Display-only from 2026-07-13. Retrievals are unlimited on every plan —
    // they're deterministic Postgres reads with no model in the path, so they
    // cost us nothing. Kept as a stat ("you made N retrievals this month"),
    // never as a limit. `included` is null on every plan.
    ops: {
      used: ops.used,
      included: ops.included,
      remaining: ops.remaining === Infinity ? null : ops.remaining,
      periodStart: ops.periodStart,
      allTime: allTimeOps,
      metered: false,
    },
    enrichments: {
      used: enrichments.used,
      included: enrichments.included,
      remaining: enrichments.remaining,
    },
    // Revenue-agent credits — the model-spend meter. The one meter that can
    // stop an action. `included: null` = unlimited (Headless, Custom, self-host).
    aiCredits: {
      used:        aiCredits.used,
      included:    aiCredits.included,
      remaining:   aiCredits.remaining,
      percentUsed: aiCredits.percentUsed,
      state:       aiCredits.state,
      periodStart: aiCredits.periodStart,
      unlimited:   aiCredits.unlimited,
    },
    workspaces: {
      current: workspaceCount,
      limit: plan.workspaceLimit,
    },
    currentWorkspaceId: workspaceId ?? null,
  };
}

usageRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);
    const { workspaceId: reqWorkspaceId } = req.query;

    const cacheKey = `${team.id}|${reqWorkspaceId ?? ''}`;
    const cached = usageCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) return res.json(cached.body);

    const body = await apiUsageBody(supabase, team, reqWorkspaceId);

    if (usageCache.size > 2000) usageCache.clear();
    usageCache.set(cacheKey, { body, expires: Date.now() + USAGE_TTL_MS });
    return res.json(body);
  } catch (err) {
    return res.status(500).json({
      error: 'internal_error',
      ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }),
    });
  }
});

// GET /api/usage/ops-breakdown
// Per-event-type op counts for the current billing period — powers the Ops
// page's retrieval filter and the "Top metrics for Retrieval Ops" panel. Only
// the retrieval event_types (RETRIEVAL_EVENT_TYPES) are billed; every other op
// is logged but free. Counts use head:true so no rows are transferred.
const RETRIEVAL_LABELS = {
  'v2.context':     'get_context',
  'v2.account.get': 'get_account',
  'v2.query':       'query',
  'v2.attention':   'attention',
};

// GET /api/usage/credits?workspaceId=…&days=30
//
// Where the model spend actually goes: by person, by model, by day. The credit wallet already
// knows the BALANCE; this answers the questions a founder asks next — who is using the agent,
// what are they running it on, and is the expensive model being used for expensive work.
//
// Cost is read from llm_usage (real per-call cost, not an estimate) and converted with the same
// costToCredits the meter uses, so this page and the bill can never disagree.
// One answer in the chat, as the person experienced it. A streamed answer can be several
// tool-loop turns, so this over-counts a long answer slightly — but it counts only rows a
// PERSON caused, which is what makes "credits per message" a number you can hold against
// what you saw on screen.
const AGENT_TURN_FEATURES = new Set(['home-agent-turn', 'home-agent-close', 'playground-agent-turn']);

// GET /api/usage/conversations?workspaceId=&days=30 — credits used per day, the way billing counts
// them: one per conversation read (GET-503). The billing page's chart reads this, so the bars add
// up to the number above them. /credits below stays the model-spend view for Usage.
// GET /api/usage/by-key?days=30 — calls and credits per API key (GET-623). See apiKeyUsage.mjs.
usageRouter.get('/by-key', verifySupabaseAuth, usageByKeyHandler);
// GET /api/usage/activity(?window=) and /activity/calls: Settings > API & MCP activity, admins only
// (GET-898). See routes/api/apiActivity.mjs.
usageRouter.get('/activity', verifySupabaseAuth, activityHandler);
usageRouter.get('/activity/calls', verifySupabaseAuth, activityCallsHandler);

usageRouter.get('/conversations', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    // THE BILLING PERIOD, COUNTED LIKE THE METER (GET-733). With `since` (the period start the
    // billing state gives), the chart covers exactly the meter's window and leaves the backfill
    // out the same way, so "300 of 1,000" and the bars under it are the same number. Without it, the
    // last `days` days as before.
    const sinceParam = Date.parse(String(req.query.since ?? ''));
    const days = Number.isFinite(sinceParam)
      ? Math.min(Math.max(Math.ceil((Date.now() - sinceParam) / 86400000), 1), 180)
      : Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    // From midnight UTC, so the window (and its cache key) holds still for the day.
    const since = Number.isFinite(sinceParam)
      ? new Date(sinceParam).toISOString()
      : new Date(new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10)).toISOString();
    const supabase = getSupabaseClient();
    const windows = Number.isFinite(sinceParam) ? await backfillWindowsFor(supabase, [workspaceId]) : [];
    const c = await cachedConversationCredits(supabase, [workspaceId], since, windows);
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      // Split (GET-721): conversations read, AI work, and the automations' share of the AI work.
      daily.push({ day, credits: c.byDay.get(day) ?? 0, reads: c.readsByDay?.get(day) ?? 0, ai: c.aiByDay?.get(day) ?? 0, automations: c.automationsByDay?.get(day) ?? 0 });
    }
    return res.json({
      days, total: c.total, email: c.email, calls: c.calls, meetings: c.meetings, daily,
      conversations: c.email + c.calls + c.meetings, ai: c.requested, automations: c.automations ?? 0,
    });
  } catch (err) {
    console.error('[GET /api/usage/conversations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

usageRouter.get('/credits', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    // Two windows, one query: a number with nothing to compare it to says only that the
    // product ran. "Up 40% on the previous 30 days" is the sentence a founder can act on.
    const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();

    const supabase = getSupabaseClient();

    // PAGE, don't ask for 40,000 and hope.
    //
    // PostgREST caps a single response at 1000 rows whatever `.limit()` says, and this query
    // had no `.order()` either — so past a thousand rows the page silently returned an
    // ARBITRARY thousand. The workspace that hit it first crossed the line today at just over 1,000
    // rows, and the symptom was the newest model missing from a breakdown and the chart
    // stopping a day short. Every number on the page was wrong, not just the visible one.
    //
    // Same failure the entity name search already carried a note about. Ordering is what
    // makes each page deterministic; without it two pages can return the same row twice and
    // skip another.
    const PAGE = 1000;
    const MAX_ROWS = 60_000;   // a sanity bound, not a cap anyone should reach
    const rows = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await supabase
        .from('llm_usage')
        .select('user_id, feature, model, cost_usd, input_tokens, output_tokens, occurred_at')
        .eq('workspace_id', workspaceId)
        .gte('occurred_at', prevSince)
        .order('occurred_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;   // last page
    }
    if (rows.length >= MAX_ROWS) {
      console.warn(`[USAGE] ws=${workspaceId} hit the ${MAX_ROWS}-row bound — the window is truncated and the totals understate.`);
    }

    // Telemetry is ours, not theirs — it's tracked for visibility and never billed, so it must
    // not appear in a spend breakdown either.
    const inWindow = (rows ?? []).filter(r => !AI_TELEMETRY_FEATURES.includes(r.feature));
    const billable = inWindow.filter(r => String(r.occurred_at) >= since);
    const previous = inWindow.filter(r => String(r.occurred_at) < since);

    const bucket = (map, key, r) => {
      const e = map.get(key) ?? { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
      e.calls += 1;
      e.cost_usd += Number(r.cost_usd) || 0;
      e.input_tokens += Number(r.input_tokens) || 0;
      e.output_tokens += Number(r.output_tokens) || 0;
      map.set(key, e);
      return e;
    };

    const byUser = new Map(), byModel = new Map(), byFeature = new Map(), byDay = new Map();
    const byVendor = new Map();
    // A "message" is one agent answer — the unit a person experiences and the only honest
    // denominator for "credits per message". Every other row (an extraction, a title, a
    // scoring pass) is the product working on its own and would deflate the average into
    // something nobody could reconcile with what they see in the chat.
    const msgsByUser = new Map();
    // Who was actually active on a given day, for the second axis of the chart. Distinct
    // PEOPLE, so an unattended routine doesn't read as a user showing up for work.
    const usersByDay = new Map();
    // Credits per person per day — what lets the chart be stacked by who spent it, and
    // filtered to one person, rather than one anonymous column of "the team".
    const creditsByDayUser = new Map();
    // The same cut by model, so the consumption chart can answer the other question a
    // founder asks about the same bar: not who spent it, but what it was spent ON.
    const creditsByDayModel = new Map();
    let messages = 0;
    for (const r of billable) {
      const uid = r.user_id ?? 'system';
      const day = String(r.occurred_at).slice(0, 10);
      bucket(byUser, uid, r);
      bucket(byModel, r.model ?? 'unknown', r);
      bucket(byVendor, vendorOfModelId(r.model), r);
      bucket(byFeature, r.feature ?? 'unknown', r);
      bucket(byDay, day, r);
      if (AGENT_TURN_FEATURES.has(r.feature)) {
        messages += 1;
        msgsByUser.set(uid, (msgsByUser.get(uid) ?? 0) + 1);
      }
      if (r.user_id) {
        if (!usersByDay.has(day)) usersByDay.set(day, new Set());
        usersByDay.get(day).add(r.user_id);
      }
      if (!creditsByDayUser.has(day)) creditsByDayUser.set(day, new Map());
      const perUser = creditsByDayUser.get(day);
      perUser.set(uid, (perUser.get(uid) ?? 0) + (Number(r.cost_usd) || 0));

      if (!creditsByDayModel.has(day)) creditsByDayModel.set(day, new Map());
      const perModel = creditsByDayModel.get(day);
      const mk = r.model ?? 'unknown';
      perModel.set(mk, (perModel.get(mk) ?? 0) + (Number(r.cost_usd) || 0));
    }

    // Name the people. "system" is the agent running unattended — a routine, a report after a
    // backfill — and it is a real consumer, so it stays in the list rather than being hidden.
    const userIds = [...byUser.keys()].filter(k => k !== 'system');
    const names = new Map(), avatars = new Map();
    if (userIds.length) {
      const { data: users } = await supabase
        .from('users').select('id, name, email, profile_picture_url').in('id', userIds);
      for (const u of users ?? []) {
        names.set(u.id, u.name || u.email || null);
        avatars.set(u.id, u.profile_picture_url || null);
      }
    }

    // The same spend one period earlier, per person and in total, so each row can carry its
    // own direction of travel rather than only the headline.
    const prevCostByUser = new Map();
    let prevTotalCost = 0;
    for (const r of previous) {
      const c = Number(r.cost_usd) || 0;
      prevTotalCost += c;
      prevCostByUser.set(r.user_id ?? 'system', (prevCostByUser.get(r.user_id ?? 'system') ?? 0) + c);
    }

    const shape = (map, keyName, label) => [...map.entries()]
      .map(([k, v]) => ({
        [keyName]: k,
        ...(label ? { label: label(k) } : {}),
        calls: v.calls,
        cost_usd: Number(v.cost_usd.toFixed(4)),
        credits: costToCredits(v.cost_usd),
        input_tokens: v.input_tokens,
        output_tokens: v.output_tokens,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    const totalCost = billable.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    const totalCredits = costToCredits(totalCost);
    const prevCredits = costToCredits(prevTotalCost);

    const members = shape(byUser, 'user_id', k => (k === 'system' ? 'Unattended (routines, reports)' : names.get(k) || 'Unknown'))
      .map(m => {
        const msgs = msgsByUser.get(m.user_id) ?? 0;
        const prev = costToCredits(prevCostByUser.get(m.user_id) ?? 0);
        return {
          ...m,
          avatar: avatars.get(m.user_id) ?? null,
          system: m.user_id === 'system',
          messages: msgs,
          credits_per_message: msgs ? Number((m.credits / msgs).toFixed(1)) : null,
          share: totalCredits ? Math.round((m.credits / totalCredits) * 100) : 0,
          prev_credits: prev,
        };
      });

    return res.json({
      days,
      total: {
        calls: billable.length,
        cost_usd: Number(totalCost.toFixed(4)),
        credits: totalCredits,
        messages,
        // The two averages a founder actually reasons with: what one answer costs, and what
        // one person costs. Both null rather than 0 when the denominator is empty — a zero
        // here would read as "free", which is the opposite of "we don't know yet".
        credits_per_message: messages ? Number((totalCredits / messages).toFixed(1)) : null,
        active_people: userIds.length,
        prev_credits: prevCredits,
        // Signed percentage change, or null when there is no earlier period to stand on.
        change_pct: prevCredits ? Math.round(((totalCredits - prevCredits) / prevCredits) * 100) : null,
      },
      by_member: members,
      by_model:  shape(byModel, 'model').map(m => ({
        ...m, vendor: vendorOfModelId(m.model), label: labelOfModelId(m.model),
      })),
      by_provider: shape(byVendor, 'vendor'),
      by_feature: shape(byFeature, 'feature'),
      daily: [...byDay.entries()]
        .map(([day, v]) => ({
          day, calls: v.calls,
          cost_usd: Number(v.cost_usd.toFixed(4)),
          credits: costToCredits(v.cost_usd),
          active_users: usersByDay.get(day)?.size ?? 0,
          // Converted per person, not apportioned from the day's total — the rounding has to
          // happen where the money did, or the stack won't add up to the bar.
          by_user: Object.fromEntries(
            [...(creditsByDayUser.get(day) ?? new Map())].map(([uid, cost]) => [uid, costToCredits(cost)]),
          ),
          by_model: Object.fromEntries(
            [...(creditsByDayModel.get(day) ?? new Map())].map(([mk, cost]) => [mk, costToCredits(cost)]),
          ),
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (err) {
    console.error('[GET /api/usage/credits]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

usageRouter.get('/ops-breakdown', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { team } = await resolveRequestTeam(req);

    const { data: subscription } = await supabase
      .from('subscriptions').select('*').eq('team_id', team.id).maybeSingle();
    const periodStart = periodStartFor(subscription).toISOString();

    const { data: workspaces } = await supabase
      .from('workspaces').select('id').eq('team_id', team.id);
    const wsIds = (workspaces ?? []).map((w) => w.id);

    if (!wsIds.length) {
      return res.json({ periodStart, total: 0, billed: 0, free: 0, retrieval: [] });
    }

    const countFor = async (eventType) => {
      const { count } = await supabase
        .from('workspace_system_log')
        .select('id', { count: 'exact', head: true })
        .in('workspace_id', wsIds)
        .eq('event_type', eventType)
        .gte('occurred_at', periodStart);
      return count ?? 0;
    };

    const [totalRes, ...retrievalCounts] = await Promise.all([
      supabase.from('workspace_system_log')
        .select('id', { count: 'exact', head: true })
        .in('workspace_id', wsIds)
        .gte('occurred_at', periodStart),
      ...RETRIEVAL_EVENT_TYPES.map(countFor),
    ]);

    const retrieval = RETRIEVAL_EVENT_TYPES
      .map((et, i) => ({ eventType: et, label: RETRIEVAL_LABELS[et] || et, count: retrievalCounts[i], billed: true }))
      .sort((a, b) => b.count - a.count);

    const total = totalRes.count ?? 0;
    const billed = retrieval.reduce((s, r) => s + r.count, 0);

    return res.json({
      periodStart,
      total,                       // every op logged this period (free + billed)
      billed,                      // retrieval ops — what counts toward the quota
      free: Math.max(0, total - billed),
      retrieval,                   // per-type, ranked — top metrics + filter source
    });
  } catch (err) {
    return res.status(500).json({
      error: 'internal_error',
      ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }),
    });
  }
});
