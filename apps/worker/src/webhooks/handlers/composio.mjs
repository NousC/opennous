// Composio trigger webhook — the ingestion side of the Composio integration layer.
//
// Composio delivers ALL triggers to one project-level webhook (svix-signed), so unlike the
// per-workspace handlers this route carries no workspaceId in its path — we resolve the
// workspace + owning member from the connected-account id in the payload, via the
// workflow_provider_connections row we wrote at connect time.
//
// Gmail funnels into the same logActivity() the native Gmail poller used, so
// downstream (observations → claims, scoring, CRM push, triggers) is identical — this handler
// only replaces "where the touch comes from". Ownership is DIRECT: the connection row's
// owner_user_id IS the Composio entity, so there is no email-matching hop.
//
// NOTE: Composio's exact trigger payload keys vary by toolkit/version. The extractors below
// try the common aliases and log the raw payload when a required field is missing, so the
// first dogfood events tell us precisely which keys to lock in.

import crypto from 'crypto';
import { getSupabaseClient, attributeRelationship, getInternalEntityIds, getInternalIdentities, confirmByAction, hashBody, splitMessage, emitEvent } from '@nous/core';
import { fetchSentBody, hasOpenProposalFor, fetchMessageHeaders } from './gmailBody.mjs';
import { emailExternalId, isBulkEmail, isReply, participantsOf } from '../../utils/emailIdentity.mjs';
import { logActivity } from '../../utils/activity.mjs';
import { decrypt } from '../../utils/encryption.mjs';
import { nudgeCalendarSync } from '../../services/calendarSync.mjs';

/** svix-style verification: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`. */
function verifyComposioSignature(req, secret) {
  const id = req.headers['webhook-id'];
  const ts = req.headers['webhook-timestamp'];
  const sigHeader = req.headers['webhook-signature'];
  if (!id || !ts || !sigHeader) return false;

  const body = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const signedContent = `${id}.${ts}.${body}`;
  // Secret is either svix-style ('whsec_<base64>') or a plain string.
  const keyBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');
  const expected = crypto.createHmac('sha256', keyBytes).update(signedContent).digest('base64');

  // Header is space-separated `v1,<sig>` pairs.
  return String(sigHeader).split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
    catch { return false; }
  });
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v != null && v !== '') return v;
  }
  return null;
}

function firstEmail(v) {
  if (!v) return null;
  const s = Array.isArray(v) ? v[0] : v;
  const m = String(s).match(/[^\s<>"]+@[^\s<>"]+/);
  return m ? m[0].toLowerCase() : null;
}

function allEmails(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => firstEmail(s)).filter(Boolean);
}

// Per-tool dispatch. Every Composio trigger slug is toolkit-prefixed (GMAIL_…), so the prefix
// picks the ingest function. Adding a Composio tool later = one entry here plus its ingest
// function. (ingest fns are exported for the backfill service.) Google Calendar is not here on
// purpose — its triggers nudge a calendar scan instead (services/calendarSync.mjs).
const INGEST = {
  GMAIL: ingestGmail,
};

// This workspace's Composio webhook secret (self-serve config, decrypted); env as the
// single-tenant fallback.
async function workspaceWebhookSecret(supabase, workspaceId) {
  try {
    const { data } = await supabase
      .from('workspace_composio_config').select('webhook_secret').eq('workspace_id', workspaceId).maybeSingle();
    if (data?.webhook_secret) return decrypt(data.webhook_secret);
  } catch { /* table absent (pre-migration) → env */ }
  return process.env.COMPOSIO_WEBHOOK_SECRET || null;
}

