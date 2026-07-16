// Push Nous activity into connected CRMs as native engagement objects.
// Called fire-and-forget from logActivity (db/activities.ts).
//
// Per-provider mapping:
//   HubSpot   → POST /crm/v3/objects/{type}        (notes / meetings / emails)
//   Pipedrive → POST /v1/activities                (type-coded: meeting / call / email / task)
//   Attio     → POST /v2/notes                     (Attio has no Activities API — Notes is idiomatic)
//
// Reliability mechanics:
//   - All fetches go through crmFetch() with a 15s timeout
//   - Automatic retry up to 3x on 429 + 5xx with exponential backoff (0.5/1/2s)
//   - Retry-After header honored when present
//   - Per-CRM Promise.allSettled — one provider failing never blocks another
//   - Failures logged to workspace_system_log so they're visible in the Mind CRM popup
//   - Identity resolution cached on contacts.{provider}_id after first successful lookup
//   - logActivity() dedupes upstream via (source, external_id) so webhook replays don't double-push

import { getSupabaseClient } from '../db/client.js';
import { decrypt } from '../utils/encryption.js';

// ─── Reliable HTTP helper (used by every adapter) ─────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function crmFetch(url: string, init: RequestInit = {}, label = 'CRM'): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (!RETRYABLE_STATUS.has(res.status)) return res;  // 2xx, 4xx (non-429) → return immediately

      // Retryable — honor Retry-After if set
      if (attempt === MAX_RETRIES) return res;  // exhausted, return last response so caller can log it
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const backoff = retryAfter ?? (500 * Math.pow(2, attempt));  // 500ms, 1s, 2s
      console.warn(`[${label}] ${res.status} — retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
    } catch (err: any) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === MAX_RETRIES) throw err;
      const isTimeout = err?.name === 'AbortError';
      const backoff = 500 * Math.pow(2, attempt);
      console.warn(`[${label}] ${isTimeout ? 'timeout' : 'network error'} — retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoff);
    }
  }
  // unreachable but TS-required
  throw lastErr || new Error('crmFetch: unreachable');
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = parseInt(header, 10);
  if (!isNaN(secs)) return Math.min(secs * 1000, 30_000);  // cap at 30s — we don't want to block a worker forever
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

export interface CrmPushEvent {
  workspaceId: string;
  contactId: string;
  activityType: string;
  activityId?: string | null;     // observation id — enables per-row push dedup
  occurredAt?: string;
  summary?: string | null;
  description?: string | null;
  rawData?: Record<string, unknown> | null;
}

// High-signal only. Easy to widen later via per-workspace config in crm_sync_configs.
const PUSHABLE_TYPES = new Set([
  'email_reply',
  'email_received',   // inbound reply (what the email-tool webhooks actually log)
  'linkedin_message',
  'linkedin_connected',
  'meeting_held',
  'meeting_scheduled',
  'proposal_sent',
  'proposal_viewed',
  'proposal_signed',
  'deal_won',
  'deal_created',
  'trial_started',
]);

const ID_COLUMN: Record<string, string> = {
  hubspot:   'hubspot_id',
  pipedrive: 'pipedrive_id',
  attio:     'attio_id',
  // salesforce intentionally omitted — still 'coming soon' in UI
};

interface ContactRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  pipeline_stage: string | null;
  icp_score: number | null;
  icp_fit: boolean | null;
  hubspot_id: string | null;
  pipedrive_id: string | null;
  attio_id: string | null;
  [k: string]: any;
}

// ─── Create-gate: WHEN a prospect earns a brand-new CRM record ────────────────
// A contact already in the CRM (cached id or found by search) always gets the
// activity logged. This gate only decides whether to CREATE a record that
// doesn't exist yet, so the CRM fills with earned hand-raises, not cold misses.

interface CreatePolicy {
  create_in_crm?: boolean;
  create_trigger?: string;
  create_require_icp_fit?: boolean;
  create_icp_threshold?: number;
}

const REPLY_INTENT_TYPES   = new Set(['email_received', 'email_reply', 'linkedin_message', 'linkedin_replied']);
const MEETING_INTENT_TYPES = new Set(['meeting_scheduled', 'meeting_held']);
// Sales events that earn a record on their own, regardless of the chosen trigger —
// you never want to drop a signed proposal because the trigger was "meeting only".
const STRONG_INTENT_TYPES  = new Set(['proposal_sent', 'proposal_viewed', 'proposal_signed', 'deal_won', 'deal_created', 'trial_started']);

