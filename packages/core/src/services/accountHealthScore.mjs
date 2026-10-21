// Account health (GET-800): what the ACCOUNT page shows, kept apart from deal health.
//
// Deal health asks "will this deal close": competitors, objections, urgency, budget. That is the
// right read on a deal page and the wrong one on an account, where a rep asks "how is this
// relationship": are they talking to us, are the people who decide in the conversation, is
// anything blocking, has a risk been raised, and, for a customer, are they using it.
//
// So the account gets its own five factors, each graded from the same facts the record shows and
// each carrying the claim ids that justify it (the card expands them into the claims, quote and
// date). Deal health is untouched and still drives the deal page.
//
// Also here, because the account page and deal health both need them and must not drift:
//   decisionMakers  — every decision role on the account, named or not, with a status
//   committeeRating — engaged decision makers over known ones (unnamed roles count)
//   selectNextStep  — the latest follow-up agreed in two weeks, never an old open task (GET-804)
//
// Pure functions first; the loader at the end is the only I/O.

import { readTitle } from './titleRead.js';
import { COMMITTEE_ROLE_RANK } from './committee.js';
import { engagementTrend, isEvidenceSnapshot, activityOutbound, isChatMessage, EVIDENCE_SNAPSHOT_TYPES } from './engagement.mjs';
import { loadHealthInputs, loadNextSteps } from './dealHealth.mjs';

const DAY = 86_400_000;

/** The roles the Qualification panel lists. A blocker is listed (as blocking) but never counts as coverage. */
export const DECISION_ROLES = ['economic_buyer', 'decision_maker', 'champion', 'blocker'];
const ROLE_ORDER = { economic_buyer: 0, decision_maker: 1, champion: 2, blocker: 3 };

/** How long a reply keeps a person "engaged". */
const ENGAGED_WINDOW_DAYS = 45;

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const lower = (s) => String(s ?? '').trim().toLowerCase();
const tsOf = (a) => ms(a?.occurred_at || a?.created_at);

/**
 * A real two-way touch: they replied, wrote in, or we met. Our own outbound is not engagement.
 * `outbound` is the row's payload direction (GET-976): a Slack or LinkedIn message they wrote is a
 * reply even though its type does not say so; one we wrote is not.
 */
export function isTwoWay(activityType, outbound = null) {
  const t = lower(activityType);
  if (!t || isEvidenceSnapshot(t) || /_sent$|^sent|scheduled|enrichment|created|updated|scored|deal_|import|note/.test(t)) return false;
  if (outbound != null && /message|linkedin|inmail|dm/.test(t) && !/connect|invite/.test(t)) return outbound === false;
  return /meeting|received|reply|inbound|call/.test(t);
}

/** A conversation the next step can come from: a meeting held, a call, an email or a chat message. */
function isConversation(activityType) {
  const t = lower(activityType);
  if (!t || isEvidenceSnapshot(t) || /scheduled|enrichment|created|updated|scored|deal_|import/.test(t)) return false;
  return /meeting|call|email|reply|received/.test(t) || isChatMessage(t);
}

// ── Engagement (GET-804) ────────────────────────────────────────────────────
//
// GET-800 counted the last 30 days against the 30 before from whatever activity the caller had,
// and the account page handed it its newest 100 rows. A busy account fills 100 rows inside a
// month, so the window before it was always empty: "41 two-way touches in the last 30 days, 0 in
// the 30 before" on an account that had a call and a thread in that window. Call pages were never
// counted at all. Both windows now count the same sources out of a set loaded for the window
// (loadEngagementActivity, no row cap), and a call page counts as the call it records.

/** Never a touch: system rows, bookings that have not happened, things that did not connect. */
const NOT_A_TOUCH = /scheduled|booked|cancel|no_show|missed|bounce|enrichment|created|updated|scored|deal_|import|note|connection|connected|invite|visit|unsubscrib|subscription|onboarding|welcome|drip|offer|payment|interest|engagement|job_change|proposal|signed_up|product_used/;
const INBOUND_TOUCH = /received|reply|replied|inbound/;
const OUTBOUND_TOUCH = /_sent$|^sent|_made$/;

/**
 * Is this activity a two-way touch? A meeting held or a call that connected always is, and so is
 * anything they wrote (an email, a reply, a LinkedIn message). Our own email counts too, but only on
 * a conversation (`conversational`: they have replied or met with us at some point), so a cold
 * sequence never reads as engagement.
 */
export function isTwoWayTouch(activityType, { conversational = true, outbound = null } = {}) {
  const t = lower(activityType);
  if (!t || isEvidenceSnapshot(t) || NOT_A_TOUCH.test(t)) return false;
  if (/meeting|call/.test(t)) return true;
  if (/email|message|linkedin|inmail|reply|replied|received|inbound|dm/.test(t)) {
    // Direction from the payload when the source wrote it (GET-976): a Slack message from the
    // customer is a reply; ours counts only on a conversation, like our own email.
    if (outbound === false) return true;
    if (outbound === true) return conversational;
    if (INBOUND_TOUCH.test(t) && !/_sent$/.test(t)) return true;
    return conversational && (OUTBOUND_TOUCH.test(t) || /^email$|^message$/.test(t));
  }
  return false;
}

/** A call page within this long of a meeting or call row is that conversation, not another one. */
const SAME_CALL_MS = 3 * 3_600_000;

