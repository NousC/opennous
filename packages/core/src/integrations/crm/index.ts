// CRM integrations — shared by the API (manual sync) and the worker
// (auto-sync cron). Each provider exposes incremental fetchers for contacts,
// companies, and deals. The orchestrator pulls all three and upserts into
// the v2 substrate via the contacts/companies views (entity + identifiers +
// state observations via INSTEAD OF triggers) and entities directly for
// deals (which don't have a v1-shape view).

import type { SupabaseClient } from '@supabase/supabase-js';
import { echoFieldsToSkip } from '../../db/crmWriteState.js';
import { accountHealthProperties, readAccountHealth, accountHealthFacts, renewalFromSubscriptions, renewalChanges, SUBSCRIPTION_TERM_PROPERTIES, customerStatusValues } from './accountHealth.js';
import type { SubscriptionTerm } from './accountHealth.js';
// Re-exported so callers outside core (the health backfill script, and any future provider) reach
// the vocabulary through @nous/core like everything else in the CRM surface.
export {
  ACCOUNT_HEALTH_FACTS, accountHealthProperties, readAccountHealth, accountHealthFacts,
  registerAccountHealthMap, accountHealthMapFor, DEFAULT_HUBSPOT_HEALTH_MAP,
  renewalFromSubscriptions, renewalChanges, SUBSCRIPTION_TERM_PROPERTIES,
} from './accountHealth.js';
export type { AccountHealthFact, SubscriptionTerm, RenewalRead } from './accountHealth.js';
import { rollupDeals, crmDealState } from '../../services/dealRollup.js';
import { advancePipelineStage } from '../../db/pipelineStage.js';
import { linkObservationToDeals } from '../../db/observationDeals.js';
import { resolveEntityPredictions } from '../../services/outcomes.js';
import { getWorkspaceStages, saveWorkspaceStages, mapToCanonical, CANONICAL_ACTIVE as CANONICAL_ACTIVE_ORDER } from '../../db/workspaceStages.js';
import type { WorkspaceStage } from '../../db/workspaceStages.js';
import { recordObservations } from '../../db/observations.js';
import type { ObservationInput } from '../../db/observations.js';
import { logActivity } from '../../db/activities.js';
import { saveDocument } from '../../db/notes.js';
import { connectedAccountOwnerByEmail } from '../../db/teamMembers.js';
import { messageBodyText } from '../../text/htmlToText.mjs';

// ─── shared types ────────────────────────────────────────────────────────────

export type CrmProvider = 'hubspot' | 'pipedrive' | 'attio' | 'salesforce';

export interface CrmContact {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  /** Provider record id of the related company, when the CRM models it as a relationship (Attio). Resolved to a company entity during sync. */
  company_external_id?: string | null;
  /** Nous company entity UUID, resolved during sync so the contact links to its account (works_at). */
  company_id?: string | null;
  domain?: string | null;
  phone?: string | null;
  job_title?: string | null;
  owner_name?: string | null;
  /** The CRM's own owner id (HubSpot `hubspot_owner_id`). Resolved to a name + email during sync. */
  owner_external_id?: string | null;
  owner_email?: string | null;
  /** The CRM's lifecycle axis (HubSpot `lifecyclestage`: lead → MQL → SQL → opportunity → customer). */
  lifecycle_stage?: string | null;
  lead_status?: string | null;
  updated_at?: string | null;
}

export interface CrmCompany {
  id: string;
  name: string | null;
  domain: string | null;
  industry?: string | null;
  city?: string | null;
  country?: string | null;
  owner_name?: string | null;
  owner_external_id?: string | null;
  owner_email?: string | null;
  lifecycle_stage?: string | null;
  /** Canonical account-health facts, when the portal carries them. See accountHealth.ts. */
  health?: Record<string, unknown> | null;
  updated_at?: string | null;
}

export interface CrmDeal {
  id: string;
  name: string | null;
  value: number | null;
  currency: string | null;
  stage: string | null;
  /** Provider's own open/won/lost flag where it exposes one (Pipedrive). Beats `stage`,
   *  which is free text the customer can rename. */
  status?: string | null;
  close_date?: string | null;
  /** When the deal was created in the CRM. The honest start of a cycle length; the
   *  alternative is the date our sync first ran, which measures us rather than the deal. */
  opened_date?: string | null;
  owner_name?: string | null;
  contact_ids?: string[];   // CRM-side contact ids associated with the deal
  /** Provider record id of the related company. Named to match CrmContact: `*_external_id`
   *  is the CRM's id, `company_id` is the resolved Nous entity UUID. The Pipedrive fetcher
   *  used to put the CRM id straight into `company_id`, which read as if it were already
   *  resolved. */
  company_external_id?: string | null;
  /** Company NAME as the CRM spells it — the fallback match when a provider exposes no
   *  association id (HubSpot's search endpoint returns none). */
  company_name?: string | null;
  /** Why it was lost / won AS THE REP LOGGED IT — a dropdown value or free text. A claim about
   *  the deal, never the finding: win/loss shows it beside what the conversations show (GET-271). */
  lost_reason_stated?: string | null;
  lost_reason_note?: string | null;
  won_reason_stated?: string | null;
  /** Nous company entity UUID, resolved during sync so the deal links to its account. */
  company_id?: string | null;
  /**
   * The CRM's stage id when `stage` has been translated to a label. HubSpot deals carry a
   * stage ID (`closedwon`, or `1234567` for a custom stage), not a name; the orchestrator
   * swaps in the label from the pipeline definitions and keeps the id here.
   */
  stage_external_ref?: string | null;
  pipeline_name?: string | null;
  /**
   * The CRM's own pipeline id, alongside the display name in `pipeline_name`. The id is what
   * readers filter on: a name is renamed by reps and arrives with stray whitespace, an id does
   * neither. HubSpot's primary pipeline is the literal `default`.
   */
  pipeline_id?: string | null;
  owner_external_id?: string | null;
  owner_email?: string | null;
  updated_at?: string | null;
}

export interface FetchOpts {
  since?: string;          // ISO timestamp — only records updated after this
  cursor?: string | number; // provider-specific pagination token
  limit?: number;          // page size; default 100, max 200
  /**
   * HubSpot only: read EXACTLY these record ids (batch read) instead of searching by modified
   * date. Set by a company-scoped import (resolveHubspotScope), never by the incremental sync.
   * The cursor is then an index into the list.
   */
  ids?: string[];
  /** Keep only conversations that happened at or after this. */
  minTimestamp?: string | null;
  /** Keep only conversations that happened BEFORE this. With minTimestamp it is one slice of
   *  time, which is how a portal's worth of email is imported by several runs at once. */
  maxTimestamp?: string | null;
  /**
   * HubSpot search only: OR-ed groups of AND-ed filters that narrow WHICH records are read (the
   * company scope). The modified-date window is added to every group, so it still pages.
   */
  filterGroups?: HubspotFilter[][] | null;
}

export interface HubspotFilter { propertyName: string; operator: string; value?: string | number; values?: string[] }

/**
 * Batch-read one page of a known id list. Same `{ id, properties }` rows as search returns, so
 * every mapper and handler downstream is unchanged.
 */
async function hubspotReadIds(token: string, object: string, properties: string[], opts: FetchOpts): Promise<{ results: any[]; cursor: string | null }> {
  const ids = opts.ids ?? [];
  const start = Number(opts.cursor ?? 0) || 0;
  const size = Math.min(opts.limit ?? 100, 100);
  const chunk = ids.slice(start, start + size);
  const next = start + size < ids.length ? String(start + size) : null;
  if (!chunk.length) return { results: [], cursor: null };
  const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(object)}/batch/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties, inputs: chunk.map(id => ({ id: String(id) })) }),
  }, token);
  if (!res.ok) throw new Error(`HubSpot ${object} batch ${res.status} — ${await res.text().catch(() => '')}`);
  const d: any = await res.json();
  let results: any[] = d.results ?? [];
  if (opts.minTimestamp) {
    const min = new Date(opts.minTimestamp).getTime();
    results = results.filter(r => {
      const t = new Date(r.properties?.hs_timestamp ?? r.properties?.createdate ?? 0).getTime();
      return Number.isFinite(t) && t >= min;
    });
  }
  return { results, cursor: next };
}

// A pipeline's stage DEFINITIONS (the workspace's own stage vocabulary) — distinct from a
// deal's current stage value. Onboarding reads these to adopt the customer's real stage
// names. `isWon`/`isLost` are the provider's own flags when it exposes them.
export interface CrmPipelineStage {
  external_ref: string;    // provider stage/status id
  label: string;
  order: number;
  isWon?: boolean;
  isLost?: boolean;
}

export interface CrmPipeline {
  id: string;
  name: string;
  stages: CrmPipelineStage[];
}

export interface FetchResult<T> {
  records: T[];
  cursor: string | number | null;  // next page cursor, or null if done
}

// ─── HubSpot ─────────────────────────────────────────────────────────────────

// HubSpot returns ONLY the properties you name (plus three defaults), so anything not listed
// here is invisible to the sync. Verified live 2026-09-09: a request with an empty list
// yields createdate/lastmodifieddate/hs_object_id and nothing else. The portal's full
// schema, custom properties included, is discovered separately (fetchHubspotProperties).
const HUBSPOT_PROPS = {
  contacts:  ['firstname', 'lastname', 'email', 'company', 'phone', 'jobtitle', 'lifecyclestage',
              'hs_lead_status', 'hubspot_owner_id', 'lastmodifieddate'],
  // The health properties ride along with the company read rather than costing a pass of their
  // own: they live on the same record, and a property this portal does not have comes back null.
  // A getter, so a map registered after import (registerAccountHealthMap) is what gets read.
  get companies() {
    return ['name', 'domain', 'industry', 'city', 'country', 'phone', 'lifecyclestage',
            'hubspot_owner_id', 'hs_lastmodifieddate',
            ...accountHealthProperties('hubspot')];
  },
  deals:     ['dealname', 'amount', 'deal_currency_code', 'dealstage', 'closedate', 'pipeline',
              // WHEN THE DEAL OPENED. Without it, the only date we hold for a deal is the
              // moment our own sync first saw it, so every cycle length came out as the gap
              // between two sync artefacts — reported as "0 days" in the revenue report,
              // which reads as "these deals closed the same day they started".
              'createdate',
              // WHY IT CLOSED, as the rep logged it (GET-271): HubSpot's standard free-text reasons
              // and the common `lost_reason` dropdown portals add. Asking for a property a portal
              // doesn't have returns null, not an error.
              'closed_lost_reason', 'closed_won_reason', 'lost_reason',
              'hubspot_owner_id', 'hs_lastmodifieddate'],
};

// Every HubSpot call goes through here. The limit is 100 requests per 10 seconds (measured
// live: x-hubspot-ratelimit-max=100, interval 10000ms) and a full-portal backfill will hit
// it, so a 429 is retried after the Retry-After the server asks for, up to three times.
// 5xx get the same treatment. Anything else returns immediately for the caller to judge.
const HUBSPOT_RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function hubspotFetch(url: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let last: Response | null = null;
  // HubSpot's search endpoints have a PER-SECOND limit, and several importers sharing one portal
  // reach it constantly: one run logged hundreds of refusals (GET-291). A 429 is not a failure, it is the
  // portal asking us to slow down — so wait longer, try more often, and jitter so parallel runs
  // do not all come back at the same instant and collide again.
  const ATTEMPTS = 8;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (!HUBSPOT_RETRYABLE.has(res.status)) return res;
    last = res;
    if (attempt === ATTEMPTS - 1) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoff = Math.min(1_000 * Math.pow(2, attempt), 30_000);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 30_000)
      : backoff + Math.random() * 500;
    await new Promise(r => setTimeout(r, waitMs));
  }
  return last as Response;
}

async function hubspotSearch<T>(
  token: string,
  object: 'contacts' | 'companies' | 'deals',
  opts: FetchOpts,
  mapper: (r: any) => T,
): Promise<FetchResult<T>> {
  if (opts.ids) {
    const { results, cursor } = await hubspotReadIds(token, object, HUBSPOT_PROPS[object], opts);
    return { records: results.map(mapper), cursor };
  }
  const propName = object === 'companies' || object === 'deals'
    ? 'hs_lastmodifieddate' : 'lastmodifieddate';
  const body: any = {
    properties: HUBSPOT_PROPS[object],
    limit: Math.min(opts.limit ?? 100, 200),
    sorts: [{ propertyName: propName, direction: 'ASCENDING' }],
  };
  const window: HubspotFilter[] = opts.since
    ? [{ propertyName: propName, operator: 'GTE', value: new Date(opts.since).getTime() }]
    : [];
  if (opts.filterGroups?.length) {
    body.filterGroups = opts.filterGroups.map(g => ({ filters: [...g, ...window] }));
  } else if (window.length) {
    body.filterGroups = [{ filters: window }];
  }
  if (opts.cursor) body.after = opts.cursor;

  const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/${object}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, token);
  if (!res.ok) throw new Error(`HubSpot ${object} ${res.status} — ${await res.text().catch(() => '')}`);
  const d = await res.json();
  return {
    records: (d.results ?? []).map(mapper),
    cursor: d.paging?.next?.after ?? null,
  };
}

export const hubspot = {
  fetchContacts: (token: string, opts: FetchOpts = {}) => hubspotSearch<CrmContact>(token, 'contacts', opts, r => {
    const p = r.properties || {};
    return {
      id: r.id,
      name: [p.firstname, p.lastname].filter(Boolean).join(' ') || null,
      email: p.email ?? null,
      company: p.company ?? null,
      phone: p.phone ?? null,
      job_title: p.jobtitle ?? null,
      lifecycle_stage: p.lifecyclestage ?? null,
      lead_status: p.hs_lead_status ?? null,
      owner_external_id: p.hubspot_owner_id ?? null,
      updated_at: p.lastmodifieddate ?? null,
    };
  }),
  fetchCompanies: (token: string, opts: FetchOpts = {}) => hubspotSearch<CrmCompany>(token, 'companies', opts, r => {
    const p = r.properties || {};
    return {
      id: r.id,
      name: p.name ?? null,
      domain: p.domain ?? null,
      industry: p.industry ?? null,
      city: p.city ?? null,
      country: p.country ?? null,
      lifecycle_stage: p.lifecyclestage ?? null,
      owner_external_id: p.hubspot_owner_id ?? null,
      health: readAccountHealth('hubspot', p),
      updated_at: p.hs_lastmodifieddate ?? null,
    };
  }),
  fetchDeals: (token: string, opts: FetchOpts = {}) => hubspotSearch<CrmDeal>(token, 'deals', opts, r => {
    const p = r.properties || {};
    return {
      id: r.id,
      name: p.dealname ?? null,
      value: p.amount ? Number(p.amount) : null,
      currency: p.deal_currency_code ?? '$',
      // A stage ID, not a label. Translated by the orchestrator via the pipeline index.
      stage: p.dealstage ?? null,
      close_date: p.closedate ?? null,
      opened_date: p.createdate ?? null,
      lost_reason_stated: p.lost_reason ?? null,
      lost_reason_note: p.closed_lost_reason ?? null,
      won_reason_stated: p.closed_won_reason ?? null,
      owner_external_id: p.hubspot_owner_id ?? null,
      // HubSpot's /search endpoint does not return associations, and a HubSpot deal carries
      // no company-name property either. So there is NOTHING to name-match on here: the
      // link comes from the v4 association batch read in syncCrmProvider, and a deal with
      // no association is counted as `unlinked` rather than silently vanishing. This used
      // to pass the DEAL name as the company name, which could only ever mis-link.
      company_name: null,
      updated_at: p.hs_lastmodifieddate ?? null,
    };
  }),
};

// Company → PARENT company, for HubSpot.
//
// A company group is not one account. A customer's graph can hold several "Kestrel Bay" branches,
// a few "Millbrook" and more "Thornfield", each a company of its own, and HubSpot already records
// which group each belongs to — a group like Quarry Ridge Holdings carries a dozen child companies.
// Nous never read it, so the branches of one customer sat as unrelated rows and nothing could
// answer "how much do we do with Quarry Ridge".
//
// VERIFIED against a customer's live portal on 2026-09-17:
//   GET /crm/v4/associations/companies/companies/labels
//   → typeId 14 "Parent Company" (HUBSPOT_DEFINED), typeId 13 "Child Company"
// Both directions are stored, so reading typeId 14 alone gives every edge exactly once, child
// first. Labels are matched on the typeId, never the label text, which a portal can rename.
//
// FAILS SOFT, like every association read here: any error or unexpected shape returns an empty
// map and the hierarchy is simply absent, never wrong.
const HUBSPOT_PARENT_COMPANY_TYPE_ID = 14;

async function hubspotCompanyParents(token: string, companyIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!companyIds.length) return out;
  for (let i = 0; i < companyIds.length; i += 100) {
    try {
      const res = await hubspotFetch('https://api.hubapi.com/crm/v4/associations/companies/companies/batch/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: companyIds.slice(i, i + 100).map(id => ({ id: String(id) })) }),
      }, token);
      if (!res.ok) continue;
      const d: any = await res.json();
      for (const row of d?.results ?? []) {
        const from = row?.from?.id ?? row?._from?.id ?? null;
        if (!from) continue;
        for (const t of row?.to ?? []) {
          const isParent = (t?.associationTypes ?? []).some((a: any) => Number(a?.typeId) === HUBSPOT_PARENT_COMPANY_TYPE_ID);
          const to = t?.toObjectId ?? t?.id ?? null;
          // A company has one parent. Self-association would make a cycle of length one.
          if (isParent && to && String(to) !== String(from) && !out.has(String(from))) out.set(String(from), String(to));
        }
      }
    } catch { /* fail soft — one page of hierarchy missing, never a failed sync */ }
  }
  return out;
}

// Deal → company associations for HubSpot.
//
// hubspotSearch (used by fetchDeals) hits /crm/v3/objects/deals/search, and HubSpot's
// search endpoints do not return associations at all. So without a second call every
// HubSpot deal syncs with its amount and no account to attach it to, which is exactly the
// orphaning this work exists to fix. One v4 batch read per page covers a whole page.
//
// VERIFIED against a live portal on 2026-09-09 (scripts/hubspot-profile.mjs run): the
// response is `results[].from.id` + `results[].to[0].toObjectId`, with the Primary
// association listed first, exactly as read below. It still FAILS SOFT: any error, any
// unexpected shape, and it returns an empty map. Deals then sync unlinked and are counted
// in `deals.unlinked`, so the gap is visible in the sync result rather than silent.
async function hubspotDealCompanyIds(token: string, dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!dealIds.length) return out;
  try {
    const res = await hubspotFetch('https://api.hubapi.com/crm/v4/associations/deals/companies/batch/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: dealIds.map(id => ({ id: String(id) })) }),
    }, token);
    if (!res.ok) return out;
    const d: any = await res.json();
    for (const row of d?.results ?? []) {
      // A deal can be associated with several companies; the primary is first.
      const from = row?.from?.id ?? row?._from?.id ?? null;
      const to = row?.to?.[0]?.toObjectId ?? row?.to?.[0]?.id ?? null;
      if (from && to) out.set(String(from), String(to));
    }
  } catch { /* fail soft — deals sync unlinked rather than not at all */ }
  return out;
}

// ─── Pipedrive ───────────────────────────────────────────────────────────────

async function pipedriveList<T>(
  token: string,
  endpoint: 'persons' | 'organizations' | 'deals',
  opts: FetchOpts,
  mapper: (r: any) => T,
): Promise<FetchResult<T>> {
  // Pipedrive's incremental endpoint: /v1/recents — returns items modified
  // since a unix timestamp, paginated via `start`. We page through it.
  // Falls back to /v1/<endpoint> for full sync when `since` is absent.
  const limit = Math.min(opts.limit ?? 100, 200);
  const start = typeof opts.cursor === 'number' ? opts.cursor : 0;

  if (opts.since) {
    const sinceTs = new Date(opts.since).toISOString().slice(0, 19).replace('T', ' ');
    const item = endpoint === 'persons' ? 'person' : endpoint === 'organizations' ? 'organization' : 'deal';
    const url = `https://api.pipedrive.com/v1/recents?since_timestamp=${encodeURIComponent(sinceTs)}&items=${item}&start=${start}&limit=${limit}&api_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pipedrive recents ${res.status}`);
    const d = await res.json();
    const items = (d.data ?? []).map((row: any) => row.data ?? row);
    const nextStart = d.additional_data?.pagination?.more_items_in_collection
      ? (d.additional_data.pagination.next_start ?? null)
      : null;
    return { records: items.map(mapper), cursor: nextStart };
  }

  const url = `https://api.pipedrive.com/v1/${endpoint}?start=${start}&limit=${limit}&api_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pipedrive ${endpoint} ${res.status}`);
  const d = await res.json();
  const items = d.data ?? [];
  const nextStart = d.additional_data?.pagination?.more_items_in_collection
    ? (d.additional_data.pagination.next_start ?? null)
    : null;
  return { records: items.map(mapper), cursor: nextStart };
}

