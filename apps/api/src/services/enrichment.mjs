// ============================================================
// Enrichment pipeline — Prospeo (default) or Apollo (user opt-in)
// Called on every new contact, and after any identity resolution
// ============================================================

import Anthropic from 'useleak';
import {
  logActivity, listSignals, scoreLead,
  listNotes, listActivities,
  resolveEntity, getOrCreateEntity, identifiersFromContactData,
  recordEnrichmentObservations,
} from '@nous/core';
import { decrypt } from '../utils/encryption.js';

// Attribute fields written as observations with the TRUE enrichment source, and
// therefore stripped from the contacts-view update so the view trigger doesn't
// re-emit them tagged with the record's origin source (provenance erasure).
// linkedin_url stays on the update for identifier attachment.
// See docs/crm-hygiene-phase-1b-spec.md Task 0.
const ENRICH_STRIP = ['job_title', 'seniority', 'department', 'company', 'phone', 'city', 'country'];

// Placeholder emails injected by CSV/Airtable imports (e.g. someone@airtable.import)
// are not real addresses — treat them as "no email" so the waterfall still hunts.
const FAKE_EMAIL_DOMAINS = /\.(import|csv|fake|test|example|placeholder|noemail)$/i;
function realEmailOf(email) {
  return email && !FAKE_EMAIL_DOMAINS.test(email.split('@')[1] || '') ? email : null;
}

async function logSysEvent(supabase, workspaceId, source, eventType, summary, contactId, metadata) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source, event_type: eventType,
      summary: summary || null, contact_id: contactId || null,
      metadata: metadata || {}, occurred_at: new Date().toISOString(),
    });
  } catch { /* non-critical */ }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROSPEO_BASE = 'https://api.prospeo.io';
const FINDYMAIL_BASE = 'https://app.findymail.com';

// The platform-owned Prospeo key: Nous's money, not the customer's.
//
// It used to be an unconditional fallback, so any workspace without its own key
// silently enriched on ours — and `resolveContact` fires enrichment on EVERY
// contact a webhook creates. On a workspace with zero customers that came to 287
// enrichment runs in 28 days, all billed to us, none of it metered.
//
// Enrichment is not a product we sell. So the fallback is now opt-in: it stays
// off unless ENRICHMENT_BUILTIN_FALLBACK is explicitly set, which keeps it
// available for our own workspace and demos without leaving an open tab for
// everyone else. Customers with their own Prospeo key are unaffected.
function builtinProspeoKey() {
  if (process.env.ENRICHMENT_BUILTIN_FALLBACK !== 'true') return null;
  return process.env.PROSPERO_API_KEY || null;
}

// Takes the key rather than reading the env directly, because the caller is the
// only one who knows WHOSE key this is: the workspace brought its own, or we fell
// back to the platform one. Reading process.env here silently ignored a BYOK key
// the caller had already resolved, and billed us anyway.
function prospeoHeaders(key) {
  return {
    'Content-Type': 'application/json',
    'X-KEY': key,
  };
}

// Returns the workspace's Apollo key only if connected AND toggled on for enrichment.
export async function getApolloEnrichmentKey(supabase, workspaceId) {
  return _getProviderKey(supabase, workspaceId, 'apollo', { requireEnrichmentToggle: true });
}

// The Apollo key WITHOUT the enrichment toggle.
//
// The toggle exists to protect email credits: revealing a person's email costs money, so
// "use Apollo for enrichment" is an explicit opt-in. Company firmographics are not that.
// Apollo's organizations/enrich is a domain lookup, it burns no email credits, and it
// returns the same `organization` block their people-search already hands back — data
// the workspace has usually paid for once already.
//
// Gating company firmographics behind the email-credit toggle is what left `keywords`
// missing on 357 of 360 companies, which silently disabled six of twelve ICP signals.
// A connected, verified Apollo key is enough for this.
export async function getApolloKey(supabase, workspaceId) {
  return _getProviderKey(supabase, workspaceId, 'apollo', { requireEnrichmentToggle: false });
}

// Returns the workspace's Prospeo BYOK key if connected (always used for enrichment when present).
export async function getProspeoEnrichmentKey(supabase, workspaceId) {
  return _getProviderKey(supabase, workspaceId, 'prospeo', { requireEnrichmentToggle: false });
}

// Returns the workspace's SignalBase key if connected.
export async function getSignalBaseKey(supabase, workspaceId) {
  return _getProviderKey(supabase, workspaceId, 'signalbase', { requireEnrichmentToggle: false });
}

// Returns the workspace's Findymail BYOK key if connected. Always BYOK — Nous
// funds no built-in Findymail key, so this rung only ever spends the user's
// own credits (which is why it ranks above the built-in Prospeo fallback).
export async function getFindymailEnrichmentKey(supabase, workspaceId) {
  return _getProviderKey(supabase, workspaceId, 'findymail', { requireEnrichmentToggle: false });
}

// Generic accessor for any workflow provider's decrypted API key (BYOK), used
// by sibling services (e.g. email verification) that follow the same
// connect-once-then-use pattern. No enrichment toggle by default.
export async function getProviderApiKey(supabase, workspaceId, providerName) {
  return _getProviderKey(supabase, workspaceId, providerName, { requireEnrichmentToggle: false });
}

async function _getProviderKey(supabase, workspaceId, providerName, { requireEnrichmentToggle }) {
  const { data: provider } = await supabase
    .from('workflow_providers')
    .select('id')
    .eq('name', providerName)
    .maybeSingle();

  if (!provider?.id) return null;

  // Take EVERY connection for this provider, newest first, and return the first key that
  // actually decrypts.
  //
  // It used to take only the newest verified row. A workspace can accumulate several
  // connections for one provider (reconnect, key rotation, a stale row left behind), and
  // if the newest one was encrypted under a previous ENCRYPTION_KEY it throws on decrypt
  // — and, being the only row we looked at, it SHADOWED a perfectly good older key. The
  // provider then reads as "not connected" while its key sits right there in the table.
  //
  // Found 2026-07-14: the Nous workspace had two apollo rows and could not decrypt the
  // newest, so company enrichment reported apollo_not_connected with a working key
  // present.
  const { data: rows } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, is_verified')
    .eq('workspace_id', workspaceId)
    .eq('provider_id', provider.id)
    .order('is_verified', { ascending: false })
    .order('created_at', { ascending: false });

  for (const row of rows || []) {
    const cred = row?.encrypted_credentials;
    if (!cred?.api_key) continue;
    if (requireEnrichmentToggle && !cred.use_for_enrichment) continue;
    try {
      const key = decrypt(cred.api_key);
      if (key) return key;
    } catch { /* stale row under an old encryption key — try the next one */ }
  }
  return null;
}

// ── Identity resolution ──────────────────────────────────────────────────────
// Waterfall: external_id → email → linkedin → name+domain → create new
// Returns { contact, created: bool }