/**
 * The two-way touches the engagement trend counts, as one list of timestamps: activity rows that
 * are touches, plus each call page (dated by when the call happened) that no meeting or call row
 * already records. Future rows are dropped. Pure.
 */
export function twoWayTouches({ activity = [], calls = [], now = Date.now() } = {}) {
  const acts = (activity || []).filter(a => { const t = tsOf(a); return t != null && t <= now + 60_000; });
  const conversational = acts.some(a => isTwoWayTouch(a.activity_type, { conversational: false, outbound: activityOutbound(a) }))
    || (calls || []).some(c => { const t = ms(c.occurred_at); return t != null && t <= now + 60_000; });
  const touches = acts.filter(a => isTwoWayTouch(a.activity_type, { conversational, outbound: activityOutbound(a) }))
    .map(a => ({ t: tsOf(a), kind: /meeting|call/.test(lower(a.activity_type)) ? 'call' : 'message' }));
  const callRows = touches.filter(x => x.kind === 'call').map(x => x.t);
  for (const c of calls || []) {
    const t = ms(c.occurred_at);
    if (t == null || t > now + 60_000) continue;
    if (callRows.some(r => Math.abs(r - t) <= SAME_CALL_MS)) continue;
    touches.push({ t, kind: 'call' });
    callRows.push(t);
  }
  return touches.map(x => x.t).sort((a, b) => a - b);
}

/** Two-way touches in the last 30 days and in the 30 before, from the same sources. Pure. */
export function engagementWindows({ activity = [], calls = [], now = Date.now() } = {}) {
  const ts = twoWayTouches({ activity, calls, now });
  const recent = ts.filter(t => now - t <= 30 * DAY).length;
  const prior = ts.filter(t => now - t > 30 * DAY && now - t <= 60 * DAY).length;
  const last = ts.length ? ts[ts.length - 1] : null;
  return { recent, prior, total: ts.length, last_at: last != null ? new Date(last).toISOString() : null };
}

/**
 * The factor's meter: how many of its three bars fill and in what colour, from its grade alone.
 * Good is three green bars, warn two amber, bad one red, unknown none (grey). GET-800 filled the
 * bars from the level's wording, and "Rising" matched no word, so a good engagement drew grey.
 */
export const GRADE_METER = Object.freeze({
  good: Object.freeze({ bars: 3, color: '#2E7A4E' }),
  warn: Object.freeze({ bars: 2, color: '#C08A3E' }),
  bad: Object.freeze({ bars: 1, color: '#B0412E' }),
  unknown: Object.freeze({ bars: 0, color: '#A9A8A2' }),
});
export function gradeMeter(tone) {
  return GRADE_METER[tone] ?? GRADE_METER.unknown;
}

// ── Decision makers ─────────────────────────────────────────────────────────

// The executive roles an unnamed authority claim names by title. Each maps its spellings to one key.
const ROLE_TITLES = [
  ['ceo', /\bceo\b|\bchief executive( officer)?\b/],
  ['coo', /\bcoo\b|\bchief operating( officer)?\b/],
  ['cfo', /\bcfo\b|\bchief financial( officer)?\b/],
  ['cto', /\bcto\b|\bchief technology( officer)?\b/],
  ['cro', /\bcro\b|\bchief revenue( officer)?\b/],
  ['cmo', /\bcmo\b|\bchief marketing( officer)?\b/],
  ['cpo', /\bcpo\b|\bchief product( officer)?\b/],
  ['ciso', /\bciso\b|\bchief information security( officer)?\b/],
  ['cio', /\bcio\b|\bchief information officer\b/],
];
const roleKeys = (title) => ROLE_TITLES.filter(([, re]) => re.test(lower(title))).map(([k]) => k);
/** The single role a claim's title names ("CEO", "the chief executive"), or null for anything else. */
const roleKey = (title) => { const k = roleKeys(title); return k.length === 1 ? k[0] : null; };

/**
 * Every decision role on the account, named and unnamed, with where it stands.
 *
 * Sources, in this order: a stakeholder already carrying a decision role (an influence edge, an
 * authority claim, or their title, as the org chart reads it), then each authority claim with a
 * `metadata.role`. A claim about someone not on record yet ("our CEO has the final say") has
 * `person_title` and no `person_name`: it becomes an unnamed role, unless a known person holds
 * that exact title, in which case it is them.
 *
 * Status: `blocking` (the role is a blocker) · `engaged` (a two-way touch in 45 days, or the claim
 * says engaged) · `not_engaged` (we have reached out, or the claim says not engaged) ·
 * `not_contacted` (nothing on record either way).
 */
