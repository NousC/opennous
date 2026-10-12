// Shared meeting-resolution layer — used by every transcript/meeting source
// (Fireflies today; Fathom and others next). A meeting is an EVENT, not just an
// email + a name, so we resolve the contacts it belongs to using two signals:
//
//   (1) Attendee identity match — resolve each attendee email/name the normal way.
//   (2) CO-ATTENDANCE — match the meeting to an existing booking (a
//       `meeting_scheduled` observation) by start time (+ title overlap). The
//       calendar already asserted who was in that invite, so this links the
//       transcript to the right person even when they joined with a different or
//       unknown address than the one on file — the domain-free fix for the
//       "same person, two personal emails (gmail vs gmx)" problem.
//
// Provider handlers normalize their payload into the `meeting` shape and call
// resolveMeetingContacts(); all the matching/learning lives here, once.

import { saveNote, upsertIdentifier, getInternalEntityIds, getInternalIdentities, recordObservation } from '@nous/core';
import { resolveContact } from './resolveContact.mjs';

const CO_ATTENDANCE_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2h around the meeting start

function titleTokens(t) {
  return new Set(
    String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2),
  );
}
function titlesOverlap(a, b) {
  if (!a || !b) return false;
  const A = titleTokens(a), B = titleTokens(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}
function bookingTitle(value) {
  if (!value || typeof value !== 'object') return null;
  return value.title || value.meeting_name || value.summary || value.description || null;
}

// Contacts already tied to a booking near this meeting's start time. A booking
// only co-attends if THIS meeting's title actually names that booking's contact
// (their first or last name appears in the title). That's the precise signal:
// generic, structurally-identical titles like "Networking Call between Theo
// Bramwell and <prospect>" all share the same filler words and the host's name, so
// token overlap would wrongly fuse back-to-back calls (Corwin 16:30 ↔ Imogen
// 17:00). Requiring the prospect's own name in the title can't do that.
async function findCoAttendees(supabase, workspaceId, startTimeIso, title) {
  if (!startTimeIso || !title) return [];
  const start = new Date(startTimeIso).getTime();
  if (isNaN(start)) return [];
  const lo = new Date(start - CO_ATTENDANCE_WINDOW_MS).toISOString();
  const hi = new Date(start + CO_ATTENDANCE_WINDOW_MS).toISOString();

  const { data } = await supabase
    .from('observations')
    .select('entity_id, observed_at')
    .eq('workspace_id', workspaceId)
    .eq('property', 'interaction.meeting_scheduled')
    .gte('observed_at', lo).lte('observed_at', hi);
  if (!data?.length) return [];

  const ids = [...new Set(data.map(r => r.entity_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: contacts } = await supabase
    .from('contacts').select('id, first_name, last_name').in('id', ids);

  const titleLc = String(title).toLowerCase();
  const matched = [];
  for (const c of contacts || []) {
    const fn = (c.first_name || '').toLowerCase().trim();
    const ln = (c.last_name || '').toLowerCase().trim();
    if ((fn.length > 2 && titleLc.includes(fn)) || (ln.length > 2 && titleLc.includes(ln))) {
      matched.push(c.id);
    }
  }
  return matched;
}

// Match transcript SPEAKER names to existing contacts. This is the identity
// signal of last resort, for the ad-hoc call that has no usable attendee email
// (Fireflies routinely reports only the host for unscheduled calls) and no
// booking to co-attend — yet the transcript labels every line with who spoke
// ("Dorian Pellow: ..." — or, for a guest Fireflies only half-knows, just
// "Tamsin"). Two tiers, each with a uniqueness gate that a naive first-name match
// (the thing the email step deliberately refuses) can't offer:
//   - FULL name ("first last"): matched against first+last, must be the UNIQUE
//     active contact with that pair (internal teammates included — the final
//     classification decides if they attach).
//   - FIRST name only ("Tamsin"): matched against first_name, but ONLY linked when
//     exactly one *external* (non-internal, non-host) contact carries that name.
//     Two "Tamsin"s, or only an internal "Tamsin" → skipped, never guessed. This is
//     the host-recorded 1:1 where the guest joined without an email we have.
// Every link leaves a reversible Data Quality note (written by the caller).
async function resolveBySpeakerName(supabase, workspaceId, speakerNames, hostEmail, internalIds = new Set()) {
  const out = [];
  const seen = new Set();
  const host = hostEmail ? hostEmail.toLowerCase().trim() : null;
  for (const raw of speakerNames || []) {
    const name = String(raw || '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const toks = name.split(/\s+/).filter(Boolean);
    const first = toks[0];
    if (!first || first.length < 2) continue;

    if (toks.length >= 2) {
      // Tier 1 — full name: unique first+last match (internal allowed).
      const last = toks[toks.length - 1];
      if (last.length < 2) continue;
      const { data } = await supabase.from('contacts')
        .select('id, company_id, email, first_name, last_name, channels')
        .eq('workspace_id', workspaceId)
        .ilike('first_name', first).ilike('last_name', last)
        .limit(2);
      if (!data || data.length !== 1) continue;          // unique full-name match only
      const c = data[0];
      if (host && c.email && c.email.toLowerCase().trim() === host) continue; // never the self/host
      out.push(c);
      continue;
    }

    // Tier 2 — first name only: link only when there is exactly ONE external
    // contact with that first name (fetch a few; any ambiguity → skip).
    const { data } = await supabase.from('contacts')
      .select('id, company_id, email, first_name, last_name, channels')
      .eq('workspace_id', workspaceId)
      .ilike('first_name', first)
      .limit(5);
    if (!data?.length) continue;
    const external = data.filter(c =>
      !internalIds.has(c.id) &&
      !(host && c.email && c.email.toLowerCase().trim() === host));
    if (external.length !== 1) continue;                 // 0 or >1 external → don't guess
    out.push(external[0]);
  }
  return out;
}

/**
 * Resolve the contacts a meeting should attach to.
 * @param {object} meeting { startTime, title, attendees:[{email,name}], organizerEmail, source, speakerNames?:[string], createMissing?:boolean }
 * @returns {Promise<Array<contact>>} existing (and, when createMissing, newly created) contacts
 */

// Role mailboxes — a shared inbox is not a person, and creating "Info" at a company is
// worse than creating nobody, because every later signal resolves onto that fiction.
const ROLE_MAILBOXES = new Set([
  'info', 'hello', 'hi', 'contact', 'support', 'help', 'sales', 'team', 'admin', 'office',
  'billing', 'accounts', 'accounting', 'finance', 'legal', 'privacy', 'security', 'careers',
  'jobs', 'hr', 'press', 'media', 'marketing', 'noreply', 'no-reply', 'donotreply',
  'do-not-reply', 'notifications', 'notification', 'mail', 'email', 'inbox', 'enquiries',
  'inquiries', 'general', 'service', 'services', 'webmaster', 'postmaster', 'abuse',
]);

/**
 * A person's name, from their email address — the fallback for a source that gives us an
 * address and nothing else.
 *
 * Fireflies is exactly that source: `meeting_attendees` comes back as
 * `{ email, displayName: null, name: null }` on every attendee, every time. The create-missing
 * step below requires a name, so a replay of a batch of real meetings created nobody and logged
 * nothing — the backfill ran perfectly and produced an empty graph.
 *
 * This is deliberately timid. It only fires when the local part actually looks like a name:
 * a role mailbox is refused outright, so is anything with digits, and so is a single letter.
 * `wren@brightharbor.example` → "Wren"; `first.last@` → "First Last"; `info@` → nothing. The
 * contact it creates is keyed on the email, so a guessed name can never fuse two people — the
 * worst case is a capitalisation a human corrects later, against a record that otherwise
 * would not exist at all.
 */
/**
 * A contact we know only by email gets the name the note-taker's attendee list gives them
 * (GET-252): a buyer sat nameless through a call whose Granola invite said
 * "Odalys", so extraction skipped every fact about them. Only fills what is EMPTY — a name
 * already on the record is never overwritten from a calendar display name — and never from
 * something that is only an email. Recorded as an observation, so the claim engine weighs it
 * like any other source and a later, better source still wins.
 */
export async function fillMissingName(supabase, workspaceId, contact, attendee, source) {
  try {
    if (!contact?.id || contact.first_name) return;
    const raw = String(attendee?.name ?? '').replace(/\s*[(\[][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw || raw.includes('@') || raw.length < 2 || /\d/.test(raw)) return;
    const [first, ...rest] = raw.split(' ');
    const at = new Date().toISOString();
    const base = { workspaceId, entityId: contact.id, kind: 'state', source: source || 'meeting', method: 'api', observedAt: at };
    await recordObservation(supabase, { ...base, property: 'first_name', value: first, externalId: `${source || 'meeting'}:attendee_name:${contact.id}:first` });
    if (rest.length && !contact.last_name) {
      await recordObservation(supabase, { ...base, property: 'last_name', value: rest.join(' '), externalId: `${source || 'meeting'}:attendee_name:${contact.id}:last` });
    }
    contact.first_name = first;
    if (rest.length && !contact.last_name) contact.last_name = rest.join(' ');
  } catch (err) {
    console.warn('[MEETING_RESOLVE] attendee name fill failed:', err?.message ?? err);
  }
}

export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0]?.toLowerCase().trim();
  if (!local || local.length < 2) return null;
  if (ROLE_MAILBOXES.has(local)) return null;
  if (/\d/.test(local)) return null;                 // ben2024, sales2 — not a name we can trust
  const parts = local.split(/[._\-+]+/).filter(p => p.length >= 2 && /^[a-z]+$/.test(p));
  if (!parts.length || parts.length > 3) return null;
  if (parts.some(p => ROLE_MAILBOXES.has(p))) return null;
  return parts.map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

export async function resolveMeetingContacts(supabase, workspaceId, meeting) {
  const { startTime, title, attendees = [], organizerEmail = null, source = 'meeting', speakerNames = [], createMissing = false } = meeting;
  const hostEmail = organizerEmail ? organizerEmail.toLowerCase().trim() : null;

  // Team/self entities (is_internal=true) and their emails. A meeting attaches to
  // the EXTERNAL people on it; internal teammates are attached only when the call
  // has NO external party (an internal team sync, e.g. a co-founder call), so it's
  // still recorded. The self/host is only skipped when the host is internal —
  // when the EXTERNAL party hosts (Bastian) and you join as a guest, Bastian must
  // still resolve, and it's you (internal) who gets dropped.
  const internalIds = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set());
  const internalIdentities = await getInternalIdentities(supabase, workspaceId).catch(() => []);
  const internalEmails = new Set(internalIdentities.filter(i => i.kind === 'email').map(i => i.value));
  const hostIsInternal = hostEmail ? internalEmails.has(hostEmail) : false;

  const resolved = new Map();   // contactId -> contact
  const unresolved = [];        // non-host attendee emails that matched no contact

  // (1) Identity match each attendee. Never attach a meeting to its own host /
  // organizer (the workspace user — you don't have a "meeting with yourself"),
  // and match on a real EMAIL only: a name-only attendee can smear the call onto
  // an unrelated same-name contact.
  for (const att of attendees) {
    const email = att.email ? att.email.toLowerCase().trim() : null;
    if (!email) continue;
    if (email === hostEmail && hostIsInternal) continue;   // skip the self/host only when internal
    const { contact } = await resolveContact(
      supabase, workspaceId, { email, source }, { createIfMissing: false },
    );
    if (contact) {
      if (!resolved.has(contact.id)) resolved.set(contact.id, contact);
      await fillMissingName(supabase, workspaceId, contact, att, source);
    } else {
      // Carry the attendee's name so we can create a proper name+email contact
      // for them below (step 4) if nothing else resolves them.
      unresolved.push({ email, name: att.name || null });
    }
  }

  // (2) Co-attendance match against bookings.
  const coIds = await findCoAttendees(supabase, workspaceId, startTime, title);
  const bookingContacts = [];
  for (const id of coIds) {
    const { data: contact } = await supabase.from('contacts')
      .select('id, company_id, email, first_name, last_name, channels')
      .eq('id', id).maybeSingle();
    if (!contact) continue;
    bookingContacts.push(contact);
    if (!resolved.has(contact.id)) resolved.set(contact.id, contact);
  }

  // (2.5) Transcript speaker-name match. The ad-hoc call (no booking, host-only
  // attendee list) resolves to nobody above — but the transcript still names who
  // spoke. Collect UNIQUE full-name speaker matches; whether each one actually
  // attaches is decided at the end (external win; internal only for an internal-
  // only sync). Internal speakers ARE collected here — a co-founder call where
  // one founder only appears as a speaker still needs them — but they're dropped by the
  // final classification the moment any external speaker is present, so an
  // external call never lands on a teammate. Notes are written only for winners.
  const speakerMatches = speakerNames.length
    ? await resolveBySpeakerName(supabase, workspaceId, speakerNames, hostEmail, internalIds)
    : [];
  for (const c of speakerMatches) if (!resolved.has(c.id)) resolved.set(c.id, c);

  // (3) Email learning. When co-attendance pins exactly ONE prospect and there is
  // exactly ONE unresolved non-host attendee email, that address is almost
  // certainly the prospect joining from an alternate mailbox. Attach it as an
  // identifier (reversible) so future events resolve, and leave a Data Quality
  // note for auditability. Conservative on purpose: any ambiguity → skip (we'd
  // rather miss a link than fuse the wrong people).
  const consumed = new Set();   // unresolved emails linked as an alternate below — don't also create them
  if (bookingContacts.length === 1 && unresolved.length === 1) {
    const target = bookingContacts[0];
    const newEmail = unresolved[0].email;
    const { data: claimed } = await supabase.from('entity_identifiers')
      .select('entity_id').eq('workspace_id', workspaceId)
      .eq('kind', 'email').eq('value', newEmail).maybeSingle();
    if (!claimed) {
      await upsertIdentifier(supabase, workspaceId, target.id, 'email', newEmail);
      consumed.add(newEmail);
      await saveNote(supabase, workspaceId, {
        entityId: target.id, category: 'Data Quality',
        content: `Linked alternate email ${newEmail} via meeting co-attendance (${source}): they joined a meeting that matched this person's booking using an address we hadn't seen. Auto-linked — unlink if this isn't them.`,
        source: 'identity_resolution', confidence: 0.7,
        metadata: { flag: 'co_attendance_email_link', linked_email: newEmail, meeting_source: source },
      }).catch(() => {});
      console.log(`[MEETING_RESOLVE] co-attendance linked ${newEmail} → entity ${target.id} (${source})`);
    }
  }

  // (4) Create the ones we still don't have. An external attendee with a real
  // EMAIL and a NAME (Fathom invitees always carry both; Fireflies when present)
  // that matched no existing contact becomes a new contact — name + email is a
  // clean, keyable, dedup-safe record, so future signals resolve to it. Gated to
  // createMissing (meeting sources opt in) and to attendees that have a name, so
  // we never spawn a nameless or bare-transcript-name record. resolveContact runs
  // its own name-fallback + duplicate flag, so this never blindly forks.
  if (createMissing) {
    for (const u of unresolved) {
      if (consumed.has(u.email)) continue;                 // already linked as an alternate email
      // The name the source gave us, or one derived from the address when it gave us none.
      // The host is excluded from the fallback on purpose: when the ORGANIZER is the one
      // without a name we would be inventing a record for the person running the call, who
      // is usually us. A named host still creates normally.
      const nm = String(u.name || '').trim()
        || (u.email !== hostEmail ? (nameFromEmail(u.email) || '') : '');
      if (!nm) continue;                                   // still nothing usable — never create email-only
      const parts = nm.split(/\s+/).filter(Boolean);
      const first_name = parts[0];
      const last_name = parts.slice(1).join(' ') || null;
      if (!first_name || first_name.length < 2) continue;
      const { contact, created } = await resolveContact(
        supabase, workspaceId,
        { email: u.email, first_name, last_name, source },
        { createIfMissing: true },
      );
      if (contact && !resolved.has(contact.id)) {
        resolved.set(contact.id, contact);
        if (created) console.log(`[MEETING_RESOLVE] created contact "${nm}" <${u.email}> from ${source} meeting`);
      }
    }
  }

  // Attach to the EXTERNAL prospects on the call. If there were none — an internal
  // team sync like a co-founder call — attach to the internal participants instead
  // so the meeting is still recorded (the self/host was already excluded above).
  // Never mix: a prospect call stays off internal records.
  const all = [...resolved.values()];
  const external = all.filter(c => !internalIds.has(c.id));
  const final = external.length ? external : all;

  // Speaker-name links are provisional until now — write the reversible note only
  // for speaker matches that actually made the final cut (so an external call
  // whose transcript also named a teammate never leaves a note on that teammate).
  // IDEMPOTENT: this resolver re-runs on every webhook retry / re-delivery (up to
  // MAX_ATTEMPTS, plus Fireflies' own re-sends), and saveNote keys each note on a
  // random uuid — so an unguarded write stacked this note 15-29× per person. Skip
  // when an identical speaker-name note already exists for this entity; one flag
  // per person is all we need, and it survives retries.
  for (const c of speakerMatches) {
    if (!final.some(f => f.id === c.id)) continue;
    const content = `Linked this meeting (${source}) by transcript speaker name — they spoke on the call as "${[c.first_name, c.last_name].filter(Boolean).join(' ')}" but joined from an address/without a booking we could match. Auto-linked on a unique name match (the only contact by that name) — unlink if this isn't them.`;
    const { data: existingNote } = await supabase.from('claims')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', c.id)
      .like('property', 'note.%')
      .eq('value->metadata->>flag', 'speaker_name_link')
      .eq('value->>content', content)
      .limit(1);
    if (existingNote && existingNote.length) continue;      // already flagged — don't duplicate on retry
    await saveNote(supabase, workspaceId, {
      entityId: c.id, category: 'Data Quality',
      content,
      source: 'identity_resolution', confidence: 0.6,
      metadata: { flag: 'speaker_name_link', meeting_source: source },
    }).catch(() => {});
    console.log(`[MEETING_RESOLVE] speaker-name linked "${c.first_name} ${c.last_name}" → contact ${c.id} (${source})`);
  }
  return final;
}

// Same-meeting guard for transcripts. Two people can record the SAME real meeting with
// their own note-takers (two Fireflies accounts, or Fireflies + Fathom). Each arrives with
// a DIFFERENT transcript id, so nothing dedups them and you get two timeline entries + two
// extraction passes → duplicated claims. This detects a prior meeting_held on the same
// contacts within a time window whose external_id is from a DIFFERENT transcript than this
// one's (own retries share the prefix and are ignored). See the Data Ingestion doc.
//
// Only a RECORDING counts (GET-240). The calendar scan writes meeting_held for every calendar
// meeting, and HubSpot writes them for CRM meetings; neither carries a transcript. Counting
// them threw away the Granola recording of "Harborline x OpenNous" because the calendar had
// already marked the meeting held — no timeline, no notes, no extraction, no score.
export const NOTE_TAKER_SOURCES = new Set(['fireflies', 'fathom', 'granola', 'fellow']);

export async function sameMeetingAlreadyLogged(supabase, workspaceId, { contactIds, occurredAt, externalIdPrefix, windowHours = 3 }) {
  if (!Array.isArray(contactIds) || contactIds.length === 0 || !occurredAt) return false;
  const t = new Date(occurredAt).getTime();
  if (Number.isNaN(t)) return false;
  const from = new Date(t - windowHours * 3600_000).toISOString();
  const to   = new Date(t + windowHours * 3600_000).toISOString();
  const { data } = await supabase
    .from('observations')
    .select('external_id, source')
    .eq('workspace_id', workspaceId)
    .eq('property', 'interaction.meeting_held')
    .in('entity_id', contactIds)
    .in('source', [...NOTE_TAKER_SOURCES])
    .gte('observed_at', from)
    .lte('observed_at', to)
    .limit(50);
  if (!data?.length) return false;
  // A prior meeting_held from a DIFFERENT transcript/source = another note-taker of the
  // same call. Our own retries carry the same externalIdPrefix and are not a duplicate.
  return data.some(o => NOTE_TAKER_SOURCES.has(o.source) && !String(o.external_id ?? '').startsWith(externalIdPrefix));
}
