import { Router } from 'express';
import { getSupabaseClient, redactObservationRowsForViewer, filterDerivedForViewer } from '@nous/core';
import { requestMessageViewer } from '../../lib/messagePrivacy.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam, workspaceInTeam } from '../../lib/auth.mjs';

export const observationsLogRouter = Router();

// Internal bookkeeping properties — how the engine keeps house (enrichment
// plumbing, raw provider blobs, summary/identity timestamps), NOT facts a human
// "learned about the account." Hidden so the stream reads as knowledge, not
// machinery. The op log on the Overview keeps the mechanical view.
const HIDDEN_PROPS = [
  'apollo_raw', 'positions', 'memory_summary', 'source',
  'enrichment_status', 'enrichment_source', 'enriched_at',
  'summary_generated_at', 'identity_status', 'deal_health_computed_at',
  'interaction.enrichment_run', // a raw enrichment JSON dump
];

// Firmographic / contact-card fields that enrichment providers (prospeo, apollo,
// findymail…) dump in bulk the moment a contact is created — a phone, a job title,
// a city, a LinkedIn URL. They populate the profile card, but they are scaffolding,
// not "what Nous learned about the deal," and at volume they bury the real intel.
// Kept out of this stream (they still live on the contact/company record).
const ENRICHMENT_PROPS = [
  'phone', 'mobile', 'email', 'work_email', 'personal_email',
  'job_title', 'title', 'seniority', 'department', 'role', 'headline',
  'country', 'city', 'state', 'region', 'location', 'timezone', 'address',
  'linkedin_url', 'twitter_url', 'facebook_url', 'github_url', 'website', 'personal_website', 'company_website',
  'company', 'company_name', 'company_domain', 'company_size',
  'industry', 'employee_count', 'revenue', 'founded', 'photo_url', 'avatar', 'logo_url',
];

// Identity + mechanical-derivation fields: an entity's own name, and the pipeline
// stage the engine derives from activity. These are how Nous keeps its records
// wired together, not something it "learned about the deal." Out of the stream.
const MECHANICAL_PROPS = [
  'first_name', 'last_name', 'full_name', 'name', 'display_name',
  'pipeline_stage', 'stage', 'lifecycle', 'lifecycle_stage',
];
const ALL_HIDDEN_PROPS = [...HIDDEN_PROPS, ...ENRICHMENT_PROPS, ...MECHANICAL_PROPS];

// Sources whose rows are always machinery, whatever the property: bulk contact-card
// enrichment (prospeo, apollo…), name/entity mentions, and stage derivations. A
// source-level catch-all so scaffolding we didn't name by property still stays out.
const NOISE_SOURCES = new Set([
  'prospeo', 'apollo', 'findymail', 'leadmagic', 'clay', 'rb2b', 'enrichment',
  'mention', 'stage_derivation', 'identity', 'identity_resolution',
]);
const NOISE_METHODS = new Set(['enrichment', 'mention', 'stage_derivation']);
const isNoiseRow = (r) =>
  NOISE_SOURCES.has(String(r.source || '').toLowerCase()) || NOISE_METHODS.has(String(r.method || '').toLowerCase());

// The derived-intel layer we fold in from the CLAIMS table: what Nous CONCLUDED
// from raw data (a pain point from a meeting, an intent read, a deal-health call),
// not a raw field. These are entity-scoped, carry confidence + freshness, and are
// deduped out of the raw observation rows so we don't show intent twice. Action
// items and raw note transcripts are deliberately excluded — action items are
// tasks with their own home, notes are the raw source, not a learned fact.
const INTEL_ROOTS = new Set([
  'intent_band', 'intent_score', 'deal_health_score',
  'pain', 'signal', 'buying_signal', 'objection', 'competitor',
  'risk', 'stance', 'need', 'budget', 'timeline', 'authority',
]);
// PostgREST `or` filter (wildcard is `*`). Exact for the scalar reads, prefix for
// the namespaced ones (pain.<id>, signal.<id>, …).
const INTEL_OR = [
  // intent_score is intentionally NOT fetched — the band ("Warm") is the human read;
  // the raw 0-100 score is a duplicate machine number. It stays in INTEL_ROOTS so any
  // raw intent_score observation is still deduped out of the stream.
  'property.eq.intent_band', 'property.eq.deal_health_score',
  // The extracted-fact layer — every pain/objection/competitor/buying-signal/goal
  // the meeting + message extractors mined. This is the substance of the feed.
  'property.like.note.*',
  'property.like.pain*', 'property.like.signal*', 'property.like.buying_signal*',
  'property.like.objection*', 'property.like.competitor*', 'property.like.risk*',
  'property.like.stance*', 'property.like.need*', 'property.like.budget*',
  'property.like.timeline*', 'property.like.authority*',
].join(',');
const INTEL_LABEL = { intent_band: 'intent', intent_score: 'intent score', deal_health_score: 'deal health', buying_signal: 'signal' };
const rootOf = (property) => String(property || '').split('.')[0];
const intelLabel = (property) => { const r = rootOf(property); return INTEL_LABEL[r] || r.replace(/_/g, ' '); };

