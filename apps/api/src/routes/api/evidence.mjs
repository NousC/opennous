// /api/evidence — the last step of a citation: go look at the original.
//
// A rep's trust problem is not that the agent might be wrong, it's that they cannot check.
// A quote with a speaker and a date gets them most of the way; this closes it — the call in
// Fireflies, the thread in Gmail, opened where they already have access.
//
// We deliberately do NOT serve raw bodies here. The link goes to the system of record, which
// already enforces that person's access, keeps its own audit trail, and shows the message in
// the place they'd expect it. Copying a transcript through us to display it would duplicate
// somebody else's words for no gain in verifiability.

import { viewerReadContext, requestMessageViewer } from '../../lib/messagePrivacy.mjs';
import { getVisibilityScope } from '../../lib/visibility.mjs';
import { Router } from 'express';
import { getSupabaseClient, resolveRaw, getClaimProvenance, getEvidenceDetail, resolveMeetingRaw, meetingRefFrom, explainIdentity, canReadMeetingRaw } from '@nous/core';
import { isWorkspaceMember } from '../../lib/authz.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';

export const evidenceRouter = Router();

const MAX_REFS = 40;

/**
 * The raw we stored → a URL a person can open, per system.
 *
 * Only where the link is REAL. LinkedIn message ids don't resolve to a public URL, so
 * LinkedIn returns null and the panel shows no link rather than a dead one — a citation
 * that promises proof and 404s is worse than one that stays quiet.
 */
// ── Deep citation: the moment, not the recording ─────────────────────────────
//
// A link that drops somebody at the top of a fifty-minute call and leaves them to find the
// line is a citation most people never actually check — and a proof nobody checks is
// decoration. When the quote we cited is known, this finds where in the call it was said.
//
// The cue index is written at ingest (worker/webhooks/handlers/fireflies.mjs). Meetings
// recorded before it shipped carry none, and then the link is exactly what it was: the top
// of the transcript. Degrading to the old behaviour is the right failure — a wrong timestamp
// is worse than no timestamp, because the reader lands on the wrong sentence and concludes
// we made the quote up.
const normalizeCue = (t) =>
  String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function cueTimeFor(raw, quote) {
  const cues = Array.isArray(raw?.cues) ? raw.cues : null;
  if (!cues?.length || !quote) return null;
  const q = normalizeCue(quote);
  // Short quotes match everywhere and locate nothing. Below this the honest answer is to
  // send them to the top of the call rather than to a confident wrong second.
  if (q.length < 12) return null;

  for (const [t, text] of cues) {
    if (typeof text !== 'string' || typeof t !== 'number') continue;
    // The cue is the sentence's opening 64 characters, so a quote CONTAINS the cue when the
    // quote is the whole sentence, and STARTS WITH it when the quote is longer. Both are the
    // same line. Checking containment both ways costs nothing and catches the common case
    // where the extraction trimmed a leading "So," or "I mean,".
    if (q.includes(text) || text.includes(q.slice(0, 64))) return Math.max(0, t - 2);
  }
  return null;
}

