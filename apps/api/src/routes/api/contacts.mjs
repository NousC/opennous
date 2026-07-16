import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getSupabaseClient, listNotes, saveNote, logActivity, collapseMeetingDupes, assertClaims, upsertIdentifier, scoreTier, normalizeClaimCategory, normalizeClaimAbout, recomputeClaim, ENRICHMENT_ATTRIBUTES, getInternalEntityIds, isInTouchWith, getRelationshipOwners, getWorkspaceMemberNames } from '@nous/core';
import { fetchIcpByEntity, fetchIntentByEntity } from '../../lib/icpFit.mjs';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { requireEnrichmentQuota } from '../../lib/access.mjs';
import { enrichContact } from '../../services/enrichment.mjs';
import { enrichContactHistory, enrichmentJobs } from '../../services/contactHistoryEnricher.mjs';

export const contactsApiRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

// GET /api/contacts
contactsApiRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, search, limit = 50, offset = 0, filter, source, sort, status, include_team } = req.query;
    const includeTeam = include_team === '1' || include_team === 'true';
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id_required' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    // verifySupabaseAuth already validated workspace membership (cached for
    // 60s) — the redundant ensureUserAndTeam + workspace_members check that
    // used to live here added ~50-100ms of DB roundtrips for no extra safety.
    // `req.workspaceId` is set by the middleware iff membership passed.
    if (req.workspaceId !== workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    // No `count: 'exact'` — it triggers a separate COUNT query that can take
    // longer than the data fetch itself on large tables. Nobody reads .total
    // from this endpoint's response in the current frontend.
    let query = supabase.from('contacts').select('*').eq('workspace_id', workspaceId);
    if (filter && filter !== 'all') query = query.eq('pipeline_stage', filter);
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (search?.trim()) {
      const t = `%${search.trim()}%`;
      query = query.or(`email.ilike.${t},first_name.ilike.${t},last_name.ilike.${t},company.ilike.${t}`);
    }
    query = sort === 'interactions_asc'
      ? query.order('last_activity_at', { ascending: true, nullsFirst: false })
      : query.order('last_activity_at', { ascending: false, nullsFirst: false });
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

    // Team members (co-founders / colleagues flagged is_internal) are not leads.
    // We tag every row so the UI can badge them, and hide them from the default
    // Accounts view — they're one toggle away via ?include_team=1. Filtering
    // after the fetch keeps the query simple; internal records are a handful.
    const internal = await getInternalEntityIds(supabase, workspaceId);
    if (!includeTeam && internal.size) rows = rows.filter(c => !internal.has(c.id));

    const ids = rows.map(c => c.id);
    const icpMap = await fetchIcpByEntity(supabase, workspaceId, ids);
    const intentMap = await fetchIntentByEntity(supabase, workspaceId, ids);

    // Who on the team is actually on this account. `primary` is whoever touched it
    // most recently — the rep currently carrying it — and `members` is everyone
    // in touch, which is what makes "you and Jordan are both on this" visible
    // instead of a surprise. Powers the Owner filter.
    const ownerMap = await getRelationshipOwners(supabase, workspaceId, ids);
    const memberNames = await getWorkspaceMemberNames(supabase, workspaceId);

    const contacts = rows.map(c => {
      const ov = icpMap.get(c.id);
      const iv = intentMap.get(c.id);
      const rel = ownerMap.get(c.id);
      // Intent overlay (reach-out-now axis) — defaults Dormant/0 until staked.
      return {
        ...c,
        is_internal: internal.has(c.id),
        owner_user_id: rel?.primary ?? null,
        owner_name: rel?.primary ? (memberNames.get(rel.primary) ?? null) : null,
        owner_members: (rel?.members ?? []).map(m => ({
          user_id: m.user_id,
          name: memberNames.get(m.user_id) ?? m.label ?? null,
        })),
        ...(ov ? { icp_score: ov.score, icp_tier: ov.tier } : {}),
        intent_score: iv?.score ?? 0,
        intent_band: iv?.band ?? 'Dormant',
      };
    });

    return res.json({ contacts, limit: lim, offset: off });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// GET /api/contacts/enrich-progress/:jobId — must be before /:id so Express doesn't swallow it
contactsApiRouter.get('/enrich-progress/:jobId', verifySupabaseAuth, (req, res) => {
  const job = enrichmentJobs.get(req.params.jobId);
  if (!job) return res.json({ found: false });
  return res.json({ found: true, contacts: job.contacts, done: job.done });
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
    const [fcRes, resolvedRes, obsRes, sharedAccount, companyRes, memories, sigRes, predRowRes] = await Promise.all([
      supabase.from('claims').select('value').eq('entity_id', id).eq('property', 'fields').is('invalid_at', null).maybeSingle(),
      supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('workspace_id', contact.workspace_id).eq('kind', 'icp_fit').not('resolved_at', 'is', null),
      supabase.from('observations').select('id, property, value, source, observed_at, raw, entity_id, owner_user_id').eq('entity_id', id).eq('kind', 'event').order('observed_at', { ascending: false }).limit(200),
      isInTouchWith(supabase, workspaceId, id, viewerUserId),
      contact.company_id
        ? supabase.from('companies').select('name, domain, industry, employee_count, tech_stack, location, revenue_range').eq('id', contact.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      listNotes(supabase, contact.workspace_id, { entityId: id, limit: 30 }),
      supabase.from('claims').select('entity_id, property, value, confidence, computed_at').in('entity_id', sigEntityIds).like('property', 'signal.%').is('invalid_at', null).order('computed_at', { ascending: false }),
      supabase.from('predictions').select('predicted_value, predicted_at, model_version, fired_signals').eq('entity_id', id).eq('kind', 'icp_fit').order('predicted_at', { ascending: false }).limit(1).maybeSingle(),
    ]);

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

    // Per-member privacy (PRIVACY_MODEL.md). Two rules, in order:
    //
    //   1. If you are IN TOUCH with this account — you have messaged or emailed
    //      them yourself, so you're in its relationship_owner.members — the whole
    //      conversation is yours to read, including a teammate's half of it. This
    //      is a shared relationship, and a rep who sees only their own half of a
    //      thread is worse off than one who sees none of it.
    //   2. Otherwise, raw email / LinkedIn CONTENT is private to the rep who owns
    //      it. Ownership-based, NOT role-based: even the founder does not read a
    //      teammate's conversations on an account they've never touched. The row
    //      and its header still show WHAT happened and WHEN — only the body goes.
    //
    // Meetings, calls, facts, signals and notes are never redacted either way.
    // viewerUserId / workspaceId / sharedAccount were resolved in the batch above.
    const ownsRaw = (o) => o.owner_user_id == null || o.owner_user_id === viewerUserId;
    const isRedactable = (type) => type.startsWith('email_') || LINKEDIN_MSG_TYPES.has(type);
    // No viewer id (a system/service caller) → don't redact.
    const shouldRedact = (o) =>
      !!viewerUserId && !sharedAccount && !ownsRaw(o)
      && isRedactable((o.property || '').replace(/^interaction\./, ''));
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
          const header = type.startsWith('email_')
            ? `Email ${dir}${o.raw?.subject ? `: ${o.raw.subject}` : ''}`
            : `LinkedIn message ${dir}`;
          return {
            id:            o.id,
            activity_type: type,
            title:         header,
            subtitle:      null,          // body redacted
            redacted:      true,          // frontend shows a subtle "private" hint
            source:        o.source || 'nous',
            created_at:    o.observed_at,
            raw_data:      null,          // strip body_text/body_html/message text
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

    return res.json({ contact, activities, company, memories, signals, prediction });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});

// POST /api/contacts
contactsApiRouter.post('/', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId, email, firstName, lastName, phone, company, jobTitle, notes, tags, source, industry, lead_source, company_size, keywords } = req.body;
    const { user } = await ensureUserAndTeam(req.user);

    if (!workspaceId || !email) return res.status(400).json({ error: 'workspace_id_and_email_required' });
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'invalid_email_format' });
    if (!UUID.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace_id' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', workspaceId).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });

    // Auto-resolve company_id
    let companyId = null;
    if (company?.trim()) {
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

    const { email, firstName, lastName, phone, company, jobTitle, linkedinUrl, notes, tags, industry, deal_value, dealValue, deal_closed_at, lead_source, company_size, keywords, status, dealStage, deal_stage, pipeline_stage } = req.body;
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
    const dv = dealValue !== undefined ? dealValue : deal_value;
    if (dv !== undefined) updates.deal_value = dv;
    if (deal_closed_at !== undefined) updates.deal_closed_at = deal_closed_at;
    const ds = dealStage !== undefined ? dealStage : deal_stage;
    if (ds !== undefined) updates.deal_stage = ds?.trim() || null;
    if (lead_source !== undefined) updates.lead_source = lead_source?.trim() || null;
    if (company_size !== undefined) updates.company_size = company_size?.trim() || null;
    if (keywords !== undefined) updates.keywords = keywords?.trim() || null;
    if (status !== undefined && ['prospect', 'client'].includes(status)) updates.status = status;
    if (pipeline_stage !== undefined) updates.pipeline_stage = pipeline_stage;

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
contactsApiRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user } = await ensureUserAndTeam(req.user);
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_contact_id' });

    const { data: contact } = await supabase.from('contacts').select('id, workspace_id').eq('id', id).single();
    if (!contact) return res.status(404).json({ error: 'contact_not_found' });

    const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('workspace_id', contact.workspace_id).eq('user_id', user.id).single();
    if (!membership) return res.status(403).json({ error: 'contact_not_found_or_unauthorized' });

    await supabase.from('contacts').delete().eq('id', id);
    return res.json({ success: true });
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

