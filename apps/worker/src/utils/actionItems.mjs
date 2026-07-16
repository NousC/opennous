// Action-item extraction — turns the prose "action items" a meeting note-taker
// produces into structured, agent-retrievable records. Stored as STATE
// observations (property `action_item.<source>_<sourceId>_<i>`) on the meeting's
// account entity, so they live in the substrate for the agent to query but never
// render in the human contact UI (which only shows activities + note.*/signal.*
// claims). owner_kind tags whose commitment it is — yours vs the prospect's.

import { recordObservation } from '@nous/core';

// Parse Fireflies' owner-split action_items markdown:
//   **Alex Rivera**
//   Share the MVP within ~2 weeks (28:37)
//   **Kabir Rao**
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
  let recorded = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
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