export const pipedrive = {
  fetchContacts: (token: string, opts: FetchOpts = {}) => pipedriveList<CrmContact>(token, 'persons', opts, r => ({
    id: String(r.id),
    name: r.name ?? null,
    email: r.email?.[0]?.value ?? r.primary_email ?? null,
    company: r.org_name ?? r.organization?.name ?? null,
    phone: r.phone?.[0]?.value ?? null,
    owner_name: r.owner_name ?? null,
    updated_at: r.update_time ?? r.add_time ?? null,
  })),
  fetchCompanies: (token: string, opts: FetchOpts = {}) => pipedriveList<CrmCompany>(token, 'organizations', opts, r => ({
    id: String(r.id),
    name: r.name ?? null,
    domain: null,
    city: r.address_city ?? null,
    country: r.address_country ?? null,
    updated_at: r.update_time ?? r.add_time ?? null,
  })),
  fetchDeals: (token: string, opts: FetchOpts = {}) => pipedriveList<CrmDeal>(token, 'deals', opts, r => ({
    id: String(r.id),
    name: r.title ?? null,
    value: r.value != null ? Number(r.value) : null,
    currency: r.currency ?? '$',
    stage: r.stage_name ?? r.stage?.name ?? null,
    // Pipedrive ships an explicit open|won|lost|deleted, which beats guessing from a
    // renameable stage label. `expected_close_date` is the FORECAST date; `close_time` is
    // when it actually closed, so an open deal only has the former.
    status: r.status ?? null,
    // `close_time` FIRST. The old order preferred `expected_close_date`, which is the
    // forecast — so a deal that closed in March with a September forecast was filed under
    // September, in the future, and dropped out of every historical window.
    close_date: r.close_time ?? r.expected_close_date ?? null,
    // `add_time` is when the deal was created, which is what a cycle length needs.
    opened_date: r.add_time ?? null,
    lost_reason_note: r.lost_reason ?? null,
    owner_name: r.owner_name ?? null,
    company_external_id: r.org_id?.value ? String(r.org_id.value) : null,
    company_name: r.org_name ?? r.org_id?.name ?? null,
    contact_ids: r.person_id?.value ? [String(r.person_id.value)] : [],
    updated_at: r.update_time ?? r.add_time ?? null,
  })),
};

// ─── Attio ───────────────────────────────────────────────────────────────────

async function attioQuery<T>(
  apiKey: string,
  objectSlug: 'people' | 'companies' | 'deals',
  opts: FetchOpts,
  mapper: (r: any) => T,
): Promise<FetchResult<T>> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = typeof opts.cursor === 'number' ? opts.cursor : 0;

  // Attio's filter/sort syntax varies by attribute and isn't well-documented
  // for our use case — we tried `sorts: [{ attribute: 'updated_at' }]` and got
  // validation errors. Until we wire up proper incremental support, just
  // paginate and filter client-side on updated_at if a `since` is provided.
  const body: Record<string, unknown> = { limit, offset };

  const res = await fetch(`https://api.attio.com/v2/objects/${objectSlug}/records/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Attio ${objectSlug} ${res.status} — ${await res.text().catch(() => '')}`);
  const d = await res.json();

  let records = (d.data ?? []).map(mapper);
  // Client-side incremental filter on the mapped `updated_at`.
  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    records = records.filter((r: any) =>
      r.updated_at && new Date(r.updated_at).getTime() > sinceMs,
    );
  }
  // Attio paginates by offset; if we got a full page there may be more.
  const nextCursor = (d.data ?? []).length === limit ? offset + limit : null;
  return { records, cursor: nextCursor };
}

const attioVal = (r: any, field: string) => r.values?.[field]?.[0]?.value ?? null;

export const attio = {
  fetchContacts: (apiKey: string, opts: FetchOpts = {}) => attioQuery<CrmContact>(apiKey, 'people', opts, r => {
    const first = r.values?.name?.[0]?.first_name ?? '';
    const last  = r.values?.name?.[0]?.last_name ?? '';
    return {
      id: r.id?.record_id ?? r.id,
      name: [first, last].filter(Boolean).join(' ') || null,
      email: r.values?.email_addresses?.[0]?.email_address ?? null,
      company: null,   // Attio models this as a record-reference; resolved to a company entity in syncCrmProvider
      company_external_id: r.values?.company?.[0]?.target_record_id ?? null,
      phone: r.values?.phone_numbers?.[0]?.phone_number ?? null,
      updated_at: r.updated_at ?? null,
    };
  }),
  fetchCompanies: (apiKey: string, opts: FetchOpts = {}) => attioQuery<CrmCompany>(apiKey, 'companies', opts, r => ({
    id: r.id?.record_id ?? r.id,
    name: attioVal(r, 'name'),
    domain: r.values?.domains?.[0]?.domain ?? null,
    industry: attioVal(r, 'categories'),
    city: null,
    country: null,
    updated_at: r.updated_at ?? null,
  })),
  // Attio ships no open/won/lost field, no close date and — before this — no link to the
  // company. Every Attio deal therefore carried an amount and nothing that could turn it
  // into a closed deal, so the outcome ledger could never see one. Three of the four gaps
  // close here; the outcome itself is read from the stage LABEL by crmDealState, which is
  // provider-agnostic on purpose.
  fetchDeals: (apiKey: string, opts: FetchOpts = {}) => attioQuery<CrmDeal>(apiKey, 'deals', opts, r => ({
    id: r.id?.record_id ?? r.id,
    name: attioVal(r, 'name'),
    // Attio's currency attribute is `{ currency_value, currency_code }` on the value entry
    // itself — the shape crmLookup verified against live records. The nested `.value.amount`
    // read here first is kept as a fallback rather than deleted: no Attio workspace in
    // production has a deal carrying an amount, so neither shape can be confirmed end to
    // end, and reading both costs nothing.
    value: r.values?.value?.[0]?.currency_value ?? r.values?.value?.[0]?.value?.amount ?? null,
    currency: r.values?.value?.[0]?.currency_code ?? r.values?.value?.[0]?.value?.currency_code ?? '$',
    // A status attribute, so the current value is `.status.title` — the same shape
    // crmLookup found on live records ("Won", "Lost", "In progress").
    stage: r.values?.stage?.[0]?.status?.title ?? attioVal(r, 'stage'),
    // No close-date attribute exists on Attio's deals object — probed live, the attributes
    // are exactly: record_id, name, stage, owner, value, associated_people,
    // associated_company, created_at, created_by. A custom one is read when a workspace has
    // added it; otherwise the honest close date is `stage.active_from`, the moment the
    // record ENTERED its current stage. For a deal now sitting in Won or Lost, that is when
    // it was decided — which beats the record's last-modified time, and Attio does not
    // expose one of those on a record anyway.
    close_date: r.values?.close_date?.[0]?.value
      ?? r.values?.closed_at?.[0]?.value
      ?? r.values?.stage?.[0]?.active_from
      ?? null,
    // Attio's own creation timestamp: the honest start of a cycle length.
    opened_date: r.created_at ?? null,
    // A record reference, resolved to a Nous company entity in syncCrmProvider — the same
    // `target_record_id` shape the contacts fetcher already uses.
    company_external_id: r.values?.associated_company?.[0]?.target_record_id
      ?? r.values?.company?.[0]?.target_record_id ?? null,
    contact_ids: (r.values?.associated_people ?? [])
      .map((v: any) => v?.target_record_id).filter(Boolean).map(String),
    updated_at: r.updated_at ?? null,
  })),
};

// ─── Salesforce ──────────────────────────────────────────────────────────────
//
// Salesforce is OAuth-only and every org has its own REST host (`instance_url`, returned at
// connect), so the one `token` string the fetchers take carries both: salesforceToken() packs
// them, sfAuth() unpacks. Access tokens expire within hours; salesforceAccess() trades the stored
// refresh token for a fresh one at the start of every import and nightly sync (GET-853).
//
// Reads are SOQL, ordered by LastModifiedDate ascending so a run that hits the page cap reports
// the newest record it filed, and the next incremental run resumes from exactly there.

const SF_API = 'v59.0';

/** Pack an org's REST host and access token into the single token string the fetchers take. */
export function salesforceToken(instanceUrl: string, accessToken: string): string {
  return JSON.stringify({ i: String(instanceUrl).replace(/\/$/, ''), t: accessToken });
}

function sfAuth(token: string): { instance: string; access: string } {
  try {
    const o = JSON.parse(token);
    if (o?.i && o?.t) return { instance: o.i, access: o.t };
  } catch { /* not packed */ }
  throw new Error('Salesforce token must carry the org instance_url (use salesforceToken)');
}

/**
 * A working token for a Salesforce connection: refresh when a refresh token and the app's client
 * credentials exist, else the stored access token as is. `creds` are the decrypted connection
 * credentials (access_token, refresh_token, instance_url).
 */
export async function salesforceAccess(
  creds: Record<string, string | null | undefined>,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const instance = creds.instance_url;
  if (!instance) return null;
  const clientId = env.SALESFORCE_CLIENT_ID?.trim();
  const clientSecret = env.SALESFORCE_CLIENT_SECRET?.trim();
  if (creds.refresh_token && clientId && clientSecret) {
    const login = (env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
    const res = await fetch(`${login}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token, client_id: clientId, client_secret: clientSecret }),
    });
    const d: any = await res.json().catch(() => ({}));
    if (res.ok && d.access_token) return salesforceToken(d.instance_url || instance, d.access_token);
    throw new Error(`Salesforce token refresh failed: ${d.error_description || d.error || res.status}`);
  }
  return creds.access_token ? salesforceToken(instance, creds.access_token) : null;
}

/** One page of a SOQL query; the cursor is Salesforce's nextRecordsUrl. */
async function sfQuery(token: string, soql: string, cursor?: string | number): Promise<{ records: any[]; cursor: string | null }> {
  const { instance, access } = sfAuth(token);
  const url = typeof cursor === 'string' && cursor.startsWith('/services/')
    ? `${instance}${cursor}`
    : `${instance}/services/data/${SF_API}/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}`, 'Sforce-Query-Options': 'batchSize=200' } });
  if (!res.ok) throw new Error(`Salesforce ${res.status} — ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const d: any = await res.json();
  return { records: d.records ?? [], cursor: d.done ? null : (d.nextRecordsUrl ?? null) };
}

function sfSince(opts: FetchOpts): string {
  // SOQL datetime literals are unquoted ISO 8601 with a zone.
  return opts.since ? ` WHERE LastModifiedDate > ${new Date(opts.since).toISOString()}` : '';
}

/** A website as Salesforce stores it ("https://www.acme.com/en") → the bare domain. */
export function salesforceDomain(website: string | null | undefined): string | null {
  const w = String(website ?? '').trim();
  if (!w) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, '').toLowerCase();
    return host.includes('.') ? host : null;
  } catch { return null; }
}

async function sfList<T>(token: string, soql: string, opts: FetchOpts, mapper: (r: any) => T): Promise<FetchResult<T>> {
  const { records, cursor } = await sfQuery(token, soql, opts.cursor);
  return { records: records.map(mapper), cursor };
}

export const salesforce = {
  fetchContacts: (token: string, opts: FetchOpts = {}) => sfList<CrmContact>(token,
    `SELECT Id, FirstName, LastName, Email, Phone, Title, AccountId, Account.Name, Owner.Name, Owner.Email, LastModifiedDate FROM Contact${sfSince(opts)} ORDER BY LastModifiedDate ASC`,
    opts, r => ({
      id: String(r.Id),
      name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || null,
      email: r.Email ?? null,
      company: r.Account?.Name ?? null,
      company_external_id: r.AccountId ?? null,
      phone: r.Phone ?? null,
      job_title: r.Title ?? null,
      owner_name: r.Owner?.Name ?? null,
      owner_email: r.Owner?.Email ?? null,
      updated_at: r.LastModifiedDate ?? null,
    })),
  fetchCompanies: (token: string, opts: FetchOpts = {}) => sfList<CrmCompany>(token,
    `SELECT Id, Name, Website, Industry, BillingCity, BillingCountry, Owner.Name, Owner.Email, LastModifiedDate FROM Account${sfSince(opts)} ORDER BY LastModifiedDate ASC`,
    opts, r => ({
      id: String(r.Id),
      name: r.Name ?? null,
      domain: salesforceDomain(r.Website),
      industry: r.Industry ?? null,
      city: r.BillingCity ?? null,
      country: r.BillingCountry ?? null,
      owner_name: r.Owner?.Name ?? null,
      owner_email: r.Owner?.Email ?? null,
      updated_at: r.LastModifiedDate ?? null,
    })),
  // Salesforce flags the outcome itself (IsClosed, IsWon), which beats reading a stage label the
  // org can rename. CloseDate is the forecast on an open opportunity and the actual date on a
  // closed one. No currency: CurrencyIsoCode exists only in multi-currency orgs.
  fetchDeals: (token: string, opts: FetchOpts = {}) => sfList<CrmDeal>(token,
    `SELECT Id, Name, Amount, StageName, IsClosed, IsWon, CloseDate, CreatedDate, AccountId, Account.Name, Owner.Name, Owner.Email, LastModifiedDate, (SELECT ContactId FROM OpportunityContactRoles) FROM Opportunity${sfSince(opts)} ORDER BY LastModifiedDate ASC`,
    opts, r => ({
      id: String(r.Id),
      name: r.Name ?? null,
      value: r.Amount != null ? Number(r.Amount) : null,
      currency: null,
      stage: r.StageName ?? null,
      status: r.IsClosed ? (r.IsWon ? 'won' : 'lost') : 'open',
      close_date: r.CloseDate ?? null,
      opened_date: r.CreatedDate ?? null,
      owner_name: r.Owner?.Name ?? null,
      owner_email: r.Owner?.Email ?? null,
      company_external_id: r.AccountId ?? null,
      company_name: r.Account?.Name ?? null,
      contact_ids: (r.OpportunityContactRoles?.records ?? []).map((c: any) => c?.ContactId).filter(Boolean).map(String),
      updated_at: r.LastModifiedDate ?? null,
    })),
};

/** The org's opportunity stages, in order, with Salesforce's own won/lost flags. */
async function fetchSalesforcePipelineStages(token: string): Promise<CrmPipeline[]> {
  const { records } = await sfQuery(token, 'SELECT ApiName, MasterLabel, SortOrder, IsClosed, IsWon FROM OpportunityStage WHERE IsActive = true ORDER BY SortOrder');
  return [{
    id: 'default', name: 'Opportunities',
    stages: records.map((r: any, i: number) => ({
      external_ref: String(r.ApiName ?? r.MasterLabel), label: String(r.MasterLabel ?? r.ApiName),
      order: Number(r.SortOrder ?? i), isWon: !!r.IsWon, isLost: !!r.IsClosed && !r.IsWon,
    })),
  }];
}

// ─── Pipeline stage definitions (the workspace's stage vocabulary) ────────────
// Reads the pipeline's stage LIST (not a deal's current stage) so onboarding can adopt the
// customer's real stage names. Attio only for now.

async function fetchAttioPipelineStages(apiKey: string): Promise<CrmPipeline[]> {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  // 1. Find the status-type attribute on the deals object (standard slug is 'stage').
  const attrsRes = await fetch('https://api.attio.com/v2/objects/deals/attributes?limit=100', { headers });
  if (!attrsRes.ok) throw new Error(`Attio attributes ${attrsRes.status} — ${await attrsRes.text().catch(() => '')}`);
  const attrs = (await attrsRes.json())?.data ?? [];
  const stageAttr = attrs.find((a: any) => a.type === 'status') ?? attrs.find((a: any) => a.api_slug === 'stage');
  if (!stageAttr) return [{ id: 'deals', name: 'Deals', stages: [] }];
  const slug = stageAttr.api_slug ?? stageAttr.id?.attribute_id;

  // 2. List its statuses (the stage options), in configured order.
  const stRes = await fetch(
    `https://api.attio.com/v2/objects/deals/attributes/${encodeURIComponent(slug)}/statuses`,
    { headers },
  );
  if (!stRes.ok) throw new Error(`Attio statuses ${stRes.status} — ${await stRes.text().catch(() => '')}`);
  const statuses = (await stRes.json())?.data ?? [];

  const stages: CrmPipelineStage[] = statuses
    .filter((s: any) => !s.is_archived)
    .map((s: any, i: number) => ({
      external_ref: s.id?.status_id ?? s.id ?? String(i),
      label: s.title ?? `Stage ${i + 1}`,
      order: i,
      // Attio marks a "won" status with celebration confetti; no explicit lost flag.
      isWon: s.celebration_enabled === true ? true : undefined,
    }));

  return [{ id: 'deals', name: 'Deals', stages }];
}

// ─── HubSpot pipelines, owners, property schema ─────────────────────────────

/**
 * Raw HubSpot pipeline → CrmPipeline. Exported for tests because the input is a trap:
 * HubSpot returns stage metadata as STRINGS. `isClosed` arrives as "false", which is
 * truthy, so a naive check marks every stage closed. Won/lost is derived from
 * `isClosed` + `probability` (1.0 = won, 0.0 = lost), never from the stage's name, which
 * the customer renames at will.
 */
export function hubspotPipelineToCrm(raw: any): CrmPipeline {
  const stages = [...(raw?.stages ?? [])]
    .sort((a: any, b: any) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0));
  return {
    id: String(raw.id),
    name: raw.label ?? String(raw.id),
    stages: stages.map((s: any, i: number) => {
      const closed = s.metadata?.isClosed === true || s.metadata?.isClosed === 'true';
      const p = s.metadata?.probability;
      const prob = p == null || p === '' ? null : Number(p);
      return {
        external_ref: String(s.id),
        label: s.label ?? String(s.id),
        order: i,
        isWon: closed && prob === 1 ? true : undefined,
        isLost: closed && prob === 0 ? true : undefined,
      };
    }),
  };
}

async function fetchHubspotPipelineStages(token: string): Promise<CrmPipeline[]> {
  const res = await hubspotFetch('https://api.hubapi.com/crm/v3/pipelines/deals', {}, token);
  if (!res.ok) throw new Error(`HubSpot pipelines ${res.status} — ${await res.text().catch(() => '')}`);
  const d: any = await res.json();
  return [...(d?.results ?? [])]
    .sort((a: any, b: any) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0))
    .map(hubspotPipelineToCrm);
}

export interface StageIndexEntry {
  label: string;
  pipelineId: string;
  pipelineName: string;
  isWon: boolean;
  isLost: boolean;
}

/**
 * The pipeline a workspace means when it says "the pipeline". HubSpot marks its primary with
 * the literal id `default`; other providers only give an ordered list, where first is primary.
 * One definition, so stage adoption, the funnel and the per-pipeline stats all agree on which
 * one that is. Never a display name: reps rename those, and several of one live portal's pipelines
 * arrive with leading or trailing whitespace.
 */
export function pickPrimaryPipeline(provider: CrmProvider, pipelines: CrmPipeline[]): CrmPipeline | null {
  if (!pipelines?.length) return null;
  if (provider === 'hubspot') return pipelines.find(p => p.id === 'default') ?? pipelines[0];
  return pipelines[0];
}

/** The primary pipeline's id, or null when the provider returned none. */
export function primaryPipelineRef(provider: CrmProvider, pipelines: CrmPipeline[]): string | null {
  return pickPrimaryPipeline(provider, pipelines)?.id ?? null;
}

/** stage id → what it means. The lookup that turns HubSpot's `dealstage` id into a label + outcome. */
export function buildStageIndex(pipelines: CrmPipeline[]): Map<string, StageIndexEntry> {
  const out = new Map<string, StageIndexEntry>();
  for (const p of pipelines) {
    for (const s of p.stages) {
      out.set(String(s.external_ref), {
        label: s.label, pipelineId: p.id, pipelineName: p.name,
        isWon: s.isWon === true, isLost: s.isLost === true,
      });
    }
  }
  return out;
}

/** The provider's explicit outcome for a stage id, or null when the id is not in the index. */
export function dealStatusFromStage(
  stageRef: string | null | undefined,
  index: Map<string, StageIndexEntry>,
): 'won' | 'lost' | 'open' | null {
  if (!stageRef) return null;
  const s = index.get(String(stageRef));
  if (!s) return null;
  return s.isWon ? 'won' : s.isLost ? 'lost' : 'open';
}

export interface CrmOwner { id: string; name: string | null; email: string | null }

/**
 * The product catalog: HubSpot's own id → the product's canonical name.
 *
 * A line item carries whatever a rep typed; the product record carries what the product is
 * actually called. Those disagree constantly — one product can be typed as "Harbor Desk",
 * "Harbor Desk Pro (annual)" and "Harbor Desk (second site)" while the catalog calls it one thing. So
 * the name on a finding comes from here, and only falls back to a typed name when it must.
 *
 * Archived products are read too, for the same reason archived owners are: a product pulled
 * from the catalog last year is still named on every line item that sold it. A product that
 * was HARD-deleted resolves to nothing at all (its id 404s), which is why every caller keeps a fallback rather than trusting this to be total.
 */
export async function fetchHubspotProducts(token: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const archived of [false, true]) {
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = `https://api.hubapi.com/crm/v3/objects/products?limit=100&properties=name${archived ? '&archived=true' : ''}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const res = await hubspotFetch(url, {}, token);
      if (!res.ok) {
        if (archived) break;   // the archived read is a bonus; never fail the sync on it
        throw new Error(`HubSpot products ${res.status} — ${await res.text().catch(() => '')}`);
      }
      const d: any = await res.json();
      for (const r of d?.results ?? []) {
        const name = typeof r?.properties?.name === 'string' ? r.properties.name.trim() : '';
        if (name && !out.has(String(r.id))) out.set(String(r.id), name);
      }
      after = d?.paging?.next?.after ?? null;
      if (!after) break;
    }
  }
  return out;
}

/** owner id → person. Without this there is no per-rep attribution: `hubspot_owner_id` is just a number. */
export async function fetchHubspotOwners(token: string): Promise<Map<string, CrmOwner>> {
  const out = new Map<string, CrmOwner>();
  // Active owners first, then ARCHIVED ones: a rep who left still owns every deal they closed,
  // and reading only active owners left those deals (several in one customer's portal) ownerless.
  for (const archived of [false, true]) {
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = `https://api.hubapi.com/crm/v3/owners?limit=100${archived ? '&archived=true' : ''}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const res = await hubspotFetch(url, {}, token);
      if (!res.ok) {
        if (archived) break;   // the archived read is a bonus; never fail the sync on it
        throw new Error(`HubSpot owners ${res.status} — ${await res.text().catch(() => '')}`);
      }
      const d: any = await res.json();
      for (const o of d?.results ?? []) {
        if (out.has(String(o.id))) continue;
        out.set(String(o.id), {
          id: String(o.id),
          name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || null,
          email: o.email ?? null,
        });
      }
      after = d?.paging?.next?.after ?? null;
      if (!after) break;
    }
  }
  return out;
}

