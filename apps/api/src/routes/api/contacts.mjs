import { viewerReadContext } from '../../lib/messagePrivacy.mjs';
import { Router } from 'express';
import { productUsersAmong, personProductUsage, PERSON_USAGE_PROPERTIES } from '../../lib/productUsage.mjs';
import { randomUUID } from 'crypto';
import { getSupabaseClient, listNotes, saveNote, getNote, deleteNote, logActivity, collapseMeetingDupes, assertClaims, upsertIdentifier, scoreTier, normalizeClaimCategory, normalizeClaimAbout, recomputeClaim, ENRICHMENT_ATTRIBUTES, getInternalEntityIds, getPersonalEntityIds, markEntityPersonal, isEntityPersonal, setEntityInternalManual, isInTouchWith, getRelationshipOwners, getWorkspaceMemberNames, getWorkspaceMemberProfiles, effectiveOwnerUserId, assignRelationshipOwner, removeRelationshipMember } from '@nous/core';
// The funnel lives in ONE place: packages/core/src/pipeline.ts. Never re-declare a
// stage list in here — a local copy is exactly how a stage goes missing from one
// code path and the account quietly drops out of it.
import { DONE_STAGES, ALL_PIPELINE_STAGES, LEGACY_STAGE_MAP, normalizeStage } from '@nous/core';
import { loadMessageViewer, isPrivateMessageType, canReadMessage, loadReplyOwed } from '@nous/core';
import { fetchIcpByEntity, fetchIntentByEntity, fetchReplySignalByEntity } from '../../lib/icpFit.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { intelTopicsFor } from '../../lib/intelTopics.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { getVisibilityScope, memberVisibleAccounts, entityVisibleToMember } from '../../lib/visibility.mjs';
import { latestStages, lifecycleDeptScope, wonCompanyIds, ownerDeptForCompany } from './lifecycle.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { requireEnrichmentQuota, requireAccountsBalance } from '../../lib/access.mjs';
import { enrichContact } from '../../services/enrichment.mjs';
import { hasListRows, listRows, accountCountries, domainsForAccounts, photosForPeople, crmLinkedPeople, workspaceHasCrm } from '../../lib/listRows.mjs';

// Pulling a missing profile photo over Unipile (LinkedIn) is Cloud's: cloud/index.mjs registers
// it at boot (GET-754). Without it the record loads without one, as it does with no LinkedIn.
let contactPhotoHook = null;
export function registerContactPhotoHook(fn) { contactPhotoHook = fn; }

export const contactsApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Personal-email providers: their domain says nothing about where someone works,
// so we never derive a company `domain` from an address at one of these.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'fastmail.com', 'hey.com',
]);
const SYSTEM_TYPES = new Set(['stage_changed', 'contact_created', 'contact_updated', 'score_updated', 'enrichment_completed', 'added_to_campaign']);

// LinkedIn message-ish activity types (Unipile direct + sequencer webhooks). For
// these the timeline must show the MESSAGE TEXT, never a generic "linkedin message
// sent" / "LinkedIn message (received)" label. When a message carries no text it's
// a voice note / image / attachment, which we label by media type instead.
const LINKEDIN_MSG_TYPES = new Set([
  'linkedin_message', 'linkedin_message_received', 'linkedin_message_sent',
  'linkedin_reply', 'linkedin_replied',
]);

// The placeholder / humanized-type strings ingestion may have stored as the
// "description" when there was no real text — these are NOT message content.
const isGeneratedMsgLabel = (s, type) => {
  if (!s) return true;
  if (/^linkedin message \((sent|received)\)$/i.test(s)) return true;
  if (/^(voice memo|image|video|gif|attachment|shared a post)\b/i.test(s)) return true;
  // HeyReach stores the humanized activity type (optionally "...: Campaign") as the
  // description; the real reply text lives in `summary`.
  const humanized = String(type || '').replace(/_/g, ' ');
  return humanized ? new RegExp(`^${humanized}\\b`, 'i').test(s) : false;
};

// A LinkedIn message with no text is a voice note / image / attachment. Derive a
// media label from the stored raw webhook body. Defensive across Unipile shapes.
const linkedinMediaLabel = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const hint = String(raw.message_type || raw.message?.type || raw.attachment_type || '').toLowerCase();
  const atts = raw.attachments || raw.message?.attachments || [];
  const a = Array.isArray(atts) ? atts[0] : null;
  const t = String(a?.type || a?.attachment_type || hint || '').toLowerCase();
  const mime = String(a?.mimetype || a?.mime_type || '').toLowerCase();
  if (a?.voice_note || a?.is_voice_note || /voice|audio/.test(t) || mime.startsWith('audio/')) return 'Voice memo';
  if (/img|image|photo|picture/.test(t) || mime.startsWith('image/')) return 'Image';
  if (/video/.test(t) || mime.startsWith('video/')) return 'Video';
  if (/gif/.test(t)) return 'GIF';
  if (t === 'linkedin_post' || /share|post/.test(t)) return 'Shared a post';
  if (a || hint) return 'Attachment';
  return null;
};

// Best message text for a LinkedIn message activity, ignoring generated labels.
const linkedinMessageText = (type, value, raw) => {
  if (value?.description && !isGeneratedMsgLabel(value.description, type)) return value.description;
  const sum = (value?.summary || '').replace(/^You:\s*/i, '').trim();
  if (sum && !isGeneratedMsgLabel(value.summary, type)) return sum;
  const rawText = raw?.message?.text
    || (typeof raw?.message === 'string' ? raw.message : '')
    || raw?.text || '';
  return rawText ? String(rawText) : null;
};

// Every column value a stage filter has to match. The database has NOT been migrated
// yet, so live rows still hold the pre-funnel words (client, aware, proposal…). Asking
// for the new name alone with .eq() matched none of them — filtering by closed_won on
// a workspace full of `client` rows returned an empty page and read as "you have no
// clients". So we resolve the caller's value to its canonical stage and query that
// stage PLUS every legacy name that maps onto it. The alias list is derived from
// LEGACY_STAGE_MAP rather than typed out, so this never becomes a second stage list
// that can drift. Returns null for a value that isn't a stage at all.
const stageQueryValues = (raw) => {
  const stage = normalizeStage(raw);
  if (!stage) return null;
  return [stage, ...Object.keys(LEGACY_STAGE_MAP).filter(k => LEGACY_STAGE_MAP[k] === stage)];
};

// GET /api/contacts
// The People filter's types (GET-1018), as a filter on the flattened list. The same words as the
// row's tag: Network (marked personal), Team (a member of the workspace), User (a product signup:
// a user or trial stage outside the sales funnel, or PostHog's product.user), Client (won).
const EMPTY = Symbol('no one');
const SALES_STAGES = [...ALL_PIPELINE_STAGES, ...Object.keys(LEGACY_STAGE_MAP)];
const CLIENT_STAGES = ['closed_won', ...Object.keys(LEGACY_STAGE_MAP).filter(k => LEGACY_STAGE_MAP[k] === 'closed_won')];
export async function peopleTypeRefine(supabase, workspaceId, type) {
  const among = (ids) => (ids.length ? (q) => q.in('entity_id', ids) : EMPTY);
  if (type === 'network') return among([...await getPersonalEntityIds(supabase, workspaceId)]);
  if (type === 'team') return among([...await getInternalEntityIds(supabase, workspaceId)]);
  if (type === 'client') return (q) => q.in('stage', CLIENT_STAGES);
  if (type === 'user') {
    // PostHog's users by id while there are few enough to name in one URL; past that, by stage.
    const { data } = await supabase.from('claims').select('entity_id, value').eq('workspace_id', workspaceId)
      .eq('property', 'product.user').is('invalid_at', null).limit(301);
    const ids = (data ?? []).filter(r => (r.value?.value ?? r.value) === true).map(r => r.entity_id);
    // The tag's rule (People.tsx isProductUserStage): a stage outside the funnel that names a user or a trial.
    const byStage = `and(stage.not.in.(${SALES_STAGES.join(',')}),or(stage.ilike.*user*,stage.ilike.*trial*))`;
    return (q) => q.or(ids.length && ids.length <= 300 ? `${byStage},entity_id.in.(${ids.join(',')})` : byStage);
  }
  return null;
}

contactsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, search, limit = 50, offset = 0, filter, source, sort, status, include_team, type } = req.query;
    const includeTeam = include_team === '1' || include_team === 'true';
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    // verifySupabaseAuth already validated workspace membership (cached for
    // 60s) — the redundant ensureUserAndTeam + workspace_members check that
    // used to live here added ~50-100ms of DB roundtrips for no extra safety.
    // `req.workspaceId` is set by the middleware iff membership passed.
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    // The flattened list, when this workspace has one (GET-296). The `contacts` view decides who
    // counts as a person by scanning every activity row in the workspace on each read — 14 seconds
    // for fifty people, so the page said "No results" while tens of thousands of them sat there.
    if (!filter && !source && !status && await hasListRows(supabase, workspaceId, 'person')) {
      const lim = Math.min(200, Math.max(1, Number(limit) || 50));
      const off = Math.max(0, Number(offset) || 0);
      // The same market filter the Accounts list uses (GET-311): a person is in the market their
      // employer is in. Nothing asked = the workspace's own focus; `all` clears it.
      const { data: wsRow } = await supabase.from('workspaces').select('focus_country').eq('id', workspaceId).maybeSingle();
      const asked = String(req.query.country ?? '').trim();
      const country = asked === 'all' ? null : (asked || wsRow?.focus_country || null);
      // `type` (GET-1018): the People filter — network, team, user or client. Unknown = everyone.
      const refine = await peopleTypeRefine(supabase, workspaceId, String(type ?? ''));
      if (refine === EMPTY) return res.json({ contacts: [], total: 0, limit: lim, offset: off, country, focus_country: wsRow?.focus_country ?? null, countries: await accountCountries(supabase, workspaceId) });
      const { rows, total } = await listRows(supabase, workspaceId, 'person', {
        q: String(search ?? '').trim(), limit: lim, offset: off, country, focusCountry: wsRow?.focus_country ?? null, refine,
      });
      // The logo and the face: the employer's domain (off its account row, else a work address)
      // and any photo on file. The flattened person row carries neither.
      const [domains, photos, crmConnected] = await Promise.all([
        domainsForAccounts(supabase, workspaceId, [...new Set(rows.map(r => r.company_id).filter(Boolean))]),
        photosForPeople(supabase, workspaceId, rows.map(r => r.entity_id)),
        workspaceHasCrm(supabase, workspaceId),
      ]);
      // Who is linked to a CRM record (GET-788), only worth asking when a CRM is connected.
      const inCrm = crmConnected ? await crmLinkedPeople(supabase, workspaceId, rows.map(r => r.entity_id)) : null;
      const users = await productUsersAmong(supabase, workspaceId, rows.map(r => r.entity_id)).catch(() => new Set());
      // Network (marked personal): the list tags them (GET-1017). This path never said so.
      const personal = await getPersonalEntityIds(supabase, workspaceId).catch(() => new Set());
      const workDomain = (email) => {
        const at = String(email ?? '').split('@')[1]?.trim().toLowerCase();
        return at && !FREEMAIL_DOMAINS.has(at) ? at : null;
      };
      return res.json({
        contacts: rows.map(r => ({
          id: r.entity_id, email: r.email, first_name: (r.name ?? '').split(' ')[0] || null,
          last_name: (r.name ?? '').split(' ').slice(1).join(' ') || null,
          job_title: r.job_title, company_id: r.company_id, company: r.company_name,
          domain: (r.company_id && domains.get(r.company_id)) || r.domain || workDomain(r.email),
          photo_url: photos.get(r.entity_id) ?? null,
          pipeline_stage: r.stage, icp_score: r.icp_score, last_activity_at: r.last_activity_at,
          in_crm: inCrm ? inCrm.has(r.entity_id) : null,
          product_user: users.has(r.entity_id),
          is_personal: personal.has(r.entity_id),
        })),
        total, limit: lim, offset: off, crm_connected: crmConnected,
        country, focus_country: wsRow?.focus_country ?? null, countries: await accountCountries(supabase, workspaceId),
      });
    }

    // No `count: 'exact'` — it triggers a separate COUNT query that can take
    // longer than the data fetch itself on large tables. Nobody reads .total
    // from this endpoint's response in the current frontend.
    // Account visibility, resolved BEFORE the query is paginated. Narrowing the
    // page after range() meant a restricted member paged through mostly-empty
    // screens: we fetched 50 rows of the whole workspace and then kept only the
    // handful they own. The id set has to be part of the query, not a post-filter.
    const vis = await getVisibilityScope(supabase, workspaceId, req);
    let visibleContactIds = null;
    if (vis.restrict) {
      const { contactIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
      if (!contactIds.size) return res.json({ contacts: [], limit: 0, offset: 0 });
      visibleContactIds = [...contactIds];
    }

    let query = supabase.from('contacts').select('*').eq('workspace_id', workspaceId);
    // PostgREST puts .in() in the URL, so an enormous set would exceed the URL
    // limit and error. That is the right failure: a member in touch with
    // thousands of accounts is not what restricted mode is for, and a loud error
    // beats silently truncating someone's book.
    if (visibleContactIds) query = query.in('id', visibleContactIds);
    // Match the canonical stage AND its un-migrated legacy spellings (see
    // stageQueryValues). A filter that isn't a stage at all matches nothing rather
    // than falling through to "everything" — the same result the old .eq() gave it.
    if (filter && filter !== 'all') {
      const stages = stageQueryValues(filter);
      if (!stages) return res.json({ contacts: [], limit: 0, offset: 0 });
      query = query.in('pipeline_stage', stages);
    }
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (search?.trim()) {
      const t = `%${search.trim()}%`;
      query = query.or(`email.ilike.${t},first_name.ilike.${t},last_name.ilike.${t},company.ilike.${t}`);
    }
    query = sort === 'interactions_asc'
      ? query.order('last_activity_at', { ascending: true, nullsFirst: false })
      // Ordering people by last_activity_at asks the view to aggregate every activity of every
      // person before it can return fifty — 14 seconds on a client-sized workspace, and the page
      // read "No results" (GET-295). Id is the only free column here.
      : query.order('id');
    const lim = Math.min(parseInt(limit) || 50, 1000);
    const off = parseInt(offset) || 0;
    query = query.range(off, off + lim - 1);

    const { data: raw, error } = await query;
    if (error) throw error;

    // Overlay the live ICP model score + tier from the prediction (the SAME source
    // the lead list and the person record use), so the People page stops showing
    // the stale v1 contacts.icp_score and gains the actionable tier. Contacts
    // without a prediction keep their existing value (no tier).
    let rows = raw || [];

    // (Account visibility is applied above, as part of the query — see the
    // getVisibilityScope call before `query` is built.)

    // Team members (co-founders / colleagues flagged is_internal) are not leads.
    // We tag every row so the UI can badge them, and hide them from the default
    // Accounts view — they're one toggle away via ?include_team=1. Filtering
    // after the fetch keeps the query simple; internal records are a handful.
    const internal = await getInternalEntityIds(supabase, workspaceId);
    if (!includeTeam && internal.size) rows = rows.filter(c => !internal.has(c.id));

    // Personal/network contacts (friends, connections you don't sell to) stay VISIBLE
    // on the Accounts page but are badged so they're never mistaken for a deal. We tag
    // every row; the UI shows the badge and pipeline surfaces exclude them.
    const personal = await getPersonalEntityIds(supabase, workspaceId);

    const ids = rows.map(c => c.id);
    const icpMap = await fetchIcpByEntity(supabase, workspaceId, ids);
    const intentMap = await fetchIntentByEntity(supabase, workspaceId, ids);
    const replyMap = await fetchReplySignalByEntity(supabase, workspaceId, ids);
    // Only people with a reply on file can be owed one; ordering their touches is cheap for those.
    const owedMap = await loadReplyOwed(supabase, workspaceId, [...replyMap.keys()]);

    // Who on the team is actually on this account. `primary` is whoever touched it
    // most recently — the rep currently carrying it — and `members` is everyone
    // in touch, which is what makes "you and Jordan are both on this" visible
    // instead of a surprise. Powers the Owner filter.
    const ownerMap = await getRelationshipOwners(supabase, workspaceId, ids);
    const crmConnected = await workspaceHasCrm(supabase, workspaceId).catch(() => false);
    const memberNames = await getWorkspaceMemberNames(supabase, workspaceId);
    const productUsers = await productUsersAmong(supabase, workspaceId, ids).catch(() => new Set());

    const contacts = rows.map(c => {
      const ov = icpMap.get(c.id);
      const iv = intentMap.get(c.id);
      const rv = replyMap.get(c.id);
      const rel = ownerMap.get(c.id);
      // Intent overlay (reach-out-now axis) — defaults Dormant/0 until staked.
      return {
        ...c,
        is_internal: internal.has(c.id),
        is_personal: personal.has(c.id),
        // Linked to a CRM record (GET-788): the view carries every CRM id column already.
        in_crm: crmConnected ? !!(c.hubspot_id || c.salesforce_id || c.pipedrive_id || c.attio_id || c.crm_record_id) : null,
        product_user: productUsers.has(c.id),
        owner_user_id: effectiveOwnerUserId(rel),
        owner_name: effectiveOwnerUserId(rel) ? (memberNames.get(effectiveOwnerUserId(rel)) ?? null) : null,
        owner_members: (rel?.members ?? []).map(m => ({
          user_id: m.user_id,
          name: memberNames.get(m.user_id) ?? m.label ?? null,
        })),
        ...(ov ? { icp_score: ov.score, icp_tier: ov.tier } : {}),
        intent_score: iv?.score ?? 0,
        intent_band: iv?.band ?? 'Dormant',
        reply_signal: rv?.signal ?? null,
        reply_at: rv?.at ?? null,
        // Their message no one on the team has answered yet, on any channel (GET-255). Null = nothing owed.
        reply_owed_since: owedMap.get(c.id)?.owed_since ?? null,
      };
    });

    // Hard role-scoped visibility: a member with a department role only sees contacts at
    // accounts their department currently owns in the lifecycle (mirrors the Accounts list).
    // Internal/personal contacts and loose contacts with no company stay visible to everyone.
    const deptScope = await lifecycleDeptScope(supabase, workspaceId, vis.viewerUserId ?? req.internalUserId);
    let scoped = contacts;
    if (deptScope) {
      const companyIds = [...new Set(contacts.map(c => c.company_id).filter(Boolean))];
      const overrides = await latestStages(supabase, workspaceId, companyIds);
      const won = await wonCompanyIds(supabase, workspaceId);
      scoped = contacts.filter(c =>
        !c.company_id || c.is_internal || c.is_personal ||
        ownerDeptForCompany(overrides.get(c.company_id), won.has(c.company_id)) === deptScope);
    }

    return res.json({ contacts: scoped, limit: lim, offset: off, crm_connected: crmConnected });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/contacts/enrich-progress/:jobId — must be before /:id so Express doesn't swallow it.
// The backfill runs in the WORKER now, so its live snapshot isn't in this process —
// progress is read from the contact_enrichment_jobs row the worker keeps updating.
contactsApiRouter.get('/enrich-progress/:jobId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('contact_enrichment_jobs')
      .select('state, done, status')
      .eq('job_id', req.params.jobId)
      .maybeSingle();
    if (data) {
      return res.json({
        found: true,
        contacts: data.state?.contacts || [],
        // 'done' flag OR a terminal queue status — so a failed job doesn't spin forever.
        done: !!data.done || data.status === 'done' || data.status === 'failed',
      });
    }
  } catch { /* table may not exist yet — fall through */ }

  return res.json({ found: false });
});

// GET /api/contacts/enrich-active?workspaceId= — the workspace's currently-running
// backfill, if any. The import modal checks this on open so it surfaces the live
// backfill instead of letting the user start a second import on top of one running.
contactsApiRouter.get('/enrich-active', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const wsId = req.query.workspaceId;
    if (!wsId) return res.json({ active: false });
    const { data } = await supabase
      .from('contact_enrichment_jobs')
      .select('job_id, state')
      .eq('workspace_id', wsId).in('status', ['pending', 'running'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return res.json({ active: true, jobId: data.job_id, contacts: data.state?.contacts || [] });
  } catch { /* fall through */ }
  return res.json({ active: false });
});

// GET /api/contacts/counts?workspaceId= — active (in the contacts view: people you've
// engaged) vs TOTAL person entities in the graph. The Accounts page projects only the
// active set, so a cold-lead import looks like it vanished ("imported 200, see 80").
// Surfacing "80 active / 200 total" tells the user everything landed and the rest are
// just waiting on their first interaction. Must be before /:id.
contactsApiRouter.get('/counts', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId || !UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'unauthorized' });
    const [{ count: active }, { count: total }] = await Promise.all([
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      supabase.from('entities').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('type', 'person'),
    ]);
    return res.json({ active: active ?? 0, total: total ?? 0 });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/contacts/:id