// createIfMissing=true  → Level 1 (Instantly, RB2B, LinkedIn, CRM bootstrap) — creates new contacts
// createIfMissing=false → Level 2/3 (Gmail, Fireflies, Fathom, Calendly) — update only, never create
export async function resolveContact(supabase, workspaceId, data, { createIfMissing = true } = {}) {
  const {
    email, full_name, first_name, last_name, linkedin_url, company_domain,
    hubspot_id, pipedrive_id, apollo_id, rb2b_id, attio_id,
    job_title, phone, source,
    company_name,
  } = data;

  const identifiers = identifiersFromContactData({
    email, linkedin_url, hubspot_id, pipedrive_id, apollo_id, rb2b_id, attio_id,
  });

  // Step 1 — resolve via entity_identifiers; fetch the contact row by id
  // (entity.id == contact.id under the migration convention).
  for (const ident of identifiers) {
    const entityId = await resolveEntity(supabase, workspaceId, ident);
    if (!entityId) continue;
    const { data: match } = await supabase.from('contacts').select('*').eq('id', entityId).maybeSingle();
    if (match) return { contact: await mergeContact(supabase, match, data), created: false };
  }

  // Step 2 — name heal: contact with matching name but no email → patch in.
  // Names aren't v2 identifiers; this is a contacts-only fallback Phase 4 retires.
  if (email) {
    const name = full_name || [first_name, last_name].filter(Boolean).join(' ') || null;
    if (name) {
      const parts = name.trim().split(/\s+/);
      const fn = parts[0];
      const ln = parts.slice(1).join(' ');
      if (fn && ln) {
        const { data: nameMatches } = await supabase
          .from('contacts').select('*')
          .eq('workspace_id', workspaceId).is('email', null)
          .ilike('first_name', fn).ilike('last_name', ln);
        if (nameMatches?.length === 1) {
          const cleanEmail = email.toLowerCase().trim();
          await supabase.from('contacts').update({ email: cleanEmail }).eq('id', nameMatches[0].id);
          await supabase.from('entity_identifiers').insert({
            workspace_id: workspaceId, entity_id: nameMatches[0].id, kind: 'email', value: cleanEmail,
          }).then(() => {}, () => {});
          nameMatches[0].email = cleanEmail;
          console.log(`[IDENTITY] Name resolved "${name}" → ${cleanEmail} (entity ${nameMatches[0].id})`);
          return { contact: await mergeContact(supabase, nameMatches[0], data), created: false };
        }
      }
    }
  }

  // Step 3 — no match → create or reject
  if (!createIfMissing) return { contact: null, created: false };
  if (!email && !linkedin_url) {
    console.warn('[IDENTITY] Cannot create contact without email or linkedin_url, skipping');
    return { contact: null, created: false };
  }

  const name = full_name || [first_name, last_name].filter(Boolean).join(' ') || null;
  const normalizedDomain = company_domain?.replace(/^www\./, '').toLowerCase().trim()
    || (email ? email.split('@')[1]?.toLowerCase() : null)
    || null;

  let companyId = null;
  if (company_name || normalizedDomain) {
    const company = await upsertCompany(supabase, workspaceId, {
      name:   company_name || null,
      domain: normalizedDomain,
    });
    companyId = company?.id || null;
  }

  // Create the v2 entity first; the contact row reuses its id.
  const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', identifiers);

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      id: entityId,
      workspace_id: workspaceId,
      email:        email ? email.toLowerCase().trim() : null,
      first_name:   first_name || name?.split(' ')[0] || null,
      last_name:    last_name  || name?.split(' ').slice(1).join(' ') || null,
      job_title, phone, linkedin_url,
      hubspot_id, pipedrive_id, apollo_id, rb2b_id, attio_id,
      company:      company_name || null,
      domain:       normalizedDomain,
      company_id:   companyId,
      source:       source || 'webhook',
      enrichment_status: 'queued',
      first_seen_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      // PK conflict — entity already had a contact row. Fetch + merge.
      const { data: existing } = await supabase.from('contacts').select('*').eq('id', entityId).maybeSingle();
      if (existing) return { contact: await mergeContact(supabase, existing, data), created: false };
    }
    console.error('[IDENTITY] Create contact error:', error);
    return { contact: null, created: false };
  }

  return { contact: created, created: true };
}


// ── Field-level merge ────────────────────────────────────────────────────────

async function mergeContact(supabase, existing, incoming) {
  const updates = {};

  const fill = (field, value) => {
    if (value != null && value !== '' && (existing[field] == null || existing[field] === '')) {
      updates[field] = value;
    }
  };

  fill('first_name',    incoming.first_name);
  fill('last_name',     incoming.last_name);
  fill('job_title',     incoming.job_title);
  fill('phone',         incoming.phone);
  fill('linkedin_url',  incoming.linkedin_url);
  fill('company',       incoming.company_name);
  fill('domain',        incoming.company_domain?.replace(/^www\./, '').toLowerCase().trim()
                          || (incoming.email ? incoming.email.split('@')[1]?.toLowerCase() : null));
  fill('hubspot_id',    incoming.hubspot_id);
  fill('pipedrive_id',  incoming.pipedrive_id);
  fill('apollo_id',     incoming.apollo_id);
  fill('rb2b_id',       incoming.rb2b_id);
  fill('attio_id',      incoming.attio_id);

  if (!existing.company_id && (incoming.company_name || updates.domain)) {
    upsertCompany(supabase, existing.workspace_id, {
      name:   incoming.company_name || null,
      domain: updates.domain || existing.domain,
    }).then(co => {
      if (co?.id) supabase.from('contacts').update({ company_id: co.id }).eq('id', existing.id).then(() => {});
    }).catch(() => {});
  }

  if (Object.keys(updates).length === 0) return existing;

  updates.updated_at = new Date().toISOString();
  const { data: updated } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', existing.id)
    .select('*')
    .single();

  return updated || existing;
}


// ── Contact enrichment waterfall ─────────────────────────────────────────────
// Try each configured provider in turn, ordered by the strongest identity key we
// hold, and STOP on the first hit (cost-first). Fall through on a miss.
//   • LinkedIn URL present  → Prospeo leads (LinkedIn→email is its strength)
//   • name + domain present → Apollo leads (people/match on name + domain)
// A provider runs only if its key exists. Firmographics from a provider that
// missed the email are still saved as observations, so falling through to the
// next rung is purely additive — never a double-charge for the same field.
// Returns true if any rung satisfied the goal (an email when one was missing,
// otherwise a profile), false if every rung missed or there was no usable key.

export async function enrichContact(supabase, contact, { apolloKey = undefined } = {}) {
  // Gate: need at least one usable identity key. A bare name (no real email, no
  // LinkedIn URL, no domain) is un-enrichable — skip it and spend nothing.
  const realEmail = realEmailOf(contact.email);
  const hasName = Boolean(contact.first_name && contact.last_name);
  const hasUsableKey = Boolean(realEmail || contact.linkedin_url || (hasName && contact.domain));
  if (!hasUsableKey) return false;

  // BYOK keys spend the user's own credits; the built-in Prospeo key is Nous's
  // COGS, so it runs LAST and only when the workspace brought no Prospeo key.
  const apolloK = apolloKey !== undefined
    ? apolloKey
    : await getApolloEnrichmentKey(supabase, contact.workspace_id);
  const prospeoByokK = await getProspeoEnrichmentKey(supabase, contact.workspace_id);
  const findymailK = await getFindymailEnrichmentKey(supabase, contact.workspace_id);
  const prospeoBuiltinK = builtinProspeoKey();

  const make = {
    apollo:    apolloK      ? (c) => enrichContactViaApollo(supabase, c, apolloK)       : null,
    prospeo:   prospeoByokK ? (c) => enrichContactViaProspeo(supabase, c, prospeoByokK) : null,
    findymail: findymailK   ? (c) => enrichContactViaFindymail(supabase, c, findymailK) : null,
  };

  // Order BYOK rungs by the strongest key we hold for this row: a LinkedIn URL
  // plays to Prospeo's strength, so it leads; otherwise Apollo (name+domain)
  // leads. Findymail sits between as the founder/agency email specialist.
  const pref = contact.linkedin_url
    ? ['prospeo', 'findymail', 'apollo']
    : ['apollo', 'findymail', 'prospeo'];

  const ladder = [];
  for (const name of pref) if (make[name]) ladder.push(make[name]);

  // Built-in Prospeo (Nous's cost) is the final safety net — appended only when
  // the workspace has no BYOK Prospeo key, so Prospeo never runs twice.
  if (!prospeoByokK && prospeoBuiltinK) {
    ladder.push((c) => enrichContactViaProspeo(supabase, c, prospeoBuiltinK));
  }

  for (const run of ladder) {
    const hit = await run(contact);
    if (hit) return true;
  }
  return false;
}


