// OUR side's words, kept as their own facts (GET-1052).
//
// The extractor has always thrown our side's lines away: "anything our side says is never their
// fact" (DEAL_BAR), and a fact whose quote our side spoke is dropped (GET-417). That guard stays —
// it is what stops a rep's guess ("you'd find $700 expensive") becoming the buyer's budget. But
// what we SAID is worth keeping in its own right: the objection playbook cannot say how an
// objection was answered if no answer was ever recorded, and win/loss reads differently when it
// knows what we promised and pitched.
//
// So the one read now has a fourth home, `our_side`, with three categories (claimCategories.ts,
// OUR_SIDE_CATEGORIES): our_reply, our_commitment ("commitment" from the model), pitch_line.
// They are filed on the ACCOUNT, as note.* claims with metadata.side = 'ours', and:
//   - they never pass through the buyer guards (checkSignals, the subject guard, the merge): those
//     are built to judge a fact about THEM, and would drop or re-file every one of ours;
//   - they get their own light check here instead: a verbatim quote, spoken by our side;
//   - every buyer reader drops them (isOurSideClaim: listNotes, isIntelClaim, the insight engine,
//     the brief, the facts search). Product decision (founder): no Insights, no buyer view, for now.
//     Only the Intelligence files (objection playbook, win/loss — api/src/lib/livingFiles.mjs) read them.
//   - no event is emitted for them: saveNote emits none, and nothing here calls the event log.

import { saveNote, normalizeOurSideCategory, OUR_SIDE, getWorkspaceTimezone, isoDateIn, resolveSaidAt } from '@nous/core';
import { groundFacts, spokenByOurSide, speakerOfQuote } from '../noema/grounding.mjs';
import { normalizeOccurred, occurredMetaFor } from './occurredDates.mjs';

/** Our side by name for a prompt: the owner, the teammates, then the company. Pure. */
export function sellerNames(ourSide, extra = []) {
  const names = [ourSide?.ownerName, ...(ourSide?.teamNames ?? []), ...extra]
    .map(n => String(n ?? '').trim()).filter(Boolean);
  return [...new Set(names)];
}

/**
 * The line that names who is who, in every extraction input (GET-1052): "<our team> = seller (our
 * side); <them> = buyer". The prompts said "our side is X" in passing; the our_side home needs the
 * roles stated, since what one says is a buyer fact and what the other says is ours. Pure.
 */
export function speakerRolesLine(ourSide, buyers = []) {
  const ours = sellerNames(ourSide);
  const company = String(ourSide?.companyName ?? '').trim();
  const seller = ours.length
    ? `${ours.join(', ')}${company ? ` (${company})` : ''}`
    : (company ? `the ${company} team` : 'our team');
  const them = [...new Set((buyers ?? []).map(b => String(b ?? '').trim()).filter(Boolean))];
  return `SPEAKER ROLES: ${seller} = seller (our side); ${them.length ? them.join(', ') : 'everyone else'} = buyer.`;
}

/** The our_side rules, in the shared system prompt (no workspace detail: names come in the user message). */
export const OUR_SIDE_RULES = `OUR SIDE'S WORDS ARE KEPT APART — home "our_side". The user message says who is the seller (our side) and who is the buyer. What OUR side actually said is recorded with home "our_side" when it is one of these, with "category" set to the key:
- our_reply — our answer to an objection, question or concern the buyer raised. "content" names what we said AND what it answered, in one sentence ("Answered the concern about HubSpot sync by saying tasks write back within a minute"). Set "answers" to the buyer's concern in 2–6 words — the same words as that objection's label when you record one.
- commitment — something we promised to do or send ("I'll send the security doc by Friday"). Set "fact_kind" to "event" and "occurred_start" to the due date when one is stated, resolved against the anchor and written into "content" too.
- pitch_line — a claim or framing we used about our product or its value. Our side's GUESS about the buyer ("you'd find $700 expensive", "I bet your team hates the data entry") is a pitch_line at most: never a fact about them, never home "claim".
Each needs "quote" (our side's own words, verbatim) and "speaker" (the teammate who said it); on a call with several attendees, "person" is the attendee it was said to. Only what our side actually said: never the buyer's words, never your summary. A buyer fact NEVER rests on our side's line: when the buyer objects and we answer, that is two facts — the objection (home "claim", their quote) and our_reply (home "our_side", our quote). Small talk, greetings, scheduling, and questions we asked are nothing. These do not count toward the fact ceiling.`;

/**
 * The light check for our side's facts (GET-1052), in place of the buyer guards. Pure.
 * Keeps a fact only when: its category is one of ours; its quote is verbatim in `text`; and that
 * quote was spoken by our side (or `text` is only our side's words, `allOurs`) — the transcript's own speaker label when it has one, else the
 * model's "speaker" naming one of our team. With no names for our side it can tell nothing, so it
 * keeps nothing.
 * @returns {object[]} the kept facts, `category` normalised to the stored key
 */