contactsApiRouter.get('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    // Try the contacts view first (people you've actually engaged). A lead that
    // hasn't graduated into that view yet still has an entity, observations and
    // signals under the SAME id, so fall back to the leads view and build a
    // contact shape from it. This is what lets a cold lead open its full record
    // straight from a lead list.
    let { data: contact } = await supabase.from('contacts').select('*').eq('id', id).maybeSingle();
    if (!contact) {
      const { data: leadRows } = await supabase.from('leads').select('*').eq('id', id).limit(1);
      const lead = leadRows?.[0];
      if (!lead) return res.status(404).json({ error: 'contact_not_found' });
      const { data: pred } = await supabase.from('predictions')
        .select('predicted_value')
        .eq('entity_id', id).eq('kind', 'icp_fit')
        .order('predicted_at', { ascending: false }).limit(1).maybeSingle();
      const parts = (lead.name || '').trim().split(/\s+/).filter(Boolean);
      const f = lead.fields || {};
      contact = {
        id: lead.id, workspace_id: lead.workspace_id,
        email: lead.email || null, linkedin_url: lead.linkedin_url || null,
        first_name: parts[0] || null, last_name: parts.slice(1).join(' ') || null,
        job_title: f.title || f.job_title || null, company: lead.company || null,
        domain: lead.domain || null, industry: f.industry || null, company_size: f.company_size || null,
        phone: null, city: null, country: null, seniority: null, department: null,
        pipeline_stage: null, deal_stage: null, deal_value: null, notes: null,
        lead_source: lead.source || null, source: lead.source || null, company_id: null,
        icp_score: pred?.predicted_value?.score ?? lead.scorecard_score ?? null,
        icp_fit: pred?.predicted_value?.fit ?? null,
        icp_reasoning: pred?.predicted_value?.reason ?? null,
        created_at: lead.created_at || null, updated_at: lead.updated_at || null,
      };
    }

    // Cold leads aren't in the contacts view → company_id is null. Resolve the
    // COMPANY entity from the lead's domain so the person INHERITS the company's
    // signals (company-class signals live on the company entity, not the person).
    if (!contact.company_id && contact.domain) {
      const { data: idRows } = await supabase.from('entity_identifiers')
        .select('entity_id')
        .eq('workspace_id', contact.workspace_id).eq('kind', 'domain').eq('value', contact.domain);
      for (const r of (idRows || [])) {
        const { data: e } = await supabase.from('entities').select('id, type').eq('id', r.entity_id).maybeSingle();
        if (e?.type === 'company') { contact.company_id = e.id; break; }
      }
    }

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', contact.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'contact_not_found_or_unauthorized' });
    // Account-visibility gate: workspace membership is not enough — on a closed (owner-scoped)
    // workspace a member may only open contacts in their own book. 404 so existence isn't revealed.
    if (!(await entityVisibleToMember(supabase, contact.workspace_id, user.id, contact.id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'contact_not_found_or_unauthorized' });
    }

    // No profile picture yet but we have a LinkedIn identity → pull it over Unipile.
    // Raced against a short timeout so a slow Unipile call can't stall the record load:
    // if it lands in time the photo shows on this load, otherwise it's persisted for the
    // next one (the underlying promise keeps running and writes photo_url regardless).
    if (contactPhotoHook && !contact.photo_url && (contact.linkedin_url || contact.linkedin_member_id)) {
      const photo = await Promise.race([
        contactPhotoHook(supabase, contact.workspace_id, contact).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (photo) contact.photo_url = photo;
    }

    // ── One parallel batch ────────────────────────────────────────────────────
    // Contact + membership are resolved above; every read below depends only on the
    // id / workspace, never on each other. Running them concurrently instead of as
    // ~8 sequential round-trips is the first-load win. (viewerUserId / workspaceId
    // are also needed by the privacy pass below.)
    const viewerUserId = req.internalUserId ?? req.memberUserId ?? null;
    // The workspace comes off the CONTACT, not the request: this route is fetched by
    // id alone, so req.workspaceId is usually undefined. contact.workspace_id is
    // authoritative and was membership-checked above.
    const workspaceId = req.workspaceId ?? contact.workspace_id;
    const sigEntityIds = [id];
    const [fcRes, resolvedRes, obsRes, _unused, companyRes, memories, sigRes, predRowRes] = await Promise.all([
      supabase.from('claims').select('value').eq('entity_id', id).eq('property', 'fields').is('invalid_at', null).maybeSingle(),
      supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('workspace_id', contact.workspace_id).eq('kind', 'icp_fit').not('resolved_at', 'is', null),
      // icp.* events are scoring OUTPUT (icp.fit / icp.priority), not real activity — exclude them
      // so the timeline shows meetings/emails/signals, not "icp.fit Today" on every account.
      supabase.from('observations').select('id, property, value, source, observed_at, raw, entity_id, owner_user_id').eq('entity_id', id).eq('kind', 'event').not('property', 'like', 'icp.%').order('observed_at', { ascending: false }).limit(200),
      Promise.resolve(null),   // was the in-touch lookup; message privacy no longer uses it (GET-244)
      contact.company_id
        ? supabase.from('companies').select('name, domain, industry, employee_count, tech_stack, location, revenue_range').eq('id', contact.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // Facts pulled out of an email follow the email (GET-253).
      listNotes(supabase, contact.workspace_id, { entityId: id, limit: 200 }, viewerReadContext(req, workspaceId)),
      supabase.from('claims').select('entity_id, property, value, confidence, computed_at').in('entity_id', sigEntityIds).like('property', 'signal.%').is('invalid_at', null).order('computed_at', { ascending: false }),
      supabase.from('predictions').select('predicted_value, predicted_at, model_version, fired_signals').eq('entity_id', id).eq('kind', 'icp_fit').order('predicted_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

    // Deal value inherits from the account. A person's deal_value is often unset even
    // when the company has an amount — on the board a "company deal value" is just the
    // largest deal_value across everyone at the company. So when this person has none,
    // surface the company's so the record isn't misleadingly zero.
    if ((contact.deal_value == null || Number(contact.deal_value) === 0) && contact.company_id) {
      const { data: sib } = await supabase.from('contacts')
        .select('deal_value').eq('company_id', contact.company_id).not('deal_value', 'is', null);
      const best = (sib || []).reduce((m, r) => (r.deal_value != null && (m == null || Number(r.deal_value) > m) ? Number(r.deal_value) : m), null);
      if (best != null) { contact.deal_value = best; contact.deal_value_inherited = true; }
    }

    // Hybrid ICP score: DISPLAY the seed until the model has ≥10 RESOLVED icp_fit
    // outcomes, then switch to the model prediction. Keeps sidebar and list aligned.
    {
      const prediction = contact.icp_score;          // model prediction (may be null)
      const sraw = fcRes.data?.value?.icp_score ?? fcRes.data?.value?.scorecard_score;
      const seed = sraw == null || Number.isNaN(Number(sraw)) ? null : Number(sraw);
      const trained = (resolvedRes.count ?? 0) >= 10;          // enough graded outcomes
      contact.icp_score = trained ? (prediction ?? seed) : (seed ?? prediction);
    }

    // Activities are kind:'event' observations in the v2 substrate.
    // entity_id == contact id (the v1->v2 migration convention).
    const obsRawAll = obsRes.data;

    // Message privacy (GET-244): an email's or LinkedIn message's CONTENT is readable only by the
    // people who were on it — its participants (from / to / cc) and the members whose account holds
    // a copy — whatever their role. Everyone else still sees the row: that it happened, when, and
    // which way. The "in touch" exception that used to open a teammate's whole conversation, and
    // the subject in the redacted header, are gone. Meetings, calls, signals and notes are not
    // messages and are never redacted here; a fact pulled out of a message is dropped upstream, in
    // listNotes (GET-253). No viewer id (a system caller) → nothing redacted.
    const messageViewer = viewerUserId ? await loadMessageViewer(supabase, workspaceId, viewerUserId) : null;
    const shouldRedact = (o) => !!messageViewer
      && isPrivateMessageType(o.property) && !canReadMessage(o, messageViewer);
    // One meeting can be seen by two connectors (Cal.com webhook + Calendar
    // poller) — collapse to a single row so the timeline shows it once.
    const obsRows = collapseMeetingDupes(obsRawAll || []);

    // Human title for known event types. Falls back to the raw type for
    // anything we don't recognize so unknown events still render readably.
    const titleFor = (prop, value, raw) => {
      const t = (prop || '').replace(/^interaction\./, '');
      // Connections — keep the simple, valid label.
      if (t === 'linkedin_connected' || t === 'linkedin_connection_accepted') return 'Connected on LinkedIn';
      if (t === 'linkedin_connection_sent') return 'Connection request sent';
      // Messages — show the text; for a text-less message (voice note, image…) label
      // it by media type. Never surface the generic "linkedin message sent" label.
      if (LINKEDIN_MSG_TYPES.has(t)) {
        const text = linkedinMessageText(t, value, raw);
        if (text) return text.slice(0, 280);
        const isOutbound = raw?.is_outbound === true || t === 'linkedin_message_sent';
        const dir = isOutbound ? 'sent' : 'received';
        const media = linkedinMediaLabel(raw);
        return media ? `${media} ${dir}` : (isOutbound ? 'LinkedIn message sent' : 'LinkedIn message received');
      }
      if (prop === 'interaction.signed_up') {
        const parts = ['Signed up'];
        if (value?.plan) parts.push(`for ${value.plan}`);
        if (value?.company) parts.push(`from ${value.company}`);
        return parts.join(' ');
      }
      // A provider "meeting booked" disposition — flagged as interest, not a
      // confirmed calendar meeting (which stays 'Meeting booked' via meeting_scheduled).
      if (prop === 'interaction.meeting_interest') return 'Meeting interest';
      if (prop === 'interaction.welcome_email_sent') return 'Welcome email delivered';
      if (prop === 'interaction.subscription_started') {
        const plan = value?.plan ? ` — ${value.plan}` : '';
        const amt = value?.amount && value?.currency
          ? ` ($${value.amount}/${value.billing_interval || 'mo'})` : '';
        return `Paid via Stripe${plan}${amt}`;
      }
      if (prop === 'interaction.subscription_updated') return `Plan updated${value?.plan ? ` to ${value.plan}` : ''}`;
      if (prop === 'interaction.subscription_canceled') return 'Canceled subscription';
      if (prop === 'interaction.linkedin_post_engagement') {
        const k = value?.kind || '';
        if (k.includes('comment') && k.includes('reaction')) return 'Commented and reacted on your post';
        if (k.includes('comment')) return 'Commented on your post';
        if (k.includes('reaction')) return value?.reaction ? `Reacted ${value.reaction} to your post` : 'Reacted to your post';
        return 'Engaged with your post';
      }
      return value?.description || (prop || '').replace(/^interaction\./, '').replace(/_/g, ' ') || 'Activity';
    };

    // Sent or received? LinkedIn messages are all stored under ONE type
    // (`linkedin_message`) — the direction lives in the payload, not the type. The
    // redaction path used to read the type's `_sent` suffix, which a LinkedIn row
    // never has, so every redacted message announced itself as "received" even when
    // the member had sent it. Read the payload, and fall back to the "You:" prefix
    // the writer puts on outbound summaries.
    const directionOf = (o, type) => {
      if (type.endsWith('_sent')) return 'sent';
      if (type.endsWith('_received')) return 'received';
      const outbound = o.raw?.is_outbound ?? o.raw?.is_sender ?? o.value?.is_outbound;
      if (typeof outbound === 'boolean') return outbound ? 'sent' : 'received';
      if (/^you:\s*/i.test(o.value?.summary ?? '')) return 'sent';
      return 'received';
    };

    const activities = (obsRows || [])
      .map(o => {
        const type = (o.property || '').replace(/^interaction\./, '');
        // Body line. For LinkedIn messages only show real text ("You: …" / the reply)
        // — never the placeholder/label, which already drives the title.
        let subtitle = o.value?.summary || o.value?.description || null;
        if (LINKEDIN_MSG_TYPES.has(type)) {
          const s = o.value?.summary;
          subtitle = (s && s.replace(/^You:\s*/i, '').trim()) ? s : null;
        }

        // Another rep's message on an account this member doesn't own: keep the
        // header (subject / a clean label) so they see it happened, but redact the
        // body and the raw payload so the words aren't exposed.
        if (shouldRedact(o)) {
          const dir = directionOf(o, type);
          const header = type.startsWith('email_') ? `Email ${dir}` : `LinkedIn message ${dir}`;
          return {
            id:            o.id,
            activity_type: type,
            title:         header,
            subtitle:      null,          // body redacted
            redacted:      true,          // frontend shows a subtle "private" hint
            source:        o.source || 'nous',
            created_at:    o.observed_at,
            // Who was on it and which way it went — never the subject, body or message text.
            raw_data:      { participants: o.raw?.participants ?? { from: o.raw?.from ?? null, to: o.raw?.to ?? [], cc: o.raw?.cc ?? [] }, is_outbound: o.raw?.is_outbound, redacted: true },
          };
        }

        return {
          id:            o.id,
          activity_type: type,
          title:         titleFor(o.property, o.value, o.raw),
          subtitle,
          source:        o.source || 'nous',
          created_at:    o.observed_at,
          raw_data:      o.raw || null,
        };
      })
      .filter(a => !SYSTEM_TYPES.has(a.activity_type) && a.activity_type !== 'stage_changed');

    const company = companyRes.data;
    // memories (listNotes) came from the batch above — notes are fully shared across
    // the team by design, no viewer scoping.

    // Buying signals — signal.* state claims written by signal-scan / record_signal.
    // Signals are COMPANY-LEVEL and live on the company record (see the company
    // view's Signals tab). The person record shows ONLY the person's own signals
    // (e.g. their post-level intent from content-scan), NOT the company's — those
    // are shown on the company, and still feed this person's ICP score via the
    // scorecard's company-feature inheritance (a separate path). So query the
    // person entity only.
    const sigRows = sigRes.data;
    const byClass = new Map();
    for (const s of (sigRows || [])) {
      const cls = (s.property || '').replace(/^signal\./, '');
      const isOwn = s.entity_id === id;
      const cur = byClass.get(cls);
      if (!cur || (isOwn && !cur._own)) {
        byClass.set(cls, {
          signal_class: cls,
          detected:   s.value?.detected ?? null,
          implies:    s.value?.implies ?? null,
          score:      s.value?.score ?? null,
          approach:   s.value?.approach ?? null,
          angle:      s.value?.angle ?? null,
          updated_at: s.computed_at,
          _own: isOwn,
        });
      }
    }
    const signals = Array.from(byClass.values()).map(({ _own, ...s }) => s);

    // ICP prediction + its history trail (the evolving per-person score). The
    // headline contact.icp_score stays the hybrid (seed until the model trains);
    // this exposes the live model score + the full trail for the timeline UI.
    const predRow = predRowRes.data;
    const prediction = predRow ? {
      score:      predRow.predicted_value?.score ?? null,
      fit:        predRow.predicted_value?.fit ?? null,
      tier:       predRow.predicted_value?.tier ?? scoreTier(predRow.predicted_value?.score),
      reason:     predRow.predicted_value?.reason ?? null,
      history:    Array.isArray(predRow.predicted_value?.history) ? predRow.predicted_value.history : [],
      updated_at: predRow.predicted_value?.rescored_at || predRow.predicted_at,
      // WHICH signals held the score up. `reason` is a sentence; this is the list, and
      // the list is the part you can argue with, act on, or notice is empty.
      drivers: (Array.isArray(predRow.fired_signals) ? predRow.fired_signals : [])
        .map(f => (typeof f === 'string' ? { key: f, weight: null } : { key: f?.key, weight: f?.weight ?? null }))
        .filter(d => d.key),
    } : null;

    // Six lookups that need nothing from each other, so they go together (GET-317). Each call to
    // this database costs ~130ms whatever it asks for, and run one after another this tail was
    // most of the 2.3 SECONDS the person drawer took. Only reply_owed genuinely depends on
    // another (there is nothing owed if there was no reply), and the member profiles are fetched
    // alongside rather than after, because whether an owner exists does not change their cost.
    const [personal, intentMap, replyMap, relMap, profiles] = await Promise.all([
      isEntityPersonal(supabase, workspaceId, id).catch(() => false),
      fetchIntentByEntity(supabase, workspaceId, [id]).catch(() => new Map()),
      fetchReplySignalByEntity(supabase, workspaceId, [id]).catch(() => new Map()),
      getRelationshipOwners(supabase, workspaceId, [id]).catch(() => new Map()),
      getWorkspaceMemberProfiles(supabase, workspaceId).catch(() => new Map()),
    ]);

    // Relationship flag — so the record drawer can show the "Not a deal" state and
    // toggle. A personal/network contact is one you've marked as a friend, never a lead.
    contact.is_personal = personal;

    // Overlay the intent band + the latest reply disposition — the SAME claims the
    // People list reads. Without this the detail drawer always rendered intent "—"
    // (the list row carried intent_band, but this by-id fetch never attached it), and
    // it's where the new "Reply" chip (positive / objection / unsubscribe / OOO) reads.
    const iv = intentMap.get(id);
    if (iv) { contact.intent_score = iv.score; contact.intent_band = iv.band; }
    const rv = replyMap.get(id);
    contact.reply_signal = rv?.signal ?? null;
    contact.reply_at = rv?.at ?? null;
    contact.reply_owed_since = rv
      ? ((await loadReplyOwed(supabase, workspaceId, [id]).catch(() => new Map())).get(id)?.owed_since ?? null)
      : null;

    // Who on the team owns this person — the relationship_owner primary (whoever has
    // actually been in touch, via co-attendance), resolved to a name + avatar so the
    // person record shows an Owner the same way an account does.
    const relRow = relMap.get(id);
    const ownerUserId = effectiveOwnerUserId(relRow);
    if (ownerUserId) {
      const prof = profiles.get(ownerUserId);
      contact.owner_user_id = ownerUserId;
      contact.owner_name = prof?.name ?? null;
      contact.owner_avatar = prof?.avatar ?? null;
    }

    // The person's facts grouped into topics (stored; rebuilt in the background when new facts land).
    const intel_topics = await intelTopicsFor(supabase, contact.workspace_id, id, memories || [],
      () => listNotes(supabase, contact.workspace_id, { entityId: id, limit: 200 })).catch(() => null);
    // Linked to a CRM record (GET-788), and whether there is a CRM to be linked to at all.
    // Read off the identifiers, not the view's columns: a cold lead's record is built from the leads
    // view, which has none of them.
    const crm_connected = await workspaceHasCrm(supabase, contact.workspace_id).catch(() => false);
    contact.in_crm = crm_connected
      ? (await crmLinkedPeople(supabase, contact.workspace_id, [id]).catch(() => new Set([id]))).has(id)
      : null;
    // Product usage from PostHog (GET-751): is this person a user, and how much.
    const { data: usageRows } = await supabase.from('claims').select('property, value')
      .eq('workspace_id', contact.workspace_id).eq('entity_id', id).in('property', PERSON_USAGE_PROPERTIES).is('invalid_at', null);
    contact.product_usage = personProductUsage(usageRows);
    return res.json({ contact, activities, company, memories, intel_topics, signals, prediction, crm_connected });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts
contactsApiRouter.post('/', verifySupabaseAuth, requireAccountsBalance, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, email, firstName, lastName, phone, company, jobTitle, notes, tags, source, industry, lead_source, company_size, keywords, company_id } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!workspaceId || !email) return res.status(400).json({ error: 'workspace_id_and_email_required' });
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email_format' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    // Auto-resolve company_id — explicit company_id (e.g. adding a stakeholder from an
    // account's org chart) wins; else resolve by domain/name.
    let companyId = null;
    if (company_id && UUID.test(company_id)) {
      const { data: ex } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).eq('id', company_id).maybeSingle();
      if (ex) companyId = ex.id;
    }
    if (!companyId && company?.trim()) {
      const cName = company.trim();
      const rawDomain = req.body.domain?.trim();
      const domain = rawDomain ? rawDomain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase().split('/')[0] : null;
      if (domain) {
        const { data: ex } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).eq('domain', domain).maybeSingle();
        if (ex) { companyId = ex.id; } else { const { data: ins } = await supabase.from('companies').insert({ workspace_id: workspaceId, name: cName, domain }).select('id').single(); companyId = ins?.id; }
      } else {
        const { data: ex } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).ilike('name', cName).maybeSingle();
        if (ex) { companyId = ex.id; } else { const { data: ins } = await supabase.from('companies').insert({ workspace_id: workspaceId, name: cName }).select('id').single(); companyId = ins?.id; }
      }
    }

    const { data: contact, error } = await supabase.from('contacts').insert({
      workspace_id: workspaceId, email: email.toLowerCase().trim(),
      first_name: firstName?.trim() || null, last_name: lastName?.trim() || null,
      phone: phone?.trim() || null, company: company?.trim() || null,
      job_title: jobTitle?.trim() || null, notes: notes?.trim() || null,
      tags: tags || [], source: source || 'manual', industry: industry?.trim() || null,
      lead_source: lead_source?.trim() || null, company_size: company_size?.trim() || null,
      keywords: keywords?.trim() || null, created_by: user.id, company_id: companyId,
    }).select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'contact_already_exists' });
      throw error;
    }
    return res.status(201).json({ contact });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// PATCH /api/contacts/:id
contactsApiRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    const { data: existing } = await supabase.from('contacts').select('*').eq('id', id).single();
    if (!existing) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', existing.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'contact_not_found_or_unauthorized' });

    const { email, firstName, lastName, phone, company, jobTitle, linkedinUrl, notes, tags, industry, deal_value, dealValue, deal_closed_at, lead_source, company_size, keywords, status, dealStage, deal_stage, pipeline_stage, department, seniority, city, country } = req.body;
    const updates = {};
    if (email !== undefined) { if (!EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email_format' }); updates.email = email.toLowerCase().trim(); }
    if (firstName !== undefined) updates.first_name = firstName?.trim() || null;
    if (lastName !== undefined) updates.last_name = lastName?.trim() || null;
    if (phone !== undefined) updates.phone = phone?.trim() || null;
    if (company !== undefined) updates.company = company?.trim() || null;
    if (jobTitle !== undefined) updates.job_title = jobTitle?.trim() || null;
    if (linkedinUrl !== undefined) updates.linkedin_url = linkedinUrl?.trim() || null;
    if (notes !== undefined) updates.notes = notes?.trim() || null;
    if (tags !== undefined) updates.tags = tags;
    if (industry !== undefined) updates.industry = industry?.trim() || null;
    // The Personal Details panel shows these as editable; they were silently dropped here.
    if (department !== undefined) updates.department = department?.trim() || null;
    if (seniority !== undefined) updates.seniority = seniority?.trim() || null;
    if (city !== undefined) updates.city = city?.trim() || null;
    if (country !== undefined) updates.country = country?.trim() || null;
    const dv = dealValue !== undefined ? dealValue : deal_value;
    if (dv !== undefined) updates.deal_value = dv;
    if (deal_closed_at !== undefined) updates.deal_closed_at = deal_closed_at;
    const ds = dealStage !== undefined ? dealStage : deal_stage;
    if (ds !== undefined) updates.deal_stage = ds?.trim() || null;
    if (lead_source !== undefined) updates.lead_source = lead_source?.trim() || null;
    if (company_size !== undefined) updates.company_size = company_size?.trim() || null;
    if (keywords !== undefined) updates.keywords = keywords?.trim() || null;
    if (status !== undefined && ['prospect', 'client'].includes(status)) updates.status = status;
    // Whatever the caller sent used to be written straight into the column, so a typo
    // or a stage the UI invented became a real record state. A value nothing
    // downstream recognises reads as "not in the funnel", which is how a live deal
    // gets misfiled. Only canonical stages are written now: legacy names (client,
    // proposal, aware…) are normalized on the way in and anything unrecognisable is a
    // 400 instead of a corrupted row. An explicit null still clears the stage, the
    // same as every other field on this route.
    if (pipeline_stage !== undefined) {
      if (pipeline_stage === null || pipeline_stage === '') {
        updates.pipeline_stage = null;
      } else {
        const stage = normalizeStage(pipeline_stage);
        if (!stage) return res.status(400).json({ error: 'invalid_pipeline_stage', allowed: [...ALL_PIPELINE_STAGES] });
        updates.pipeline_stage = stage;
      }
    }

    const { data: contact, error } = await supabase.from('contacts').update(updates).eq('id', id).select().single();
    if (error) { if (error.code === '23505') return res.status(409).json({ error: 'contact_already_exists' }); throw error; }

    // Identity fields (email, linkedin_url) live in `entity_identifiers`, where the
    // contacts view surfaces ONE active row per kind (LIMIT 1, no ordering). A plain
    // update inserts the new value but leaves the OLD identifier active too — so the
    // view can keep showing the stale one, which is why a manual edit appears to
    // "revert". Make the edited value the SINGLE active identifier of its kind so the
    // change sticks deterministically. Reversible: others are deactivated, not deleted.
    const identityEdits = [];
    if (email !== undefined)       identityEdits.push({ kind: 'email',        value: updates.email || null });
    if (linkedinUrl !== undefined) identityEdits.push({ kind: 'linkedin_url', value: updates.linkedin_url || null });
    for (const { kind, value } of identityEdits) {
      // Retire every other active identifier of this kind on this entity.
      // ('retired' is the only non-active status the CHECK constraint allows.)
      let retire = supabase.from('entity_identifiers').update({ status: 'retired' })
        .eq('workspace_id', existing.workspace_id).eq('entity_id', id).eq('kind', kind).eq('status', 'active');
      if (value) retire = retire.neq('value', value);
      await retire;
      // Ensure the edited value exists and is active. upsertIdentifier does a
      // reactivate-or-insert that works against the partial active index (a plain
      // .upsert on workspace_id,kind,value can't target it and silently fails).
      if (value) {
        await upsertIdentifier(supabase, existing.workspace_id, id, kind, value);
      }
    }

    // Claim-backed fields (name, job_title, company, notes, …) are resolved from
    // observations and recompute asynchronously — so a plain edit can lag, then get
    // OVERWRITTEN by a later enrichment run. A manual edit is ground truth, so we
    // ASSERT it: assertClaims pins each edited field as an `asserted` claim
    // (confidence 1.0), which the derivation engine refuses to overwrite
    // (recomputeClaim bails on epistemic_class='asserted') and which shows
    // immediately (no recompute wait). Passing null invalidates (clears) the field.
    // email/linkedin_url are identifiers (handled above), not claims — skip them.
    const ASSERT_SKIP = new Set(['email', 'linkedin_url']);
    const assertValues = {};
    for (const [k, v] of Object.entries(updates)) {
      if (!ASSERT_SKIP.has(k)) assertValues[k] = v;
    }
    if (Object.keys(assertValues).length) {
      await assertClaims(supabase, existing.workspace_id, id, { values: assertValues, source: 'manual' });
    }

    // Re-fetch so the response reflects the asserted claims + reconciled
    // identifiers, not the pre-reconciliation row returned by the update above.
    if (identityEdits.length || Object.keys(assertValues).length) {
      const { data: fresh } = await supabase.from('contacts').select('*').eq('id', id).single();
      return res.json({ contact: fresh || contact });
    }
    return res.json({ contact });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// DELETE /api/contacts/:id
// Full cascade delete of person entities. Deleting the `entities` row cascades
// EVERYTHING Nous knows about them — claims (incl. notes + meeting documents),
// observations/activities, entity_identifiers, predictions/scores, relationships,
// claim_jobs, collection (lead-list) memberships — all ON DELETE CASCADE from here.
// So the account is removed completely and a re-import starts clean. We null out any
// `merged_into` pointer first, since that FK would otherwise RESTRICT the delete.
async function cascadeDeleteEntities(supabase, workspaceId, ids) {
  if (!ids.length) return 0;
  await supabase.from('entities').update({ merged_into: null })
    .eq('workspace_id', workspaceId).in('merged_into', ids)
    .then(() => {}, () => {});
  const { data, error } = await supabase.from('entities').delete()
    .eq('workspace_id', workspaceId).in('id', ids).select('id');
  if (error) throw error;
  return data?.length || 0;
}

contactsApiRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    // Resolve the workspace off the ENTITY, not the contacts view — a cold lead isn't
    // in the view, which is why the old delete 404'd on freshly imported people.
    const { data: ent } = await supabase.from('entities').select('workspace_id').eq('id', id).maybeSingle();
    if (!ent) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', ent.workspace_id).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    const deleted = await cascadeDeleteEntities(supabase, ent.workspace_id, [id]);
    return res.json({ success: true, deleted });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/bulk-delete { workspaceId, ids } — multi-select delete.
contactsApiRouter.post('/bulk-delete', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, ids } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);
    if (!workspaceId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'workspace_and_ids_required' });
    const valid = ids.filter(x => UUID.test(String(x)));
    if (!valid.length) return res.status(400).json({ error: 'no_valid_ids' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    const deleted = await cascadeDeleteEntities(supabase, workspaceId, valid);
    return res.json({ success: true, deleted });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/bulk-personal { workspaceId, ids, personal } — multi-select mark
// (or unmark) as personal/network. Sets a sticky is_personal claim on each selected
// contact; they stay in the graph and the list but drop out of deal/pipeline logic.
contactsApiRouter.post('/bulk-personal', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, ids, personal } = req.body || {};
    const on = personal !== false; // default true; pass { personal: false } to unmark
    const { user } = await ensureUserAndTeam(req.user);
    if (!workspaceId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'workspace_and_ids_required' });
    const valid = ids.filter(x => UUID.test(String(x)));
    if (!valid.length) return res.status(400).json({ error: 'no_valid_ids' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    for (const entityId of valid) await markEntityPersonal(supabase, workspaceId, entityId, on);
    return res.json({ success: true, updated: valid.length, is_personal: on });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/bulk-internal { workspaceId, ids, internal } — multi-select mark
// (or unmark) as a team member. Team members stay in the graph and the list (tagged)
// but are excluded from pipeline/deal analysis, scoring, and outreach.
contactsApiRouter.post('/bulk-internal', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, ids, internal } = req.body || {};
    const on = internal !== false; // default true; pass { internal: false } to unmark
    const { user } = await ensureUserAndTeam(req.user);
    if (!workspaceId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'workspace_and_ids_required' });
    const valid = ids.filter(x => UUID.test(String(x)));
    if (!valid.length) return res.status(400).json({ error: 'no_valid_ids' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    for (const entityId of valid) await setEntityInternalManual(supabase, workspaceId, entityId, on);
    return res.json({ success: true, updated: valid.length, is_internal: on });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/:id/owner — manually assign or revoke the owner of a person.
// Body: { user_id, action?: 'assign' | 'remove' } (default 'assign'). Assigning sets
// the sticky owner and grants that member read access; removing revokes it. The
// assignee must be a member of the same workspace.
contactsApiRouter.post('/:id/owner', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user_id, action = 'assign' } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });
    if (!user_id || !UUID.test(String(user_id))) return res.status(400).json({ error: 'user_id_required' });

    const { data: ent } = await supabase.from('entities').select('workspace_id').eq('id', id).maybeSingle();
    const workspaceId = ent?.workspace_id;
    if (!workspaceId) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    const { data: target } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).eq('user_id', user_id).maybeSingle();
    if (!target) return res.status(400).json({ error: 'not_a_workspace_member' });

    const rel = action === 'remove'
      ? await removeRelationshipMember(supabase, workspaceId, id, user_id)
      : await assignRelationshipOwner(supabase, workspaceId, id, user_id);

    // Provenance for the workspace access log: who granted/revoked whom, on what.
    auditFromReq(req, {
      action: action === 'remove' ? 'ownership.removed' : 'ownership.assigned',
      target_type: 'account', target_id: id, target_workspace_id: workspaceId,
      metadata: { member_user_id: user_id, via: 'manual' },
    });

    const ownerUserId = effectiveOwnerUserId(rel);
    const prof = ownerUserId ? (await getWorkspaceMemberProfiles(supabase, workspaceId)).get(ownerUserId) : null;
    return res.json({ success: true, action, owner_user_id: ownerUserId ?? null, owner_name: prof?.name ?? null, owner_avatar: prof?.avatar ?? null });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/:id/memories
contactsApiRouter.post('/:id/memories', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { content, category, about } = req.body;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });

    const { data: contact } = await supabase.from('contacts').select('workspace_id').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', contact.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    const mem = await saveNote(supabase, contact.workspace_id, {
      entityId: id,
      category: normalizeClaimCategory(category),
      content: content.trim(),
      source: 'manual',
      metadata: { about: normalizeClaimAbout(about) },
    });
    return res.json({ memory: mem });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/contacts/:id/memories/:noteId — soft-delete one note/document on a
