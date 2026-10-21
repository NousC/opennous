// Who may read a message's CONTENT — one rule, for every reader (GET-244).
//
// Nous files every email and LinkedIn message a teammate's connected account sees onto the
// person it involves, so the whole team knows the conversation happened. What it SAID belongs to
// the people who were in it. Until this module there were three different rules and a dozen
// readers with none: an owner-only check that open workspaces switched off, an "in touch"
// exception that let anyone who had ever touched an account read every teammate's email with
// it, an admin bypass, a redacted header that still printed the subject, and endpoints that
// returned full bodies with no check at all.
//
// THE RULE. A viewer may read a message's subject, preview and body when:
//   1. no viewer is named — a system job (extraction, scoring, sync) is not a privacy boundary;
//   2. the row has no owner — company tooling (a sequencer, a CRM log) is not anyone's inbox;
//   3. it came from the viewer's own connected account, or the viewer's mailbox holds a copy
//      (raw.mailbox_owner_ids — how a bcc is honoured, since a bcc leaves no header);
//   4. one of the viewer's own addresses is a participant — from, to or cc.
// Everyone else sees that it happened — who, when, which way — and nothing it said. Role does
// not matter: a founder does not read a co-founder's 1:1 with a prospect. The same predicate is
// enforced in SQL by visible_observations_v2 (migration 2026_09_14_message_privacy.sql); change
// one, change both.

import { getInternalIdentities } from '../db/teamMembers.js';

/** Interaction types whose content is private to its participants. */
export const PRIVATE_MESSAGE_TYPES = new Set([
  'email_sent', 'email_received', 'email_reply', 'email_replied',
  'linkedin_message', 'linkedin_message_sent', 'linkedin_message_received',
  'linkedin_replied', 'linkedin_reply',
  'linkedin_inmail', 'linkedin_inmail_sent', 'linkedin_inmail_received',
  // A teammate's own Slack DMs (GET-985). Channel messages stay shared: a channel is a room the
  // team was invited into, a DM is somebody's conversation. The snapshot a DM read files as
  // evidence is the same conversation, so it follows the same rule.
  'slack_dm', 'slack_dm_conversation',
]);

/** `interaction.email_sent`, `evidence.slack_dm_conversation` or `email_sent` → a private message? */
export function isPrivateMessageType(typeOrProperty) {
  return PRIVATE_MESSAGE_TYPES.has(String(typeOrProperty || '').replace(/^(interaction|evidence)\./, ''));
}

const lower = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(lower).filter(Boolean);

/** Every address on a message: participants when stored, the legacy from/to/cc otherwise. */
export function messageParticipants(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.participants && typeof r.participants === 'object' ? r.participants : {};
  return [...new Set([
    ...list(p.from), ...list(p.to), ...list(p.cc),
    ...list(r.from), ...list(r.to), ...list(r.cc),
  ])];
}

/**
 * May this viewer read this message's content?
 * @param {{ owner_user_id?: string|null, raw?: object|null, raw_data?: object|null }} row
 * @param {{ userId: string|null, emails: Set<string> } | null | undefined} viewer
 */
export function canReadMessage(row, viewer) {
  if (!viewer || !viewer.userId) return true;                       // 1. system
  const owner = row?.owner_user_id ?? null;
  if (owner == null) return true;                                   // 2. company tooling
  if (owner === viewer.userId) return true;                         // 3. own account
  const raw = row?.raw ?? row?.raw_data ?? null;
  const holders = Array.isArray(raw?.mailbox_owner_ids) ? raw.mailbox_owner_ids : [];
  if (holders.includes(viewer.userId)) return true;                 // 3. a copy in their mailbox
  const emails = viewer.emails instanceof Set ? viewer.emails : new Set(list(viewer.emails));
  return messageParticipants(raw).some((a) => emails.has(a));      // 4. on the email
}

/** Sent or received, from the type or the payload. */
export function messageDirection(type, raw, summary) {
  const t = String(type || '').replace(/^interaction\./, '');
  if (t.endsWith('_sent')) return 'sent';
  if (t.endsWith('_received')) return 'received';
  const outbound = raw?.is_outbound ?? raw?.is_sender;
  if (typeof outbound === 'boolean') return outbound ? 'sent' : 'received';
  if (/^you:\s*/i.test(summary ?? '')) return 'sent';
  return 'received';
}

