// What OUR side said, for the Intelligence files (GET-1052).
//
// Our replies, commitments and pitch lines are filed as note.* claims with metadata.side = 'ours'
// (worker signals/ourSide.mjs). Every buyer view drops them; the objection playbook and win/loss are
// the only readers, by founder's decision, and they read them through here:
//   - the playbook attaches to each objection the replies we gave on the same account, in the same
//     conversation or after it, so it can state the answers given ("we answered: …");
//   - win/loss lists, per closed deal, what we pitched and promised.
// Kept out of livingFiles.mjs so the file's update path (GET-1054) and this read do not collide.
import { OUR_SIDE } from '@nous/core';

const REPLIES_PER_OBJECTION = 3;
const SAID_PER_DEAL = 6;
const day = (ts) => String(ts ?? '').slice(0, 10);

/** Our side's live claims on these entities, of these categories, oldest first. [] on any failure. */
export async function ourSideOn(sb, ws, entityIds, categories) {
  const ids = [...new Set((entityIds ?? []).filter(Boolean))];
  if (!ids.length) return [];
  const { data, error } = await sb.from('claims').select('entity_id, value, valid_from').eq('workspace_id', ws).in('entity_id', ids)
    .like('property', 'note.%').is('invalid_at', null).eq('value->metadata->>side', OUR_SIDE)
    .in('value->>category', categories).order('valid_from', { ascending: true }).limit(100);
  if (error) { console.warn('[LIVING_OUR_SIDE] read failed:', error.message); return []; }
  return (data ?? []).filter(c => c.value?.content);
}

const words = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

/**
 * The replies that answer one objection (GET-1052). Pure.
 * A reply qualifies when it was said in the same conversation (same source_ref) or after the
 * objection (by said date, the same day included). Among those, a reply from another conversation
 * must share words with the objection (its label and content against the reply's `answers` and
 * content) — an answer about price from a later call is not an answer to a security objection.
 * Same conversation first, then most words in common, then the soonest.
 * @param objection { value, valid_from } the objection claim
 * @param replies   our_reply claims on the same account: { value, valid_from }
 * @returns {string[]} reply sentences, at most `max`
 */
export function repliesFor(objection, replies, { max = REPLIES_PER_OBJECTION } = {}) {
  const ov = objection?.value ?? {};
  const said = day(objection?.valid_from);
  const ref = ov.metadata?.source_ref ?? null;
  const theirs = words(`${ov.label ?? ''} ${ov.content ?? ''}`);
  return (replies ?? [])
    .map(r => {
      const v = r.value ?? {};
      const same = !!ref && v.metadata?.source_ref === ref;
      const after = !!said && day(r.valid_from) >= said;
      const shared = overlap(theirs, words(`${v.metadata?.answers ?? ''} ${v.content ?? ''}`));
      return { r, same, after, shared };
    })
    .filter(x => x.same || (x.after && x.shared > 0))
    .sort((a, b) => Number(b.same) - Number(a.same) || b.shared - a.shared || String(a.r.valid_from).localeCompare(String(b.r.valid_from)))
    .slice(0, max)
    .map(x => String(x.r.value.content).slice(0, 220));
}

/** What we pitched and promised on a deal, as short lines ("[commitment] … (due 2026-10-30)"), newest last. Pure. */
export function saidLines(claims, { max = SAID_PER_DEAL } = {}) {
  return (claims ?? [])
    .filter(c => c?.value?.content && ['pitch_line', 'our_commitment'].includes(c.value.category))
    .slice(-max)
    .map(c => {
      const v = c.value;
      const due = v.category === 'our_commitment' && v.metadata?.occurred_start ? ` (due ${v.metadata.occurred_start})` : '';
      return `[${v.category === 'our_commitment' ? 'commitment' : 'pitch line'}] ${String(v.content).slice(0, 200)}${due}`;
    });
}