// ── Apollo enrichment path ────────────────────────────────────────────────────

async function enrichContactViaApollo(supabase, contact, apolloKey) {
  await supabase.from('contacts').update({ enrichment_status: 'queued' }).eq('id', contact.id);

  try {
    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify({
        // Match on whatever identity keys we hold, not email alone, so
        // name+domain and LinkedIn-only rows resolve too.
        email:        realEmailOf(contact.email) || undefined,
        first_name:   contact.first_name  || undefined,
        last_name:    contact.last_name   || undefined,
        domain:       contact.domain      || undefined,
        linkedin_url: contact.linkedin_url || undefined,
        reveal_personal_emails: false,
        reveal_phone_number: false,
      }),
    });

    if (!res.ok) throw new Error(`Apollo ${res.status}: ${await res.text().catch(() => '')}`);
    const body = await res.json();
    const person = body.person;
    if (!person) {
      // Soft miss — record it and let the waterfall fall through to the next rung.
      await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
      return false;
    }

    const org = person.organization || {};
    const updates = {
      enrichment_status:  'complete',
      enriched_at:        new Date().toISOString(),
      enrichment_source:  'apollo',
      apollo_raw:         person,
      apollo_id:          person.id || contact.apollo_id,
      linkedin_url:       person.linkedin_url || contact.linkedin_url,
      job_title:          person.title        || contact.job_title,
      seniority:          normalizeSeniority(person.seniority),
      department:         normalizeDepartment(person.departments?.[0]),
      phone:              person.phone_numbers?.[0]?.raw_number || contact.phone,
      city:               person.city    || contact.city    || null,
      country:            person.country || contact.country || null,
    };

    if (org.name || org.primary_domain) {
      const company = await upsertCompany(supabase, contact.workspace_id, {
        name:           org.name,
        domain:         org.primary_domain,
        industry:       org.industry,
        employee_count: org.estimated_num_employees,
        location:       [org.city, org.country].filter(Boolean).join(', '),
        tech_stack:     org.technology_names || [],
        apollo_account_id: org.id,
        apollo_raw:     org,
      });
      if (company) {
        updates.company_id = company.id;
        // Capture Apollo's descriptive text/keywords onto the company entity so a
        // `contains_any` exclusion (e.g. keywords ⊇ "cold calling") can fire at
        // score time without a website read. Best-effort — never block enrichment.
        await captureCompanyKeywords(supabase, contact.workspace_id, company.id, 'apollo', {
          keywords:    org.keywords,
          description: org.short_description || org.seo_description || null,
        });
      }
    }

    // Write enriched attributes as observations with the true source (apollo),
    // then strip them from the view update so the trigger doesn't re-tag them
    // with the record's origin source. Other columns still flow via the view.
    await recordEnrichmentObservations(supabase, contact.workspace_id, contact.id, 'apollo', updates);
    const viewUpdate = { ...updates };
    for (const f of ENRICH_STRIP) delete viewUpdate[f];
    if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);

    await logActivity(supabase, {
      workspaceId: contact.workspace_id, contactId: contact.id,
      companyId: updates.company_id || contact.company_id || null,
      type: 'enrichment_run', source: 'apollo',
      // Unique per run so the timeline accumulates the full enrichment history.
      externalId: `apollo_enrich_${contact.id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Profile enriched via Apollo',
      summary: [
        person.email || null,
        [updates.job_title, org.name].filter(Boolean).join(' at ') || null,
      ].filter(Boolean).join(' · ') || null,
      rawData: {
        provider: 'apollo',
        email: person.email || contact.email || null,
        email_status: person.email_status || null,
        job_title: updates.job_title || null,
        company: org.name || null,
        domain: org.primary_domain || null,
      },
    }).catch(() => {});
    logSysEvent(supabase, contact.workspace_id, 'apollo', 'enrichment_run',
      `Enriched: ${[person.name, updates.job_title, org.name].filter(Boolean).join(' · ')}`,
      contact.id, { status: 'success', job_title: updates.job_title, company: org.name }
    ).catch(() => {});

    // Capture a real work email if Apollo returned one (skip locked placeholders
    // like "email_not_unlocked@domain.com"). Persist it as an entity email
    // identifier so cold leads (not in the contacts view) keep it too — and so
    // it's resolvable even when a (different) primary already exists, since the
    // activity summary surfaces it regardless. Primary column untouched.
    const apolloEmail = person.email && !/not_unlocked|notunlocked/i.test(person.email)
      ? person.email.toLowerCase().trim() : null;
    const apolloPrimaryLc = realEmailOf(contact.email) ? contact.email.toLowerCase().trim() : null;
    if (apolloEmail && apolloEmail !== apolloPrimaryLc) {
      await supabase.from('entity_identifiers')
        .insert({ workspace_id: contact.workspace_id, entity_id: contact.id, kind: 'email', value: apolloEmail, status: 'active' })
        .then(() => {}, () => {}); // ignore unique conflict (email already on another entity)
    }

    await scoreICP(supabase, contact.workspace_id, { ...contact, ...updates });

    // Hit = goal satisfied: an email when one was missing, otherwise a profile.
    return realEmailOf(contact.email) ? true : Boolean(apolloEmail);

  } catch (err) {
    console.error('[ENRICH] Apollo failed for', contact.email, ':', err.message);
    await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
    await logActivity(supabase, {
      workspaceId: contact.workspace_id, contactId: contact.id,
      companyId: contact.company_id || null,
      type: 'enrichment_run', source: 'apollo',
      externalId: `apollo_err_${contact.id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Enrichment failed',
      summary: err.message,
    }).catch(() => {});
    logSysEvent(supabase, contact.workspace_id, 'apollo', 'enrichment_run',
      `Enrichment error: ${err.message}`,
      contact.id, { status: 'error' }
    ).catch(() => {});
    return false;
  }
}


// ── Prospeo enrichment path ───────────────────────────────────────────────────

