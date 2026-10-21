// Engagement metrics — the leading indicators the deal-health score, the pipeline tool,
// and the flag sweep all share. Three things that predict a deal cooling before the
// number moves: is engagement RISING or COOLING (trend), are we MULTI-THREADED (breadth),
// and how fast does the buyer RESPOND. All derived from the activity log. See
// docs/revenue-layer-gap-analysis.md (P3 engagement layer).
const DAY = 86_400_000;

// ── What an activity row is (GET-976) ───────────────────────────────────────
//
// Every engagement reader asks the same three questions of a row, and they used to answer them
// with their own regexes: a Slack message counted on one surface and not on another, and the
// conversation snapshot a Slack read files as provenance counted as a second touch. One answer:
//
//   evidence snapshot  a copy of a whole conversation kept so a finding can cite it. Never a
//                      timeline row, never a touch, never a person's activity.
//   direction          the payload's is_outbound when the source wrote it (Slack, LinkedIn and
//                      legacy Slack DMs carry every direction under one type), else the type name.
//   chat message       a Slack message or DM. What the customer wrote in a channel is a reply.

/** Activity types that are provenance copies of a conversation, not something that happened. */
export const EVIDENCE_SNAPSHOT_TYPES = Object.freeze(['slack_conversation', 'slack_dm_conversation']);
export function isEvidenceSnapshot(activityType) {
  return EVIDENCE_SNAPSHOT_TYPES.includes(String(activityType ?? '').toLowerCase().replace(/^interaction\./, ''));
}