export function decisionMakers({ notes = [], stakeholders = [], activity = [], now = Date.now() } = {}) {
  const people = (stakeholders || []).filter(s => s && s.id);
  const byId = new Map(people.map(s => [s.id, s]));
  const byName = new Map(people.filter(s => s.name).map(s => [lower(s.name), s]));
  const byTitle = new Map(people.filter(s => s.title).map(s => [lower(s.title), s]));
  // An unnamed role ("our CEO") is the one person whose title holds that same role (GET-976):
  // "CEO" is the person titled "Founder & CEO". Exactly one holder or none, never a guess between
  // two, and the role is read as a whole word so "CTO" is never "Director".
  const holderOfTitle = (title) => {
    const exact = byTitle.get(lower(title));
    if (exact) return { s: exact, by: 'exact_title' };
    const key = roleKey(title);
    if (!key) return null;
    const holders = people.filter(s => s.title && roleKeys(s.title).includes(key));
    return holders.length === 1 ? { s: holders[0], by: 'role_in_title' } : null;
  };

  const entries = new Map();
  const better = (a, b) => (b && (!a || (COMMITTEE_ROLE_RANK[b] ?? -1) > (COMMITTEE_ROLE_RANK[a] ?? -1)) ? b : a);
  const entryFor = (key, init) => {
    if (!entries.has(key)) entries.set(key, { key, entity_id: null, name: null, title: null, role: null, unnamed: false, basis: null, evidence: [], quote: null, said_at: null, engagement: null, ...init });
    return entries.get(key);
  };
  const personEntry = (s) => entryFor(s.id, { entity_id: s.id, name: s.name ?? null, title: s.title ?? null });

  for (const s of people) {
    if (!DECISION_ROLES.includes(s.role)) continue;
    const e = personEntry(s);
    e.role = better(e.role, s.role);
    e.basis = s.role_basis ?? e.basis;
  }

  const authority = (notes || [])
    .filter(n => lower(n.category) === 'authority' && DECISION_ROLES.includes(n.metadata?.role))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));   // newest last wins the quote
  for (const n of authority) {
    const m = n.metadata || {};
    const pname = typeof m.person_name === 'string' && m.person_name.trim() ? m.person_name.trim() : null;
    const ptitle = typeof m.person_title === 'string' && m.person_title.trim() ? m.person_title.trim() : null;
    let e;
    const byRole = !pname && ptitle && !(n.entity_id && byId.get(n.entity_id)) ? holderOfTitle(ptitle) : null;
    const known = (n.entity_id && byId.get(n.entity_id)) || (pname && byName.get(lower(pname))) || byRole?.s || null;
    if (known) {
      e = personEntry(known);
      // Who said the role and how it was matched stay with the entry: the claim named a title, the
      // person record supplied the name. Their engagement is still read from their own touches.
      if (byRole) { e.matched_by = byRole.by; e.claim_title = ptitle; }
    }
    else if (pname) e = entryFor(`name:${lower(pname)}`, { name: pname, title: ptitle });
    else if (ptitle) e = entryFor(`title:${lower(ptitle)}`, { title: ptitle, unnamed: true });
    else continue;   // a company-level authority fact with nobody attached to it
    e.role = better(e.role, m.role);
    e.basis = 'evidence';
    e.evidence.push(n.id);
    if (typeof m.quote === 'string' && m.quote.trim()) e.quote = m.quote.trim();
    e.said_at = n.created_at ?? e.said_at;
    if (typeof m.engagement === 'string' && m.engagement.trim()) e.engagement = lower(m.engagement).replace(/[\s-]+/g, '_');
  }

  const acts = activity || [];
  const touchesOf = (id) => acts.filter(a => a.contact_id === id);
  const twoWayAt = (a) => isTwoWay(a.activity_type, activityOutbound(a));
  const status = (e) => {
    if (e.role === 'blocker' || e.engagement === 'blocking') return 'blocking';
    if (e.entity_id) {
      const mine = touchesOf(e.entity_id);
      const lastTwoWay = Math.max(-Infinity, ...mine.filter(twoWayAt).map(tsOf).filter(t => t != null && t <= now + 60_000));
      if (Number.isFinite(lastTwoWay) && now - lastTwoWay <= ENGAGED_WINDOW_DAYS * DAY) return 'engaged';
      // With no activity loaded at all, fall back to the record's own last touch.
      const s = byId.get(e.entity_id);
      if (!acts.length && s?.last_activity_at && now - (ms(s.last_activity_at) ?? -Infinity) <= 45 * DAY) return 'engaged';
      if (e.engagement === 'engaged') return 'engaged';
      if (mine.length || e.engagement === 'not_engaged' || s?.last_activity_at) return 'not_engaged';
      return 'not_contacted';
    }
    if (e.engagement === 'engaged') return 'engaged';
    if (e.engagement === 'not_engaged') return 'not_engaged';
    return 'not_contacted';
  };

  return [...entries.values()]
    .filter(e => e.role)
    .map(e => ({
      key: e.key, entity_id: e.entity_id, name: e.name, title: e.title, role: e.role,
      status: status(e), unnamed: e.unnamed, basis: e.basis,
      ...(e.matched_by ? { matched_by: e.matched_by, claim_title: e.claim_title } : {}),
      tier: readTitle(e.title ?? '').tier ?? null,
      evidence: e.evidence, quote: e.quote, said_at: e.said_at,
    }))
    .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (Number(a.unnamed) - Number(b.unnamed)) || String(a.name ?? a.title ?? '').localeCompare(String(b.name ?? b.title ?? '')));
}

/**
 * The buying-committee rating: engaged decision makers over known decision makers, unnamed roles
 * included. A blocker is not coverage and sits outside both counts. Strong needs three in four
 * engaged, so one of two is Moderate.
 */