async function enrichContactViaProspeo(supabase, contact, prospeoKey) {
  if (!prospeoKey) {
    console.warn('[ENRICH] No Prospeo key available (connect Prospeo in Integrations or set PROSPERO_API_KEY)');
    await supabase.from('contacts').update({ enrichment_status: 'no_integration' }).eq('id', contact.id);
    return false;
  }

  // Strip placeholder emails injected by Airtable/CSV imports (e.g. someone@airtable.import)
  const realEmail = realEmailOf(contact.email);

  if (!realEmail && !contact.linkedin_url) {
    console.warn('[ENRICH_PROSPEO] No real email or LinkedIn URL — skipping');
    await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
    return false;
  }

  console.log('[ENRICH_PROSPEO] Starting for', realEmail || contact.linkedin_url);
  await supabase.from('contacts').update({ enrichment_status: 'queued' }).eq('id', contact.id);

  try {
    const requestData = {};
    if (realEmail)             requestData.email        = realEmail;
    if (contact.first_name)    requestData.first_name   = contact.first_name;
    if (contact.last_name)     requestData.last_name    = contact.last_name;
    if (contact.linkedin_url)  requestData.linkedin_url = contact.linkedin_url;

    console.log('[ENRICH_PROSPEO] Calling API for:', JSON.stringify(requestData));
    const res = await fetch(`${PROSPEO_BASE}/enrich-person`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-KEY': prospeoKey },
      body: JSON.stringify({ data: requestData }),
    });

    const body = await res.json();
    console.log('[ENRICH_PROSPEO] Response status:', res.status, '| error:', body.error_code || 'none', '| has person:', !!body.person);

    if (body.error) {
      if (body.error_code === 'NO_MATCH') {
        await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
        await logActivity(supabase, {
          workspaceId: contact.workspace_id, contactId: contact.id,
          companyId: contact.company_id || null,
          type: 'enrichment_run', source: 'prospeo',
          externalId: `prospeo_nomatch_${contact.id}`,
          occurredAt: new Date().toISOString(),
          description: 'Enrichment: no match found',
          summary: `Prospeo searched for ${realEmail || contact.linkedin_url || 'contact'} — no profile found`,
        }).catch(() => {});
        logSysEvent(supabase, contact.workspace_id, 'prospeo', 'enrichment_run',
          `No profile found: ${realEmail || contact.linkedin_url || contact.id}`,
          contact.id, { status: 'no_match' }
        ).catch(() => {});
        return false;
      }
      throw new Error(`Prospeo ${body.error_code || res.status}`);
    }

    const person = body.person;
    if (!person) throw new Error('No person returned');

    // Prospeo returns the found email under person.email = { email, status }.
    const _emailObj = person.email;
    const foundEmail = (_emailObj && typeof _emailObj === 'object' ? _emailObj.email : _emailObj) || null;
    const foundEmailStatus = _emailObj && typeof _emailObj === 'object' ? (_emailObj.status || null) : null;
    console.log('[ENRICH_PROSPEO] found email:', foundEmail || '(none)', '| status:', foundEmailStatus || '-');

    const currentJob = person.job_history?.find(j => j.current) || person.job_history?.[0];

    const updates = {
      enrichment_status:  'complete',
      enriched_at:        new Date().toISOString(),
      enrichment_source:  'prospeo',
      apollo_raw:         person,
      apollo_id:          person.person_id || contact.apollo_id,
      linkedin_url:       person.linkedin_url  || contact.linkedin_url,
      job_title:          person.current_job_title || contact.job_title,
      seniority:          normalizeSeniority(currentJob?.seniority),
      department:         normalizeDepartment(currentJob?.departments?.[0]),
      phone:              person.mobile?.mobile || contact.phone,
      city:               person.location?.city    || contact.city    || null,
      country:            person.location?.country || contact.country || null,
    };

    const co = body.company;
    console.log('[ENRICH_PROSPEO] Company data from Prospeo:', co ? `name=${co.name} domain=${co.domain} industry=${co.industry} employees=${co.employee_count} location=${JSON.stringify(co.location)}` : 'none');
    if (co?.name || co?.website || co?.domain) {
      const rawDomain = co.domain
        || co.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;

      const company = await upsertCompany(supabase, contact.workspace_id, {
        name:              co.name,
        domain:            rawDomain,
        industry:          co.industry,
        employee_count:    co.employee_count,
        location:          [co.location?.city, co.location?.country].filter(Boolean).join(', '),
        tech_stack:        co.technology?.technology_names || [],
        apollo_account_id: co.company_id,
        apollo_raw:        co,
      });

      console.log('[ENRICH_PROSPEO] upsertCompany result:', company ? `id=${company.id} name=${company.name}` : 'null/failed');
      if (company) {
        updates.company_id = company.id;
        updates.company = co.name || contact.company;
        if (rawDomain && !contact.domain) updates.domain = rawDomain;
        // Descriptive text/keywords for score-time `contains_any` exclusions.
        await captureCompanyKeywords(supabase, contact.workspace_id, company.id, 'prospeo', {
          keywords:    co.keywords || co.keyword || null,
          description: co.description || null,
        });

        // Skip immediate background enrichCompany — person response already contains company fields.
        // A separate manual enrich on the company page can fetch deeper data if needed.
      }
    }

    if (foundEmailStatus) updates.reachability_status = foundEmailStatus;
    await recordEnrichmentObservations(supabase, contact.workspace_id, contact.id, 'prospeo', updates);
    const viewUpdate = { ...updates };
    for (const f of ENRICH_STRIP) delete viewUpdate[f];
    if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);

    // Persist the found email as an entity email identifier — works whether or
    // not the entity is a "contact" (cold leads aren't in the contacts view, so
    // the contacts.update above is a no-op for them). Persist it even when a
    // primary email already exists, as long as it DIFFERS: enrichment surfaces
    // the found address in the activity summary regardless, so if we don't also
    // store it as an identifier, check_leads/get_account can't resolve the very
    // address Nous just showed (it reads as net_new / 404s). The primary column
    // is left untouched (enrich-not-overwrite); this is purely an additive
    // known-identifier so lookups and dedup agree with what was surfaced.
    const foundEmailLc = foundEmail ? foundEmail.toLowerCase().trim() : null;
    const primaryEmailLc = realEmail ? realEmail.toLowerCase().trim() : null;
    if (foundEmailLc && foundEmailLc !== primaryEmailLc) {
      await supabase.from('entity_identifiers')
        .insert({ workspace_id: contact.workspace_id, entity_id: contact.id, kind: 'email', value: foundEmailLc, status: 'active' })
        .then(() => {}, () => {}); // ignore unique conflict (email already on another entity)
    }

    await logActivity(supabase, {
      workspaceId: contact.workspace_id, contactId: contact.id,
      companyId: updates.company_id || contact.company_id || null,
      type: 'enrichment_run', source: 'prospeo',
      // Unique per run (not per contact) so the timeline ACCUMULATES every
      // enrichment — that append-only trail is the history: email changes,
      // status changes, company moves, all visible across re-enrichments.
      externalId: `prospeo_enrich_${contact.id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Profile enriched via Prospeo',
      summary: [
        foundEmail && `${foundEmail}${foundEmailStatus ? ` (${foundEmailStatus})` : ''}`,
        [updates.job_title, updates.company].filter(Boolean).join(' at ') || null,
      ].filter(Boolean).join(' · ') || null,
      rawData: {
        provider: 'prospeo',
        email: foundEmail || contact.email || null,
        email_status: foundEmailStatus || null,
        job_title: updates.job_title || null,
        company: updates.company || null,
        domain: updates.domain || null,
      },
    }).catch(() => {});
    logSysEvent(supabase, contact.workspace_id, 'prospeo', 'enrichment_run',
      `Enriched: ${[person.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' '), updates.job_title, updates.company].filter(Boolean).join(' · ')}`,
      contact.id, { status: 'success', job_title: updates.job_title, company: updates.company }
    ).catch(() => {});

    await scoreICP(supabase, contact.workspace_id, { ...contact, ...updates });

    // Hit = goal satisfied: an email when one was missing, otherwise a profile.
    return realEmail ? true : Boolean(foundEmail);

  } catch (err) {
    console.error('[ENRICH] Prospeo failed for', contact.email, ':', err.message);
    await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
    await logActivity(supabase, {
      workspaceId: contact.workspace_id, contactId: contact.id,
      companyId: contact.company_id || null,
      type: 'enrichment_run', source: 'prospeo',
      externalId: `prospeo_err_${contact.id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Enrichment failed',
      summary: err.message,
    }).catch(() => {});
    logSysEvent(supabase, contact.workspace_id, 'prospeo', 'enrichment_run',
      `Enrichment error: ${err.message}`,
      contact.id, { status: 'error' }
    ).catch(() => {});
    return false;
  }
}


