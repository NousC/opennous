// Rules (GET-846): the checks behind a CHECKED rule.
//
// A rule is something a rep said once ("every meeting ends with a dated next step within 48
// hours"). Guidance rules only reach the agent. A checked rule is mapped onto one of the checks
// below and the worker evaluates it in the background (workers/ruleChecks.mjs): a broken rule
// becomes a flag and a task on the account, ranked by the rule's weight and how late it is.
//
// The catalogue is deliberately short. Each check is something the engine can VERIFY from data
// it already holds; a rule that maps onto none of them stays guidance rather than getting a check
// that only looks like one. Pure: the worker loads the data, these decide.

import { DONE_STAGES } from '../pipeline.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A broken rule older than this is history, not something to act on. */
const LOOKBACK_DAYS = 14;

export interface RuleCheckSpec {
  label: string;
  /** The one number the rule turns on, and its unit. */
  param: 'hours' | 'days';
  default: number;
  min: number;
  max: number;
  /** One line for the agent: what the check verifies, so it can map a stated rule onto it. */
  verifies: string;
}

export const RULE_CHECKS: Record<string, RuleCheckSpec> = {
  next_step_after_meeting: {
    label: 'Dated next step after every meeting',
    param: 'hours', default: 48, min: 1, max: 24 * 14,
    verifies: 'Within N hours of a meeting you held, the account has a task with a due date from that meeting or later, or a next meeting booked.',
  },
  reply_to_buyer_email: {
    label: 'Reply to buyer emails',
    param: 'hours', default: 24, min: 1, max: 24 * 14,
    verifies: 'Every email thread where the buyer wrote last gets a reply from you within N hours.',
  },
  stage_without_meeting: {
    label: 'No deal sits in a stage without a meeting',
    param: 'days', default: 21, min: 1, max: 365,
    verifies: 'An open deal you own has had a meeting within N days of entering its current stage, or more recently than N days ago.',
  },
};

export type RuleWeight = 'low' | 'normal' | 'high';
export const RULE_WEIGHTS: RuleWeight[] = ['low', 'normal', 'high'];

/** A check type and its parameter, clamped to the catalogue. Null for a check we do not have. */
export function normalizeCheck(type: unknown, params: Record<string, unknown> | null | undefined): { check_type: string; params: Record<string, number> } | null {
  const spec = typeof type === 'string' ? RULE_CHECKS[type] : undefined;
  if (!spec) return null;
  const raw = Number((params ?? {})[spec.param]);
  const n = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : spec.default;
  return { check_type: type as string, params: { [spec.param]: Math.min(spec.max, Math.max(spec.min, n)) } };
}

export interface RuleRow {
  id: string;
  user_id: string | null;
  statement: string;
  kind: 'guidance' | 'checked';
  check_type: string | null;
  params: Record<string, unknown> | null;
  weight?: string | null;
  status?: string | null;
  removed_at?: string | null;
}

/** What the worker loads for one rule owner. Each list is already the workspace's, accounts resolved. */
export interface RuleCheckData {
  meetings?: { account_id: string; key: string; at: string; owner_user_id: string | null; title?: string | null }[];
  /** Open or done action items on the account: when they were said, and their due date. */
  tasks?: { account_id: string; occurred_at: string | null; due_at: string | null }[];
  /** Meetings booked (scheduled) on the account, by when the booking was seen. */
  bookings?: { account_id: string; at: string }[];
  inbound?: { account_id: string; thread_id: string; at: string; owner_user_id: string | null; subject?: string | null }[];
  outbound?: { account_id: string; thread_id: string; at: string }[];
  accounts?: { account_id: string; name?: string | null; stage: string; stage_entered_at: string | null; last_meeting_at: string | null; owner_user_id: string | null }[];
}

export interface RuleViolation {
  rule_id: string;
  account_id: string;
  /** Stable per broken instance (this meeting, this thread, this stage), so it is flagged and tasked once. */
  key: string;
  /** When the rule's window ran out. */
  due_at: string;
  overdue_hours: number;
  /** One line a rep can act on, naming the evidence. */
  reason: string;
  /** The task title the broken rule opens. */
  task: string;
  evidence: Record<string, unknown>;
}

const ms = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Every broken instance of one rule, from the data loaded for its owner. Empty for guidance, paused or removed rules. */
export function evaluateRule(rule: RuleRow, data: RuleCheckData, now: number = Date.now()): RuleViolation[] {
  return checkRule(rule, data, now).broken;
}

/**
 * The full answer: what is broken, and which instances were checked inside the window and PASS.
 * Only a `met` instance may close a rule's task as done — one that merely aged out of the window,
 * or whose data did not load, was never met.
 */
