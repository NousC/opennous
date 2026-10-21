// Interpreted events (GET-950). The signal.* events say what was extracted: "someone left",
// "they asked about more". These say what it means for the account: the champion left, the deal
// stalled, the customer asked for more of a named product. Each carries the fact it was read from
// and how sure we are. Never the action: what to do about it is the receiver's call.
//
// Pure, so the rules can be pinned with fixtures. The reads live next to the passes that emit them
// (processAccountSignals and emitStalledDealsPoll in automationRun.mjs).

const DAY = 86_400_000;

const days = (fromIso, now) => {
  const t = fromIso ? Date.parse(fromIso) : NaN;
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// ── Stale deals: the one rule (moved here from apps/api detectorDrafts, which re-exports it) ──

/**
 * Open deals quiet long enough to be worth a stage-age read: no touch in `staleDays` (or never).
 * Biggest first, so a short day's cap goes to the deals with the most at stake. Pure.
 * @param rows entity_list_rows deal rows: { entity_id, name, company_id, company_name, stage, status, pipeline_value, last_activity_at }
 */
export function quietOpenDeals(rows, { now = Date.now(), staleDays = 14, staleMaxDays = Infinity } = {}) {
  return (rows ?? [])
    .filter((d) => d?.entity_id && d.company_id && String(d.status ?? '').toLowerCase() === 'open')
    .filter((d) => { const q = days(d.last_activity_at, now); return q == null || (q >= staleDays && q <= staleMaxDays); })
    .sort((a, b) => (Number(b.pipeline_value) || 0) - (Number(a.pipeline_value) || 0)
      || String(a.last_activity_at ?? '').localeCompare(String(b.last_activity_at ?? '')));
}

/**
 * A stale-deal firing from one quiet deal row and its CRM candidate (stage entry date, roster,
 * owner), or null when it does not fire. A deal whose stage entry we cannot date does not fire:
 * "sat in one stage for 14 days" is a claim, and an undated stage cannot back it. Pure.
 */
export function staleDealFiring(row, candidate, { now = Date.now(), staleDays = 14, staleMaxDays = Infinity } = {}) {
  if (!row || !candidate) return null;
  if (String(candidate.status ?? row.status ?? '').toLowerCase() !== 'open') return null;
  const inStage = days(candidate.lastStageChangeAt, now);
  if (inStage == null || inStage < staleDays || inStage > staleMaxDays) return null;
  const quiet = days(row.last_activity_at, now);
  if (quiet != null && (quiet < staleDays || quiet > staleMaxDays)) return null;
  const stage = candidate.stage || row.stage || 'its stage';
  const name = candidate.name || row.name || 'This deal';
  return {
    automation: 'stale_deal',
    targetType: 'deal', targetId: row.entity_id,
    accountId: row.company_id, accountName: row.company_name ?? null,
    dealId: row.entity_id, dealName: name,
    fingerprint: `${row.entity_id}|${String(stage).toLowerCase()}|${String(candidate.lastStageChangeAt).slice(0, 10)}`,
    why: `${name} sat in ${stage} for ${inStage} days${quiet != null ? `, no touch in ${quiet} days` : ', never touched'}`,
    trigger: { stage, days_in_stage: inStage, days_quiet: quiet, stage_entered_at: candidate.lastStageChangeAt, value: row.pipeline_value ?? null },
    rosterIds: Array.isArray(candidate.roster) ? candidate.roster : [],
    ownerEmail: candidate.ownerEmail ?? null,
    raisedBy: null, quote: null,
  };
}

// ── deal.stalled ─────────────────────────────────────────────────────────────

/**
 * deal.stalled from one deal row and its CRM candidate, or null. Same rule as the stale-deal
 * automation, with one more kind of touch: a meeting with anyone at the account. A meeting held
 * counts as a touch, and a meeting booked ahead means the deal is waiting, not stalled, so the
 * window runs from the later of the last touch and the latest meeting (`meetings`, start times).
 *
 * It is dated the moment the deal crossed the window (whichever came last: the stage turning
 * `staleDays` old, or the last touch), so a deal that went stale months ago is history, not news.
 * The dedupe key is the stage stint: one event per deal per stage it sits in. Pure.
 */
export function stalledDealEvent(row, candidate, { now = Date.now(), staleDays = 14, meetings = [] } = {}) {
  if (!row) return null;
  const times = [row.last_activity_at, ...(meetings ?? [])].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  const touched = times.length ? Math.max(...times) : NaN;
  const touchedIso = Number.isFinite(touched) ? new Date(touched).toISOString() : null;
  const f = staleDealFiring({ ...row, last_activity_at: touchedIso }, candidate, { now, staleDays });
  if (!f) return null;
  const entered = Date.parse(f.trigger.stage_entered_at);
  const crossed = Math.max(entered + staleDays * DAY, Number.isFinite(touched) ? touched + staleDays * DAY : 0);
  return {
    type: 'deal.stalled',
    accountId: f.accountId, dealId: f.dealId,
    occurredAt: new Date(crossed).toISOString(),
    dedupeKey: f.fingerprint,
    data: {
      deal_id: f.dealId, deal_name: f.dealName, account_id: f.accountId,
      stage: f.trigger.stage, days_in_stage: f.trigger.days_in_stage, days_since_touch: f.trigger.days_quiet,
      window_days: staleDays,
      evidence: {
        text: f.why,
        stage_entered_at: f.trigger.stage_entered_at,
        last_touch_at: touchedIso,
        value: f.trigger.value != null && Number.isFinite(Number(f.trigger.value)) ? Number(f.trigger.value) : null,
      },
    },
  };
}

// ── account.champion_left ────────────────────────────────────────────────────

/** A replacement named within this long before the departure still counts (a handover is often announced early). */
export const REPLACEMENT_WINDOW_DAYS = 30;
// A CHAMPIONS edge at or above this was stated outright on a call or in mail (the extractor's
// `confirmed` is 0.95, `likely` 0.6; one added by hand defaults to 1).
const CONFIRMED_EDGE = 0.9;

const padded = (s) => ` ${norm(s)} `;
const firstName = (name) => norm(name).split(' ')[0] ?? '';

/**
 * Which one contact of the account some words name, or null. A unique full name wins; else a
 * unique first name (three letters or more) among the account's contacts. Two contacts who share
 * the first name, or two different people named, is ambiguous: null, never a guess. Pure.
 * Returns { id, by: 'full_name' | 'first_name' } or null.
 */
export function contactNamedIn(words, contacts, { exclude = null } = {}) {
  const text = padded(words);
  const list = (contacts ?? []).filter((c) => c?.entity_id && str(c.name) && c.entity_id !== exclude);
  const full = list.filter((c) => norm(c.name).includes(' ') && text.includes(padded(c.name)));
  if (full.length) return full.length === 1 ? { id: full[0].entity_id, by: 'full_name' } : null;
  const first = list.filter((c) => firstName(c.name).length >= 3 && text.includes(` ${firstName(c.name)} `));
  return first.length === 1 ? { id: first[0].entity_id, by: 'first_name' } : null;
}

/**
 * Who left, and whether they were (or are) a champion of the account. Pure.
 *
 * A fact filed on the person names them. A fact filed on the company only says someone left in
 * words, so who left is read off those words against every contact of the account (not only the
 * champions): the text first, the speaker when the text names nobody. The one who says a
 * colleague left is not the one who left, so the speaker is set aside when the text names
 * someone else too. Then the person counts only if they were a champion.
 *
 * @param signal account_signals row (kind stakeholder_left)
 * @param ctx.edges   workspace_graph_edges CHAMPIONS rows: { subject_id, subject_label, object_id, confidence, created_at }
 * @param ctx.roles   authority claims read as Map(person id → role) (the committee's own reading)
 * @param ctx.names   Map(person id → name)
 * @param ctx.people  the account's contacts: [{ entity_id, name }] (defaults to `names`)
 */
export function championWhoLeft(signal, { edges = [], roles = new Map(), names = new Map(), people = null } = {}) {
  if (signal?.kind !== 'stakeholder_left' || !signal.account_id) return null;
  const champEdges = (edges ?? []).filter((e) => e?.subject_id && (e.relationship ?? 'CHAMPIONS') === 'CHAMPIONS');
  const evidenceFor = (id) => {
    const mine = champEdges.filter((e) => e.subject_id === id);
    const confirmed = mine.some((e) => Number(e.confidence ?? 1) >= CONFIRMED_EDGE);
    if (mine.length) return { via: confirmed ? 'confirmed_edge' : 'likely_edge', label: mine[0].subject_label ?? null };
    if (roles.get(id) === 'champion') return { via: 'committee_role', label: null };
    return null;
  };
  const personScoped = signal.entity_id && signal.entity_id !== signal.account_id;
  if (personScoped) {
    const ev = evidenceFor(signal.entity_id);
    if (!ev) return null;
    return { personId: signal.entity_id, name: names.get(signal.entity_id) ?? ev.label, via: ev.via, matchedBy: null };
  }
  // Company-scoped: who the words name, among all the account's contacts.
  const contacts = people ?? [...names].map(([entity_id, name]) => ({ entity_id, name }));
  const words = [signal.title, signal.content, signal.quote].filter(Boolean).join(' ');
  const speaker = str(signal.speaker) ? contactNamedIn(signal.speaker, contacts) : null;
  let hit = contactNamedIn(words, contacts);
  if (!hit && speaker) {
    // The text named the speaker and one other: the other is who left.
    hit = contactNamedIn(words, contacts, { exclude: speaker.id });
    // The text named nobody: the speaker is telling us about themselves.
    if (!hit && !hasAnyName(words, contacts)) hit = speaker;
  }
  if (!hit) return null;
  const ev = evidenceFor(hit.id);
  if (!ev) return null;   // they left, but were no champion: the signal says enough
  return { personId: hit.id, name: names.get(hit.id) ?? contacts.find((c) => c.entity_id === hit.id)?.name ?? ev.label, via: ev.via, matchedBy: hit.by };
}

/** Whether the words name any contact at all, by full or first name. */
function hasAnyName(words, contacts) {
  const text = padded(words);
  return (contacts ?? []).some((c) => str(c?.name) && (text.includes(padded(c.name)) || (firstName(c.name).length >= 3 && text.includes(` ${firstName(c.name)} `))));
}

/**
 * Who took over, if anyone said so: a new champion named, a champion edge on someone else, or
 * someone who joined the account, within REPLACEMENT_WINDOW_DAYS before the departure or after it.
 * A new champion beats a plain join; nearest to the departure wins among equals. Pure.
 * @param related account_signals rows on the same account (already team-readable)
 */
export function replacementFor(signal, leaverId, { related = [], edges = [], names = new Map(), windowDays = REPLACEMENT_WINDOW_DAYS } = {}) {
  const leftAt = Date.parse(signal?.occurred_at ?? '');
  if (!Number.isFinite(leftAt)) return null;
  const from = leftAt - windowDays * DAY;
  const inWindow = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) && t >= from; };
  const other = (id) => id && id !== leaverId && id !== signal.account_id;
  const found = [];
  for (const r of related ?? []) {
    if (!r || r.id === signal.id || r.account_id !== signal.account_id || !other(r.entity_id) || !inWindow(r.occurred_at)) continue;
    const champ = r.kind === 'stakeholder_identified' && r.detail?.role === 'champion';
    if (!champ && r.kind !== 'stakeholder_joined') continue;
    found.push({
      rank: champ ? 0 : 2, at: r.occurred_at,
      out: { entity_id: r.entity_id, name: names.get(r.entity_id) ?? null, via: champ ? 'new_champion' : 'stakeholder_joined', said_at: r.occurred_at, quote: r.quote ?? null, signal_id: r.id },
    });
  }
  for (const e of edges ?? []) {
    if ((e.relationship ?? 'CHAMPIONS') !== 'CHAMPIONS' || !other(e.subject_id) || !inWindow(e.created_at)) continue;
    found.push({
      rank: 1, at: e.created_at,
      out: { entity_id: e.subject_id, name: names.get(e.subject_id) ?? e.subject_label ?? null, via: 'champion_edge', said_at: e.created_at, quote: null, signal_id: null },
    });
  }
  if (!found.length) return null;
  const gap = (x) => Math.abs(Date.parse(x.at) - leftAt);
  found.sort((a, b) => a.rank - b.rank || gap(a) - gap(b));
  return found[0].out;
}

