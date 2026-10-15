// What a LIST reads (GET-296).
//
// Accounts and people are assembled per request from facts — a name is a claim, a domain an
// identifier, "last activity" an aggregate over every observation of every person at the account.
// That is the right shape for truth and the wrong shape for a list: at about 9,000 accounts the page
// broke three ways in one evening (capped at a thousand rows, then two different timeouts).
//
// `entity_list_rows` holds one row per account and per person with exactly what a list shows,
// refreshed from the substrate by refresh_entity_list_rows(). Reading it is one indexed query —
// 1.5ms for 200 accounts ordered by last activity, the query that used to time out.
//
// It is a CACHE, not the truth: when a workspace has no rows yet (a fresh workspace, or one whose
// refresh has not run), the caller falls back to reading the substrate as before.

import { dealWindowFilter, accountWindowFilter } from './dealListWindow.mjs';
import { ownerFilter } from './ownerScope.mjs';

/** Has this workspace been flattened yet? */
export async function hasListRows(supabase, workspaceId, kind) {
  // One row is the whole question. Counting them all is a scan of a table that a rebuild churns
  // (GET-301), and it sat in front of every accounts page.
  const { data } = await supabase.from('entity_list_rows')
    .select('entity_id')
    .eq('workspace_id', workspaceId).eq('kind', kind)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * A page of accounts or people, newest activity first, with the workspace's own total.
 * `q` matches a name, a domain or an email — on the server, over every row, not the page.
 */
/**
 * Is this the market the workspace focuses on, rather than a one-off country pick?
 * The focus is inclusive of unrecorded countries (see listRows); any other country is exact.
 */
export function isFocusCountry(country, focusCountry) {
  return !!country && !!focusCountry && country.toLowerCase() === String(focusCountry).toLowerCase();
}

// `detail`, `refine` and `orderBy` are for the public API (/v2/accounts, /v2/people?include=all),
// which reads the SAME rows with more filters than the app's list offers. All three are optional
// and off by default, so the app's lists read exactly what they read before.
//   detail   also select industry, won_deals and (once migrated) last_inbound_at
//   refine   (query, { ready, inbound }) => query — extra PostgREST filters, ANDed with the rest
//   orderBy  { col, ascending } — the primary order; entity_id stays the tie-break
export async function listRows(supabase, workspaceId, kind, { q = '', limit = 200, offset = 0, companyId = null, country = null, focusCountry = null, windowed = false, owner = null, detail = false, refine = null, orderBy = null } = {}) {
  const [ready, inbound] = await Promise.all([hasOwnershipColumns(supabase), hasInboundColumn(supabase)]);
  let cols = ready ? `${LEGACY_ACCOUNT_COLS}, owner_name, owner_email` : LEGACY_ACCOUNT_COLS;
  if (detail) cols += `, industry${ready ? ', won_deals' : ''}${inbound ? ', last_inbound_at' : ''}`;
  let query = supabase.from('entity_list_rows')
    .select(cols, { count: 'exact' })
    .eq('workspace_id', workspaceId).eq('kind', kind);
  if (refine) query = refine(query, { ready, inbound });
  if (companyId) query = query.eq('company_id', companyId);
  // An account earns its place by holding a deal the lists would show (dealListWindow.mjs), or by
  // having answered us recently. Only accounts: a person is not filtered by someone else's deals.
  if (ready && windowed && kind === 'account') query = query.or(accountWindowFilter(new Date(), { inbound }));
  // ...and a rep sees their own book. `owner` is null for an admin or anyone we could not resolve
  // to a CRM owner, and a null filter is no filter — never an empty list.
  if (ready && owner) {
    const f = ownerFilter(owner);
    if (f) query = query.or(f);
  }
  // A market focus (GET-311). `country` narrows the list; the count that comes back is the count of
  // that market, so "200 of 6,000 accounts in that market" is a true sentence.
  //
  // The focus country also KEEPS rows with no country at all. A couple of hundred of one customer's
  // accounts have no location in the CRM — many on the focus market's own domain suffix, most active
  // this year, together holding real won deals — and they are not foreign, they are unrecorded. Excluding them would delete a location
  // from the list because HubSpot is missing a city, which is the opposite of focusing a market.
  // Every other country is matched strictly.
  if (country) {
    query = isFocusCountry(country, focusCountry)
      ? query.or(`country.eq.${country},country.is.null`)
      : query.eq('country', country);
  }
  if (q) {
    const like = `%${String(q).replace(/[%,()]/g, ' ')}%`;
    // company_name too: people are found by where they work as often as by name.
    query = query.or(`name.ilike.${like},domain.ilike.${like},email.ilike.${like},company_name.ilike.${like}`);
  }
  const { data, error, count } = await query
    .order(orderBy?.col ?? 'last_activity_at', { ascending: orderBy?.ascending ?? false, nullsFirst: false })
    // A total order, not just "by activity": thousands of rows share a null or identical timestamp,
    // and without a tie-break Postgres may return them in a different order on every read — so
    // "Load more" (offset paging) repeats some people and silently skips others.
    .order('entity_id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
}

/** Rebuild a workspace's rows. Cheap enough to run on a schedule; ~20s on a 9,000-account CRM. */
export async function refreshListRows(supabase, workspaceId) {
  const { data, error } = await supabase.rpc('refresh_entity_list_rows', { ws: workspaceId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { accounts: row?.accounts ?? 0, people: row?.people ?? 0 };
}

/** How many ids fit in one PostgREST `in` list before the URL is the limit (GET-329). */
const ID_BATCH = 100;

// Does this database have the ownership columns yet?
//
// Migrations here are applied BY HAND in the dashboard and the app is deployed separately, so the
// two orders both happen. Selecting a column that does not exist is a 400 from PostgREST, which
// would take the Accounts and Pipeline tabs down completely — a worse outcome than not scoping.
// So the reader asks once and degrades to exactly today's behaviour until the migration lands.
//
// Only a TRUE answer is cached. A false one re-probes, so applying the migration starts working
// without restarting the API, and a transient error never latches the feature off for the life of
// the process. Same posture as crmPipelineRef and pipelineStageStats.
let ownershipColumnsPresent = false;
export async function hasOwnershipColumns(supabase) {
  if (ownershipColumnsPresent) return true;
  const { error } = await supabase.from('entity_list_rows')
    .select('owner_email, won_deals, child_deals, last_lost_at, pipeline').limit(1);
  if (!error) ownershipColumnsPresent = true;
  return ownershipColumnsPresent;
}

// Does it have `last_inbound_at` (2026_09_21_last_inbound_at.sql)? Probed separately from the
// ownership columns so that migration can land on its own, and cached the same way: only a true
// answer sticks. Until it does, the account window keeps counting any touch — see
// accountWindowFilter.
let inboundColumnPresent = false;
export async function hasInboundColumn(supabase) {
  if (inboundColumnPresent) return true;
  const { error } = await supabase.from('entity_list_rows').select('last_inbound_at').limit(1);
  if (!error) inboundColumnPresent = true;
  return inboundColumnPresent;
}

// Does it have the stored deal health (2026_10_02_deal_health_rows.sql)? Same posture as the two
// probes above: applied by hand, deployed separately, only a true answer is cached. Until it lands
// every deal reads health null, exactly as before.
let dealHealthColumnsPresent = false;
export async function hasDealHealthColumns(supabase) {
  if (dealHealthColumnsPresent) return true;
  const { error } = await supabase.from('entity_list_rows').select('deal_health_score, deal_health_reason, deal_health_at').limit(1);
  if (!error) dealHealthColumnsPresent = true;
  return dealHealthColumnsPresent;
}

const LEGACY_ACCOUNT_COLS = 'entity_id, name, domain, email, job_title, company_id, company_name, country, stage, icp_score, deal_health, people_count, open_deals, pipeline_value, won_value, last_activity_at';
const LEGACY_DEAL_COLS = 'entity_id, name, company_id, company_name, country, stage, status, pipeline_value, close_date, owner_name, pipeline_ref, last_activity_at';

/**
 * A few faces per account for the avatars: four people each, from the same flattened rows.
 *
 * Batched, because the deal board asks about every account on the board at once — over a thousand
 * on a real CRM — and one `in` list that long is a URL Postgres never sees. Each company falls in
 * exactly one batch, so taking the first four per company stays correct across batches.
 */
export async function facesForAccounts(supabase, workspaceId, companyIds) {
  const byCompany = new Map();
  if (!companyIds.length) return byCompany;
  for (let i = 0; i < companyIds.length; i += ID_BATCH) {
    const { data } = await supabase.from('entity_list_rows')
      // email too: a face is resolved FROM the email (Gravatar), so a roster without emails can
      // only ever draw initials (GET-312).
      .select('entity_id, name, email, company_id, last_activity_at')
      .eq('workspace_id', workspaceId).eq('kind', 'person')
      .in('company_id', companyIds.slice(i, i + ID_BATCH))
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(20000);
    for (const p of data ?? []) {
      if (!p.name) continue;
      const faces = byCompany.get(p.company_id) ?? [];
      if (faces.length < 4) { faces.push({ id: p.entity_id, name: p.name, email: p.email ?? null, photo_url: null }); byCompany.set(p.company_id, faces); }
    }
  }
  return byCompany;
}

/**
 * Every deal a pipeline board shows, from the flattened rows. Ordered by close date.
 *
 * `windowed` narrows to what a workspace list shows — open and won at any age, losses only from
 * the last 12 months (see dealWindow.mjs). Off by default, so a caller that must read the whole
 * history keeps reading it.
 */
export async function listDealRows(supabase, workspaceId, { status = null, country = null, focusCountry = null, windowed = false, owner = null, pipelineRef = null } = {}) {
  // PAGED, because `.limit(20000)` is not a limit: PostgREST answers with at most 1000 rows and says
  // nothing about the rest, so the board silently showed 1,000 of several thousand deals.
  const [ready, health] = await Promise.all([hasOwnershipColumns(supabase), hasDealHealthColumns(supabase)]);
  const cols = `${LEGACY_DEAL_COLS}${ready ? ', pipeline' : ''}${health ? ', deal_health_score, deal_health_reason, deal_health_at' : ''}`;
  const data = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('entity_list_rows')
      .select(cols)
      .eq('workspace_id', workspaceId).eq('kind', 'deal');
    if (status && status !== 'all') q = q.eq('status', status);
    // A rep's own deals. Null for an admin or an unresolved viewer, and null means no filter.
    if (ready && owner) { const f = ownerFilter(owner); if (f) q = q.or(f); }
    // One pipeline at a time, so a stage strip describes one funnel. The id, never the name: reps
    // rename pipelines and HubSpot's arrive with stray whitespace.
    if (pipelineRef) q = q.eq('pipeline_ref', pipelineRef);
    // What a workspace list shows. A second `or` on the same query is ANDed with the country one
    // below, not overridden.
    if (windowed) q = q.or(dealWindowFilter());
    // The market this board is focused on (GET-311); null shows every deal. Same rule as the
    // account list: the focus keeps deals whose account has no recorded country.
    if (country) {
      q = isFocusCountry(country, focusCountry)
        ? q.or(`country.eq.${country},country.is.null`)
        : q.eq('country', country);
    }
    const { data: page, error } = await q
      .order('close_date', { ascending: true, nullsFirst: false })
      // close_date repeats across thousands of deals, so paging needs a total order to not repeat
      // or skip rows between pages.
      .order('entity_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    data.push(...(page ?? []));
    if (!page || page.length < 1000 || data.length >= 20000) break;
  }
  // The two things this path used to hand back empty, both of them one lookup away on rows we
  // already hold (GET-297 called the roster "a deliberate gap"; the favicon was never mentioned
  // because nobody traced why every deal row drew a letter tile).
  //
  //   company_domain — the deal row has company_id but no domain; the ACCOUNT row next to it in
  //     the same table has one. Without it every favicon on the board falls back to initials.
  //   roster_people  — the people at the account. A CRM-given roster (`stakeholder_of`) is the
  //     better answer and lives in the substrate, so this is the account fallback the claims path
  //     already documents: shown, and flagged `roster_known: false` so nobody reads it as the
  //     deal's actual buying committee.
  const rows = data ?? [];
  const companyIds = [...new Set(rows.map(d => d.company_id).filter(Boolean))];
  const [domains, faces] = await Promise.all([
    domainsForAccounts(supabase, workspaceId, companyIds),
    facesForAccounts(supabase, workspaceId, companyIds),
  ]);
  return rows.map(d => {
    const people = faces.get(d.company_id) ?? [];
    // Nous deal health, stored twice a day by the worker (dealHealthRefresh.mjs) with the deal page's
    // own computation. Open deals only: a closed deal's last score describes a deal that is gone.
    const open = String(d.status ?? '').toLowerCase() === 'open';
    return {
      id: d.entity_id, name: d.name, company_id: d.company_id, company_name: d.company_name,
      company_domain: domains.get(d.company_id) ?? null,
      stage: d.stage, status: d.status, value: d.pipeline_value,
      // Selected above and read by dealVerdict (dealSignals.mjs) for "nobody has worked it since";
      // it used to be dropped here, so every open deal read as never worked.
      close_date: d.close_date, owner_name: d.owner_name, last_activity_at: d.last_activity_at ?? null,
      pipeline_id: d.pipeline_ref, pipeline: d.pipeline ?? null,
      roster_ids: people.map(p => p.id), roster_people: people, roster_count: people.length,
      roster_known: false,
      health_score: open ? d.deal_health_score ?? null : null,
      health_reason: open ? d.deal_health_reason ?? null : null,
      health_at: open ? d.deal_health_at ?? null : null,
    };
  });
}

/**
 * Just the money: every won and open deal's account, status and amount, nothing else. For callers
 * that roll value up per account (the Insights board's "At stake") and would otherwise pay for
 * listDealRows' domains, faces and rosters twice over. `value` is null when the CRM sent no amount.
 * @returns {Promise<{company_id: string|null, status: string, value: number|null}[]>}
 */
export async function listDealValues(supabase, workspaceId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase.from('entity_list_rows')
      .select('entity_id, company_id, status, pipeline_value')
      .eq('workspace_id', workspaceId).eq('kind', 'deal').in('status', ['won', 'open'])
      .order('entity_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    for (const d of page ?? []) out.push({ company_id: d.company_id ?? null, status: d.status, value: d.pipeline_value == null ? null : Number(d.pipeline_value) });
    if (!page || page.length < 1000 || out.length >= 50000) break;
  }
  return out;
}

/** domain per account id, off the same flattened table the deals came from. */
export async function domainsForAccounts(supabase, workspaceId, companyIds) {
  const byId = new Map();
  if (!companyIds.length) return byId;
  // 100 at a time: an `in` list is a URL, and a few hundred uuids do not fit in one (GET-329).
  for (let i = 0; i < companyIds.length; i += ID_BATCH) {
    const { data } = await supabase.from('entity_list_rows')
      .select('entity_id, domain')
      .eq('workspace_id', workspaceId).eq('kind', 'account')
      .in('entity_id', companyIds.slice(i, i + ID_BATCH));
    for (const a of data ?? []) if (a.domain) byId.set(a.entity_id, a.domain);
  }
  return byId;
}

/**
 * The photo each person has on file, by entity id: the photo_url claim (LinkedIn, the CRM, the
 * Google contact photo). A person with none is absent, and the list falls back to Gravatar.
 */
export async function photosForPeople(supabase, workspaceId, personIds) {
  const byId = new Map();
  if (!personIds.length) return byId;
  for (let i = 0; i < personIds.length; i += ID_BATCH) {
    const { data } = await supabase.from('claims')
      .select('entity_id, value, confidence')
      .eq('workspace_id', workspaceId).eq('property', 'photo_url').is('invalid_at', null)
      .in('entity_id', personIds.slice(i, i + ID_BATCH));
    for (const c of (data ?? []).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
      const url = typeof c.value === 'string' ? c.value : c.value?.value;
      if (typeof url === 'string' && /^https:\/\//.test(url) && !byId.has(c.entity_id)) byId.set(c.entity_id, url);
    }
  }
  return byId;
}

/**
 * The markets this workspace's accounts are in, most accounts first, for the country filter.
 * Read off the flattened rows, so it costs one indexed scan and never the claims table.
 */
export async function accountCountries(supabase, workspaceId) {
  const counts = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('entity_list_rows')
      .select('country')
      .eq('workspace_id', workspaceId).eq('kind', 'account').not('country', 'is', null)
      .order('country').range(from, from + 999);
    if (error) return [];
    for (const r of data ?? []) counts.set(r.country, (counts.get(r.country) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([country, accounts]) => ({ country, accounts }));
}

// The account's own deal value, rolled up from its people.
//
// An account with no CRM deal still has a deal — the implied one the board shows as
// "<name> deal" — and its amount is typed on the deal page, which writes `deal_value` on the
// account's primary contact. Nothing read it back, so every implied deal's Value column said
// "—" while the deal page it came from said $199.
//
// One indexed read over the ids ON THIS PAGE, filtered to the few people who carry a value:
// a few hundred ms against the largest workspace we have, 200 accounts, because almost nobody does. This
// is not the query that timed out in GET-294 — that one asked each person for every column.
//
// Max rather than sum: one live deal per account, so summing would double-count a roster.
//
// Batched by ID_BATCH (GET-329): the public deal list asks about every implied deal at once.
export async function dealValueByCompany(supabase, companyIds) {
  const out = new Map();
  if (!companyIds?.length) return out;
  for (let i = 0; i < companyIds.length; i += ID_BATCH) {
    const { data, error } = await supabase
      .from('contacts')
      .select('company_id, deal_value')
      .in('company_id', companyIds.slice(i, i + ID_BATCH))
      .not('deal_value', 'is', null)
      .limit(2000);
    if (error) { console.error('[companies/list] deal value rollup:', error.message); return out; }
    for (const r of data ?? []) {
      const v = Number(r.deal_value);
      if (!Number.isFinite(v) || !r.company_id) continue;
      const cur = out.get(r.company_id);
      if (cur == null || v > cur) out.set(r.company_id, v);
    }
  }
  return out;
}

/**
 * Every person's stage per account, off the flattened person rows — what accountStage() needs to
 * say an account's stage without reading the claims. Batched like facesForAccounts.
 * @returns Map<companyId, Array<string|null>>
 */
export async function personStagesForAccounts(supabase, workspaceId, companyIds) {
  const byCompany = new Map();
  if (!companyIds?.length) return byCompany;
  for (let i = 0; i < companyIds.length; i += ID_BATCH) {
    const batch = companyIds.slice(i, i + ID_BATCH);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('entity_list_rows')
        .select('entity_id, company_id, stage')
        .eq('workspace_id', workspaceId).eq('kind', 'person')
        .in('company_id', batch)
        .order('entity_id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      for (const p of data ?? []) {
        const list = byCompany.get(p.company_id) ?? [];
        list.push(p.stage ?? null);
        byCompany.set(p.company_id, list);
      }
      if (!data || data.length < 1000) break;
    }
  }
  return byCompany;
}

/**
 * The CRM identifier kinds: a person carrying one of these is linked to a record in the CRM.
 * (The contacts view's `ei.kind IN (…)` list also has stripe, which is billing, not a CRM.)
 */
export const CRM_ID_KINDS = ['hubspot', 'salesforce', 'pipedrive', 'attio', 'crm'];

/**
 * Which of these people are linked to a CRM record (GET-788). A meeting note-taker creates every
 * attendee it can name, CRM or not; the people list tags the ones with no CRM id so they can be
 * reviewed or pushed. "No CRM id linked", strictly: the connect import reaches the last twelve
 * months, so someone can sit in the CRM unlinked until a push or sync resolves them.
 */
export async function crmLinkedPeople(supabase, workspaceId, personIds) {
  const linked = new Set();
  for (let i = 0; i < personIds.length; i += ID_BATCH) {
    const { data, error } = await supabase.from('entity_identifiers')
      .select('entity_id')
      .eq('workspace_id', workspaceId).in('kind', CRM_ID_KINDS)
      .in('entity_id', personIds.slice(i, i + ID_BATCH));
    if (error) throw error;
    for (const r of data ?? []) linked.add(r.entity_id);
  }
  return linked;
}

/** Whether this workspace has a CRM connected at all. Without one, "not in the CRM" says nothing. */
export async function workspaceHasCrm(supabase, workspaceId) {
  const { data, error } = await supabase.from('crm_sync_configs').select('provider').eq('workspace_id', workspaceId).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
