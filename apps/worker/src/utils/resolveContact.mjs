// General-purpose identity resolution — ported from an earlier internal prototype.
// Waterfall: external_id → email → linkedin_url → name+email heal → create
// Used by all webhook handlers except LinkedIn (which has its own linkedin_member_id step).

import {
  getSupabaseClient,
  resolveEntity,
  getOrCreateEntity,
  assertClaims,
  identifiersFromContactData,
  saveNote,
  companyDomainFromEmail,
  isFreeEmailDomain,
} from '@nous/core';
import { enrichContact } from './enrichContact.mjs';
import { corroboratesIdentity, emailDomain } from './identityMatch.mjs';

// ── Company upsert ────────────────────────────────────────────────────────────

export async function upsertCompany(supabase, workspaceId, { name, domain, industry, employee_count }) {
  let normalizedDomain = domain?.replace(/^www\./, '').toLowerCase().trim() || null;
  // Never create or key a company on a personal-mailbox domain (gmail.com, …).
  // A free domain isn't an employer — drop it and fall back to name-only.
  if (normalizedDomain && isFreeEmailDomain(normalizedDomain)) normalizedDomain = null;
  if (!name && !normalizedDomain) return null;

  // Persist firmographics as CLAIMS on the company ENTITY (what the ICP scorer
  // reads) when supplied — not just the v1 companies row. Keyed by domain so it
  // resolves to the shared company entity. Best-effort; never blocks the upsert.
  if (normalizedDomain && (industry != null || employee_count != null)) {
    try {
      const entityId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: normalizedDomain }]);
      const values = {};
      if (industry != null) values.industry = String(industry);
      if (employee_count != null) {
        const n = Number(employee_count);
        if (Number.isFinite(n)) values.employee_count = n;
      }
      if (Object.keys(values).length) await assertClaims(supabase, workspaceId, entityId, { values, source: 'enrichment' });
    } catch { /* best-effort */ }
  }

  let existing = null;
  if (normalizedDomain) {
    const { data } = await supabase.from('companies').select('id, name, domain')
      .eq('workspace_id', workspaceId).eq('domain', normalizedDomain).maybeSingle();
    existing = data;
  }
  if (!existing && name) {
    const { data } = await supabase.from('companies').select('id, name, domain')
      .eq('workspace_id', workspaceId).ilike('name', name).maybeSingle();
    existing = data;
  }

  if (existing) {
    const updates = {};
    if (name && !existing.name) updates.name = name;
    if (normalizedDomain && !existing.domain) updates.domain = normalizedDomain;
    if (Object.keys(updates).length) {
      const { data: updated } = await supabase.from('companies').update(updates)
        .eq('id', existing.id).select('id').single();
      return updated || existing;
    }
    return existing;
  }

  const { data: created } = await supabase.from('companies')
    .insert({ workspace_id: workspaceId, name: name || null, domain: normalizedDomain })
    .select('id').single();
  return created;
}

// ── Fill empty fields from incoming data ──────────────────────────────────────

async function mergeContact(supabase, existing, incoming) {
  const updates = {};
  const fill = (field, value) => {
    if (value != null && value !== '' && (existing[field] == null || existing[field] === ''))
      updates[field] = value;
  };

  fill('first_name',   incoming.first_name);
  fill('last_name',    incoming.last_name);
  fill('job_title',    incoming.job_title);
  fill('phone',        incoming.phone);
  fill('linkedin_url', incoming.linkedin_url);
  fill('company',      incoming.company_name);
  fill('hubspot_id',   incoming.hubspot_id);
  fill('pipedrive_id', incoming.pipedrive_id);
  fill('apollo_id',    incoming.apollo_id);

  const explicitDomain = incoming.company_domain?.replace(/^www\./, '').toLowerCase().trim() || null;
  // Prefer an explicit company domain; otherwise derive from the email — but a
  // free mailbox (gmail.com, …) is never an employer, so it stays out of `domain`.
  const incomingDomain = (explicitDomain && !isFreeEmailDomain(explicitDomain) ? explicitDomain : null)
    || companyDomainFromEmail(incoming.email);
  fill('domain', incomingDomain);

  // Opportunistically link company_id if missing and we have company data
  if (!existing.company_id && (incoming.company_name || incomingDomain)) {
    upsertCompany(supabase, existing.workspace_id, {
      name:   incoming.company_name || null,
      domain: incomingDomain || existing.domain,
    }).then(co => {
      if (co?.id) supabase.from('contacts').update({ company_id: co.id }).eq('id', existing.id).then(() => {});
    }).catch(() => {});
  }

  if (!Object.keys(updates).length) return existing;
  updates.updated_at = new Date().toISOString();

  // The `contacts` view's INSTEAD OF UPDATE trigger writes the v2 state
  // observations for each changed field — no explicit mirror needed.
  const { data: updated } = await supabase.from('contacts')
    .update(updates).eq('id', existing.id).select('id, company_id, email, channels').single();

  return { ...existing, ...updates, ...(updated || {}) };
}

