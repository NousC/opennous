// Contact enrichment + ICP scoring — fires after new contact creation.
// Priority: Apollo BYOK (if enabled) → Prospeo BYOK → built-in Prospeo key.
// scoreICP runs after every successful enrichment.

import Anthropic, { setUser } from 'useleak';
import { listNotes, recordEnrichmentObservations, recordObservation, isMemberUrnLinkedInUrl, upsertIdentifier } from '@nous/core';
import { logActivity } from './activity.mjs';
import { upsertCompany } from './resolveContact.mjs';
import { decrypt } from './encryption.mjs';

// A member-URN URL (/in/ACoAA…) is an encoded id, not a resolvable public
// profile — external finders choke on it. Treat as "no usable URL".
function usableLinkedInUrl(url) {
  return url && !isMemberUrnLinkedInUrl(url) ? url : null;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Attribute fields we write as observations with the TRUE enrichment source
// (recordEnrichmentObservations) and therefore STRIP from the contacts-view
// update — otherwise the view trigger re-emits them tagged with the record's
// origin source and erases provenance. linkedin_url is kept on the update so the
// trigger still attaches it as an identifier. See docs/crm-hygiene-phase-1b-spec.md Task 0.
const ENRICH_STRIP = ['job_title', 'seniority', 'department', 'company', 'phone', 'city', 'country'];

async function logSysEvent(supabase, workspaceId, source, eventType, summary, contactId, metadata) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source, event_type: eventType,
      summary: summary || null, contact_id: contactId || null,
      metadata: metadata || {}, occurred_at: new Date().toISOString(),
    });
  } catch { /* non-critical */ }
}

async function getProviderKey(supabase, workspaceId, providerName, requireEnrichmentToggle = false) {
  const { data: provider } = await supabase.from('workflow_providers')
    .select('id').eq('name', providerName).maybeSingle();
  if (!provider?.id) return null;

  const { data } = await supabase.from('workflow_provider_connections')
    .select('encrypted_credentials')
    .eq('workspace_id', workspaceId).eq('provider_id', provider.id).eq('is_verified', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data?.encrypted_credentials) return null;
  if (requireEnrichmentToggle && !data.encrypted_credentials.use_for_enrichment) return null;

  try { return decrypt(data.encrypted_credentials.api_key) || null; } catch { return null; }
}

// ── ICP scoring ───────────────────────────────────────────────────────────────

