// The middle layer of a citation: the raw, rendered as a record a human reads.
//
// A citation today has two rungs — the claim, and a link out to Fireflies. That is a big gap
// to ask somebody to cross. They read "procurement is the blocker", and to check it they
// leave the product, land in a fifty-minute recording, and go looking. Most people don't, and
// a proof nobody checks is decoration.
//
// The hierarchy this file exists to make possible is three rungs, not two:
//
//     INSIGHT     "Procurement has become the primary blocker."
//     EVIDENCE    Call · Sep 8 · 31:42 — Odile Farrant, VP Ops:
//                 "I think procurement is going to be the thing that slows us down."
//                 …with the two lines either side, so the quote has a conversation around it.
//     SOURCE      Open recording ↗
//
// The middle rung is the one that does the work. It is also the one that has never existed.
//
// ── Two rules that shape everything below ──
//
// **Never the raw payload.** A Salesforce object rendered as JSON is not evidence, it is a
// dare. The reader wants "close date moved Sep 30 → Oct 31, by Theo, on the 10th". So each
// source gets a RENDERER, and a source we cannot render honestly returns nothing rather than
// a pretty-printed blob.
//
// **Never the whole transcript.** Thirty thousand characters with the quote somewhere inside
// is the same as no evidence. What earns trust is the quote with enough around it to see it
// was not cherry-picked — which is a handful of lines, not a document.

import type { SupabaseClient } from '@supabase/supabase-js';
import { systemLabel, readableProperty, gist } from './evidence.js';
import { resolveRaw } from './db/observations.js';
import { rawVisible } from './db/readContext.js';
import type { ReadContext } from './db/readContext.js';

/** What kind of record this is, which decides how the panel draws it. */
export type EvidenceKind = 'meeting' | 'email' | 'message' | 'field_change' | 'record';

export interface EvidenceDetail {
  kind: EvidenceKind;
  system: string;
  when: string | null;
  /** The headline of the record: a meeting title, an email subject, the field that changed. */
  title: string | null;
  /** Who said or did it, where we know. */
  who: string | null;
  /** The line itself — what was actually said or written. */
  body: string | null;
  /** The lines either side, so a quote can be seen in its conversation. Meetings only. */
  context: { who: string | null; text: string; isQuote: boolean }[] | null;
  /** A field change, rendered as the change rather than the value. */
  change: { field: string; from: string | null; to: string | null } | null;
  /**
   * Whether a full transcript is on file for this citation. What turns "read the excerpt"
   * into "ask it your own question" — the account agent can already read the document, so
   * the only thing missing was knowing one exists.
   */
  transcript: { entity_id: string; title: string | null; chars: number } | null;
  /** Content-hash check from resolveRaw: what we hold is byte-identical to what we ingested. */
  verified: boolean;
}

// Lines either side of the quote. Three is enough to show the question that prompted it and
// what it led to; more and the panel becomes the transcript it was supposed to replace.
const CONTEXT_LINES = 3;

const norm = (t: unknown) =>
  String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A citation's ref → the CANONICAL meeting ref its transcript is filed under.
 *
 * `source://fireflies/action_item_fireflies_01QX…_0` → `source://fireflies/01QX…`
 *
 * Two things make this necessary. The id is EMBEDDED in the segment rather than being the
 * whole of it — an action item appends its own prefix and index — so splitting on "/" and
 * taking the last part finds nothing. And the three note-takers each recorded a different
 * key on the document they saved (`meeting_id`, `note_id`, and in Fathom's case none at
 * all), so there was no single thing to join on. Now there is one: this.
 */
