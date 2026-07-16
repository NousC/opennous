// CRM integrations — shared by the API (manual sync) and the worker
// (auto-sync cron). Each provider exposes incremental fetchers for contacts,
// companies, and deals. The orchestrator pulls all three and upserts into
// the v2 substrate via the contacts/companies views (entity + identifiers +
// state observations via INSTEAD OF triggers) and entities directly for
// deals (which don't have a v1-shape view).

import type { SupabaseClient } from '@supabase/supabase-js';
import { echoFieldsToSkip } from '../../db/crmWriteState.js';

// ─── shared types ────────────────────────────────────────────────────────────

export type CrmProvider = 'hubspot' | 'pipedrive' | 'attio';

export interface CrmContact {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  domain?: string | null;
  phone?: string | null;
  owner_name?: string | null;
  updated_at?: string | null;
}

export interface CrmCompany {
  id: string;
  name: string | null;
  domain: string | null;
  industry?: string | null;
  city?: string | null;
  country?: string | null;
  updated_at?: string | null;
}

export interface CrmDeal {
  id: string;
  name: string | null;
  value: number | null;
  currency: string | null;
  stage: string | null;
  close_date?: string | null;
  owner_name?: string | null;
  contact_ids?: string[];   // CRM-side contact ids associated with the deal
  company_id?: string | null;
  updated_at?: string | null;
}

export interface FetchOpts {
  since?: string;          // ISO timestamp — only records updated after this
  cursor?: string | number; // provider-specific pagination token
  limit?: number;          // page size; default 100, max 200
}

export interface FetchResult<T> {
  records: T[];
  cursor: string | number | null;  // next page cursor, or null if done
}

// ─── HubSpot ─────────────────────────────────────────────────────────────────

const HUBSPOT_PROPS = {
  contacts:  ['firstname', 'lastname', 'email', 'company', 'phone', 'lastmodifieddate'],
  companies: ['name', 'domain', 'industry', 'city', 'country', 'phone', 'hs_lastmodifieddate'],
  deals:     ['dealname', 'amount', 'dealstage', 'closedate', 'pipeline', 'hs_lastmodifieddate'],
};

async function hubspotSearch<T>(
  token: string,
  object: 'contacts' | 'companies' | 'deals',
  opts: FetchOpts,
  mapper: (r: any) => T,
): Promise<FetchResult<T>> {
  const propName = object === 'companies' || object === 'deals'
    ? 'hs_lastmodifieddate' : 'lastmodifieddate';
  const body: any = {
    properties: HUBSPOT_PROPS[object],
    limit: Math.min(opts.limit ?? 100, 200),
    sorts: [{ propertyName: propName, direction: 'ASCENDING' }],
  };
  if (opts.since) {
    body.filterGroups = [{
      filters: [{ propertyName: propName, operator: 'GTE', value: new Date(opts.since).getTime() }],
    }];
  }
  if (opts.cursor) body.after = opts.cursor;

  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
      updated_at: p.hs_lastmodifieddate ?? null,
    };
  }),
  fetchDeals: (token: string, opts: FetchOpts = {}) => hubspotSearch<CrmDeal>(token, 'deals', opts, r => {
    const p = r.properties || {};
    return {
      id: r.id,
      name: p.dealname ?? null,
      value: p.amount ? Number(p.amount) : null,
      currency: '$',
      stage: p.dealstage ?? null,
      close_date: p.closedate ?? null,
      updated_at: p.hs_lastmodifieddate ?? null,
    };
  }),
};

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
    close_date: r.close_time ?? null,
    owner_name: r.owner_name ?? null,
    company_id: r.org_id?.value ? String(r.org_id.value) : null,
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
      company: null,   // Attio represents this as a relationship; we skip name-lookup here
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
  fetchDeals: (apiKey: string, opts: FetchOpts = {}) => attioQuery<CrmDeal>(apiKey, 'deals', opts, r => ({
    id: r.id?.record_id ?? r.id,
    name: attioVal(r, 'name'),
    value: r.values?.value?.[0]?.value?.amount ?? null,
    currency: r.values?.value?.[0]?.value?.currency_code ?? '$',
    stage: attioVal(r, 'stage'),
    close_date: null,
    company_id: null,
    contact_ids: [],
    updated_at: r.updated_at ?? null,
  })),
};

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

async function upsertContact(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  c: CrmContact,
): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!c.email && !c.id) return 'skipped';
  const idColumn = provider === 'hubspot' ? 'hubspot_id'
                 : provider === 'pipedrive' ? 'pipedrive_id'
                 : 'attio_id';

  // Match priority: by external CRM id first, then by email.
  let existing: { id: string } | null = null;
  {
    const { data } = await supabase.from('contacts').select('id')
      .eq('workspace_id', workspaceId).eq(idColumn, c.id).maybeSingle();
    existing = data ?? null;
  }
  if (!existing && c.email) {
    const { data } = await supabase.from('contacts').select('id')
      .eq('workspace_id', workspaceId).eq('email', c.email.toLowerCase().trim()).maybeSingle();
    existing = data ?? null;
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

  if (existing) {
    // Echo suppression: if company/phone match a value Nous just wrote to this
    // record, drop them from the update so we don't re-ingest our own write.
    const skip = await echoFieldsToSkip(supabase, workspaceId, provider, c.id, { company: c.company, phone: c.phone });
    if (skip.has('company')) delete payload.company;
    if (skip.has('phone'))   delete payload.phone;
    await supabase.from('contacts').update(payload).eq('id', existing.id);
    return 'updated';
  }
  await supabase.from('contacts').insert(payload);
  return 'inserted';
}

