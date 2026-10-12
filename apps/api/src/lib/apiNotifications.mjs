// API-plan notifications (GET-635): webhook failures, a key about to expire, credits running low.
//
// Same shape as the ops-limit emails (routes/opsEmails.mjs): the api decides WHO is due an
// alert and RESERVES the send in team_ops_email_log, the worker cron does the sending. The log's
// primary key (team_id, kind, period_start) is the de-duplication, so no new table or column:
//
//   webhook_failures  kind 'webhook_failures:<subscription id>', period_start = the UTC day.
//                     Plus a lookback: never within 24h of the last alert for that subscription,
//                     and only again if it has failed since that alert.
//   key_expiring      kind 'key_expiring:<key id>', period_start = the key's expires_at. Once per
//                     expiry; a key given a new expiry can warn again.
//   credits_low       kind 'api_credits_low', period_start = the billing period's start. Credits
//                     are counted per team (getTeamAiCredits, what the Usage page reads), so this
//                     is once per billing period per team.
//
// Who gets them: the members of the workspace, read from workspace_members.notification_prefs.
// A member who never set the key gets it when they are an owner or admin, not otherwise; a member
// who set it gets what they set. The API plan has no in-app inbox, so email is the channel, and a
// row reads as on when either stored channel is (the same rule the Settings switch shows).
//
// Only the API plan. A workspace on any other plan is skipped before anything is read about it.
// Delivery itself is never touched: the webhook check reads webhook_deliveries/outbound_events
// after the fact, on a schedule, so it cannot slow or fail a delivery.

import { getPlanFromSubscription, getTeamAiCredits, isApiTier, planIsLive } from './plans.mjs';

export const API_ALERT_KEYS = ['webhook_failures', 'key_expiring', 'credits_low'];

export const WEBHOOK_FAILURE_THRESHOLD = 3;
export const WEBHOOK_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const KEY_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CREDITS_LOW_PCT = 80;

const ADMIN_ROLES = new Set(['owner', 'admin']);
const BATCH = 100; // PostgREST .in() stays well under the URL limit at this size

// ── The preference model ────────────────────────────────────────────────────

/** Does this member want this alert? Stored value wins; unset means on for owners/admins only. */
export function wantsAlert(prefs, key, role) {
  const v = prefs && typeof prefs === 'object' ? prefs[key] : undefined;
  if (v && typeof v === 'object') return !!(v.email || v.app);
  if (typeof v === 'boolean') return v;
  return ADMIN_ROLES.has(String(role ?? '').toLowerCase());
}

/** Unique emails of the members who want `key`. members: [{ role, notification_prefs, email }] */
export function alertRecipients(members, key) {
  const out = new Set();
  for (const m of members ?? []) {
    if (!m?.email) continue;
    if (wantsAlert(m.notification_prefs, key, m.role)) out.add(m.email);
  }
  return [...out];
}

// ── The thresholds ──────────────────────────────────────────────────────────

/** Failed attempts in a row, counting back from the newest. attempts: newest first. */
export function consecutiveFailures(attempts) {
  let n = 0;
  for (const a of attempts ?? []) {
    if (a?.ok) break;
    n++;
  }
  return n;
}

/** Three failures in a row, or an event the outbox gave up on. */
export function webhookAlertDue({ attempts, deadLettered = false }) {
  return deadLettered || consecutiveFailures(attempts) >= WEBHOOK_FAILURE_THRESHOLD;
}

/**
 * The 24h rule. No earlier alert → due. An earlier one → only once 24h have passed AND the
 * endpoint has failed again since it (a subscription that failed once, a day ago, and has had no
 * traffic since is not news twice).
 */
export function webhookCooldownClear({ lastAlertAt, lastFailureAt, now = Date.now() }) {
  if (!lastAlertAt) return true;
  const last = Date.parse(lastAlertAt);
  if (Number.isNaN(last)) return true;
  if (now - last < WEBHOOK_ALERT_COOLDOWN_MS) return false;
  return !!lastFailureAt && Date.parse(lastFailureAt) > last;
}

/** Expires within 7 days, has not expired yet, and is not revoked. */
export function keyExpiringDue(key, now = Date.now()) {
  if (!key || key.revoked_at || !key.expires_at) return false;
  const at = Date.parse(key.expires_at);
  if (Number.isNaN(at)) return false;
  return at > now && at - now <= KEY_EXPIRY_WINDOW_MS;
}

/**
 * 80% of a real allowance and not yet over it. Over 100% is said by the existing credits_over
 * email, and from 90% (credits.state 'warn') the existing credits_warn90 ops email says it, so a
 * second one about the same month would be nagging. Unlimited plans never warn.
 */
export function creditsLowDue(credits) {
  if (!credits || credits.unlimited) return false;
  if (!(Number(credits.included) > 0)) return false;
  if (credits.state === 'warn') return false;
  const pct = Number(credits.percentUsed) || 0;
  return pct >= CREDITS_LOW_PCT && pct < 100;
}