export interface CrmPropertyDef {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  /** Invented by the customer, not by HubSpot — the personalisation. */
  custom: boolean;
  calculated: boolean;
  groupName?: string;
  options?: string[];
}

/**
 * The portal's full property schema for one object, custom properties flagged. This is
 * how "what fields does THIS portal have" is discovered rather than assumed, and it is
 * also what makes write-back safe: a value can be checked against the declared type and
 * allowed options before it is ever sent.
 */
export async function fetchHubspotProperties(token: string, objectType: string): Promise<CrmPropertyDef[]> {
  const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/properties/${encodeURIComponent(objectType)}`, {}, token);
  if (!res.ok) throw new Error(`HubSpot properties/${objectType} ${res.status} — ${await res.text().catch(() => '')}`);
  const d: any = await res.json();
  return (d?.results ?? []).map((p: any) => ({
    name: p.name, label: p.label ?? p.name, type: p.type, fieldType: p.fieldType,
    custom: !p.hubspotDefined, calculated: !!p.calculated, groupName: p.groupName,
    options: Array.isArray(p.options) && p.options.length
      ? p.options.map((o: any) => String(o.value ?? o.label)).slice(0, 200)
      : undefined,
  }));
}

// ─── HubSpot batch read + property history ───────────────────────────────────
//
// Search (the "what changed since" path) never returns property history — confirmed live.
// History comes only from GET/batch-read with `propertiesWithHistory`, capped at 100 ids per
// call, or 50 when history is requested. So the sync is two-pass: search for the changed
// ids, then batch-read those ids with history. This is where "this deal sat in Negotiation
// for 94 days" and "the close date slipped three times" come from.

export interface HubspotHistoryEntry {
  value: string;
  timestamp: string;
  sourceType?: string;
  sourceId?: string;
}

export interface HubspotBatchRow {
  id: string;
  properties: Record<string, any>;
  propertiesWithHistory: Record<string, HubspotHistoryEntry[]>;
}

export async function hubspotBatchRead(
  token: string,
  object: string,
  ids: string[],
  properties: string[],
  propertiesWithHistory: string[] = [],
): Promise<HubspotBatchRow[]> {
  const out: HubspotBatchRow[] = [];
  const chunkSize = propertiesWithHistory.length ? 50 : 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const inputs = ids.slice(i, i + chunkSize).map(id => ({ id: String(id) }));
    const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(object)}/batch/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties, ...(propertiesWithHistory.length ? { propertiesWithHistory } : {}), inputs }),
    }, token);
    // 207 is "multi-status": some ids missing, the rest returned. Treat as success.
    if (res.status >= 400) throw new Error(`HubSpot batch/${object} ${res.status} — ${await res.text().catch(() => '')}`);
    const d: any = await res.json();
    for (const r of d?.results ?? []) {
      out.push({ id: String(r.id), properties: r.properties ?? {}, propertiesWithHistory: r.propertiesWithHistory ?? {} });
    }
  }
  return out;
}

/** One historical fact, ready to become an observation. `externalId` makes it idempotent. */
export interface HistoryFact {
  property: string;
  value: unknown;
  observedAt: string;
  externalId: string;
  raw: unknown;
}

/**
 * A deal's property history → observations on the deal entity. Stage changes are recorded
 * under `stage` with the LABEL as the value (translated through the pipeline index, so a
 * renamed stage stays readable) and the raw id kept in `raw`. Amount and close-date changes
 * land under the same property names the current-state write uses, so the claim engine
 * sees one timeline per property with the newest observation winning.
 */
export function dealHistoryFacts(
  dealId: string,
  history: Record<string, HubspotHistoryEntry[]> | null | undefined,
  stageIndex: Map<string, StageIndexEntry> | null,
): HistoryFact[] {
  const out: HistoryFact[] = [];
  const key = (prop: string, ts: string) => `hubspot:deal:${dealId}:${prop}:${ts}`;
  for (const e of history?.dealstage ?? []) {
    if (!e?.timestamp) continue;
    const st = stageIndex?.get(String(e.value)) ?? null;
    out.push({
      property: 'stage',
      value: st?.label ?? String(e.value),
      observedAt: e.timestamp,
      externalId: key('dealstage', e.timestamp),
      raw: { stage_id: String(e.value), status: st ? (st.isWon ? 'won' : st.isLost ? 'lost' : 'open') : null, source_type: e.sourceType ?? null },
    });
  }
  for (const e of history?.amount ?? []) {
    if (!e?.timestamp || e.value == null || e.value === '') continue;
    const n = Number(e.value);
    if (!Number.isFinite(n)) continue;
    out.push({ property: 'value', value: n, observedAt: e.timestamp, externalId: key('amount', e.timestamp), raw: { source_type: e.sourceType ?? null } });
  }
  for (const e of history?.closedate ?? []) {
    if (!e?.timestamp || !e.value) continue;
    out.push({ property: 'close_date', value: e.value, observedAt: e.timestamp, externalId: key('closedate', e.timestamp), raw: { source_type: e.sourceType ?? null } });
  }
  return out;
}

/** A contact's lifecycle history → observations. Lead → MQL → SQL → opportunity → customer, dated. */
export function contactHistoryFacts(
  contactId: string,
  history: Record<string, HubspotHistoryEntry[]> | null | undefined,
): HistoryFact[] {
  const out: HistoryFact[] = [];
  const key = (prop: string, ts: string) => `hubspot:contact:${contactId}:${prop}:${ts}`;
  for (const e of history?.lifecyclestage ?? []) {
    if (!e?.timestamp || !e.value) continue;
    out.push({ property: 'lifecycle_stage', value: String(e.value), observedAt: e.timestamp, externalId: key('lifecyclestage', e.timestamp), raw: { source_type: e.sourceType ?? null } });
  }
  for (const e of history?.hs_lead_status ?? []) {
    if (!e?.timestamp || !e.value) continue;
    out.push({ property: 'lead_status', value: String(e.value), observedAt: e.timestamp, externalId: key('hs_lead_status', e.timestamp), raw: { source_type: e.sourceType ?? null } });
  }
  return out;
}

// ─── HubSpot engagements (calls, emails, meetings, notes) ────────────────────
//
// Engagements are first-class CRM objects with the same search endpoint as contacts, so the
// same "modified since" incremental pull works. They carry no contact on the record; the
// v4 associations API links each one to its contacts / companies / deals.

export const HUBSPOT_ENGAGEMENT_OBJECTS = ['calls', 'emails', 'meetings', 'notes'] as const;
export type HubspotEngagementObject = typeof HUBSPOT_ENGAGEMENT_OBJECTS[number];

// hs_ai_summary / hs_call_summary / hs_meeting_summary are HubSpot's own Conversation
// Intelligence output, and they are plain properties: no extra scope, no extensions API.
// They are the guaranteed floor for call content (see docs on transcripts).
export const HUBSPOT_ENGAGEMENT_PROPS: Record<HubspotEngagementObject, string[]> = {
  calls: ['hs_call_title', 'hs_call_body', 'hs_call_duration', 'hs_call_direction', 'hs_call_status',
    'hs_call_disposition', 'hs_call_source', 'hs_call_app_id', 'hs_call_recording_url',
    'hs_call_video_recording_url', 'hs_call_has_transcript', 'hs_call_transcription_id',
    'hs_ai_summary', 'hs_call_summary', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  // hs_email_html as well as hs_email_text: HubSpot leaves the TEXT field empty for an HTML-only
  // message, which is what a real person's mail client sends. Asking for text alone cost one customer
  // the body of about a third of its received email — and a few percent of its sent, because our own sends go out
  // through HubSpot and do populate text. The asymmetry is the tell (GET-396).
  emails: ['hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_direction', 'hs_email_status',
    // Which conversation it belongs to, and who was on it: kept so a row can be placed in its
    // thread without storing the thread's text on every message (GET-277).
    'hs_email_thread_id', 'hs_email_from_email', 'hs_email_to_email',
    'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_internal_meeting_notes', 'hs_meeting_start_time',
    'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_meeting_source', 'hs_meeting_recording_url',
    'hs_has_meeting_transcript', 'hs_meeting_transcription_id', 'hs_has_call_with_transcript',
    'hs_ai_summary', 'hs_meeting_summary', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
  notes: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id', 'hs_lastmodifieddate'],
};

export interface HubspotEngagementRaw {
  id: string;
  properties: Record<string, any>;
  /** hs_lastmodifieddate, so the windowed pager can resume past the search ceiling. */
  updated_at?: string | null;
}

/** Search any HubSpot object with an explicit property list; ascending by hs_lastmodifieddate. */
export async function hubspotSearchObject(
  token: string,
  object: string,
  properties: string[],
  opts: FetchOpts,
): Promise<FetchResult<HubspotEngagementRaw>> {
  if (opts.ids) {
    const { results, cursor } = await hubspotReadIds(token, object, properties, opts);
    return {
      records: results.map((r: any) => ({ id: String(r.id), properties: r.properties ?? {}, updated_at: r.properties?.hs_lastmodifieddate ?? null })),
      cursor,
    };
  }
  const body: any = {
    properties,
    limit: Math.min(opts.limit ?? 100, 200),
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
  };
  const filters: any[] = [];
  if (opts.since) filters.push({ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: new Date(opts.since).getTime() });
  // WHEN IT HAPPENED, not when it was last edited (GET-285). A portal can hold hundreds of thousands of calls; the
  // ones worth importing are the year's, and asking for them by timestamp is the difference
  // between walking the whole history and walking the window.
  if (opts.minTimestamp) filters.push({ propertyName: 'hs_timestamp', operator: 'GTE', value: new Date(opts.minTimestamp).getTime() });
  if (opts.maxTimestamp) filters.push({ propertyName: 'hs_timestamp', operator: 'LT', value: new Date(opts.maxTimestamp).getTime() });
  if (filters.length) body.filterGroups = [{ filters }];
  if (opts.cursor) body.after = opts.cursor;
  const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(object)}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, token);
  if (!res.ok) throw new Error(`HubSpot ${object} ${res.status} — ${await res.text().catch(() => '')}`);
  const d: any = await res.json();
  return {
    records: (d.results ?? []).map((r: any) => ({
      id: String(r.id), properties: r.properties ?? {}, updated_at: r.properties?.hs_lastmodifieddate ?? null,
    })),
    cursor: d.paging?.next?.after ?? null,
  };
}

/** from-object ids → ALL associated to-object ids, via one v4 batch read per 100 ids. */
export async function hubspotAssociations(
  token: string,
  from: string,
  to: string,
  ids: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const res = await hubspotFetch(`https://api.hubapi.com/crm/v4/associations/${encodeURIComponent(from)}/${encodeURIComponent(to)}/batch/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: chunk.map(id => ({ id: String(id) })) }),
      }, token);
      if (!res.ok) continue;
      const d: any = await res.json();
      for (const row of d?.results ?? []) {
        const fromId = row?.from?.id ?? row?._from?.id;
        if (!fromId) continue;
        const targets = (row?.to ?? []).map((t: any) => String(t?.toObjectId ?? t?.id)).filter(Boolean);
        if (targets.length) out.set(String(fromId), targets);
      }
    } catch { /* fail soft: the engagement attaches by whatever links did resolve */ }
  }
  return out;
}

const stripHtml = (s: unknown): string => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export interface MappedEngagement {
  /** Nous activity type. Deterministic from the engagement's own direction / outcome. */
  type: string;
  occurredAt: string;
  description: string;
  summary: string | null;
  /** Long-form content worth keeping as a document (HubSpot's AI summary, notes, body). */
  text: string | null;
  docType: 'meeting_notes' | 'note' | null;
  ownerExternalId: string | null;
  meta: Record<string, unknown>;
}

/**
 * One HubSpot engagement → one Nous activity (plus an optional document). Pure and
 * exported for tests. Returns null for records that carry nothing usable (no timestamp).
 *
 * Type vocabulary matches what the webhook handlers already write, so the intelligence
 * jobs (cadence, days-since-touch, follow-up persistence) see HubSpot history exactly like
 * live email/meeting webhooks: email_sent / email_received / meeting_held /
 * meeting_scheduled / meeting_cancelled. Calls and notes are new: call_made /
 * call_received / call_missed / note_added.
 */
export function hubspotEngagementToActivity(object: HubspotEngagementObject, raw: HubspotEngagementRaw): MappedEngagement | null {
  const p = raw.properties ?? {};
  const occurredAt: string | null = (object === 'meetings' ? (p.hs_meeting_start_time || p.hs_timestamp) : p.hs_timestamp) || null;
  if (!occurredAt) return null;
  const owner = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
  const aiSummary: string | null = stripHtml(p.hs_ai_summary) || null;

  if (object === 'calls') {
    const dir = String(p.hs_call_direction ?? '').toUpperCase();
    const status = String(p.hs_call_status ?? '').toUpperCase();
    const type = status && status !== 'COMPLETED' && status !== 'IN_PROGRESS'
      ? 'call_missed'                                  // BUSY, NO_ANSWER, FAILED, CANCELED, MISSED, QUEUED…
      : dir === 'INBOUND' ? 'call_received' : 'call_made';
    const body = stripHtml(p.hs_call_body);
    const summary = aiSummary ?? (stripHtml(p.hs_call_summary) || null);
    const text = [summary ? `Summary\n${summary}` : null, body ? `Notes\n${body}` : null].filter(Boolean).join('\n\n') || null;
    return {
      type, occurredAt,
      description: stripHtml(p.hs_call_title) || (type === 'call_received' ? 'Inbound call' : 'Call'),
      summary: summary ?? (body ? body.slice(0, 300) : null),
      // The body rides on rawData, never as a DOCUMENT (GET-282). A CRM's call and meeting notes
      // are a copy of what the note-taker already wrote, and the note-taker is the source we pull
      // from properly: two copies of one conversation is a Meetings tab nobody can read and an
      // extractor paying twice. Everything that reads content reads the activity.
      text: null, docType: null, ownerExternalId: owner,
      meta: {
        body: text ? text.slice(0, 20_000) : null,
        duration_ms: p.hs_call_duration != null ? Number(p.hs_call_duration) : null,
        direction: dir || null, status: status || null, disposition: p.hs_call_disposition ?? null,
        call_source: p.hs_call_source ?? null, app_id: p.hs_call_app_id ?? null,
        recording_url: p.hs_call_recording_url ?? p.hs_call_video_recording_url ?? null,
        has_transcript: p.hs_call_has_transcript === true || p.hs_call_has_transcript === 'true',
        transcription_id: p.hs_call_transcription_id ?? null,
      },
    };
  }

  if (object === 'emails') {
    const dir = String(p.hs_email_direction ?? '').toUpperCase();
    const type = dir === 'INCOMING_EMAIL' ? 'email_received' : 'email_sent';
    // This email only: HubSpot stores the whole thread in the body, and keeping it would file the
    // same conversation again on every reply (GET-277). The other messages are their own rows.
    // Text when HubSpot has it, the HTML body when it does not — through messageBodyText, which
    // drops <script>/<style>/<head>, turns block tags into line breaks and decodes numeric
    // entities. The local stripHtml does none of that: run real HTML mail through it and the
    // stylesheet becomes the body text (GET-249 named that trap; GET-396 walked into it).
    const body = messageBodyText(p.hs_email_text || p.hs_email_html, { preview: true });
    return {
      type, occurredAt,
      description: stripHtml(p.hs_email_subject) || '(no subject)',
      summary: body ? body.slice(0, 300) : null,
      text: null, docType: null, ownerExternalId: owner,   // the body rides on rawData; not a document
      meta: {
        direction: dir || null, status: p.hs_email_status ?? null,
        thread_id: p.hs_email_thread_id ?? null,
        from: p.hs_email_from_email ?? null,
        to: p.hs_email_to_email ?? null,
        body: body ? body.slice(0, 20_000) : null,
      },
    };
  }

  if (object === 'meetings') {
    const outcome = String(p.hs_meeting_outcome ?? '').toUpperCase();
    const inFuture = Date.parse(occurredAt) > Date.now();
    const type = outcome === 'CANCELED' || outcome === 'CANCELLED' ? 'meeting_cancelled'
      : outcome === 'NO_SHOW' ? 'meeting_no_show'
      : outcome === 'COMPLETED' ? 'meeting_held'
      : outcome === 'RESCHEDULED' || outcome === 'SCHEDULED' || inFuture ? 'meeting_scheduled'
      : 'meeting_held';                                  // past, no outcome recorded: it happened
    const summary = aiSummary ?? (stripHtml(p.hs_meeting_summary) || null);
    const body = stripHtml(p.hs_meeting_body);
    const internal = stripHtml(p.hs_internal_meeting_notes);
    const text = [summary ? `Summary\n${summary}` : null, body ? `Description\n${body}` : null, internal ? `Internal notes\n${internal}` : null]
      .filter(Boolean).join('\n\n') || null;
    return {
      type, occurredAt,
      description: stripHtml(p.hs_meeting_title) || 'Meeting',
      summary: summary ?? (body ? body.slice(0, 300) : null),
      text: null, docType: null, ownerExternalId: owner,   // body on rawData, not a document (GET-282)
      meta: {
        body: text ? text.slice(0, 20_000) : null,
        outcome: outcome || null, end_time: p.hs_meeting_end_time ?? null, meeting_source: p.hs_meeting_source ?? null,
        recording_url: p.hs_meeting_recording_url ?? null,
        has_transcript: p.hs_has_meeting_transcript === true || p.hs_has_meeting_transcript === 'true',
        transcription_id: p.hs_meeting_transcription_id ?? null,
        call_with_transcript: p.hs_has_call_with_transcript ?? null,
      },
    };
  }

  // notes
  const body = stripHtml(p.hs_note_body);
  if (!body) return null;
  return {
    type: 'note_added', occurredAt,
    description: body.slice(0, 120),
    summary: body.slice(0, 300),
    text: null, docType: null, ownerExternalId: owner,   // body on rawData, not a document (GET-282)
    meta: { body: body.slice(0, 20_000) },
  };
}

// ─── HubSpot call intelligence: transcripts + Notetaker recap ────────────────
//
// Three tiers, established live on 2026-09-09 (see scripts/hubspot-profile.mjs):
//   1. hs_ai_summary / hs_call_summary / hs_meeting_summary — plain properties, always
//      readable. Already captured by hubspotEngagementToActivity. The guaranteed floor.
//   2. The Notetaker recap: GET /notetaker/2026-09/conversation/recap/{0-47|0-48}/{id}.
//      Real endpoint, our key auths, GATED on the portal's tier. Returns summary, ACTION
//      ITEMS, QUESTIONS ASKED, participants, recording URL — two audit findings, pre-extracted.
//   3. Raw transcript: GET /crm/v3/extensions/calling/transcripts/{transcriptionId}. A read
//      path (TranscriptGetError on a bad id), but whether it serves HubSpot-generated
//      transcripts to a non-owning app is unconfirmed. Tried, never relied on.
// Everything here fails soft and counts what it saw, so the sync result says exactly which
// tier a portal actually delivered.

/** Pull plain text out of whatever shape the transcript endpoint returns. Exported for tests. */
export function normalizeHubspotTranscript(body: any): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body.trim() || null;
  const direct = body.transcript ?? body.text ?? body.content ?? body.fullTranscript ?? body.full_transcript ?? null;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const segs = body.segments ?? body.utterances ?? body.sentences ?? body.lines
    ?? (typeof body.transcript === 'object' ? (body.transcript?.segments ?? body.transcript?.utterances) : null)
    ?? body.results ?? null;
  if (Array.isArray(segs) && segs.length) {
    const lines = segs.map((s: any) => {
      const text = s?.text ?? s?.content ?? s?.transcript ?? s?.sentence ?? '';
      if (!text) return null;
      const who = s?.speaker ?? s?.speakerName ?? s?.speaker_name ?? s?.participant ?? s?.speakerLabel ?? null;
      return who ? `${who}: ${text}` : String(text);
    }).filter((l: string | null): l is string => !!l);
    if (lines.length) return lines.join('\n');
  }
  return null;
}

export async function fetchHubspotTranscript(
  token: string,
  transcriptionId: string | number,
): Promise<{ text: string | null; status: number; raw: unknown }> {
  const res = await hubspotFetch(
    `https://api.hubapi.com/crm/v3/extensions/calling/transcripts/${encodeURIComponent(String(transcriptionId))}`, {}, token,
  );
  const txt = await res.text().catch(() => '');
  let raw: any = null;
  try { raw = JSON.parse(txt); } catch { raw = txt; }
  if (!res.ok) return { text: null, status: res.status, raw };
  return { text: normalizeHubspotTranscript(raw), status: res.status, raw };
}

export interface HubspotRecap {
  summary: string | null;
  actionItems: string[];
  questions: string[];
  participants: string[];
  recordingUrl: string | null;
  raw: unknown;
}