export function committeeRating(list = []) {
  const known = (list || []).filter(d => d && d.role !== 'blocker');
  const engaged = known.filter(d => d.status === 'engaged');
  const unnamed = known.filter(d => d.unnamed);
  const k = known.length, e = engaged.length;
  const [level, tone] = !k ? ['Unknown', 'unknown']
    : e / k >= 0.75 ? ['Strong', 'good']
    : e > 0 ? ['Moderate', 'warn']
    : ['Weak', 'bad'];
  const reason = !k
    ? 'No decision maker named on this account yet'
    : `${e} of ${k} decision maker${k === 1 ? '' : 's'} engaged${unnamed.length ? `, including ${unnamed.length} not yet named (${unnamed.map(d => d.title).filter(Boolean).slice(0, 3).join(', ')})` : ''}`;
  return { level, tone, engaged: e, known: k, reason };
}

// ── The factor panel (GET-807) ──────────────────────────────────────────────
//
// GET-804's pop-up was a grey slab that repeated the numbers row and never listed what it counted
// ("5 open", without which five). Each factor now carries its items, a one-line summary and a
// "what would improve it" line picked from those items. Pure.

/** A blocker said this long ago, with no later mention, is aging. */
export const AGING_DAYS = 21;
const WORD_NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const inWords = (k) => WORD_NUM[k] ?? String(k);
const said = (n) => n?.metadata?.occurred_at || n?.said_at || n?.created_at || null;
/** A claim's short handle: its label, else the named thing, else its first eight words. */
const tagOf = (n) => {
  const label = String(n?.label ?? '').trim();
  if (label) return label;
  const entity = String(n?.metadata?.entity ?? '').trim();
  if (entity) return entity;
  const words = String(n?.content ?? '').trim().split(/\s+/).filter(Boolean);
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : words.join(' ');
};
const sameThing = (a, b) => {
  const la = lower(a.label), lb = lower(b.label);
  if (la && la === lb) return true;
  const sa = lower(a.subject ?? a.metadata?.subject), sb = lower(b.subject ?? b.metadata?.subject);
  return !!sa && sa === sb;
};
const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : null);

/**
 * The claims behind a count factor, as rows: { id, label, content, quote, speaker, said_at,
 * last_mentioned_at, status, aging, age_days }. Open first, newest first within each group.
 * `aging` (blockers): open, and nothing has mentioned it since — not a reaffirmation, not the same
 * label or subject said again — for more than AGING_DAYS.
 */
export function claimItems(notes = [], { category, stakeholders = [], now = Date.now(), aging = false } = {}) {
  const nameOf = new Map((stakeholders || []).filter(s => s?.id).map(s => [s.id, s.name ?? null]));
  const own = (notes || []).filter(n => n && lower(n.category) === category);
  const items = own.map(n => {
    const m = n.metadata || {};
    const at = said(n);
    const mentions = [at, n.reaffirmed_at, m.reaffirmed_at, m.last_mentioned_at,
      ...own.filter(o => o !== n && sameThing(o, n)).map(said)].map(ms).filter(t => t != null);
    const last = mentions.length ? Math.max(...mentions) : null;
    const open = isOpen(n);
    const age = last != null ? Math.floor((now - last) / DAY) : null;
    const quote = typeof m.quote === 'string' && m.quote.trim() ? m.quote.trim() : null;
    const speaker = (m.voiced_by_contact_id && nameOf.get(m.voiced_by_contact_id))
      || (typeof m.speaker === 'string' && m.speaker.trim() ? m.speaker.trim() : null);
    return {
      id: n.id, label: tagOf(n), content: n.content ?? '', quote, speaker: speaker || null,
      said_at: at, last_mentioned_at: last != null ? new Date(last).toISOString() : null,
      status: open ? 'open' : 'resolved',
      aging: !!(aging && open && age != null && age > AGING_DAYS), age_days: age,
    };
  });
  return items.sort((a, b) => (Number(b.status === 'open') - Number(a.status === 'open'))
    || String(b.said_at ?? '').localeCompare(String(a.said_at ?? '')));
}

/** Conversations per week for the last `weeks` weeks, oldest first, this week last. Pure. */
export function weeklyConversations(timestamps = [], now = Date.now(), weeks = 8) {
  const out = new Array(weeks).fill(0);
  for (const t of timestamps || []) {
    if (t == null || t > now + 60_000) continue;
    const w = Math.floor(Math.max(0, now - t) / (7 * DAY));
    if (w < weeks) out[weeks - 1 - w] += 1;
  }
  return out;
}

const DM_IMPROVE_ROLE = { economic_buyer: 'economic buyer', decision_maker: 'decision maker', champion: 'champion' };

/**
 * The "what would improve it" line for one factor, from that factor's own data, or null when
 * nothing would. blockers: the oldest open one. decision_makers: the first decider not engaged
 * (the list is ordered economic buyer, decision maker, champion), else a blocker to win over.
 * risk_signals: the newest open risk. engagement: only when it is slipping. adoption: the idle seats.
 */
