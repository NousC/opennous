import type { SupabaseClient } from '@supabase/supabase-js';
import { isUUID } from '../utils/identity.js';
import type { Lead, LeadList, LeadColumn, LeadStatus, ReplyOutcome } from '../types.js';

// DB layer for Lead Lists — the cold outreach universe, kept separate from
// `contacts` (People). See docs/adaptive-lead-scoring.md.

const LEAD_LIST_COLUMNS = 'id, workspace_id, name, source, columns, created_at, updated_at';

// Only the columns the lead-list UI actually renders. The `leads` VIEW derives
// every column with a correlated subquery, and PostgreSQL prunes the subqueries
// for columns we don't SELECT — so omitting unused ones (sent_at, send_variant,
// is_repeat_contact, features, replied_at, contact_id, updated_at) drops ~7
// per-row lookups per page, including the costly updated_at max-over-all-claims.
const LEAD_COLUMNS =
  'id, lead_list_id, workspace_id, email, name, company, linkedin_url, ' +
  'fields, scorecard_score, reply_outcome, status, created_at, ' +
  'domain, email_status, last_channel, source';

// Columns a new list starts with, beyond the fixed name / email / company /
// linkedin / status. Stored on lead_lists.columns; values live in leads.fields.
const DEFAULT_LEAD_COLUMNS: LeadColumn[] = [
  { key: 'title',        label: 'Title' },
  { key: 'industry',     label: 'Industry' },
  { key: 'company_size', label: 'Company size' },
];

const cleanEmail = (email: string | null | undefined): string | null =>
  email ? email.toLowerCase().trim() || null : null;

// ── Lead lists ────────────────────────────────────────────────────────────────

export interface CreateLeadListParams {
  name: string;
  source?: string;
}