/** The label a redacted message shows. Never the subject. */
export function redactedMessageLabel(type, raw, summary) {
  const t = String(type || '').replace(/^(interaction|evidence)\./, '');
  const dir = messageDirection(t, raw, summary);
  if (t.startsWith('slack_')) return `Slack message ${dir}`;
  return t.startsWith('email_') ? `Email ${dir}` : `LinkedIn message ${dir}`;
}

/** What a redacted row keeps of its payload: who was on it and which way it went. */
function redactedRaw(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const p = r.participants && typeof r.participants === 'object' ? r.participants : null;
  return {
    participants: p ?? { from: lower(r.from), to: list(r.to), cc: list(r.cc) },
    is_outbound: typeof r.is_outbound === 'boolean' ? r.is_outbound : undefined,
    redacted: true,
  };
}

/**
 * May this viewer read a MEETING's raw words (GET-286)?
 *
 * A transcript is the most sensitive thing we hold: everything said in a room, including the parts
 * the buyer meant for the person in front of them. The claims drawn OUT of it are the company's —
 * that is the whole point of the product — but the words themselves belong to the people who were
 * in the call, the same way an email's words belong to the people on it.
 *
 * So: the host, anyone the meeting was attributed to, and admins. A meeting nobody has claimed
 * (a company note-taker's call where no attendee holds a seat yet) follows the workspace's own
 * visibility dial rather than defaulting to everyone.
 *
 * @param meta   the document's metadata: { owner_user_id, host_email, attendee_emails? }
 * @param viewer { userId, emails: Set<string>, isAdmin }
 * @param open   the workspace's open_account_visibility
 */
export function canReadMeetingRaw(meta, viewer, { open = false } = {}) {
  if (!viewer || !viewer.userId) return true;                       // a system job
  if (viewer.isAdmin) return true;
  const m = meta && typeof meta === 'object' ? meta : {};
  if (m.owner_user_id && m.owner_user_id === viewer.userId) return true;
  const emails = viewer.emails instanceof Set ? viewer.emails : new Set(viewer.emails ?? []);
  const was = (v) => typeof v === 'string' && emails.has(v.trim().toLowerCase());
  if (was(m.host_email)) return true;
  if (Array.isArray(m.attendee_emails) && m.attendee_emails.some(was)) return true;
  return !m.owner_user_id && open;
}

/** An observation-shaped row ({ property, value, raw, owner_user_id }) the viewer may see. */
export function redactObservationForViewer(o, viewer) {
  if (!o || !isPrivateMessageType(o.property) || canReadMessage(o, viewer)) return o;
  const label = redactedMessageLabel(o.property, o.raw, o.value?.summary);
  return {
    ...o,
    value: { description: label, summary: null },
    ...(o.raw !== undefined ? { raw: redactedRaw(o.raw) } : {}),
    redacted: true,
  };
}

/** An activity-shaped row ({ activity_type, description, summary, raw_data }) the viewer may see. */
export function redactActivityForViewer(a, viewer) {
  if (!a || !isPrivateMessageType(a.activity_type) || canReadMessage(a, viewer)) return a;
  return {
    ...a,
    description: redactedMessageLabel(a.activity_type, a.raw_data, a.summary),
    summary: null,
    raw_data: redactedRaw(a.raw_data),
    redacted: true,
  };
}

export function applyMessagePrivacyToObservations(rows, viewer) {
  if (!viewer || !viewer.userId) return rows;
  return (rows || []).map((o) => redactObservationForViewer(o, viewer));
}

export function applyMessagePrivacyToActivities(rows, viewer) {
  if (!viewer || !viewer.userId) return rows;
  return (rows || []).map((a) => redactActivityForViewer(a, viewer));
}

/**
 * Redact message rows fetched by a reader that could not select the payload (a semantic RPC, a
 * narrow column list): loads owner + raw for the message rows only, then applies the rule.
 * Rows keep their shape; a redacted row gets a labelled `value`, a stripped `raw`, `redacted`.
 */
