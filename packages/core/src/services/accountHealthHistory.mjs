// Account health over time (GET-804): the trend line on the account page.
//
// Two sources, merged by day:
//   - a BACKFILL: the same pure scoring (computeAccountHealth) evaluated as of past dates, weekly over
//     the last 60 days, from the activity up to that date and the claims valid on it (valid_from at or
//     before it, and not retired by then). So an account opened for the first time already has a line.
//   - SNAPSHOTS: one dated state observation a day on the company entity, property
//     `account_health_score`, value { score, label, factors }, written when the score is computed
//     (the account page, the nightly health refresh). The same substrate deal health's history rests
//     on (`deal_health_score` observations), so no new table. external_id is the day, so a second
//     write the same day is a no-op.
// A stored snapshot wins over a backfilled point on the same day; today's live score wins over both.
//
// Pure functions first; the loaders at the end are the only I/O.

import { computeAccountHealth, loadEngagementActivity } from './accountHealthScore.mjs';
import { recordObservations } from '../db/observations.js';
import { listAccountNotes } from '../db/notes.js';
import { listDocuments } from '../db/documents.js';
import { teamReadContext } from '../db/readContext.js';
import { readTitle } from './titleRead.js';

const DAY = 86_400_000;
export const SNAPSHOT_PROPERTY = 'account_health_score';
export const SNAPSHOT_SOURCE = 'nous';

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
/** The UTC day an instant falls on, the series' dedupe key. */
export const dayKey = (t) => new Date(typeof t === 'number' ? t : Date.parse(t)).toISOString().slice(0, 10);

/** When a claim became true: valid_from, which notes carry as `said_at` / `created_at`. */
const validFrom = (n) => ms(n.valid_from ?? n.said_at ?? n.created_at);

/** Was this claim valid at `at`: said at or before it, and not retired by then. */
export function claimValidAt(n, at) {
  const from = validFrom(n);
  if (from == null || from > at) return false;
  const until = ms(n.invalid_at);
  return until == null || until > at;
}

/**
 * The account's health as it stood at `at`: activity up to that moment, claims valid then. Null
 * when nothing was on record yet (no activity, no call, no claim), because a score of nothing is
 * not a point on the line.
 */
export function accountHealthAsOf({ notes = [], activity = [], calls = [], stakeholders = [], customer = null, at }) {
  const actsThen = (activity || []).filter(a => { const t = ms(a.occurred_at || a.created_at); return t != null && t <= at; });
  const callsThen = (calls || []).filter(c => { const t = ms(c.occurred_at); return t != null && t <= at; });
  const notesThen = (notes || []).filter(n => claimValidAt(n, at));
  if (!actsThen.length && !callsThen.length && !notesThen.length) return null;
  return computeAccountHealth({ notes: notesThen, activity: actsThen, calls: callsThen, stakeholders, customer, now: at });
}

/**
 * Weekly points over the last `days` days, oldest first, not including today (today is the live
 * score). Each is `{ at, score, label, source: 'backfill' }`.
 */
export function backfillAccountHealth({ notes = [], activity = [], calls = [], stakeholders = [], customer = null, now = Date.now(), days = 60, stepDays = 7 } = {}) {
  const out = [];
  for (let back = Math.floor(days / stepDays) * stepDays; back >= stepDays; back -= stepDays) {
    const at = now - back * DAY;
    const h = accountHealthAsOf({ notes, activity, calls, stakeholders, customer, at });
    if (h) out.push({ at: new Date(at).toISOString(), score: h.score, label: h.band, source: 'backfill' });
  }
  return out;
}

/** A stored snapshot observation row → a series point, or null when it carries no score. */
export function snapshotPoint(row) {
  const v = row?.value && typeof row.value === 'object' ? row.value : null;
  const score = Number(v?.score);
  if (!row?.observed_at || !Number.isFinite(score)) return null;
  return { at: row.observed_at, score: Math.round(score), label: v?.label ?? null, source: 'snapshot' };
}

/**
 * The trend series: backfilled points and stored snapshots, one point per day, oldest first, with
 * today's live score as the last point when given. On a day with both, the snapshot wins (it was
 * measured then); on today, the live score wins.
 */
