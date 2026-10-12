#!/usr/bin/env node
// Seed a HubSpot TEST portal with a realistic pipeline. WRITES. Never point this at a
// customer portal.
//
// WHY THIS EXISTS
//
// A fresh developer test portal has two sample contacts, one company and zero deals. You
// cannot test deal linking, stage history, won/lost classification, or any downstream
// pipeline calculation against zero deals. This creates ~30 deals spread across the
// portal's real stage vocabulary, moves them through stages so HubSpot records genuine
// property history, and attaches calls, meetings and notes. The seeded portal is then the
// fixture every mapper is verified against.
//
// SAFETY
//   - Only reads HUBSPOT_TEST_TOKEN (never HUBSPOT_TOKEN), and requires --yes-test-portal.
//   - Refuses to run if the portal already holds more than 100 deals (looks real).
//   - Every record it creates is prefixed "[nous-seed]" so --wipe can find and delete them.
//
// Run:  node scripts/hubspot-seed-test-portal.mjs --env .env --yes-test-portal
//       node scripts/hubspot-seed-test-portal.mjs --env .env --yes-test-portal --wipe
//
// Limitation: HubSpot stamps property history at write time, so stage transitions all
// carry today's timestamp. Engagement hs_timestamp values ARE backdated across the last
// year, so timeline logic can be exercised; stage-duration logic needs a real portal.

import { readFileSync } from 'node:fs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback;
}

if (!arg('yes-test-portal')) {
  console.error('Refusing: pass --yes-test-portal to confirm this is a throwaway test portal.');
  process.exit(1);
}

function resolveToken() {
  if (process.env.HUBSPOT_TEST_TOKEN) return process.env.HUBSPOT_TEST_TOKEN;
  const envPath = arg('env', '.env');
  try {
    const line = readFileSync(envPath, 'utf8').split(/\r?\n/).find(l => l.startsWith('HUBSPOT_TEST_TOKEN='));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through */ }
  return null;
}
const TOKEN = resolveToken();
if (!TOKEN) { console.error('HUBSPOT_TEST_TOKEN not found (deliberately not HUBSPOT_TOKEN).'); process.exit(1); }

const BASE = 'https://api.hubapi.com';
const SEED = '[nous-seed]';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function hs(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (res.status === 429) { await sleep(2000); return hs(path, init); }
  return { status: res.status, ok: res.ok, body };
}
const why = (r) => (typeof r.body === 'object' && r.body ? r.body.message : String(r.body)).slice(0, 140);

// Per-object tallies. A 403 here is a scope report, not a failure to hide.
const tally = {};
function note(kind, r) {
  const t = (tally[kind] ??= { ok: 0, fail: 0, firstError: null });
  if (r.ok) t.ok++; else { t.fail++; t.firstError ??= `${r.status} ${why(r)}`; }
}