function linkFor(source, raw, quote) {
  if (!raw || typeof raw !== 'object') return null;

  // Note-takers hand us the URL outright — the transcript lives with them.
  const transcript = raw.transcript_url ?? raw.share_url ?? raw.recording_url ?? raw.url;
  if (typeof transcript === 'string' && /^https?:\/\//.test(transcript)) {
    const label = `Open in ${source === 'fathom' ? 'Fathom' : source === 'granola' ? 'Granola' : source === 'fellow' ? 'Fellow' : 'Fireflies'}`;
    const at = cueTimeFor(raw, quote);
    if (at == null) return { url: transcript, label };
    // Fireflies reads ?t= in seconds. Appended rather than templated so a share URL that
    // already carries its own query string keeps it.
    const url = `${transcript}${transcript.includes('?') ? '&' : '?'}t=${at}`;
    return { url, label: `${label} at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`, at };
  }

  if (source === 'gmail' || source === 'gmail_oauth') {
    const id = typeof raw.message_id === 'string' ? raw.message_id.trim() : null;
    if (!id) return null;
    // Two id shapes reach us: Gmail's own message id (hex, deep-linkable) and an RFC-822
    // Message-ID from a header (contains @), which Gmail can only find by search.
    const url = id.includes('@')
      ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(id)}`
      : `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`;
    return { url, label: 'Open in Gmail' };
  }

  return null;
}

// POST /api/evidence/links { workspaceId, refs: ["source://fireflies/abc", …] }
//
// Batched and lazy: the panel asks once, when a person opens it, for the handful of
// citations on screen. resolveRaw enforces the owner gate per row, so a member never gets a
// link to raw they could not read directly.
evidenceRouter.post('/links', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    // Two accepted shapes. A bare string is the original contract and still works; an
    // object carries the QUOTE we cited, which is what lets the link land on the moment
    // rather than the recording. Callers that have the quote should send it.
    const incoming = Array.isArray(req.body?.refs) ? req.body.refs.slice(0, MAX_REFS) : [];
    const quoteByRef = new Map();
    const refs = [];
    for (const r of incoming) {
      const ref = typeof r === 'string' ? r : typeof r?.ref === 'string' ? r.ref : null;
      if (!ref) continue;
      refs.push(ref);
      if (typeof r?.quote === 'string' && r.quote.trim()) quoteByRef.set(ref, r.quote.trim().slice(0, 400));
    }
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (!refs.length) return res.json({ links: {} });

    const supabase = getSupabaseClient();
    const readCtx = viewerReadContext(req, workspaceId);

    const entries = await Promise.all([...new Set(refs)].map(async (ref) => {
      try {
        let resolved = await resolveRaw(supabase, workspaceId, ref, readCtx);
        // A citation carrying the CANONICAL meeting ref has no observation under that exact
        // string — the pipelines wrote `action_item_fireflies_<id>_0` and
        // `fathom_<id>_<contactId>`. Verified against production: 0 of 40 sampled insight
        // refs matched exactly, so those citations rendered with a name, a date, and no way
        // to open the call, which is most of a citation and none of the point. Every
        // attendee's row points at the same recording, so any of them answers "where is it".
        if (!resolved) {
          const meetingRef = meetingRefFrom(ref);
          const fromMeeting = meetingRef
            ? await resolveMeetingRaw(supabase, workspaceId, meetingRef, readCtx)
            : null;
          // `verified` stays false: the content hash belongs to the row we looked up by its
          // own ref, and claiming a check we did not run is the one thing this must not do.
          if (fromMeeting) resolved = { ...fromMeeting, verified: false };
        }
        if (!resolved) return [ref, null];
        const link = linkFor(resolved.source, resolved.raw, quoteByRef.get(ref));
        if (!link) return [ref, null];
        // `verified` is resolveRaw's content-hash check: the raw we hold is byte-identical
        // to what we ingested. Passed through so the UI can say so where it matters.
        // The meeting's own name ("Quist/Bramwell"), so a source reads as the conversation it was.
        const title = typeof resolved.raw?.title === 'string' ? resolved.raw.title.slice(0, 200) : null;
        return [ref, { ...link, source: resolved.source, verified: resolved.verified, title }];
      } catch {
        return [ref, null];
      }
    }));

    return res.json({ links: Object.fromEntries(entries.filter(([, v]) => v)) });
  } catch (err) {
    console.error('[POST /api/evidence/links]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/evidence/provenance?workspaceId=&entityId=&property=
//
// "Why do you believe that?", answered from the claim itself: how sure, how fresh, how many
// systems, which observations, when a source last confirmed it, and which systems currently
// hold a different value.
//
// This has all been on the row since Phase 0 and has never reached a user. The record has
// been honest and silent, which from the outside is indistinguishable from a guess with a
// nice font.
evidenceRouter.get('/provenance', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, entityId, property } = req.query;
    if (!workspaceId || !entityId || !property) {
      return res.status(400).json({ error: 'workspaceId_entityId_property_required' });
    }
    const supabase = getSupabaseClient();
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Named viewer: a fact from an email they aren't on has no provenance for them (GET-253).
    const prov = await getClaimProvenance(supabase, String(workspaceId), String(entityId), String(property), viewerReadContext(req, String(workspaceId)));
    // No live claim is a real and useful answer: the product never believed that. Rendering a
    // provenance chip for a fact nobody asserted would be inventing a belief to justify.
    if (!prov) return res.status(404).json({ error: 'no_claim', property });
    return res.json({ provenance: prov });
  } catch (err) {
    console.error('[GET /api/evidence/provenance]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/evidence/detail { workspaceId, refs: [{ ref, quote }] }
//
// The middle rung of a citation: the raw, RENDERED — the quote with the lines either side, an
// email's relevant paragraph, a field change as a change. Not the payload, and not the whole
// transcript. See packages/core/src/evidenceDetail.ts for why each of those is a refusal
// rather than an omission.
//
// Batched, because a panel opens with several citations on screen and one round trip per row
// is the difference between a panel people verify through and one they close.
evidenceRouter.post('/detail', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const wanted = (Array.isArray(req.body?.refs) ? req.body.refs : [])
      .map(r => (typeof r === 'string' ? { ref: r } : r))
      .filter(r => typeof r?.ref === 'string')
      .slice(0, 12);
    if (!wanted.length) return res.json({ details: {} });

    // The SAME read context the links endpoint uses. resolveRaw enforces the owner gate per
    // row, so a member never sees the body of a message they could not open directly — which
    // matters far more here than for a link, because this endpoint returns the WORDS.
    const ctx = viewerReadContext(req, workspaceId);

    const entries = await Promise.all(wanted.map(async ({ ref, quote }) => {
      try {
        const detail = await getEvidenceDetail(supabase, workspaceId, ref, { quote, ctx });
        return [ref, detail];
      } catch {
        return [ref, null];
      }
    }));

    return res.json({ details: Object.fromEntries(entries.filter(([, v]) => v)) });
  } catch (err) {
    console.error('[POST /api/evidence/detail]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/evidence/source { workspaceId, ref }
//
// The raw itself, for the viewer beside the chat. `/detail` answers "what is this and can I
// open it"; this answers "show me it" — the whole transcript, or the whole email.
//
// Deliberately a SEPARATE endpoint rather than a flag on /detail. The panel asks for a dozen
// details every time it opens; the viewer asks for one document when somebody actually wants
// to read it. Folding them together would put 30,000 characters × 12 behind a click that
// most people make to glance at a date.
evidenceRouter.post('/source', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, ref } = req.body ?? {};
    if (!workspaceId || typeof ref !== 'string') return res.status(400).json({ error: 'workspaceId_and_ref_required' });
    const supabase = getSupabaseClient();
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const readCtx = viewerReadContext(req, workspaceId);

    // A meeting: the words are in the filed document, never in the observation's raw (which
    // is a 104-character pointer). Matched on the canonical meeting ref, because the same
    // call is filed against every attendee under a ref of its own.
    const meetingRef = meetingRefFrom(ref);
    if (meetingRef) {
      const { data } = await supabase
        .from('claims')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId)
        .like('property', 'note.%')
        .is('invalid_at', null)
        .is('value->metadata->>side', null)   // GET-1052: our side's statement is not the meeting's text
        .filter('value->metadata->>source_ref', 'eq', meetingRef)
        .limit(1);
      const row = data?.[0];
      if (row?.value?.content) {
        const v = row.value;
        // A citation must not become the way to read a transcript somebody could not open
        // directly (GET-286). The words belong to the people who were in the room; the claims
        // drawn out of them are the company's and are not gated here.
        const viewer = await requestMessageViewer(supabase, req, workspaceId);
        const allowed = canReadMeetingRaw(v.metadata ?? {},
          { ...(viewer ?? { userId: req.internalUserId ?? null, emails: new Set() }), isAdmin: req.viewerScope === 'admin' },
          { open: (await getVisibilityScope(supabase, workspaceId, req)).open });
        if (!allowed) {
          return res.status(403).json({
            error: 'not_yours',
            message: 'This call\'s words are for the people who were in it. What was learned from it is on the account.',
          });
        }
        return res.json({
          kind: 'transcript',
          title: v.metadata?.title ?? null,
          system: v.source ?? meetingRef.split('/')[2],
          date: v.metadata?.date ?? null,
          content: String(v.content).slice(0, 400_000),
        });
      }
    }

    // Everything else — an email, a LinkedIn message — reads its own raw.
    const detail = await getEvidenceDetail(supabase, workspaceId, ref, { ctx: readCtx });
    if (!detail?.body) {
      // Said plainly rather than returned as an empty document. "We hold the pointer but not
      // the words" is a real state and the viewer should say which one it is in.
      return res.status(404).json({ error: 'no_content', message: 'We have the pointer to this source but not its contents.' });
    }
    return res.json({
      kind: detail.kind,
      title: detail.title,
      system: detail.system,
      date: detail.when,
      who: detail.who,
      content: detail.body,
    });
  } catch (err) {
    console.error('[POST /api/evidence/source]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/evidence/identity?workspaceId=&entityId=
//
// Why this record is this record: every identifier and which system asserted it, what was
// merged into it and on what basis, and any live cross-source disagreement. The identity
// counterpart to /provenance, which answers the same question about a single claim.
evidenceRouter.get('/identity', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, entityId } = req.query;
    if (!workspaceId || !entityId) return res.status(400).json({ error: 'workspaceId_and_entityId_required' });
    const supabase = getSupabaseClient();
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.json({ identity: await explainIdentity(supabase, String(workspaceId), String(entityId)) });
  } catch (err) {
    console.error('[GET /api/evidence/identity]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