export function checkOurSide(facts, { text = '', ourNames = [], allOurs = false } = {}) {
  const names = [...new Set((ourNames ?? []).map(n => String(n ?? '').trim()).filter(Boolean))];
  // `allOurs`: `text` is only what our side wrote (an email thread's "us" blocks), so a quote found
  // in it is ours whoever the model named; otherwise we need names to tell.
  if (!names.length && !allOurs) return [];
  const typed = (facts ?? [])
    .filter(f => f && typeof f.content === 'string' && f.content.trim())
    .map(f => ({ ...f, category: normalizeOurSideCategory(f.category) }))
    .filter(f => f.category);
  const { facts: grounded } = groundFacts(typed, text);
  return grounded.filter(f => {
    if (!f.quote) return false;
    if (allOurs) return true;
    if (speakerOfQuote(f.quote, text)) return spokenByOurSide(f.quote, text, names);
    // No speaker label on that line (notes, a single message): the model's speaker must be ours.
    return isOurName(f.speaker, names);
  }).map(f => ({ ...f, content: f.content.replace(/\s+/g, ' ').trim() }));
}

/** Whether a speaker label names one of our side, by the same rule spokenByOurSide uses: the
 *  whole name, or a first name of three letters or more. Pure. */
export function isOurName(speaker, names = []) {
  const clean = (v) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sp = clean(speaker);
  if (!sp) return false;
  const spFirst = sp.split(' ')[0];
  return (names ?? []).some(n => {
    const nn = clean(n);
    if (!nn) return false;
    if (nn === sp) return true;
    const first = nn.split(' ')[0];
    return first.length >= 3 && (first === spFirst || sp.startsWith(nn) || nn.startsWith(sp));
  });
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The metadata one of our facts is stored with. Pure. */
export function ourSideMetadata(fact, { type = null, source = null, sourceRef = null, sourceHash = null } = {}) {
  return {
    side: OUR_SIDE,
    about: 'company',
    signal_type: type,
    extraction_source: source,
    source_activity_id: fact.activityId || null,
    quote: typeof fact.quote === 'string' && fact.quote ? fact.quote : null,
    speaker: typeof fact.speaker === 'string' && fact.speaker.trim() ? fact.speaker.trim().slice(0, 80) : null,
    // Who it was said TO: the buyer on the call or thread. Not voiced_by_contact_id — that field
    // means "the buyer who said this" to every account reader.
    said_to_contact_id: fact.contactId ?? null,
    // What our reply answered, in the buyer's terms, so the playbook can pair it to the objection.
    ...(fact.category === 'our_reply' && typeof fact.answers === 'string' && fact.answers.trim()
      ? { answers: fact.answers.trim().slice(0, 120) } : {}),
    ...(sourceRef ? { source_ref: sourceRef } : {}),
    ...(sourceRef && sourceHash ? { source_hash: sourceHash } : {}),
    ...occurredMetaFor(fact),
    graph_layer: 'private',
  };
}

/**
 * File our side's facts on the account (GET-1052). Best-effort, like the claims about us: a failure
 * here never costs the conversation its buyer facts, so it logs and returns what it wrote.
 * Each fact carries contactId / companyId / activityId; it lands on the company, or on the person
 * when there is no company. A re-read files nothing twice: a fact already on file from the same
 * source, in the same category and words, is skipped.
 * `links` (GET-1053): the conversation's CauseLedger, told which claim each fact is on file as (the
 * one written, or the one it repeats), so "objection resolved caused_by our reply" can be linked.
 */
export async function saveOurSideFacts(supabase, workspaceId, facts, { type = null, source = null, sourceRef = null, sourceHash = null, occurredAt = null, dryRun = false, links = null } = {}) {
  const list = (facts ?? []).filter(f => f && (f.companyId || f.contactId));
  if (!list.length || dryRun) return [];
  try {
    const tz = list.some(f => f.fact_kind != null || f.occurred_start != null)
      ? await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined) : undefined;
    const anchor = isoDateIn(resolveSaidAt(occurredAt), tz);
    // category|words → the claim on file (its id, for the cause links of a repeat; GET-1053).
    const seen = new Map();
    if (sourceRef) {
      const { data } = await supabase.from('claims').select('id, value')
        .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
        .eq('value->metadata->>side', OUR_SIDE).eq('value->metadata->>source_ref', sourceRef).limit(200);
      for (const r of data ?? []) seen.set(`${r.value?.category}|${norm(r.value?.content)}`, r.id ?? null);
    }
    const written = [];
    for (const raw of list) {
      // Only a commitment is dated: a reply or a pitch line is a statement, not an event.
      const f = raw.category === 'our_commitment' ? normalizeOccurred(raw, anchor) : { ...raw, fact_kind: undefined, occurred_start: undefined, occurred_end: undefined };
      const key = `${f.category}|${norm(f.content)}`;
      if (seen.has(key)) { links?.claim(raw, seen.get(key)); continue; }
      seen.set(key, null);
      const note = await saveNote(supabase, workspaceId, {
        entityId: f.companyId ?? f.contactId,
        category: f.category,
        label: typeof f.label === 'string' ? f.label.trim().slice(0, 40) || undefined : undefined,
        content: f.content,
        source: 'signal_extraction',
        saidAt: f.saidAt ?? occurredAt ?? null,
        supportingObservationIds: f.activityId ? [f.activityId] : undefined,
        metadata: ourSideMetadata(f, { type, source, sourceRef, sourceHash }),
      }).catch(err => { console.warn('[OUR_SIDE] write failed:', err.message); return null; });
      if (note) { seen.set(key, note.id); links?.claim(raw, note.id); written.push({ id: note.id, category: f.category, content: f.content }); }
    }
    if (written.length) console.log(`[OUR_SIDE] ${written.length} of our side's statement(s) filed — ${type}/${source}`);
    return written;
  } catch (err) {
    console.warn('[OUR_SIDE] failed:', err?.message ?? err);
    return [];
  }
}
