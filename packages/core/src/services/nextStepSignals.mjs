// Next step missed and next step slipped (GET-954). A next step agreed is a task: what someone
// already said they would do, so it is not a signal in the Workspace. Two things about one ARE
// signals, because they change what someone should do:
//
//   next_step_missed   its due date passed more than a day ago, and nothing has happened on the
//                      account since it was agreed: no email either way, no call, no meeting.
//                      A closed task is done. Fires once per step.
//   next_step_slipped  the buyer pushed the date of the same step a second time: the step is
//                      restated in a later conversation with a later date, twice. Fires once per
//                      step (keyed by the first time it was agreed).
//
// WHY SLIPPED IS READ FROM REPEATED STEPS, NOT FROM A DUE DATE CHANGING ON ONE TASK. Each
// conversation files its own tasks (`action_item.meeting_<id>_<n>`, `action_item.email_<id>_<n>`),
// so when the buyer says "let's make it next week" on the next call, that is a NEW task with the
// same words and a later date, on the same account. The due date of one task changes only when
// that same conversation is read again (the model resolving the phrase differently, which is noise)
// or when someone edits it on the Tasks page (our side, not the buyer). So a push is: the same
// promise (most of its words, timing words aside), from a different conversation, said later, with
// a due date at least a day later than the one before, while the earlier one was not done.
//
// Pure, so the rules can be pinned with fixtures. The reads live in detectNextStepSignalsPoll
// (automationRun.mjs), which writes these rows into account_signals for processAccountSignals.

const DAY = 86_400_000;
/** A step is missed a day after its due date: a reply the morning after is still on time. */
export const MISSED_GRACE_DAYS = 1;
/** A step missed longer ago than this is history, not news: it is not raised. */
export const MISSED_MAX_AGE_DAYS = 7;
/** A second push said longer ago than this is history. */
export const SLIPPED_MAX_AGE_DAYS = 14;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * An `action_item.*` claim as a next step, or null when it is not one agreed with a buyer: our own
 * rule tasks (`action_item.rule_`) and internal-meeting tasks (`action_item.internal_`) are ours.
 * `account_id` is set by the caller (the claim's company, or the company its person works at).
 */
export function stepFromClaim(c) {
  const p = String(c?.property ?? '');
  if (!p.startsWith('action_item.') || p.startsWith('action_item.rule_') || p.startsWith('action_item.internal_')) return null;
  const v = c.value && typeof c.value === 'object' ? c.value : {};
  if (v.internal_meeting === true) return null;
  return {
    entity_id: c.entity_id, property: p, account_id: c.account_id ?? null,
    title: str(v.title), status: str(v.status) ?? 'open',
    due_at: str(v.due_at), due_phrase: str(v.due_phrase),
    // When it was agreed: the conversation's own time, else when the claim was first seen.
    agreed_at: str(v.occurred_at) ?? str(c.valid_from) ?? str(c.last_observed_at),
    source_id: v.source_id != null ? String(v.source_id) : null, source_type: str(v.source_type),
    source_ref: str(v.source_url) ?? str(v.source_ref), quote: str(v.quote),
    speaker: str(v.asked_by) ?? str(v.for_name) ?? str(v.owner_name), owner: str(v.owner_kind),
  };
}

// A touch that could plausibly fulfil a next step: a message either way, a call, a meeting held or
// booked. A bounce, an open, a visit or an accepted connection is not anyone doing the step.
const TOUCH = /^interaction\.(email_(sent|received|reply|replied)|reply|positive_reply|outbound_positive_reply|linkedin_(message|message_sent|message_received|reply|replied)|call|call_(made|received|held)|meeting_(held|scheduled|booked))$/;
export const isTouch = (property) => TOUCH.test(String(property ?? ''));

/**
 * The next_step_missed row for one step, or null when it is not missed: still open, dated, more
 * than the grace day past due, and no touch on the account after it was agreed and on or before
 * due + the grace day. `touches` = [{ at, property }] for the account (its people and the company).
 * Dated when it became missed, so the signal pass's freshness window reads it right.
 */
export function missedNextStep(step, touches, { now = Date.now(), maxAgeDays = MISSED_MAX_AGE_DAYS } = {}) {
  if (!step?.account_id || !step.property || (step.status ?? 'open') !== 'open') return null;
  const due = ms(step.due_at);
  if (due == null) return null;
  const deadline = due + MISSED_GRACE_DAYS * DAY;
  if (now <= deadline || now - deadline > maxAgeDays * DAY) return null;
  const agreed = ms(step.agreed_at) ?? -Infinity;
  const done = (touches ?? []).some((t) => {
    const at = ms(t?.at);
    return at != null && at > agreed && at <= deadline && isTouch(t.property);
  });
  if (done) return null;
  const title = step.title ?? 'A next step';
  return {
    kind: 'next_step_missed', entity_id: step.entity_id, account_id: step.account_id, claim_property: step.property,
    title, content: `${title} was due ${day(due)}; nothing has happened on the account since it was agreed.`,
    quote: step.quote ?? null, speaker: step.speaker ?? null, source_ref: step.source_ref ?? null,
    detail: { due_at: step.due_at, agreed_at: step.agreed_at ?? null, status: 'open', owner: step.owner ?? null, source: step.source_type ?? null },
    occurred_at: new Date(deadline).toISOString(),
    dedupe_key: `next_step_missed:${step.property}`,
  };
}

// The words that say what the step is, not when: articles and timing words aside, so "by Friday"
// and "next Wednesday" do not make two promises look different.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'on', 'in', 'at', 'by', 'from', 'is', 'it', 'its', 'our', 'we', 'us', 'them', 'their']);
const TIMING = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri',
  'today', 'tomorrow', 'tonight', 'next', 'this', 'week', 'weeks', 'month', 'months', 'day', 'days', 'end', 'eod', 'eow', 'eom', 'within',
  'before', 'after', 'until', 'later', 'asap', 'soon', 'morning', 'afternoon', 'evening', 'again', 'quarter', 'year',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const words = (s) => new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((w) => w.length > 1 && !STOP.has(w) && !TIMING.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w)));