export function buildHealthSeries({ backfill = [], snapshots = [], current = null, now = Date.now() } = {}) {
  const byDay = new Map();
  for (const p of backfill || []) if (p && Number.isFinite(p.score)) byDay.set(dayKey(p.at), p);
  // Snapshots oldest first, so the latest of a day wins if two ever landed.
  const snaps = (snapshots || []).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const p of snaps) if (Number.isFinite(p.score)) byDay.set(dayKey(p.at), p);
  if (current && Number.isFinite(current.score)) {
    byDay.set(dayKey(now), { at: new Date(now).toISOString(), score: current.score, label: current.label ?? null, source: 'live' });
  }
  return [...byDay.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** True when the series has anything before today: the only case "First score" is wrong. */
export const hasHistory = (series, now = Date.now()) => (series || []).some(p => dayKey(p.at) < dayKey(now));

/**
 * The day's snapshot observation for an account's health: a dated state observation on the company
 * entity, one per day (the day is the external_id). Factors keep only what the trend needs.
 */
export function snapshotObservation(workspaceId, companyId, health, now = Date.now()) {
  if (!workspaceId || !companyId || !health || !Number.isFinite(health.score)) return null;
  const day = dayKey(now);
  return {
    workspaceId, entityId: companyId, kind: 'state', property: SNAPSHOT_PROPERTY,
    value: {
      score: health.score, label: health.band ?? null,
      factors: (health.smart || []).map(f => ({ key: f.key, level: f.level ?? null, tone: f.tone })),
    },
    source: SNAPSHOT_SOURCE, method: 'inference',
    observedAt: new Date(now).toISOString(),
    externalId: `${SNAPSHOT_PROPERTY}:${companyId}:${day}`,
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/** Store today's snapshot (idempotent per day). Never throws: a trend write must not fail a page. */
export async function recordAccountHealthSnapshot(supabase, workspaceId, companyId, health, { now = Date.now() } = {}) {
  const obs = snapshotObservation(workspaceId, companyId, health, now);
  if (!obs) return 0;
  try { return await recordObservations(supabase, [obs]); } catch { return 0; }
}

/** Stored snapshots since `since`, as series points. */
export async function loadAccountHealthSnapshots(supabase, workspaceId, companyId, { since } = {}) {
  let q = supabase.from('observations').select('value, observed_at')
    .eq('workspace_id', workspaceId).eq('entity_id', companyId).eq('property', SNAPSHOT_PROPERTY);
  if (since) q = q.gte('observed_at', since);
  const { data, error } = await q.order('observed_at', { ascending: true }).limit(400);
  if (error) return [];
  return (data || []).map(snapshotPoint).filter(Boolean);
}

/** The account's call pages as { id, title, occurred_at }, dated by when the call happened. */
export async function loadAccountCalls(supabase, workspaceId, subjectIds) {
  const docs = await listDocuments(supabase, workspaceId, { subjectEntityIds: subjectIds, limit: 300 }).catch(() => []);
  return docs.filter(d => d.kind === 'call' && d.period_start).map(d => ({ id: d.id, title: d.title, occurred_at: d.period_start }));
}

/**
 * The CRM's customer bag for an account (entity_list_rows.cs), as computeAccountHealth's
 * `customer` ({ activeUsers, totalUsers }) when the CRM treats it as a customer, else null. The same
 * bag and the same test the account page uses, so the trend and the page grade the same factors.
 */
export async function loadCustomerForHealth(supabase, workspaceId, companyId) {
  const { data, error } = await supabase.from('entity_list_rows').select('cs')
    .eq('workspace_id', workspaceId).eq('kind', 'account').eq('entity_id', companyId).maybeSingle();
  const cs = !error && data?.cs && typeof data.cs === 'object' ? data.cs : null;
  return String(cs?.status ?? '').toLowerCase() === 'client' ? { activeUsers: cs.active_users_30d, totalUsers: cs.total_users } : null;
}

/**
 * The account's health trend: backfilled weekly points over `days` days, stored daily snapshots, and
 * today's live score, deduped by day. Reads what the whole team may read (the stored score is shown
 * to everyone), including claims retired inside the window so a past date sees what was true then.
 * With `persist`, stores today's snapshot. `backfill: false` skips the past dates (the nightly job,
 * which only needs today's snapshot). Returns { series, current, has_history }.
 */
export async function loadAccountHealthTrend(supabase, workspaceId, companyId, { now = Date.now(), days = 60, persist = true, backfill: doBackfill = true } = {}) {
  const sinceIso = new Date(now - days * DAY).toISOString();
  const { data: contacts } = await supabase.from('contacts')
    .select('id, first_name, last_name, email, job_title, seniority, pipeline_stage, last_activity_at')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  const stakeholders = (contacts || []).map(c => ({
    id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || null,
    title: c.job_title ?? null, seniority: c.seniority ?? null, pipeline_stage: c.pipeline_stage ?? null,
    // The role as the title reads it; the page's influence edges are not loaded here, and authority
    // claims (the stronger evidence) arrive with the notes either way.
    last_activity_at: c.last_activity_at ?? null, role: readTitle(c.job_title).role ?? null, role_basis: 'title',
  }));
  const contactIds = stakeholders.map(s => s.id);
  const subjectIds = [companyId, ...contactIds];
  const [notes, activity, calls, customer, snapshots] = await Promise.all([
    listAccountNotes(supabase, workspaceId, companyId, contactIds, { retiredSince: sinceIso }, teamReadContext(workspaceId)),
    // The earliest point's "30 before" window reaches 60 days behind it.
    loadEngagementActivity(supabase, workspaceId, subjectIds, { since: new Date(now - (days + 60) * DAY).toISOString() }),
    loadAccountCalls(supabase, workspaceId, subjectIds),
    loadCustomerForHealth(supabase, workspaceId, companyId).catch(() => null),
    doBackfill ? loadAccountHealthSnapshots(supabase, workspaceId, companyId, { since: sinceIso }) : Promise.resolve([]),
  ]);

  const live = computeAccountHealth({ notes: notes.filter(n => claimValidAt(n, now)), activity, calls, stakeholders, customer, now });
  const backfill = doBackfill ? backfillAccountHealth({ notes, activity, calls, stakeholders, customer, now, days }) : [];
  if (persist) await recordAccountHealthSnapshot(supabase, workspaceId, companyId, live, { now });
  const current = { score: live.score, label: live.band };
  const series = buildHealthSeries({ backfill, snapshots, current, now });
  return { series, current, has_history: hasHistory(series, now) };
}
