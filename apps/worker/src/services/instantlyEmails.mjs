// Backfill the REAL body of Instantly emails onto their observations.
//
// Instantly's `email_sent` / `reply_received` webhooks carry only metadata
// (subject, campaign, step) — never the rendered body — so an "email sent" row
// on the timeline showed just its subject line and nothing else. Instantly's v2
// `GET /api/v2/emails` DOES return the rendered per-lead body, keyed by the same
// message id we already stored in `observations.external_id` (`instantly_<id>`).
// We pull it and fill in:
//   value.summary     — the timeline preview line (first ~240 chars, plain text)
//   value.description  — the subject (drives the row title where used)
//   raw.sent_body      — the full plain-text body (read by agents / analysis)
//   raw.body_html      — the full HTML body
//
// Only SENT rows need this: their external_id is `instantly_<uuid>`, which is
// what we match on. Received rows key on `instantly_reply_<email>_<hash>` and
// already carry the reply text from the webhook, so they never match here.

import { decrypt } from '../utils/encryption.mjs';

const BASE = 'https://api.instantly.ai/api/v2';

// Instantly ue_type — the email's lifecycle stage. 1 = sent from campaign,
// 3 = sent (manual/reply), 2 = received, 4 = scheduled. 1|3 are outbound.
const OUTBOUND_UE = new Set([1, 3]);

// The webhook fires within seconds of a send, so a correct (email + time) match is
// near-instant. Anything beyond this window means the exact email wasn't in the
// fetched set and the nearest is probably a DIFFERENT send — we'd rather leave the
// row subject-only than attach the wrong body. Trust over coverage.
const MAX_MATCH_DELTA_MS = 90 * 60 * 1000; // 90 minutes