// 'connected' ranks below 'interested' so a bare LinkedIn connection never trips
// the interested_stage CRM create-gate (outbound connections aren't CRM-worthy yet).
const GATE_STAGE_ORDER: Record<string, number> = { identified: 0, aware: 1, connected: 2, interested: 3, evaluating: 4, client: 5 };

function evaluateCreateGate(policy: CreatePolicy, evt: CrmPushEvent, contact: ContactRow): { allow: boolean; reason: string } {
  if (policy.create_in_crm === false) return { allow: false, reason: 'record creation is off for this CRM' };

  const type = evt.activityType;
  const trigger = policy.create_trigger || 'positive_reply_or_meeting';
  const sentiment = (evt.rawData as { sentiment?: string } | null | undefined)?.sentiment;

  let intentOk: boolean;
  if (STRONG_INTENT_TYPES.has(type)) {
    intentOk = true;
  } else if (trigger === 'meeting_only') {
    intentOk = MEETING_INTENT_TYPES.has(type);
  } else if (trigger === 'interested_stage') {
    intentOk = (GATE_STAGE_ORDER[contact.pipeline_stage || 'identified'] ?? 0) >= GATE_STAGE_ORDER.interested;
  } else if (trigger === 'any_reply_or_meeting') {
    intentOk = REPLY_INTENT_TYPES.has(type) || MEETING_INTENT_TYPES.has(type);
  } else { // positive_reply_or_meeting (default)
    intentOk = MEETING_INTENT_TYPES.has(type) || (REPLY_INTENT_TYPES.has(type) && sentiment === 'positive');
  }

  if (!intentOk) {
    const reason = REPLY_INTENT_TYPES.has(type) && trigger === 'positive_reply_or_meeting'
      ? `reply not positive (${sentiment || 'unclassified'})`
      : `${activityTitle(evt)} does not meet trigger '${trigger}'`;
    return { allow: false, reason };
  }

  if (policy.create_require_icp_fit) {
    const threshold = policy.create_icp_threshold ?? 70;
    const score = typeof contact.icp_score === 'number' ? contact.icp_score : null;
    if (score == null)        return { allow: false, reason: `ICP not scored yet (need ≥ ${threshold})` };
    if (score < threshold)    return { allow: false, reason: `ICP fit ${score} < ${threshold}` };
  }

  return { allow: true, reason: 'ok' };
}

export async function pushActivityToAllCrms(evt: CrmPushEvent): Promise<void> {
  if (!PUSHABLE_TYPES.has(evt.activityType)) return;
  const supabase = getSupabaseClient();

  const { data: configs } = await supabase
    .from('crm_sync_configs')
    .select('provider, connection_id, push_activities, create_in_crm, create_trigger, create_require_icp_fit, create_icp_threshold')
    .eq('workspace_id', evt.workspaceId);

  const enabled = (configs || []).filter((c: any) =>
    c.push_activities && ID_COLUMN[c.provider] && c.connection_id
  );
  if (!enabled.length) return;

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, email, first_name, last_name, company, pipeline_stage, icp_score, icp_fit, hubspot_id, pipedrive_id, attio_id, salesforce_id')
    .eq('id', evt.contactId)
    .single();
  if (!contact?.email) return;

  // Read existing per-provider engagement IDs so a retry doesn't double-post.
  // Phase 2: keyed by observation id in the v2 substrate (was contact_activity_log).
  let alreadyPushed: Record<string, string> = {};
  if (evt.activityId) {
    const { data: rows } = await supabase
      .from('observation_crm_pushes')
      .select('provider, engagement_id')
      .eq('observation_id', evt.activityId);
    for (const r of (rows as { provider: string; engagement_id: string }[]) || []) {
      alreadyPushed[r.provider] = r.engagement_id;
    }
  }

  await Promise.allSettled(enabled.map((cfg: any) =>
    pushOne(cfg, contact as ContactRow, evt, alreadyPushed[cfg.provider]).catch(err =>
      console.error(`[CRM_PUSH ${cfg.provider}]`, err?.message || err)
    )
  ));
}