export async function handleComposio(req, res) {
  const body = req.body || {};
  // Composio's V3 envelope (the default for new webhook subscriptions — @composio/core
  // WebhookTriggerPayloadV3Schema) is { id, timestamp, type: 'composio.trigger.message',
  // metadata: { trigger_slug, connected_account_id, … }, data }. `type` is the EVENT type
  // there, not the trigger, so the slug must come from metadata first. The older keys stay
  // as fallbacks. Until GET-221 this read only the old keys, and every delivery since the
  // cutover was dropped as 'no_connection_id' — logged as a warning, answered with a 200.
  const triggerSlug = String(pick(
    body,
    'metadata.trigger_slug', 'metadata.triggerSlug', 'triggerSlug', 'trigger_slug', 'triggerName', 'type',
  ) || '').toUpperCase();
  const connectedAccountId = pick(
    body,
    'metadata.connected_account_id', 'metadata.connectedAccount.id', 'metadata.connectedAccount.uuid',
    'metadata.connectedAccountId', 'connectedAccountId', 'connection_id', 'data.connection_id', 'data.connectedAccountId',
  );
  const data = body.data || body.payload || {};

  if (!connectedAccountId) {
    console.error('[WEBHOOK/composio] no connected-account id in payload — event DROPPED; keys:', Object.keys(body), 'metadata keys:', Object.keys(body.metadata || {}));
    return res.json({ ok: true, skipped: 'no_connection_id' });
  }

  const supabase = getSupabaseClient();
  // Resolve the connection FIRST (read-only, safe on unverified input) so we know which
  // workspace — and therefore which webhook secret — to verify against. A forged
  // connectedAccountId can't produce a valid signature, so this ordering leaks nothing.
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, composio_connection_id, workflow_providers!inner(name)')
    .eq('composio_connection_id', connectedAccountId)
    .maybeSingle();

  if (!conn) {
    // A Composio account no row holds — typically one a reconnect replaced (GET-234). The
    // delivery cannot be filed, but it must not vanish into a log line a deploy erases: keep
    // it in webhook_inbox as 'unmatched' (the retry worker only reads 'pending'), so
    // scripts/reconcile-composio-triggers.mjs and a human can see which accounts still send.
    console.error('[WEBHOOK/composio] unknown connection — event NOT filed', connectedAccountId, triggerSlug);
    await supabase.from('webhook_inbox').insert({
      workspace_id: null, source: 'composio', payload: { metadata: body.metadata ?? null, type: body.type ?? null },
      status: 'unmatched', attempts: 1, last_error: `unknown_connection ${connectedAccountId} ${triggerSlug}`.trim(),
    }).then(null, () => {});
    return res.json({ ok: true, skipped: 'unknown_connection' });
  }

  // Verify with THIS workspace's secret. If a secret is configured and the signature doesn't
  // match, reject.
  const secret = await workspaceWebhookSecret(supabase, conn.workspace_id);
  if (secret && !verifyComposioSignature(req, secret)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // A calendar trigger is a nudge, never a parsed event: see services/calendarSync.mjs. The
  // scan reads the canonical Google event, so a change in this payload cannot drop a meeting.
  if (conn.workflow_providers?.name === 'google_calendar' || triggerSlug.startsWith('GOOGLECALENDAR')) {
    nudgeCalendarSync(supabase, conn);
    return res.json({ ok: true, queued: 'calendar_scan' });
  }

  const toolkit = triggerSlug.split('_')[0];   // GMAIL
  const ingest = INGEST[toolkit];
  if (!ingest) {
    console.error('[WEBHOOK/composio] no ingest for toolkit — event DROPPED', toolkit, 'slug', triggerSlug);
    return res.json({ ok: true, skipped: 'unhandled_toolkit' });
  }

  try {
    const logged = await ingest(supabase, conn, data, { triggerSlug });
    // The delivery arrived and was read — the heartbeat a silent connection is measured by.
    await supabase.from('workflow_provider_connections')
      .update({ last_used_at: new Date().toISOString() }).eq('id', conn.id).then(null, () => {});
    return res.json({ ok: true, logged });
  } catch (err) {
    console.error('[WEBHOOK/composio] ingest failed', toolkit, err?.message || err);
    return res.status(500).json({ error: 'ingest_failed' });
  }
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

// People reachable at any of these addresses. Matched on EVERY active email identifier, not
// the `contacts.email` column — that column is one address per person (the oldest active
// one), so a second address on a record (a personal Gmail next to a work email) never
// matched a single message. `email` on the result is the address that matched.
async function contactsByAnyEmail(supabase, workspaceId, emails) {
  const list = [...new Set(emails.map(e => String(e).toLowerCase().trim()).filter(Boolean))];
  if (!list.length) return [];
  const { data: ids } = await supabase.from('entity_identifiers')
    .select('entity_id, value')
    .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active')
    .in('value', list);
  const emailByEntity = new Map();
  for (const r of ids || []) if (!emailByEntity.has(r.entity_id)) emailByEntity.set(r.entity_id, r.value);
  if (!emailByEntity.size) return [];
  const { data: contacts } = await supabase.from('contacts')
    .select('id, company_id')
    .eq('workspace_id', workspaceId)
    .in('id', [...emailByEntity.keys()]);
  return (contacts || []).map(c => ({ ...c, email: emailByEntity.get(c.id) }));
}
// Match existing contacts only (Gmail never bootstraps new contacts — same rule as the
// native poller). Attribution owner is the mailbox member (conn.owner_user_id) directly.
export async function ingestGmail(supabase, conn, data, { triggerSlug = '' } = {}) {
  const workspaceId = conn.workspace_id;
  const ownerUserId = conn.owner_user_id || null;
  const mailbox = (conn.account_email || '').toLowerCase();

  const messageId = pick(data, 'id', 'messageId', 'message_id');
  const subject   = pick(data, 'subject', 'payload.subject') || '(no subject)';
  const fromAddr  = firstEmail(pick(data, 'sender', 'from', 'fromEmail', 'payload.from'));
  const toAddrs   = allEmails(pick(data, 'to', 'recipients', 'toEmail', 'payload.to'));
  const ts        = pick(data, 'messageTimestamp', 'message_timestamp', 'internalDate', 'date', 'createdTime');
  // Gmail hands over HTML for most real email. Store and read text: the preview, the agent, the
  // reply classifier and extraction all used to see `<div dir="ltr">…` and `&#39;` (GET-249).
  const bodyRaw   = pick(data, 'messageText', 'message_text', 'body_text', 'text', 'snippet', 'preview') || null;
  // THIS message only — the thread quoted beneath it belongs to the rows of those emails (GET-277).
  const split = bodyRaw ? splitMessage(bodyRaw) : { written: '', full: '', quotedChars: 0 };
  const previewText = split.written || null;
  const bodyText = previewText;

  if (!messageId || !fromAddr) {
    console.warn('[composio/gmail] missing id/from — raw keys:', Object.keys(data), 'slug:', triggerSlug);
    return 0;
  }

  const occurredAt = ts ? new Date(isNaN(Number(ts)) ? ts : Number(ts)).toISOString() : new Date().toISOString();
  // Direction is relative to the TEAM, not to this mailbox (GET-244). An email one founder sends to a
  // prospect with the other on cc is the team writing to the prospect in BOTH mailboxes; reading it
  // from the second founder's inbox as "received from" the first filed it on the sender's own record instead of the
  // prospect's. Gmail's SENT label marks this mailbox's own sends; a teammate's address marks the rest.
  const labels = [].concat(pick(data, 'labelIds', 'label_ids') || []).map(String);
  const sentHere = triggerSlug.includes('SENT') || labels.includes('SENT') || Boolean(mailbox && fromAddr === mailbox);
  const internalEmails = await internalEmailSet(supabase, workspaceId, mailbox);
  const sentByTeam = sentHere || internalEmails.has(fromAddr);

  // The list call returns `to` but never `cc`, so a team send needs its headers before we know
  // who it went to. Everything else fetches them only once it has matched someone.
  let h = sentByTeam ? await fetchMessageHeaders(supabase, workspaceId, conn, messageId) : null;
  const listCc = allEmails(pick(data, 'cc', 'payload.cc'));
  const toList = h?.to?.length ? h.to : toAddrs;
  const ccList = h ? h.cc : listCc;
  const counterparts = [...new Set((sentByTeam ? [...toList, ...ccList] : [fromAddr])
    .filter((e) => e && !internalEmails.has(e)))];
  // Nobody outside the team on it (a teammate writing to a teammate): nothing to file.
  if (!counterparts.length) return 0;

  const contacts = await contactsByAnyEmail(supabase, workspaceId, counterparts);
  if (!contacts.length) return 0;

  if (!h) h = await fetchMessageHeaders(supabase, workspaceId, conn, messageId);
  const participants = participantsOf(h, { from: fromAddr, to: toAddrs, cc: listCc });
  const rfcMessageId = h?.rfcMessageId ?? null;
  const bulk = isBulkEmail(h, fromAddr);

  const internalIds = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set());
  // The preview is what was newly written, not the thread quoted underneath it.
  const snippet = previewText ? String(previewText).slice(0, 300) : null;
  const threadId = pick(data, 'threadId', 'thread_id') || null;
  // What the reply classifier, action items and fact extraction read (GET-256): the whole newly
  // written message. They used to get only the 300-character preview above — activityText reads
  // `raw.text`, and nothing set it — so an email's facts came from its first two sentences.
  const writtenText = previewText ? String(previewText).slice(0, 20_000) : null;
  let logged = 0;

  // Close the decision loop for the flow people actually use: the agent drafts, the human
  // sends it themselves from Gmail. No hook can witness that — the send happens outside the
  // agent session entirely — so this ingest IS the confirmation lane, and without it every
  // hand-sent recommendation matures to 'unconfirmed' and reads as advice that was ignored.
  //
  // Only from the SENDER's mailbox: a cc'd teammate's copy of the same send must not confirm it
  // a second time. The body hash is sent ONLY when we have the real body — a hashed snippet
  // would differ from the draft every time and label the entire corpus 'edited'.
  if (sentHere) {
    let fullBody = pick(data, 'messageText', 'message_text', 'body_text', 'text');
    if (!fullBody && (await hasOpenProposalFor(supabase, workspaceId, counterparts).catch(() => false))) {
      fullBody = await fetchSentBody(supabase, workspaceId, conn, messageId);
    }
    for (const to of counterparts) {
      try {
        await confirmByAction(supabase, workspaceId, {
          recipient: to,
          provider: 'gmail',
          provider_message_id: messageId,
          sent_at: occurredAt,
          sent_hash: fullBody ? hashBody(String(fullBody)) : null,
          action_type: 'email_send',
          confirmed_via: 'webhook',
          stage: 'sent',
        });
      } catch (e) {
        // Never let loop bookkeeping cost us an ingested activity.
        console.warn('[composio/gmail] decision confirm failed:', e.message);
      }
    }
  }

  const copy = { owner_user_id: ownerUserId, message_id: String(messageId) };
  for (const contact of contacts) {
    const internalCounterpart = internalIds.has(contact.id);
    // A reply label (and any suppression it triggers) is for a person answering our outreach —
    // never a newsletter, never a teammate, never an email that isn't a reply (GET-245).
    const replyEligible = !sentByTeam && !bulk && !internalCounterpart
      && (h ? isReply(h) : /^\s*re:/i.test(subject))
      && await hasPriorOutbound(supabase, workspaceId, contact.id, occurredAt);

    const externalId = emailExternalId({ rfcMessageId, gmailMessageId: messageId, contactId: contact.id });
    const result = await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        sentByTeam ? 'email_sent' : 'email_received',
      source:      'gmail',
      externalId,
      occurredAt,
      description: snippet || (sentByTeam ? `Email sent: ${subject}` : `Email received: ${subject}`),
      summary:     snippet,
      ownerUserId,
      // A newsletter or notification says nothing about the person; don't pay to extract it.
      // ONE READER (GET-557). Filing never calls the model: the thread reader (noema/gmailRead)
      // reads email, writes the noema.read record credits are counted from, and is the only thing
      // that does. Extracting here read the same mail unbilled — Activity said Read, billing said 0 —
      // and made a backfill pay a model call per filed message. Every other source already files
      // with extraction off (Fireflies, Fellow, Granola, Fathom, RingCentral, calendar).
      suppressExtraction: true,
      rawData: {
        message_id: messageId,
        rfc_message_id: rfcMessageId,
        subject,
        from: participants.from,
        to: participants.to,
        cc: participants.cc,
        // Who may read this email's content (GET-244): its participants, and every member whose
        // mailbox holds a copy (a bcc leaves no trace in the headers, only in the mailbox).
        participants,
        mailbox_owner_ids: ownerUserId ? [ownerUserId] : [],
        gmail_copies: [copy],
        thread_id: threadId,
        body_text: bodyText,
        text: writtenText,
        // How much quoted history sat under it. The thread is not stored twice; this says it existed.
        quoted_chars: split.quotedChars || 0,
        is_outbound: sentByTeam,
        bulk,
        reply_eligible: replyEligible,
      },
    });
    if (result) logged++;
    // conversation.reply_received (GET-559): a person answering us — the same test the reply
    // label uses, so a newsletter, a teammate or a fresh inbound never pages anybody. Only on the
    // first filing; emitEvent's age window keeps a mailbox backfill quiet.
    if (result && replyEligible) {
      await emitEvent(supabase, {
        workspaceId, type: 'conversation.reply_received',
        personId: contact.id, accountId: contact.company_id || null, occurredAt,
        dedupeKey: rfcMessageId || `${messageId}:${contact.id}`,
        data: {
          source: 'gmail', subject: subject ?? null, snippet, thread_id: threadId,
          message_id: rfcMessageId ?? String(messageId), from: participants.from ?? null,
        },
      }).catch(() => 0);
    }
    // Already filed — from this mailbox on an earlier scan, or from a teammate's copy of the same
    // email. Add this mailbox as a holder instead of filing it twice.
    else await addMailboxCopy(supabase, workspaceId, externalId, copy);

    // Attribute the relationship to the rep whose mailbox this is — unless the counterpart
    // is itself a teammate (internal-to-internal email).
    if (result && ownerUserId && !internalCounterpart) {
      try { await attributeRelationship(supabase, workspaceId, contact.id, ownerUserId, { at: occurredAt }); }
      catch (e) { console.warn('[composio/gmail] attribute failed', e.message); }
    }
  }
  return logged;
}