// ── Findymail enrichment path ─────────────────────────────────────────────────
// Pure email-finder for the founder/agency ICP. Resolves from a LinkedIn URL or
// a name+domain, and Findymail verifies before returning, so a returned address
// is already deliverable. BYOK only. Same hit/miss contract as the other rungs.
// NOTE: endpoint shapes follow Findymail's documented API — smoke-test with a
// real key before shipping, as the payload/response can drift.
async function enrichContactViaFindymail(supabase, contact, findymailKey) {
  if (!findymailKey) {
    await supabase.from('contacts').update({ enrichment_status: 'no_integration' }).eq('id', contact.id);
    return false;
  }

  const realEmail = realEmailOf(contact.email);
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
  const canLinkedin = Boolean(contact.linkedin_url);
  const canNameDomain = Boolean(name && contact.domain);
  if (!canLinkedin && !canNameDomain) {
    // No key Findymail can work from — clean miss, let the waterfall move on.
    await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
    return false;
  }

  await supabase.from('contacts').update({ enrichment_status: 'queued' }).eq('id', contact.id);

  try {
    const endpoint = canLinkedin
      ? `${FINDYMAIL_BASE}/api/search/linkedin`
      : `${FINDYMAIL_BASE}/api/search/name`;
    const payload = canLinkedin
      ? { linkedin_url: contact.linkedin_url }
      : { name, domain: contact.domain };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${findymailKey}`,
      },
      body: JSON.stringify(payload),
    });

    // 402 = out of Findymail credits. Treat as a miss so the waterfall falls
    // through to the next rung rather than dying.
    if (res.status === 402) {
      console.warn('[ENRICH_FINDYMAIL] out of credits');
      await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
      return false;
    }
    if (!res.ok) throw new Error(`Findymail ${res.status}: ${await res.text().catch(() => '')}`);

    const body = await res.json();
    const found = body.contact || null;
    const foundEmail = found?.email ? found.email.toLowerCase().trim() : null;

    if (!foundEmail) {
      await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
      await logActivity(supabase, {
        workspaceId: contact.workspace_id, contactId: contact.id,
        companyId: contact.company_id || null,
        type: 'enrichment_run', source: 'findymail',
        externalId: `findymail_nomatch_${contact.id}`,
        occurredAt: new Date().toISOString(),
        description: 'Enrichment: no match found',
        summary: `Findymail searched for ${contact.linkedin_url || `${name} @ ${contact.domain}`} — no email found`,
      }).catch(() => {});
      return false;
    }

    // Findymail returns mainly the email plus light company context. We do NOT
    // write reachability_status here — Verify owns email status (enrich ≠ verify).
    const updates = {
      enrichment_status: 'complete',
      enriched_at:       new Date().toISOString(),
      enrichment_source: 'findymail',
    };
    if (found.company && !contact.company)           updates.company = found.company;
    if (found.domain && !contact.domain)             updates.domain = found.domain;
    if (found.linkedin_url && !contact.linkedin_url) updates.linkedin_url = found.linkedin_url;

    await recordEnrichmentObservations(supabase, contact.workspace_id, contact.id, 'findymail', updates);
    const viewUpdate = { ...updates };
    for (const f of ENRICH_STRIP) delete viewUpdate[f];
    if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);

    // Persist the found email as an entity email identifier (works for cold
    // leads not in the contacts view, exactly as the Prospeo/Apollo rungs do).
    // Store it even alongside a different primary so the surfaced address stays
    // resolvable; primary column untouched.
    const findymailPrimaryLc = realEmail ? realEmail.toLowerCase().trim() : null;
    if (foundEmail !== findymailPrimaryLc) {
      await supabase.from('entity_identifiers')
        .insert({ workspace_id: contact.workspace_id, entity_id: contact.id, kind: 'email', value: foundEmail, status: 'active' })
        .then(() => {}, () => {}); // ignore unique conflict
    }

    await logActivity(supabase, {
      workspaceId: contact.workspace_id, contactId: contact.id,
      companyId: contact.company_id || null,
      type: 'enrichment_run', source: 'findymail',
      externalId: `findymail_enrich_${contact.id}_${Date.now()}`,
      occurredAt: new Date().toISOString(),
      description: 'Profile enriched via Findymail',
      summary: [foundEmail, [contact.job_title, updates.company || contact.company].filter(Boolean).join(' at ') || null].filter(Boolean).join(' · ') || null,
      rawData: { provider: 'findymail', email: foundEmail, company: updates.company || contact.company || null, domain: updates.domain || contact.domain || null },
    }).catch(() => {});
    logSysEvent(supabase, contact.workspace_id, 'findymail', 'enrichment_run',
      `Enriched: ${[name, updates.company || contact.company].filter(Boolean).join(' · ')}`,
      contact.id, { status: 'success', company: updates.company || contact.company }
    ).catch(() => {});

    await scoreICP(supabase, contact.workspace_id, { ...contact, ...updates });

    // Hit = goal satisfied: an email when one was missing, otherwise a profile.
    return realEmail ? true : Boolean(foundEmail);

  } catch (err) {
    console.error('[ENRICH] Findymail failed for', contact.email, ':', err.message);
    await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
    logSysEvent(supabase, contact.workspace_id, 'findymail', 'enrichment_run',
      `Enrichment error: ${err.message}`,
      contact.id, { status: 'error' }
    ).catch(() => {});
    return false;
  }
}


// ── Prospeo company enrichment ───────────────────────────────────────────────

export async function enrichCompany(supabase, workspaceId, domain) {
  // The workspace's own key first. This function used to reach straight for
  // PROSPERO_API_KEY with no BYOK path at all, so every company enrichment was
  // billed to Nous even when the customer had connected Prospeo themselves.
  const prospeoKey =
    (await getProspeoEnrichmentKey(supabase, workspaceId)) || builtinProspeoKey();

  if (!prospeoKey) {
    // No workspace key, and the platform fallback is off (the default). Surface a
    // clean "not configured" instead of a generic 500, mirroring how contact
    // enrichment degrades (sets enrichment_status='no_integration' and returns).
    const err = new Error('no Prospeo key (connect Prospeo, or set ENRICHMENT_BUILTIN_FALLBACK=true)');
    err.code = 'enrichment_not_configured';
    throw err;
  }

  const res = await fetch(`${PROSPEO_BASE}/enrich-company`, {
    method: 'POST',
    headers: prospeoHeaders(prospeoKey),
    body: JSON.stringify({ data: { company_website: domain } }),
  });

  const body = await res.json();
  if (body.error) {
    if (body.error_code === 'NO_MATCH') return null;
    throw new Error(`Prospeo ${body.error_code || res.status}`);
  }

  const co = body.company;
  if (!co) return null;

  const rawDomain = co.domain
    || co.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || domain;

  return upsertCompany(supabase, workspaceId, {
    domain:           rawDomain,
    name:             co.name,
    industry:         co.industry,
    employee_count:   co.employee_count,
    location:         [co.location?.city, co.location?.country].filter(Boolean).join(', '),
    tech_stack:       co.technology?.technology_names || [],
    apollo_account_id: co.company_id,
    apollo_raw:       co,
  });
}


// ── Company upsert ───────────────────────────────────────────────────────────

// Write descriptive company text (keywords array + description) onto the COMPANY
// entity as enrichment observations, so a `contains_any` exclusion rule can match
// it at score time (e.g. keywords ⊇ "cold calling" → cap Not-ICP) without a
// website read. company.id from upsertCompany IS the entity id (the companies
// view selects e.id). Normalizes keywords to a clean string array. Best-effort.
async function captureCompanyKeywords(supabase, workspaceId, companyEntityId, source, { keywords, description }) {
  try {
    const facts = {};
    const kw = Array.isArray(keywords)
      ? keywords.map(k => String(k).trim()).filter(Boolean)
      : (typeof keywords === 'string' && keywords.trim() ? keywords.split(',').map(k => k.trim()).filter(Boolean) : null);
    if (kw && kw.length) facts.keywords = kw;
    if (typeof description === 'string' && description.trim()) facts.description = description.trim().slice(0, 2000);
    if (!Object.keys(facts).length) return;
    await recordEnrichmentObservations(supabase, workspaceId, companyEntityId, source, facts);
  } catch (e) {
    console.error('[ENRICH] captureCompanyKeywords failed:', e.message);
  }
}

export async function upsertCompany(supabase, workspaceId, data) {
  const { name, domain, industry, employee_count, location, tech_stack,
          hubspot_company_id, apollo_account_id, apollo_raw, revenue_range } = data;

  const normalizedDomain = domain?.replace(/^www\./, '').toLowerCase().trim() || null;

  let existing = null;
  if (normalizedDomain) {
    const { data: m } = await supabase.from('companies').select('*')
      .eq('workspace_id', workspaceId).eq('domain', normalizedDomain).maybeSingle();
    existing = m;
  }
  if (!existing && hubspot_company_id) {
    const { data: m } = await supabase.from('companies').select('*')
      .eq('workspace_id', workspaceId).eq('hubspot_company_id', hubspot_company_id).maybeSingle();
    existing = m;
  }

  const payload = {
    workspace_id:       workspaceId,
    name:               name || existing?.name,
    domain:             normalizedDomain || existing?.domain,
    industry:           industry || existing?.industry,
    employee_count:     employee_count || existing?.employee_count,
    location:           location || existing?.location,
    tech_stack:         tech_stack?.length ? tech_stack : existing?.tech_stack,
    revenue_range:      revenue_range || existing?.revenue_range,
    hubspot_company_id: hubspot_company_id || existing?.hubspot_company_id,
    apollo_account_id:  apollo_account_id || existing?.apollo_account_id,
    apollo_raw:         apollo_raw || existing?.apollo_raw,
    enrichment_status:  'complete',
    enriched_at:        new Date().toISOString(),
  };

  // The `companies` view's INSTEAD OF triggers translate INSERT/UPDATE into
  // v2 ops (entity upsert + identifier upserts + state observations).
  if (existing) {
    const { data: updated } = await supabase.from('companies')
      .update(payload).eq('id', existing.id).select('*').single();
    return updated;
  }
  const { data: created } = await supabase.from('companies')
    .insert(payload).select('*').single();
  return created;
}


// ── ICP scoring ──────────────────────────────────────────────────────────────

export async function scoreICP(supabase, workspaceId, contact) {
  // Point-in-time feature snapshot that drives Scorecard scoring. Company-level
  // features are merged in below once the contact's company is known.
  let features = {
    job_title:  contact.job_title  || null,
    seniority:  contact.seniority  || null,
    department: contact.department || null,
    company:    contact.company    || null,
    country:    contact.country    || null,
  };
  const contactSummary = [
    contact.job_title   && `Title: ${contact.job_title}`,
    contact.seniority   && `Seniority: ${contact.seniority}`,
    contact.department  && `Department: ${contact.department}`,
    contact.company     && `Company: ${contact.company}`,
  ].filter(Boolean).join('\n');

  if (!contactSummary) return; // No profile data yet — skip

  try {
    // Enrich the snapshot with company-level features so signals over
    // industry / employee_count can fire (richer feature snapshot).
    if (contact.company_id) {
      const { data: co } = await supabase
        .from('companies')
        .select('industry, employee_count')
        .eq('id', contact.company_id)
        .maybeSingle();
      if (co) {
        features = {
          ...features,
          industry:       co.industry || null,
          employee_count: co.employee_count ?? null,
        };
      }
    }

    // ── Score ────────────────────────────────────────────────────────────────
    // The Scorecard is the live scorer: a deterministic, decomposable sum of
    // weighted signals, refined nightly by the learning loop. A workspace
    // without a Scorecard yet falls back to the LLM reading ICP memories.
    // See docs/adaptive-lead-scoring.md.
    let score, fit, reasoning, model;
    let basisMemoryIds = [];

    let signals = [];
    try {
      signals = await listSignals(supabase, workspaceId, { activeOnly: true });
    } catch {
      signals = []; // Scorecard unavailable — fall through to the LLM scorer
    }

    if (signals.length > 0) {
      const result = scoreLead(features, signals);
      score = result.score;
      fit = score >= 70;
      reasoning = result.fired.length
        ? `Scorecard: ${result.fired.length} signal${result.fired.length === 1 ? '' : 's'} fired — ${result.fired.slice(0, 4).map(f => f.key).join(', ')}`
        : 'Scorecard: no signals matched this profile';
      model = 'scorecard';
    } else {
      const memories = await listNotes(supabase, workspaceId, {
        categories: ['ICP', 'Market', 'Company', 'Product'],
        limit: 60,
      });

      const prompt = memories.length
        ? `Workspace ICP criteria:\n${memories.map(m => `[${m.category}] ${m.content}`).join('\n')}\n\nContact:\n${contactSummary}\n\nScore this contact's ICP fit 0-100 and give a one-sentence reason. Respond as JSON: {"score": <int>, "fit": <bool>, "reasoning": "<one sentence>"}`
        : `Contact profile:\n${contactSummary}\n\nScore this B2B contact's ICP fit 0-100 based on their role alone. Use seniority as the primary signal: C-suite/VP/Director = high (75-95), Manager/Senior = medium (45-70), IC/unknown = low (20-40). Give a one-sentence reason. Note: no specific ICP criteria configured. Respond as JSON: {"score": <int>, "fit": <bool>, "reasoning": "<one sentence>"}`;

      const msg = await anthropic.messages.create({
        feature: 'icp-score-llm-fallback',
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0].text.trim();
      const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      score = json.score;
      fit = json.fit ?? json.score >= 70;
      reasoning = json.reasoning || null;
      model = 'claude-haiku-4-5-20251001';
      basisMemoryIds = (memories || []).map(m => m.id);
    }

    if (typeof score !== 'number' || Number.isNaN(score)) {
      console.error('[ICP_SCORE] No score produced for contact', contact.id);
      return;
    }

    // ── Write ────────────────────────────────────────────────────────────────
    await supabase.from('contacts').update({
      icp_score:     score,
      icp_fit:       fit,
      icp_reasoning: reasoning,
      icp_scored_at: new Date().toISOString(),
    }).eq('id', contact.id);

    // The prediction snapshot now lives in the v2 substrate: the scoreEntities
    // worker stakes an `icp_fit` prediction from the entity's claims, and the
    // outcome job resolves it. (Was: a mind_episodes insert here.)

    const fitLabel = score >= 75 ? 'Strong fit' : score >= 50 ? 'Potential fit' : 'Weak fit';
    // ICP scoring is not a timeline-worthy event — it's shown in the contact's
    // Record Details, not the activity feed. Keep the internal sys-event only.
    logSysEvent(supabase, workspaceId, 'system', 'icp_scored',
      `ICP score ${score}/100 — ${fitLabel}: ${(reasoning || '').slice(0, 120)}`,
      contact.id, { score, fit, fit_label: fitLabel, scorer: model }
    ).catch(() => {});

    console.log(`[ICP_SCORE] ${contact.id}: score=${score} fit=${fit} (${model === 'scorecard' ? 'scorecard' : 'memory fallback'})`);
  } catch (e) {
    console.error('[ICP_SCORE] Failed for contact', contact.id, ':', e.message);
  }
}