/** Start of the UTC day — the webhook alert's period_start. */
export function dayBucket(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * Work out every alert due now and reserve it. Returns the queue the worker sends from.
 * `db` is the data access (supabaseDb below in production, a fake in the tests).
 */
export async function sweepApiNotifications(db, { kinds = API_ALERT_KEYS, now = Date.now() } = {}) {
  const want = new Set(kinds.filter((k) => API_ALERT_KEYS.includes(k)));
  const queued = [];
  const plans = new Map(); // team_id → { api, sub }

  const teamPlan = async (teamId) => {
    if (!plans.has(teamId)) {
      const sub = await db.teamSubscription(teamId);
      plans.set(teamId, { sub, api: isApiTier(getPlanFromSubscription(sub)) });
    }
    return plans.get(teamId);
  };

  if (want.has('webhook_failures')) {
    try { queued.push(...await sweepWebhooks(db, now)); }
    catch (e) { console.error('[api-notifications] webhooks:', e?.message); }
  }
  if (want.has('key_expiring')) {
    try { queued.push(...await sweepKeys(db, now, teamPlan)); }
    catch (e) { console.error('[api-notifications] keys:', e?.message); }
  }
  if (want.has('credits_low')) {
    try { queued.push(...await sweepCredits(db, now)); }
    catch (e) { console.error('[api-notifications] credits:', e?.message); }
  }
  return queued;
}

/**
 * Walks the API plan's active subscriptions and reads each one's last few attempts (and its
 * newest dead letter in the window): bounded by the number of subscriptions, not by how many
 * failed rows exist across every plan.
 */
async function sweepWebhooks(db, now) {
  const since = new Date(now - WEBHOOK_ALERT_COOLDOWN_MS).toISOString();
  const apiTeams = (await db.allSubscriptions())
    .filter(({ sub }) => isApiTier(getPlanFromSubscription(sub)))
    .map((t) => t.team_id);
  if (!apiTeams.length) return [];
  const workspaces = await db.workspacesByTeams(apiTeams);
  if (!workspaces.size) return [];
  const subs = (await db.activeSubscriptions([...workspaces.keys()])).filter((s) => s.active);
  const out = [];

  for (const s of subs) {
    const ws = workspaces.get(s.workspace_id);
    if (!ws) continue;

    const [attempts, deadAt] = await Promise.all([
      db.recentAttempts(s.id, WEBHOOK_FAILURE_THRESHOLD),
      db.lastDeadLetter(s.id, since),
    ]);
    if (!webhookAlertDue({ attempts, deadLettered: !!deadAt })) continue;

    // Only news while it is failing now: the newest failure must fall inside the window.
    const failedAt = attempts.find((a) => !a.ok)?.created_at ?? null;
    const lastFailureAt = [failedAt, deadAt].filter(Boolean).sort().at(-1) ?? null;
    if (!lastFailureAt || lastFailureAt < since) continue;

    const kind = `webhook_failures:${s.id}`;
    const lastAlertAt = await db.lastAlert(ws.team_id, kind);
    if (!webhookCooldownClear({ lastAlertAt, lastFailureAt, now })) continue;

    const to = alertRecipients(await db.members([s.workspace_id]), 'webhook_failures');
    if (!to.length) continue;
    if (!(await db.reserve(ws.team_id, kind, dayBucket(now)))) continue;

    const last = attempts[0] ?? null;
    out.push({
      kind: 'webhook_failures', to, workspace_id: s.workspace_id, workspaceName: ws.name,
      subscriptionName: s.name, url: s.url ?? (s.github_repo ? `github.com/${s.github_repo}` : null),
      failures: consecutiveFailures(attempts), deadLettered: !!deadAt,
      lastStatus: last?.status_code ?? null, lastError: last?.error ?? null,
    });
  }
  return out;
}

async function sweepKeys(db, now, teamPlan) {
  const keys = (await db.expiringKeys(new Date(now).toISOString(), new Date(now + KEY_EXPIRY_WINDOW_MS).toISOString()))
    .filter((k) => keyExpiringDue(k, now));
  if (!keys.length) return [];
  const workspaces = await db.workspacesByIds([...new Set(keys.map((k) => k.workspace_id))]);
  const out = [];
  for (const k of keys) {
    const ws = workspaces.get(k.workspace_id);
    if (!ws) continue;
    if (!(await teamPlan(ws.team_id)).api) continue;
    const to = alertRecipients(await db.members([k.workspace_id]), 'key_expiring');
    if (!to.length) continue;
    if (!(await db.reserve(ws.team_id, `key_expiring:${k.id}`, new Date(k.expires_at).toISOString()))) continue;
    out.push({
      kind: 'key_expiring', to, workspace_id: k.workspace_id, workspaceName: ws.name,
      keyName: k.name, expiresAt: k.expires_at,
    });
  }
  return out;
}

async function sweepCredits(db) {
  const out = [];
  for (const { team_id: teamId, sub } of await db.allSubscriptions()) {
    // Paying and on the API plan. An unpaid team has an allowance of zero (GET-554).
    if (!planIsLive(sub) || !isApiTier(getPlanFromSubscription(sub))) continue;
    let credits;
    try { credits = await db.credits(teamId, sub); }
    catch (e) { console.error('[api-notifications] credits failed for team', teamId, e?.message); continue; }
    if (!creditsLowDue(credits)) continue;

    const workspaces = await db.teamWorkspaces(teamId);
    if (!workspaces.length) continue;
    const to = alertRecipients(await db.members(workspaces.map((w) => w.id)), 'credits_low');
    if (!to.length) continue;
    if (!(await db.reserve(teamId, 'api_credits_low', credits.periodStart))) continue;
    out.push({
      kind: 'credits_low', to, team_id: teamId,
      used: credits.used, included: credits.included, percentUsed: credits.percentUsed,
    });
  }
  return out;
}

// ── Supabase-backed data access ─────────────────────────────────────────────

function chunks(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += BATCH) out.push(arr.slice(i, i + BATCH));
  return out;
}