/** Normalise the recap payload. Field names are from the docs; the shape is defended, not assumed. */
export function normalizeHubspotRecap(body: any): HubspotRecap | null {
  if (!body || typeof body !== 'object') return null;
  const str = (v: any): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    const s = v.text ?? v.content ?? v.title ?? v.description ?? v.name ?? v.email ?? null;
    return typeof s === 'string' && s.trim() ? s.trim() : null;
  };
  const list = (v: any): string[] => Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : (str(v) ? [str(v) as string] : []);
  const root = body.recap && typeof body.recap === 'object' ? { ...body, ...body.recap } : body;
  const summary = str(root.summary) ?? str(root.overview) ?? null;
  const actionItems = list(root.actionItems ?? root.action_items ?? root.nextSteps ?? root.next_steps);
  const questions = list(root.questionsAsked ?? root.questions_asked ?? root.questions);
  const participants = list(root.participants ?? root.attendees);
  const recordingUrl = root.recordingUrl ?? root.recording_url ?? root.recording?.url ?? null;
  if (!summary && !actionItems.length && !questions.length) return null;
  return { summary, actionItems, questions, participants, recordingUrl: typeof recordingUrl === 'string' ? recordingUrl : null, raw: body };
}

export async function fetchHubspotRecap(
  token: string,
  objectTypeId: '0-47' | '0-48',
  objectId: string,
): Promise<{ recap: HubspotRecap | null; status: number; gated: boolean }> {
  const res = await hubspotFetch(
    `https://api.hubapi.com/notetaker/2026-09/conversation/recap/${objectTypeId}/${encodeURIComponent(objectId)}`, {}, token,
  );
  const txt = await res.text().catch(() => '');
  let raw: any = null;
  try { raw = JSON.parse(txt); } catch { raw = null; }
  const gated = res.status === 403 && raw?.category === 'GATED';
  if (!res.ok) return { recap: null, status: res.status, gated };
  return { recap: normalizeHubspotRecap(raw), status: res.status, gated: false };
}

/** The recap as a readable document body: what was said, what was promised, what was asked. */
export function recapToDocument(recap: HubspotRecap): string {
  const parts: string[] = [];
  if (recap.summary) parts.push(`Summary\n${recap.summary}`);
  if (recap.actionItems.length) parts.push(`Action items\n${recap.actionItems.map(a => `- ${a}`).join('\n')}`);
  if (recap.questions.length) parts.push(`Questions asked\n${recap.questions.map(q => `- ${q}`).join('\n')}`);
  if (recap.participants.length) parts.push(`Participants\n${recap.participants.join(', ')}`);
  return parts.join('\n\n');
}

// ─── Deal stage timeline (from the history observations) ─────────────────────
//
// The stage history written by writeHistory lands on the DEAL entity as dated `stage`
// observations (label in value, id + verdict in raw). These pure helpers turn that into
// "how long did this deal sit in each stage", which is the substrate for the stall and
// slip findings. Kept label-based on purpose: the audit speaks the customer's stage names.

export interface DealStageObservation {
  value: unknown;                       // the stage label
  observed_at: string;
  raw?: { stage_id?: string | null; status?: 'won' | 'lost' | 'open' | null } | null;
}

export interface DealStageHop {
  label: string;
  stageId: string | null;
  status: 'won' | 'lost' | 'open';
  at: string;
}

/** Chronological hops, one per stage change. Duplicate timestamps keep the last write. */
export function dealStageHops(observations: DealStageObservation[]): DealStageHop[] {
  const byTime = new Map<string, DealStageHop>();
  for (const o of observations) {
    const at = o.observed_at;
    if (!at || !Number.isFinite(Date.parse(at))) continue;
    const label = typeof o.value === 'string' ? o.value : String((o.value as any)?.label ?? o.value ?? '');
    if (!label) continue;
    const status = o.raw?.status === 'won' || o.raw?.status === 'lost' ? o.raw.status : 'open';
    byTime.set(at, { label, stageId: o.raw?.stage_id ?? null, status, at });
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * When the deal ENTERED the stage it is in now: the first hop of the newest run of one stage.
 *
 * Not the newest stage observation. The sync writes the current stage again every time the deal is
 * touched in the CRM (an edit, a note, a property change), dated to that touch, so the newest row
 * is "last edited", not "moved here". Read that way, a deal that entered Qualified on Sep 22 and
 * was edited on Oct 1 showed "2 days in stage" beside a stage strip saying 11. Same stage = same stage id when both carry one, else the same label
 * ignoring case and surrounding space (a portal can write " First Call" with a leading space).
 */
export function stageEnteredAt(observations: DealStageObservation[]): string | null {
  const hops = dealStageHops(observations);
  if (!hops.length) return null;
  const same = (a: DealStageHop, b: DealStageHop) =>
    (a.stageId && b.stageId) ? a.stageId === b.stageId : a.label.trim().toLowerCase() === b.label.trim().toLowerCase();
  const last = hops[hops.length - 1];
  let i = hops.length - 1;
  while (i > 0 && same(hops[i - 1], last)) i--;
  return hops[i].at;
}

export interface DealStageOccupancy {
  label: string;
  stageId: string | null;
  days: number;
  /** Still sitting there (no later hop) — a lower bound, not a duration. */
  censored: boolean;
  enteredAt: string;
}

/** Days spent in each open stage. A closed stage (won/lost) ends the timeline and is not an occupancy. */
export function dealStageOccupancies(hops: DealStageHop[], opts: { now?: number } = {}): DealStageOccupancy[] {
  const now = opts.now ?? Date.now();
  const out: DealStageOccupancy[] = [];
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (h.status !== 'open') break;
    const start = Date.parse(h.at);
    const next = hops[i + 1];
    const end = next ? Date.parse(next.at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ label: h.label, stageId: h.stageId, days: Math.max(0, (end - start) / 86_400_000), censored: !next, enteredAt: h.at });
  }
  return out;
}

/** How many times a deal moved BACKWARDS (a later hop to an earlier rung) — the slip count. */
export function dealStageRegressions(hops: DealStageHop[], order: string[]): number {
  const rank = new Map(order.map((id, i) => [id, i]));
  let regressions = 0;
  for (let i = 1; i < hops.length; i++) {
    const a = rank.get(hops[i - 1].stageId ?? ''), b = rank.get(hops[i].stageId ?? '');
    if (a != null && b != null && b < a) regressions++;
  }
  return regressions;
}

// ─── HubSpot commerce: line items, subscriptions, invoices ───────────────────
//
// "What did this account actually buy" is the substrate for upsell and cross-sell: an
// account that bought A while its peers bought A+B, and was never pitched B, is a finding.
// Line items hang off deals; subscriptions and invoices off companies (contacts as a
// fallback, resolved to their company). Each record becomes ONE state observation on the
// target entity, value = the record's populated properties, so the audit can read it
// without a second schema. Property lists are best-effort: HubSpot ignores names it does
// not know (verified live: a request naming 200 nonexistent properties was accepted), so an
// unknown field simply comes back absent rather than failing the sync.

export const HUBSPOT_COMMERCE = {
  line_items: {
    to: 'deals' as const, property: 'line_item',
    props: ['name', 'hs_sku', 'quantity', 'price', 'amount', 'discount', 'hs_product_id', 'description',
      'hs_recurring_billing_period', 'hs_recurring_billing_start_date', 'hs_term_in_months', 'createdate', 'hs_lastmodifieddate'],
  },
  subscriptions: {
    to: 'companies' as const, property: 'subscription',
    props: ['hs_name', 'name', 'hs_status', 'hs_recurring_billing_start_date', 'hs_next_payment_due_date',
      'hs_last_payment_amount', 'hs_next_payment_amount', 'hs_currency_code', 'hs_recurring_billing_frequency',
      'hs_payment_method', 'createdate', 'hs_lastmodifieddate',
      // When the committed term ends, which is the renewal (accountHealth.ts renewalFromSubscriptions).
      'hs_recurring_billing_end_date'],
  },
  invoices: {
    to: 'companies' as const, property: 'invoice',
    props: ['hs_invoice_number', 'hs_number', 'hs_invoice_status', 'hs_amount_billed', 'hs_balance_due', 'hs_currency',
      'hs_invoice_date', 'hs_due_date', 'hs_invoice_source', 'createdate', 'hs_lastmodifieddate'],
  },
} as const;
export type HubspotCommerceObject = keyof typeof HUBSPOT_COMMERCE;

/**
 * Commerce objects a sync does NOT import (GET-283). Subscriptions say what a customer pays now
 * and when it renews; line items say what is in a deal. An invoice says what was billed and what
 * is outstanding — accounting's record, not a sales one, and the heaviest object in a portal
 * (typically many times more of them than subscriptions).
 */
const SKIP_COMMERCE = new Set<string>(['invoices']);

/** Populated properties only, numbers coerced, plus a normalised name/amount so the audit has one key to read. */
export function commerceRecordToValue(
  object: HubspotCommerceObject,
  raw: HubspotEngagementRaw,
  productNames?: Map<string, string> | null,
): Record<string, unknown> {
  const p = raw.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === '' || k === 'hs_lastmodifieddate' || k === 'createdate') continue;
    const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    out[k] = n;
  }
  out.hubspot_id = raw.id;
  out.name = out.name ?? out.hs_name ?? out.hs_invoice_number ?? out.hs_number ?? null;
  // The provider's own id for the PRODUCT, beside the name someone typed for it. Normalised
  // here, next to name and amount, so every reader groups purchases the same way without
  // learning a provider's field names. See lineItemProduct for why the name cannot be the key.
  if (object === 'line_items') {
    out.product_key = out.hs_product_id != null ? String(out.hs_product_id) : null;
    // What the product is actually called, when the catalog knows it. Absent for a deleted
    // product or an ad-hoc line, and every reader falls back to the typed name in that case.
    out.product_name = out.product_key ? (productNames?.get(out.product_key as string) ?? null) : null;
  }
  out.amount = object === 'invoices' ? (out.hs_amount_billed ?? null)
    : object === 'subscriptions' ? (out.hs_next_payment_amount ?? out.hs_last_payment_amount ?? null)
    : (out.amount ?? (typeof out.price === 'number' && typeof out.quantity === 'number' ? out.price * out.quantity : null));
  return out;
}

/**
 * Which PRODUCT a line item is, as opposed to what somebody typed in its name field.
 *
 * Reps retype product names. One product can be filed under "Harbor Desk", "Harbor Desk Pro
 * (annual)" and "Harbor Desk (second site)". Grouping on the name turns one product with four buyers into three
 * products with one buyer each, which clears no peer threshold, so the cross-sell finding is
 * never made — and an empty result reads as "no opportunity here", not as a miscount. Group
 * on the provider's product id instead.
 *
 * `key` is for grouping and is never shown; `label` is what a human reads. They are separate
 * because one id legitimately carries several typed names and a report has to print one.
 *
 * Reads rows written before `product_key` existed — their `hs_product_id` is already stored —
 * so the correction applies to everything already synced, with no re-import.
 *
 * A line item with NO product id falls back to its own name rather than to a shared bucket.
 * The ad-hoc rows ("Spring discount", "Onboarding package - $500") are genuinely different things, and absent
 * an id from the CRM we have no grounds to declare any two of them the same product.
 */
export function lineItemProduct(value: unknown): { key: string; label: string; canonical: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => (x == null ? '' : String(x).trim());
  // The catalog's name first, then whatever a rep typed. `canonical` tells a caller which
  // it got, so a report can prefer a real product name over a popular typo without guessing.
  const canonical = text(v.product_name);
  const label = canonical || text(v.name) || text(v.hs_sku);
  // An all-digit id is coerced to a number on the way in, so it is stringified rather than
  // compared as one. The id:/name: prefixes stop a product literally named "10000000001"
  // from merging with the product whose id that is.
  const id = text(v.product_key) || text(v.hs_product_id);
  if (id) return { key: `id:${id}`, label: label || id, canonical: !!canonical };
  if (!label) return null;
  return { key: `name:${label.toLowerCase().replace(/\s+/g, ' ')}`, label, canonical: false };
}

/** Persist a discovered schema. Quiet if the table has not been migrated yet. */
export async function storeCrmPropertySchema(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  objectType: string,
  properties: CrmPropertyDef[],
): Promise<boolean> {
  const { error } = await supabase.from('crm_property_schemas').upsert({
    workspace_id: workspaceId, provider, object_type: objectType,
    properties, custom_count: properties.filter(p => p.custom).length,
    fetched_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,provider,object_type' });
  if (!error) return true;
  if (error.code === '42P01' || error.code === 'PGRST205') return false;   // migration not applied
  throw new Error(error.message);
}

/**
 * Pull a CRM's pipeline stage DEFINITIONS (not a deal's current stage). HubSpot and Attio;
 * Pipedrive throws until wired. Returns one entry per pipeline.
 */
export async function fetchPipelineStages(provider: CrmProvider, token: string): Promise<CrmPipeline[]> {
  if (provider === 'attio') return fetchAttioPipelineStages(token);
  if (provider === 'hubspot') return fetchHubspotPipelineStages(token);
  if (provider === 'salesforce') return fetchSalesforcePipelineStages(token);
  throw new Error(`fetchPipelineStages is not implemented for ${provider} yet`);
}

/**
 * Adopt the CRM's own stage vocabulary as the workspace's stages, so the board speaks the
 * customer's language the moment their CRM connects. Deterministic: their labels verbatim,
 * won/lost from the provider's flags, canonical rank from mapToCanonical.
 *
 * Never clobbers a hand-edited set: adopts only when the workspace has no stages yet, or
 * when every existing stage came from a CRM (a refresh). Uses the primary pipeline (first by
 * display order). Returns the saved stages, or null when it left things alone.
 */
export async function adoptCrmStages(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  token: string,
): Promise<WorkspaceStage[] | null> {
  const pipelines = await fetchPipelineStages(provider, token);
  // The same definition of "primary" the sync records on crm_sync_configs, so the adopted
  // ladder and the funnel filter can never disagree about which pipeline the workspace is.
  const primary = pickPrimaryPipeline(provider, pipelines);
  if (!primary?.stages.length) return null;

  // EVERY pipeline gets its vocabulary, not just the primary one.
  //
  // Storing one ladder is why a board mixing funnels had no way to name the others: one customer's
  // hundreds of deals outside its primary pipeline sit in a score of stages the workspace had never heard of, so
  // each ranked 1000 and painted itself the same fallback colour as a stage we do know.
  //
  // The primary lands under a NULL pipeline_ref — the workspace's own ladder — so every existing
  // reader keeps seeing exactly what it sees today. The rest land under their CRM id.
  const adopt = async (p: CrmPipeline, ref: string | null): Promise<WorkspaceStage[] | null> => {
    // Never clobber a hand-edited set, per pipeline rather than per workspace: someone renaming
    // their sales stages should not freeze the vocabulary of a pipeline they have never touched.
    const existing = await getWorkspaceStages(supabase, workspaceId, { pipelineRef: ref });
    const ownScope = existing.filter(s => (s.pipeline_ref ?? null) === ref);
    if (ownScope.length && ownScope.some(s => s.source !== 'crm')) {
      // Say so. This used to return null silently, and a workspace whose CRM labels never
      // appeared looked identical to one whose CRM had never been read.
      console.warn(`[adoptCrmStages] kept hand-edited stages for ${workspaceId} pipeline ${ref ?? '(workspace)'}`);
      return null;
    }

    const total = p.stages.length;
    // A pipeline is ordered, so the canonical rank must never go backwards along it. Keyword
    // mapping alone read "Presentation Scheduled" (after "Qualified To Buy") as meeting_booked,
    // a rung BELOW discovery. Clamp each open stage to at least the rank of the one before it.
    const ladderRank = new Map(CANONICAL_ACTIVE_ORDER.map((c, i) => [c, i]));
    let floor = 0;
    const stages: WorkspaceStage[] = p.stages.map((st, i) => {
      let canonical = mapToCanonical(st.label, { order: i, total, isWon: st.isWon, isLost: st.isLost });
      if (!st.isWon && !st.isLost && ladderRank.has(canonical)) {
        const rank = Math.max(ladderRank.get(canonical)!, floor);
        canonical = CANONICAL_ACTIVE_ORDER[rank];
        floor = rank;
      }
      return {
        key: '', label: st.label, canonical, sort_order: i,
        // `kind` comes from the provider's flags, `canonical` can come from the label. They
        // disagree when a CRM forgets to mark a stage closed — one customer's Expansion `Won` is
        // probability 0.9 and isClosed "false" — so a stage reading closed_won would have been
        // stored as kind 'active'. Trust the canonical reading for kind too, since it already
        // had the provider's flags as its first input.
        kind: st.isWon ? 'won' : st.isLost ? 'lost'
          : canonical === 'closed_won' ? 'won'
          : (canonical === 'closed_lost' || canonical === 'disqualified') ? 'lost'
          : canonical === 'churned' ? 'churned' : 'active',
        is_signup_default: i === 0,
        source: 'crm',
        external_ref: st.external_ref,
      };
    });
    return saveWorkspaceStages(supabase, workspaceId, stages, { pipelineRef: ref });
  };

  const adopted = await adopt(primary, null);
  for (const p of pipelines) {
    if (p.id === primary.id || !p.stages.length) continue;
    // One pipeline's vocabulary failing is not a reason to have none of the others.
    try { await adopt(p, String(p.id)); }
    catch (err) { console.warn(`[adoptCrmStages] ${workspaceId} pipeline ${p.id}:`, (err as Error).message); }
  }
  return adopted;
}

// ─── Single-record field read (CRM hygiene reconcile) ────────────────────────
// Read ONE record's reconcilable free-text fields by id. Read-only. Only the
// fields a provider exposes as STANDARD attributes are returned (a key present
// = reconcilable on this provider); enum/custom/relationship fields are omitted
// so reconcile simply doesn't touch them. See docs/crm-hygiene-phase-1b-spec.md.

export interface CrmRecordFields {
  job_title?: string | null;
  company?: string | null;
  phone?: string | null;
}

export async function fetchCrmRecordFields(
  provider: CrmProvider,
  token: string,
  recordId: string,
): Promise<CrmRecordFields | null> {
  if (provider === 'hubspot') {
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(recordId)}?properties=jobtitle,company,phone`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HubSpot get contact ${res.status} — ${await res.text().catch(() => '')}`);
    const p = (await res.json()).properties || {};
    return { job_title: p.jobtitle ?? null, company: p.company ?? null, phone: p.phone ?? null };
  }
  if (provider === 'pipedrive') {
    const res = await fetch(
      `https://api.pipedrive.com/v1/persons/${encodeURIComponent(recordId)}?api_token=${encodeURIComponent(token)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Pipedrive get person ${res.status}`);
    const r = (await res.json()).data || {};
    // job_title is not a standard Pipedrive person field (custom) — omit it.
    return { company: r.org_name ?? r.organization?.name ?? null, phone: r.phone?.[0]?.value ?? null };
  }
  if (provider === 'attio') {
    const res = await fetch(
      `https://api.attio.com/v2/objects/people/records/${encodeURIComponent(recordId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Attio get record ${res.status} — ${await res.text().catch(() => '')}`);
    const v = (await res.json()).data?.values || {};
    // company is a linked relationship in Attio — omit (not a free-text field).
    return {
      job_title: v.job_title?.[0]?.value ?? null,
      phone:     v.phone_numbers?.[0]?.phone_number ?? null,
    };
  }
  return null;
}

// ─── Single-record field WRITE (CRM hygiene apply, Phase 2) ──────────────────
// PATCH one record's reconciled free-text fields. THIS WRITES TO A LIVE CRM.
// Only writes fields the provider exposes as standard writable attributes;
// company (Pipedrive/Attio relationship) and enum/custom fields are not written.
// NOTE: payload shapes are per current provider API docs but are not yet
// runtime-verified — test on a throwaway record first.

const WRITE_FIELD_MAP: Record<CrmProvider, Record<string, string>> = {
  hubspot:   { job_title: 'jobtitle', company: 'company', phone: 'phone' },
  pipedrive: { phone: 'phone' },                 // company=org relationship, job_title=custom → not written
  attio:     { job_title: 'job_title', phone: 'phone' },
  salesforce: {},                                // write-back not wired for Salesforce
};