// ── Main resolver ─────────────────────────────────────────────────────────────
// createIfMissing=true  → webhook sources that bootstrap contacts (LinkedIn, RB2B, Apollo)
// createIfMissing=false → update-only sources (Fireflies, Calendly — never create)

export async function resolveContact(supabase, workspaceId, data, { createIfMissing = true } = {}) {
  const {
    email, full_name, first_name, last_name,
    linkedin_url, company_domain, company_name,
    hubspot_id, pipedrive_id, apollo_id, job_title, phone, source,
  } = data;

  const SELECT = 'id, company_id, email, first_name, last_name, channels, linkedin_url, workspace_id';
  const identifiers = identifiersFromContactData({
    email, linkedin_url, hubspot_id, pipedrive_id, apollo_id,
  });

  // Set when a name matches an existing contact but nothing corroborates the
  // new email — used to flag the contact we end up creating (Step 3) for review.
  let duplicateCandidates = null;

  // Step 1 — resolve via entity_identifiers (the v2 lookup); fetch the contact
  // row by id (entity.id == contact.id under the migration convention).
  for (const ident of identifiers) {
    const entityId = await resolveEntity(supabase, workspaceId, ident);
    if (!entityId) continue;
    const { data: match } = await supabase.from('contacts').select(SELECT)
      .eq('id', entityId).maybeSingle();
    if (match) return { contact: await mergeContact(supabase, match, data), created: false };
  }

  // Step 2 — name heal: contact exists with matching name but no email → patch
  // email in. Names aren't v2 identifiers (not unique); this is a contacts-only
  // fallback that Phase 4 retires.
  if (email) {
    const name = full_name || [first_name, last_name].filter(Boolean).join(' ') || null;
    if (name) {
      const parts = name.trim().split(/\s+/);
      const fn = parts[0], ln = parts.slice(1).join(' ');
      if (fn && ln) {
        const { data: nameMatches } = await supabase.from('contacts').select(SELECT)
          .eq('workspace_id', workspaceId).is('email', null)
          .ilike('first_name', fn).ilike('last_name', ln);
        if (nameMatches?.length === 1) {
          const cleanEmail = email.toLowerCase().trim();
          await supabase.from('contacts').update({ email: cleanEmail }).eq('id', nameMatches[0].id);
          // The healed contact now has an email — register it in entity_identifiers
          await supabase.from('entity_identifiers').insert({
            workspace_id: workspaceId, entity_id: nameMatches[0].id, kind: 'email', value: cleanEmail,
          }).then(() => {}, () => {});
          console.log(`[IDENTITY] Name heal "${name}" → ${cleanEmail} (entity ${nameMatches[0].id})`);
          return { contact: await mergeContact(supabase, { ...nameMatches[0], email: cleanEmail }, data), created: false };
        }
      }
    }
  }

  // Step 2.5 — corroborated cross-email match: the person already exists (WITH an
  // email) but is reaching us from a new, unseen address — e.g. they booked with
  // a work email when we only had their personal one. Matching on name alone is
  // unsafe (two people can share a name), so we require domain/company
  // corroboration. With it → attach the new email to the existing entity instead
  // of spawning a duplicate. Without it → fall through to create + flag (Step 3)
  // for human review. Never an automatic merge on name alone.
  if (email && createIfMissing) {
    const nm = full_name || [first_name, last_name].filter(Boolean).join(' ') || null;
    const p = nm?.trim().split(/\s+/) || [];
    const fn = p[0], ln = p.slice(1).join(' ');
    if (fn && ln) {
      const { data: nameMatches } = await supabase.from('contacts')
        .select('id, first_name, last_name, email, domain, company, workspace_id')
        .eq('workspace_id', workspaceId)
        .ilike('first_name', fn).ilike('last_name', ln)
        .not('email', 'is', null);
      if (nameMatches?.length) {
        const incomingDomain = emailDomain(email);
        const corroborated = [];
        for (const c of nameMatches) {
          const { data: ids } = await supabase.from('entity_identifiers')
            .select('value').eq('workspace_id', workspaceId)
            .eq('entity_id', c.id).eq('kind', 'email').eq('status', 'active');
          const emailDomains = (ids || []).map(r => emailDomain(r.value)).filter(Boolean);
          if (corroboratesIdentity({ domain: c.domain, company: c.company, emailDomains }, incomingDomain)) {
            corroborated.push(c);
          }
        }
        if (corroborated.length === 1) {
          const target = corroborated[0];
          const cleanEmail = email.toLowerCase().trim();
          await supabase.from('entity_identifiers').insert({
            workspace_id: workspaceId, entity_id: target.id, kind: 'email', value: cleanEmail,
          }).then(() => {}, () => {});
          console.log(`[IDENTITY] Corroborated match "${nm}" + ${incomingDomain} → attach ${cleanEmail} to entity ${target.id}`);
          const { data: full } = await supabase.from('contacts').select(SELECT).eq('id', target.id).maybeSingle();
          return { contact: await mergeContact(supabase, full || target, data), created: false };
        }
        // Ambiguous: name matches but nothing corroborates (or >1 corroborates).
        // Remember the candidates so the contact we create can be flagged.
        duplicateCandidates = nameMatches.slice(0, 3).map(c => ({
          id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          email: c.email,
        }));
      }
    }
  }

  // Step 3 — no match
  if (!createIfMissing) return { contact: null, created: false };
  if (!email && !linkedin_url) {
    console.warn('[IDENTITY] Cannot create contact without email or linkedin_url');
    return { contact: null, created: false };
  }

  const name = full_name || [first_name, last_name].filter(Boolean).join(' ') || null;
  const explicitCreateDomain = company_domain?.replace(/^www\./, '').toLowerCase().trim() || null;
  const normalizedDomain = (explicitCreateDomain && !isFreeEmailDomain(explicitCreateDomain) ? explicitCreateDomain : null)
    || companyDomainFromEmail(email);

  let companyId = null;
  if (company_name || normalizedDomain) {
    const co = await upsertCompany(supabase, workspaceId, { name: company_name || null, domain: normalizedDomain });
    companyId = co?.id || null;
  }

  // Create the v2 entity first (and register every identifier on it); then
  // create the v1 contact row using the entity's id as its primary key, so the
  // migration convention `contact.id == entity.id` holds for new ingestion.
  // nameHint enables the corroborated name fallback — attach to a unique existing
  // person instead of forking a duplicate (prevents the Ravi LinkedIn/Cal.com split).
  const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', identifiers,
    { nameHint: { first_name, last_name } });

  const { data: created, error } = await supabase.from('contacts').insert({
    id: entityId,
    workspace_id: workspaceId,
    email:        email ? email.toLowerCase().trim() : null,
    first_name:   first_name || name?.split(' ')[0] || null,
    last_name:    last_name  || name?.split(' ').slice(1).join(' ') || null,
    job_title, phone, linkedin_url,
    hubspot_id, pipedrive_id, apollo_id,
    company:    company_name || null,
    domain:     normalizedDomain,
    company_id: companyId,
    source:     source || 'webhook',
    pipeline_stage: 'identified',
    first_seen_at:  new Date().toISOString(),
  }).select(SELECT).single();

  if (error) {
    // PK conflict (entity-first id already has a contact row) — fetch + merge.
    if (error.code === '23505') {
      const { data: existing } = await supabase.from('contacts').select(SELECT)
        .eq('id', entityId).maybeSingle();
      if (existing) return { contact: await mergeContact(supabase, existing, data), created: false };
    }
    console.error('[IDENTITY] Create error:', error.message);
    return { contact: null, created: false };
  }

  // (No explicit state observation mirror: the contacts view's INSERT trigger
  // already wrote the entity, identifiers, and state observations for every
  // claim-worthy field above.)

  // Flag for review: a same-name contact already exists but nothing corroborated
  // this new email, so we created rather than merged. Leave a Data Quality note
  // so a human can confirm + merge — we never auto-merge on name alone.
  if (duplicateCandidates?.length) {
    const refs = duplicateCandidates
      .map(d => `${d.name || 'unknown'} (${d.email || 'no email'}, id ${d.id})`).join('; ');
    saveNote(supabase, workspaceId, {
      entityId: created.id,
      category: 'Data Quality',
      content: `Possible duplicate — created from ${source || 'webhook'} with a new email (${email}). A same-name contact already exists: ${refs}. Review and merge if this is the same person.`,
      source: 'identity_resolution',
      confidence: 0.5,
      metadata: { flag: 'possible_duplicate', candidate_ids: duplicateCandidates.map(d => d.id), new_email: email },
    }).catch(() => {});
  }

  // Fire-and-forget enrichment — never block the webhook response
  enrichContact(supabase, { ...created, workspace_id: workspaceId }).catch(() => {});

  return { contact: created, created: true };
}
