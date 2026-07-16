import { Router } from 'express';
import {
  getSupabaseClient,
  getOrCreateEntity,
  attachIdentifiers,
  resolveFocus,
  assertClaims,
  fetchEntityOverlays,
  applyContactOverlay,
  normaliseLinkedInUrl,
} from '@nous/core';

// LinkedIn URL variants (with/without trailing slash, with/without www) so
// the linkedin_url= exact filter matches historical rows that were stored raw
// before normaliseIdentifier started normalising on write.
function linkedInVariants(url) {
  const out = new Set();
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return [];
  const canonical = normaliseLinkedInUrl(trimmed);
  if (canonical) {
    const noWww = canonical.replace('https://www.', 'https://');
    for (const base of [canonical, noWww]) { out.add(base); out.add(base + '/'); }
  }
  out.add(trimmed);
  out.add(trimmed.toLowerCase());
  return Array.from(out);
}

export const peopleV2Router = Router();

// ─── /v2/people — the deterministic surface for People (humans) ─────────────
// REST shape that workflow runtimes (n8n, Make, custom backends) call when
// they already know the parameters. Agents reading context should still use
// /v2/context or /v2/accounts/:id (intent-shaped, epistemics-tagged).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 1000;

// The only query params GET /v2/people honours. Anything else is rejected
// rather than silently ignored — a filter the API doesn't support must fail
// loudly, or a workflow believes it filtered when it didn't (e.g. icp_fit and
// sort=icp_score used to be dropped silently, returning the full unfiltered set).
const ALLOWED_PARAMS = new Set([
  'search', 'pipeline_stage', 'source', 'status',
  'has_email', 'has_linkedin', 'linkedin_url', 'email',
  'icp_fit', 'min_icp_score',
  'last_activity_before', 'last_activity_after',
  'sort', 'limit', 'offset', 'page',
]);

// Whitelisted sort keys → (column, direction). Unknown sort values 400 rather
// than silently falling back to the default order.
const SORTS = {
  last_activity:     { col: 'last_activity_at', ascending: false },
  last_activity_asc: { col: 'last_activity_at', ascending: true  },
  icp_score:         { col: 'icp_score',        ascending: false },
  icp_score_asc:     { col: 'icp_score',        ascending: true  },
  recently_added:    { col: 'first_seen_at',    ascending: false },
};

// Properties that live in entity_identifiers, not in claims. Splitting these
// out keeps the PATCH/POST surface unsurprising — `email` works.
const IDENTIFIER_KIND_BY_FIELD = {
  email:              'email',
  linkedin_url:       'linkedin_url',
  linkedin_member_id: 'linkedin_member_id',
  hubspot_id:         'hubspot',
  pipedrive_id:       'pipedrive',
  apollo_id:          'apollo',
  attio_id:           'attio',
};

function parseDuration(input) {
  // '2d' | '7d' | '30d' | '6h' | '90m' → ms; null when unparseable.
  if (input == null) return null;
  const m = String(input).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * ms;
}

function splitBody(body) {
  // identifiers → entity_identifiers via attachIdentifiers
  // everything else → claims via assertClaims
  const identifiers = [];
  const claimValues = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k in IDENTIFIER_KIND_BY_FIELD) {
      if (v) identifiers.push({ kind: IDENTIFIER_KIND_BY_FIELD[k], value: String(v) });
    } else {
      claimValues[k] = v;
    }
  }
  return { identifiers, claimValues };
}

async function projectPerson(supabase, entityId) {
  // Reuse the same overlay the contacts view + /v2/accounts use, so n8n and
  // the agent see the same person.
  const overlays = await fetchEntityOverlays(supabase, [entityId]);
  const row = applyContactOverlay({ id: entityId }, overlays.get(entityId));
  return { entity_id: entityId, ...row };
}

