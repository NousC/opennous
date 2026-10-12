// Why a deal closed the way it did, as a dated sequence of evidence (GET-405).
//
// A CRM keeps one word about a lost deal: the reason the rep picked from a dropdown at close.
// The graph holds what was actually said while the deal was live — an objection nobody answered,
// a competitor named on a call, a close date pushed twice, three weeks of silence — each with a
// quote and a date. This turns that into the deal's record: an ordered list of EVENTS, frozen at
// close, pointing at the claims they rest on.
//
// Frozen on purpose. Every other reading in the graph is a projection over live claims, and a
// live projection of "why it closed" would drift as claims decay and get superseded. A close is
// a fact with a date; its record is written once and kept.
//
// Pointers, not copies: each event carries the claim id and the quote, so the account's intel
// stays where it is and a closed-lost account keeps everything for the next conversation.
//
// ORDERED, because the order is the finding. "No economic buyer → close date slipped → pricing
// objection → competitor named → went quiet → closed lost" is a path, and the same path across
// many deals is a pattern the aggregate report can count, and an open deal on its first three
// steps is a warning. A bag of causes cannot do either. So every event is dated by when it was
// SAID (the claim's occurred_at, then when it was recorded), never by when this record was built.
//
// Pure. The loader that finds a deal's claims, touches and close-date history lives with the
// worker; this only decides.

export type CloseOutcome = 'won' | 'lost' | 'no_decision';

/**
 * The event vocabulary. Closed on purpose — a pattern can only be counted over a closed set —
 * and shared with the win/loss report's cause taxonomy (apps/api/src/lib/winLoss.mjs), which
 * maps onto it one-to-one where the two overlap.
 */
export const CLOSE_EVENT_KINDS = [
  // the road to a loss
  'no_decision_maker',   // nobody with economic_buyer / decision_maker authority ever on the deal
  'close_date_slipped',  // the CRM close date moved later (one event per slip)
  'objection_open',      // an objection raised and never resolved or addressed
  'competitor_named',    // a competitor evaluating / incumbent / mentioned (a past failure is an opening, not a cause)
  'budget_constraint',
  'timing_constraint',
  'risk_signal',         // on a renewal or expansion: the customer said the relationship was in question
  'went_quiet',          // no real touch for QUIET_DAYS before the close
  // the road to a win
  'champion',            // someone pushing for us internally
  'objection_resolved',
  'buying_signal',
  'expansion_asked',     // a won expansion that the customer asked for first
] as const;
export type CloseEventKind = typeof CLOSE_EVENT_KINDS[number];

/** Silence long enough to be a cause, not a Tuesday. The same bar the win/loss report uses. */
export const QUIET_DAYS = 21;

export interface CloseEvidenceClaim {
  id: string;
  category: string;
  content: string;
  quote?: string | null;
  /** When it was said — the claim's occurred_at, falling back to when it was recorded. */
  at: string;
  status?: string | null;    // objection
  hardness?: string | null;  // objection
  stance?: string | null;    // competitor · expansion_signal
  severity?: string | null;  // risk_signal
  role?: string | null;      // authority
  entity?: string | null;    // competitor
  product?: string | null;   // expansion_signal
  /** Whether its source conversation is attributed to this deal (observation_deals), or only to the roster. */
  filedToDeal?: boolean;
}

export interface CloseRecordInput {
  outcome: CloseOutcome;
  openedAt: string | null;
  closedAt: string;
  claims: CloseEvidenceClaim[];
  /** Real touches with the deal's people, any direction, as ISO timestamps. */
  touches: string[];
  /** The CRM's close-date history on the deal: each change, dated. */
  closeDateChanges: Array<{ at: string; value: string | null }>;
  /** The rep's own word at close, from the CRM. Reported beside the evidence, never as it. */
  repReason?: string | null;
}

export interface CloseEvent {
  kind: CloseEventKind;
  at: string;
  /** One line a person can read on the card. */
  text: string;
  claim_id?: string;
  quote?: string | null;
  /** How sure the attribution is: the claim's conversation was filed to this deal, or only to its people. */
  attribution: 'deal' | 'roster' | 'crm' | 'derived';
  detail?: Record<string, unknown>;
}

export interface CloseRecord {
  outcome: CloseOutcome;
  opened_at: string | null;
  closed_at: string;
  /** Oldest first. The path. */
  events: CloseEvent[];
  /** The distinct kinds, in the order they first happened — the sequence a pattern job counts. */
  path: CloseEventKind[];
  /** The rep's word from the CRM, beside the evidence. */
  rep_reason: string | null;
  /** False when a lost deal has no event on record: "we cannot explain this" beats guessing. */
  explained: boolean;
  built_at: string;
}

const DAY = 86_400_000;
const HANDLED = new Set(['resolved', 'addressed', 'closed']);
const BUYER_ROLES = new Set(['economic_buyer', 'decision_maker']);
const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Only what was said while the deal was live explains how it closed; a concern raised after the loss is not why. */
function liveWindow(input: CloseRecordInput): (at: string) => boolean {
  const open = t(input.openedAt) || t(input.closedAt);
  const close = t(input.closedAt);
  return (at) => { const x = t(at); return Number.isFinite(x) && x >= open - DAY && x <= close + DAY; };
}