export function meetingRefFrom(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // Leading `.*` is GREEDY on purpose: it skips to the LAST occurrence of the provider name.
  // `action_item_fireflies_01QX…` contains the word twice, and a non-greedy match captures
  // "action_item_fireflies_01QX…" as the id — which then joins to nothing. Caught by the
  // test that two action items from one call must normalize to one ref.
  //
  // `-` is in the separator class for the git pointers the plugin plan writes:
  // `git://nous-raw/raw/acme/2026-04-02-fireflies-01QA2BC3D4EF….md` is the same call, filed
  // in the operator's own repo rather than here.
  // Fathom's recording ids are short and all digits (`source://fathom/100200300`, 9 of them), so
  // a 12-character floor alone never matched the ref every insight carries, and those citations
  // resolved to no call. The digits-only branch comes second so a long id is still taken whole.
  const m = /.*(fireflies|fathom|granola|fellow|ringcentral)[-_/]([0-9A-Za-z_-]{12,}|\d{6,})/.exec(ref);
  if (!m) return null;
  // Strip what each pipeline APPENDS to the meeting's own id, so every citation from one
  // call normalizes to the same ref. Two suffixes, and the order matters:
  //   `_<uuid>`  — Fathom keys its observations `fathom_<recordingId>_<contactId>`, one per
  //                attendee, so the same call arrives under five different refs.
  //   `_<n>`     — Fireflies appends an index per extracted action item.
  // Fathom's is stripped first because a uuid ends in hex that can look numeric.
  const id = m[2]
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
    .replace(/_\d+$/, '')
    // A file extension, from the git pointers: `…01QA2BC3D4EF….md`.
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    // ⚠️ The provider's OWN short prefix. Fireflies writes both `ff_01QZ7TRV…` and bare
    // `01QZ7TRV…` for the same meeting, which split one call into two rows with two tokens —
    // dozens of stored refs that were really fewer calls. Stripped LAST, after the suffixes, so it
    // cannot eat part of an id that legitimately starts with those letters.
    .replace(/^ff_/i, '');
  return `source://${m[1]}/${id}`;
}

/** @deprecated kept for the tests that pin the parsing; prefer meetingRefFrom. */
export function meetingIdFromRef(ref: string | null | undefined): string | null {
  const canonical = meetingRefFrom(ref);
  return canonical ? canonical.split('/').pop() ?? null : null;
}

/**
 * A `Speaker: line` transcript, cut down to the quote and its neighbours.
 *
 * Returns null when the quote cannot be found, and that is deliberate: a "context" block that
 * silently falls back to the first few lines of the call would show the reader a passage that
 * does not contain what we attributed, which is worse than showing them nothing.
 */
export function excerptAround(
  transcript: string,
  quote: string | null | undefined,
  lines = CONTEXT_LINES,
): { who: string | null; text: string; isQuote: boolean }[] | null {
  if (!transcript || !quote) return null;
  // A quote the extractor trimmed ("they talked about… but it just never worked out") is never
  // one transcript line; its longest fragment is. Located by that, not by the whole string.
  const q = quote.split(/\.{3}|…/).map(norm).sort((a, b) => b.length - a.length)[0] ?? '';
  if (q.length < 12) return null;                  // too short to locate anything honestly

  const rows = transcript.split('\n').map(l => l.trim()).filter(Boolean);
  const at = rows.findIndex(l => {
    const n = norm(l.replace(/^[^:]{2,60}:\s*/, ''));
    // A line with no words ("...", "Mm.") normalizes to almost nothing, and every quote
    // "contains" the empty string. Such a line can be context, never the match.
    if (n.length < 12) return false;
    return n.includes(q) || q.includes(n.slice(0, 80));
  });
  if (at < 0) return null;

  // A fixed window inside one person's monologue shows that person, several times, and never the
  // question they were answering. So the window reaches back to the other side's last line and
  // forward to their reply, a bounded distance, whichever is further than `lines`.
  const who = (l: string) => /^([^:]{2,60}):/.exec(l)?.[1]?.trim() ?? null;
  const me = who(rows[at]);
  let start = Math.max(0, at - lines), end = Math.min(rows.length - 1, at + lines);
  const REACH = 12;
  while (me && start > 0 && at - start < REACH && rows.slice(start, at).every(l => who(l) === me || who(l) === null)) start--;
  while (me && end < rows.length - 1 && end - at < REACH && rows.slice(at + 1, end + 1).every(l => who(l) === me || who(l) === null)) end++;
  return rows
    .slice(start, end + 1)
    .map((l, i) => {
      const m = /^([^:]{2,60}):\s*(.*)$/.exec(l);
      return {
        who: m?.[1]?.trim() ?? null,
        text: (m?.[2] ?? l).trim(),
        // Which of the returned lines IS the citation, so the panel can mark it. The others
        // are there to prove it was not lifted out of a conversation that said the opposite.
        isQuote: start + i === at,
      };
    })
    // A line with no words ("...") says nothing; keep it out of the excerpt unless it IS the quote.
    .filter(l => l.isQuote || norm(l.text).length > 0);
}