// ── Connection status (computed, not stored) ──────────────────────────────────

export function connectionStatus(lastActivityAt, totalTouchpoints) {
  if (!lastActivityAt) return 'cold';
  const daysSince = (Date.now() - new Date(lastActivityAt)) / 86400000;
  if (daysSince <= 14 && totalTouchpoints >= 3) return 'hot';
  if (daysSince <= 60 && totalTouchpoints >= 1) return 'warm';
  return 'cold';
}

// Activity type sets — must mirror webhooks.mjs pipeline stage definitions
const INTERESTED_TYPES = new Set([
  'email_reply', 'linkedin_message', 'linkedin_connected', 'website_revisit',
]);
const EVALUATING_TYPES = new Set([
  'meeting_held', 'meeting_scheduled', 'proposal_sent', 'proposal_viewed',
  'outbound_positive_reply', 'pricing_page_visit', 'deal_created', 'trial_started',
]);
const QUALIFIED_TYPES = new Set([...INTERESTED_TYPES, ...EVALUATING_TYPES]);
const ENGAGED_BACK_TYPES = new Set([
  'email_reply', 'linkedin_message', 'outbound_positive_reply', 'proposal_viewed', 'meeting_held',
]);

// Theoretical max when all 13 signals are active — used for completeness calculation
const FULL_MAX = 155;