export async function redactObservationRowsForViewer(supabase, workspaceId, rows, viewer) {
  if (!viewer || !viewer.userId || !rows?.length) return rows;
  const need = rows.filter((r) => isPrivateMessageType(r.property) && (r.raw === undefined || r.owner_user_id === undefined)).map((r) => r.id);
  const extra = new Map();
  for (let i = 0; i < need.length; i += 200) {
    const { data } = await supabase.from('observations').select('id, owner_user_id, raw')
      .eq('workspace_id', workspaceId).in('id', need.slice(i, i + 200));
    for (const d of data || []) extra.set(d.id, d);
  }
  return rows.map((r) => {
    if (!isPrivateMessageType(r.property)) return r;
    const e = extra.get(r.id);
    const full = e ? { ...r, owner_user_id: e.owner_user_id, raw: e.raw } : r;
    // A message whose owner we could not load is treated as private, never as shared.
    if (full.owner_user_id === undefined) return redactObservationForViewer({ ...full, owner_user_id: '__unknown__' }, viewer);
    const out = redactObservationForViewer(full, viewer);
    return out.redacted ? out : r;
  });
}

// ── The viewer ──────────────────────────────────────────────────────────────
// A viewer's addresses: their login email and every mailbox they connected. Cached briefly — a
// page load reads several surfaces, and a newly connected mailbox shows up within a minute.
const viewerCache = new Map();
const VIEWER_TTL_MS = 60_000;

/**
 * The message viewer for a member, or null for a system caller (no user id).
 * @returns {Promise<{ userId: string, emails: Set<string> } | null>}
 */
export async function loadMessageViewer(supabase, workspaceId, userId) {
  if (!userId) return null;
  const key = `${workspaceId}|${userId}`;
  const hit = viewerCache.get(key);
  if (hit && Date.now() - hit.at < VIEWER_TTL_MS) return hit.viewer;
  const emails = new Set();
  try {
    for (const idy of await getInternalIdentities(supabase, workspaceId)) {
      if (idy.kind === 'email' && idy.ownerUserId === userId && idy.value) emails.add(String(idy.value).trim().toLowerCase());
    }
  } catch { /* no addresses → they read only what their own account filed; never more */ }
  const viewer = { userId, emails };
  viewerCache.set(key, { at: Date.now(), viewer });
  return viewer;
}

/** The viewer for a ReadContext — null (system) when the context names no member. */
export function messageViewerForContext(supabase, ctx) {
  return ctx?.viewerUserId ? loadMessageViewer(supabase, ctx.workspaceId, ctx.viewerUserId) : Promise.resolve(null);
}

// ── What was DERIVED from a message (GET-253, GET-985) ──────────────────────
// A fact, an action item or a reply disposition pulled out of a private message (an email, a
// LinkedIn message, a Slack DM) is the TEAM's: everyone sees the fact, health and automations count
// it, so nobody acts on an account as if a teammate's live conversation did not exist. What the
// message SAID stays with the people in it: the verbatim quote a fact carries is shown only to a
// member who may read at least one message it came from; everyone else gets the fact with
// `quote_private: true` and no quote (a founder decision, 2026-10-21, superseding GET-253's
// "facts follow the email"). The check follows the pointer to the source AT READ TIME rather than
// copying an access list onto the fact, because a teammate's mailbox copy is merged onto the
// message after the fact was extracted (addMailboxCopy) and a copied list would go stale.

/**
 * The viewer an aggregate is written for: the whole team. It reads shared material only — a
 * summary, a coaching note, a graph label is shown to everyone, so what goes into it must be
 * readable by everyone. canReadMessage passes company tooling (no owner) and nothing owned.
 */
export const TEAM_VIEWER = Object.freeze({ userId: '__team__', emails: new Set() });

/** Signal types that name a message as the source, for a fact whose source row is gone. */
const MESSAGE_SIGNAL_RE = /^(email_|linkedin_|slack_dm|conversation_thread$|reply$|positive_reply$|email$|linkedin$)/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The observations a derived row points back to, from any of the shapes readers hold: a claim row
 * ({ value, supporting_observation_ids }), a Note ({ metadata, supporting_observation_ids }), an
 * action item value ({ source_id, source_type }).
 * @returns {{ ids: string[], messageHint: boolean }}
 */