export async function createLeadList(
  supabase: SupabaseClient,
  workspaceId: string,
  params: CreateLeadListParams,
): Promise<LeadList> {
  const { data, error } = await supabase
    .from('lead_lists')
    .insert({
      workspace_id: workspaceId,
      name: params.name.trim(),
      source: params.source ?? 'csv',
      columns: DEFAULT_LEAD_COLUMNS,
    })
    .select(LEAD_LIST_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as LeadList;
}

// Replace a list's user-defined column set.
export async function updateLeadListColumns(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  columns: LeadColumn[],
): Promise<LeadList | null> {
  if (!isUUID(id)) return null;
  const clean = columns
    .filter(c => c && typeof c.key === 'string' && c.key.trim())
    .map(c => ({ key: c.key.trim(), label: String(c.label || c.key).trim() }));
  const { data, error } = await supabase
    .from('lead_lists')
    .update({ columns: clean })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(LEAD_LIST_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as LeadList) ?? null;
}

export async function listLeadLists(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<LeadList[]> {
  // `lead_lists` and `leads` are v2 VIEWs (Phase 5), so PostgREST can't embed
  // `leads(count)` across them — there's no FK between two views. Fetch the
  // lists, then get every list's count in ONE grouped query via the
  // `lead_list_counts` RPC (was a head+count query per list — N round-trips).
  const { data, error } = await supabase
    .from('lead_lists')
    .select(LEAD_LIST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const lists = (data || []) as unknown as LeadList[];
  const { data: countRows, error: countError } = await supabase
    .rpc('lead_list_counts', { p_ws: workspaceId });
  if (countError) throw countError;
  const counts = new Map<string, number>(
    ((countRows || []) as { lead_list_id: string; lead_count: number }[])
      .map(r => [r.lead_list_id, Number(r.lead_count) || 0]),
  );
  return lists.map(list => ({
    ...list,
    lead_count: counts.get((list as unknown as { id: string }).id) ?? 0,
  }));
}

export async function getLeadList(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<LeadList | null> {
  if (!isUUID(id)) return null;
  const { data, error } = await supabase
    .from('lead_lists')
    .select(LEAD_LIST_COLUMNS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as LeadList) ?? null;
}

// Delete an entire lead list. Removes the list (collection) and its membership;
// the underlying entities + engagement history are never hard-deleted. Requires
// the lead_lists view's INSTEAD OF DELETE trigger. Returns true if a row matched.
export async function deleteLeadList(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  if (!isUUID(id)) return false;
  const { data, error } = await supabase
    .from('lead_lists')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id');
  if (error) throw error;
  return (data || []).length > 0;
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export interface LeadInput {
  email?: string | null;
  name?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  // Stable LinkedIn member URN (e.g. "ACoAA…"). Slug-proof — the resolver matches
  // on this first so an engager merges into an existing contact even when their
  // vanity URL differs (…/vikram-shah vs …/vikram-shah-72bb828a).
  linkedin_member_id?: string | null;
  // Pre-resolved entity to attach this lead to (skips identity resolution).
  contact_id?: string | null;
  send_variant?: string | null;
  is_repeat_contact?: boolean;
  features?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  // Lead source — where this lead came from (Sales Navigator, Apollo, CSV, API,
  // Manual…). Per-row; falls back to the import's defaultSource when absent.
  source?: string | null;
}

// Normalize a LinkedIn URL for cross-list dedup. Same transforms our LinkedIn
// engagement engine uses, so the two stay in sync: lowercase, force
// https, drop www., drop query/fragment, drop trailing slashes.
function normalizeLinkedInUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim();
  if (!trimmed) return null;
  return trimmed
    .toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/^https?:\/\/www\./, 'https://')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

// Bulk-insert leads into a list. Rows with neither an email nor a LinkedIn URL
// are dropped — there would be no way to resolve a reply back to them.
//
// By default rows whose email or normalized LinkedIn URL already exists in the
// workspace are skipped (workspace-wide dedup, matching how operators expect
// re-imports to behave). Pass `{ importDuplicates: true }` to force-insert.
//
// Response counts:
//   - inserted          rows actually written
//   - skipped           total rows not written (no-identifier + duplicates)
//   - duplicate_skipped of `skipped`, how many were dedup matches
export async function insertLeads(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
  rows: LeadInput[],
  opts: { importDuplicates?: boolean; defaultSource?: string | null } = {},
): Promise<{ inserted: number; skipped: number; duplicate_skipped: number }> {
  if (!isUUID(leadListId) || rows.length === 0) {
    return { inserted: 0, skipped: 0, duplicate_skipped: 0 };
  }

  // Identity waterfall — top tier: resolve to an existing entity by STABLE
  // LinkedIn member id before insert, so an engager who is already a contact
  // merges into that record instead of forking a duplicate (the vanity slug can
  // differ; the member URN can't). Email / normalized-url are handled downstream
  // by the leads_insert_handler when no contact_id is supplied.
  const memberIds = Array.from(new Set(
    rows.map(r => r.linkedin_member_id?.trim()).filter((v): v is string => !!v),
  ));
  const midToEntity = new Map<string, string>();
  if (memberIds.length) {
    const { data: mids } = await supabase
      .from('entity_identifiers')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'linkedin_member_id').eq('status', 'active')
      .in('value', memberIds);
    for (const m of mids || []) midToEntity.set(m.value as string, m.entity_id as string);
  }

  const defaultSource = opts.defaultSource?.trim() || null;
  const payload = rows
    .map(r => {
      const mid = r.linkedin_member_id?.trim() || null;
      return {
        lead_list_id: leadListId,
        workspace_id: workspaceId,
        contact_id: r.contact_id ?? (mid ? midToEntity.get(mid) ?? null : null),
        email: cleanEmail(r.email),
        name: r.name?.trim() || null,
        company: r.company?.trim() || null,
        linkedin_url: r.linkedin_url?.trim() || null,
        send_variant: r.send_variant ?? null,
        is_repeat_contact: r.is_repeat_contact ?? false,
        features: r.features ?? {},
        fields: r.fields ?? {},
        source: r.source?.trim() || defaultSource,
      };
    })
    .filter(r => r.email || r.linkedin_url);

  const droppedNoIdentifier = rows.length - payload.length;

  let toInsert = payload;
  let duplicateSkipped = 0;

  if (!opts.importDuplicates && payload.length > 0) {
    // Pull every existing email + linkedin_url ALREADY IN THIS LIST, paginated,
    // and filter the incoming payload through them. Per-list (not workspace-wide):
    // the same person is allowed to live in more than one list, so list B can
    // reuse list A's enrichment instead of paying again — the enrich reuse-gate
    // is the credit guard, not a hard import skip. We only block re-adding the
    // same person to the SAME list twice.
    const existingEmails = new Set<string>();
    const existingUrls = new Set<string>();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('leads')
        .select('email, linkedin_url')
        .eq('workspace_id', workspaceId)
        .eq('lead_list_id', leadListId)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (row.email) existingEmails.add(row.email.toLowerCase().trim());
        const u = normalizeLinkedInUrl(row.linkedin_url);
        if (u) existingUrls.add(u);
      }
      if (data.length < PAGE) break;
    }

    toInsert = payload.filter(r => {
      if (r.email && existingEmails.has(r.email)) return false;
      const u = normalizeLinkedInUrl(r.linkedin_url);
      if (u && existingUrls.has(u)) return false;
      return true;
    });
    duplicateSkipped = payload.length - toInsert.length;
  }

  if (toInsert.length === 0) {
    return {
      inserted: 0,
      skipped: droppedNoIdentifier + duplicateSkipped,
      duplicate_skipped: duplicateSkipped,
    };
  }

  const { data, error } = await supabase.from('leads').insert(toInsert).select('id');
  if (error) throw error;
  return {
    inserted: data?.length ?? 0,
    skipped: droppedNoIdentifier + duplicateSkipped,
    duplicate_skipped: duplicateSkipped,
  };
}

// Channel filter → the interaction sources that map to each human channel.
// Mirrors channelLabel() in the Lists UI so "Channel is LinkedIn" filters the
// same way the column displays.
const CHANNEL_SOURCES: Record<string, string[]> = {
  linkedin: ['heyreach', 'linkedin', 'apify_linkedin', 'unipile'],
  email: ['instantly', 'smartlead', 'lemlist', 'emailbison', 'gmail', 'smtp', 'imap'],
  meeting: ['calendly', 'cal_com', 'calendar'],
  slack: ['slack'],
};

// The lead-list filter dimensions, shared by the paged table read (listLeads)
// and agent/bulk targeting (selectLeadIdsByFilter) so "all unverified" resolves
// to the same set everywhere.
export interface LeadFilterOpts {
  icp?: 'true' | 'false';
  status?: string;        // pending | sent | replied | bounced
  reply?: string;         // interested | objection | wrong_fit | unsubscribe
  verified?: string;      // exact email_status value
  channel?: string;       // none | a known group (linkedin/email/…) | free-text substring of last_channel
  emailStatus?: string;   // has | none | unverified | <exact email_status value>
  domain?: string;        // has | none
  size?: string;          // substring match on fields->>company_size
  source?: string;        // free-text substring of the lead's source
  search?: string;        // free-text substring across name / email / company
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyLeadFilters(query: any, opts: LeadFilterOpts): any {
  if (opts.icp === 'true' || opts.icp === 'false') query = query.filter('fields->>icp', 'eq', opts.icp);
  if (opts.status)   query = query.eq('status', opts.status);
  if (opts.reply)    query = query.eq('reply_outcome', opts.reply);
  if (opts.verified) query = query.eq('email_status', opts.verified);
  // Channel: 'none' = never contacted; a known group expands to its sources;
  // anything else is a free-text substring match on the raw last_channel source.
  if (opts.channel === 'none') query = query.is('last_channel', null);
  else if (opts.channel && CHANNEL_SOURCES[opts.channel]) query = query.in('last_channel', CHANNEL_SOURCES[opts.channel]);
  else if (opts.channel) query = query.ilike('last_channel', `%${opts.channel}%`);
  // Email: has/none; 'unverified' = has an email but no verification verdict yet;
  // else an exact email_status (DELIVERABLE/RISKY/UNAVAILABLE).
  if (opts.emailStatus === 'has') query = query.not('email', 'is', null);
  else if (opts.emailStatus === 'none') query = query.is('email', null);
  else if (opts.emailStatus === 'unverified') query = query.not('email', 'is', null).is('email_status', null);
  else if (opts.emailStatus) query = query.eq('email_status', opts.emailStatus);
  if (opts.domain === 'has') query = query.not('domain', 'is', null);
  else if (opts.domain === 'none') query = query.is('domain', null);
  if (opts.size) query = query.ilike('fields->>company_size', `%${opts.size}%`);
  // Source: free-text substring match on where the lead came from.
  if (opts.source) query = query.ilike('source', `%${opts.source}%`);
  // Search: one box across name / email / company. Strip the chars that would
  // break the PostgREST or() filter (commas, parens, wildcards) before matching.
  if (opts.search) {
    const s = opts.search.replace(/[,()%*]/g, ' ').trim();
    if (s) query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%,company.ilike.%${s}%`);
  }
  return query;
}

// Resolve the lead ids in a list that match a filter. Selects only `id`, so the
// view's per-row subqueries are pruned and it stays cheap even at the cap — this
// powers agent/bulk "enrich all unverified / with a domain but no email" targeting.
export async function selectLeadIdsByFilter(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
  filter: LeadFilterOpts = {},
  cap = 5000,
): Promise<string[]> {
  if (!isUUID(leadListId)) return [];
  let query = supabase.from('leads').select('id')
    .eq('workspace_id', workspaceId).eq('lead_list_id', leadListId);
  query = applyLeadFilters(query, filter);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(cap);
  if (error) throw error;
  return ((data || []) as { id: string }[]).map(r => r.id);
}

// Like selectLeadIdsByFilter but also returns email + domain — the minimum
// needed to resolve the EFFECTIVE domain and to join predictions for tier
// counting/filtering, WITHOUT pulling the heavy `fields` jsonb per row. This is
// what keeps tier counts + the tier/domain filters fast across a whole list.
export async function selectLeadsLite(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
  filter: LeadFilterOpts = {},
  cap = 5000,
): Promise<{ id: string; email: string | null; domain: string | null }[]> {
  if (!isUUID(leadListId)) return [];
  let query = supabase.from('leads').select('id, email, domain')
    .eq('workspace_id', workspaceId).eq('lead_list_id', leadListId);
  query = applyLeadFilters(query, filter);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(cap);
  if (error) throw error;
  return (data || []) as { id: string; email: string | null; domain: string | null }[];
}

export async function listLeads(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
  opts: LeadFilterOpts & {
    limit?: number;
    offset?: number;
    sort?: 'recent' | 'icp_score_desc' | 'icp_score_asc';
  } = {},
): Promise<Lead[]> {
  if (!isUUID(leadListId)) return [];
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  const sort = opts.sort ?? 'recent';

  // Numeric sort on a JSONB field can't go through PostgREST, so use the RPC.
  // Falls through to the plain query if the migration isn't applied yet.
  // The icp-score sort RPC only knows the icp filter; if a status/reply/verified
  // filter is active, fall through to the plain query so those apply correctly.
  if ((sort === 'icp_score_desc' || sort === 'icp_score_asc') && !opts.status && !opts.reply
      && !opts.verified && !opts.channel && !opts.emailStatus && !opts.domain && !opts.size && !opts.source) {
    const { data, error } = await supabase.rpc('lead_list_leads', {
      p_ws: workspaceId, p_list: leadListId, p_lim: limit, p_off: offset,
      p_icp: opts.icp ?? null, p_sort: sort,
    });
    if (!error) return (data || []) as unknown as Lead[];
  }

  let query = supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('lead_list_id', leadListId);
  query = applyLeadFilters(query, opts);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return (data || []) as unknown as Lead[];
}

// ICP segmentation counts for a list — drives the "ICP 168 / Non-ICP 253" chips.
export async function countLeadsByIcp(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
): Promise<{ icp: number; non_icp: number }> {
  if (!isUUID(leadListId)) return { icp: 0, non_icp: 0 };
  const base = () =>
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('lead_list_id', leadListId);
  const [icpRes, nonRes] = await Promise.all([
    base().filter('fields->>icp', 'eq', 'true'),
    base().filter('fields->>icp', 'eq', 'false'),
  ]);
  return { icp: icpRes.count ?? 0, non_icp: nonRes.count ?? 0 };
}

// Connect → message → reply funnel counts for a list (drives the LinkedIn
// Connections header stat: "Connected 100 · Messaged 90 · Replied 5"). Cumulative:
// `messaged` includes those who later replied; `connected` is the whole list (in
// the connections list everyone is at least a connection).
export async function countLeadFunnel(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
): Promise<{ connected: number; messaged: number; replied: number }> {
  if (!isUUID(leadListId)) return { connected: 0, messaged: 0, replied: 0 };
  const base = () =>
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('lead_list_id', leadListId);
  const [totalRes, msgRes, replyRes] = await Promise.all([
    base(),
    base().in('status', ['messaged', 'sent', 'replied']),
    base().eq('status', 'replied'),
  ]);
  return { connected: totalRes.count ?? 0, messaged: msgRes.count ?? 0, replied: replyRes.count ?? 0 };
}

// Resolve an inbound reply to a lead. Returns the most recent matching lead in
// the workspace, or null. Used by the graduation flow.
export async function findLeadByEmail(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<Lead | null> {
  const clean = cleanEmail(email);
  if (!clean) return null;
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('email', clean)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as unknown as Lead) ?? null;
}

// Find a lead row for an already-resolved contact by its entity id. The leads
// view's `id` IS the entity id (contact.id == entity.id), so this matches a lead
// regardless of whether it has an email — the fix for LinkedIn-native replies,
// where the lead was imported with only a linkedin_url and identity resolution
// has already linked the reply to the same entity. An entity in several lists
// returns the most recent membership.
export async function findLeadById(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<Lead | null> {
  if (!isUUID(id)) return null;
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as unknown as Lead) ?? null;
}

export interface LeadPatch {
  status?: LeadStatus;
  reply_outcome?: ReplyOutcome | null;
  replied_at?: string | null;
  sent_at?: string | null;
  send_variant?: string | null;
  scorecard_score?: number | null;
  contact_id?: string | null;
  features?: Record<string, unknown>;
  fields?: Record<string, unknown>;
}

export async function updateLead(
  supabase: SupabaseClient,
  workspaceId: string,
  id: string,
  patch: LeadPatch,
): Promise<Lead | null> {
  if (!isUUID(id)) return null;
  const { data, error } = await supabase
    .from('leads')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(LEAD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Lead) ?? null;
}

// Delete selected leads from a list — the operator's manual control step after
// ICP scoring (remove confirmed junk, or a misjudged non-ICP row). Scoped to the
// workspace and list. Returns the count removed. Requires the leads view's
// INSTEAD OF DELETE trigger (v2 phase 5) to be applied.
export async function deleteLeads(
  supabase: SupabaseClient,
  workspaceId: string,
  leadListId: string,
  ids: string[],
): Promise<number> {
  const valid = (ids || []).filter(isUUID);
  if (!isUUID(leadListId) || valid.length === 0) return 0;
  const { data, error } = await supabase
    .from('leads')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('lead_list_id', leadListId)
    .in('id', valid)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

// ── Cold-outbound dedup: classifyEmails ──────────────────────────────────────
//
// The pre-flight check for a new CSV upload. Given a list of emails, returns
// which are safe to cold-email and which are not (already engaged, bounced,
// unsubscribed, workspace-suppressed, or recently contacted). Cross-list,
// across all-time engagement — the agency unlock v2 enables.

export type EmailClassificationStatus =
  | 'net_new'        // no prior record — safe to send
  | 'engaged'        // in an active conversation; don't cold-send
  | 'recent'         // contacted within the cooldown window — defer
  | 'bounced'        // last delivery bounced — skip
  | 'unsubscribed'   // opted out or do-not-contact — skip
  | 'suppressed'     // workspace-level suppression (policy layer)
  | 'known';         // (domain) a company already in the workspace — skip to save spend

export interface EmailClassification {
  /** @deprecated use `value` (kept for backward compat). */
  email: string;
  kind: 'email' | 'linkedin_url' | 'domain';
  value: string;
  status: EmailClassificationStatus;
  entity_id?: string;
  reason?: string | null;
  // Enrichment coverage — present only when we already have this entity. Lets a
  // pre-spend caller decide buy (net_new) vs reuse (we have a fresh verified
  // email) vs re-enrich (we own the identity but it's stale / has no email).
  email_status?: string | null;   // reachability_status: DELIVERABLE / RISKY / … (null = never verified)
  enriched_at?: string | null;    // last enrichment date (null = never enriched)
  stale?: boolean;                // we have them, but not enriched within the freshness window
}

export interface ClassifyInput {
  emails?: string[];
  linkedin_urls?: string[];
  /** Company domains — for pre-spend, company-level dedup ("do I already have
   *  anyone at this company?"). Resolves against entity_identifiers(kind=domain)
   *  and the companies table. */
  domains?: string[];
}

/** Normalize a company domain for matching: lowercase, strip scheme/www/path. */
function normalizeDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = d.toLowerCase().trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
  return s || null;
}

const STAGE_ENGAGED = new Set(['aware', 'interested', 'evaluating', 'client']);
const RECENT_WINDOW_DAYS = 30;
// Matches the enrich endpoint's reuse-gate: enrichment older than this is stale
// (an email may have changed) and worth re-verifying rather than trusting.
const ENRICH_STALE_DAYS = 90;

// PostgREST sends `.in()` filters in the URL. URLs are bounded (~64KB on most
// proxies), so a single `.in('value', 10_000_items)` blows past it. We chunk
// every IN query into ~1000-item batches and run the chunks in parallel; the
// caller sees a single flat result.
const IN_CHUNK_SIZE = 1000;

function chunked<T>(arr: T[], size = IN_CHUNK_SIZE): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run `.in(column, values)` across chunked batches in parallel, concatenating
 * the rows. Returns rows or null on error; never throws.
 */
async function chunkedIn<T = unknown>(
  build: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
  values: string[],
): Promise<T[]> {
  if (values.length === 0) return [];
  const chunks = chunked(values);
  const results = await Promise.all(chunks.map(c => build(c)));
  const rows: T[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    if (r.data) rows.push(...r.data);
  }
  return rows;
}

/**
 * Classify a batch of identifiers (emails and/or LinkedIn URLs) against the
 * workspace's existing engagement graph. Pure read; does not mutate.
 *
 * The Apollo-pre-flight unlock: pass LinkedIn URLs from the preview (visible
 * for free, before you pay to reveal emails) and you know your overlap with
 * the workspace before spending any money on the export.
 */
export async function classifyIdentifiers(
  supabase: SupabaseClient,
  workspaceId: string,
  input: ClassifyInput,
): Promise<EmailClassification[]> {
  const emails = Array.from(new Set(
    (input.emails ?? []).map(e => (e ?? '').toLowerCase().trim()).filter(Boolean),
  ));
  const linkedinUrls = Array.from(new Set(
    (input.linkedin_urls ?? []).map(u => normalizeLinkedInUrl(u)).filter((u): u is string => !!u),
  ));
  const domains = Array.from(new Set(
    (input.domains ?? []).map(d => normalizeDomain(d)).filter((d): d is string => !!d),
  ));
  if (emails.length === 0 && linkedinUrls.length === 0 && domains.length === 0) return [];

  // 1. Workspace policy: suppressions (email-only — LinkedIn doesn't have an
  // equivalent opt-out registry).
  const supByEmail = new Map<string, string | null>();
  if (emails.length) {
    const supRows = await chunkedIn<{ email: string; reason: string | null }>(
      chunk => supabase
        .from('lead_suppressions')
        .select('email, reason')
        .eq('workspace_id', workspaceId)
        .in('email', chunk),
      emails,
    );
    for (const s of supRows) supByEmail.set(s.email, s.reason);
  }

  // 2. Existing entity_identifiers. Emails are stored lowercased (same as the
  // input), so an exact IN matches. LinkedIn URLs are stored RAW (scheme / www /
  // case / trailing-slash vary), so an exact IN on normalized inputs would miss —
  // pull the workspace's linkedin identifiers and match on the normalized form in
  // JS, exactly how insertLeads dedups. (Domains below are stored normalized.)
  const entityByEmail = new Map<string, string>();
  if (emails.length) {
    const emailRows = await chunkedIn<{ value: string; entity_id: string }>(
      chunk => supabase.from('entity_identifiers').select('value, entity_id')
        .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active')
        .in('value', chunk),
      emails,
    );
    for (const i of emailRows) entityByEmail.set(i.value, i.entity_id);
  }

  const entityByLinkedIn = new Map<string, string>();
  if (linkedinUrls.length) {
    // Stored linkedin_urls are raw (scheme/www/case/slash vary), so an exact IN
    // on normalized inputs would miss. Pull the workspace's linkedin identifiers,
    // normalize them, then resolve ONLY the inputs — NOT the whole set, or
    // entityIds below would balloon to the entire workspace.
    const wanted = new Set(linkedinUrls);
    const byNorm = new Map<string, string>();
    let after = '';
    for (;;) {
      let q = supabase
        .from('entity_identifiers')
        .select('id, value, entity_id')
        .eq('workspace_id', workspaceId).eq('kind', 'linkedin_url').eq('status', 'active')
        .order('id', { ascending: true }).limit(1000);
      if (after) q = q.gt('id', after);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        const n = normalizeLinkedInUrl(r.value);
        if (n && wanted.has(n) && !byNorm.has(n)) byNorm.set(n, r.entity_id);
      }
      after = data[data.length - 1].id;
    }
    for (const [n, id] of byNorm) entityByLinkedIn.set(n, id);
  }

  // 2b. Company-level resolution by domain — entity_identifiers(kind=domain)
  // plus the companies table (some domains live there but not as an identifier).
  const entityByDomain = new Map<string, string>();
  if (domains.length) {
    const [domainIdRows, companyRows] = await Promise.all([
      chunkedIn<{ value: string; entity_id: string }>(
        chunk => supabase.from('entity_identifiers').select('value, entity_id')
          .eq('workspace_id', workspaceId).eq('kind', 'domain').eq('status', 'active')
          .in('value', chunk),
        domains,
      ),
      chunkedIn<{ id: string; domain: string }>(
        chunk => supabase.from('companies').select('id, domain')
          .eq('workspace_id', workspaceId).in('domain', chunk),
        domains,
      ),
    ]);
    for (const r of domainIdRows) {
      const d = normalizeDomain(r.value);
      if (d) entityByDomain.set(d, r.entity_id);
    }
    for (const c of companyRows) {
      const d = normalizeDomain(c.domain);
      if (d && !entityByDomain.has(d)) entityByDomain.set(d, c.id);
    }
  }

  // 3. For matched entities — what we know about them.
  const entityIds = [...new Set([
    ...entityByEmail.values(),
    ...entityByLinkedIn.values(),
    ...entityByDomain.values(),
  ])];
  const claimsByEntity = new Map<string, Record<string, unknown>>();
  const recentByEntity = new Set<string>();
  const enrichedByEntity = new Map<string, string>();   // entity_id → last enrichment date

  if (entityIds.length > 0) {
    const claimRows = await chunkedIn<{ entity_id: string; property: string; value: unknown }>(
      chunk => supabase
        .from('claims')
        .select('entity_id, property, value')
        .in('entity_id', chunk)
        .is('invalid_at', null)
        .in('property', ['reachability_status', 'sentiment', 'pipeline_stage']),
      entityIds,
    );
    for (const c of claimRows) {
      const m = claimsByEntity.get(c.entity_id) ?? {};
      m[c.property] = c.value;
      claimsByEntity.set(c.entity_id, m);
    }

    const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
    const recentRows = await chunkedIn<{ entity_id: string }>(
      chunk => supabase
        .from('observations')
        .select('entity_id')
        .in('entity_id', chunk)
        .gte('observed_at', since)
        .like('property', 'interaction.%')
        .limit(chunk.length * 4),
      entityIds,
    );
    for (const r of recentRows) recentByEntity.add(r.entity_id);

    // Last enrichment per entity (method='enrichment', newest first) — drives the
    // stale check. Each entity sits in exactly one chunk; the chunk query is
    // ordered newest-first, so the first row seen for an entity is its latest.
    const enrichRows = await chunkedIn<{ entity_id: string; observed_at: string }>(
      chunk => supabase
        .from('observations')
        .select('entity_id, observed_at')
        .in('entity_id', chunk)
        .eq('method', 'enrichment')
        .order('observed_at', { ascending: false }),
      entityIds,
    );
    for (const r of enrichRows) {
      if (!enrichedByEntity.has(r.entity_id)) enrichedByEntity.set(r.entity_id, r.observed_at);
    }
  }

  // 4. Classify (suppression > bounced > unsubscribed > engaged > recent > net_new).
  const classifyOne = (kind: 'email' | 'linkedin_url' | 'domain', value: string, entityId?: string): EmailClassification => {
    if (kind === 'email' && supByEmail.has(value)) {
      return { email: value, kind, value, status: 'suppressed',
               reason: supByEmail.get(value) ?? 'workspace suppression' };
    }
    if (!entityId) return { email: value, kind, value, status: 'net_new' };

    const claims = claimsByEntity.get(entityId) ?? {};
    const reach = claims.reachability_status as string | undefined;
    // Enrichment coverage, attached to every entity-backed result so a pre-spend
    // caller can split "have them, fresh" from "have them, stale → re-enrich".
    const enrichedAt = enrichedByEntity.get(entityId) ?? null;
    const stale = !enrichedAt
      || (Date.now() - new Date(enrichedAt).getTime()) > ENRICH_STALE_DAYS * 86_400_000;
    const cov = { entity_id: entityId, email_status: reach ?? null, enriched_at: enrichedAt, stale };

    if (reach === 'bounced')      return { email: value, kind, value, status: 'bounced', ...cov };
    if (reach === 'unsubscribed') return { email: value, kind, value, status: 'unsubscribed', ...cov };

    const sentiment = claims.sentiment as string | undefined;
    if (sentiment === 'do_not_contact') {
      return { email: value, kind, value, status: 'unsubscribed', ...cov, reason: 'do_not_contact' };
    }

    const stage = claims.pipeline_stage as string | undefined;
    if (stage && STAGE_ENGAGED.has(stage)) {
      return { email: value, kind, value, status: 'engaged', ...cov, reason: stage };
    }
    if (recentByEntity.has(entityId)) {
      return { email: value, kind, value, status: 'recent', ...cov };
    }
    // Present but cold. For a domain that still means "a company you already
    // have" — mark it `known` so the skill skips it before paying to enrich.
    if (kind === 'domain') {
      return { email: value, kind, value, status: 'known', ...cov, reason: 'company in workspace' };
    }
    return { email: value, kind, value, status: 'net_new', ...cov, reason: 'cold' };
  };

  return [
    ...emails.map(e => classifyOne('email', e, entityByEmail.get(e))),
    ...linkedinUrls.map(u => classifyOne('linkedin_url', u, entityByLinkedIn.get(u))),
    ...domains.map(d => classifyOne('domain', d, entityByDomain.get(d))),
  ];
}

/**
 * Backward-compat: emails-only classify. Prefer classifyIdentifiers().
 */
export async function classifyEmails(
  supabase: SupabaseClient,
  workspaceId: string,
  emails: string[],
): Promise<EmailClassification[]> {
  return classifyIdentifiers(supabase, workspaceId, { emails });
}


// ── Suppression list ──────────────────────────────────────────────────────────

export async function addSuppression(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
  reason?: string,
): Promise<void> {
  const clean = cleanEmail(email);
  if (!clean) return;
  const { error } = await supabase
    .from('lead_suppressions')
    .upsert(
      { workspace_id: workspaceId, email: clean, reason: reason ?? null },
      { onConflict: 'workspace_id,email' },
    );
  if (error) throw error;
}

export async function isSuppressed(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const clean = cleanEmail(email);
  if (!clean) return false;
  const { data, error } = await supabase
    .from('lead_suppressions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', clean)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
