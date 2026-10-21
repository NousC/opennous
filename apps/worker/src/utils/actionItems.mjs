// Action-item extraction — turns the prose "action items" a meeting note-taker
// produces into structured, agent-retrievable records. Stored as STATE
// observations (property `action_item.<source>_<sourceId>_<i>`) on the meeting's
// account entity, so they live in the substrate for the agent to query but never
// render in the human contact UI (which only shows activities + note.*/signal.*
// claims). owner_kind tags whose commitment it is — yours vs the prospect's.

import { recordObservation, extractDuePhrase, resolveDuePhrase, dueDateAgreeingWith, getWorkspaceTimezone, writesTasks } from '@nous/core';
import { createMessage, messageText } from '../lib/llm.mjs';
import { meterLLM } from './meterLLM.mjs';

const MAX_ITEMS_PER_CALL = 20;

// ─── Reading the timing out of prose ────────────────────────────────────────
//
// Fireflies hands us action items as ordinary sentences, with no separate due
// field, so the timing has to be read out of the words. Pattern-matching alone
// cannot do it: a time word is only a deadline when it says WHEN the work is
// due, and "Monday" in "share the Monday standup notes" names a meeting, while
// "30 days" in "the 30 days pilot proposal" describes the pilot. Both look
// identical to a regex, and treating them as deadlines invented due dates
// nobody agreed to.
//
// So the model reads them, exactly as it already does on the email path. Two
// rules keep it honest:
//   1. It returns the SPEAKER'S OWN WORDS, never a date. Date arithmetic stays
//      in resolveDuePhrase, where it is deterministic and tested — the same
//      "LLM decides, code computes" split used for ICP and intent scoring.
//   2. A phrase it returns must actually appear in the item. A quote that isn't
//      in the source is a hallucination, and it is dropped.

const DUE_SYSTEM = [
  'You read the action items from a sales call and report which ones state a DEADLINE.',
  '',
  'An item states a deadline when it says WHEN the work must be done:',
  '  "Send the deck by Friday"          -> "by Friday"',
  '  "Share the MVP within ~2 weeks"    -> "within ~2 weeks"',
  '  "Follow up Friday"                 -> "Friday"',
  '  "Get pricing over end of month"    -> "end of month"',
  '',
  'A time word is NOT a deadline when it names something, or describes the work:',
  '  "Share the Monday standup notes"   -> null   (Monday names the meeting)',
  '  "Send the 30 days pilot proposal"  -> null   (30 days describes the pilot)',
  '  "Block out a day for onboarding"   -> null   (a day is how much work)',
  '  "Send the Black Friday deck"       -> null   (part of a name)',
  '  "Circle back after the demo"       -> null   (no date can be derived)',
  '',
  'Return the timing in the SPEAKER\'S OWN WORDS, copied verbatim from the item.',
  'Never return a date, and never compute one — the words are turned into a date',
  'elsewhere. A phrase you return must appear in the item exactly as written.',
  '',
  'When in doubt, return null. A missing deadline is harmless; an invented one',
  'sends someone chasing work nobody asked for.',
  '',
  'Output ONLY a JSON array, one entry per item, no prose:',
  '[{"i":1,"due_phrase":"by Friday"},{"i":2,"due_phrase":null}]',
].join('\n');

/**
 * Which timing wins for one item.
 *
 * If the model ran and had something to say about this item, that is the answer
 * — INCLUDING when it says there is no deadline. Falling back to the regex on a
 * model null would put back exactly the invented dates the model pass exists to
 * remove ("Monday standup notes" is not due Monday, however confidently a
 * pattern says so). The deterministic scan is only for items the model never
 * saw: no API key, a failed call, or an item past the batch cap.
 */
export function chooseDuePhrase(modelPhrases, index, title) {
  if (modelPhrases && modelPhrases.has(index)) return modelPhrases.get(index);
  return extractDuePhrase(title);
}

/**
 * Ask the model which items state a deadline. One call per meeting, not per item.
 *
 * Returns a Map of index -> phrase (or null) when the model ran, and null when
 * it did not run at all (every model failed). That distinction is load-bearing: a model that ran and
 * said "no deadline" must be believed, or the regex fallback would put back
 * exactly the invented dates this exists to remove.
 */