export function derivedSources(row) {
  const r = row && typeof row === 'object' ? row : {};
  const v = r.value && typeof r.value === 'object' ? r.value : {};
  const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata
    : (v.metadata && typeof v.metadata === 'object') ? v.metadata : {};
  const ids = [
    ...(Array.isArray(r.supporting_observation_ids) ? r.supporting_observation_ids : []),
    ...(Array.isArray(meta.source_observation_ids) ? meta.source_observation_ids : []),
    meta.source_activity_id, v.source_id, r.source_id,
  ].filter((x) => typeof x === 'string' && UUID_RE.test(x));
  const hint = [meta.signal_type, v.source_type, r.source_type]
    .some((t) => typeof t === 'string' && MESSAGE_SIGNAL_RE.test(t));
  return { ids: [...new Set(ids)], messageHint: hint };
}

/**
 * Load the message rows behind derived rows: id → { property, owner_user_id, raw } for every source
 * that is a message (other observations are dropped — they carry no privacy). `found` holds every
 * id that exists at all, so a source that was deleted can be told apart from one that isn't a message.
 */
export async function loadDerivedSources(supabase, workspaceId, rows) {
  const ids = [...new Set((rows || []).flatMap((r) => derivedSources(r).ids))];
  const messages = new Map();
  const found = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('observations')
      .select('id, property, owner_user_id, mailbox_owner_ids:raw->mailbox_owner_ids, participants:raw->participants, from:raw->from, to:raw->to, cc:raw->cc')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 200));
    // A lookup that failed must not read as "no private sources": mark every id unknown.
    if (error) return { messages, found, failed: true };
    for (const d of data || []) {
      // An action item's claim points at its own action_item.* observation — a pointer to the
      // derived row, not evidence. Only the message it names (value.source_id) decides.
      if (isDerivedProperty(d.property)) continue;
      found.add(d.id);
      if (!isPrivateMessageType(d.property)) continue;
      messages.set(d.id, {
        property: d.property, owner_user_id: d.owner_user_id,
        raw: { mailbox_owner_ids: d.mailbox_owner_ids, participants: d.participants, from: d.from, to: d.to, cc: d.cc },
      });
    }
  }
  return { messages, found, failed: false };
}

/**
 * May this viewer read a derived row's WORDING (its quotes), given its loaded sources? The fact
 * itself is shared either way (GET-985).
 *   - system viewer → yes;
 *   - any source that is not a private message (a meeting, a CRM row) → yes, it is shared evidence;
 *   - any readable message source → yes;
 *   - a source we could not find, on a row that says it came from a message → no (a deleted
 *     message is still somebody's message; this fails closed like an unknown owner does).
 */
export function canReadDerived(row, sources, viewer) {
  if (!viewer || !viewer.userId) return true;
  const { ids, messageHint } = derivedSources(row);
  if (!ids.length) return !messageHint;
  if (sources?.failed) return false;
  let sawMessage = false;
  for (const id of ids) {
    const msg = sources.messages.get(id);
    if (msg) { sawMessage = true; if (canReadMessage(msg, viewer)) return true; continue; }
    if (sources.found.has(id)) return true;          // a non-message source: shared
  }
  // Only messages the viewer can't read, or ids that no longer exist.
  return sawMessage ? false : !messageHint;
}

/** Is this a row whose content may come from a message? note.*, action_item.*, reply_signal. */
export function isDerivedProperty(property) {
  const p = String(property || '');
  return p.startsWith('note.') || p.startsWith('action_item.') || p === 'reply_signal';
}

// The fields a derived row copies verbatim out of its source message. Everything else on it (the
// title, the fact, who asked, the due date) is the team's.
const QUOTE_FIELDS = ['quote', 'accepted_quote', 'evidence_quote', 'source_quote', 'excerpt', 'snippet'];
const stripQuotes = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  let out = o;
  for (const k of QUOTE_FIELDS) if (out[k] != null) { if (out === o) out = { ...o }; out[k] = null; }
  return out;
};

/**
 * A derived row as a viewer who may not read its source sees it: the fact, without the words it
 * was lifted from. Quotes live on the row, its value, its metadata and its value's metadata.
 */