export async function updateDealHealthScore(supabase, contactId, workspaceId, triggerActivityType) {
  // Skip recompute for AWARE-only signals — they don't affect deal health
  if (triggerActivityType &&
      !QUALIFIED_TYPES.has(triggerActivityType) &&
      triggerActivityType !== 'proposal_viewed' &&
      triggerActivityType !== 'proposal_signed') {
    return;
  }

  // Fetch contact fields needed for computation
  const { data: contact } = await supabase
    .from('contacts')
    .select('pipeline_stage, pipeline_stage_updated_at, deal_value, deal_health_computed_at, company_id, seniority')
    .eq('id', contactId)
    .single();

  if (!contact) return;

  // Hard rule: client stage → clear score, no computation
  if (contact.pipeline_stage === 'client') {
    await supabase.from('contacts')
      .update({ deal_health_score: null, deal_health_breakdown: null, deal_health_computed_at: new Date().toISOString() })
      .eq('id', contactId);
    return;
  }

  // Debounce: skip if computed within last 30 seconds
  if (contact.deal_health_computed_at) {
    const msSince = Date.now() - new Date(contact.deal_health_computed_at).getTime();
    if (msSince < 30000) return;
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const days30Iso = new Date(nowMs - 30 * 86400000).toISOString();
  const days60Iso = new Date(nowMs - 60 * 86400000).toISOString();

  // Fetch all activities for this contact (v2: from observations).
  const rows = await listActivities(supabase, { contactId, limit: 2000 });

  // Hard rule: fewer than 2 qualified activities → insufficient data
  const qualifiedCount = rows.filter(a => QUALIFIED_TYPES.has(a.activity_type)).length;
  if (qualifiedCount < 2) {
    await supabase.from('contacts')
      .update({ deal_health_score: null, deal_health_breakdown: { insufficient_data: true }, deal_health_computed_at: nowIso })
      .eq('id', contactId);
    return;
  }

  // Fetch most recent proposal for this contact
  const { data: proposals } = await supabase
    .from('documents')
    .select('signing_status, created_at')
    .or(`primary_contact_id.eq.${contactId},generated_from_contact_id.eq.${contactId}`)
    .order('created_at', { ascending: false })
    .limit(1);

  const breakdown = {};
  let rawPositive = 0;
  let activePenalty = 0;
  let activeMax = 0;

  // Hard rule: fully signed → 100 (checked after data fetch to keep code linear)
  const latestProposal = proposals?.[0] || null;
  if (latestProposal?.signing_status === 'fully_signed') {
    await supabase.from('contacts')
      .update({ deal_health_score: 100, deal_health_breakdown: { fully_signed: true }, deal_health_computed_at: nowIso })
      .eq('id', contactId);
    return;
  }

  // ── Signal 1: Proposal lifecycle (max 25, can go negative) ──────────────────
  let s1 = 0;
  if (latestProposal) {
    const proposalAgeDays = (nowMs - new Date(latestProposal.created_at).getTime()) / 86400000;
    const proposalViewed  = rows.some(a => a.activity_type === 'proposal_viewed');

    if (latestProposal.signing_status === 'partially_signed') {
      s1 = 18;
    } else if (proposalViewed) {
      s1 = 18;
    } else if (proposalAgeDays < 7) {
      s1 = 10;
    } else if (proposalAgeDays < 21) {
      s1 = 5;
    } else {
      s1 = -5; // stalling — sent but unseen for 3+ weeks
    }
  }
  if (s1 >= 0) { rawPositive += s1; activeMax += 25; }
  else          { activePenalty += s1; }
  breakdown.s1_proposal = s1;

  // ── Signal 2: They engaged back (max 20) ────────────────────────────────────
  const engagedBack = rows.some(a => ENGAGED_BACK_TYPES.has(a.activity_type));
  const s2 = engagedBack ? 20 : 0;
  rawPositive += s2; activeMax += 20;
  breakdown.s2_engaged_back = s2;

  // ── Signal 3: Qualified engagement volume last 30 days (max 20) ─────────────
  const recentQualifiedCount = rows.filter(a => QUALIFIED_TYPES.has(a.activity_type) && a.occurred_at >= days30Iso).length;
  const s3 = recentQualifiedCount === 0 ? 0 : recentQualifiedCount === 1 ? 8 : recentQualifiedCount === 2 ? 14 : 20;
  rawPositive += s3; activeMax += 20;
  breakdown.s3_volume = s3;

  // ── Signal 4: Last meaningful activity recency (max 15) ─────────────────────
  const lastQualifiedRow = rows.find(a => QUALIFIED_TYPES.has(a.activity_type));
  let s4 = 0;
  if (lastQualifiedRow) {
    const d = (nowMs - new Date(lastQualifiedRow.occurred_at).getTime()) / 86400000;
    s4 = d < 7 ? 15 : d < 14 ? 10 : d < 30 ? 5 : d < 60 ? 2 : 0;
  }
  rawPositive += s4; activeMax += 15;
  breakdown.s4_recency = s4;

  // ── Signal 5: Stage velocity (penalty only, max = 0) ────────────────────────
  // Only fires when Signal 4 = 0 (no recent engagement)
  let s5 = 0;
  if (s4 === 0 && contact.pipeline_stage_updated_at) {
    const daysInStage = (nowMs - new Date(contact.pipeline_stage_updated_at).getTime()) / 86400000;
    s5 = daysInStage > 60 ? -15 : daysInStage > 30 ? -10 : daysInStage > 14 ? -5 : 0;
  }
  activePenalty += s5; // max = 0, does NOT add to activeMax
  breakdown.s5_velocity = s5;

  // ── Signal 6: Pipeline stage position (max 10) ──────────────────────────────
  const stagePoints = { evaluating: 10, interested: 6, aware: 3, identified: 0 };
  const s6 = stagePoints[contact.pipeline_stage] ?? 0;
  rawPositive += s6; activeMax += 10;
  breakdown.s6_stage = s6;

  // ── Signal 7: Deal value defined (max 5) ────────────────────────────────────
  const s7 = contact.deal_value !== null && contact.deal_value !== undefined ? 5 : 0;
  rawPositive += s7; activeMax += 5;
  breakdown.s7_deal_value = s7;

  // ── Signals 8, 9, 13: Meeting note taker signals ────────────────────────────
  const meetingsWithTranscripts = rows.filter(a =>
    a.activity_type === 'meeting_held' &&
    a.raw_data?.summary &&
    a.raw_data.summary !== 'Meeting recorded'
  );

  // Signal 8: Meeting quality (max 15, recency-weighted, half-life 60 days)
  let s8 = null;
  if (meetingsWithTranscripts.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const m of meetingsWithTranscripts) {
      const daysAgo = (nowMs - new Date(m.occurred_at).getTime()) / 86400000;
      const weight  = Math.exp(-daysAgo / 60);
      let pts = 0;
      if (m.raw_data.summary)                    pts += 1;
      if (m.raw_data.pain_points?.length > 0)    pts += 2;
      if (m.raw_data.budget_signal)              pts += 3;
      if (m.raw_data.timeline)                   pts += 2;
      // max 8 pts per meeting
      weightedSum += pts * weight;
      totalWeight += weight;
    }
    const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    s8 = Math.round((avgScore / 8) * 15);
    rawPositive += s8; activeMax += 15;
  }
  breakdown.s8_meeting_quality = s8;

  // Signal 9: Next steps clarity (max 10) — most recent meeting with transcript
  let s9 = null;
  if (meetingsWithTranscripts.length > 0) {
    const lastMeeting = meetingsWithTranscripts[0]; // desc order, most recent first
    const items = lastMeeting.raw_data.action_items || [];
    s9 = items.length >= 2 ? 10 : items.length === 1 ? 5 : 0;
    rawPositive += s9; activeMax += 10;
  }
  breakdown.s9_next_steps = s9;

  // Signal 13: Competitive risk (penalty only, max = 0)
  // Only counts competitors_mentioned with confidence >= 0.7
  let s13 = null;
  const recentTranscriptMeetings = meetingsWithTranscripts.filter(m => m.occurred_at >= days60Iso);
  if (recentTranscriptMeetings.length > 0) {
    const competitorNames = new Set();
    for (const m of recentTranscriptMeetings) {
      for (const c of (m.raw_data.competitors_mentioned || [])) {
        if (typeof c === 'object' && c.confidence >= 0.7) competitorNames.add(c.name);
        else if (typeof c === 'string') competitorNames.add(c); // backwards compat: plain string
      }
    }
    s13 = competitorNames.size >= 2 ? -15 : competitorNames.size === 1 ? -10 : 0;
    activePenalty += s13; // max = 0, does NOT add to activeMax
  }
  breakdown.s13_competitive_risk = s13;

  // ── Signal 10: Website revisit (max 5, conditional on RB2B/visitor-ID) ──────
  // Only active if contact has ANY website_revisit events (signals RB2B is wired)
  let s10 = null;
  if (rows.some(a => a.activity_type === 'website_revisit')) {
    const hasRecentRevisit = rows.some(a => a.activity_type === 'website_revisit' && a.occurred_at >= days30Iso);
    s10 = hasRecentRevisit ? 5 : 0;
    rawPositive += s10; activeMax += 5;
  }
  breakdown.s10_revisit = s10;

  // ── Signals 11, 12: Enrichment-conditional signals ──────────────────────────
  let s11 = null;
  let s12 = null;

  if (contact.company_id) {
    // Signal 11: Stakeholder coverage (max 15) — distinct contacts at this
    // company with a qualified interaction in the last 60 days.
    const { data: companyContacts } = await supabase
      .from('contacts')
      .select('id')
      .eq('company_id', contact.company_id);
    const companyContactIds = (companyContacts || []).map(c => c.id);
    const stakeholderRows = companyContactIds.length
      ? await listActivities(supabase, {
          contactIds: companyContactIds,
          since: days60Iso,
          types: [...QUALIFIED_TYPES],
          limit: 500,
        })
      : [];
    const distinctStakeholders = new Set(stakeholderRows.map(r => r.contact_id)).size;
    s11 = distinctStakeholders >= 3 ? 15 : distinctStakeholders === 2 ? 10 : 5;
    rawPositive += s11; activeMax += 15;
    breakdown.s11_stakeholders = s11;
  }

  if (contact.seniority) {
    const DM_SENIORITY = new Set(['c_suite', 'vp', 'director']);

    if (DM_SENIORITY.has(contact.seniority) && engagedBack) {
      // Case A: contact is DM and has responded
      s12 = 15;
    } else if (!DM_SENIORITY.has(contact.seniority) && contact.company_id) {
      // Case B/C: contact is IC/manager — check for engaged senior at same company
      const { data: seniorContacts } = await supabase
        .from('contacts')
        .select('id')
        .eq('company_id', contact.company_id)
        .in('seniority', ['c_suite', 'vp'])
        .neq('id', contactId);

      if (seniorContacts?.length > 0) {
        const seniorActivity = await listActivities(supabase, {
          contactIds: seniorContacts.map(c => c.id),
          since: days60Iso,
          types: [...QUALIFIED_TYPES],
          limit: 1,
        });
        s12 = seniorActivity.length > 0 ? 15 : 0;
      } else {
        s12 = 0; // Case C: IC/manager, no senior contact at company
      }
    } else {
      s12 = 0; // DM exists but hasn't engaged back
    }

    rawPositive += s12; activeMax += 15;
  }
  breakdown.s12_decision_maker = s12 ?? null;

  // ── Final calculation ────────────────────────────────────────────────────────
  const netRaw    = rawPositive + activePenalty;
  const score     = activeMax > 0 ? Math.max(0, Math.min(100, Math.round((netRaw / activeMax) * 100))) : null;
  const completeness = Math.round((activeMax / FULL_MAX) * 100) / 100;

  breakdown.active_max   = activeMax;
  breakdown.completeness = completeness;

  const updatePayload = {
    deal_health_score:       score,
    deal_health_breakdown:   breakdown,
    deal_health_active_max:  activeMax,
    deal_health_computed_at: nowIso,
  };
  // Skip future-dated rows entirely — they're bad data, not real engagement,
  // and writing them (clamped or not) bumps the contact to the top of the sort.
  if (lastQualifiedRow && lastQualifiedRow.occurred_at <= nowIso) {
    updatePayload.last_activity_at = lastQualifiedRow.occurred_at;
  }

  await supabase.from('contacts').update(updatePayload).eq('id', contactId);

  // Propagate to company-level score if this contact belongs to a company
  if (contact.company_id) {
    await updateCompanyDealHealthScore(supabase, contact.company_id);
  }
}

