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

import { saveNote, upsertIdentifier } from '@nous/core';
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
// generic, structurally-identical titles like "Networking Call between Alex
// Rivera and <prospect>" all share the same filler words and the host's name, so
// token overlap would wrongly fuse back-to-back calls (Jordan 16:30 ↔ Kabir
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

/**
 * Resolve the contacts a meeting should attach to.
 * @param {object} meeting { startTime, title, attendees:[{email,name}], organizerEmail, source }
 * @returns {Promise<Array<contact>>} existing contacts (createIfMissing is never set here)
 */
export async function resolveMeetingContacts(supabase, workspaceId, meeting) {
  const { startTime, title, attendees = [], organizerEmail = null, source = 'meeting' } = meeting;
  const hostEmail = organizerEmail ? organizerEmail.toLowerCase().trim() : null;

  const resolved = new Map();   // contactId -> contact
  const unresolved = [];        // non-host attendee emails that matched no contact

  // (1) Identity match each attendee. Never attach a meeting to its own host /
  // organizer (the workspace user — you don't have a "meeting with yourself"),
  // and match on a real EMAIL only: a name-only attendee can smear the call onto
  // an unrelated same-name contact.
  for (const att of attendees) {
    const email = att.email ? att.email.toLowerCase().trim() : null;
    if (!email || email === hostEmail) continue;
    const { contact } = await resolveContact(
      supabase, workspaceId, { email, source }, { createIfMissing: false },
    );
    if (contact) {
      if (!resolved.has(contact.id)) resolved.set(contact.id, contact);
    } else {
      unresolved.push({ email });
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

  // (3) Email learning. When co-attendance pins exactly ONE prospect and there is
  // exactly ONE unresolved non-host attendee email, that address is almost
  // certainly the prospect joining from an alternate mailbox. Attach it as an
  // identifier (reversible) so future events resolve, and leave a Data Quality
  // note for auditability. Conservative on purpose: any ambiguity → skip (we'd
  // rather miss a link than fuse the wrong people).
  if (bookingContacts.length === 1 && unresolved.length === 1) {
    const target = bookingContacts[0];
    const newEmail = unresolved[0].email;
    const { data: claimed } = await supabase.from('entity_identifiers')
      .select('entity_id').eq('workspace_id', workspaceId)
      .eq('kind', 'email').eq('value', newEmail).maybeSingle();
    if (!claimed) {
      await upsertIdentifier(supabase, workspaceId, target.id, 'email', newEmail);
      await saveNote(supabase, workspaceId, {
        entityId: target.id, category: 'Data Quality',
        content: `Linked alternate email ${newEmail} via meeting co-attendance (${source}): they joined a meeting that matched this person's booking using an address we hadn't seen. Auto-linked — unlink if this isn't them.`,
        source: 'identity_resolution', confidence: 0.7,
        metadata: { flag: 'co_attendance_email_link', linked_email: newEmail, meeting_source: source },
      }).catch(() => {});
      console.log(`[MEETING_RESOLVE] co-attendance linked ${newEmail} → entity ${target.id} (${source})`);
    }
  }

  return [...resolved.values()];
}