async function pushOne(
  cfg: { provider: string; connection_id: string } & CreatePolicy,
  contact: ContactRow,
  evt: CrmPushEvent,
  alreadyPushedEngagementId?: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const provider = cfg.provider;
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  // Idempotency: already pushed this activity to this CRM in a prior run
  if (alreadyPushedEngagementId) {
    console.log(`[CRM_PUSH ${provider}] skip — already pushed activity ${evt.activityId} → ${alreadyPushedEngagementId}`);
    return;
  }

  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials')
    .eq('id', cfg.connection_id)
    .single();
  if (!conn) return;

  const creds: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(conn.encrypted_credentials || {})) {
    creds[k] = decrypt(v as string);
  }

  // Resolve the CRM record in three steps so the create-gate only governs NEW
  // records: (1) use the cached id, (2) search the CRM for an existing match —
  // always logged onto, no gate — (3) if still none, apply the create-gate.
  const cachedId = contact[ID_COLUMN[provider]] as string | null;
  let crmId: string | null = cachedId;

  if (!crmId) {
    try {
      crmId = await findCrmContact(provider, creds, contact);
    } catch (err: any) {
      await logCrmOp(supabase, evt, provider, 'identity_failed',
        `${providerLabel}: lookup failed for ${contact.email} — ${err?.message || err}`);
      return;
    }
  }

  let justCreated = false;
  if (!crmId) {
    const gate = evaluateCreateGate(cfg, evt, contact);
    if (!gate.allow) {
      await logCrmOp(supabase, evt, provider, 'creation_skipped',
        `${providerLabel}: did not create ${contact.email} — ${gate.reason}`, { reason: gate.reason });
      return;
    }
    try {
      crmId = await createCrmContact(provider, creds, contact);
    } catch (err: any) {
      await logCrmOp(supabase, evt, provider, 'identity_failed',
        `${providerLabel}: create failed for ${contact.email} — ${err?.message || err}`);
      return;
    }
    justCreated = true;
  }

  if (!crmId) {
    await logCrmOp(supabase, evt, provider, 'identity_failed',
      `${providerLabel}: no contact match for ${contact.email}`);
    return;
  }

  if (!cachedId) {
    await supabase.from('contacts').update({ [ID_COLUMN[provider]]: crmId }).eq('id', contact.id);
    await logCrmOp(supabase, evt, provider, justCreated ? 'contact_created_in_crm' : 'contact_resolved',
      `${providerLabel}: ${justCreated ? 'created' : 'linked'} ${contact.email} → ${crmId}`, { crm_id: crmId });
  }

  try {
    let engagementId: string | null = null;
    if (provider === 'hubspot')   engagementId = await pushHubSpotEngagement(creds, crmId, evt);
    if (provider === 'pipedrive') engagementId = await pushPipedriveActivity(creds, crmId, evt);
    if (provider === 'attio')     engagementId = await pushAttioNote(creds, crmId, evt);

    // Idempotency: record what we pushed so a retry sees it and skips
    if (evt.activityId && engagementId) {
      await markActivityPushed(supabase, evt.workspaceId, evt.activityId, provider, engagementId);
    }

    await logCrmOp(supabase, evt, provider, 'activity_pushed',
      `Pushed ${activityTitle(evt)} → ${providerLabel} (${contact.email})`,
      { crm_id: crmId, engagement_id: engagementId });
  } catch (err: any) {
    await logCrmOp(supabase, evt, provider, 'activity_push_failed',
      `${providerLabel} push failed for ${activityTitle(evt)} → ${contact.email} · ${err?.message || err}`,
      { crm_id: crmId, error: String(err?.message || err) });
    throw err;
  }
}

// Record one (observation, provider, engagement) push. PK (observation_id, provider)
// makes this naturally idempotent under concurrency.
async function markActivityPushed(
  supabase: any,
  workspaceId: string,
  observationId: string,
  provider: string,
  engagementId: string,
): Promise<void> {
  try {
    await supabase.from('observation_crm_pushes').upsert(
      { workspace_id: workspaceId, observation_id: observationId, provider, engagement_id: engagementId },
      { onConflict: 'observation_id,provider', ignoreDuplicates: false },
    );
  } catch (err: any) {
    console.warn('[CRM_PUSH] dedup write failed:', err?.message || err);
  }
}

// Best-effort write to workspace_system_log. Failures here never bubble up — the activity
// already succeeded; missing telemetry shouldn't break the user-facing flow.
async function logCrmOp(
  supabase: any, evt: CrmPushEvent, provider: string, eventType: string,
  summary: string, metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: evt.workspaceId,
      source: provider,
      event_type: eventType,
      summary,
      contact_id: evt.contactId,
      metadata: { activity_type: evt.activityType, ...metadata },
    });
  } catch (err: any) {
    console.warn('[CRM_PUSH] system_log write failed:', err?.message || err);
  }
}

// ─── Identity resolution ──────────────────────────────────────────────────────