// contact. Notes are asserted claims (property note.<uuid>); "delete" invalidates
// via invalid_at per the v2 "never hard-delete" rule (see @nous/core deleteNote),
// so it vanishes from the Notes tab but stays recoverable. Used to clear duplicate
// briefs the meeting-brief skill appended.
contactsApiRouter.delete('/:id/memories/:noteId', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id, noteId } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });
    if (!UUID.test(noteId)) return res.status(400).json({ error: 'invalid_note_id' });

    // Resolve the workspace off the entity so cold leads (not in the contacts view)
    // still work — same reason the contact delete reads entities, not contacts.
    const { data: ent } = await supabase.from('entities').select('workspace_id').eq('id', id).maybeSingle();
    if (!ent) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', ent.workspace_id).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    // The note must exist in this workspace AND belong to THIS contact — so you
    // can't invalidate a note hanging off another entity by guessing its id.
    const note = await getNote(supabase, ent.workspace_id, noteId);
    if (!note || note.entity_id !== id) return res.status(404).json({ error: 'note_not_found' });

    await deleteNote(supabase, ent.workspace_id, noteId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/:id/mark-lost — record an explicit closed-lost on a contact.
// This is a real negative the Mind learns from (vs 30-day silence). It logs an
// `interaction.deal_lost` observation, which mindOutcomes resolves as a loss.
contactsApiRouter.post('/:id/mark-lost', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { reason } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    const { data: contact } = await supabase.from('contacts').select('workspace_id, company_id').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'contact_not_found' });
    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', contact.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    await logActivity(supabase, {
      workspaceId: contact.workspace_id,
      contactId: id,
      companyId: contact.company_id || null,
      type: 'deal_lost',
      source: 'manual',
      externalId: `deal_lost_${id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Marked lost',
      summary: reason ? String(reason).slice(0, 280) : null,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/contacts/:id/mark-lost]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Mark a contact — and their company — as a CLIENT (a won deal). Logs a deal_won
// activity on the person (→ pipeline_stage=closed_won + the Mind resolves their ICP
// prediction as a WIN, which the scorecard learns from), then propagates the same
// to the company entity: one won contact means the whole account is won, so the
// company flips to closed_won too while the OTHER contacts are left untouched. That
// matches how you actually close — you sign one company, not every person at it.
// For a SERVICE business, winning a company makes EVERY person at it a client —
// there is one client relationship, not a separate deal per contact. (Software keeps
// the per-contact behavior below: individual users convert independently.) People
// already off the ladder are left alone: that is DONE_STAGES, not TERMINAL_STAGES,
// because closed_won is the top of the ladder rather than an exit but must not be
// re-won by propagation either. Gated on business_type so we don't change
// B2B-software semantics.
async function propagateClientToCompanyPeople(supabase, workspaceId, companyId, exceptContactId, { force = false } = {}) {
  // `force` skips the service gate — used when the user explicitly marks the whole
  // COMPANY a client, where converting everyone at it is the whole point regardless
  // of business type.
  if (!force) {
    const { data: ws } = await supabase.from('workspaces').select('business_type').eq('id', workspaceId).maybeSingle();
    if (ws?.business_type !== 'service') return;
  }
  const { data: people } = await supabase.from('contacts')
    .select('id, pipeline_stage').eq('workspace_id', workspaceId).eq('company_id', companyId);
  const ts = new Date().toISOString();
  for (const p of (people || [])) {
    // Rows still hold pre-funnel values (client, lost, …) until the migration runs,
    // so normalize before the check — a raw compare would miss them and re-convert
    // someone who is already won or already lost.
    if (p.id === exceptContactId || DONE_STAGES.has(normalizeStage(p.pipeline_stage))) continue;
    await supabase.from('contacts').update({ pipeline_stage: 'closed_won' }).eq('id', p.id);
    await supabase.from('observations').insert({
      workspace_id: workspaceId, entity_id: p.id, kind: 'state',
      property: 'pipeline_stage', value: 'closed_won', source: 'system',
      method: 'client_propagation', observed_at: ts,
    }).then(({ error }) => { if (error && !['23505'].includes(error.code ?? '')) console.warn('[CLIENT_PROPAGATE]', error.message); });
  }
}

async function markContactClient(supabase, workspaceId, contactId, companyId) {
  const ts = Date.now();
  await logActivity(supabase, {
    workspaceId, contactId, companyId: companyId || null,
    type: 'deal_won', source: 'manual',
    externalId: `deal_won_${contactId}_${ts}`,
    occurredAt: new Date().toISOString(),
    description: 'Marked client',
  });
  if (companyId) {
    // contactId=companyId so advancePipelineStage + outcome resolution run on the
    // COMPANY entity (writeStage's contacts update is a harmless no-op for a company).
    await logActivity(supabase, {
      workspaceId, contactId: companyId, companyId,
      type: 'deal_won', source: 'manual',
      externalId: `deal_won_company_${companyId}_${ts}`,
      occurredAt: new Date().toISOString(),
      description: 'Marked client',
    });
    // Service businesses: the whole account converts, not just the signer.
    await propagateClientToCompanyPeople(supabase, workspaceId, companyId, contactId);
  }
}

// Mark a whole COMPANY a client: the company entity converts and EVERY person at it
// becomes a client. The account relationship is with the company, not one individual,
// so this is the natural entry point; markContactClient above is the per-person one.
export async function markCompanyClient(supabase, workspaceId, companyId) {
  const ts = Date.now();
  await logActivity(supabase, {
    workspaceId, contactId: companyId, companyId,
    type: 'deal_won', source: 'manual',
    externalId: `deal_won_company_${companyId}_${ts}`,
    occurredAt: new Date().toISOString(),
    description: 'Marked client',
  });
  await propagateClientToCompanyPeople(supabase, workspaceId, companyId, null, { force: true });
}

// POST /api/contacts/:id/mark-client — mark one contact (and their company) a client.
contactsApiRouter.post('/:id/mark-client', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    const { data: contact } = await supabase.from('contacts').select('workspace_id, company_id').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'contact_not_found' });
    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', contact.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    await markContactClient(supabase, contact.workspace_id, id, contact.company_id || null);
    return res.json({ ok: true, company_id: contact.company_id || null });
  } catch (err) {
    console.error('[POST /api/contacts/:id/mark-client]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/contacts/bulk-client { workspaceId, ids } — mark many contacts (and their
// companies) as clients.
contactsApiRouter.post('/bulk-client', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, ids } = req.body || {};
    const { user } = await ensureUserAndTeam(req.user);
    if (!workspaceId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'workspace_and_ids_required' });
    const valid = ids.filter(x => UUID.test(String(x)));
    if (!valid.length) return res.status(400).json({ error: 'no_valid_ids' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    const { data: rows } = await supabase.from('contacts').select('id, company_id').eq('workspace_id', workspaceId).in('id', valid);
    for (const c of rows || []) await markContactClient(supabase, workspaceId, c.id, c.company_id || null);
    return res.json({ success: true, updated: (rows || []).length });
  } catch (err) {
    console.error('[POST /api/contacts/bulk-client]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/contacts/:id/personal — mark (or unmark) a contact as personal/network,
// not a deal. Sets a sticky is_personal claim so no deal-risk, lost-deal, or going-dark
// logic ever applies to them. Body: { personal?: boolean } (defaults to true).
contactsApiRouter.post('/:id/personal', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const on = req.body?.personal !== false; // default true; pass { personal: false } to unmark
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    const { data: contact } = await supabase.from('contacts').select('workspace_id').eq('id', id).maybeSingle();
    const workspaceId = contact?.workspace_id
      || (await supabase.from('leads').select('workspace_id').eq('id', id).maybeSingle()).data?.workspace_id;
    if (!workspaceId) return res.status(404).json({ error: 'contact_not_found' });
    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'unauthorized' });

    await markEntityPersonal(supabase, workspaceId, id, on);
    return res.json({ ok: true, is_personal: on });
  } catch (err) {
    console.error('[POST /api/contacts/:id/personal]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Map a free-text stage/status cell from a CSV (a "Status", "Stage", "Lifecycle" or
// "Client" column) onto our canonical pipeline_stage + the prospect/client status.
// This is what lets an import know, on day one, who is already a client vs who is in
// the funnel. Case-insensitive; returns null when the cell isn't a recognizable stage
// so we never overwrite with garbage.
const IMPORT_STAGE_MAP = new Map(Object.entries({
  // won — the top of the ladder, and the only stage that also makes them a client
  client: 'closed_won', customer: 'closed_won', won: 'closed_won', 'closed won': 'closed_won', 'closed-won': 'closed_won',
  closedwon: 'closed_won', active: 'closed_won', paying: 'closed_won', signed: 'closed_won', live: 'closed_won',
  'current client': 'closed_won', existing: 'closed_won', 'existing client': 'closed_won', 'active client': 'closed_won', member: 'closed_won',
  // terminal
  churned: 'churned', churn: 'churned', former: 'churned', cancelled: 'churned', canceled: 'churned',
  lost: 'closed_lost', 'closed lost': 'closed_lost', 'closed-lost': 'closed_lost', dead: 'closed_lost',
  disqualified: 'disqualified', dq: 'disqualified', unqualified: 'disqualified', 'not a fit': 'disqualified',
  // funnel. proposal is folded into negotiation, and evaluating resolves to the
  // conservative `interested` rather than inventing a call that may never have
  // happened — same rules as LEGACY_STAGE_MAP in packages/core/src/pipeline.ts.
  negotiation: 'negotiation', negotiating: 'negotiation', contract: 'negotiation', 'contract sent': 'negotiation',
  proposal: 'negotiation', 'proposal sent': 'negotiation', quote: 'negotiation', quoted: 'negotiation',
  demo: 'demo', 'demo held': 'demo', 'product demo': 'demo',
  discovery: 'discovery', 'discovery call': 'discovery', 'meeting held': 'discovery', 'call held': 'discovery',
  'meeting booked': 'meeting_booked', 'meeting scheduled': 'meeting_booked', 'demo booked': 'meeting_booked',
  'demo scheduled': 'meeting_booked', 'call booked': 'meeting_booked', 'call scheduled': 'meeting_booked',
  evaluating: 'interested', evaluation: 'interested', trial: 'interested',
  interested: 'interested', replied: 'interested', engaged: 'interested', mql: 'interested',
  sql: 'interested', opportunity: 'interested', opp: 'interested', qualified: 'interested',
  connected: 'connected', connection: 'connected',
  aware: 'identified', nurture: 'identified', nurturing: 'identified',
  lead: 'identified', prospect: 'identified', new: 'identified', cold: 'identified',
  identified: 'identified', open: 'identified',
}));
function normalizeImportedStage(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  if (!k) return null;
  // The table covers the words CRMs invent; normalizeStage covers our own stage names
  // and the pre-funnel ones a legacy export still carries, so neither list has to be
  // kept in two places.
  const stage = IMPORT_STAGE_MAP.get(k) || IMPORT_STAGE_MAP.get(k.replace(/[_-]+/g, ' ')) || normalizeStage(k);
  if (!stage) return null;
  // `status` is the separate prospect/client column, not a pipeline stage — a won
  // deal is the one thing that makes someone a client.
  return { stage, status: stage === 'closed_won' ? 'client' : 'prospect' };
}
// The row's lifecycle, from whichever column carried it (pipeline_stage, deal_stage,
// or a status/client column mapped to `status`).
const resolveRowStage = (r) =>
  normalizeImportedStage(r.pipeline_stage) || normalizeImportedStage(r.deal_stage) || normalizeImportedStage(r.status);

// POST /api/contacts/import
// requireAccountsBalance: importing works right up to and through the 3-day grace
// window (over the plan's active-account cap still passes). It only 402s once grace
// has expired — the hard paywall. Existing accounts and incoming signal are never
// touched; this only gates PROACTIVELY adding more.
contactsApiRouter.post('/import', verifySupabaseAuth, requireAccountsBalance, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, rows } = req.body;
    const { user } = await ensureUserAndTeam(req.user);
    if (!workspaceId || !Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'workspace_id_and_rows_required' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    // Accept rows with a valid email OR a linkedin_url — at least one is required
    const validRows = rows.filter(r => {
      const hasEmail = r.email && EMAIL.test(r.email.trim());
      const hasLinkedin = r.linkedin_url && r.linkedin_url.trim().length > 0;
      return hasEmail || hasLinkedin;
    }).slice(0, 2000);
    if (!validRows.length) return res.status(400).json({ error: 'no_valid_rows' });

    // Split into email-identified and linkedin-only rows
    const emailRows = validRows.filter(r => r.email && EMAIL.test(r.email.trim()));
    const linkedinOnlyRows = validRows.filter(r => !(r.email && EMAIL.test(r.email.trim())));

    // Dedup against the ENTITY graph (entity_identifiers), NOT the `contacts` view.
    // The view only projects engaged people, so a cold lead imported earlier is
    // invisible to it — which made every re-import fork a NEW entity whose email
    // identifier then collided with the original's (unique index → ON CONFLICT DO
    // NOTHING in the insert trigger) and got dropped. Net result: empty email/LinkedIn
    // columns and duplicate contacts. Identifiers cover every entity, engaged or cold.
    const emails = emailRows.map(r => r.email.toLowerCase().trim());
    const { data: emailIdents } = emails.length
      ? await supabase.from('entity_identifiers').select('entity_id, value')
          .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active').in('value', emails)
      : { data: [] };
    const existingByEmail = (emailIdents || []).map(r => ({ id: r.entity_id, email: r.value }));
    const existingEmailSet = new Set(existingByEmail.map(c => c.email.toLowerCase()));

    // Dedup linkedin-only rows by linkedin_url, same way.
    const linkedinUrls = linkedinOnlyRows.map(r => r.linkedin_url.trim());
    const { data: liIdents } = linkedinUrls.length
      ? await supabase.from('entity_identifiers').select('entity_id, value')
          .eq('workspace_id', workspaceId).eq('kind', 'linkedin_url').eq('status', 'active').in('value', linkedinUrls)
      : { data: [] };
    const existingByLinkedin = (liIdents || []).map(r => ({ id: r.entity_id, linkedin_url: r.value }));
    const existingLinkedinSet = new Set(existingByLinkedin.map(c => c.linkedin_url));

    const toCreate = [
      ...emailRows.filter(r => !existingEmailSet.has(r.email.toLowerCase().trim())),
      ...linkedinOnlyRows.filter(r => !existingLinkedinSet.has(r.linkedin_url.trim())),
    ];
    const toUpdateEmail = emailRows.filter(r => existingEmailSet.has(r.email.toLowerCase().trim()));
    const toUpdateLinkedin = linkedinOnlyRows.filter(r => existingLinkedinSet.has(r.linkedin_url.trim()));

    // Resolve-or-create a company entity for every distinct company in the
    // import, so importing people also populates the Companies list. Mirrors the
    // single-contact create path, batched over distinct companies. Best-effort:
    // a failed company never blocks the contact import.
    const normDomain = (d) => d ? d.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase().split('/')[0] : null;
    // A B2B contact's email domain IS their company domain (kai@lumora.example →
    // lumora.example), so derive it when the import file carried no domain column —
    // except for free-mail providers, where the email domain says nothing about
    // where they work. This is what fills the DOMAIN column and, via the company
    // entity, the logo-by-domain lookup.
    const domainFromEmail = (email) => {
      const at = (email || '').toLowerCase().trim().split('@')[1];
      if (!at || FREEMAIL_DOMAINS.has(at)) return null;
      return normDomain(at);
    };
    const rowDomain = (r) => normDomain(r.domain?.trim()) || domainFromEmail(r.email);
    const companyKeyOf = (r) => {
      const dom = rowDomain(r);
      if (dom) return `d:${dom}`;
      const name = r.company?.trim();
      if (name) return `n:${name.toLowerCase()}`;
      return null;
    };
    const companyIdByKey = new Map();
    const distinctCompanies = new Map();
    for (const r of validRows) {
      const key = companyKeyOf(r);
      if (key && !distinctCompanies.has(key)) {
        distinctCompanies.set(key, { name: r.company?.trim() || null, domain: rowDomain(r) });
      }
    }
    for (const [key, { name, domain }] of distinctCompanies) {
      try {
        let cid = null;
        if (domain) {
          const { data: ex } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).eq('domain', domain).maybeSingle();
          cid = ex?.id ?? (await supabase.from('companies').insert({ workspace_id: workspaceId, name: name || domain, domain }).select('id').single()).data?.id;
        } else if (name) {
          const { data: ex } = await supabase.from('companies').select('id').eq('workspace_id', workspaceId).ilike('name', name).maybeSingle();
          cid = ex?.id ?? (await supabase.from('companies').insert({ workspace_id: workspaceId, name }).select('id').single()).data?.id;
        }
        if (cid) companyIdByKey.set(key, cid);
      } catch (e) {
        console.error('[CONTACTS_IMPORT_COMPANY_RESOLVE]', e.message);
      }
    }

    const buildInsertRow = (r) => ({
      workspace_id: workspaceId,
      email: r.email ? r.email.toLowerCase().trim() : null,
      first_name: r.first_name?.trim() || null, last_name: r.last_name?.trim() || null,
      company: r.company?.trim() || null, job_title: r.job_title?.trim() || null,
      linkedin_url: r.linkedin_url?.trim() || null, source: r.source?.trim() || 'import',
      phone: r.phone?.trim() || null, domain: rowDomain(r),
      notes: r.notes?.trim() || null, seniority: r.seniority?.trim() || null,
      department: r.department?.trim() || null, deal_stage: r.deal_stage?.trim() || null,
      pipeline_stage: resolveRowStage(r)?.stage || null,
      status: resolveRowStage(r)?.status || 'prospect',
      created_by: user.id,
    });

    const buildUpdateFields = (r) => {
      const u = {};
      if (r.first_name) u.first_name = r.first_name.trim();
      if (r.last_name) u.last_name = r.last_name.trim();
      if (r.company) u.company = r.company.trim();
      if (r.job_title) u.job_title = r.job_title.trim();
      if (r.phone) u.phone = r.phone.trim();
      const dom = rowDomain(r);
      if (dom) u.domain = dom;
      if (r.notes) u.notes = r.notes.trim();
      if (r.seniority) u.seniority = r.seniority.trim();
      if (r.department) u.department = r.department.trim();
      if (r.deal_stage) u.deal_stage = r.deal_stage.trim();
      const st = resolveRowStage(r);
      if (st) { u.pipeline_stage = st.stage; u.status = st.status; }
      if (r.linkedin_url) u.linkedin_url = r.linkedin_url.trim();
      return u;
    };

    let created = 0, updated = 0;
    let newContactIds = [];
    if (toCreate.length) {
      const { data: inserted, error } = await supabase.from('contacts').insert(toCreate.map(buildInsertRow)).select('id');
      if (!error) {
        created = inserted?.length || 0;
        newContactIds = (inserted || []).map(c => c.id);
        // Link each new contact to its company via a works_at relationship — the
        // contacts view derives company_id from this edge (its INSTEAD OF insert
        // trigger ignores a company_id column). Insert order matches toCreate.
        const rels = [];
        for (let i = 0; i < inserted.length; i++) {
          const cid = companyIdByKey.get(companyKeyOf(toCreate[i]));
          if (cid) rels.push({ workspace_id: workspaceId, from_entity_id: inserted[i].id, to_entity_id: cid, type: 'works_at', valid_from: new Date().toISOString() });
        }
        if (rels.length) {
          const { error: relErr } = await supabase.from('relationships').upsert(rels, { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true });
          if (relErr) console.error('[CONTACTS_IMPORT_WORKS_AT]', relErr.message);
        }
      }
    }
    for (const r of toUpdateEmail) {
      const u = buildUpdateFields(r);
      if (Object.keys(u).length) await supabase.from('contacts').update(u).eq('workspace_id', workspaceId).eq('email', r.email.toLowerCase().trim());
      updated++;
    }
    for (const r of toUpdateLinkedin) {
      const u = buildUpdateFields(r);
      if (Object.keys(u).length) await supabase.from('contacts').update(u).eq('workspace_id', workspaceId).eq('linkedin_url', r.linkedin_url.trim());
      updated++;
    }

    // Also link existing (updated) contacts to their company, so re-importing a
    // file backfills associations for people imported before this existed.
    const emailToId = new Map((existingByEmail || []).map(c => [c.email.toLowerCase(), c.id]));
    const liToId = new Map((existingByLinkedin || []).map(c => [c.linkedin_url, c.id]));
    const updateRels = [];
    for (const r of toUpdateEmail) {
      const cid = companyIdByKey.get(companyKeyOf(r));
      const pid = emailToId.get(r.email.toLowerCase().trim());
      if (cid && pid) updateRels.push({ workspace_id: workspaceId, from_entity_id: pid, to_entity_id: cid, type: 'works_at', valid_from: new Date().toISOString() });
    }
    for (const r of toUpdateLinkedin) {
      const cid = companyIdByKey.get(companyKeyOf(r));
      const pid = liToId.get(r.linkedin_url.trim());
      if (cid && pid) updateRels.push({ workspace_id: workspaceId, from_entity_id: pid, to_entity_id: cid, type: 'works_at', valid_from: new Date().toISOString() });
    }
    if (updateRels.length) {
      const { error: relErr } = await supabase.from('relationships').upsert(updateRels, { onConflict: 'workspace_id,from_entity_id,to_entity_id,type', ignoreDuplicates: true });
      if (relErr) console.error('[CONTACTS_IMPORT_WORKS_AT_UPDATE]', relErr.message);
    }

    // Apply the imported lifecycle to the resolved record: write a pipeline_stage
    // observation so get_context + analytics reflect it (and the timestamp marks when
    // they entered as client/prospect, for funnel→client conversion reporting). Won
    // rows run the full client path — company + people convert, intent flips to the
    // client axis. Only rows that carried a recognizable stage are touched.
    const applyImportedStage = async (contactId, companyId, r) => {
      const st = resolveRowStage(r);
      if (!contactId || !st) return;
      if (st.stage === 'closed_won') {
        await markContactClient(supabase, workspaceId, contactId, companyId || null).catch(e => console.warn('[IMPORT_CLIENT]', e.message));
      } else {
        await supabase.from('observations').insert({
          workspace_id: workspaceId, entity_id: contactId, kind: 'state',
          property: 'pipeline_stage', value: st.stage, source: 'import', method: 'csv_import',
          observed_at: new Date().toISOString(),
        }).then(({ error }) => { if (error && error.code !== '23505') console.warn('[IMPORT_STAGE]', error.message); });
      }
    };
    for (let i = 0; i < newContactIds.length; i++) {
      await applyImportedStage(newContactIds[i], companyIdByKey.get(companyKeyOf(toCreate[i])), toCreate[i]);
    }
    for (const r of toUpdateEmail) await applyImportedStage(emailToId.get(r.email.toLowerCase().trim()), companyIdByKey.get(companyKeyOf(r)), r);
    for (const r of toUpdateLinkedin) await applyImportedStage(liToId.get(r.linkedin_url.trim()), companyIdByKey.get(companyKeyOf(r)), r);

    // ENQUEUE history enrichment for all imported contacts (new + updated). The heavy
    // backfill runs in the WORKER (drains contact_enrichment_jobs), not here — see
    // apps/worker/src/workers/contactEnrichmentJobs.mjs. The API just records the job
    // and returns; the modal polls /enrich-progress/:jobId, which reads the row.
    //
    // We pass the full contact PAYLOAD (email + name + linkedin), not just ids. A
    // freshly imported person is a cold lead that isn't in the `contacts` view yet, so
    // the worker can't reload it by id — but we hold its email/name right here, so we
    // hand them over and the backfill scans off that.
    const rowToContact = (id, r) => ({
      id,
      email:       r.email ? r.email.toLowerCase().trim() : null,
      first_name:  r.first_name?.trim() || null,
      last_name:   r.last_name?.trim() || null,
      company:     r.company?.trim() || null,
      company_id:  companyIdByKey.get(companyKeyOf(r)) || null,
      linkedin_url: r.linkedin_url?.trim() || null,
    });
    const contactsPayload = [];
    for (let i = 0; i < newContactIds.length; i++) contactsPayload.push(rowToContact(newContactIds[i], toCreate[i]));
    for (const r of toUpdateEmail) { const id = emailToId.get(r.email.toLowerCase().trim()); if (id) contactsPayload.push(rowToContact(id, r)); }
    for (const r of toUpdateLinkedin) { const id = liToId.get(r.linkedin_url.trim()); if (id) contactsPayload.push(rowToContact(id, r)); }

    let jobId = null;
    if (contactsPayload.length) {
      jobId = randomUUID();
      const { error: enqErr } = await supabase.from('contact_enrichment_jobs').insert({
        job_id:       jobId,
        workspace_id: workspaceId,
        contact_ids:  contactsPayload.map(c => c.id),
        contacts:     contactsPayload,
        status:       'pending',
      });
      if (enqErr) {
        // Table not migrated yet, or a write hiccup — don't fail the import over the
        // backfill. The contacts are in; enrichment just won't run until it's fixed.
        console.error('[CONTACTS_IMPORT_ENQUEUE]', enqErr.message);
        jobId = null;
      }
    }

    return res.json({ created, updated, skipped: rows.length - validRows.length, jobId });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts/:id/enrich
// Gated by the plan's monthly enrichment allowance (its own metered unit —
// not ops). requireEnrichmentQuota 402s when the allowance is exhausted.
contactsApiRouter.post('/:id/enrich', verifySupabaseAuth, requireEnrichmentQuota, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data: contact } = await supabase.from('contacts').select('*').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'contact_not_found' });
    // Need at least one usable identity key: email, LinkedIn URL, or name+domain.
    const hasUsableKey = Boolean(
      contact.email || contact.linkedin_url ||
      (contact.first_name && contact.last_name && contact.domain),
    );
    if (!hasUsableKey) {
      return res.status(422).json({ error: 'contact_has_no_email_or_linkedin' });
    }

    await enrichContact(supabase, contact);

    // Enrichment writes its results as observations (tagged with the true
    // provider source), which a background worker normally materializes into
    // claims — so company/domain/title would only surface on the list once the
    // worker catches up (the "takes two refreshes to appear" lag). Recompute the
    // enriched display claims synchronously here so the fresh values are live the
    // instant this request returns. Properties with no observation are no-ops.
    try {
      await Promise.all(
        ENRICHMENT_ATTRIBUTES.map((prop) =>
          recomputeClaim(supabase, contact.workspace_id, contact.id, prop)),
      );
    } catch (e) {
      console.warn('[POST /api/contacts/:id/enrich] claim recompute failed:', e.message);
    }

    // Re-fetch updated contact so the frontend gets live enrichment_status + new fields
    const { data: updated } = await supabase.from('contacts').select('*').eq('id', id).single();
    const enriched = updated?.enrichment_status === 'complete';

    // A successful enrichment writes an `enrichment_run` row to the live op
    // log — billable_ops=0, because enrichment has its own metered allowance
    // (counted by getTeamEnrichmentUsage), it is NOT billed as an op.
    if (enriched) {
      try {
        await supabase.from('workspace_system_log').insert({
          workspace_id: updated?.workspace_id || contact.workspace_id,
          source:       'enrichment',
          event_type:   'enrichment_run',
          summary:      `Enriched ${updated?.first_name || updated?.email || 'contact'}`,
          contact_id:   id,
          metadata:     { provider: updated?.enrichment_provider || null },
          billable_ops: 0,
          occurred_at:  new Date().toISOString(),
        });
      } catch (e) {
        console.warn('[POST /api/contacts/:id/enrich] op-log insert failed:', e.message);
      }
    }

    return res.json({ contact: updated || contact, enriched });
  } catch (err) {
    console.error('[POST /api/contacts/:id/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// (enrich-progress route is registered above /:id to prevent Express route shadowing)

// GET /api/companies/list
contactsApiRouter.get('/companies/list', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: companies } = await supabase.from('companies').select('id, name, domain, industry, employee_count, location, revenue_range, enrichment_status, deal_health_score').eq('workspace_id', workspaceId).order('name');

    // Board card metrics. Company-level activity lives on the company's CONTACTS, so
    // we roll it up here: activity_count = sum of each contact's interaction_count;
    // meeting_count = workspace's meeting_held events mapped to the contact's company.
    // All reads — no schema change.
    const { data: coContacts } = await supabase.from('contacts')
      .select('id, company_id, interaction_count')
      .eq('workspace_id', workspaceId);
    const activityByCompany = new Map();
    const contactToCompany = new Map();
    for (const c of coContacts ?? []) {
      if (!c.company_id) continue;
      contactToCompany.set(c.id, c.company_id);
      activityByCompany.set(c.company_id, (activityByCompany.get(c.company_id) ?? 0) + (c.interaction_count ?? 0));
    }
    const meetingByCompany = new Map();
    const { data: meetings } = await supabase.from('observations')
      .select('entity_id')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'event')
      .eq('property', 'interaction.meeting_held');
    for (const m of meetings ?? []) {
      const co = contactToCompany.get(m.entity_id);
      if (co) meetingByCompany.set(co, (meetingByCompany.get(co) ?? 0) + 1);
    }

    const enriched = (companies || []).map((co) => ({
      ...co,
      activity_count: activityByCompany.get(co.id) ?? 0,
      meeting_count: meetingByCompany.get(co.id) ?? 0,
    }));
    return res.json({ companies: enriched });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