export function buildCloseRecord(input: CloseRecordInput, now: Date = new Date()): CloseRecord {
  const inWindow = liveWindow(input);
  const claims = input.claims.filter(c => inWindow(c.at));
  const attr = (c: CloseEvidenceClaim): CloseEvent['attribution'] => (c.filedToDeal ? 'deal' : 'roster');
  const ev: CloseEvent[] = [];
  const closeMs = t(input.closedAt);
  const lost = input.outcome !== 'won';

  if (lost) {
    // Nobody who could sign was ever on it. Dated at open: it was true from the start.
    //
    // Only when something was READ. On the first customer, every closed deal carried this
    // event on the first dry run, because their conversations sit in a CRM corpus extraction had
    // never touched: no claims at all, so no authority claim, so "no buyer". Absence of evidence
    // is not evidence of absence. A deal with no claim in its window gets no event here and,
    // with nothing else on record, reads as unexplained — which is the honest word for it.
    const buyer = claims.some(c => c.category === 'authority' && BUYER_ROLES.has(String(c.role ?? '')));
    if (claims.length > 0 && !buyer) {
      ev.push({ kind: 'no_decision_maker', at: input.openedAt ?? input.closedAt, attribution: 'derived',
        text: 'No economic buyer or decision maker on the deal', detail: { claims_read: claims.length } });
    }

    // Each time the CRM close date moved to a later DAY. The history is the CRM's own; a rep
    // pushing the date is the rep saying "not yet" in the one place they always say it.
    //
    // Day granularity, not timestamp: HubSpot's history carries the same date under different
    // hours (a timezone, a re-save), and the first dry run printed "pushed from 09-07 to 09-07".
    // And a change on the close day itself is the CRM stamping the actual close, not a slip.
    const closeDay = input.closedAt.slice(0, 10);
    const changes = input.closeDateChanges
      .filter(x => Number.isFinite(t(x.at)) && Number.isFinite(t(x.value)))
      .sort((a, b) => t(a.at) - t(b.at));
    for (let i = 1; i < changes.length; i++) {
      const prevDay = changes[i - 1].value!.slice(0, 10), nextDay = changes[i].value!.slice(0, 10);
      const changedOn = changes[i].at.slice(0, 10);
      if (nextDay > prevDay && changedOn < closeDay && inWindow(changes[i].at)) {
        ev.push({ kind: 'close_date_slipped', at: changes[i].at, attribution: 'crm',
          text: `Close date pushed from ${prevDay} to ${nextDay}`,
          detail: { from: changes[i - 1].value, to: changes[i].value } });
      }
    }

    for (const c of claims) {
      if (c.category === 'objection' && !HANDLED.has(String(c.status ?? '').toLowerCase())) {
        ev.push({ kind: 'objection_open', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c),
          text: c.content, detail: { hardness: c.hardness ?? null } });
      } else if (c.category === 'competitor' && String(c.stance ?? '') !== 'past_failure') {
        ev.push({ kind: 'competitor_named', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c),
          text: c.entity ? `${c.entity} named (${c.stance ?? 'mentioned'})` : c.content, detail: { entity: c.entity ?? null, stance: c.stance ?? null } });
      } else if (c.category === 'budget') {
        ev.push({ kind: 'budget_constraint', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c), text: c.content });
      } else if (c.category === 'timeline') {
        ev.push({ kind: 'timing_constraint', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c), text: c.content });
      } else if (c.category === 'risk_signal') {
        ev.push({ kind: 'risk_signal', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c),
          text: c.content, detail: { severity: c.severity ?? null } });
      }
    }

    // The longest silence before the close, on real touches only.
    const before = input.touches.map(t).filter(x => Number.isFinite(x) && x <= closeMs);
    const lastTouch = before.length ? Math.max(...before) : NaN;
    if (Number.isFinite(lastTouch) && (closeMs - lastTouch) / DAY >= QUIET_DAYS) {
      const days = Math.round((closeMs - lastTouch) / DAY);
      ev.push({ kind: 'went_quiet', at: new Date(lastTouch + QUIET_DAYS * DAY).toISOString(), attribution: 'derived',
        text: `No conversation for ${days} days before the close`, detail: { days, last_touch_at: new Date(lastTouch).toISOString() } });
    }
  } else {
    for (const c of claims) {
      if (c.category === 'authority' && String(c.role ?? '') === 'champion') {
        ev.push({ kind: 'champion', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c), text: c.content });
      } else if (c.category === 'objection' && HANDLED.has(String(c.status ?? '').toLowerCase())) {
        ev.push({ kind: 'objection_resolved', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c), text: c.content });
      } else if (c.category === 'buying_signal') {
        ev.push({ kind: 'buying_signal', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c), text: c.content });
      } else if (c.category === 'expansion_signal' && String(c.stance ?? '') === 'asked') {
        ev.push({ kind: 'expansion_asked', at: c.at, claim_id: c.id, quote: c.quote ?? null, attribution: attr(c),
          text: c.content, detail: { product: c.product ?? null } });
      }
    }
  }

  ev.sort((a, b) => t(a.at) - t(b.at));
  const path: CloseEventKind[] = [];
  for (const e of ev) if (!path.includes(e.kind)) path.push(e.kind);

  return {
    outcome: input.outcome,
    opened_at: input.openedAt,
    closed_at: input.closedAt,
    events: ev,
    path,
    rep_reason: input.repReason?.trim() || null,
    // A won deal with no event is unremarkable; a lost deal with no event is unexplained, and
    // saying so is the honest answer — a taxonomy with no residual is a taxonomy that guessed.
    explained: !lost || ev.length > 0,
    built_at: now.toISOString(),
  };
}