/** Sent by us (true), by them (false), or not recorded (null). Reads a row or its raw payload. */
export function activityOutbound(a) {
  const v = a?.is_outbound ?? a?.raw_data?.is_outbound ?? a?.raw?.is_outbound;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

/** A chat message type (Slack today), whose direction lives only in the payload. */
export const isChatMessage = (activityType) => /^slack_(message|dm)$/.test(String(activityType ?? '').toLowerCase());

// Which activity types count as real two-way engagement (exclude system/enrichment).
export function isEngagementEvent(activityType) {
  const t = (activityType || '').toLowerCase();
  if (isEvidenceSnapshot(t)) return false;
  if (/enrichment|scored|created|updated|deal_won|import/.test(t)) return false;
  return /meeting|received|reply|sent|linkedin|call|message|email/.test(t);
}
const isInboundType = (t) => /received|reply|inbound/.test((t || '').toLowerCase()) && !/_sent$/.test((t || '').toLowerCase());
const isOutboundType = (t) => /_sent$|^sent/.test((t || '').toLowerCase());
/** Did the buyer send this? The payload's direction wins over the type name. */
export function isInboundActivity(a) {
  const type = a?.activity_type ?? a?.type;
  if (isEvidenceSnapshot(type)) return false;
  const out = activityOutbound(a);
  if (out != null && /message|linkedin|inmail|email|reply|dm/.test(String(type ?? '').toLowerCase())) return !out;
  return isInboundType(type);
}
/** Did we send this? */
export function isOutboundActivity(a) {
  const type = a?.activity_type ?? a?.type;
  if (isEvidenceSnapshot(type)) return false;
  const out = activityOutbound(a);
  if (out != null && /message|linkedin|inmail|email|reply|dm/.test(String(type ?? '').toLowerCase())) return out;
  return isOutboundType(type);
}

// Trend from two equal windows (recent 30d vs prior 30d activity counts).
export function engagementTrend(recent, prior) {
  if (!recent && !prior) return 'cold';
  if (!recent) return 'cooling';
  if (!prior) return 'rising';
  const r = recent / prior;
  if (r >= 1.25) return 'rising';
  if (r <= 0.6) return 'cooling';
  return 'steady';
}

// Median days the BUYER takes to respond: for each inbound, the gap since our most
// recent prior outbound. Null when there are no outbound→inbound pairs.
export function medianBuyerResponseDays(activities) {
  const rows = (activities || [])
    .map(a => ({ t: new Date(a.occurred_at || a.created_at).getTime(), out: isOutboundActivity(a), in: isInboundActivity(a) }))
    .filter(a => Number.isFinite(a.t))
    .sort((a, b) => a.t - b.t);
  const gaps = [];
  let lastOut = null;
  for (const a of rows) {
    if (a.out) lastOut = a.t;
    else if (a.in && lastOut != null && a.t >= lastOut) { gaps.push((a.t - lastOut) / DAY); lastOut = null; }
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  const m = Math.floor(gaps.length / 2);
  return +(gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2).toFixed(1);
}

/**
 * The buyer answered, on any channel: a meeting or call held, or anything they sent. Deal health's
 * Last Response and the list's reason line both read this one rule (GET-976).
 */
export function isBuyerResponse(a) {
  const t = String(a?.activity_type ?? '').toLowerCase();
  if (!t || isEvidenceSnapshot(t)) return false;
  if (/_sent$|enrichment|deal_won|scheduled|created|updated|scored|product_used|signed_up/.test(t)) return false;
  if (activityOutbound(a) === true) return false;
  return /meeting|received|reply|inbound|call|linkedin|message|dm/.test(t);
}

/** A touch that is a person taking part in a conversation with us: a meeting or call held, or
 *  something they wrote. Product use, a connection accepted or an open is not. */
export function isDirectParticipation(a) {
  const t = String(a?.activity_type ?? '').toLowerCase();
  if (!t || isEvidenceSnapshot(t)) return false;
  if (/scheduled|booked|cancel|no_show|missed|enrichment|created|updated|scored|import|connect|invite|visit|opened|product_used|signed_up/.test(t)) return false;
  if (/meeting|(^|_)call(_|$)/.test(t)) return true;
  return isInboundActivity(a);
}

/**
 * Multi-threading: breadth of relationship at the account (GET-976).
 *
 * With the activity rows, a person is ENGAGED only when they took part in a conversation in the last
 * 45 days (a meeting, a call, or something they wrote). A product user and someone merely
 * identified are counted apart, so "2/5 in conversation, 1 using the product" says what it means;
 * a title or a new contact record never adds engagement. Without activity (old callers) it falls
 * back to the record's own signals and last touch.
 */
export function multiThread(stakeholders, now = Date.now(), activity = null) {
  const people = stakeholders || [];
  const total = people.length;
  if (!Array.isArray(activity)) {
    const engaged = people.filter(s =>
      (s.signal_count || 0) > 0 ||
      (s.last_activity_at && (now - new Date(s.last_activity_at).getTime()) / DAY <= 45)).length;
    return { total, engaged, single_threaded: engaged <= 1 };
  }
  const recent = (a) => { const t = Date.parse(a.occurred_at || a.created_at || ''); return Number.isFinite(t) && t <= now + 60_000 && now - t <= 45 * DAY; };
  const byPerson = new Map();
  for (const a of activity) if (a?.contact_id && recent(a)) (byPerson.get(a.contact_id) ?? byPerson.set(a.contact_id, []).get(a.contact_id)).push(a);
  const direct = [], product = [];
  for (const s of people) {
    const mine = byPerson.get(s.id) || [];
    if (mine.some(isDirectParticipation)) direct.push(s.id);
    else if (mine.some(a => /product_used|signed_up/.test(String(a.activity_type ?? '').toLowerCase()))) product.push(s.id);
  }
  return { total, engaged: direct.length, product_users: product.length,
    identified: total - direct.length - product.length, engaged_ids: direct, product_user_ids: product,
    single_threaded: direct.length <= 1 };
}

// Recent/prior 30d engagement counts from an activity array (occurred_at based).
export function windowedCounts(activities, now = Date.now()) {
  let recent = 0, prior = 0;
  for (const a of activities || []) {
    if (!isEngagementEvent(a.activity_type)) continue;
    const t = new Date(a.occurred_at || a.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const age = (now - t) / DAY;
    if (age <= 30) recent++;
    else if (age <= 60) prior++;
  }
  return { recent, prior };
}

export const ENGAGEMENT_DEFS = {
  engagement_trend: 'rising|steady|cooling|cold — activity in the last 30d vs the prior 30d',
  multi_threading: 'people who took part in a conversation in 45 days (meeting, call, or wrote to us) / people on the account; product users and people only identified are counted apart; single_threaded = one or none in conversation (a risk)',
  response_time_days: 'median days the buyer takes to reply to our outreach (lower = warmer)',
};