// Returns a stakeholder weight based on seniority/title so senior buyers count more
function stakeholderWeight(seniority, jobTitle) {
  const s = (seniority || '').toLowerCase();
  const t = (jobTitle  || '').toLowerCase();
  if (s === 'c_suite' || /\b(ceo|cto|cfo|coo|cpo|cmo|founder|owner|president)\b/.test(t)) return 3;
  if (s === 'vp'      || /\b(vp|vice.?president|director|head of)\b/.test(t))              return 2;
  return 1;
}

// Aggregate deal health for a company: seniority-weighted average of active contacts' scores.
// C-level/Founder → weight 3, VP/Director → weight 2, everyone else → weight 1.
// A disengaged DM naturally drags the company score down even if a champion looks healthy.
export async function updateCompanyDealHealthScore(supabase, companyId) {
  const { data: rows } = await supabase
    .from('contacts')
    .select('deal_health_score, seniority, job_title')
    .eq('company_id', companyId)
    .neq('pipeline_stage', 'client')
    .not('deal_health_score', 'is', null);

  if (!rows?.length) {
    await supabase.from('companies')
      .update({ deal_health_score: null, deal_health_computed_at: new Date().toISOString() })
      .eq('id', companyId);
    return;
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of rows) {
    const w = stakeholderWeight(r.seniority, r.job_title);
    weightedSum += r.deal_health_score * w;
    totalWeight += w;
  }
  const score = Math.round(weightedSum / totalWeight);

  await supabase.from('companies')
    .update({ deal_health_score: score, deal_health_computed_at: new Date().toISOString() })
    .eq('id', companyId);
}

// Keep old name as alias so any missed call sites don't crash at runtime
export const updateConnectionScore = updateDealHealthScore;


// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSeniority(raw) {
  if (!raw) return null;
  const r = raw.toLowerCase();
  if (r.includes('c_suite') || r.includes('founder') || r.includes('owner') || r.includes('c-suite')) return 'c_suite';
  if (r.includes('vp') || r.includes('vice')) return 'vp';
  if (r.includes('director')) return 'director';
  if (r.includes('manager')) return 'manager';
  return 'ic';
}

function normalizeDepartment(raw) {
  if (!raw) return null;
  const r = raw.toLowerCase();
  if (r.includes('sales'))       return 'sales';
  if (r.includes('marketing'))   return 'marketing';
  if (r.includes('engineering') || r.includes('product')) return 'engineering';
  if (r.includes('operations'))  return 'ops';
  return raw;
}
