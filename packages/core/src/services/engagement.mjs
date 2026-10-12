// Engagement metrics — the leading indicators the deal-health score, the pipeline tool,
// and the flag sweep all share. Three things that predict a deal cooling before the
// number moves: is engagement RISING or COOLING (trend), are we MULTI-THREADED (breadth),
// and how fast does the buyer RESPOND. All derived from the activity log. See
// docs/revenue-layer-gap-analysis.md (P3 engagement layer).
const DAY = 86_400_000;

// Which activity types count as real two-way engagement (exclude system/enrichment).
export function isEngagementEvent(activityType) {
  const t = (activityType || '').toLowerCase();
  if (/enrichment|scored|created|updated|deal_won|import/.test(t)) return false;
  return /meeting|received|reply|sent|linkedin|call|message|email/.test(t);
}
const isInbound = (t) => /received|reply|inbound/.test((t || '').toLowerCase()) && !/_sent$/.test((t || '').toLowerCase());
const isOutbound = (t) => /_sent$|^sent/.test((t || '').toLowerCase());

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
    .map(a => ({ t: new Date(a.occurred_at || a.created_at).getTime(), type: a.activity_type }))
    .filter(a => Number.isFinite(a.t))
    .sort((a, b) => a.t - b.t);
  const gaps = [];
  let lastOut = null;
  for (const a of rows) {
    if (isOutbound(a.type)) lastOut = a.t;
    else if (isInbound(a.type) && lastOut != null && a.t >= lastOut) { gaps.push((a.t - lastOut) / DAY); lastOut = null; }
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  const m = Math.floor(gaps.length / 2);
  return +(gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2).toFixed(1);
}

// Multi-threading: breadth of relationship at the account.
export function multiThread(stakeholders, now = Date.now()) {
  const total = (stakeholders || []).length;
  const engaged = (stakeholders || []).filter(s =>
    (s.signal_count || 0) > 0 ||
    (s.last_activity_at && (now - new Date(s.last_activity_at).getTime()) / DAY <= 45)).length;
  return { total, engaged, single_threaded: engaged <= 1 };
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
  multi_threading: 'engaged contacts / total contacts at the account; single_threaded = only one person engaged (a risk)',
  response_time_days: 'median days the buyer takes to reply to our outreach (lower = warmer)',
};