export function redactDerivedText(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...stripQuotes(row), quote_private: true };
  if (row.metadata && typeof row.metadata === 'object') out.metadata = stripQuotes(row.metadata);
  if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
    const v = stripQuotes(row.value);
    out.value = v.metadata && typeof v.metadata === 'object' ? { ...v, metadata: stripQuotes(v.metadata) } : v;
  }
  return out;
}

/**
 * Every derived row, with its quotes removed where this viewer may not read the message it came
 * from (GET-985). Rows that aren't derived (a claim like `name`, a document with doc_type) pass
 * through untouched; pass `isDerived` to change which rows are judged. The array keeps its order
 * and length: facts are shared, only their wording is private.
 */
export async function filterDerivedForViewer(supabase, workspaceId, rows, viewer, { isDerived } = {}) {
  if (!viewer || !viewer.userId || !rows?.length) return rows || [];
  const judged = isDerived ?? ((r) => (r.property ? isDerivedProperty(r.property) : true) && !(r.metadata?.doc_type ?? r.value?.metadata?.doc_type));
  const targets = rows.filter(judged);
  if (!targets.length) return rows;
  const sources = await loadDerivedSources(supabase, workspaceId, targets);
  const wordingHidden = new Set(targets.filter((r) => !canReadDerived(r, sources, viewer)));
  return wordingHidden.size ? rows.map((r) => (wordingHidden.has(r) ? redactDerivedText(r) : r)) : rows;
}

/** The viewer derived rows are judged for, from a ReadContext: team-only, a member, or system. */
export function derivedViewerForContext(supabase, ctx) {
  if (ctx?.teamOnly) return Promise.resolve(TEAM_VIEWER);
  return messageViewerForContext(supabase, ctx);
}

/**
 * Rows that cite a claim by id (a graph edge's `source_memory_id`, a concept's `claim_ids`): keep
 * those whose cited claims this viewer may see. Since facts are the team's (GET-985) that is every
 * claim that still exists; a failed lookup still fails closed. `claimIdsOf` returns the ids a row cites.
 */
export async function filterByCitedClaimsForViewer(supabase, workspaceId, rows, viewer, claimIdsOf) {
  if (!viewer || !viewer.userId || !rows?.length) return rows || [];
  const ids = [...new Set(rows.flatMap((r) => (claimIdsOf(r) || []).filter((x) => typeof x === 'string' && UUID_RE.test(x))))];
  if (!ids.length) return rows;
  const claims = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('claims').select('id, property, value, supporting_observation_ids')
      .eq('workspace_id', workspaceId).in('id', ids.slice(i, i + 200));
    if (error) return rows.filter((r) => !(claimIdsOf(r) || []).length);   // fail closed
    claims.push(...(data || []));
  }
  const visible = new Set((await filterDerivedForViewer(supabase, workspaceId, claims, viewer)).map((c) => c.id));
  const known = new Set(claims.map((c) => c.id));
  return rows.filter((r) => {
    const cited = (claimIdsOf(r) || []).filter((x) => typeof x === 'string' && UUID_RE.test(x));
    // A claim that no longer exists cites nothing private any more.
    return !cited.length || cited.some((id) => visible.has(id) || !known.has(id));
  });
}

/**
 * Who a derived row is for, as a comparable key: 'team' when no private message backs it, else the
 * members whose mailboxes hold its source messages. Two facts merge (one supersedes or swallows the
 * other) only when their keys match — otherwise a fact from a private email could retire the team's
 * copy, or a shared fact could stand in for a private one and leak its wording (GET-253).
 */
export function derivedAudienceKey(row, sources) {
  const { ids, messageHint } = derivedSources(row);
  const holders = new Set();
  const addresses = new Set();
  let sawMessage = false;
  for (const id of ids) {
    const msg = sources?.messages?.get(id);
    if (!msg) { if (sources?.found?.has(id)) return 'team'; continue; }
    sawMessage = true;
    if (msg.owner_user_id == null) return 'team';
    holders.add(msg.owner_user_id);
    for (const h of Array.isArray(msg.raw?.mailbox_owner_ids) ? msg.raw.mailbox_owner_ids : []) holders.add(h);
    for (const a of messageParticipants(msg.raw)) addresses.add(a);
  }
  if (!sawMessage) return messageHint && ids.length ? 'unknown' : 'team';
  return `msg:${[...holders].sort().join(',')}|${[...addresses].sort().join(',')}`;
}