export function improveFor(key, ctx = {}) {
  const items = ctx.items || [];
  if (key === 'blockers') {
    const open = items.filter(i => i.status === 'open');
    if (!open.length) return null;
    const oldest = open.reduce((p, q) => ((ms(q.last_mentioned_at ?? q.said_at) ?? Infinity) < (ms(p.last_mentioned_at ?? p.said_at) ?? Infinity) ? q : p));
    const when = shortDay(oldest.said_at);
    return `Resolve the oldest open blocker first: ${oldest.label}${when ? `, raised ${when}` : ''}`;
  }
  if (key === 'risk_signals') {
    const open = items.filter(i => i.status === 'open');
    if (!open.length) return null;
    const newest = open.reduce((p, q) => (String(q.said_at ?? '') > String(p.said_at ?? '') ? q : p));
    return `Address the latest risk: ${newest.label}`;
  }
  if (key === 'decision_makers') {
    if (!items.length) return 'Find out who signs off: ask who else has to approve this';
    const order = ['economic_buyer', 'decision_maker', 'champion'];
    const gap = items.filter(i => i.role !== 'blocker' && i.status !== 'engaged')
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))[0];
    if (gap) {
      const who = gap.name ?? (gap.title ? `the ${gap.title}` : `the ${DM_IMPROVE_ROLE[gap.role] ?? 'decision maker'}`);
      return gap.status === 'not_contacted'
        ? `Reach ${who}, the ${DM_IMPROVE_ROLE[gap.role] ?? 'decision maker'}: not contacted yet`
        : `Get ${who} back into the conversation: the ${DM_IMPROVE_ROLE[gap.role] ?? 'decision maker'} has not engaged`;
    }
    const blocking = items.find(i => i.status === 'blocking');
    return blocking ? `Win over ${blocking.name ?? (blocking.title ? `the ${blocking.title}` : 'the blocker')}, who is blocking` : null;
  }
  if (key === 'engagement') {
    const { trend, daysQuiet, hasConversation, none } = ctx;
    const ago = daysQuiet === 0 ? 'today' : daysQuiet === 1 ? 'yesterday' : `${daysQuiet} days ago`;
    if (none) return hasConversation ? 'Get a first reply or a meeting: nothing back from them yet' : 'Start a conversation: nothing on record yet';
    if (trend === 'cold' || trend === 'cooling') return `Book the next conversation: the last one was ${ago}`;
    return null;
  }
  if (key === 'adoption') {
    const { active, total } = ctx;
    if (!Number.isFinite(active) || !Number.isFinite(total) || total <= 0) return 'Ask for the active-user count so adoption can be read';
    if (active / total >= 0.6) return null;
    return `Help the idle seats get started: ${total - active} of ${total} have not used it in 30 days`;
  }
  return null;
}

// ── Account health ──────────────────────────────────────────────────────────

const TONE_VAL = { good: 85, warn: 55, unknown: 55, bad: 25 };
const isOpen = (n) => !/^(resolved|closed|done|dismissed)$/.test(lower(n.metadata?.status) || 'open');
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * The account's health: a 0-100 score, a band, and the factors behind it in the deal-health card's
 * shape (`smart` / `numeric`), so the same card draws both.
 *
 * `customer` is `{ activeUsers, totalUsers }` from the CRM's customer bag when the account is a
 * customer, and null otherwise: only a customer has an adoption factor.
 */