export async function writeCrmRecordFields(
  provider: CrmProvider,
  token: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const map = WRITE_FIELD_MAP[provider] || {};
  const writable = Object.entries(fields).filter(([k]) => k in map);
  if (!writable.length) return { ok: false, error: `no writable field for ${provider} in ${Object.keys(fields).join(',')}` };

  if (provider === 'hubspot') {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of writable) properties[map[k]] = v;
    const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(recordId)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HubSpot PATCH ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
  }
  if (provider === 'pipedrive') {
    const body: Record<string, unknown> = {};
    for (const [k, v] of writable) if (map[k] === 'phone') body.phone = [{ value: String(v), primary: true, label: 'work' }];
    const res = await fetch(`https://api.pipedrive.com/v1/persons/${encodeURIComponent(recordId)}?api_token=${encodeURIComponent(token)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Pipedrive PUT ${res.status}` };
  }
  if (provider === 'attio') {
    const values: Record<string, unknown> = {};
    for (const [k, v] of writable) {
      if (map[k] === 'job_title') values.job_title = [{ value: v }];
      // Attio's phone-number type is written with `original_phone_number` (E.164),
      // even though it's READ back as `phone_number`.
      if (map[k] === 'phone')     values.phone_numbers = [{ original_phone_number: String(v) }];
    }
    const res = await fetch(`https://api.attio.com/v2/objects/people/records/${encodeURIComponent(recordId)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { values } }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Attio PATCH ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
  }
  return { ok: false, error: `unknown provider ${provider}` };
}

// ─── ICP write-back (Phase 2): provision nous_icp_* fields, then write ───────
// Nous OWNS a namespaced field set rather than overwriting a team's own ICP
// field. Provisioning is idempotent (create; ignore "already exists"). HubSpot +
// Attio only for now — Pipedrive needs custom-field key handling. Payloads per
// API docs, NOT runtime-verified.

const ICP_FIELDS = [
  { key: 'nous_icp_score',     label: 'Nous ICP Score',     hsType: 'number',   hsField: 'number', attioType: 'number' },
  { key: 'nous_icp_fit',       label: 'Nous ICP Fit',       hsType: 'string',   hsField: 'text',   attioType: 'checkbox' },
  { key: 'nous_icp_scored_at', label: 'Nous ICP Scored At', hsType: 'datetime', hsField: 'date',   attioType: 'timestamp' },
  { key: 'nous_icp_reason',    label: 'Nous ICP Reason',    hsType: 'string',   hsField: 'text',   attioType: 'text' },
];

// "already exists" is the only error we ignore on provisioning — everything else
// (bad payload, missing scope) is a real reason the field won't be writable, so
// we surface it instead of swallowing it.
function isAlreadyExists(status: number, body: string): boolean {
  return status === 409 || /already\s*exists|conflict|duplicate|slug.*taken/i.test(body);
}

async function ensureHubspotIcpProps(token: string): Promise<string[]> {
  const errors: string[] = [];
  for (const f of ICP_FIELDS) {
    try {
      const res = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.key, label: f.label, type: f.hsType, fieldType: f.hsField, groupName: 'contactinformation' }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (!isAlreadyExists(res.status, t)) errors.push(`${f.key}: ${res.status} ${t.slice(0, 160)}`);
      }
    } catch (e: any) { errors.push(`${f.key}: ${e?.message || e}`); }
  }
  return errors;
}

async function ensureAttioIcpAttrs(token: string): Promise<string[]> {
  const errors: string[] = [];
  for (const f of ICP_FIELDS) {
    try {
      const res = await fetch('https://api.attio.com/v2/objects/people/attributes', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: {
          title: f.label, api_slug: f.key, type: f.attioType,
          is_required: false, is_unique: false, is_multiselect: false,
        }}),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (!isAlreadyExists(res.status, t)) errors.push(`${f.key}: ${res.status} ${t.slice(0, 300)}`);
      }
    } catch (e: any) { errors.push(`${f.key}: ${e?.message || e}`); }
  }
  return errors;
}

export async function writeCrmIcpFields(
  provider: CrmProvider,
  token: string,
  recordId: string,
  icp: { nous_icp_score?: unknown; nous_icp_fit?: unknown; nous_icp_reason?: unknown },
): Promise<{ ok: boolean; error?: string }> {
  const score = icp.nous_icp_score ?? null;
  const fit = icp.nous_icp_fit ?? null;
  const scoredAt = new Date().toISOString();
  const reason = icp.nous_icp_reason ?? null;

  if (provider === 'hubspot') {
    const provErrors = await ensureHubspotIcpProps(token);
    const properties: Record<string, unknown> = { nous_icp_score: score, nous_icp_fit: fit == null ? '' : String(fit), nous_icp_scored_at: scoredAt };
    if (reason) properties.nous_icp_reason = reason;
    const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(recordId)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text().catch(() => '')).slice(0, 300);
    if (/PROPERTY_DOESNT_EXIST|does not exist|Cannot find/i.test(body)) {
      return { ok: false, error: `HubSpot is missing the nous_icp_* properties. Create them on Contacts — nous_icp_score (Number), nous_icp_fit (Text), nous_icp_scored_at (Date), nous_icp_reason (Text) — or grant the token crm.schemas.contacts.write. See docs/crm-setup.md.${provErrors.length ? ` [auto-create error: ${provErrors[0]}]` : ''}` };
    }
    return { ok: false, error: `HubSpot ICP PATCH ${res.status}: ${body}` };
  }
  if (provider === 'attio') {
    const provErrors = await ensureAttioIcpAttrs(token);
    const values: Record<string, unknown> = {
      nous_icp_score: [{ value: score }],
      nous_icp_fit: [{ value: !!fit }],
      nous_icp_scored_at: [{ value: scoredAt }],
    };
    if (reason) values.nous_icp_reason = [{ value: reason }];
    const res = await fetch(`https://api.attio.com/v2/objects/people/records/${encodeURIComponent(recordId)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { values } }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.text().catch(() => '')).slice(0, 300);
    // Fields don't exist and we couldn't auto-create them → actionable setup message.
    if (/value_not_found|Cannot find attribute/i.test(body)) {
      return { ok: false, error: `Attio is missing the nous_icp_* attributes. Create them on the People object — nous_icp_score (Number), nous_icp_fit (Checkbox), nous_icp_scored_at (Timestamp), nous_icp_reason (Text) — then retry. See docs/crm-setup.md.${provErrors.length ? ` [auto-create error: ${provErrors[0]}]` : ''}` };
    }
    return { ok: false, error: `Attio ICP PATCH ${res.status}: ${body}` };
  }
  return { ok: false, error: `ICP write-back not supported for ${provider} yet` };
}

// ─── Upsert into the v2 substrate ────────────────────────────────────────────
// Contacts + companies go through the v1-shape views — the INSTEAD OF triggers
// translate writes into entity / identifier / observation rows. Deals go
// straight to entities + claims since there's no v1 deals table to mirror.

// Write current-state facts as observations; the claim engine derives the claims. Shared by
// the contact/company/deal upserts so owner, lifecycle and title land the same way on all.
async function writeStateFacts(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  provider: CrmProvider,
  facts: Array<[string, unknown]>,
  observedAt?: string | null,
): Promise<void> {
  const rows = facts
    .filter(([, v]) => v != null && v !== '')
    .map(([property, value]) => ({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: 'state',
      property,
      value,
      source: provider,
      method: 'crm_sync',
      observed_at: observedAt ?? new Date().toISOString(),
    }));
  if (rows.length) await supabase.from('observations').insert(rows).then(() => {}, () => {});
}

const contactFacts = (c: CrmContact): Array<[string, unknown]> => [
  ['job_title',       c.job_title],
  ['owner_name',      c.owner_name],
  ['owner_email',     c.owner_email],
  ['lifecycle_stage', c.lifecycle_stage],
  ['lead_status',     c.lead_status],
];

const companyFacts = (co: CrmCompany): Array<[string, unknown]> => [
  ['owner_name',      co.owner_name],
  ['owner_email',     co.owner_email],
  ['lifecycle_stage', co.lifecycle_stage],
  // Account health, when the portal keeps any. A prospect yields an empty bag, so this adds
  // nothing to the thousands of companies that are not customers.
  ...accountHealthFacts(co.health),
];

// Each upsert reports what happened AND which entity it touched, so the orchestrator can
// hang history observations off the right entity without a second lookup.
interface UpsertResult { outcome: 'inserted' | 'updated' | 'skipped'; entityId: string | null }
const SKIPPED: UpsertResult = { outcome: 'skipped', entityId: null };

// `contacts` and `companies` are VIEWS, and every identifier column on them — email, domain,
// hubspot_id — is a correlated subquery over `entity_identifiers`. So `WHERE email = $1` cannot
// use an index: Postgres has to materialise the email for every person in the workspace and
// compare. Measured on a customer workspace (tens of thousands of people): 869ms and ~146,000 buffers to return no row.
//
// The same answer, asked of the table the identifier actually lives in, is an index scan on
// `entity_identifiers_active (workspace_id, kind, value) WHERE status='active'` — 3.5ms and
// three buffers. That index already existed; we were simply asking the wrong relation.
//
// One subtlety, which measuring caught and the query plan did not. The view hides people who are
// not "real contacts" yet (no interaction, no CRM id, no stage), and an UPDATE through a view that
// hides the row matches zero rows and reports NO error. So "I found an entity" is not the same
// claim as "the update below will land". The first attempt at this fix verified visibility with a
// second read, and timed slower than the code it replaced on a hit — two round trips beat one, and
// the view lookup is only slow when it MISSES and has to scan the whole workspace.
//
// So the update itself is the confirmation: `.select('id')` makes it return what it touched, and
// no rows means the view hid the person, in which case we fall through to the insert — exactly
// what the old lookup-by-view did. A hit costs the same round trips it always did; a miss, which
// is most of a first import, costs one indexed read instead of scanning every person in the workspace.
//
// The CRM kinds each view column maps to, from the view definitions:
//   contacts.email → 'email'   contacts.hubspot_id → 'hubspot'   .pipedrive_id → 'pipedrive'
//   companies.domain → 'domain'   .hubspot_company_id → 'hubspot_company'   etc.
//
// One deliberate difference. The view exposes a person's FIRST active email (`ORDER BY
// first_seen_at LIMIT 1`), so matching on it only ever found someone by their earliest address;
// a contact arriving under a second, equally active address was treated as a new person. Asking
// entity_identifiers matches any of their active addresses, which is the identity model's own
// rule — an active identifier belongs to exactly one entity, enforced by the unique index. The
// effect is fewer duplicate people created by a sync, never a different person matched.
//
// The kind maps live beside personEntitiesByCrmId below, which already reads the identifier table
// for the deal roster — this is the same fix applied to the path the roster fix left behind.

async function findByIdentifier(
  supabase: SupabaseClient,
  workspaceId: string,
  kind: string | undefined,
  value: string,
): Promise<{ id: string } | null> {
  // An unmapped provider means we have no identifier to match on — the caller then inserts,
  // which is what it did before. Same defensive shape personEntitiesByCrmId uses.
  if (!kind || !value) return null;
  const { data } = await supabase
    .from('entity_identifiers')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('value', value)
    .eq('status', 'active')
    .maybeSingle();
  return data?.entity_id ? { id: data.entity_id } : null;
}

async function upsertContact(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  c: CrmContact,
): Promise<UpsertResult> {
  if (!c.email && !c.id) return SKIPPED;
  const idColumn = provider === 'hubspot' ? 'hubspot_id'
                 : provider === 'pipedrive' ? 'pipedrive_id'
                 : provider === 'salesforce' ? 'salesforce_id'
                 : 'attio_id';

  // Match priority: by external CRM id first, then by email. Both go to entity_identifiers —
  // see findByIdentifier for why asking the view costs 869ms and asking the table costs 3.5ms.
  let existing: { id: string } | null = null;
  if (c.id) existing = await findByIdentifier(supabase, workspaceId, CONTACT_ID_KIND[provider], String(c.id));
  if (!existing && c.email) {
    existing = await findByIdentifier(supabase, workspaceId, 'email', c.email.toLowerCase().trim());
  }

  const [firstName, ...rest] = (c.name ?? '').split(' ');
  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    email: c.email ? c.email.toLowerCase().trim() : null,
    first_name: firstName || null,
    last_name: rest.length ? rest.join(' ') : null,
    company: c.company,
    phone: c.phone,
    source: provider,
    [idColumn]: c.id,
  };
  // Link to the account (works_at) when we resolved a company entity for this contact.
  if (c.company_id) payload.company_id = c.company_id;

  if (existing) {
    // Echo suppression: if company/phone match a value Nous just wrote to this
    // record, drop them from the update so we don't re-ingest our own write.
    const skip = await echoFieldsToSkip(supabase, workspaceId, provider, c.id, { company: c.company, phone: c.phone });
    if (skip.has('company')) delete payload.company;
    if (skip.has('phone'))   delete payload.phone;
    // `.select('id')` so the update reports what it touched: no rows means the view does not
    // expose this person yet, and we fall through to the insert rather than silently writing
    // nothing. See findByIdentifier.
    const { data: updated } = await supabase.from('contacts').update(payload).eq('id', existing.id).select('id');
    if (updated?.length) {
      await writeStateFacts(supabase, workspaceId, existing.id, provider, contactFacts(c), c.updated_at);
      return { outcome: 'updated', entityId: existing.id };
    }
  }
  // The view's INSTEAD OF trigger assigns the entity id and returns the row, so RETURNING
  // works; the lookup is the fallback in case it ever doesn't.
  const { data: inserted, error: insertErr } = await supabase.from('contacts').insert(payload).select('id').maybeSingle();
  // A refused insert used to return `inserted` as a person the sync counted and never stored
  // (GET-287). Say it once per run rather than per row: a portal's worth of the same message is
  // its own kind of silence.
  if (insertErr) warnOnce(`contact insert: ${insertErr.message}`);
  let newId: string | null = inserted?.id ?? null;
  if (!newId && c.id) {
    newId = (await findByIdentifier(supabase, workspaceId, CONTACT_ID_KIND[provider], String(c.id)))?.id ?? null;
  }
  if (newId) await writeStateFacts(supabase, workspaceId, newId, provider, contactFacts(c), c.updated_at);
  return { outcome: 'inserted', entityId: newId };
}

async function upsertCompany(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  co: CrmCompany,
): Promise<UpsertResult> {
  if (!co.name && !co.domain) return SKIPPED;
  const idColumn = provider === 'hubspot' ? 'hubspot_company_id'
                 : provider === 'pipedrive' ? 'pipedrive_org_id'
                 : provider === 'salesforce' ? null
                 : 'attio_company_id';

  let existing: { id: string } | null = null;
  if (co.id) existing = await findByIdentifier(supabase, workspaceId, COMPANY_ID_KIND[provider], String(co.id));
  if (!existing && co.domain) {
    const normalized = co.domain.replace(/^www\./, '').toLowerCase().trim();
    existing = await findByIdentifier(supabase, workspaceId, 'domain', normalized);
  }

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: co.name,
    domain: co.domain ? co.domain.replace(/^www\./, '').toLowerCase().trim() : null,
    industry: co.industry,
    location: [co.city, co.country].filter(Boolean).join(', ') || null,
    ...(idColumn ? { [idColumn]: co.id } : {}),
  };
  // A provider with no companies-view column keeps its account id on the identifier table.
  const keepId = async (entityId: string | null) => {
    if (idColumn || !entityId || !co.id) return;
    // The unique index is partial (status = 'active'), which an upsert cannot name: insert, and a
    // duplicate (the id is already on file) is the outcome we wanted anyway.
    await supabase.from('entity_identifiers')
      .insert({ workspace_id: workspaceId, entity_id: entityId, kind: COMPANY_ID_KIND[provider], value: String(co.id) })
      .then(() => {}, () => {});
  };

  if (existing) {
    // Same as upsertContact: the update reports what it touched, and nothing touched means the
    // view does not expose this account yet, so we insert instead of writing into the void.
    const { data: updated } = await supabase.from('companies').update(payload).eq('id', existing.id).select('id');
    if (updated?.length) {
      await keepId(existing.id);
      await writeStateFacts(supabase, workspaceId, existing.id, provider, companyFacts(co), co.updated_at);
      return { outcome: 'updated', entityId: existing.id };
    }
  }
  const { data: inserted } = await supabase.from('companies').insert(payload).select('id').maybeSingle();
  let newId: string | null = inserted?.id ?? null;
  if (!newId && co.id) {
    newId = (await findByIdentifier(supabase, workspaceId, COMPANY_ID_KIND[provider], String(co.id)))?.id ?? null;
  }
  await keepId(newId);
  if (newId) await writeStateFacts(supabase, workspaceId, newId, provider, companyFacts(co), co.updated_at);
  return { outcome: 'inserted', entityId: newId };
}

// Deals → entities of type='deal' with claims, LINKED to their company.
//
// `companyEntityId` is the resolved Nous company entity (see syncCrmProvider, which looks
// it up in the same map the contacts pass uses). Before this existed, a synced deal carried
// its amount and close date but hung off nothing: there was no path from an account to its
// own deal value, so the money sat in the database unreachable. The `belongs_to` edge is
// that path, and it is what lets the forecast read an account's open pipeline.
// The entity_identifiers kind each provider's own contact id is stored under. The `contacts`
// view projects it back out as `<provider>_id`, but through a correlated subquery, so
// filtering the VIEW by it scans every person in the workspace: invisible at a hundred
// contacts, a silent timeout at tens of thousands (the error was swallowed and the deal got no people).
// The identifier table has a unique (workspace_id, kind, value) index — read that instead.
const CONTACT_ID_KIND: Partial<Record<CrmProvider, string>> = {
  hubspot: 'hubspot',
  pipedrive: 'pipedrive',
  attio: 'attio',
  salesforce: 'salesforce',
};

// The same, for the account side: `companies.<provider>_company_id` is the identical correlated
// subquery, and upsertCompany used to filter the view by it once per company in the portal.
const COMPANY_ID_KIND: Partial<Record<CrmProvider, string>> = {
  hubspot: 'hubspot_company',
  pipedrive: 'pipedrive_org',
  attio: 'attio_company',
  // No companies-view column for it: written to entity_identifiers directly (upsertCompany).
  salesforce: 'salesforce_account',
};

/** CRM contact ids → person entity ids, off the identifier index, 200 ids per read. */
async function personEntitiesByCrmId(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  crmIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const kind = CONTACT_ID_KIND[provider];
  const wanted = [...new Set(crmIds.map(String))];
  if (!kind || !wanted.length) return out;
  for (let i = 0; i < wanted.length; i += 200) {
    const { data, error } = await supabase.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', kind).eq('status', 'active')
      .in('value', wanted.slice(i, i + 200));
    if (error) throw new Error(`contact ids → entities: ${error.message}`);
    for (const row of (data ?? []) as Array<{ entity_id: string; value: string }>) out.set(String(row.value), row.entity_id);
  }
  return out;
}

/**
 * The people on a deal, as relationship rows: person → deal, type `stakeholder_of`.
 *
 * This is the edge the graph never had. It knew a deal belonged to a company and a person
 * worked at a company, but not which people sat on which deal, so "was this call about
 * Deal A or Deal B" could not even be asked. HubSpot hands the roster back in the same v4
 * association read the company link already uses; this turns it into rows. Pure, so the
 * shape is testable without a database. Deduped on the person id; a deal with no roster
 * yields nothing rather than a row with a null person.
 */
export function stakeholderEdges(
  workspaceId: string,
  dealEntityId: string,
  personEntityIds: Array<string | null | undefined>,
  validFrom?: string | null,
): Array<{ workspace_id: string; from_entity_id: string; to_entity_id: string; type: 'stakeholder_of'; valid_from: string }> {
  const seen = new Set<string>();
  const at = validFrom ?? new Date().toISOString();
  const rows: Array<{ workspace_id: string; from_entity_id: string; to_entity_id: string; type: 'stakeholder_of'; valid_from: string }> = [];
  for (const id of personEntityIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ workspace_id: workspaceId, from_entity_id: id, to_entity_id: dealEntityId, type: 'stakeholder_of', valid_from: at });
  }
  return rows;
}

async function upsertDeal(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  d: CrmDeal,
  companyEntityId: string | null = null,
  contactEntityIds: string[] = [],
): Promise<UpsertResult> {
  if (!d.name && !d.id) return SKIPPED;
  const kind = `deal_${provider}`;

  // Resolve to an existing deal entity via entity_identifiers, else create.
  let entityId: string | null = null;
  {
    const { data } = await supabase.from('entity_identifiers')
      .select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', kind).eq('value', d.id).eq('status', 'active')
      .maybeSingle();
    entityId = data?.entity_id ?? null;
  }
  // Decide inserted-vs-updated HERE. The old code checked `entityId` after creating one,
  // which is always truthy — so `deals.inserted` was always 0 and every deal read as an update.
  const existed = !!entityId;

  if (!entityId) {
    const { data: created, error } = await supabase.from('entities')
      .insert({ workspace_id: workspaceId, type: 'deal', status: 'active' })
      .select('id').single();
    if (error || !created) return SKIPPED;
    entityId = created.id;
    await supabase.from('entity_identifiers').insert({
      // The CRM asserting its own record id. Named so a later dispute can say WHICH crm.
      workspace_id: workspaceId, entity_id: entityId, kind, value: d.id, source: provider,
    }).then(() => {}, () => {});
  }

  // Write current state as observations (the claim engine will derive claims).
  const facts: Array<[string, unknown]> = [
    ['name',       d.name],
    ['value',      d.value],
    ['currency',   d.currency],
    ['stage',      d.stage],
    ['close_date', d.close_date],
    ['opened_date', d.opened_date],
    ['owner_name', d.owner_name],
    ['owner_email', d.owner_email],
    // The provider's explicit outcome and the raw stage id, alongside the label in `stage`.
    ['status',     d.status],
    ['stage_id',   d.stage_external_ref],
    ['pipeline',   d.pipeline_name],
    // The id beside the name: the stable key every reader should filter on.
    ['pipeline_id', d.pipeline_id],
    ['lost_reason_stated', d.lost_reason_stated],
    ['lost_reason_note',   d.lost_reason_note],
    ['won_reason_stated',  d.won_reason_stated],
  ];
  const REP_STATED = new Set(['lost_reason_stated', 'lost_reason_note', 'won_reason_stated']);
  const rows = facts
    .filter(([, v]) => v != null && v !== '')
    .map(([property, value]) => ({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: 'state',
      property,
      value,
      source: provider,
      // A reason the rep typed is testimony, not an observation of what happened: marked so every
      // reader can keep it apart from the evidence.
      method: REP_STATED.has(property) ? 'rep_stated' : 'crm_sync',
      observed_at: d.updated_at ?? new Date().toISOString(),
      // Same raw shape as the history rows (dealHistoryFacts), so the current-state stage and
      // the historical stages read as one timeline with a won/lost verdict on every hop.
      raw: property === 'stage' ? { stage_id: d.stage_external_ref ?? null, status: d.status ?? null } : null,
    }));
  if (rows.length) await supabase.from('observations').insert(rows).then(() => {}, () => {});

  // The link that was missing. Idempotent on (workspace, from, to, type), so a re-sync
  // refreshes rather than duplicating. Best-effort: a failed edge must never fail the
  // deal's own sync — the amount is still worth having even unlinked.
  if (companyEntityId && entityId) {
    await supabase.from('relationships').upsert(
      {
        workspace_id: workspaceId,
        from_entity_id: entityId,
        to_entity_id: companyEntityId,
        type: 'belongs_to',
        valid_from: d.updated_at ?? new Date().toISOString(),
      },
      { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true },
    ).then(() => {}, () => {});
  }

  // The roster: who sits on this deal. Same idempotency and the same best-effort stance
  // as the company link above, and for the same reason: a deal is worth having even when
  // its people could not be resolved. Every existing reader of `relationships` filters on
  // an exact type, so this edge is invisible to them until something asks for it.
  if (entityId && contactEntityIds.length) {
    const rows = stakeholderEdges(workspaceId, entityId, contactEntityIds, d.updated_at);
    if (rows.length) {
      await supabase.from('relationships').upsert(rows,
        { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true },
      ).then(() => {}, () => {});
    }
  }

  return { outcome: existed ? 'updated' : 'inserted', entityId };
}