// Find an existing CRM record by email. Search only — never creates. Returns
// the CRM id, or null if there's no match (the create-gate decides what next).
async function findCrmContact(provider: string, creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  if (provider === 'hubspot')   return findHubSpot(creds, contact);
  if (provider === 'pipedrive') return findPipedrive(creds, contact);
  if (provider === 'attio')     return findAttio(creds, contact);
  return null;
}

// Create a new CRM record. Only called once the create-gate has allowed it.
async function createCrmContact(provider: string, creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  if (provider === 'hubspot')   return createHubSpot(creds, contact);
  if (provider === 'pipedrive') return createPipedrive(creds, contact);
  if (provider === 'attio')     return createAttio(creds, contact);
  return null;
}

async function findHubSpot(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.access_token || creds.api_key;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sr = await crmFetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST', headers,
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contact.email }] }],
      properties: ['email'], limit: 1,
    }),
  }, 'HubSpot search');
  if (sr.ok) {
    const d: any = await sr.json();
    if (d.results?.[0]?.id) return d.results[0].id;
  }
  return null;
}

async function createHubSpot(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.access_token || creds.api_key;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const cr = await crmFetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST', headers,
    body: JSON.stringify({ properties: {
      email:     contact.email,
      firstname: contact.first_name || '',
      lastname:  contact.last_name  || '',
      company:   contact.company    || '',
    }}),
  }, 'HubSpot create');
  if (cr.ok) { const d: any = await cr.json(); return d.id || null; }
  // 409 = email already exists (race condition) — fall back to a search
  if (cr.status === 409) return findHubSpot(creds, contact);
  return null;
}

async function findPipedrive(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.api_token || creds.api_key;
  if (!token) return null;
  const sr = await crmFetch(
    `https://api.pipedrive.com/v1/persons/search?term=${encodeURIComponent(contact.email)}&fields=email&exact_match=true&api_token=${encodeURIComponent(token)}`,
    {}, 'Pipedrive search',
  );
  if (sr.ok) {
    const d: any = await sr.json();
    const hit = d.data?.items?.[0]?.item;
    if (hit?.id) return String(hit.id);
  }
  return null;
}