async function upsertCompany(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  co: CrmCompany,
): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!co.name && !co.domain) return 'skipped';
  const idColumn = provider === 'hubspot' ? 'hubspot_company_id'
                 : provider === 'pipedrive' ? 'pipedrive_org_id'
                 : 'attio_company_id';

  let existing: { id: string } | null = null;
  {
    const { data } = await supabase.from('companies').select('id')
      .eq('workspace_id', workspaceId).eq(idColumn, co.id).maybeSingle();
    existing = data ?? null;
  }
  if (!existing && co.domain) {
    const normalized = co.domain.replace(/^www\./, '').toLowerCase().trim();
    const { data } = await supabase.from('companies').select('id')
      .eq('workspace_id', workspaceId).eq('domain', normalized).maybeSingle();
    existing = data ?? null;
  }

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: co.name,
    domain: co.domain ? co.domain.replace(/^www\./, '').toLowerCase().trim() : null,
    industry: co.industry,
    location: [co.city, co.country].filter(Boolean).join(', ') || null,
    [idColumn]: co.id,
  };

  if (existing) {
    await supabase.from('companies').update(payload).eq('id', existing.id);
    return 'updated';
  }
  await supabase.from('companies').insert(payload);
  return 'inserted';
}

// Deals → entities of type='deal' with claims. No view wrapper yet.
async function upsertDeal(
  supabase: SupabaseClient,
  workspaceId: string,
  provider: CrmProvider,
  d: CrmDeal,
): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!d.name && !d.id) return 'skipped';
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

  if (!entityId) {
    const { data: created, error } = await supabase.from('entities')
      .insert({ workspace_id: workspaceId, type: 'deal', status: 'active' })
      .select('id').single();
    if (error || !created) return 'skipped';
    entityId = created.id;
    await supabase.from('entity_identifiers').insert({
      workspace_id: workspaceId, entity_id: entityId, kind, value: d.id,
    }).then(() => {}, () => {});
  }

  // Write current state as observations (the claim engine will derive claims).
  const facts: Array<[string, unknown]> = [
    ['name',       d.name],
    ['value',      d.value],
    ['currency',   d.currency],
    ['stage',      d.stage],
    ['close_date', d.close_date],
    ['owner_name', d.owner_name],
  ];
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
      observed_at: d.updated_at ?? new Date().toISOString(),
    }));
  if (rows.length) await supabase.from('observations').insert(rows).then(() => {}, () => {});

  return entityId ? 'updated' : 'inserted';
}

// ─── The orchestrator ────────────────────────────────────────────────────────

export interface SyncRunResult {
  contacts: { fetched: number; inserted: number; updated: number; skipped: number };
  companies: { fetched: number; inserted: number; updated: number; skipped: number };
  deals: { fetched: number; inserted: number; updated: number; skipped: number };
  errors: string[];
}

const PROVIDER_FETCHERS: Record<CrmProvider, typeof hubspot> = { hubspot, pipedrive, attio };

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_RUN = 20;   // safety cap → 2k records per kind per run

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
): Promise<SyncRunResult> {
  const fetcher = PROVIDER_FETCHERS[provider];
  if (!fetcher) throw new Error(`Unsupported CRM provider: ${provider}`);

  const result: SyncRunResult = {
    contacts:  { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
    companies: { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
    deals:     { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
    errors: [],
  };

  // ── contacts ──
  try {
    let cursor: string | number | null = null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const { records, cursor: next } = await fetcher.fetchContacts(token, {
        since: since ?? undefined,
        cursor: cursor ?? undefined,
        limit: PAGE_LIMIT,
      });
      result.contacts.fetched += records.length;
      for (const r of records) {
        const outcome = await upsertContact(supabase, workspaceId, provider, r);
        result.contacts[outcome]++;
      }
      if (!next) break;
      cursor = next;
    }
  } catch (e: any) {
    result.errors.push(`contacts: ${e?.message ?? e}`);
  }

  // ── companies ──
  try {
    let cursor: string | number | null = null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const { records, cursor: next } = await fetcher.fetchCompanies(token, {
        since: since ?? undefined,
        cursor: cursor ?? undefined,
        limit: PAGE_LIMIT,
      });
      result.companies.fetched += records.length;
      for (const r of records) {
        const outcome = await upsertCompany(supabase, workspaceId, provider, r);
        result.companies[outcome]++;
      }
      if (!next) break;
      cursor = next;
    }
  } catch (e: any) {
    result.errors.push(`companies: ${e?.message ?? e}`);
  }

  // ── deals ──
  try {
    let cursor: string | number | null = null;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const { records, cursor: next } = await fetcher.fetchDeals(token, {
        since: since ?? undefined,
        cursor: cursor ?? undefined,
        limit: PAGE_LIMIT,
      });
      result.deals.fetched += records.length;
      for (const r of records) {
        const outcome = await upsertDeal(supabase, workspaceId, provider, r);
        result.deals[outcome]++;
      }
      if (!next) break;
      cursor = next;
    }
  } catch (e: any) {
    result.errors.push(`deals: ${e?.message ?? e}`);
  }

  return result;
}