/**
 * How sure we are, and why, in words a receiver can show. Pure.
 *   high   a confirmed CHAMPIONS edge, and the departure was said about the person with a quote
 *   medium one of the two holds
 *   low    neither: a likely edge or a committee read, matched by name or said without a quote
 * A person resolved by first name only drops one step (medium becomes low).
 */
export function championLeftConfidence(who, signal) {
  const explicit = !who.matchedBy && !!str(signal?.quote);
  const confirmed = who.via === 'confirmed_edge';
  const championWhy = confirmed ? 'champion stated outright on a call or in mail'
    : who.via === 'likely_edge' ? 'champion inferred, not stated'
    : 'named champion in the buying committee';
  const leftWhy = explicit ? 'departure said about them, in a quote'
    : who.matchedBy === 'first_name' ? 'departure said about the company; matched to them by first name only'
    : who.matchedBy ? 'departure said about the company; matched to them by full name'
    : 'departure filed without a quote';
  let level = confirmed && explicit ? 'high' : confirmed || explicit ? 'medium' : 'low';
  // A first name is the weakest match there is: a step down from what a full name would get.
  if (who.matchedBy === 'first_name') level = level === 'high' ? 'medium' : 'low';
  return { level, reason: `${championWhy}; ${leftWhy}` };
}