export function computeAccountHealth({ notes = [], activity = [], calls = [], stakeholders = [], customer = null, now = Date.now() } = {}) {
  const acts = (activity || []).filter(a => { const t = tsOf(a); return t != null && t <= now + 60_000; });
  const { recent, prior, total, last_at: lastTwoWay } = engagementWindows({ activity: acts, calls, now });
  const daysQuiet = lastTwoWay ? Math.floor((now - ms(lastTwoWay)) / DAY) : null;
  const hasConversation = acts.length > 0 || (calls || []).some(c => { const t = ms(c.occurred_at); return t != null && t <= now + 60_000; });
  const ago = (d) => (d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`);

  // ── Engagement trend: two-way touches in the last 30 days against the 30 before. ──
  const trend = engagementTrend(recent, prior);
  const TREND = { rising: ['Rising', 'good'], steady: ['Steady', 'good'], cooling: ['Cooling', 'warn'], cold: ['Cold', 'bad'] };
  const touches = (k) => plural(k, 'two-way touch', 'two-way touches');
  const VERDICT = {
    rising: () => `Engagement is rising: ${touches(recent)} in the last 30 days, up from ${prior}`,
    steady: () => `Engagement is steady: ${touches(recent)} in the last 30 days, against ${prior} in the 30 before`,
    cooling: () => `Engagement is cooling: ${touches(recent)} in the last 30 days, down from ${prior}`,
    cold: () => `Engagement has gone cold: no two-way touch in 60 days${daysQuiet != null ? `, the last one ${ago(daysQuiet)}` : ''}`,
  };
  const SUMMARY = {
    rising: 'rising, more conversations than the month before',
    steady: 'steady, about as many conversations as the month before',
    cooling: 'cooling, fewer conversations than the month before',
    cold: 'cold, no conversation in 60 days',
  };
  const engagement = !total
    ? { level: 'Unknown', tone: 'unknown', value: 'None yet',
        reason: hasConversation ? 'We have reached out, but they have not replied or met with us yet' : 'No conversation on record yet',
        verdict: hasConversation ? 'No engagement yet: we have reached out, but they have not replied or met with us' : 'No engagement yet: no conversation on record',
        summary: hasConversation ? 'no reply or meeting yet' : 'no conversation yet' }
    : { level: TREND[trend][0], tone: TREND[trend][1], value: `${recent} in 30d`,
        reason: `${touches(recent)} in the last 30 days, ${prior} in the 30 before. Last one ${ago(daysQuiet)}`,
        verdict: VERDICT[trend](), summary: SUMMARY[trend] };
  // The panel's numbers (GET-807): what the stats row under the factors used to repeat.
  const meetings = acts.filter(a => /meeting/.test(lower(a.activity_type)) && !/scheduled|booked|cancel|no_show|interest/.test(lower(a.activity_type))).length;
  engagement.detail = { weeks: weeklyConversations(twoWayTouches({ activity: acts, calls, now }), now), last_at: lastTwoWay, recent, prior, meetings };
  engagement.items = [];
  engagement.improve = improveFor('engagement', { trend, daysQuiet, hasConversation, none: !total });

  // ── Decision makers covered. ──
  const dms = decisionMakers({ notes, stakeholders, activity: acts, now });
  const rating = committeeRating(dms);
  const unnamedCount = dms.filter(d => d.role !== 'blocker' && d.unnamed).length;
  const blockingCount = dms.filter(d => d.status === 'blocking').length;
  const decision = { level: rating.level, tone: rating.tone, value: rating.known ? `${rating.engaged}/${rating.known} engaged` : 'None named', reason: rating.reason,
    verdict: !rating.known ? 'No decision maker named on this account yet'
      : `${rating.level === 'Strong' ? 'The people who decide are in the conversation' : rating.level === 'Moderate' ? 'Some of the people who decide are in the conversation' : 'None of the people who decide are in the conversation'}: ${rating.engaged} of ${rating.known} engaged`,
    summary: !rating.known ? 'none named yet'
      : `${rating.engaged} of ${rating.known} engaged${unnamedCount ? `, ${inWords(unnamedCount)} not yet named` : ''}${blockingCount ? `, ${inWords(blockingCount)} blocking` : ''}`,
    items: dms, improve: improveFor('decision_makers', { items: dms }),
    evidence: dms.filter(d => d.role !== 'blocker').flatMap(d => d.evidence) };

  // ── Open blockers and risk signals: claims still open, graded by count. Silence on an account we
  //    have never spoken to is unknown, not clear. ──
  const openOf = (category) => (notes || []).filter(n => lower(n.category) === category && isOpen(n));
  const countFactor = (category, noun, one) => {
    const open = openOf(category);
    const items = claimItems(notes, { category, stakeholders, now, aging: category === 'blocker' });
    const improve = improveFor(category === 'blocker' ? 'blockers' : 'risk_signals', { items });
    const k = open.length;
    if (!k) return hasConversation
      ? { level: 'None open', tone: 'good', value: '0 open', reason: `No open ${noun} on record`, verdict: `No open ${noun}: nothing raised that is still unresolved`, summary: 'none open', items, improve, evidence: [] }
      : { level: 'Unknown', tone: 'unknown', value: '0 open', reason: `No conversation yet, so no ${noun} either way`, verdict: `No conversation yet, so no ${noun} either way`, summary: 'nothing raised yet', items, improve, evidence: [] };
    const agingOpen = items.filter(i => i.aging);
    const oldestAge = agingOpen.length ? Math.max(...agingOpen.map(i => i.age_days)) : 0;
    const agingText = !agingOpen.length ? ''
      : agingOpen.length === 1 ? `, one is ${inWords(Math.floor(oldestAge / 7))} weeks old`
      : `, ${inWords(agingOpen.length)} are over three weeks old`;
    return { level: k === 1 ? 'One open' : `${k} open`, tone: k === 1 ? 'warn' : 'bad', value: `${k} open`,
      reason: `${plural(k, one, noun)} still open`,
      verdict: k === 1 ? `One ${one} is still open` : `${k} ${noun} are still open`,
      summary: `${k} open${agingText}`, items, improve, evidence: open.map(n => n.id) };
  };
  const blockers = countFactor('blocker', 'blockers', 'blocker');
  const risks = countFactor('risk_signal', 'risk signals', 'risk signal');

  // ── Adoption, a customer only: active users over seats, from the CRM. ──
  let adoption = null;
  if (customer) {
    const active = Number(customer.activeUsers), total = Number(customer.totalUsers);
    const adoptionNotes = (notes || []).filter(n => lower(n.category) === 'adoption').map(n => n.id);
    if (Number.isFinite(active) && Number.isFinite(total) && total > 0) {
      const r = active / total;
      const level = r >= 0.6 ? 'High' : r >= 0.3 ? 'Moderate' : 'Low';
      adoption = { level, tone: r >= 0.6 ? 'good' : r >= 0.3 ? 'warn' : 'bad',
        value: `${active}/${total} active`, reason: `${active} of ${total} users active in the last 30 days (${Math.round(r * 100)}%)`,
        verdict: `Adoption is ${level.toLowerCase()}: ${active} of ${total} users active in the last 30 days`,
        summary: `${active} of ${total} users active`, items: [], improve: improveFor('adoption', { active, total }),
        evidence: adoptionNotes };
    } else {
      adoption = { level: 'Unknown', tone: 'unknown', value: '—', reason: 'The CRM has no active-user count for this customer yet',
        verdict: 'Adoption unknown: the CRM has no active-user count for this customer yet', summary: 'unknown, no active-user count yet',
        items: [], improve: improveFor('adoption', {}), evidence: adoptionNotes };
    }
  }

  const smart = [
    { key: 'engagement', label: 'Engagement', evidence: [], ...engagement },
    { key: 'decision_makers', label: 'Decision makers', ...decision },
    { key: 'blockers', label: 'Open blockers', ...blockers },
    { key: 'risk_signals', label: 'Risk signals', ...risks },
    ...(adoption ? [{ key: 'adoption', label: 'Adoption', ...adoption }] : []),
  ].map(f => ({ ...f, meter: gradeMeter(f.tone) }));
  const score = Math.round(smart.reduce((s, f) => s + (TONE_VAL[f.tone] ?? 55), 0) / smart.length);
  const band = score >= 70 ? 'Healthy' : score >= 40 ? 'Needs attention' : 'At risk';

  // The numbers row under the factors went (GET-807): it repeated the engagement numbers, which now
  // sit in the Engagement panel with plain labels. `numeric` stays in the shape, empty, for the card.
  const numeric = [];
  const unknown = smart.filter(f => f.tone === 'unknown').map(f => f.label);
  return {
    score, band, smart, numeric, decision_makers: dms,
    evidence: { graded: smart.length - unknown.length, total: smart.length, unknown },
  };
}

// ── Next step ───────────────────────────────────────────────────────────────

/**
 * The next step: the latest follow-up AGREED in the last two weeks, across every conversation on
 * the account (GET-804). GET-800 read only the single most recent conversation, so a newer email
 * that agreed nothing hid the follow-up agreed on a call two days before it.
 *
 * Candidates are open follow-ups (`loadNextSteps` rows: action items from a call page, a meeting
 * or an email, { title, status, due_at, occurred_at, source_observation_id, quote }), each dated by
 * when it was agreed: its own `occurred_at`, else the conversation it came from. The most recently
 * agreed wins; the other open steps agreed in that same conversation ride along as `items`, the
 * soonest due first. With none, a meeting already booked is the next step. With neither: "No next
 * step agreed in the last two weeks", never a month-old open task dressed up as a plan.
 */
/**
 * A conversation's name for the card: the meeting's title, which the note-takers write as the
 * description ("Meeting: Pilot review"), else a summary short enough to be one (one line, no
 * markdown). A note-taker's summary is often the whole note, every heading and bullet, and the card
 * printed all of it after "on the call," (GET-827); a conversation with no short name goes unnamed.
 */
function conversationName(a) {
  for (const v of [a?.description, a?.summary]) {
    const s = String(v ?? '').replace(/^meeting:\s*/i, '').trim();
    if (s && s.length <= 80 && !/[\n#*]/.test(s)) return s;
  }
  return null;
}

export function selectNextStep({ activity = [], calls = [], nextSteps = [], now = Date.now(), freshDays = 14 } = {}) {
  const convs = [];
  for (const a of activity || []) {
    const t = tsOf(a);
    if (t == null || t > now + 60_000 || !isConversation(a.activity_type)) continue;
    const type = lower(a.activity_type);
    // A chat message is named by its channel kind, never by its words (GET-976).
    const chat = isChatMessage(type);
    convs.push({ id: a.id ?? null, at: new Date(t).toISOString(), t, kind: chat ? 'slack' : /meeting/.test(type) ? 'meeting' : /call/.test(type) ? 'call' : 'email', title: chat ? null : conversationName(a) });
  }
  for (const c of calls || []) {
    const t = ms(c.occurred_at || c.meeting_date || c.date || c.created_at);
    if (t == null || t > now + 60_000) continue;
    convs.push({ id: c.id ?? null, at: new Date(t).toISOString(), t, kind: 'call', title: c.title || null });
  }
  convs.sort((a, b) => b.t - a.t);
  const last = convs[0] ?? null;
  const convById = new Map(convs.filter(c => c.id).map(c => [c.id, c]));
  // Where a step was agreed: the conversation it cites, else the closest one on the same day
  // (a call page and its meeting row are the same call; the call wins over an email that day).
  const sourceOf = (x) => {
    if (x.source_observation_id && convById.has(x.source_observation_id)) return convById.get(x.source_observation_id);
    if (x.source_id && convById.has(x.source_id)) return convById.get(x.source_id);
    const said = ms(x.occurred_at);
    if (said == null) return null;
    const near = convs.filter(c => Math.abs(c.t - said) <= DAY)
      .sort((p, q) => (Number(p.kind === 'email') - Number(q.kind === 'email')) || (Math.abs(p.t - said) - Math.abs(q.t - said)));
    return near[0] ?? null;
  };

  const cutoff = now - freshDays * DAY;
  const agreed = [];
  for (const x of nextSteps || []) {
    if (!x || !x.title || (x.status || 'open') !== 'open') continue;
    const src = sourceOf(x);
    const at = ms(x.occurred_at) ?? src?.t ?? null;
    if (at == null) {
      // No record of when it was said, but a date still ahead: a live step, ranked below any dated one.
      const due = ms(x.due_at);
      if (due != null && due >= now - DAY) agreed.push({ step: x, src: null, at: -Infinity });
      continue;
    }
    if (at < cutoff || at > now + 60_000) continue;
    agreed.push({ step: x, src, at });
  }
  const dueOrder = (a, b) => (ms(a.step.due_at) ?? Infinity) - (ms(b.step.due_at) ?? Infinity);
  const sameConversation = (a, b) => (a.src && b.src ? a.src === b.src
    : !Number.isFinite(a.at) || !Number.isFinite(b.at) ? a.at === b.at
    : Math.abs(a.at - b.at) <= DAY);

  const conversationOf = (c) => (c ? { kind: c.kind, at: c.at, title: c.title } : null);
  const out = (status, step, items, extra = {}) => ({
    status, title: step?.title ?? null, due_at: step?.due_at ?? null, said_at: step?.occurred_at ?? null,
    agreed_at: extra.agreed_at ?? null, quote: step?.quote ?? null, items: items ?? [],
    conversation: extra.conversation ?? conversationOf(last), reason: extra.reason ?? null,
    // Who asked and who owes it, when the source recorded them (GET-976).
    commitment: step?.commitment ?? null, asked_by: step?.asked_by ?? null, owner_name: step?.owner_name ?? null,
    participants: step?.participants ?? [], slack_mentions: step?.slack_mentions ?? null,
  });

  if (agreed.length) {
    const latest = agreed.reduce((p, q) => (q.at > p.at || (q.at === p.at && dueOrder(q, p) < 0) ? q : p));
    const group = agreed.filter(g => sameConversation(g, latest)).sort(dueOrder);
    const head = group[0];
    const dated = Number.isFinite(latest.at);
    // Requested, not agreed: someone asked and nobody on the owing side has said yes (GET-976).
    // Accepted or scheduled, and every source that records only agreed steps, reads as agreed.
    return out(head.step.commitment === 'requested' ? 'requested' : 'agreed', head.step, group.map(g => g.step.title), {
      agreed_at: dated ? new Date(latest.at).toISOString() : null,
      conversation: conversationOf(latest.src) ?? (dated ? { kind: 'conversation', at: new Date(latest.at).toISOString(), title: null } : null),
    });
  }

  const upcoming = (activity || [])
    .filter(a => /meeting|call/.test(lower(a.activity_type)) && !/cancel|no_show/.test(lower(a.activity_type)) && (tsOf(a) ?? -Infinity) > now)
    .sort((a, b) => tsOf(a) - tsOf(b))[0] ?? null;
  if (upcoming) {
    return out('scheduled', { title: conversationName(upcoming) || 'Meeting booked', due_at: new Date(tsOf(upcoming)).toISOString(), occurred_at: null }, []);
  }
  return out('none', null, [], { reason: last ? 'No next step agreed in the last two weeks' : 'No conversation yet' });
}

// ── Loader ──────────────────────────────────────────────────────────────────

const ENGAGEMENT_PAGE = 1000;

/**
 * Every activity row on these entities since `since`, newest first, with NO row cap: the engagement
 * windows must see the whole 60 days (GET-804; a capped read emptied the earlier window). Pages
 * through PostgREST's 1000-row limit. A system read: the score is shown to the whole team and reads
 * only types and dates, never message content.
 */
export async function loadEngagementActivity(supabase, workspaceId, entityIds, { since, maxRows = 20_000 } = {}) {
  const ids = [...new Set((entityIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    for (let from = 0; out.length < maxRows; from += ENGAGEMENT_PAGE) {
      // Direction only, never the message (GET-976): a Slack message is a reply when they wrote it.
      let q = supabase.from('observations')
        .select('id, entity_id, property, value, source, observed_at, is_outbound:raw->is_outbound')
        .eq('workspace_id', workspaceId).in('entity_id', ids.slice(i, i + 100))
        .like('property', 'interaction.%')
        .not('property', 'in', `(${EVIDENCE_SNAPSHOT_TYPES.map(t => `interaction.${t}`).join(',')})`);
      if (since) q = q.gte('observed_at', since);
      const { data, error } = await q.order('observed_at', { ascending: false }).range(from, from + ENGAGEMENT_PAGE - 1);
      if (error) throw new Error(error.message);
      for (const o of data || []) {
        out.push({
          id: o.id, contact_id: o.entity_id, activity_type: String(o.property ?? '').replace(/^interaction\./, ''),
          summary: o.value?.summary ?? null, description: o.value?.description ?? null, source: o.source, occurred_at: o.observed_at,
          is_outbound: typeof o.is_outbound === 'boolean' ? o.is_outbound : null,
        });
      }
      if (!data || data.length < ENGAGEMENT_PAGE) break;
    }
  }
  return out.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
}

/**
 * Account health and the next step for one company, from the same team-readable inputs the stored
 * deal-health score uses, with the engagement windows read from the full 120 days of activity on
 * the company and its people. A caller that already holds the inputs (the account page) calls
 * `computeAccountHealth` / `selectNextStep` directly instead.
 */
export async function loadAccountHealthScore(supabase, workspaceId, companyId, { customer = null, calls = [], now = Date.now() } = {}) {
  const { notes, stakeholders, nextSteps } = await loadHealthInputs(supabase, workspaceId, companyId);
  const activity = await loadEngagementActivity(supabase, workspaceId, [companyId, ...stakeholders.map(s => s.id)],
    { since: new Date(now - 120 * DAY).toISOString() });
  const health = computeAccountHealth({ notes, activity, calls, stakeholders, customer, now });
  const steps = nextSteps ?? await loadNextSteps(supabase, workspaceId, [companyId]);
  return { ...health, next_step: selectNextStep({ activity, calls, nextSteps: steps, now }) };
}