/** The claim property a deal's record is stored under. One per deal; a rebuild replaces it. */
export const CLOSE_RECORD_PROPERTY = 'deal.close_record';

/**
 * Does an OPEN deal's evidence so far match the first steps of a path? The early warning: the
 * same vocabulary read before the close. Prefix match on the deal's own path, in order.
 */
export function pathPrefixMatch(open: readonly CloseEventKind[], pattern: readonly CloseEventKind[]): number {
  let i = 0;
  for (const k of open) if (i < pattern.length && k === pattern[i]) i++;
  return i;
}

// ── The aggregate: which paths do lost deals take (GET-416) ──────────────────────────────────
//
// "32% of lost deals showed the same sequence" is an ordered-subsequence count, not a model.
// Two honest rules, both in the code rather than left to the narrator: SUBSEQUENCES, never
// exact paths (every deal's full path is unique and matching it exactly finds nothing), and
// ALWAYS BESIDE THE WON RATE (a pattern 32% of losses share and 30% of wins share is not a loss
// pattern). Small cohorts carry their own n.

export interface PathPattern {
  steps: CloseEventKind[];
  lost_n: number;
  lost_pct: number | null;
  won_n: number;
  won_pct: number | null;
  /** lost share minus won share, in points: the pattern's pull toward a loss. */
  lift: number | null;
}

export interface PathSummary {
  lost_n: number;
  won_n: number;
  /** The share of lost deals with at least one event on record. */
  lost_explained_pct: number | null;
  /** Ordered pairs and triples of event kinds, ranked by how much more often they precede a loss than a win. */
  patterns: PathPattern[];
  /** How often each kind appears on a lost path at all, ranked. */
  steps: Array<{ kind: CloseEventKind; lost_n: number; lost_pct: number | null; won_n: number; won_pct: number | null }>;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Every ordered subsequence of length 2 and 3 of a path, as keys. */
function subsequences(path: readonly CloseEventKind[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < path.length; i++) {
    for (let j = i + 1; j < path.length; j++) {
      out.add(`${path[i]}>${path[j]}`);
      for (let k = j + 1; k < path.length; k++) out.add(`${path[i]}>${path[j]}>${path[k]}`);
    }
  }
  return [...out];
}

export function summarizeClosePaths(
  records: ReadonlyArray<Pick<CloseRecord, 'outcome' | 'path'>>,
  { minLost = 3, limit = 8 }: { minLost?: number; limit?: number } = {},
): PathSummary {
  const lost = records.filter(r => r.outcome !== 'won');
  const won = records.filter(r => r.outcome === 'won');
  const count = (rows: typeof lost, keyer: (p: readonly CloseEventKind[]) => string[]) => {
    const m = new Map<string, number>();
    for (const r of rows) for (const k of new Set(keyer(r.path))) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const lostSub = count(lost, subsequences), wonSub = count(won, subsequences);
  const patterns: PathPattern[] = [...lostSub.entries()]
    .filter(([, n]) => n >= minLost)
    .map(([key, n]) => {
      const w = wonSub.get(key) ?? 0;
      const lp = pct(n, lost.length), wp = pct(w, won.length);
      return { steps: key.split('>') as CloseEventKind[], lost_n: n, lost_pct: lp, won_n: w, won_pct: wp, lift: lp != null && wp != null ? Math.round((lp - wp) * 10) / 10 : lp };
    })
    // Longer, more discriminating paths first; then by how many losses they cover.
    .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0) || b.steps.length - a.steps.length || b.lost_n - a.lost_n)
    .slice(0, limit);
  const lostStep = count(lost, p => [...p]), wonStep = count(won, p => [...p]);
  const steps = CLOSE_EVENT_KINDS
    .map(kind => ({ kind, lost_n: lostStep.get(kind) ?? 0, lost_pct: pct(lostStep.get(kind) ?? 0, lost.length), won_n: wonStep.get(kind) ?? 0, won_pct: pct(wonStep.get(kind) ?? 0, won.length) }))
    .filter(s => s.lost_n || s.won_n)
    .sort((a, b) => b.lost_n - a.lost_n);
  return {
    lost_n: lost.length, won_n: won.length,
    lost_explained_pct: pct(lost.filter(r => r.path.length > 0).length, lost.length),
    patterns, steps,
  };
}