/** account.champion_left from one stakeholder_left signal, or null when the person was not a champion. Pure. */
export function championLeftEvent(signal, ctx = {}) {
  const who = championWhoLeft(signal, ctx);
  if (!who) return null;
  const replacement = replacementFor(signal, who.personId, ctx);
  const confidence = championLeftConfidence(who, signal);
  return {
    type: 'account.champion_left',
    accountId: signal.account_id, personId: who.personId,
    occurredAt: signal.occurred_at,
    dedupeKey: signal.id,
    data: {
      signal_id: signal.id, account_id: signal.account_id,
      account: { entity_id: signal.account_id, name: ctx.accountName ?? null },
      person: { entity_id: who.personId, name: who.name ?? null },
      champion: { via: who.via },
      resolved_by: who.matchedBy ?? 'person',
      replacement,
      evidence: {
        text: signal.content ?? null, quote: signal.quote ?? null, speaker: signal.speaker ?? null,
        source: signal.detail?.source ?? null, source_ref: signal.source_ref ?? null, said_at: signal.occurred_at ?? null,
      },
      confidence: confidence.level,
      confidence_reason: confidence.reason,
    },
  };
}

// ── account.expansion_requested ──────────────────────────────────────────────

/**
 * account.expansion_requested from one expansion_signal, or null. Same reading as the expansion
 * automation (detectorDrafts signalFirings): `asked` with a named product is an ask, `considering`
 * is not, and a customer said it (a quote). A decline of the same product said at or after the ask
 * (`declines`, expansion_declined rows) means the no stands. Pure.
 */
export function expansionRequestedEvent(signal, { declines = [] } = {}) {
  if (signal?.kind !== 'expansion_signal' || !signal.account_id) return null;
  const d = signal.detail ?? {};
  const product = str(d.product);
  if (d.stance !== 'asked' || !product) return null;
  if (!str(signal.content) || !str(signal.quote)) return null;
  const at = String(signal.occurred_at ?? '');
  const declined = (declines ?? []).some((x) => x?.kind === 'expansion_declined' && x.account_id === signal.account_id
    && norm(x.detail?.product) === norm(product) && String(x.occurred_at ?? '') >= at);
  if (declined) return null;
  return {
    type: 'account.expansion_requested',
    accountId: signal.account_id, personId: signal.entity_id !== signal.account_id ? signal.entity_id : null,
    occurredAt: signal.occurred_at,
    dedupeKey: signal.id,
    data: {
      signal_id: signal.id, account_id: signal.account_id, product,
      text: signal.content, quote: signal.quote, speaker: signal.speaker ?? null,
      said_at: signal.occurred_at ?? null, source_ref: signal.source_ref ?? null,
    },
  };
}