// ─── The orchestrator ────────────────────────────────────────────────────────

export interface SyncRunResult {
  // `history` counts the NEW historical observations written this run (dedup'd on
  // external_id, so a re-sync adds only what it has not seen). Contacts: lifecycle changes.
  // Deals: stage / amount / close-date changes — the raw material of the pipeline timeline.
  contacts: { fetched: number; inserted: number; updated: number; skipped: number; history: number };
  companies: { fetched: number; inserted: number; updated: number; skipped: number };
  // `linked` / `unlinked` make the association gap visible in the sync result instead of
  // silently producing orphaned deals. An unlinked deal's amount is unreachable.
  // `stakeholders` counts person → deal roster edges written this run (gap 1 of the
  // multi-deal model): the number of people the graph can now place on a specific deal.
  deals: { fetched: number; inserted: number; updated: number; skipped: number; linked: number; unlinked: number; history: number; stakeholders: number };
  errors: string[];
  /**
   * Non-fatal: something optional could not be fetched (owners, pipelines, schema —
   * usually a missing scope). The run is still complete for cursor purposes; the gap is
   * reported rather than hidden, and never blocks the sync.
   */
  warnings: string[];
  /**
   * Kinds that hit the page cap with more pages still to come. A truncated run is NOT a
   * complete run: callers must not advance `last_synced_at` to "now" on it, or every record
   * past the cap is skipped forever (next run only asks for records modified after now).
   */
  truncated: string[];
  /**
   * HubSpot only: per engagement object (calls, emails, meetings, notes). `logged` counts
   * NEW activity rows (dedup'd on external_id); `documents` the summaries/notes kept as
   * documents; `unattached` engagements with no resolvable contact or company.
   */
  // `deal_links`: activity → deal attributions mirrored from the CRM's own engagement
  // associations (observation_deals rows, source 'crm'), counted across new AND
  // already-synced engagements so a re-sync backfills the table for older workspaces.
  engagements: Record<string, { fetched: number; logged: number; documents: number; unattached: number; deal_links: number }>;
  /**
   * HubSpot only. Which call-content tier the portal actually delivered. `recapGated` means
   * the Notetaker recap API answered GATED (tier), `transcriptBlocked` that the transcript
   * read refused us (auth/ownership) — each is a fact about their portal, reported not hidden.
   */
  callIntelligence: {
    transcriptsAttempted: number; transcriptsFetched: number; transcriptBlocked: boolean; transcriptStatus: number | null;
    recapsAttempted: number; recapsFetched: number; recapGated: boolean;
    actionItems: number; questions: number;
  };
  /** HubSpot only: line items / subscriptions / invoices, each recorded on its deal or account. */
  commerce: Record<string, { fetched: number; recorded: number; unattached: number }>;
  /**
   * Decided deals seen this run, in the shape the closed-deals ICP trainer takes
   * (apps/api/src/lib/closedDeals.mjs → normalizeClosedDeals). The API layer feeds these to
   * runClosedDeals after a sync so the model learns from the CRM's real outcomes without
   * anyone typing domains into a form.
   */
  closedDeals: Array<{ domain: string; amount: number | null; currency: string | null; closedAt: string | null; disposition: 'won' | 'lost' }>;
  /**
   * Where the next run should resume from when `truncated` is non-empty: the newest
   * `updated_at` actually seen across the truncated kinds. Only set for providers that
   * page in ascending modified order (HubSpot); null means "hold the cursor and retry".
   */
  resumeFrom: string | null;
  /**
   * The CRM's id for the workspace's primary pipeline, from the provider's own marker (see
   * pickPrimaryPipeline). Callers store it on crm_sync_configs.primary_pipeline_ref so readers
   * can scope to the main pipeline without a token. Null when the prelude could not fetch
   * pipelines; callers must then leave the stored value alone.
   */
  primaryPipelineRef: string | null;
  /** Locations linked to a parent group this run (HubSpot company hierarchy). */
  companyHierarchy: number;
}

const PROVIDER_FETCHERS: Record<CrmProvider, typeof hubspot> = { hubspot, pipedrive, attio, salesforce };

// ─── Renewal dates, from the subscriptions a customer is billed on ───────────
//
// WHY THE SYNC READS HUBSPOT AGAIN for this instead of reading back the subscription.* observations
// it just wrote: those observations are keyed `hubspot:subscriptions:<id>` and recordObservations
// skips an external id it has seen, so each one holds the subscription as it was the FIRST time we
// saw it, never its later status or term. And an incremental run only sees the subscriptions that
// changed since the cursor, never the rest of the account's. A renewal is a fact about all of an
// account's live subscriptions at once, so for each account a run touched, this asks HubSpot for
// all of them, as they are now. One association read and one batch read per hundred.

/** Live HubSpot company ids → entity, read from the identifier table. */
async function companyEntitiesByHubspotIds(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'hubspot_company').eq('status', 'active')
      .in('value', ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ entity_id: string; value: string }>) out.set(String(r.value), r.entity_id);
  }
  return out;
}

/** entity → every live HubSpot company id it carries (a merged account carries several). */
async function hubspotIdsOfEntities(supabase: SupabaseClient, workspaceId: string, entityIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < entityIds.length; i += 200) {
    const { data, error } = await supabase.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'hubspot_company').eq('status', 'active')
      .in('entity_id', entityIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ entity_id: string; value: string }>) {
      (out.get(r.entity_id) ?? out.set(r.entity_id, []).get(r.entity_id)!).push(String(r.value));
    }
  }
  return out;
}

/**
 * Every subscription on these HubSpot companies, as it stands now, keyed by company id.
 *
 * Strict where hubspotAssociations is lenient: a failed read throws rather than handing back part
 * of an account's subscriptions, because a renewal computed from half of them can clear a real one.
 */