// POST /api/contacts/import
contactsApiRouter.post('/import', verifySupabaseAuth, async (req, res) => {
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

    // Dedup email rows by email
    const emails = emailRows.map(r => r.email.toLowerCase().trim());
    const { data: existingByEmail } = emails.length
      ? await supabase.from('contacts').select('id, email').eq('workspace_id', workspaceId).in('email', emails)
      : { data: [] };
    const existingEmailSet = new Set((existingByEmail || []).map(c => c.email.toLowerCase()));

    // Dedup linkedin-only rows by linkedin_url
    const linkedinUrls = linkedinOnlyRows.map(r => r.linkedin_url.trim());
    const { data: existingByLinkedin } = linkedinUrls.length
      ? await supabase.from('contacts').select('id, linkedin_url').eq('workspace_id', workspaceId).in('linkedin_url', linkedinUrls)
      : { data: [] };
    const existingLinkedinSet = new Set((existingByLinkedin || []).map(c => c.linkedin_url));

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
    const companyKeyOf = (r) => {
      const dom = normDomain(r.domain?.trim());
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
        distinctCompanies.set(key, { name: r.company?.trim() || null, domain: normDomain(r.domain?.trim()) });
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
      phone: r.phone?.trim() || null, domain: r.domain?.trim() || null,
      notes: r.notes?.trim() || null, seniority: r.seniority?.trim() || null,
      department: r.department?.trim() || null, deal_stage: r.deal_stage?.trim() || null,
      pipeline_stage: r.pipeline_stage?.trim() || null,
      created_by: user.id,
    });

    const buildUpdateFields = (r) => {
      const u = {};
      if (r.first_name) u.first_name = r.first_name.trim();
      if (r.last_name) u.last_name = r.last_name.trim();
      if (r.company) u.company = r.company.trim();
      if (r.job_title) u.job_title = r.job_title.trim();
      if (r.phone) u.phone = r.phone.trim();
      if (r.domain) u.domain = r.domain.trim();
      if (r.notes) u.notes = r.notes.trim();
      if (r.seniority) u.seniority = r.seniority.trim();
      if (r.department) u.department = r.department.trim();
      if (r.deal_stage) u.deal_stage = r.deal_stage.trim();
      if (r.pipeline_stage) u.pipeline_stage = r.pipeline_stage.trim();
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

    // Fire async history enrichment for all imported contacts (new + updated)
    const existingIds = [
      ...(existingByEmail || []).map(c => c.id),
      ...(existingByLinkedin || []).map(c => c.id),
    ];
    const allImportedIds = [...newContactIds, ...existingIds];
    let jobId = null;
    if (allImportedIds.length) {
      jobId = randomUUID();
      enrichContactHistory(supabase, workspaceId, allImportedIds, jobId).catch(e =>
        console.error('[CONTACTS_IMPORT_ENRICH_ERROR]', e.message)
      );
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
    return res.json({ companies: companies || [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
