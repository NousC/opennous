// Cause links, for the Intelligence files (GET-1053).
//
// The extractor now says when one fact happened BECAUSE of another (claim_links, kind caused_by:
// from = the effect, to = the cause; worker signals/causeLinks.mjs, core db/claimLinks.ts). Two
// readers here:
//   - the objection playbook: an objection linked to one of our replies (either way round: "the
//     objection resolved caused_by our reply", or "our reply caused_by the objection") is shown as
//     "answered by: <reply>". That is the record saying which answer it was, so it is preferred over
//     the shared-words pairing (livingOurSide.mjs repliesFor), which stays as the fallback.
//   - win/loss: for a lost deal, the objections and blockers linked as the CAUSE of one of the deal's
//     facts ("lost because: <the objection> (led to: <the fact>)").
// Kept out of livingFiles.mjs so the files' update path (GET-1054 / GET-1055) and these reads do not
// collide. Every read is fail-safe: no table, no links, an error → nothing, and the file reads as it
// did before links existed.
import { listClaimLinks, OUR_SIDE } from '@nous/core';

const ANSWERS_PER_OBJECTION = 3;
const LOST_BECAUSE_PER_DEAL = 4;
const CAUSE_CATEGORIES = new Set(['objection', 'blocker']);

const isOurReply = (c) => c?.value?.category === 'our_reply' && c?.value?.metadata?.side === OUR_SIDE;
const isOurs = (c) => c?.value?.metadata?.side === OUR_SIDE;
const text = (c, n) => String(c?.value?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The claims behind a set of ids, by id: live ones only. Map, empty on any failure. */
async function claimsById(sb, ws, ids) {
  const want = [...new Set((ids ?? []).filter(Boolean))];
  const out = new Map();
  if (!want.length) return out;
  try {
    const { data, error } = await sb.from('claims').select('id, entity_id, value, valid_from, invalid_at')
      .eq('workspace_id', ws).in('id', want);
    if (error) { console.warn('[LIVING_LINKS] claims read failed:', error.message); return out; }
    for (const c of data ?? []) if (c?.id && c.invalid_at == null && c.value?.content) out.set(c.id, c);
  } catch (err) { console.warn('[LIVING_LINKS] claims read failed:', err?.message ?? err); }
  return out;
}

/**
 * Per objection, the replies of ours the record links to it, oldest link first. Pure.
 * @param objectionIds string[]
 * @param links [{ from_claim_id, to_claim_id }] live caused_by links touching them
 * @param byId Map id → claim ({ value: { category, content, metadata } })
 * @returns Map objection id → reply sentences (at most `max`)
 */
export function answersFromLinks(objectionIds, links, byId, { max = ANSWERS_PER_OBJECTION } = {}) {
  const out = new Map();
  const ids = new Set(objectionIds ?? []);
  for (const l of links ?? []) {
    for (const [mine, other] of [[l.from_claim_id, l.to_claim_id], [l.to_claim_id, l.from_claim_id]]) {
      if (!ids.has(mine)) continue;
      const reply = byId.get(other);
      if (!isOurReply(reply)) continue;
      const list = out.get(mine) ?? [];
      const line = text(reply, 220);
      if (line && !list.includes(line) && list.length < max) list.push(line);
      out.set(mine, list);
    }
  }
  return out;
}

/** The replies the record links to each of these objections (see answersFromLinks). Map; empty when there are none or no table. */
export async function linkedAnswers(sb, ws, objectionIds) {
  const ids = [...new Set((objectionIds ?? []).filter(Boolean))];
  if (!ids.length) return new Map();
  const links = await listClaimLinks(sb, ws, ids);
  if (!links.length) return new Map();
  const others = links.flatMap(l => [l.from_claim_id, l.to_claim_id]).filter(id => !ids.includes(id));
  return answersFromLinks(ids, links, await claimsById(sb, ws, others));
}

/**
 * For a lost deal: the objections and blockers linked as the cause of one of the deal's facts, as
 * lines ("<cause> (led to: <effect>)"). Our side's statements are never an effect here: the reason
 * a deal was lost is the buyer's. Pure.
 * @param dealIds the deal's claim ids (its account's and its people's notes)
 */
export function lostBecauseLines(dealIds, links, byId, { max = LOST_BECAUSE_PER_DEAL } = {}) {
  const ids = new Set(dealIds ?? []);
  const out = [];
  for (const l of links ?? []) {
    if (!ids.has(l.from_claim_id)) continue;
    const effect = byId.get(l.from_claim_id), cause = byId.get(l.to_claim_id);
    if (!effect || !cause || isOurs(effect) || isOurs(cause)) continue;
    if (!CAUSE_CATEGORIES.has(cause.value?.category)) continue;
    const line = `[${cause.value.category}] ${text(cause, 200)} (led to: ${text(effect, 160)})`;
    if (!out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** The "lost because" lines of one lost deal from its claim ids. [] when nothing is linked or no table. */
export async function lostBecause(sb, ws, dealClaimIds) {
  const ids = [...new Set((dealClaimIds ?? []).filter(Boolean))];
  if (!ids.length) return [];
  const links = await listClaimLinks(sb, ws, ids);
  const effects = links.filter(l => ids.includes(l.from_claim_id));
  if (!effects.length) return [];
  return lostBecauseLines(ids, effects, await claimsById(sb, ws, effects.flatMap(l => [l.from_claim_id, l.to_claim_id])));
}