async function create(object, properties) {
  const r = await hs(`/crm/v3/objects/${object}`, { method: 'POST', body: JSON.stringify({ properties }) });
  note(object, r);
  return r.ok ? r.body.id : null;
}
async function patch(object, id, properties) {
  const r = await hs(`/crm/v3/objects/${object}/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
  note(`${object}:patch`, r);
  return r.ok;
}
// Default association via v4, so we never have to know HubSpot's numeric typeIds.
async function associate(from, fromId, to, toId) {
  const r = await hs(`/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`, { method: 'PUT' });
  note(`assoc:${from}->${to}`, r);
  return r.ok;
}

// --- wipe ---------------------------------------------------------------------

// List every record and filter on the prefix client-side. Search's CONTAINS_TOKEN
// tokenises on punctuation, so "[nous-seed]" is not reliably matchable server-side; a
// test portal is small enough that a full list is the honest way to find our own rows.
async function findSeeded(object, nameProp) {
  const ids = [];
  let after;
  do {
    const r = await hs(`/crm/v3/objects/${object}?limit=100&properties=${nameProp}${after ? `&after=${after}` : ''}`);
    if (!r.ok) { console.log(`  ${object}: list ${r.status} ${why(r)}`); break; }
    for (const x of r.body.results ?? []) {
      if (String(x.properties?.[nameProp] ?? '').startsWith(SEED)) ids.push(x.id);
    }
    after = r.body.paging?.next?.after;
  } while (after);
  return ids;
}

async function wipe() {
  const targets = [
    ['calls', 'hs_call_title'], ['meetings', 'hs_meeting_title'], ['notes', 'hs_note_body'],
    ['deals', 'dealname'], ['contacts', 'firstname'], ['companies', 'name'],
  ];
  for (const [object, prop] of targets) {
    const ids = await findSeeded(object, prop);
    let gone = 0;
    for (const id of ids) {
      const r = await hs(`/crm/v3/objects/${object}/${id}`, { method: 'DELETE' });
      if (r.ok) gone++;
      await sleep(120);
    }
    console.log(`  ${object.padEnd(10)} found ${ids.length}, deleted ${gone}`);
  }
}

// --- seed ---------------------------------------------------------------------

// Domains must be a real-looking TLD (HubSpot rejects `.example` addresses) and `industry`
// is an enumeration, so the keyword is matched against the portal's own option list at
// run time rather than guessed.
const COMPANIES = [
  ['Northwind Logistics', 'northwind-logistics-seed.com', 'logistics'],
  ['Brightline Health', 'brightline-health-seed.com', 'health'],
  ['Cobalt Fintech', 'cobalt-fintech-seed.com', 'financial'],
  ['Meridian Manufacturing', 'meridian-mfg-seed.com', 'machinery'],
  ['Sable Media Group', 'sablemedia-seed.com', 'media'],
  ['Quarry Analytics', 'quarry-analytics-seed.com', 'software'],
];

// Resolve a keyword to one of the portal's allowed `industry` values. Returns null (omit
// the field) rather than sending a value HubSpot would reject.
async function industryResolver() {
  const r = await hs('/crm/v3/properties/companies/industry');
  const options = r.ok ? (r.body.options ?? []) : [];
  return (keyword) => {
    const hit = options.find(o => `${o.label} ${o.value}`.toLowerCase().includes(keyword));
    return hit ? hit.value : null;
  };
}
const FIRST = ['Halvard', 'Marcus', 'Elena', 'Tomas', 'Aisha', 'Jordan', 'Wei', 'Sofia', 'Daniel', 'Naomi', 'Kwame', 'Solveig'];
const TITLES = ['VP Sales', 'Head of RevOps', 'CFO', 'Director of Operations', 'CTO', 'Procurement Lead'];

const OBJECTIONS = [
  'Budget is frozen until the new fiscal year; asked whether we can start with a pilot.',
  'They are already trialling a competitor and want a side-by-side before committing.',
  'Security review required; asked for SOC 2 report and a DPA before legal will engage.',
  'Decision maker was not on the call; the champion will bring it to the CFO next week.',
  'Pricing came in higher than the number they had in mind; asked about annual discount.',
  'Integration with their existing CRM is the main concern; asked for a technical call.',
];
const NEXT_STEPS = [
  'Send pricing proposal by Friday.', 'Schedule technical deep-dive with their engineering lead.',
  'Share two customer references in the same industry.', 'Follow up after their board meeting.',
  'Send the security questionnaire responses.', 'Book the executive alignment call.',
];

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const pick = (arr, i) => arr[i % arr.length];

async function seed() {
  // Guard: does this look like a real portal?
  const count = await hs('/crm/v3/objects/deals/search', { method: 'POST', body: JSON.stringify({ limit: 1 }) });
  const existing = count.body?.total ?? 0;
  if (existing > 100) { console.error(`Refusing: portal already has ${existing} deals. This does not look like a test portal.`); process.exit(1); }

  // Their real stage vocabulary — the seed adopts it rather than inventing one.
  const pl = await hs('/crm/v3/pipelines/deals');
  if (!pl.ok) { console.error(`pipelines ${pl.status} ${why(pl)}`); process.exit(1); }
  const pipeline = pl.body.results[0];
  const stages = pipeline.stages.slice().sort((a, b) => a.displayOrder - b.displayOrder);
  const open = stages.filter(s => s.metadata?.isClosed !== 'true');
  const won  = stages.find(s => s.metadata?.isClosed === 'true' && Number(s.metadata?.probability) === 1);
  const lost = stages.find(s => s.metadata?.isClosed === 'true' && Number(s.metadata?.probability) === 0);
  console.log(`pipeline "${pipeline.label}": ${open.length} open stages, won=${won?.label}, lost=${lost?.label}`);

  // Owner to attribute deals to, if the scope allows.
  const ow = await hs('/crm/v3/owners?limit=5');
  const ownerIds = ow.ok ? (ow.body.results ?? []).map(o => o.id) : [];
  console.log(`owners readable: ${ow.ok ? ownerIds.length : `no (${ow.status})`}`);

  // Companies + contacts. Falls back to the portal's existing ones if contacts.write is missing.
  const industryOf = await industryResolver();
  const companyIds = [];
  for (const [name, domain, keyword] of COMPANIES) {
    const industry = industryOf(keyword);
    const id = await create('companies', { name: `${SEED} ${name}`, domain, ...(industry ? { industry } : {}) });
    if (id) companyIds.push(id);
    await sleep(120);
  }
  const contactIds = [];
  for (let i = 0; i < 12; i++) {
    const company = companyIds.length ? companyIds[i % companyIds.length] : null;
    const id = await create('contacts', {
      firstname: `${SEED} ${pick(FIRST, i)}`, lastname: `Seed${i + 1}`,
      email: `${pick(FIRST, i).toLowerCase()}.seed${i + 1}@${pick(COMPANIES, i)[1]}`,
      jobtitle: pick(TITLES, i),
    });
    if (id) { contactIds.push({ id, company }); if (company) await associate('contacts', id, 'companies', company); }
    await sleep(120);
  }
  if (!contactIds.length) {
    const ex = await hs('/crm/v3/objects/contacts?limit=10');
    for (const c of ex.body?.results ?? []) contactIds.push({ id: c.id, company: null });
    const exc = await hs('/crm/v3/objects/companies?limit=10');
    for (const c of exc.body?.results ?? []) companyIds.push(c.id);
    console.log(`contacts.write unavailable — reusing ${contactIds.length} existing contacts, ${companyIds.length} companies`);
  }

  // 30 deals. Outcome mix: 8 won, 7 lost, 15 open spread across the open stages.
  const dealIds = [];
  for (let i = 0; i < 30; i++) {
    const outcome = i < 8 ? 'won' : i < 15 ? 'lost' : 'open';
    const contact = contactIds[i % contactIds.length];
    const company = contact.company ?? (companyIds.length ? companyIds[i % companyIds.length] : null);
    const amount = 8000 + ((i * 7919) % 90000);
    const props = {
      dealname: `${SEED} Deal ${i + 1} — ${pick(COMPANIES, i)[0]}`,
      amount: String(amount), pipeline: pipeline.id, dealstage: open[0].id,
      closedate: daysAgo(outcome === 'open' ? -30 - (i % 60) : 10 + (i * 11) % 300),
    };
    if (ownerIds.length) props.hubspot_owner_id = pick(ownerIds, i);
    const id = await create('deals', props);
    if (!id) continue;
    dealIds.push({ id, contact: contact.id, company, outcome, i });
    if (company) await associate('deals', id, 'companies', company);
    await associate('deals', id, 'contacts', contact.id);

    // Walk the stages so HubSpot writes genuine dealstage history.
    const hops = outcome === 'open' ? 1 + (i % open.length) : open.length;
    for (let s = 1; s < Math.min(hops, open.length); s++) { await patch('deals', id, { dealstage: open[s].id }); await sleep(150); }
    if (outcome === 'won' && won)   await patch('deals', id, { dealstage: won.id });
    if (outcome === 'lost' && lost) await patch('deals', id, { dealstage: lost.id });
    await sleep(150);
  }

  // Engagements, backdated across the last year, tied to contact + deal.
  for (const d of dealIds) {
    const base = 20 + (d.i * 13) % 320;
    const callId = await create('calls', {
      hs_timestamp: daysAgo(base), hs_call_title: `${SEED} Discovery call — deal ${d.i + 1}`,
      hs_call_body: pick(OBJECTIONS, d.i), hs_call_direction: 'OUTBOUND', hs_call_status: 'COMPLETED',
      hs_call_duration: String(600000 + (d.i % 5) * 300000),
    });
    if (callId) { await associate('calls', callId, 'contacts', d.contact); await associate('calls', callId, 'deals', d.id); }
    const meetId = await create('meetings', {
      hs_timestamp: daysAgo(base - 7), hs_meeting_title: `${SEED} Demo — deal ${d.i + 1}`,
      hs_meeting_body: `Demo covering core workflow. ${pick(NEXT_STEPS, d.i)}`,
      hs_meeting_start_time: daysAgo(base - 7), hs_meeting_end_time: new Date(Date.parse(daysAgo(base - 7)) + 45 * 60000).toISOString(),
      hs_meeting_outcome: d.outcome === 'lost' ? 'COMPLETED' : 'COMPLETED',
    });
    if (meetId) { await associate('meetings', meetId, 'contacts', d.contact); await associate('meetings', meetId, 'deals', d.id); }
    if (d.i % 2 === 0) {
      const noteId = await create('notes', {
        hs_timestamp: daysAgo(base - 9), hs_note_body: `${SEED} Rep note: ${pick(NEXT_STEPS, d.i + 1)} ${d.outcome === 'lost' ? 'Went quiet after this.' : ''}`,
      });
      if (noteId) { await associate('notes', noteId, 'contacts', d.contact); await associate('notes', noteId, 'deals', d.id); }
    }
    await sleep(200);
  }
}

// --- run ----------------------------------------------------------------------

if (arg('wipe')) {
  console.log('wiping seeded records...');
  await wipe();
} else {
  console.log('seeding...');
  await seed();
}

console.log('\n-- tally --');
for (const [kind, t] of Object.entries(tally)) {
  console.log(`  ${kind.padEnd(24)} ok=${String(t.ok).padEnd(4)} fail=${String(t.fail).padEnd(4)} ${t.firstError ?? ''}`);
}