// Every address that is the team's own: member logins and connected mailboxes, plus this one.
async function internalEmailSet(supabase, workspaceId, mailbox) {
  const set = new Set(mailbox ? [mailbox] : []);
  try {
    for (const idy of await getInternalIdentities(supabase, workspaceId)) {
      if (idy.kind === 'email' && idy.value) set.add(String(idy.value).trim().toLowerCase());
    }
  } catch { /* the mailbox alone still separates us from them */ }
  return set;
}

// Did the team write to this person before this email? A reply label means "they answered us".
async function hasPriorOutbound(supabase, workspaceId, entityId, beforeIso) {
  const { data } = await supabase.from('observations').select('id')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .in('property', ['interaction.email_sent', 'interaction.linkedin_message_sent', 'interaction.linkedin_connection_sent', 'interaction.outbound_sent'])
    .lt('observed_at', beforeIso).limit(1);
  return Boolean(data?.length);
}

// Record that another mailbox holds a copy of an email already filed. Idempotent.
async function addMailboxCopy(supabase, workspaceId, externalId, copy) {
  if (!copy.owner_user_id) return;
  const { data: row } = await supabase.from('observations').select('id, raw')
    .eq('workspace_id', workspaceId).eq('source', 'gmail').eq('external_id', externalId).maybeSingle();
  if (!row) return;
  const raw = row.raw || {};
  const owners = new Set(Array.isArray(raw.mailbox_owner_ids) ? raw.mailbox_owner_ids : []);
  const copies = Array.isArray(raw.gmail_copies) ? raw.gmail_copies : [];
  if (owners.has(copy.owner_user_id) && copies.some(c => c.message_id === copy.message_id)) return;
  owners.add(copy.owner_user_id);
  if (!copies.some(c => c.message_id === copy.message_id)) copies.push(copy);
  await supabase.from('observations')
    .update({ raw: { ...raw, mailbox_owner_ids: [...owners], gmail_copies: copies } })
    .eq('id', row.id).then(null, () => {});
}