// Cheap HTML → text. Good enough for a timeline preview and for feeding the copy
// to an agent; we keep the raw HTML in raw.body_html for anything that needs it.
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Instantly rate-limits the emails endpoint hard. Serialize every call through a
// single spacer + generous 429 backoff so a full-campaign backfill doesn't trip
// it. This is a slow background job; throughput doesn't matter, completeness does.
let _lastCall = 0;
const MIN_SPACING_MS = 900;
async function httpJson(url, apiKey) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = _lastCall + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    _lastCall = Date.now();
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (r.status === 429) { await sleep(2500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`instantly ${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`instantly 429 (gave up): ${url}`);
}

// Page through GET /api/v2/emails and normalize each row. Filter by campaign
// (campaignId) OR by a single recipient (lead) — the `lead` filter is what lets
// us pull just one replier's outbound thread cheaply. Returns { items,
// next_starting_after } (defensive on shape).
export async function fetchInstantlyEmails(apiKey, { campaignId, lead, emailType = 'sent', max = 2000 }) {
  const out = [];
  let cursor = null;
  while (out.length < max) {
    const params = new URLSearchParams({ limit: '100', sort_order: 'desc' });
    if (campaignId) params.set('campaign_id', campaignId);
    if (lead) params.set('lead', lead);
    if (emailType) params.set('email_type', emailType);
    if (cursor) params.set('starting_after', cursor);
    const page = await httpJson(`${BASE}/emails?${params.toString()}`, apiKey);
    const items = page.items || page.data || (Array.isArray(page) ? page : []);
    if (!items.length) break;
    for (const e of items) {
      const html = e.body?.html || null;
      const text = e.body?.text || (html ? htmlToText(html) : null);
      out.push({
        id:        e.id || e.message_id || null,
        messageId: e.message_id || e.id || null,
        subject:   e.subject || null,
        text, html,
        lead:      String(e.lead || e.to_address_email_list || '').toLowerCase().trim() || null,
        campaignId: e.campaign_id || null,
        ueType:    e.ue_type ?? null,
        isOutbound: OUTBOUND_UE.has(e.ue_type),
        ts:        e.timestamp_email || e.timestamp_created || null,
      });
    }
    cursor = page.next_starting_after || page.cursor || items[items.length - 1]?.id || null;
    if (!cursor || items.length < 100) break;
  }
  return out;
}

// The webhook's message-id and the API's email id are DIFFERENT identifiers, so
// we can't join on external_id. Instead we match on (recipient email + nearest
// send time): every sent email to a lead is the same thread, so for each of our
// `email_sent` rows we pick the API email to that same address whose send time is
// closest, consuming each API email at most once (greedy). Returns coverage.
export async function enrichInstantlyEmailBodies(supabase, { workspaceId, apiKey, campaignIds, dryRun = false, log = console, onMatch = null }) {
  let updated = 0, matched = 0, unmatched = 0;
  for (const campaignId of campaignIds) {
    let emails;
    try {
      emails = await fetchInstantlyEmails(apiKey, { campaignId, emailType: 'sent' });
    } catch (e) {
      log.warn?.(`[INSTANTLY_EMAILS] fetch failed ws=${workspaceId} campaign=${campaignId}: ${e?.message || e}`);
      continue;
    }
    // Group outbound emails (that carry a body) by recipient, sorted by time.
    const byLead = new Map();
    for (const e of emails) {
      if (!e.isOutbound || (!e.text && !e.html) || !e.lead) continue;
      e._ms = e.ts ? Date.parse(e.ts) : NaN;
      if (!byLead.has(e.lead)) byLead.set(e.lead, []);
      byLead.get(e.lead).push(e);
    }
    for (const list of byLead.values()) list.sort((a, b) => a._ms - b._ms);
    if (!byLead.size) continue;

    // Our email_sent rows for this campaign, oldest first (match order).
    const { data: rows } = await supabase.from('observations')
      .select('id, entity_id, value, raw, observed_at')
      .eq('workspace_id', workspaceId)
      .eq('property', 'interaction.email_sent')
      .eq('raw->>campaign_id', campaignId)
      .order('observed_at', { ascending: true })
      .limit(5000);
    if (!rows?.length) continue;

    // Resolve each row's recipient email.
    const entityIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean))];
    const emailById = new Map();
    for (let i = 0; i < entityIds.length; i += 300) {
      const { data: cs } = await supabase.from('contacts')
        .select('id, email').in('id', entityIds.slice(i, i + 300));
      for (const c of cs || []) if (c.email) emailById.set(c.id, c.email.toLowerCase().trim());
    }

    for (const row of rows) {
      const lead = emailById.get(row.entity_id);
      const candidates = lead ? byLead.get(lead) : null;
      if (!candidates || !candidates.length) { unmatched++; continue; }
      // Nearest unconsumed send by time.
      const obsMs = Date.parse(row.observed_at);
      let bestIdx = -1, bestDelta = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i]._used) continue;
        const d = Math.abs((candidates[i]._ms || obsMs) - obsMs);
        if (d < bestDelta) { bestDelta = d; bestIdx = i; }
      }
      if (bestIdx < 0 || bestDelta > MAX_MATCH_DELTA_MS) { unmatched++; continue; }
      const e = candidates[bestIdx];
      e._used = true;
      matched++;

      const text = (e.text || htmlToText(e.html)).replace(/\s+/g, ' ').trim();
      const preview = text.slice(0, 240) || null;
      if (!preview) continue;
      onMatch?.({ obsId: row.id, lead, subject: e.subject, deltaMin: Math.round(bestDelta / 60000), preview });

      // Already backfilled — don't rewrite on every cron pass.
      if (row.raw?.sent_body || row.raw?.body_html) continue;
      if (dryRun) continue;

      const value = {
        ...(row.value || {}),
        description: e.subject || row.value?.description || null,
        summary:     preview,
      };
      const raw = {
        ...(row.raw || {}),
        sent_body:  e.text || htmlToText(e.html) || null,
        body_html:  e.html || null,
        subject:    e.subject ?? row.raw?.subject ?? null,
        instantly_email_id: e.id ?? null,
      };
      const { error } = await supabase.from('observations').update({ value, raw }).eq('id', row.id);
      if (error) log.warn?.(`[INSTANTLY_EMAILS] update failed obs=${row.id}: ${error.message}`);
      else updated++;
    }
  }
  if (matched || updated) {
    log.log?.(`[INSTANTLY_EMAILS] ws=${workspaceId} matched=${matched} updated=${updated} unmatched=${unmatched}`);
  }
  return { updated, matched, unmatched };
}

// Save one entity's outbound Instantly emails (already fetched + normalized) as
// email_sent observations WITH the real body. Direct insert (not logActivity) so
// we don't fire signal extraction on hundreds of outbound sends; dedup on
// external_id. Only used for people who replied — where the exact copy matters.
export async function saveSentEmailsForEntity(supabase, { workspaceId, entityId, emails, log = console }) {
  let created = 0;
  await supabase.from('entities')
    .upsert({ id: entityId, workspace_id: workspaceId, type: 'person', status: 'active' },
      { onConflict: 'id', ignoreDuplicates: true });
  // A webhook may already have logged some of these sends under a DIFFERENT id, so
  // external_id dedup can't catch them. Skip any API email sent within a few
  // minutes of an existing email_sent row for this person — same physical send.
  const { data: existing } = await supabase.from('observations')
    .select('observed_at')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .eq('property', 'interaction.email_sent');
  const existingMs = (existing || []).map(r => Date.parse(r.observed_at)).filter(Number.isFinite);
  const DUP_MS = 3 * 60 * 1000;
  for (const e of emails) {
    if (!e.isOutbound || !e.id) continue;
    const text = (e.text || htmlToText(e.html)).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const eMs = Date.parse(e.ts || '');
    if (Number.isFinite(eMs) && existingMs.some(m => Math.abs(m - eMs) < DUP_MS)) continue;
    // Keyed off the API email id (distinct namespace from webhook rows, which key
    // off the webhook message-id) so a later webhook for the same send can't
    // collide, and a re-run is idempotent.
    const externalId = `instantly_api_${e.id}`;
    const { error } = await supabase.from('observations').insert({
      workspace_id: workspaceId,
      entity_id:    entityId,
      kind:         'event',
      property:     'interaction.email_sent',
      value:        { description: e.subject || null, summary: text.slice(0, 240) },
      source:       'instantly',
      method:       'connector',
      observed_at:  e.ts || new Date().toISOString(),
      external_id:  externalId,
      raw: {
        campaign_id: e.campaignId ?? null,
        subject:     e.subject ?? null,
        is_outbound: true,
        sent_body:   text,
        body_html:   e.html || null,
        instantly_email_id: e.id,
        backfilled:  'replier_thread',
      },
    });
    if (!error) created++;
    else if (error.code !== '23505') log.warn?.(`[INSTANTLY_REPLIER] insert failed entity=${entityId}: ${error.message}`);
  }
  return created;
}

// For everyone who REPLIED, pull the exact email(s) we sent them (by lead) and
// save them — so each reply has the outbound thread it answered. Bounded to
// repliers (non-repliers are covered by the campaign copy). Skips repliers who
// already have a stored sent body, so the cron is cheap after the first pass.
export async function backfillReplierSentEmails(supabase, { workspaceId, apiKey, dryRun = false, log = console }) {
  // Repliers: entities with an inbound email in this workspace.
  const { data: recv } = await supabase.from('observations')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('property', 'interaction.email_received')
    .limit(20000);
  const replierIds = [...new Set((recv || []).map(r => r.entity_id).filter(Boolean))];
  if (!replierIds.length) return { people: 0, created: 0 };

  // Skip repliers whose full thread we've already pulled (marked
  // backfilled='replier_thread') — idempotence + don't re-hit the API for them.
  // (Per-email dedup in saveSentEmailsForEntity still guards the overlap with any
  // webhook-logged sends.)
  const covered = new Set();
  for (let i = 0; i < replierIds.length; i += 300) {
    const { data } = await supabase.from('observations')
      .select('entity_id, raw')
      .eq('workspace_id', workspaceId)
      .eq('property', 'interaction.email_sent')
      .in('entity_id', replierIds.slice(i, i + 300));
    for (const r of data || []) if (r.raw?.backfilled === 'replier_thread') covered.add(r.entity_id);
  }
  const todo = replierIds.filter(id => !covered.has(id));
  if (!todo.length) return { people: 0, created: 0, todo: 0 };
  // Dry: report how many repliers WOULD be filled without hitting the API.
  if (dryRun) {
    log.log?.(`[INSTANTLY_REPLIER] ws=${workspaceId} DRY repliers_needing_backfill=${todo.length}`);
    return { people: 0, created: 0, todo: todo.length };
  }

  // Resolve emails for the ones we still need.
  const emailById = new Map();
  for (let i = 0; i < todo.length; i += 300) {
    const { data: cs } = await supabase.from('contacts')
      .select('id, email').in('id', todo.slice(i, i + 300));
    for (const c of cs || []) if (c.email) emailById.set(c.id, c.email.toLowerCase().trim());
  }

  let created = 0, people = 0;
  for (const id of todo) {
    const email = emailById.get(id);
    if (!email) continue;
    let emails;
    try {
      emails = await fetchInstantlyEmails(apiKey, { lead: email, emailType: 'sent' });
    } catch (e) {
      log.warn?.(`[INSTANTLY_REPLIER] fetch failed lead=${email}: ${e?.message || e}`);
      continue;
    }
    if (!emails.length) continue;
    const n = await saveSentEmailsForEntity(supabase, { workspaceId, entityId: id, emails, log });
    created += n;
    if (n) people++;
  }
  if (people || created) {
    log.log?.(`[INSTANTLY_REPLIER] ws=${workspaceId} repliers_needing=${todo.length} people_filled=${people} rows_created=${created}`);
  }
  return { people, created };
}

// Decrypt a workspace's verified Instantly API key (or null).
export async function getInstantlyApiKey(supabase, workspaceId) {
  const { data } = await supabase.from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('is_verified', true);
  const conn = (data || []).find(c => c.workflow_providers?.name === 'instantly');
  if (!conn?.encrypted_credentials?.api_key) return null;
  try { return decrypt(conn.encrypted_credentials.api_key); } catch { return null; }
}

// Reply-driven: the moment someone replies, pull the exact email(s) we sent that
// lead and save the outbound thread (bodies included). Best-effort, safe to
// fire-and-forget from the webhook — dedup keeps it idempotent.
export async function saveLeadSentThread(supabase, { workspaceId, entityId, leadEmail, apiKey = null, log = console }) {
  if (!entityId || !leadEmail) return 0;
  const key = apiKey || await getInstantlyApiKey(supabase, workspaceId);
  if (!key) return 0;
  let emails;
  try {
    emails = await fetchInstantlyEmails(key, { lead: leadEmail.toLowerCase().trim(), emailType: 'sent' });
  } catch (e) {
    log.warn?.(`[INSTANTLY_REPLIER] live fetch failed lead=${leadEmail}: ${e?.message || e}`);
    return 0;
  }
  if (!emails.length) return 0;
  return saveSentEmailsForEntity(supabase, { workspaceId, entityId, emails, log });
}