async function createPipedrive(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.api_token || creds.api_key;
  if (!token) return null;
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;
  const cr = await crmFetch(`https://api.pipedrive.com/v1/persons?api_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email: [contact.email] }),
  }, 'Pipedrive create');
  if (cr.ok) { const d: any = await cr.json(); return d.data?.id ? String(d.data.id) : null; }
  return null;
}

async function findAttio(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.api_key || creds.access_token;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sr = await crmFetch('https://api.attio.com/v2/objects/people/records/query', {
    method: 'POST', headers,
    body: JSON.stringify({ filter: { email_addresses: contact.email }, limit: 1 }),
  }, 'Attio search');
  if (sr.ok) {
    const d: any = await sr.json();
    const id = d.data?.[0]?.id?.record_id;
    if (id) return id;
  }
  return null;
}

async function createAttio(creds: Record<string, string | null>, contact: ContactRow): Promise<string | null> {
  const token = creds.api_key || creds.access_token;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const first = contact.first_name || '';
  const last = contact.last_name || '';
  const full = [first, last].filter(Boolean).join(' ') || contact.email;

  // PUT with matching_attribute is an upsert — safe against a race where the
  // record appeared between our find() and now.
  const cr = await crmFetch('https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses', {
    method: 'PUT', headers,
    body: JSON.stringify({ data: { values: {
      email_addresses: [contact.email],
      // Attio's name attribute requires `full_name` as a string in addition to first/last
      name: [{ first_name: first, last_name: last, full_name: full }],
    }}}),
  }, 'Attio assert');
  if (cr.ok) { const d: any = await cr.json(); return d.data?.id?.record_id || null; }
  const errText = await cr.text().catch(() => '');
  throw new Error(`Attio create ${cr.status}: ${errText.slice(0, 200)}`);
}

// ─── Push adapters ────────────────────────────────────────────────────────────

const HUBSPOT_ASSOC: Record<string, number> = { notes: 202, meetings: 200, emails: 198, calls: 194, tasks: 204 };

function hubspotObjectType(t: string): string {
  if (t === 'meeting_held' || t === 'meeting_scheduled') return 'meetings';
  if (t === 'email_reply') return 'emails';
  return 'notes';
}

function hubspotProperties(evt: CrmPushEvent): Record<string, any> {
  const ts = new Date(evt.occurredAt || Date.now()).getTime();
  const ob = hubspotObjectType(evt.activityType);
  const body = activityTitle(evt) + (evt.summary ? `\n\n${evt.summary}` : '');
  if (ob === 'meetings') return { hs_meeting_title: activityTitle(evt), hs_meeting_body: evt.summary || '', hs_timestamp: ts, hs_meeting_outcome: 'COMPLETED' };
  if (ob === 'emails')   return { hs_email_subject: activityTitle(evt), hs_email_text: evt.summary || '', hs_email_direction: 'INCOMING_EMAIL', hs_timestamp: ts };
  return { hs_note_body: body, hs_timestamp: ts };
}

async function pushHubSpotEngagement(creds: Record<string, string | null>, crmId: string, evt: CrmPushEvent): Promise<string | null> {
  const token = creds.access_token || creds.api_key;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const ob = hubspotObjectType(evt.activityType);
  const cr = await crmFetch(`https://api.hubapi.com/crm/v3/objects/${ob}`, {
    method: 'POST', headers,
    body: JSON.stringify({
      properties: hubspotProperties(evt),
      associations: [{ to: { id: crmId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: HUBSPOT_ASSOC[ob] }] }],
    }),
  }, `HubSpot push ${ob}`);
  if (!cr.ok) {
    const t = await cr.text().catch(() => '');
    throw new Error(`HubSpot ${cr.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await cr.json().catch(() => null);
  return d?.id || null;
}

function pipedriveType(t: string): string {
  if (t.startsWith('meeting')) return 'meeting';
  if (t === 'email_reply')     return 'email';
  return 'task';
}

async function pushPipedriveActivity(creds: Record<string, string | null>, crmId: string, evt: CrmPushEvent): Promise<string | null> {
  const token = creds.api_token || creds.api_key;
  const cr = await crmFetch(`https://api.pipedrive.com/v1/activities?api_token=${encodeURIComponent(token!)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject:   activityTitle(evt),
      type:      pipedriveType(evt.activityType),
      done:      1,
      note:      evt.summary || evt.description || '',
      person_id: Number(crmId),
      due_date:  (evt.occurredAt || new Date().toISOString()).slice(0, 10),
    }),
  }, 'Pipedrive push activity');
  if (!cr.ok) {
    const t = await cr.text().catch(() => '');
    throw new Error(`Pipedrive ${cr.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await cr.json().catch(() => null);
  return d?.data?.id ? String(d.data.id) : null;
}

async function pushAttioNote(creds: Record<string, string | null>, crmId: string, evt: CrmPushEvent): Promise<string | null> {
  const token = creds.api_key || creds.access_token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const lines: string[] = [];
  if (evt.summary)     lines.push(evt.summary);
  if (evt.description) lines.push(`_${evt.description}_`);
  lines.push('');
  lines.push(`— Logged by Nous on ${new Date(evt.occurredAt || Date.now()).toLocaleString()}`);

  // Attio requires a valid RFC-3339 created_at and rejects future dates, so
  // normalize occurredAt through Date and clamp to now (a "meeting scheduled"
  // event can carry the meeting's future time).
  const createdAt = new Date(Math.min(Date.parse(evt.occurredAt || '') || Date.now(), Date.now())).toISOString();

  const cr = await crmFetch('https://api.attio.com/v2/notes', {
    method: 'POST', headers,
    body: JSON.stringify({ data: {
      parent_object:    'people',
      parent_record_id: crmId,
      title:            `[Nous] ${activityTitle(evt)}`,
      format:           'markdown',
      content:          lines.join('\n'),
      created_at:       createdAt,
    }}),
  }, 'Attio push note');
  if (!cr.ok) {
    const t = await cr.text().catch(() => '');
    throw new Error(`Attio ${cr.status}: ${t.slice(0, 200)}`);
  }
  const d: any = await cr.json().catch(() => null);
  return d?.data?.id?.note_id || null;
}

function activityTitle(evt: CrmPushEvent): string {
  const map: Record<string, string> = {
    email_reply:        'Email reply',
    email_received:     'Email reply',
    linkedin_message:   'LinkedIn message',
    linkedin_connected: 'LinkedIn connection accepted',
    meeting_held:       'Meeting held',
    meeting_scheduled:  'Meeting scheduled',
    proposal_sent:      'Proposal sent',
    proposal_viewed:    'Proposal viewed',
    proposal_signed:    'Proposal signed',
    deal_won:           'Deal won',
    deal_created:       'Deal created',
    trial_started:      'Trial started',
  };
  return map[evt.activityType] || evt.activityType;
}