async function hubspotSubscriptionTerms(token: string, companyIds: string[]): Promise<Map<string, SubscriptionTerm[]>> {
  const subsOf = new Map<string, string[]>();
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const res = await hubspotFetch('https://api.hubapi.com/crm/v4/associations/companies/subscriptions/batch/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: chunk.map(id => ({ id: String(id) })) }),
    }, token);
    if (!res.ok) throw new Error(`HubSpot companies→subscriptions ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const d: any = await res.json();
    for (const row of d?.results ?? []) {
      const fromId = row?.from?.id ?? row?._from?.id;
      if (!fromId) continue;
      subsOf.set(String(fromId), (row?.to ?? []).map((t: any) => String(t?.toObjectId ?? t?.id)).filter(Boolean));
    }
  }
  const subIds = [...new Set([...subsOf.values()].flat())];
  const byId = new Map<string, SubscriptionTerm>();
  for (let cursor: string | null = '0'; cursor != null && subIds.length;) {
    const page: { results: any[]; cursor: string | null } = await hubspotReadIds(token, 'subscriptions', SUBSCRIPTION_TERM_PROPERTIES, { ids: subIds, cursor, limit: 100 });
    for (const r of page.results) {
      const p = r.properties ?? {};
      byId.set(String(r.id), {
        status: p.hs_status ?? null, start: p.hs_recurring_billing_start_date ?? null,
        end: p.hs_recurring_billing_end_date ?? null, frequency: p.hs_recurring_billing_frequency ?? null,
        nextPaymentDue: p.hs_next_payment_due_date ?? null,
      });
    }
    cursor = page.cursor;
  }
  const out = new Map<string, SubscriptionTerm[]>();
  for (const [company, ids] of subsOf) out.set(company, ids.map(id => byId.get(id)).filter((s): s is SubscriptionTerm => !!s));
  return out;
}

/**
 * Write `cs.renewal_date` / `cs.term_months` for these accounts (HubSpot only). Observations, never
 * claims: the claim engine derives them and the list-row sweep projects them into the `cs` bag like
 * every other cs.* fact (refresh_list_chunk reads `cs.%`), so the Customers page and the account
 * strip read them with no new query. Exported for a one-off backfill over a workspace's customers.
 */
export async function writeHubspotRenewals(
  supabase: SupabaseClient, workspaceId: string, token: string, entityIds: string[], today: Date = new Date(),
): Promise<{ accounts: number; written: number }> {
  const ids = [...new Set(entityIds)].filter(Boolean);
  if (!ids.length) return { accounts: 0, written: 0 };
  const hsIds = await hubspotIdsOfEntities(supabase, workspaceId, ids);
  const terms = await hubspotSubscriptionTerms(token, [...new Set([...hsIds.values()].flat())]);

  const current = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('claims').select('entity_id, property, value')
      .eq('workspace_id', workspaceId).is('invalid_at', null)
      .in('entity_id', ids.slice(i, i + 100)).in('property', ['cs.renewal_date', 'cs.term_months']);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as Array<{ entity_id: string; property: string; value: unknown }>) {
      (current.get(c.entity_id) ?? current.set(c.entity_id, {}).get(c.entity_id)!)[c.property.slice(3)] = c.value;
    }
  }

  const observedAt = new Date().toISOString();
  const inputs: ObservationInput[] = [];
  for (const id of ids) {
    const subs = (hsIds.get(id) ?? []).flatMap(h => terms.get(h) ?? []);
    for (const [property, value] of renewalChanges(renewalFromSubscriptions(subs, today), current.get(id) ?? {})) {
      inputs.push({ workspaceId, entityId: id, kind: 'state', property, value, source: 'hubspot', method: 'crm_sync', observedAt });
    }
  }
  return { accounts: ids.length, written: inputs.length ? await recordObservations(supabase, inputs) : 0 };
}

/** Every HubSpot record id a company-scoped import reads, per object. */
export type HubspotScopeIds = Record<string, string[]>;

/**
 * Resolve a list of HubSpot companies to every record that belongs to them (GET-273): their
 * contacts and deals, the engagements on the company, its contacts or its deals, the deals' line
 * items, and the subscriptions and invoices on the company or its contacts. A client import is a
 * chosen set of ACCOUNTS, not the whole portal — a portal holds years of junk nobody sells to.
 *
 * Read-only against HubSpot, so the same call is the dry run: its counts are what an import writes.
 */
export async function resolveHubspotScope(token: string, companyIds: string[]): Promise<HubspotScopeIds> {
  const uniq = (xs: string[]) => [...new Set(xs.map(String))];
  const linked = async (from: string, to: string, ids: string[]) => {
    if (!ids.length) return [];
    const started = Date.now();
    const out = [...(await hubspotAssociations(token, from, to, ids)).values()].flat();
    console.log(`[CRM_SYNC] scope ${from}->${to}: ${ids.length} in, ${out.length} out, ${Math.round((Date.now() - started) / 1000)}s`);
    return out;
  };
  const companies = uniq(companyIds);
  const contacts = uniq(await linked('companies', 'contacts', companies));
  const deals = uniq(await linked('companies', 'deals', companies));
  // Records are read by id. CONVERSATIONS are not: asking HubSpot which calls belong to thousands
  // of accounts, their tens of thousands of people and their thousands of deals is thousands of association reads before
  // a single row is written — twenty minutes of silence, and the first connect looked hung.
  // They are streamed by date instead and kept if they touch something in scope (GET-285).
  return { companies, contacts, deals, line_items: uniq(await linked('deals', 'line_items', deals)) };
}

/**
 * The companies worth importing from a HubSpot portal (GET-281).
 *
 * A portal is not a customer list. One customer's holds tens of thousands of companies, of which under
 * a fifth are a customer, carry a deal, or have been spoken to in the last year — the rest are scraped rows,
 * duplicates and dead ends nobody sells to. Importing all of them costs hours, fills the account
 * list with noise and teaches the ICP model from records that were never a deal.
 *
 * So: a company qualifies if ANY of these is true (HubSpot treats filterGroups as OR):
 *   · lifecycle stage is customer — they pay us, whatever else is true
 *   · it has at least one deal — someone worked it
 *   · it was contacted inside the window — it is live now
 *
 * Read-only. Returns every matching id, windowing past the 10k search ceiling by object id.
 */
export async function hubspotImportScope(
  token: string,
  { months = 12 }: { months?: number } = {},
): Promise<{ companyIds: string[]; total: number }> {
  const since = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const groups = [
    { filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] },
    { filters: [{ propertyName: 'num_associated_deals', operator: 'GTE', value: 1 }] },
    { filters: [{ propertyName: 'notes_last_contacted', operator: 'GTE', value: since }] },
  ];
  const seen = new Set<string>();
  let afterId: string | null = null;
  // Search stops at 10k results per query, so each window asks for ids above the last one seen.
  // A window that adds NOTHING NEW ends it: `hs_object_id GT` is a string comparison on HubSpot's
  // side, so a window can hand back rows it has already given us, and counting rows rather than
  // new ids turned that into a silent 5,000-request spin (GET-283).
  for (let window = 0; window < 20; window++) {
    const before = seen.size;
    let cursor: string | null = null;
    let lastId: string | null = null;
    for (let page = 0; page < 100; page++) {
      const body: any = {
        filterGroups: afterId
          ? groups.map(g => ({ filters: [...g.filters, { propertyName: 'hs_object_id', operator: 'GT', value: afterId }] }))
          : groups,
        properties: ['hs_object_id'],
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      };
      const res = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, token);
      if (!res.ok) throw new Error(`HubSpot company scope ${res.status} — ${await res.text().catch(() => '')}`);
      const d: any = await res.json();
      for (const r of d.results ?? []) { seen.add(String(r.id)); lastId = String(r.id); }
      cursor = d.paging?.next?.after ?? null;
      if (!cursor) break;
    }
    if (!cursor || !lastId || seen.size === before) break;
    afterId = lastId;
  }
  const companyIds = [...seen];
  return { companyIds, total: companyIds.length };
}

/**
 * Which companies the sync reads (crm_sync_configs.company_scope, 2026-10-06).
 *
 *   all                   every company the portal holds (the default, and what a workspace that
 *                         prospects from its CRM needs)
 *   customers_and_deals   only a company that is a customer, a churned customer, or has any deal
 *                         (open, won or lost). The accounts CS works and the ones the win/loss
 *                         patterns come from.
 *
 * Why it exists: a portal can hold tens of thousands of companies when the account work needs a few
 * thousand. The rest are prospect lists that cost a sync run its whole company budget, and once
 * a bulk update stamped more than ten thousand of them with the same second, which is more than one
 * search window holds: the pager could not get past it, the cursor froze, and every company
 * changed after it was never read again (customer MRR and usage included).
 */
export type CompanyScope = 'all' | 'customers_and_deals';

/**
 * The HubSpot filter groups for a company scope, or null to read everything. OR-ed: has a deal,
 * or lifecycle stage customer, or the portal's own account-status field says customer/churned.
 * Pure, so the rule is tested without a portal.
 */
export function hubspotCompanyScopeGroups(
  scope: CompanyScope | null | undefined,
  schema: Array<{ name: string; options?: string[] }>,
): HubspotFilter[][] | null {
  if (scope !== 'customers_and_deals') return null;
  const groups: HubspotFilter[][] = [
    [{ propertyName: 'num_associated_deals', operator: 'GT', value: 0 }],
    [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }],
  ];
  // HubSpot allows five groups per search; two are taken above.
  for (const { property, values } of customerStatusValues('hubspot', schema).slice(0, 3)) {
    groups.push([{ propertyName: property, operator: 'IN', values }]);
  }
  return groups;
}

/** The workspace's company scope. Tolerates the column not existing yet (migration by hand). */
async function readCompanyScope(supabase: SupabaseClient, workspaceId: string, provider: CrmProvider): Promise<CompanyScope> {
  try {
    const { data, error } = await supabase.from('crm_sync_configs').select('company_scope')
      .eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
    if (error) return 'all';
    return (data as any)?.company_scope === 'customers_and_deals' ? 'customers_and_deals' : 'all';
  } catch { return 'all'; }
}

export interface SyncCrmOptions {
  /** Override the workspace's crm_sync_configs.company_scope for this run. */
  companyScope?: CompanyScope | null;
  /** HubSpot only: import these companies and what belongs to them, instead of the whole portal. */
  scope?: {
    hubspotCompanyIds: string[];
    /** Conversations from this date. */
    engagementsSince?: string | null;
    /** Conversations BEFORE this date. With `since` it is one slice, so several runs can share
     *  the work: a portal's year of email is four quarters imported at once rather than one walk
     *  of over a hundred thousand (GET-289). Slices never overlap, so nothing is filed twice. */
    engagementsUntil?: string | null;
  } | null;
  /**
   * Run only these passes ('companies' | 'contacts' | 'deals' | engagement objects | commerce
   * objects). For finishing a pass that failed without re-walking a portal that took hours.
   */
  only?: string[] | null;
}

const PAGE_LIMIT = 100;
// Safety cap → 10k records per kind per run, which is also HubSpot's search ceiling. Hitting
// it is reported via `truncated` + `resumeFrom` so the next run continues, never skips.
const MAX_PAGES_PER_RUN = 100;
/** Engagements filed at once. Enough to hide the round-trip latency, small enough to be a good
 *  citizen of both the database's connection pool and HubSpot's rate limit. Measured on a real
 *  portal: 8 at a time filed ~3,500 rows a minute, which is hours for a year of conversations. */
const ENGAGEMENT_CONCURRENCY = 16;
/** Records upserted at once within a page (companies, people, deals). A portal's worth of records
 *  filed one at a time runs at about 80 a minute — days for a real CRM. They are independent rows. */
const RECORD_CONCURRENCY = 24;

/** Module-level so a single message from a page of 100 is reported once, not a hundred times. */
const seenWarnings = new Set<string>();
function warnOnce(message: string): void {
  if (seenWarnings.has(message)) return;
  seenWarnings.add(message);
  console.warn(`[CRM_SYNC] ${message}`);
}

/** Run `fn` over `items`, `n` at a time, in order of batches. */
async function inBatches<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) {
    await Promise.all(items.slice(i, i + n).map(fn));
  }
}

/**
 * Pull every record updated since `since` from a single CRM provider
 * (contacts + companies + deals) and upsert into the v2 substrate.
 * Paginates with a safety cap so a runaway dataset can't peg the worker.
 */
export async function syncCrmProvider(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  token: string,
  since: string | null,
  options: SyncCrmOptions = {},
): Promise<SyncRunResult> {
  const fetcher = PROVIDER_FETCHERS[provider];
  if (!fetcher) throw new Error(`Unsupported CRM provider: ${provider}`);
  // Which passes to run. Everything, unless a caller is finishing one that failed.
  const runs = (kind: string) => !options.only?.length || options.only.includes(kind);
  const scopeStarted = Date.now();
  const scopeIds: HubspotScopeIds | null = provider === 'hubspot' && options.scope?.hubspotCompanyIds?.length
    ? await resolveHubspotScope(token, options.scope.hubspotCompanyIds)
    : null;
  if (scopeIds) {
    console.log(`[CRM_SYNC] scope resolved in ${Math.round((Date.now() - scopeStarted) / 1000)}s: `
      + Object.entries(scopeIds).map(([k, v]) => `${k}=${v.length}`).join(' '));
  }
  // A scoped run reads its id lists in full; engagements alone keep a date floor.
  const scoped = (kind: string, opts: FetchOpts): FetchOpts => {
    if (!scopeIds) return opts;
    // A kind we resolved ids for is read by id; everything else (conversations, subscriptions)
    // is streamed from the date floor and filtered to the scope as each page arrives.
    const ids = scopeIds[kind];
    if (ids) return { ...opts, since: undefined, ids, minTimestamp: null };
    // Only a CONVERSATION has an hs_timestamp. A subscription is a standing arrangement, not an
    // event: asking HubSpot to filter it by one is a 400, and the whole pass returns nothing
    // (GET-288). A portal's subscriptions are few and all of them matter — take them all.
    const isEngagement = (HUBSPOT_ENGAGEMENT_OBJECTS as readonly string[]).includes(kind);
    // `opts.since` is the WINDOW CURSOR, not a caller's preference: search stops at 10,000 results
    // per query, and the pager resumes past that by asking for records modified after the newest
    // it saw. Dropping it here meant every window re-ran the same query — a large slice of emails
    // imported its first 10,000, read them again, then stopped saying "truncated" (GET-292). The
    // date floor is a separate filter on when the conversation HAPPENED and composes with it.
    return {
      ...opts,
      minTimestamp: isEngagement ? (options.scope?.engagementsSince ?? null) : null,
      maxTimestamp: isEngagement ? (options.scope?.engagementsUntil ?? null) : null,
    };
  };
  // What "in scope" means for a streamed page: it touches one of these.
  const inScope = scopeIds
    ? { companies: new Set(scopeIds.companies), contacts: new Set(scopeIds.contacts), deals: new Set(scopeIds.deals) }
    : null;

  const result: SyncRunResult = {
    contacts:  { fetched: 0, inserted: 0, updated: 0, skipped: 0, history: 0 },
    companies: { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
    deals:     { fetched: 0, inserted: 0, updated: 0, skipped: 0, linked: 0, unlinked: 0, history: 0, stakeholders: 0 },
    errors: [],
    warnings: [],
    truncated: [],
    resumeFrom: null,
    engagements: {},
    callIntelligence: {
      transcriptsAttempted: 0, transcriptsFetched: 0, transcriptBlocked: false, transcriptStatus: null,
      recapsAttempted: 0, recapsFetched: 0, recapGated: false, actionItems: 0, questions: 0,
    },
    commerce: {},
    closedDeals: [],
    primaryPipelineRef: null,
    companyHierarchy: 0,
  };

  // Newest `updated_at` seen per kind — the resume point if that kind gets truncated.
  const seenMax: Record<string, string | null> = {};
  const bump = (kind: string, records: Array<{ updated_at?: string | null }>) => {
    for (const r of records) if (r.updated_at && (!seenMax[kind] || r.updated_at > seenMax[kind]!)) seenMax[kind] = r.updated_at;
  };

  // ── HubSpot prelude: pipelines, owners, schema ──
  // Three cheap calls that make the records below mean something: stage ids become labels
  // with a won/lost verdict, owner ids become people, and the portal's property schema is
  // captured (custom fields included) for the mapping layer and for safe write-back. Each
  // fails soft into `warnings` — a missing owners scope must not stop contacts syncing.
  let stageIndex: Map<string, StageIndexEntry> | null = null;
  let owners: Map<string, CrmOwner> | null = null;
  let companySchema: CrmPropertyDef[] = [];
  if (provider === 'hubspot') {
    try {
      const pipelines = await fetchHubspotPipelineStages(token);
      stageIndex = buildStageIndex(pipelines);
      result.primaryPipelineRef = primaryPipelineRef(provider, pipelines);
    }
    catch (e: any) { result.warnings.push(`pipelines: ${e?.message ?? e}`); }
    try { owners = await fetchHubspotOwners(token); }
    catch (e: any) { result.warnings.push(`owners: ${e?.message ?? e}`); }
    for (const obj of ['contacts', 'companies', 'deals'] as const) {
      try {
        const defs = await fetchHubspotProperties(token, obj);
        if (obj === 'companies') companySchema = defs;
        await storeCrmPropertySchema(supabase, workspaceId, provider, obj, defs);
      }
      catch (e: any) { result.warnings.push(`schema ${obj}: ${e?.message ?? e}`); }
    }
  }
  // Which companies to read. A scoped import (scopeIds) already names its companies and wins.
  const companyScope: CompanyScope = options.companyScope ?? await readCompanyScope(supabase, workspaceId, provider);
  const companyGroups = provider === 'hubspot' && !scopeIds ? hubspotCompanyScopeGroups(companyScope, companySchema) : null;
  if (companyGroups) console.log(`[CRM_SYNC] company scope: ${companyScope} (${companyGroups.length} filter groups)`);
  const resolveOwner = (r: { owner_external_id?: string | null; owner_name?: string | null; owner_email?: string | null; health?: Record<string, unknown> | null }) => {
    if (!owners) return;
    if (r.owner_external_id) {
      const o = owners.get(String(r.owner_external_id));
      if (o) {
        r.owner_name = r.owner_name ?? o.name;
        r.owner_email = o.email;
      }
    }
    // The CS owner is a SECOND owner on the same record and resolves through the same directory:
    // One customer's `cs` property is an OWNER-referenced picklist, so the id it holds is one of these.
    // It is kept apart from `owner_name` on purpose — that one is the AE, and on nearly every
    // customer account the two are different people. Overwriting one with the other would hand
    // every CS rep the AE's book and lose the AE's entirely.
    const csId = r.health?.['cs.owner_external_id'];
    if (csId) {
      const o = owners.get(String(csId));
      if (o) {
        r.health!['cs.owner_name'] = o.name;
        r.health!['cs.owner_email'] = o.email;
      }
    }
  };

  // Page through one kind, windowing past the provider's search ceiling. HubSpot's search
  // stops at 10k results per query (100 pages of 100). When a window fills we open the next
  // one from the newest record seen: pages arrive in ascending modified order, so nothing
  // is skipped, and the overlap at the boundary dedups on upsert. Providers that cannot
  // promise that order get one window; hitting the cap there is reported via `truncated`.
  const MAX_WINDOWS = 10;   // 100k records per kind per run; beyond that, resumeFrom carries on
  const pageKind = async <T extends { updated_at?: string | null }>(
    kind: string,
    counter: { fetched: number },
    fetchPage: (opts: FetchOpts) => Promise<FetchResult<T>>,
    handlePage: (records: T[]) => Promise<void>,
  ): Promise<void> => {
    let windowSince: string | null = since;
    let cursor: string | number | null = null;
    // Reading a known id list is not a search: the cap that stops a runaway query would instead
    // stop the list halfway, and the next window restarts the list at zero — which is how an
    // import of tens of thousands of people "fetched" most of them and stored the same 10,000
    // several times over (GET-287). An id list is finite, so page it to the end, once.
    const idCount = scopeIds?.[kind]?.length ?? 0;
    const pageCap = idCount ? Math.ceil(idCount / PAGE_LIMIT) + 1 : MAX_PAGES_PER_RUN;
    const windowCap = idCount ? 1 : MAX_WINDOWS;
    for (let w = 0; w < windowCap; w++) {
      cursor = null;
      for (let page = 0; page < pageCap; page++) {
        const { records, cursor: next } = await fetchPage({
          since: windowSince ?? undefined,
          cursor: cursor ?? undefined,
          limit: PAGE_LIMIT,
        });
        counter.fetched += records.length;
        bump(kind, records);
        const pageStarted = Date.now();
        await handlePage(records);
        // A client import runs for hours; without a line per page nobody can tell a slow phase
        // from a hung one, which is exactly the hour we lost on the first connect of that customer.
        console.log(`[CRM_SYNC] ${provider} ${kind} page=${page + 1} fetched=${counter.fetched} filed_in=${Date.now() - pageStarted}ms`);
        if (!next) { cursor = null; break; }
        cursor = next;
      }
      if (cursor == null) return;                                // window exhausted: done
      if (provider !== 'hubspot' || !seenMax[kind]) break;        // cannot window: truncated
      if (seenMax[kind] === windowSince) break;                   // no progress: never spin
      windowSince = seenMax[kind];
    }
    if (cursor != null) result.truncated.push(kind);
  };

  // Historical observations for a page of records, via the batch-read + history path.
  // Fails soft into warnings: history is enrichment on top of the sync, never a reason to
  // stop it. `entityIds` maps CRM id → Nous entity id for the page just upserted.
  const writeHistory = async (
    object: 'contacts' | 'deals',
    entityIds: Map<string, string>,
    historyProps: string[],
    toFacts: (crmId: string, history: Record<string, HubspotHistoryEntry[]>) => HistoryFact[],
  ): Promise<void> => {
    if (provider !== 'hubspot' || !entityIds.size) return;
    try {
      const rows = await hubspotBatchRead(token, object, [...entityIds.keys()], [historyProps[0]], historyProps);
      const inputs: ObservationInput[] = [];
      for (const row of rows) {
        const entityId = entityIds.get(row.id);
        if (!entityId) continue;
        for (const f of toFacts(row.id, row.propertiesWithHistory)) {
          inputs.push({
            workspaceId, entityId, kind: 'state', source: provider, method: 'crm_history',
            property: f.property, value: f.value, observedAt: f.observedAt, externalId: f.externalId, raw: f.raw,
          });
        }
      }
      result[object].history += await recordObservations(supabase, inputs);
    } catch (e: any) {
      result.warnings.push(`history ${object}: ${e?.message ?? e}`);
    }
  };

  // ── companies ── (must run BEFORE contacts so contact→account links can resolve)
  try {
    if (runs('companies')) await pageKind('companies', result.companies, opts => fetcher.fetchCompanies(token, { ...scoped('companies', opts), filterGroups: companyGroups }), async (records) => {
      await inBatches(records, RECORD_CONCURRENCY, async (r) => {
        resolveOwner(r);
        const u = await upsertCompany(supabase, workspaceId, provider, r);
        result.companies[u.outcome]++;
      });
    });
  } catch (e: any) {
    result.errors.push(`companies: ${e?.message ?? e}`);
  }

  // Build lookup maps so each contact can be linked to its account (works_at):
  //   • by the provider's company record id (Attio models company as a relationship)
  //   • by company name (HubSpot/Pipedrive carry the name as text)
  // We read them back from the substrate after the companies pass so we get the
  // resolved entity UUIDs (dedupe by domain/name already applied by upsertCompany).
  const companyIdColumn = provider === 'hubspot' ? 'hubspot_company_id'
                        : provider === 'pipedrive' ? 'pipedrive_org_id'
                        : provider === 'salesforce' ? null
                        : 'attio_company_id';
  const entityByExternalId = new Map<string, string>();
  const entityByName = new Map<string, string>();
  const domainByEntityId = new Map<string, string>();   // for the closed-deals trainer
  const nameByEntityId = new Map<string, string>();     // to label a contact's account when the CRM record carries no company text
  try {
    // Paged: PostgREST returns at most 1000 rows and says nothing when it stops. One read
    // here meant every contact and deal of company #1001 onward landed with no account.
    for (let from = 0; ; from += 1000) {
      const { data: companyRows, error } = await supabase.from('companies')
        .select(companyIdColumn ? `id, name, domain, ${companyIdColumn}` : 'id, name, domain')
        .eq('workspace_id', workspaceId)
        .order('id')
        .range(from, from + 999);
      if (error) throw error;
      for (const row of (companyRows ?? []) as unknown as Array<{ id: string; name: string | null; domain?: string | null } & Record<string, unknown>>) {
        const ext = companyIdColumn ? (row as any)[companyIdColumn] : null;
        if (ext) entityByExternalId.set(String(ext), row.id);
        if (row.name) { entityByName.set(row.name.toLowerCase().trim(), row.id); nameByEntityId.set(row.id, row.name); }
        if ((row as any).domain) domainByEntityId.set(row.id, String((row as any).domain));
      }
      if (!companyRows || companyRows.length < 1000) break;
    }
    // No view column for this provider's account id: read it off the identifier index instead.
    if (!companyIdColumn && COMPANY_ID_KIND[provider]) {
      for (let from = 0; ; from += 1000) {
        const { data: ids, error } = await supabase.from('entity_identifiers')
          .select('entity_id, value').eq('workspace_id', workspaceId)
          .eq('kind', COMPANY_ID_KIND[provider]!).eq('status', 'active')
          .order('id').range(from, from + 999);
        if (error) throw error;
        for (const r of ids ?? []) entityByExternalId.set(String(r.value), r.entity_id);
        if (!ids || ids.length < 1000) break;
      }
    }
  } catch (e: any) {
    result.errors.push(`company-map: ${e?.message ?? e}`);
  }

  // ── company hierarchy (the group a location belongs to) ──
  //
  // Written as its own edge type so it is invisible to every existing reader until one asks for
  // it: they all filter on an exact type. Direction is child → parent, the way the CRM states it.
  // Best-effort in full: a workspace whose CRM models no hierarchy, or a portal that refuses the
  // read, simply has no edges, and everything behaves as it did before.
  if (provider === 'hubspot' && runs('companies') && entityByExternalId.size) {
    try {
      const parents = await hubspotCompanyParents(token, [...entityByExternalId.keys()]);
      const edges: Array<Record<string, unknown>> = [];
      for (const [childExt, parentExt] of parents) {
        const child = entityByExternalId.get(String(childExt));
        const parent = entityByExternalId.get(String(parentExt));
        // Both ends must be companies this workspace actually holds, and a company is never
        // its own parent: either would make the family graph unusable for the readers below.
        if (child && parent && child !== parent) {
          edges.push({
            workspace_id: workspaceId,
            from_entity_id: child,
            to_entity_id: parent,
            type: 'subsidiary_of',
            valid_from: new Date().toISOString(),
          });
        }
      }
      for (let i = 0; i < edges.length; i += 500) {
        const { error } = await supabase.from('relationships').upsert(edges.slice(i, i + 500),
          { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true });
        if (error) throw error;
      }
      result.companyHierarchy = edges.length;
      if (edges.length) console.log(`[CRM_SYNC] company hierarchy: ${edges.length} location(s) linked to a parent group`);
    } catch (e: any) {
      result.warnings.push(`company-hierarchy: ${e?.message ?? e}`);
    }
  }

  // ── contacts ──
  try {
    if (runs('contacts')) await pageKind('contacts', result.contacts, opts => fetcher.fetchContacts(token, scoped('contacts', opts)), async (records) => {
      // HubSpot links a contact to its company by ASSOCIATION, not by the `company` text
      // property (which is a free-text field, usually empty). Without this read every
      // contact landed unlinked, and everything that walks contact → account → deals (the
      // audit's win/loss, stalls, expansion) saw nothing. One v4 batch read per page.
      if (provider === 'hubspot') {
        const assoc = await hubspotAssociations(token, 'contacts', 'companies', records.map(r => String(r.id)));
        for (const r of records) {
          const primary = assoc.get(String(r.id))?.[0];
          if (primary && !r.company_external_id) r.company_external_id = primary;
        }
      }
      const entityIds = new Map<string, string>();
      await inBatches(records, RECORD_CONCURRENCY, async (r) => {
        resolveOwner(r);
        // Resolve the contact's account entity so the works_at link is created.
        const companyId =
          (r.company_external_id && entityByExternalId.get(String(r.company_external_id))) ||
          (r.company && entityByName.get(r.company.toLowerCase().trim())) ||
          null;
        if (companyId) {
          r.company_id = companyId;
          if (!r.company) r.company = nameByEntityId.get(companyId) ?? null;
        }
        const u = await upsertContact(supabase, workspaceId, provider, r);
        result.contacts[u.outcome]++;
        if (u.entityId) entityIds.set(String(r.id), u.entityId);
      });
      // The AE → CS handoff, dated: every lifecycle transition this contact ever made.
      await writeHistory('contacts', entityIds, ['lifecyclestage', 'hs_lead_status'], contactHistoryFacts);
    });
  } catch (e: any) {
    result.errors.push(`contacts: ${e?.message ?? e}`);
  }

  // ── deals ──
  // Collected per account so the rollup below sees ALL of a company's deals at once —
  // summing two open deals needs both in hand, so it cannot be done inside the loop.
  const dealsByCompany = new Map<string, CrmDeal[]>();
  try {
    if (runs('deals')) await pageKind('deals', result.deals, opts => fetcher.fetchDeals(token, scoped('deals', opts)), async (records) => {
      // HubSpot carries no association on the deal record itself — fill it in for the page
      // before resolving. Other providers already supply it on the record.
      if (provider === 'hubspot') {
        const ids = records.map(r => String(r.id));
        const [assoc, roster] = await Promise.all([
          hubspotDealCompanyIds(token, ids),
          // The deal's contacts: the same v4 batch read, pointed at contacts instead of
          // companies. Fails soft to an empty map like every association read here.
          hubspotAssociations(token, 'deals', 'contacts', ids),
        ]);
        for (const r of records) {
          const ext = assoc.get(String(r.id));
          if (ext) r.company_external_id = ext;
          const people = roster.get(String(r.id));
          if (people?.length) r.contact_ids = people;
        }
        // A SCOPED company read can miss a deal's company: a brand-new account whose first deal
        // was added after the companies pass looked at it. Read those companies by id here, so the
        // deal still lands on its account instead of being counted unlinked forever.
        if (companyGroups) {
          const missing = [...new Set(records.map(r => r.company_external_id).filter((x): x is string => !!x && !entityByExternalId.has(String(x))))];
          let cursor: string | null = null;
          do {
            if (!missing.length) break;
            try {
              const page: FetchResult<CrmCompany> = await fetcher.fetchCompanies(token, { ids: missing, cursor: cursor ?? undefined, limit: PAGE_LIMIT });
              for (const co of page.records) {
                resolveOwner(co);
                const u = await upsertCompany(supabase, workspaceId, provider, co);
                result.companies[u.outcome]++;
                if (u.entityId && co.id) entityByExternalId.set(String(co.id), u.entityId);
              }
              cursor = page.cursor == null ? null : String(page.cursor);
            } catch (e: any) { result.warnings.push(`deal companies: ${e?.message ?? e}`); break; }
          } while (cursor);
        }
      }
      // CRM contact ids → person entities, for the deal roster. One indexed read per 200 ids.
      // A failure is reported, not swallowed: a deal that silently loses its people looks
      // exactly like a deal that never had any.
      let contactEntityByCrmId = new Map<string, string>();
      try {
        contactEntityByCrmId = await personEntitiesByCrmId(supabase, workspaceId, provider,
          records.flatMap(r => r.contact_ids ?? []).map(String));
      } catch (e: any) {
        if (!result.warnings.some(w => w.startsWith('deal roster:'))) result.warnings.push(`deal roster: ${e?.message ?? e}`);
      }
      const entityIds = new Map<string, string>();
      await inBatches(records, RECORD_CONCURRENCY, async (r) => {
        resolveOwner(r);
        // HubSpot's `dealstage` is an id. Swap in the label and take the provider's own
        // won/lost verdict, so crmDealState never has to regex a customer's stage names.
        if (stageIndex && r.stage) {
          const st = stageIndex.get(String(r.stage));
          if (st) {
            r.stage_external_ref = r.stage;
            r.stage = st.label;
            r.pipeline_name = st.pipelineName;
            r.pipeline_id = st.pipelineId;
            r.status = dealStatusFromStage(r.stage_external_ref, stageIndex);
          }
        }
        // Resolve the deal's account the SAME way the contacts pass does, off the same
        // map. This loop used to skip the lookup entirely, which is why every synced deal
        // ended up orphaned.
        const companyEntityId =
          (r.company_external_id && entityByExternalId.get(String(r.company_external_id))) ||
          (r.company_name && entityByName.get(r.company_name.toLowerCase().trim())) ||
          null;
        const contactEntityIds = (r.contact_ids ?? [])
          .map(id => contactEntityByCrmId.get(String(id))).filter((v): v is string => !!v);
        const u = await upsertDeal(supabase, workspaceId, provider, r, companyEntityId, contactEntityIds);
        result.deals[u.outcome]++;
        if (u.entityId) entityIds.set(String(r.id), u.entityId);
        result.deals.stakeholders += contactEntityIds.length;
        // A decided deal with a known account domain is a training example for the ICP model.
        if ((r.status === 'won' || r.status === 'lost') && companyEntityId && domainByEntityId.get(companyEntityId)) {
          result.closedDeals.push({
            domain: domainByEntityId.get(companyEntityId)!, amount: r.value ?? null, currency: r.currency ?? null,
            closedAt: r.close_date ?? null, disposition: r.status,
          });
        }
        if (companyEntityId) {
          result.deals.linked++;
          const bucket = dealsByCompany.get(companyEntityId) ?? [];
          bucket.push(r);
          dealsByCompany.set(companyEntityId, bucket);
        } else {
          result.deals.unlinked++;
        }
      });
      // The pipeline timeline: every stage move, amount change and close-date slip, dated.
      await writeHistory('deals', entityIds, ['dealstage', 'amount', 'closedate'],
        (id, h) => dealHistoryFacts(id, h, stageIndex));
    });
  } catch (e: any) {
    result.errors.push(`deals: ${e?.message ?? e}`);
  }

  // ── engagements (HubSpot) ──
  // Calls, emails, meetings and notes, attached to every associated contact (or to the
  // company when no contact is linked), as the SAME activity types the live webhooks write,
  // so the intelligence jobs see a year of HubSpot history exactly like live traffic.
  // Stage advance is skipped (the stageDerivation cron recomputes from logged history) and
  // the push-back to CRMs is source-guarded, so HubSpot's own history never boomerangs into
  // HubSpot as new engagements. Dedup is (source, external_id): a re-sync is a no-op, and
  // the document is only written the first time an engagement is seen.
  // Deal entities by HubSpot deal id, shared by the engagement pass (activity → deal
  // links) and the commerce pass (line items onto their deal). Filled lazily.
  const dealEntityByHubspotId = new Map<string, string>();
  const resolveDeals = async (hubspotIds: string[]) => {
    const missing = hubspotIds.filter(id => !dealEntityByHubspotId.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const { data } = await supabase.from('entity_identifiers').select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('kind', 'deal_hubspot').eq('status', 'active').in('value', missing.slice(i, i + 200));
      for (const row of (data ?? []) as Array<{ entity_id: string; value: string }>) dealEntityByHubspotId.set(String(row.value), row.entity_id);
    }
  };
  // The observation id of an engagement this sync has already logged, by its external
  // id. Only consulted when logActivity reports a dedup and there is a deal link to file.
  const existingObservationId = async (externalId: string): Promise<string | null> => {
    const { data } = await supabase.from('observations').select('id')
      .eq('workspace_id', workspaceId).eq('source', provider).eq('external_id', externalId).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };

  if (provider === 'hubspot') {
    const contactEntityByHubspotId = new Map<string, string>();
    const ownerUserByEmail = new Map<string, string | null>();

    const resolveContacts = async (hubspotIds: string[]) => {
      const missing = hubspotIds.filter(id => !contactEntityByHubspotId.has(id));
      try {
        for (const [crmId, entityId] of await personEntitiesByCrmId(supabase, workspaceId, 'hubspot', missing)) {
          contactEntityByHubspotId.set(crmId, entityId);
        }
      } catch (e: any) {
        // Same soft failure as before (the engagement falls back to the company), but said out loud.
        if (!result.warnings.some(w => w.startsWith('engagement contacts:'))) result.warnings.push(`engagement contacts: ${e?.message ?? e}`);
      }
    };
    // The rep who owns the engagement in HubSpot → the Nous member with that email (a
    // member login or a connected mailbox). Null means shared, not private to anyone.
    const ownerUserIdFor = async (email: string | null | undefined): Promise<string | null> => {
      const key = (email ?? '').trim().toLowerCase();
      if (!key) return null;
      if (!ownerUserByEmail.has(key)) {
        ownerUserByEmail.set(key, await connectedAccountOwnerByEmail(supabase, workspaceId, key).catch(() => null));
      }
      return ownerUserByEmail.get(key) ?? null;
    };

    // Tiers 2 and 3 of call content, for a call or meeting we are seeing for the first time.
    // Both stop asking once the portal has said no: GATED on the recap, or three auth
    // refusals on the transcript read. Everything they find lands on the FIRST attached
    // contact only, like the summary document, so a three-attendee call is stored once.
    const intel = result.callIntelligence;
    let transcriptAuthFailures = 0;
    // A portal that has never produced a recap answers every probe with an empty 200, and the
    // probe is one HTTP call per call and meeting: hundreds of them on one customer, all empty,
    // for nothing. After this many in a row we take the portal at its word (GET-281).
    const RECAP_EMPTY_LIMIT = 25;
    let recapEmptyStreak = 0;
    const captureCallIntelligence = async (
      entityId: string, object: HubspotEngagementObject, hubspotId: string, m: MappedEngagement, ownerUser: string | null,
    ): Promise<void> => {
      const transcriptionId = m.meta.transcription_id as string | number | null | undefined;
      if (m.meta.has_transcript === true && transcriptionId && !intel.transcriptBlocked) {
        intel.transcriptsAttempted++;
        try {
          const t = await fetchHubspotTranscript(token, transcriptionId);
          if (t.text) {
            intel.transcriptsFetched++;
            transcriptAuthFailures = 0;
            await saveDocument(supabase, workspaceId, {
              entityId, type: 'transcript', title: `Transcript — ${m.description}`, content: t.text,
              date: m.occurredAt, source: provider,
              meta: {
                external_id: `hubspot_transcript_${transcriptionId}`, hubspot_object: object, hubspot_id: hubspotId,
                owner_user_id: ownerUser, transcription_id: transcriptionId, recording_url: m.meta.recording_url ?? null,
              },
            }).catch(() => {});
          } else {
            intel.transcriptStatus ??= t.status;
            if (t.status === 401 || t.status === 403) {
              if (++transcriptAuthFailures >= 3) intel.transcriptBlocked = true;
            }
          }
        } catch (e: any) {
          if (!result.warnings.some(w => w.startsWith('transcript:'))) result.warnings.push(`transcript: ${e?.message ?? e}`);
        }
      }

      if (intel.recapGated) return;
      intel.recapsAttempted++;
      try {
        const r = await fetchHubspotRecap(token, object === 'calls' ? '0-48' : '0-47', hubspotId);
        if (r.gated) { intel.recapGated = true; return; }
        if (!r.recap) {
          if (++recapEmptyStreak >= RECAP_EMPTY_LIMIT) {
            intel.recapGated = true;
            result.warnings.push(`recap: ${RECAP_EMPTY_LIMIT} calls in a row had none — stopped asking`);
          }
          return;
        }
        recapEmptyStreak = 0;
        intel.recapsFetched++;
        // The recap itself is not filed as a document (GET-282): it is the CRM's copy of the
        // note-taker's summary, and the note-taker is where we read meeting notes from. Its
        // action items and questions are still recorded below — those are commitments, not prose.
        // Pre-extracted, dated, idempotent: an unanswered question and an open commitment
        // are each an audit finding on their own, straight from HubSpot's own notetaker.
        //
        // Action items use the SAME shape the worker's extractor writes
        // (apps/worker/src/utils/actionItems.mjs → property `action_item.<source>_<id>_<i>`),
        // so they appear on the Tasks page and are closed by the deterministic closer when
        // the follow-up actually happens. Owner is 'user': the notetaker recaps what OUR
        // side committed to; the prospect's commitments read as questions/asks instead.
        const sourceId = `${object}_${hubspotId}`;
        const inputs: ObservationInput[] = [
          ...r.recap.questions.map((text, i) => ({
            workspaceId, entityId, kind: 'event' as const, property: 'question.asked', value: { text },
            source: provider, method: 'notetaker', observedAt: m.occurredAt,
            externalId: `hubspot_recap_${sourceId}_q${i}`,
          })),
          ...r.recap.actionItems.map((title, i) => ({
            workspaceId, entityId, kind: 'state' as const,
            property: `action_item.${provider}_${sourceId}_${i}`,
            value: {
              title, owner_kind: 'user', owner_name: null, status: 'open',
              due_phrase: null, due_at: null, source_type: provider, source_id: sourceId,
            },
            source: provider, method: 'extraction', observedAt: m.occurredAt,
            externalId: `action_item_${provider}_${sourceId}_${i}`,
          })),
        ];
        if (inputs.length) {
          await recordObservations(supabase, inputs).catch(() => {});
          intel.questions += r.recap.questions.length;
          intel.actionItems += r.recap.actionItems.length;
        }
      } catch (e: any) {
        if (!result.warnings.some(w => w.startsWith('recap:'))) result.warnings.push(`recap: ${e?.message ?? e}`);
      }
    };

    for (const object of HUBSPOT_ENGAGEMENT_OBJECTS) {
      if (!runs(object)) continue;
      const counter = { fetched: 0, logged: 0, documents: 0, unattached: 0, deal_links: 0 };
      result.engagements[object] = counter;
      try {
        await pageKind(object, counter,
          opts => hubspotSearchObject(token, object, HUBSPOT_ENGAGEMENT_PROPS[object], scoped(object, opts)),
          async (records) => {
            const ids = records.map(r => r.id);
            const [toContacts, toCompanies, toDeals] = await Promise.all([
              hubspotAssociations(token, object, 'contacts', ids),
              hubspotAssociations(token, object, 'companies', ids),
              hubspotAssociations(token, object, 'deals', ids),
            ]);
            await resolveContacts([...new Set([...toContacts.values()].flat())]);

            // Each engagement is several round trips (dedup, insert, document, deal links), and a
            // 12-month portal holds hundreds of thousands of them: filed one at a time, an import
            // takes days. They are independent — different rows, counters incremented in one
            // thread — so a page is filed a few at a time (GET-281).
            const fileOne = async (raw: HubspotEngagementRaw) => {
              // Streamed by date: keep it only if it touches an account, person or deal we import.
              if (inScope) {
                const touches = (toCompanies.get(raw.id) ?? []).some(id => inScope.companies.has(id))
                  || (toContacts.get(raw.id) ?? []).some(id => inScope.contacts.has(id))
                  || (toDeals.get(raw.id) ?? []).some(id => inScope.deals.has(id));
                if (!touches) { counter.unattached++; return; }
              }
              const m = hubspotEngagementToActivity(object, raw);
              if (!m) return;
              const contactEntityIds = (toContacts.get(raw.id) ?? [])
                .map(id => contactEntityByHubspotId.get(id)).filter((v): v is string => !!v);
              const companyEntityIds = (toCompanies.get(raw.id) ?? [])
                .map(id => entityByExternalId.get(id)).filter((v): v is string => !!v);
              const targets = contactEntityIds.length ? contactEntityIds : companyEntityIds.slice(0, 1);
              if (!targets.length) { counter.unattached++; return; }

              const owner = (m.ownerExternalId && owners?.get(m.ownerExternalId)) || null;
              const ownerUser = await ownerUserIdFor(owner?.email);
              // The deals this engagement was logged against in HubSpot, as Nous deal
              // entities. The rep chose these when they logged it; mirror, never ask.
              const dealHubspotIds = toDeals.get(raw.id) ?? [];
              if (dealHubspotIds.length) await resolveDeals(dealHubspotIds);
              const dealEntityIds = dealHubspotIds.map(id => dealEntityByHubspotId.get(id)).filter((v): v is string => !!v);
              let firstSeen = true;
              for (const entityId of targets) {
                const externalId = `hubspot_${object}_${raw.id}_${entityId}`;
                const logged = await logActivity(supabase, {
                  workspaceId, contactId: entityId, entityId,
                  companyId: companyEntityIds[0] ?? null,
                  type: m.type, source: provider,
                  externalId,
                  occurredAt: m.occurredAt, description: m.description, summary: m.summary,
                  rawData: {
                    ...m.meta,
                    // What everything that reads content reads (activityText → raw.text): the call's
                    // notes, the meeting's description, the note, the email's own message. It used to
                    // live in a document for calls and meetings, and extraction of a HubSpot email saw
                    // only its 300-character summary (GET-282).
                    text: m.meta.body ?? null,
                    hubspot_object: object, hubspot_id: raw.id,
                    deal_ids: dealHubspotIds,
                    owner_name: owner?.name ?? null, owner_email: owner?.email ?? null,
                  },
                  ownerUserId: ownerUser, skipStageAdvance: true,
                });
                // File the deal link whether this engagement is new or already synced. A
                // re-sync returns null (dedup) for every engagement it has seen, and those
                // are exactly the rows a workspace backfilled before this table existed.
                if (dealEntityIds.length) {
                  const obsId = logged?.id ?? await existingObservationId(externalId);
                  if (obsId) {
                    const ok = await linkObservationToDeals(supabase, workspaceId, obsId, dealEntityIds, 'crm').catch(() => false);
                    if (ok) counter.deal_links += dealEntityIds.length;
                  }
                }
                if (!logged) { firstSeen = false; continue; }   // dedup: seen before, no document either
                counter.logged++;
                if (firstSeen && m.text && m.docType) {
                  await saveDocument(supabase, workspaceId, {
                    entityId, type: m.docType, title: m.description, content: m.text,
                    date: m.occurredAt, source: provider,
                    meta: {
                      external_id: `hubspot_${object}_${raw.id}`, hubspot_object: object, owner_user_id: ownerUser,
                      recording_url: m.meta.recording_url ?? null, has_transcript: m.meta.has_transcript ?? null,
                      transcription_id: m.meta.transcription_id ?? null,
                    },
                  }).then(() => { counter.documents++; }, () => {});
                }
                if (firstSeen && (object === 'calls' || object === 'meetings')) {
                  await captureCallIntelligence(entityId, object, raw.id, m, ownerUser);
                }
                firstSeen = false;
              }
            };
            for (let i = 0; i < records.length; i += ENGAGEMENT_CONCURRENCY) {
              await Promise.all(records.slice(i, i + ENGAGEMENT_CONCURRENCY).map(r => fileOne(r).catch((e: any) => {
                if (!result.warnings.some(w => w.startsWith(`${object}:`))) result.warnings.push(`${object}: ${e?.message ?? e}`);
              })));
            }
          });
      } catch (e: any) {
        result.errors.push(`${object}: ${e?.message ?? e}`);
      }
    }
  }

  // ── commerce (HubSpot) ──
  // Line items onto their deal, subscriptions and invoices onto their account. One state
  // observation per record, idempotent on the record id, so the audit can ask "what has
  // this account bought" from the graph alone. A missing scope fails soft into warnings.
  if (provider === 'hubspot') {
    // dealEntityByHubspotId / resolveDeals are declared above the engagement pass and
    // shared with it.
    // One read of the product catalog per sync (a few dozen records on a typical portal), so every
    // line item can be named by what the product IS rather than by what a rep typed. Best
    // effort: a portal without the products scope still syncs line items, just under typed names.
    let productNames: Map<string, string> | null = null;
    if (!SKIP_COMMERCE.has('line_items')) {
      try { productNames = await fetchHubspotProducts(token); }
      catch (e: any) { result.warnings.push(`products: ${e?.message ?? e}`); }
    }

    const contactCompany = new Map<string, string | null>();
    const resolveContactCompanies = async (hubspotIds: string[]) => {
      const missing = hubspotIds.filter(id => !contactCompany.has(id));
      for (let i = 0; i < missing.length; i += 200) {
        const { data } = await supabase.from('contacts').select('hubspot_id, company_id')
          .eq('workspace_id', workspaceId).in('hubspot_id', missing.slice(i, i + 200));
        for (const row of (data ?? []) as Array<{ hubspot_id: string | null; company_id: string | null }>) {
          if (row.hubspot_id) contactCompany.set(String(row.hubspot_id), row.company_id ?? null);
        }
      }
    };

    // The accounts whose subscriptions this run saw, so their renewal is re-read once at the end.
    const renewalAccounts = new Set<string>();
    // A merged account keeps ONE HubSpot company id on the `companies` view that built
    // entityByExternalId, so a subscription on its other id found no account (a few dozen of several hundred
    // subscription-holding companies on one portal). The identifier table has them all.
    const otherCompanyIds = new Map<string, string>();

    for (const object of (Object.keys(HUBSPOT_COMMERCE) as HubspotCommerceObject[]).filter(o => !SKIP_COMMERCE.has(o) && runs(o))) {
      const spec = HUBSPOT_COMMERCE[object];
      const counter = { fetched: 0, recorded: 0, unattached: 0 };
      result.commerce[object] = counter;
      try {
        await pageKind(object, counter,
          opts => hubspotSearchObject(token, object, [...spec.props], scoped(object, opts)),
          async (records) => {
            const ids = records.map(r => r.id);
            const toTarget = await hubspotAssociations(token, object, spec.to, ids);
            // Subscriptions and invoices are sometimes linked to a contact only; walk to the company.
            const toContacts = spec.to === 'companies' ? await hubspotAssociations(token, object, 'contacts', ids) : new Map<string, string[]>();
            if (spec.to === 'deals') await resolveDeals([...new Set([...toTarget.values()].flat())]);
            if (toContacts.size) await resolveContactCompanies([...new Set([...toContacts.values()].flat())]);
            if (object === 'subscriptions') {
              const missing = [...new Set([...toTarget.values()].flat())].filter(t => !entityByExternalId.has(t) && !otherCompanyIds.has(t));
              // Best effort: without it the subscription falls back to the contact walk, as before.
              if (missing.length) {
                try { for (const [hs, entity] of await companyEntitiesByHubspotIds(supabase, workspaceId, missing)) otherCompanyIds.set(hs, entity); }
                catch (e: any) { warnOnce(`subscriptions: identifier lookup failed — ${e?.message ?? e}`); }
              }
            }

            const inputs: ObservationInput[] = [];
            for (const raw of records) {
              let entityId: string | null = null;
              for (const t of toTarget.get(raw.id) ?? []) {
                entityId = spec.to === 'deals' ? (dealEntityByHubspotId.get(t) ?? null) : (entityByExternalId.get(t) ?? otherCompanyIds.get(t) ?? null);
                if (entityId) break;
              }
              if (!entityId) {
                for (const c of toContacts.get(raw.id) ?? []) { entityId = contactCompany.get(c) ?? null; if (entityId) break; }
              }
              if (!entityId) { counter.unattached++; continue; }
              if (object === 'subscriptions') renewalAccounts.add(entityId);
              inputs.push({
                workspaceId, entityId, kind: 'state',
                property: `${spec.property}.${raw.id}`,
                value: commerceRecordToValue(object, raw, productNames),
                source: provider, method: 'crm_sync',
                observedAt: raw.updated_at ?? raw.properties?.createdate ?? new Date().toISOString(),
                externalId: `hubspot:${object}:${raw.id}`,
              });
            }
            if (inputs.length) counter.recorded += await recordObservations(supabase, inputs);
          });
      } catch (e: any) {
        // A 403 here is a scope report, not a sync failure: the CRM spine is still complete.
        result.warnings.push(`${object}: ${e?.message ?? e}`);
      }
    }

    // Renewal dates for the accounts whose subscriptions moved this run (Phase 5, 2026-10-02).
    // Fails soft like the rest of commerce: a date that could not be read keeps its last value.
    if (renewalAccounts.size) {
      try {
        const r = await writeHubspotRenewals(supabase, workspaceId, token, [...renewalAccounts]);
        console.log(`[CRM_SYNC] renewals: ${r.accounts} accounts read, ${r.written} facts changed`);
      } catch (e: any) {
        result.warnings.push(`renewals: ${e?.message ?? e}`);
      }
    }
  }

  // A resume point only makes sense when pages arrive in ascending modified order, which
  // HubSpot's search guarantees (we sort on lastmodifieddate). For the others we leave it
  // null and the caller holds the cursor, so the same window is retried rather than skipped.
  if (result.truncated.length && provider === 'hubspot') {
    const points = result.truncated.map(k => seenMax[k]).filter((v): v is string => !!v);
    result.resumeFrom = points.length ? points.reduce((a, b) => (a < b ? a : b)) : null;
  }

  // ── roll the deals up onto their accounts ──
  //
  // A CRM hangs many deals off one company; Nous treats an account AS the deal. rollupDeals
  // reduces them to one set of numbers (open pipeline, nearest close date, historical won
  // value) and we write those onto the company entity, where the forecast reads them.
  //
  // Written as observations, not direct claim writes, so the claim engine derives them the
  // same way it derives everything else and the provenance stays intact.
  for (const [companyEntityId, deals] of dealsByCompany) {
    try {
      const roll = rollupDeals(deals);
      const facts: Array<[string, unknown]> = [
        // Only write an amount we can trust. Mixed currencies are NOT summed — we have no
        // FX rates, and a confidently wrong number is worse than an absent one.
        ['deal_value',          roll.mixedCurrency ? null : roll.openAmount],
        ['deal_currency',       roll.currency],
        ['expected_close_date', roll.closeDate],
        ['open_deal_count',     roll.openDeals],
        ['won_deal_value',      roll.mixedCurrency ? null : roll.wonAmount],
      ];
      const rows = facts
        .filter(([, v]) => v != null)
        .map(([property, value]) => ({
          workspace_id: workspaceId,
          entity_id: companyEntityId,
          kind: 'state',
          property,
          value,
          source: provider,
          method: 'crm_sync',
          observed_at: new Date().toISOString(),
        }));
      if (rows.length) await supabase.from('observations').insert(rows).then(() => {}, () => {});
      if (roll.mixedCurrency) {
        result.errors.push(`deal-rollup: mixed currencies on one account — amount left unset`);
      }
      await bridgeOutcomeToPipeline(supabase, workspaceId, companyEntityId, deals, roll);
    } catch (e: any) {
      result.errors.push(`deal-rollup: ${e?.message ?? e}`);
    }
  }

  return result;
}

/**
 * Bridge a CRM account OUTCOME onto the people at that account.
 *
 * WHY THIS EXISTS. CRM sync and the pipeline funnel were two disconnected worlds.
 * A synced deal lands on its own `deal` entity carrying the CRM's own stage string,
 * read only by the forecast's rollup. Nothing ever told the FUNNEL that the deal
 * closed, because this file never calls logActivity and therefore never reaches
 * advancePipelineStage. Meanwhile the derivation worker can only reach an outcome
 * from an `interaction.deal_won`/`deal_lost` observation — and nothing but Stripe
 * emits one. So for a customer whose only record of "we won this" is a stage name
 * inside HubSpot, `pipeline_stage` never reached a terminal at all: the account sat
 * at whatever its last email or meeting implied, indefinitely.
 *
 * Deliberately conservative — it fires ONLY when the account has no open deal left,
 * so an account with a live renewal alongside a won deal is untouched. Outcome is
 * read through crmDealState, the same keyword heuristic the forecast already trusts,
 * so a customer's own stage names ("Closed Won", "Deal Lost") work without mapping.
 *
 * advancePipelineStage is advance-only, idempotent, honours `stage_locked`, and its
 * terminal branch refuses to overwrite an existing terminal — so a re-sync is a
 * no-op and this can never walk an account backwards.
 */
async function bridgeOutcomeToPipeline(
  supabase: SupabaseClient,
  workspaceId: string,
  companyEntityId: string,
  deals: CrmDeal[],
  roll: { openDeals: number },
): Promise<void> {
  try {
    // An account with anything still live is still in play — say nothing.
    if (roll.openDeals > 0) return;

    const states = deals.map(d => crmDealState(d));
    if (!states.length || states.some(st => st === 'open')) return;
    const won = states.some(st => st === 'won');
    const type = won ? 'deal_won' : 'deal_lost';

    // Date the transition to the CRM's own close date where it has one, so a
    // historical sync lands the hop when it happened rather than at sync time.
    const closeDates = deals
      .map(d => d.close_date)
      .filter((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
      .sort();
    const occurredAt = won ? closeDates[closeDates.length - 1] : closeDates[0];

    const { data: people } = await supabase
      .from('contacts').select('id').eq('company_id', companyEntityId).limit(200);
    for (const p of (people as Array<{ id: string }> | null) ?? []) {
      await advancePipelineStage(supabase, workspaceId, p.id, type, { occurredAt })
        .catch(() => {});
      // Same follow-through as the live activity hook: a decided deal resolves any
      // open ICP prediction, which is what feeds win-rate and the contrastive model.
      await resolveEntityPredictions(supabase, { workspaceId, entityId: p.id })
        .catch(() => {});
    }
  } catch {
    /* best-effort: the rollup numbers are still worth having if this fails */
  }
}