function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data ?? [];
}

export function supabaseDb(supabase) {
  return {
    async workspacesByTeams(teamIds) {
      const map = new Map();
      for (const c of chunks(teamIds)) {
        for (const w of must(await supabase.from('workspaces').select('id, team_id, name').in('team_id', c), 'workspaces by team')) {
          map.set(w.id, w);
        }
      }
      return map;
    },
    async activeSubscriptions(workspaceIds) {
      const out = [];
      for (const c of chunks(workspaceIds)) {
        out.push(...must(await supabase.from('trigger_subscriptions')
          .select('id, workspace_id, name, url, github_repo, active').eq('active', true).in('workspace_id', c), 'subscriptions'));
      }
      return out;
    },
    // The newest dead letter since `since`, or null. A dead letter for an inactive subscription is
    // the subscription being switched off, not the endpoint failing.
    async lastDeadLetter(subscriptionId, since) {
      const rows = must(await supabase.from('outbound_events')
        .select('dead_lettered_at').eq('subscription_id', subscriptionId).gte('dead_lettered_at', since)
        .or('last_error.is.null,last_error.neq.subscription_inactive')
        .order('dead_lettered_at', { ascending: false }).limit(1), 'dead letters');
      return rows[0]?.dead_lettered_at ?? null;
    },
    async recentAttempts(subscriptionId, n) {
      return must(await supabase.from('webhook_deliveries')
        .select('ok, status_code, error, created_at').eq('subscription_id', subscriptionId)
        .order('created_at', { ascending: false }).limit(n), 'recent attempts');
    },
    async expiringKeys(fromIso, untilIso) {
      return must(await supabase.from('api_keys')
        .select('id, workspace_id, name, expires_at, revoked_at').is('revoked_at', null)
        .gt('expires_at', fromIso).lte('expires_at', untilIso), 'expiring keys');
    },
    async workspacesByIds(ids) {
      const map = new Map();
      for (const c of chunks(ids)) {
        for (const w of must(await supabase.from('workspaces').select('id, team_id, name').in('id', c), 'workspaces')) {
          map.set(w.id, w);
        }
      }
      return map;
    },
    async teamWorkspaces(teamId) {
      return must(await supabase.from('workspaces').select('id, team_id, name').eq('team_id', teamId), 'team workspaces');
    },
    async teamSubscription(teamId) {
      const { data, error } = await supabase.from('subscriptions').select('*').eq('team_id', teamId).maybeSingle();
      if (error) throw new Error(`subscription: ${error.message}`);
      return data ?? null;
    },
    async allSubscriptions() {
      return must(await supabase.from('subscriptions').select('*'), 'subscriptions')
        .map((sub) => ({ team_id: sub.team_id, sub }));
    },
    async members(workspaceIds) {
      const rows = [];
      for (const c of chunks(workspaceIds)) {
        rows.push(...must(await supabase.from('workspace_members')
          .select('workspace_id, user_id, role, notification_prefs').in('workspace_id', c), 'members'));
      }
      const userIds = [...new Set(rows.map((r) => r.user_id))];
      const emails = new Map();
      for (const c of chunks(userIds)) {
        for (const u of must(await supabase.from('users').select('id, email').in('id', c), 'users')) emails.set(u.id, u.email);
      }
      return rows.map((r) => ({ ...r, email: emails.get(r.user_id) ?? null }));
    },
    async lastAlert(teamId, kind) {
      const rows = must(await supabase.from('team_ops_email_log').select('sent_at')
        .eq('team_id', teamId).eq('kind', kind).order('sent_at', { ascending: false }).limit(1), 'alert log');
      return rows[0]?.sent_at ?? null;
    },
    async reserve(teamId, kind, periodStart) {
      const { error } = await supabase.from('team_ops_email_log').insert({ team_id: teamId, kind, period_start: periodStart });
      if (!error) return true;
      if (error.code !== '23505') console.error('[api-notifications] reserve failed:', error.message);
      return false;
    },
    credits(teamId, sub) {
      return getTeamAiCredits(supabase, teamId, sub);
    },
  };
}