// The heart of the feed: the extracted meeting/message facts. The signal extractor
// (worker/signals) saves every pain, objection, competitor, buying signal, goal,
// etc. as a `note.<uuid>` claim with the real category INSIDE value.category — so
// filtering by `property.like.pain*` never caught them. We fold the whole note.*
// layer in and read the category from the value, mapping it to a short display type.
const CATEGORY_LABEL = {
  status_quo: 'stack', goal: 'goal', pain: 'pain', objection: 'objection',
  authority: 'authority', budget: 'budget', timeline: 'timeline',
  buying_signal: 'buying signal', preference: 'preference', competitor: 'competitor',
  discovery: 'discovery', relationship: 'connection', general: 'note',
};

// Collapse a claim value to a short human string — a pain/objection may be a
// {title|text|summary} object; an intent/deal-health value is a scalar.
function shortLabel(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const t = v.title || v.text || v.summary || v.label || v.name || v.detail;
    if (t) return String(t);
    try { const s = JSON.stringify(v); return s.length > 180 ? s.slice(0, 180) + '…' : s; } catch { return ''; }
  }
  return String(v);
}

// GET /api/workspace/observations
// The human-readable "what did Nous learn" stream for the Activity page: raw
// observation facts (entity · property · value · confidence · source) AND the
// derived intel claims (pains, signals, intent, deal health), one time-ordered
// feed, entity names resolved. Workspace-private with the same team guard as the
// op log; optional ?mine=1 owner scope.
observationsLogRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspace_id, days = '30', limit = '200', mine } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id_required' });

    // Workspace-private. Never serve a workspace the caller's team does not own.
    const { team } = await ensureUserAndTeam(req.user);
    if (!(await workspaceInTeam(supabase, workspace_id, team?.id))) {
      return res.status(403).json({ error: 'workspace_forbidden' });
    }

    const since = days === 'all' ? null : new Date(Date.now() - parseInt(days) * 86400000).toISOString();
    const cap = Math.min(parseInt(limit) || 200, 500);
    const scoped = mine === '1' && req.memberUserId;

    // Personal ("mine") scope: the member's owned entities. Observations carry an
    // owner directly; claims are entity-level, so we scope them by the entities the
    // member owns. Backfilled data has no owner, so the API-plan panel calls this
    // WITHOUT `mine` to show the whole workspace.
    let ownedEntityIds = null;
    if (scoped) {
      const { data: owned } = await supabase.from('observations')
        .select('entity_id').eq('workspace_id', workspace_id).eq('owner_user_id', req.memberUserId).limit(5000);
      ownedEntityIds = [...new Set((owned || []).map((o) => o.entity_id).filter(Boolean))];
    }

    // ── Raw observation facts ──
    let obsQ = supabase.from('observations')
      .select('id, entity_id, property, value, source, method, source_confidence, observed_at, owner_user_id')
      .eq('workspace_id', workspace_id)
      .not('property', 'in', `(${ALL_HIDDEN_PROPS.map((p) => `"${p}"`).join(',')})`)
      .order('observed_at', { ascending: false })
      .limit(cap);
    if (since) obsQ = obsQ.gte('observed_at', since);
    if (scoped) obsQ = obsQ.eq('owner_user_id', req.memberUserId);

    // ── Derived intel + extracted-fact claims ── (active only: invalid_at IS NULL,
    // so a superseded pain/objection doesn't linger in the stream). Order + window
    // on valid_from: extracted note.* facts don't set last_observed_at, so keying
    // off it would silently drop every meeting-mined pain/objection from the feed.
    let claimQ = supabase.from('claims')
      .select('id, entity_id, property, value, confidence, freshness, epistemic_class, last_observed_at, valid_from, supporting_observation_ids')
      .eq('workspace_id', workspace_id)
      .is('invalid_at', null)
      .or(INTEL_OR)
      .order('valid_from', { ascending: false })
      .limit(cap);
    if (since) claimQ = claimQ.gte('valid_from', since);
    if (scoped) claimQ = ownedEntityIds && ownedEntityIds.length ? claimQ.in('entity_id', ownedEntityIds) : null;

    const [{ data: obsData, error: obsErr }, claimRes] = await Promise.all([
      obsQ,
      claimQ ? claimQ : Promise.resolve({ data: [], error: null }),
    ]);
    if (obsErr) throw obsErr;
    if (claimRes.error) throw claimRes.error;

    // A message's content only for the people who were on it (GET-244). This feed showed every
    // teammate's email snippet to anyone on the team.
    const viewer = await requestMessageViewer(supabase, req, workspace_id);
    // What was read out of a message (an action item, a fact) is shared; its quote follows the message (GET-985).
    const visibleObs = await filterDerivedForViewer(supabase, workspace_id,
      await redactObservationRowsForViewer(supabase, workspace_id, obsData || [], viewer), viewer);
    const visibleClaims = await filterDerivedForViewer(supabase, workspace_id, claimRes.data || [], viewer);

    // Raw observations, minus any intel root (those come from the reconciled claim
    // layer instead, so intent/deal-health aren't shown twice) and minus any
    // enrichment-sourced scaffolding that slipped past the property filter.
    const obsRows = visibleObs
      .filter((r) => !INTEL_ROOTS.has(rootOf(r.property)) && !isNoiseRow(r))
      .map((r) => ({
        id: r.id,
        kind: 'observation',
        observed_at: r.observed_at,
        entity_id: r.entity_id,
        property: r.property,
        value: r.value,
        source: r.source,
        method: r.method,
        source_confidence: r.source_confidence,
        freshness: null,
      }));

    const claimRows = visibleClaims.map((c) => {
      const conf = typeof c.confidence === 'number' ? c.confidence : null;
      const observedAt = c.last_observed_at || c.valid_from;
      // An extracted fact (note.<uuid>): the category lives inside the value, and
      // the value.content sentence IS the fact — "Clay's list-building is bottlenecked
      // by manual work." That sentence is what we show.
      if (String(c.property || '').startsWith('note.')) {
        const v = c.value || {};
        const cat = String(v.category || 'general').toLowerCase();
        return {
          id: `claim:${c.id}`,
          kind: 'claim',
          observed_at: observedAt,
          entity_id: c.entity_id,
          property: CATEGORY_LABEL[cat] || cat.replace(/_/g, ' '),
          value: shortLabel(v.content ?? v),
          source: c.epistemic_class || 'nous',
          method: 'derived',
          source_confidence: conf,
          freshness: c.freshness || null,
        };
      }
      // A reconciled scalar intel claim (intent_band, deal_health_score).
      return {
        id: `claim:${c.id}`,
        kind: 'claim',
        observed_at: observedAt,
        entity_id: c.entity_id,
        property: intelLabel(c.property),
        value: shortLabel(c.value),
        source: c.epistemic_class || 'nous',
        method: 'derived',
        source_confidence: conf,
        freshness: c.freshness || null,
      };
    });

    // Merge into one time-ordered feed.
    const merged = [...obsRows, ...claimRows]
      .filter((r) => r.observed_at)
      .sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))
      .slice(0, cap);

    // Resolve entity_id → a human name AND a kind (person/company), so the feed can link
    // each row straight to its account (/people/:id) or company (/accounts/:id).
    const entityIds = [...new Set(merged.map((r) => r.entity_id).filter(Boolean))];
    const nameById = new Map();
    const kindById = new Map();
    if (entityIds.length) {
      const [{ data: cs }, { data: cos }] = await Promise.all([
        supabase.from('contacts').select('id, first_name, last_name, company').in('id', entityIds),
        supabase.from('companies').select('id, name').in('id', entityIds),
      ]);
      for (const c of cs ?? []) { nameById.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company || null); kindById.set(c.id, 'person'); }
      for (const c of cos ?? []) if (!nameById.has(c.id)) { nameById.set(c.id, c.name); kindById.set(c.id, 'company'); }
    }

    // Keep entity_id + kind on each row (the click-through target).
    const observations = merged.map((r) => ({ ...r, entity_name: nameById.get(r.entity_id) ?? null, entity_kind: kindById.get(r.entity_id) ?? null }));
    return res.json({ observations });
  } catch (err) {
    console.error('[GET /api/workspace/observations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