const what = (s) => {
  let t = String(s?.title ?? '');
  if (s?.due_phrase) t = t.split(s.due_phrase).join(' ');
  return words(t);
};

/**
 * Two steps that are the same promise: most of all their words in common, timing aside (Jaccard,
 * so "follow up with Ines on the contract" and "... on the invoice" stay two promises).
 */
export function sameStep(a, b) {
  const x = what(a), y = what(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.7;
}

// The step was finished or dropped: a restatement after it is a new step, not a push.
const CLOSED = new Set(['done', 'dismissed', 'cancelled', 'closed', 'completed']);

/**
 * next_step_slipped rows for the steps on any number of accounts: one per chain whose date was
 * pushed twice or more, at the second push. A chain is the same promise restated in a later
 * conversation (a different source), each link not closed before the next; a push is a link
 * whose due date is at least a day later than the one before. Keyed by the chain's first step.
 */
export function slippedNextSteps(steps, { now = Date.now(), maxAgeDays = SLIPPED_MAX_AGE_DAYS } = {}) {
  const usable = (steps ?? []).filter((s) => s?.account_id && s.property && ms(s.agreed_at) != null && ms(s.due_at) != null)
    .sort((a, b) => ms(a.agreed_at) - ms(b.agreed_at) || String(a.property).localeCompare(String(b.property)));
  const chains = [];
  for (const s of usable) {
    const chain = chains.find((c) => {
      const last = c[c.length - 1];
      return last.account_id === s.account_id && !CLOSED.has(last.status)
        && ms(s.agreed_at) > ms(last.agreed_at)
        && !(last.source_id && s.source_id && last.source_id === s.source_id)
        && sameStep(last, s);
    });
    if (chain) chain.push(s); else chains.push([s]);
  }
  const out = [];
  for (const chain of chains) {
    let pushes = 0;
    for (let i = 1; i < chain.length; i++) {
      if (ms(chain[i].due_at) - ms(chain[i - 1].due_at) < DAY) continue;
      if (++pushes < 2) continue;
      const s = chain[i];
      if (now - ms(s.agreed_at) > maxAgeDays * DAY) break;
      const title = s.title ?? chain[0].title ?? 'A next step';
      out.push({
        kind: 'next_step_slipped', entity_id: s.entity_id, account_id: s.account_id, claim_property: s.property,
        title, content: `${title}: pushed ${pushes} times, from ${day(ms(chain[0].due_at))} to ${day(ms(s.due_at))}.`,
        quote: s.quote ?? null, speaker: s.speaker ?? null, source_ref: s.source_ref ?? null,
        detail: {
          due_at: s.due_at, previous_due_at: chain[i - 1].due_at, first_due_at: chain[0].due_at, pushes,
          agreed_at: s.agreed_at, first_agreed_at: chain[0].agreed_at, steps: chain.slice(0, i + 1).map((x) => x.property),
          owner: s.owner ?? null, source: s.source_type ?? null,
        },
        occurred_at: s.agreed_at,
        dedupe_key: `next_step_slipped:${chain[0].property}`,
      });
      break;
    }
  }
  return out;
}