/**
 * The transcript filed for a meeting.
 *
 * Matched on `metadata.source_ref` — the one key every note-taker now writes and every
 * existing document has been backfilled with. The same call is filed against each attendee,
 * so several rows can match; any of them holds the same words, and `limit(1)` is correct
 * rather than lucky.
 */
async function transcriptFor(
  supabase: SupabaseClient,
  workspaceId: string,
  meetingRef: string | null,
): Promise<{ entity_id: string; title: string | null; content: string } | null> {
  if (!meetingRef) return null;
  const { data } = await supabase
    .from('claims')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .filter('value->metadata->>source_ref', 'eq', meetingRef)
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  const v = row.value as { content?: string; metadata?: { title?: string } } | null;
  const content = typeof v?.content === 'string' ? v.content : '';
  return content ? { entity_id: row.entity_id as string, title: v?.metadata?.title ?? null, content } : null;
}

// ── Per-source renderers ─────────────────────────────────────────────────────
//
// One per shape of raw we actually hold. Verified against production before writing any of
// them: LinkedIn raw averages 1k chars (the message is there), Gmail 19k (the body is there),
// HubSpot 59 (a field value, not history), and Fireflies 104 — a POINTER, not the transcript.
// That last one is why a meeting has to go and find its document instead of reading its raw,
// and why nobody could show the words before.

function renderEmail(raw: Record<string, unknown>, quote?: string | null) {
  const body = String(raw.body_text ?? raw.text ?? raw.snippet ?? raw.body ?? '').trim();
  // The paragraph that matters, not the whole thread with four quoted replies under it.
  const para = quote
    ? body.split(/\n{2,}/).find(p => norm(p).includes(norm(quote).slice(0, 60))) ?? null
    : null;
  return {
    title: String(raw.subject ?? '').trim() || null,
    who: String(raw.from ?? raw.from_email ?? raw.sender ?? '').trim() || null,
    body: (para ?? body).slice(0, 1200) || null,
  };
}

function renderMessage(raw: Record<string, unknown>) {
  return {
    title: null,
    who: String(raw.sender_name ?? raw.from ?? raw.author ?? '').trim() || null,
    body: String(raw.text ?? raw.message ?? raw.body ?? '').trim().slice(0, 1200) || null,
  };
}

/**
 * A CRM touch, rendered as the CHANGE where we can see one.
 *
 * ⚠️ We usually cannot. A CRM observation's raw is the value as it stood, not a diff — 59
 * characters on average in production. So `from` is filled only when the payload genuinely
 * carries a previous value, and is left null rather than guessed. A field change that invents
 * its own "from" is a fabricated record, and this whole file exists to stop exactly that.
 */
function renderFieldChange(property: string, raw: Record<string, unknown>, value: unknown) {
  const field = readableProperty(property);
  const to = gist(raw.value ?? raw.new_value ?? value, 80) || null;
  const from = raw.previous_value != null || raw.old_value != null
    ? gist(raw.previous_value ?? raw.old_value, 80)
    : null;
  return { field, from, to };
}


/**
 * Any observation of a meeting, for a citation that carries the CANONICAL ref.
 *
 * ⚠️ The gap this closes: an insight cites `source://fireflies/<id>`, but the observations
 * were written as `…/action_item_fireflies_<id>_0` and `fathom_<id>_<contactId>`. `resolveRaw`
 * matches the ref exactly, so it found nothing — 0 of 40 sampled insight refs — and the
 * citation rendered with a name, a date, and no way to open the call. Which is most of a
 * citation and none of the point.
 *
 * Matched on the meeting id inside the ref, and the FIRST observation with a usable raw wins:
 * every attendee's row points at the same recording, so any of them answers "where is it".
 */
