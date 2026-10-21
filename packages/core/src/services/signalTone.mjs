// A signal's tag (GET-894): the colour of each account-signal kind, and the line a person reads for
// it. Decided once, here: the API attaches `label`, `tone` and `text` to the Accounts table's latest
// signal (latestSignalView), so the browser only maps a tone to its tinted pill. Pure.
//
// Tones are colour names, not meanings, so the frontend's class map stays a plain palette:
//   red     the account is at risk          churn_risk, expansion_declined, stakeholder_left, next_step_missed
//   green   the account is moving forward   buying_signal, expansion_signal, objection_resolved
//   blue    people                          stakeholder_identified, stakeholder_joined
//   amber   competitors                     competitor_mentioned, competitor_evaluating
//   orange  objections, a step pushed       objection_raised, next_step_slipped
//   purple  pricing and budget              budget_discussed
//   slate   neutral (unknown)               next_step (a task, never shown as a signal: GET-954)
//   teal / pink / indigo                    a workspace's own signals (custom_<id>), stable per id
import { SIGNAL_LABEL, shownAsSignal } from './signalLabels.mjs';

export const SIGNAL_TONES = ['red', 'green', 'blue', 'amber', 'orange', 'purple', 'slate', 'teal', 'pink', 'indigo'];
export const CUSTOM_TONES = ['teal', 'pink', 'indigo'];

export const SIGNAL_TONE = {
  churn_risk: 'red', expansion_declined: 'red', stakeholder_left: 'red', next_step_missed: 'red',
  usage_dropped: 'red', account_inactive: 'red',
  buying_signal: 'green', expansion_signal: 'green', objection_resolved: 'green', feature_adopted: 'green',
  product_qualified: 'green', seats_growing: 'green', account_activated: 'green',
  stakeholder_identified: 'blue', stakeholder_joined: 'blue',
  competitor_mentioned: 'amber', competitor_evaluating: 'amber',
  objection_raised: 'orange', next_step_slipped: 'orange', seat_dropped: 'orange',
  budget_discussed: 'purple',
  next_step: 'slate',
};

/** The tone of a kind. A custom signal (`custom_<definition id>`) keeps one colour by its id. */
export function signalTone(kind) {
  const k = typeof kind === 'string' ? kind : '';
  if (SIGNAL_TONE[k]) return SIGNAL_TONE[k];
  if (k.startsWith('custom_')) {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0;
    return CUSTOM_TONES[Math.abs(h) % CUSTOM_TONES.length];
  }
  return 'slate';
}

const clean = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const MAX_TEXT = 500;

/**
 * What was actually said or happened: the fact's content (a one-line summary), else the speaker's
 * quote, else its title. Whitespace collapsed; null when there is nothing.
 */
export function signalText(s) {
  const t = clean(s?.content) || clean(s?.quote) || clean(s?.title);
  if (!t) return null;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1).trimEnd()}…` : t;
}

/** The kind's human label. A custom signal's is its definition's name (the row's title). */
export function signalKindLabel(kind, title = null) {
  if (SIGNAL_LABEL[kind]) return SIGNAL_LABEL[kind];
  if (typeof kind === 'string' && kind.startsWith('custom_') && clean(title)) return clean(title);
  const words = String(kind ?? 'signal').replace(/^custom_/, '').replace(/[_.]+/g, ' ').trim() || 'signal';
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * The latest-signal object of an account row, with the tag and the line the table shows. A next
 * step agreed is a task, not a signal (GET-954): the overview read sorts it last, so when it comes
 * back the account has no signal at all.
 */
export function latestSignalView(raw) {
  if (!raw || typeof raw !== 'object' || !shownAsSignal(raw.kind)) return null;
  const label = signalKindLabel(raw.kind, raw.title);
  const text = signalText(raw);
  // A custom signal with no content would read its name twice.
  return { ...raw, label, tone: signalTone(raw.kind), text: text && text.toLowerCase() !== label.toLowerCase() ? text : null };
}