export async function extractDuePhrasesWithModel(items, { occurredAt, workspaceId, supabase } = {}) {
  const subset = (items || []).slice(0, MAX_ITEMS_PER_CALL);
  if (!subset.length) return null;

  try {
    const when = occurredAt ? new Date(occurredAt).toISOString().slice(0, 10) : 'an unknown date';
    const msg = await createMessage({
      meter: false,
      feature: 'meeting-action-item-due',
      max_tokens: 600,
      system: DUE_SYSTEM,
      messages: [{
        role: 'user',
        content: `The call happened on ${when}. Action items:\n` +
          subset.map((it, i) => `${i + 1}. ${it.title}`).join('\n'),
      }],
    });
    await meterLLM(supabase, workspaceId, 'action-items', msg);

    const text = messageText(msg);
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s === -1 || e === -1) return null;
    const rows = JSON.parse(text.slice(s, e + 1));
    if (!Array.isArray(rows)) return null;

    const out = new Map();
    for (const row of rows) {
      const idx = Number(row?.i) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= subset.length) continue;
      const phrase = typeof row?.due_phrase === 'string' ? row.due_phrase.trim() : null;
      // The anti-hallucination guard: a deadline it did not read in the item is
      // one it made up. Same bar as the completion judge in apps/api.
      const grounded = phrase && subset[idx].title.toLowerCase().includes(phrase.toLowerCase());
      out.set(idx, grounded ? phrase : null);
    }
    // Items past the cap were never shown to the model, so they must not inherit
    // its silence — leaving them absent sends them to the deterministic fallback.
    return out;
  } catch (err) {
    console.warn('[ACTION_ITEMS] due-phrase model pass failed:', err.message);
    return null;   // fall back to the deterministic scan
  }
}

// Parse Fireflies' owner-split action_items markdown:
//   **Avery Castellan**
//   Share the MVP within ~2 weeks (28:37)
//   **Lena Quist**
//   Send the calendar link (29:39)
// → [{ owner_name, title }]. Strips bullets and trailing (MM:SS) timestamp refs.
export function parseActionItems(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  let owner = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.match(/^\*\*(.+?)\*\*:?$/);
    if (header) { owner = header[1].trim(); continue; }
    const title = line
      .replace(/^[-*•\d.)\s]+/, '')              // leading bullet / number
      .replace(/\s*\(\d{1,2}:\d{2}\)\s*$/, '')   // trailing (MM:SS) transcript ref
      .trim();
    if (title.length > 3) out.push({ owner_name: owner, title });
  }
  return out;
}

// 'prospect' if the item's owner name matches the account contact; else 'user'
// (the founder's own commitment). Anything not clearly the prospect = yours.
function ownerKind(ownerName, contact) {
  if (!ownerName) return 'user';
  const n = ownerName.toLowerCase();
  const fn = (contact?.first_name || '').toLowerCase().trim();
  const ln = (contact?.last_name || '').toLowerCase().trim();
  if ((fn.length > 2 && n.includes(fn)) || (ln.length > 2 && n.includes(ln))) return 'prospect';
  return 'user';
}

// Record parsed items as state observations on the account. Deterministic
// property + external_id per (source, sourceId, index) so reprocessing the same
// meeting is idempotent (no duplicate action items).
export async function recordActionItems(supabase, { workspaceId, entityId, contact, items, source, sourceId, occurredAt }) {
  // Tasks only from a meeting in the last 30 days (GET-514); older meetings still give claims.
  if (!writesTasks(occurredAt)) return 0;
  // Anchor for resolving a timing phrase found inside the item's title (Fireflies
  // gives us prose like "Share the MVP within ~2 weeks", never a separate due
  // field) — the meeting's own time, not whenever this pass happens to run.
  const anchor = occurredAt ? new Date(occurredAt) : new Date();
  // One batched read of the whole list. When it comes back, its answer is
  // authoritative — including the nulls. When it doesn't (no key, model down,
  // unparseable reply), every item falls back to the deterministic scan.
  const modelPhrases = await extractDuePhrasesWithModel(items, { occurredAt, workspaceId, supabase });
  // The workspace's own timezone (cached ~5 min in core) — the meeting's "within
  // 2 weeks" resolves against the founder's calendar, not the server's. Falls
  // back to NOUS_DEFAULT_TIMEZONE / UTC inside resolveDuePhrase when unset.
  const timeZone = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
  let recorded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const duePhrase = chooseDuePhrase(modelPhrases, i, it.title);
    const rec = await recordObservation(supabase, {
      workspaceId,
      entityId,
      kind:     'state',
      property: `action_item.${source}_${sourceId}_${i}`,
      value: {
        title:       it.title,
        owner_kind:  ownerKind(it.owner_name, contact),   // 'user' (yours) | 'prospect'
        owner_name:  it.owner_name || null,
        status:      'open',
        due_phrase:  duePhrase,
        // A date the title itself contradicts is worse than none: commitments_overdue sorts on
        // it, so a wrong one reports itself overdue and teaches the rep to ignore the column.
        due_at:      duePhrase ? dueDateAgreeingWith(resolveDuePhrase(duePhrase, anchor, timeZone), it.title) : null,
        source_type: source,
        source_id:   sourceId,
      },
      source,
      method:     'extraction',
      observedAt: occurredAt || new Date().toISOString(),
      externalId: `action_item_${source}_${sourceId}_${i}`,
    }).catch(() => null);
    if (rec) recorded++;
  }
  return recorded;
}