export async function resolveMeetingRaw(
  supabase: SupabaseClient,
  workspaceId: string,
  meetingRef: string,
  ctx?: ReadContext,
): Promise<{ raw: unknown; source: string } | null> {
  const id = meetingRef.split('/').pop();
  if (!id) return null;
  const { data } = await supabase
    .from('observations')
    .select('raw, source, owner_user_id')
    .eq('workspace_id', workspaceId)
    .like('source_ref', `%${id}%`)
    .not('raw', 'is', null)
    .limit(6);
  for (const row of data ?? []) {
    // The same owner gate resolveRaw applies. A citation must not become the way to read
    // raw somebody could not open directly.
    if (!rawVisible(row.owner_user_id as string | null, ctx)) continue;
    if (row.raw && typeof row.raw === 'object') return { raw: row.raw, source: row.source as string };
  }
  return null;
}

/**
 * The name of a call, from ANY observation of it.
 *
 * A meeting is observed once per attendee and the ref a citation carries is only one of
 * them, so an exact lookup often finds nothing while four siblings sit there holding the
 * summary. Matched on the meeting id inside the ref rather than the ref itself.
 */
async function meetingSummaryFor(
  supabase: SupabaseClient,
  workspaceId: string,
  meetingRef: string,
): Promise<string | null> {
  const id = meetingRef.split('/').pop();
  if (!id) return null;
  const { data } = await supabase
    .from('observations')
    .select('value')
    .eq('workspace_id', workspaceId)
    .like('source_ref', `%${id}%`)
    .not('value', 'is', null)
    .limit(4);
  for (const row of data ?? []) {
    const v = row.value as Record<string, unknown> | null;
    const name = typeof v?.summary === 'string' ? v.summary : typeof v?.title === 'string' ? v.title : null;
    if (name?.trim()) return name.trim().slice(0, 120);
  }
  return null;
}

/**
 * Everything behind one citation, resolved and rendered.
 *
 * `quote` is what was cited — it is what lets a meeting find its moment in the transcript and
 * an email find its paragraph. Without it the detail is still useful, just not located.
 */