export function checkRule(rule: RuleRow, data: RuleCheckData, now: number = Date.now()): { broken: RuleViolation[]; met: Set<string> } {
  const met = new Set<string>();
  if (!rule || rule.kind !== 'checked' || rule.removed_at || (rule.status ?? 'active') !== 'active') return { broken: [], met };
  const check = normalizeCheck(rule.check_type, rule.params);
  if (!check || !data) return { broken: [], met };
  const mine = (owner: string | null | undefined) => !rule.user_id || owner === rule.user_id;
  const floor = now - LOOKBACK_DAYS * DAY;
  const out: RuleViolation[] = [];
  const push = (v: Omit<RuleViolation, 'rule_id'>) => out.push({ rule_id: rule.id, ...v });

  if (check.check_type === 'next_step_after_meeting') {
    const hours = check.params.hours;
    const seen = new Set<string>();
    for (const m of data.meetings ?? []) {
      const t = ms(m.at);
      if (t == null || !mine(m.owner_user_id) || seen.has(m.key)) continue;
      seen.add(m.key);
      const deadline = t + hours * HOUR;
      if (t < floor) continue;
      // A dated task said in that meeting or after it (an action item is dated by the meeting it
      // came from, so "from the meeting" is occurred_at at or after the meeting, give or take an hour).
      const dated = (data.tasks ?? []).some((k) => k.account_id === m.account_id && k.due_at
        && (ms(k.occurred_at) ?? -Infinity) >= t - HOUR);
      // A NEXT meeting: calendar bookings are dated by the meeting's start, so the held meeting's own
      // booking sits at (about) t. Only one starting more than an hour after it is a next step.
      const booked = (data.bookings ?? []).some((b) => b.account_id === m.account_id && (ms(b.at) ?? -Infinity) > t + HOUR);
      if (dated || booked) { met.add(`next_step_after_meeting:${m.key}`); continue; }
      if (deadline > now) continue;
      const name = m.title ? `"${m.title}"` : 'the meeting';
      push({
        account_id: m.account_id, key: `next_step_after_meeting:${m.key}`,
        due_at: new Date(deadline).toISOString(), overdue_hours: Math.floor((now - deadline) / HOUR),
        reason: `No dated next step after ${name} on ${day(t)} (your rule: within ${hours}h)`,
        task: `Agree a dated next step after ${name} (${day(t)})`,
        evidence: { meeting: m.key, meeting_at: m.at, hours },
      });
    }
  }

  if (check.check_type === 'reply_to_buyer_email') {
    const hours = check.params.hours;
    const latest = new Map<string, NonNullable<RuleCheckData['inbound']>[number]>();
    for (const e of data.inbound ?? []) {
      if (!mine(e.owner_user_id) || ms(e.at) == null) continue;
      const prev = latest.get(e.thread_id);
      if (!prev || (ms(e.at) as number) > (ms(prev.at) as number)) latest.set(e.thread_id, e);
    }
    for (const e of latest.values()) {
      const t = ms(e.at) as number;
      const deadline = t + hours * HOUR;
      if (t < floor) continue;
      // A reply on the thread, or any email to that account after it: a team thread is filed once,
      // under whichever mailbox was read first, so its thread id is not always the rep's.
      const replied = (data.outbound ?? []).some((o) => (o.thread_id === e.thread_id || o.account_id === e.account_id) && (ms(o.at) ?? -Infinity) > t);
      if (replied) { met.add(`reply_to_buyer_email:${e.thread_id}`); continue; }
      if (deadline > now) continue;
      const what = e.subject ? `"${e.subject}"` : 'their email';
      push({
        account_id: e.account_id, key: `reply_to_buyer_email:${e.thread_id}`,
        due_at: new Date(deadline).toISOString(), overdue_hours: Math.floor((now - deadline) / HOUR),
        reason: `No reply to ${what} from ${day(t)} (your rule: within ${hours}h)`,
        task: `Reply to ${what} (${day(t)})`,
        evidence: { thread_id: e.thread_id, received_at: e.at, hours },
      });
    }
  }

  if (check.check_type === 'stage_without_meeting') {
    const days = check.params.days;
    for (const a of data.accounts ?? []) {
      if (!mine(a.owner_user_id) || !a.stage || DONE_STAGES.has(a.stage)) continue;
      const entered = ms(a.stage_entered_at);
      if (entered == null) continue;
      const lastMeeting = ms(a.last_meeting_at);
      // The window runs from the later of: entering the stage, the last meeting.
      const since = Math.max(entered, lastMeeting ?? -Infinity);
      const deadline = since + days * DAY;
      if (deadline > now) { met.add(`stage_without_meeting:${a.account_id}:${a.stage}`); continue; }
      push({
        account_id: a.account_id, key: `stage_without_meeting:${a.account_id}:${a.stage}`,
        due_at: new Date(deadline).toISOString(), overdue_hours: Math.floor((now - deadline) / HOUR),
        reason: `${a.name ?? 'This deal'} has sat in ${a.stage} since ${day(entered)} with no meeting${lastMeeting ? ` since ${day(lastMeeting)}` : ''} (your rule: within ${days} days)`,
        task: `Book a meeting with ${a.name ?? 'this account'} (in ${a.stage} since ${day(entered)})`,
        evidence: { stage: a.stage, stage_entered_at: a.stage_entered_at, last_meeting_at: a.last_meeting_at, days },
      });
    }
  }
  return { broken: out, met };
}

const WEIGHT_BASE: Record<RuleWeight, number> = { low: 10, normal: 20, high: 30 };

/**
 * The flag priority of a broken rule: the weight sets the band, lateness moves it inside the band
 * (a day late adds one, capped below the next band), so a broken high rule always outranks a
 * normal one and a long-broken rule outranks a fresh one of the same weight.
 */
export function rulePriority(weight: string | null | undefined, overdueHours: number): number {
  const base = WEIGHT_BASE[(weight as RuleWeight)] ?? WEIGHT_BASE.normal;
  const late = Math.min(9, Math.floor(Math.max(0, overdueHours) / 24));
  return base + late;
}