export async function scoreICP(supabase, workspaceId, contact) {
  setUser({ id: String(workspaceId) });
  const profileLines = [
    contact.job_title  && `Title: ${contact.job_title}`,
    contact.seniority  && `Seniority: ${contact.seniority}`,
    contact.department && `Department: ${contact.department}`,
    contact.company    && `Company: ${contact.company}`,
  ].filter(Boolean);
  if (!profileLines.length) return;

  const memories = await listNotes(supabase, workspaceId, {
    categories: ['ICP', 'Market', 'Company', 'Product'],
    limit: 60,
  });

  const profile = profileLines.join('\n');
  const prompt = memories.length
    ? `Workspace ICP criteria:\n${memories.map(m => `[${m.category}] ${m.content}`).join('\n')}\n\nContact:\n${profile}\n\nScore 0-100 and give a one-sentence reason. JSON only: {"score":<int>,"fit":<bool>,"reasoning":"<sentence>"}`
    : `Contact:\n${profile}\n\nScore this B2B contact's ICP fit 0-100 based on role alone. C-suite/VP/Director=high(75-95), Manager/Senior=medium(45-70), IC/unknown=low(20-40). JSON only: {"score":<int>,"fit":<bool>,"reasoning":"<sentence>"}`;

  try {
    const msg = await anthropic.messages.create({
      feature: 'icp-score-on-enrich',
      model: 'claude-haiku-4-5-20251001', max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const json = JSON.parse(msg.content[0].text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (typeof json.score !== 'number') return;

    await supabase.from('contacts').update({
      icp_score:     json.score,
      icp_fit:       json.fit ?? json.score >= 70,
      icp_reasoning: json.reasoning,
      icp_scored_at: new Date().toISOString(),
    }).eq('id', contact.id);

    // ICP scoring is shown in Record Details, not the activity timeline — no logActivity.

    console.log(`[ICP_SCORE] contact=${contact.id} score=${json.score} fit=${json.fit} (${memories.length ? 'workspace criteria' : 'generic'})`);
  } catch (e) {
    console.warn('[ICP_SCORE] Failed:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  if (r.includes('sales'))     return 'sales';
  if (r.includes('marketing')) return 'marketing';
  if (r.includes('engineering') || r.includes('product')) return 'engineering';
  if (r.includes('operations')) return 'ops';
  return raw;
}

// ── Free LinkedIn-sourced enrichment ───────────────────────────────────────────

// LinkedIn headlines rarely fit a clean "Role @ Company" regex (e.g. "Fractional
// CMO / Head of Growth / GTM Advisor | +12y exp | SaaS"). When the cheap parse
// misses, Haiku pulls the primary current role out of the free text. We already
// pay for a Haiku call to score ICP, so this adds no new vendor and no $ for email.
async function extractRoleFromHeadline(workspaceId, headline) {
  setUser({ id: String(workspaceId) });
  try {
    const msg = await anthropic.messages.create({
      feature: 'linkedin-headline-extract',
      model: 'claude-haiku-4-5-20251001', max_tokens: 150,
      messages: [{ role: 'user', content: `Extract the person's CURRENT primary job title and employer from this LinkedIn headline. Headlines often mix taglines, services, and multiple roles — pick the single current role and company. Use null for anything not clearly stated; never invent a company.\n\nHeadline: "${headline}"\n\nJSON only: {"job_title":<string|null>,"company":<string|null>,"seniority":<"c_suite"|"vp"|"director"|"manager"|"ic"|null>,"department":<string|null>}` }],
    });
    const j = JSON.parse(msg.content[0].text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}');
    return { job_title: j.job_title || null, company: j.company || null, seniority: j.seniority || null, department: j.department || null };
  } catch (e) {
    console.warn('[LI_HEADLINE_EXTRACT] failed:', e.message);
    return { job_title: null, company: null, seniority: null, department: null };
  }
}

// Populates structured fields from a Unipile profile (no paid provider) and scores
// ICP. job_title alone clears scoreICP's gate, so a LinkedIn-only contact becomes
// scoreable without ever spending on email enrichment. Only fills empty fields —
// never overwrites data a paid provider or the user already set.
export async function applyLinkedInProfile(supabase, contact, { jobTitle, company, companyDomain, photoUrl, email, phone, headline, publicIdentifier } = {}) {
  if (!contact?.id || !contact?.workspace_id) return;
  const workspaceId = contact.workspace_id;
  const updates = {};

  let seniority = jobTitle ? normalizeSeniority(jobTitle) : null;
  let department = null;
  // Fall back to LLM extraction when the regex parse left title/company empty.
  if ((!jobTitle || !company) && headline) {
    const ext = await extractRoleFromHeadline(workspaceId, headline);
    if (!jobTitle && ext.job_title) { jobTitle = ext.job_title; seniority = ext.seniority || normalizeSeniority(ext.job_title); }
    if (!company && ext.company) company = ext.company;
    if (ext.department) department = normalizeDepartment(ext.department);
  }

  if (jobTitle && !contact.job_title) {
    updates.job_title = jobTitle;
    updates.seniority = seniority;
    if (department) updates.department = department;
  }
  if (company && !contact.company) {
    const co = await upsertCompany(supabase, workspaceId, { name: company, domain: companyDomain || null });
    if (co?.id) updates.company_id = co.id;
    updates.company = company;
  }
  if (photoUrl && !contact.photo_url) updates.photo_url = photoUrl;
  if (phone && !contact.phone) updates.phone = phone;

  // Heal a member-URN linkedin_url (/in/ACoAA…) to the real public vanity URL when
  // Unipile gives us the handle. This is what makes the contact enrichable —
  // Prospeo/Apollo can resolve a real /in/<slug>, never the encoded form — and it
  // keeps member_id as the matching anchor while the URL becomes the scrapeable one.
  if (publicIdentifier && (!contact.linkedin_url || isMemberUrnLinkedInUrl(contact.linkedin_url))) {
    const vanity = `https://www.linkedin.com/in/${publicIdentifier}`;
    updates.linkedin_url = vanity;
    // Retire the stale member-URN active URL so the view surfaces the healed one,
    // then attach the vanity URL (reactivate-or-insert; the plain .upsert can't
    // target the partial active index).
    await supabase.from('entity_identifiers').update({ status: 'retired' })
      .eq('workspace_id', workspaceId).eq('entity_id', contact.id).eq('kind', 'linkedin_url')
      .eq('status', 'active').neq('value', vanity).then(null, () => {});
    await upsertIdentifier(supabase, workspaceId, contact.id, 'linkedin_url', vanity);
  }

  // Email from the LinkedIn profile (contact_info.emails) — register it as an
  // identity so resolution keys on it, then fill the column. Done separately from
  // the enrichment-observation set because email is an identifier, not just a claim.
  const cleanEmail = email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.toLowerCase().trim() : null;
  if (cleanEmail && !contact.email) {
    // Attach the email as an active identifier — this is what the contacts view
    // shows (it reads email from entity_identifiers, not the claim). upsertIdentifier
    // works against the partial active index; the old swallowed .upsert never landed.
    await upsertIdentifier(supabase, workspaceId, contact.id, 'email', cleanEmail);
    await recordObservation(supabase, {
      workspaceId, entityId: contact.id, kind: 'state', property: 'email',
      value: cleanEmail, source: 'linkedin', method: 'api', externalId: `li_email_${cleanEmail}`,
    }).catch(() => {});
  }

  if (!Object.keys(updates).length) {
    // Even with no claim-fields, we may have scored nothing yet — score if we have a title now.
    if (jobTitle || company) await scoreICP(supabase, workspaceId, { ...contact, job_title: jobTitle, company });
    return;
  }

  await recordEnrichmentObservations(supabase, workspaceId, contact.id, 'linkedin', updates);
  console.log(`[APPLY_LI] ${contact.id}: observations recorded (${Object.keys(updates).join(',')})`);
  const viewUpdate = { ...updates };
  for (const f of ENRICH_STRIP) delete viewUpdate[f];
  if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);
  logSysEvent(supabase, workspaceId, 'linkedin', 'enrichment_run',
    `Captured from LinkedIn: ${[updates.job_title, updates.company].filter(Boolean).join(' · ')}`,
    contact.id, { status: 'success', source: 'linkedin_profile', free: true }).catch(() => {});

  // Score with what we now know — title/company is enough; no paid call.
  await scoreICP(supabase, workspaceId, { ...contact, ...updates });
}

// ── Apollo path ───────────────────────────────────────────────────────────────

async function enrichViaApollo(supabase, contact, apolloKey) {
  const workspaceId = contact.workspace_id;
  await supabase.from('contacts').update({ enrichment_status: 'queued' }).eq('id', contact.id);
  try {
    // Pass email / usable linkedin_url / name + domain — so a lead with no email
    // but a real company domain still matches on name+domain.
    const match = { reveal_personal_emails: false, reveal_phone_number: false };
    const liUrl = usableLinkedInUrl(contact.linkedin_url);
    if (contact.email)      match.email            = contact.email;
    if (liUrl)              match.linkedin_url      = liUrl;
    if (contact.first_name) match.first_name        = contact.first_name;
    if (contact.last_name)  match.last_name         = contact.last_name;
    if (contact.domain)     match.domain            = contact.domain;
    if (contact.company)    match.organization_name = contact.company;
    const canMatch = match.email || match.linkedin_url
      || (match.first_name && match.last_name && (match.domain || match.organization_name));
    if (!canMatch) {
      await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
      return;
    }
    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify(match),
    });
    if (!res.ok) throw new Error(`Apollo ${res.status}: ${await res.text().catch(() => '')}`);
    const body = await res.json();
    const person = body.person;
    if (!person) throw new Error('No person in Apollo response');

    const org = person.organization || {};
    const updates = {
      enrichment_status: 'complete', enriched_at: new Date().toISOString(), enrichment_source: 'apollo',
      apollo_raw:  person,
      apollo_id:   person.id             || contact.apollo_id,
      linkedin_url: person.linkedin_url  || contact.linkedin_url,
      job_title:   person.title          || contact.job_title,
      seniority:   normalizeSeniority(person.seniority),
      department:  normalizeDepartment(person.departments?.[0]),
      phone:       person.phone_numbers?.[0]?.raw_number || contact.phone,
      city:        person.city    || null,
      country:     person.country || null,
    };

    if (org.name || org.primary_domain) {
      const co = await upsertCompany(supabase, workspaceId, { name: org.name, domain: org.primary_domain });
      if (co) { updates.company_id = co.id; updates.company = org.name; }
    }

    await recordEnrichmentObservations(supabase, workspaceId, contact.id, 'apollo', updates);
    const viewUpdate = { ...updates };
    for (const f of ENRICH_STRIP) delete viewUpdate[f];
    if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);
    await logActivity(supabase, {
      workspaceId, contactId: contact.id, companyId: updates.company_id || contact.company_id || null,
      type: 'enrichment_run', source: 'apollo',
      externalId: `apollo_enrich_${contact.id}`,
      occurredAt: new Date().toISOString(),
      description: 'Profile enriched via Apollo',
      summary: [updates.job_title, org.name].filter(Boolean).join(' at ') || null,
    }).catch(() => {});
    logSysEvent(supabase, workspaceId, 'apollo', 'enrichment_run',
      `Enriched: ${[person.name, updates.job_title, org.name].filter(Boolean).join(' · ')}`,
      contact.id, { status: 'success' }).catch(() => {});

    await scoreICP(supabase, workspaceId, { ...contact, ...updates });
  } catch (err) {
    console.error('[ENRICH_APOLLO]', contact.email, err.message);
    await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
    logSysEvent(supabase, workspaceId, 'apollo', 'enrichment_run',
      `Enrichment error: ${err.message}`, contact.id, { status: 'error' }).catch(() => {});
  }
}

// ── Prospeo path ──────────────────────────────────────────────────────────────

const FAKE_DOMAINS = /\.(import|csv|fake|test|example|placeholder|noemail)$/i;

async function enrichViaProspeo(supabase, contact, prospeoKey) {
  if (!prospeoKey) {
    await supabase.from('contacts').update({ enrichment_status: 'no_integration' }).eq('id', contact.id);
    return;
  }
  const workspaceId = contact.workspace_id;
  const realEmail = contact.email && !FAKE_DOMAINS.test(contact.email.split('@')[1] || '') ? contact.email : null;
  const liUrl = usableLinkedInUrl(contact.linkedin_url);
  if (!realEmail && !liUrl) {
    await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
    return;
  }

  await supabase.from('contacts').update({ enrichment_status: 'queued' }).eq('id', contact.id);
  try {
    const reqData = {};
    if (realEmail)          reqData.email        = realEmail;
    if (contact.first_name) reqData.first_name   = contact.first_name;
    if (contact.last_name)  reqData.last_name    = contact.last_name;
    if (liUrl)              reqData.linkedin_url = liUrl;

    const res = await fetch('https://api.prospeo.io/enrich-person', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-KEY': prospeoKey },
      body: JSON.stringify({ data: reqData }),
    });
    const body = await res.json();

    if (body.error) {
      if (body.error_code === 'NO_MATCH') {
        await supabase.from('contacts').update({ enrichment_status: 'not_found' }).eq('id', contact.id);
        return;
      }
      throw new Error(`Prospeo ${body.error_code || res.status}`);
    }

    const person = body.person;
    if (!person) throw new Error('No person in Prospeo response');

    const currentJob = person.job_history?.find(j => j.current) || person.job_history?.[0];
    // ENRICH, don't OVERWRITE — only fill fields we don't already have (provider
    // data can be stale or a secondary role). Mirrors the API enrichment path.
    const updates = {
      enrichment_status: 'complete', enriched_at: new Date().toISOString(), enrichment_source: 'prospeo',
      apollo_raw:  person,
      apollo_id:   person.person_id     || contact.apollo_id,
      linkedin_url: contact.linkedin_url || person.linkedin_url,
      city:        contact.city    || person.location?.city    || null,
      country:     contact.country || person.location?.country || null,
    };
    if (contact.phone == null && person.mobile?.mobile) updates.phone = person.mobile.mobile;
    if (!contact.job_title && person.current_job_title) {
      updates.job_title  = person.current_job_title;
      updates.seniority  = normalizeSeniority(currentJob?.seniority);
      updates.department = normalizeDepartment(currentJob?.departments?.[0]);
    }

    const co = body.company;
    if (!contact.company && (co?.name || co?.website || co?.domain)) {
      const rawDomain = co.domain || co.website?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
      const company = await upsertCompany(supabase, workspaceId, { name: co.name, domain: rawDomain });
      if (company) { updates.company_id = company.id; updates.company = co.name; }
    }

    await recordEnrichmentObservations(supabase, workspaceId, contact.id, 'prospeo', updates);
    // Multi-position: full role history as a background `positions` fact (not shown
    // in record details, which renders only the primary). Preserves secondary roles
    // for agents/backend. Mirrors the API path.
    if (Array.isArray(person.job_history) && person.job_history.length) {
      await recordObservation(supabase, {
        workspaceId, entityId: contact.id, kind: 'state',
        property: 'positions', value: person.job_history,
        source: 'prospeo', method: 'enrichment', externalId: `prospeo_positions_${contact.id}`,
      }).catch(() => {});
    }
    const viewUpdate = { ...updates };
    for (const f of ENRICH_STRIP) delete viewUpdate[f];
    if (Object.keys(viewUpdate).length) await supabase.from('contacts').update(viewUpdate).eq('id', contact.id);
    await logActivity(supabase, {
      workspaceId, contactId: contact.id, companyId: updates.company_id || contact.company_id || null,
      type: 'enrichment_run', source: 'prospeo',
      externalId: `prospeo_enrich_${contact.id}`,
      occurredAt: new Date().toISOString(),
      description: 'Profile enriched via Prospeo',
      summary: [updates.job_title, updates.company].filter(Boolean).join(' at ') || null,
    }).catch(() => {});
    logSysEvent(supabase, workspaceId, 'prospeo', 'enrichment_run',
      `Enriched: ${[[contact.first_name, contact.last_name].filter(Boolean).join(' '), updates.job_title, updates.company].filter(Boolean).join(' · ')}`,
      contact.id, { status: 'success' }).catch(() => {});

    await scoreICP(supabase, workspaceId, { ...contact, ...updates });
  } catch (err) {
    console.error('[ENRICH_PROSPEO]', contact.email, err.message);
    await supabase.from('contacts').update({ enrichment_status: 'failed' }).eq('id', contact.id);
    logSysEvent(supabase, workspaceId, 'prospeo', 'enrichment_run',
      `Enrichment error: ${err.message}`, contact.id, { status: 'error' }).catch(() => {});
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function enrichContact(supabase, contact) {
  if (!contact?.id || !contact?.workspace_id) return;
  const hasNameDomain = !!(contact.first_name && contact.last_name && contact.domain);
  if (!contact.email && !usableLinkedInUrl(contact.linkedin_url) && !hasNameDomain) return;

  const apolloKey = await getProviderKey(supabase, contact.workspace_id, 'apollo', true);
  if (apolloKey) return enrichViaApollo(supabase, contact, apolloKey);

  const prospeoKey = await getProviderKey(supabase, contact.workspace_id, 'prospeo');
  return enrichViaProspeo(supabase, contact, prospeoKey || process.env.PROSPERO_API_KEY || null);
}