export async function getEvidenceDetail(
  supabase: SupabaseClient,
  workspaceId: string,
  ref: string,
  opts: { quote?: string | null; ctx?: ReadContext } = {},
): Promise<EvidenceDetail | null> {
  // ── A meeting is resolved FIRST, and without needing an observation ──
  //
  // ⚠️ The bug this ordering fixes: gating everything on `resolveRaw` meant a citation only
  // produced evidence if an observation carried that EXACT source_ref. Insights carry the
  // CANONICAL meeting ref (`source://fireflies/<id>`) while observations carry the shape
  // their pipeline wrote (`…/action_item_fireflies_<id>_0`), so the richest citations in the
  // product — the verbatim buyer quotes — resolved to nothing at all.
  //
  // It is also the wrong dependency on its own terms. A meeting observation's raw is a
  // POINTER, 104 characters; the words live in the filed transcript. So the transcript IS
  // the evidence here, and requiring the pointer to exist first was asking permission from
  // the one row that has nothing to say.
  const meetingRef = meetingRefFrom(ref);
  if (meetingRef) {
    const doc = await transcriptFor(supabase, workspaceId, meetingRef);
    // A call with no transcript filed and no observation under this EXACT ref still has a
    // name: another observation of the same meeting carries it. Without this the row reads
    // just "Call", which is a source the reader cannot tell apart from the other three in
    // the list — the citation names a category instead of a thing.
    const named = doc ? null : await meetingSummaryFor(supabase, workspaceId, meetingRef);
    // Best-effort: it adds the timestamp and the content-hash check when an observation
    // happens to exist under this ref, and is simply absent when one does not.
    const obs = await resolveRaw(supabase, workspaceId, ref, opts.ctx).catch(() => null);
    if (!doc && !obs) return null;
    const rawMeta = (obs?.raw ?? {}) as Record<string, unknown>;
    return {
      kind: 'meeting',
      system: systemLabel(obs?.source ?? meetingRef.split('/')[2]),
      when: obs?.observedAt ?? null,
      verified: obs?.verified ?? false,
      change: null,
      // Three roads to a name, in order of how much each knows: the filed transcript's own
      // title, the observation's summary, the raw's title. A row that reads only "Call" is a
      // source the reader cannot tell apart from the other three in the list.
      // Four roads to a name, in order of how much each knows: the filed transcript's title,
      // this observation's summary, any sibling observation of the same call, the raw's title.
      title: doc?.title
        ?? (String((obs?.value as Record<string, unknown> | null)?.summary ?? '').trim() || null)
        ?? named
        ?? (String(rawMeta.title ?? '').trim() || null),
      who: null,
      body: opts.quote ?? null,
      context: doc ? excerptAround(doc.content, opts.quote) : null,
      // Offered whether or not the quote could be located: even when we cannot show the
      // passage, knowing a transcript exists is what makes "ask it yourself" available.
      transcript: doc
        ? { entity_id: doc.entity_id, title: doc.title, chars: doc.content.length }
        : null,
    };
  }

  const resolved = await resolveRaw(supabase, workspaceId, ref, opts.ctx);
  if (!resolved) return null;

  const system = systemLabel(resolved.source);
  const raw = (resolved.raw ?? {}) as Record<string, unknown>;
  const base = {
    system,
    when: resolved.observedAt ?? null,
    verified: resolved.verified,
    change: null as EvidenceDetail['change'],
    context: null as EvidenceDetail['context'],
    transcript: null as EvidenceDetail['transcript'],
  };

  if (/gmail|smtp|outlook/i.test(resolved.source)) {
    return { ...base, kind: 'email', ...renderEmail(raw, opts.quote) };
  }
  if (/linkedin|slack/i.test(resolved.source)) {
    return { ...base, kind: 'message', ...renderMessage(raw) };
  }
  if (/hubspot|salesforce|attio|pipedrive|close/i.test(resolved.source)) {
    const property = String(raw.property ?? raw.field ?? '');
    return {
      ...base,
      kind: 'field_change',
      title: null,
      who: String(raw.updated_by ?? raw.owner ?? '').trim() || null,
      body: null,
      change: renderFieldChange(property, raw, resolved.raw),
    };
  }

  // Something we hold but have no honest rendering for. A generic gist beats a JSON blob and
  // is clearly marked as a plain record rather than dressed up as a quote.
  const body = gist(resolved.raw, 400);
  return { ...base, kind: 'record', title: null, who: null, body: body || null };
}

/**
 * A short, stable token for one source — the thing an agent CITES.
 *
 * ⚠️ The bug this exists to kill: the model numbered its own citations and the panel numbered
 * its own rows, and the two had no relationship. Observed in production: an answer discussing
 * calls with Corin, Dax and Rowan carried [1][2][3][4] over a panel listing "Theo X Avery",
 * two LinkedIn messages and an email. Every marker pointed at the wrong thing.
 *
 * That is not fixable by prompting, because the model cannot see the panel — it is numbering
 * blind and any agreement would be luck. So it stops numbering. The token is derived from the
 * source_ref, handed to the model in the tool result, and copied into the text; the panel
 * derives the SAME token from the same ref and maps it to a row. Neither side counts, so
 * neither side can drift.
 *
 * Four characters of base36: short enough that a model copies it without transcription error,
 * wide enough (1.6M) that two sources in one answer will not collide.
 */
export function citeKey(ref: string | null | undefined): string | null {
  if (!ref) return null;
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (Math.imul(h, 31) + ref.charCodeAt(i)) | 0;
  return `c${(Math.abs(h) % 1679616).toString(36).padStart(4, '0')}`;
}