// ─── GET /v2/people/coverage — attribute coverage estimate ──────────────────
// "How many <agency founders> do we already have, and how fresh?" — the planning
// question you ask BEFORE building a list elsewhere, without pasting identifiers.
// Buckets matching people by enrichment freshness so you know how much is already
// covered vs needs (re-)enrichment vs needs acquiring.
//   ?title=founder  ?keyword=agency  ?stale_days=90  ?limit=25
peopleV2Router.get('/coverage', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });
    const { title, keyword, stale_days, limit } = req.query;
    const { data, error } = await supabase.rpc('people_coverage', {
      p_workspace: workspaceId,
      p_title: (typeof title === 'string' && title.trim()) || null,
      p_keyword: (typeof keyword === 'string' && keyword.trim()) || null,
      p_stale_days: stale_days ? Math.max(1, parseInt(stale_days, 10) || 90) : 90,
      p_limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 25)) : 25,
    });
    if (error) throw error;
    return res.json(data || { total: 0, never_enriched: 0, stale: 0, fresh_verified: 0, needs_enrichment: 0, sample: [] });
  } catch (err) {
    console.error('[GET /v2/people/coverage]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET /v2/people — filtered list ─────────────────────────────────────────
// Reads the `contacts` view (v2-substrate-backed) for stability. Filters map
// directly to columns the view exposes; n8n discovers them via the docs.
peopleV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const {
      search,
      pipeline_stage,
      source,
      status,
      has_email,
      has_linkedin,
      linkedin_url,
      email,
      icp_fit,
      min_icp_score,
      last_activity_before,
      last_activity_after,
      sort,
      limit,
      offset,
      page,
    } = req.query;

    // Fail loudly on unsupported params instead of returning an unfiltered set.
    const unknown = Object.keys(req.query).filter(k => !ALLOWED_PARAMS.has(k));
    if (unknown.length) {
      return res.status(400).json({
        error: 'unknown_query_param',
        detail: `unsupported query param(s): ${unknown.join(', ')}`,
        supported: Array.from(ALLOWED_PARAMS),
      });
    }

    let q = supabase.from('contacts').select('*').eq('workspace_id', workspaceId);
    if (pipeline_stage) q = q.eq('pipeline_stage', pipeline_stage);
    if (status)         q = q.eq('status', status);
    if (source)         q = q.eq('source', source);
    if (has_email === 'true')     q = q.not('email', 'is', null);
    if (has_email === 'false')    q = q.is('email', null);
    if (has_linkedin === 'true')  q = q.not('linkedin_url', 'is', null);
    if (has_linkedin === 'false') q = q.is('linkedin_url', null);
    if (icp_fit === 'true')  q = q.eq('icp_fit', true);
    if (icp_fit === 'false') q = q.eq('icp_fit', false);
    if (min_icp_score != null && String(min_icp_score).trim() !== '') {
      const n = parseInt(min_icp_score, 10);
      if (!Number.isNaN(n)) q = q.gte('icp_score', n);
    }

    // Exact-match lookups by identifier — the shape workflow runtimes use
    // when they already have the value. linkedin_url= tries variant forms
    // (with/without trailing slash, with/without www) so old rows match too.
    if (email) q = q.eq('email', String(email).toLowerCase().trim());
    if (linkedin_url) q = q.in('linkedin_url', linkedInVariants(linkedin_url));

    const beforeMs = parseDuration(last_activity_before);
    if (beforeMs != null) {
      const cutoff = new Date(Date.now() - beforeMs).toISOString();
      // "gone quiet for N" — either never had activity, or last activity is before cutoff.
      q = q.or(`last_activity_at.is.null,last_activity_at.lt.${cutoff}`);
    }
    const afterMs = parseDuration(last_activity_after);
    if (afterMs != null) {
      const cutoff = new Date(Date.now() - afterMs).toISOString();
      q = q.gte('last_activity_at', cutoff);
    }

    if (search && String(search).trim()) {
      const t = `%${String(search).trim()}%`;
      q = q.or(`email.ilike.${t},first_name.ilike.${t},last_name.ilike.${t},company.ilike.${t},linkedin_url.ilike.${t}`);
    }

    const sortKey = sort != null && String(sort).trim() !== '' ? String(sort) : 'last_activity';
    const sortSpec = SORTS[sortKey];
    if (!sortSpec) {
      return res.status(400).json({
        error: 'unknown_sort',
        detail: `unsupported sort '${sortKey}'`,
        supported: Object.keys(SORTS),
      });
    }
    q = q.order(sortSpec.col, { ascending: sortSpec.ascending, nullsFirst: false });

    const lim = Math.min(parseInt(limit, 10) || 100, MAX_LIMIT);
    // offset wins if given; otherwise derive it from the documented `page` (1-based).
    let off = parseInt(offset, 10) || 0;
    if ((offset == null || String(offset).trim() === '') && page != null) {
      const p = parseInt(page, 10);
      if (!Number.isNaN(p) && p > 0) off = (p - 1) * lim;
    }
    // Fetch one extra row to compute has_more without a second count query.
    q = q.range(off, off + lim);

    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    const has_more = rows.length > lim;
    const people = has_more ? rows.slice(0, lim) : rows;
    return res.json({ people, limit: lim, offset: off, has_more });
  } catch (err) {
    console.error('[GET /v2/people]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /v2/people — create or upsert by identifier ────────────────────────
// Body: { email?, linkedin_url?, ... + any claim properties }
// If an entity with one of the identifiers already exists, returns it and
// asserts any new claim values onto it (safe to call from a form intake hook
// that fires repeatedly).
peopleV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { identifiers, claimValues } = splitBody(req.body);

    if (identifiers.length === 0) {
      return res.status(400).json({
        error: 'identifier_required',
        detail: 'pass at least one of: email, linkedin_url, linkedin_member_id, hubspot_id, pipedrive_id, apollo_id, attio_id',
      });
    }

    const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', identifiers);
    if (Object.keys(claimValues).length > 0) {
      await assertClaims(supabase, workspaceId, entityId, { values: claimValues });
    }
    const person = await projectPerson(supabase, entityId);
    return res.status(201).json({ person });
  } catch (err) {
    console.error('[POST /v2/people]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── PATCH /v2/people/:id — assert claim values + attach identifiers ─────────
// `:id` may be an entity UUID, email, domain, or LinkedIn URL. Asserted claims
// are sticky — derivation from observations will not overwrite them.
peopleV2Router.patch('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status === 'not_found')  return res.status(404).json({ error: 'entity_not_found' });
    if (resolution.status === 'ambiguous')  return res.json({ status: 'ambiguous', candidates: resolution.candidates });

    const entityId = resolution.entity_id;
    const { identifiers, claimValues } = splitBody(req.body);

    if (identifiers.length > 0) {
      await attachIdentifiers(supabase, workspaceId, entityId, identifiers);
    }
    let writtenCount = 0;
    if (Object.keys(claimValues).length > 0) {
      const result = await assertClaims(supabase, workspaceId, entityId, { values: claimValues });
      writtenCount = result.written.length + result.invalidated.length;
    }

    const person = await projectPerson(supabase, entityId);
    return res.json({ person, claims_written: writtenCount });
  } catch (err) {
    console.error('[PATCH /v2/people/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
