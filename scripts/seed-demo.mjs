#!/usr/bin/env node
// Writes supabase/seed/demo.sql: a fictional demo workspace for screenshots and local poking (GET-757).
//
//   node scripts/seed-demo.mjs            regenerate supabase/seed/demo.sql
//
// Everything here is invented: the selling company (Fernpoint), 40 customer companies in four
// verticals, ~150 people, their tools and competitors. Domains use the reserved `.example` TLD;
// no real company, person or domain appears. Output is deterministic (seeded PRNG, ids derived
// from names), and every timestamp is written relative to now() so the data looks current
// whenever it is loaded.
//
// It writes through the tables the app reads: entities, entity_identifiers, claims (profile facts
// and note.* intel), observations (interaction.* events), relationships (works_at, belongs_to,
// stakeholder_of), predictions (icp_fit), workspace_graph_edges, graph_concepts and observation_deals,
// then calls refresh_entity_list_rows() so the Accounts list and the Graph
// (which read entity_list_rows) are filled.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'supabase', 'seed', 'demo.sql');

// ── determinism ────────────────────────────────────────────────────────────────
let seed = 757;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const uid = (...parts) => {
  const h = createHash('md5').update('nous-demo:' + parts.join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const q = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;
const ago = (minutes) => `now() - interval '${Math.round(minutes)} minutes'`;
const ahead = (days) => `now() + interval '${Math.round(days)} days'`;
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const DAY = 1440;

// ── the workspace ─────────────────────────────────────────────────────────────
const WS = uid('workspace');
const TEAM = uid('team');
const WS_ENTITY = uid('entity', 'workspace');
const SELLER = { name: 'Fernpoint', website: 'https://fernpoint.example' };
const REPS = [
  { key: 'owner', name: 'Avery Lindqvist', email: 'avery@fernpoint.example', role: 'owner', team: 'founder' },
  { key: 'ae1', name: 'Marisol Okafor', email: 'marisol@fernpoint.example', role: 'admin', team: 'member' },
  { key: 'ae2', name: 'Theo Bramwell', email: 'theo@fernpoint.example', role: 'member', team: 'member' },
].map(r => ({ ...r, authId: uid('auth', r.key), userId: uid('user', r.key) }));

// Invented tools and rivals. Deliberately not real products.
const RIVALS = ['Routewell', 'Cadence Grid', 'Tallybook', 'Routekeeper'];
const TOOLS = {
  logistics: ['spreadsheets', 'Dockyard TMS', 'a homegrown dispatch board', 'Ledgerline ERP', 'Shiftwell'],
  manufacturing: ['spreadsheets', 'Millrun MES', 'Ledgerline ERP', 'a paper traveler system', 'Shiftwell'],
  clinics: ['spreadsheets', 'ChairTime PM', 'Rosterly', 'a shared Outlook calendar', 'Ledgerline ERP'],
  field: ['spreadsheets', 'Truckroll FSM', 'a whiteboard', 'Ledgerline ERP', 'Rosterly'],
};

// ── companies (fictional) ─────────────────────────────────────────────────────
const VERTICALS = {
  logistics: {
    industry: 'Logistics & Freight',
    names: ['Harborline Freight', 'Ridgeway Haulage', 'Bluecanal Logistics', 'Tern Cold Chain', 'Ironleaf Carriers',
      'Meridian Crossdock', 'Saltmarsh Shipping', 'Gullwing Parcel', 'Copperfield Distribution', 'Larkspur Fleet Services'],
    desc: (n) => `${n} runs regional freight and warehousing with a mixed owned and contracted fleet.`,
    titles: { dm: ['VP Operations', 'COO', 'Director of Transportation', 'Head of Network Planning', 'CFO'],
      other: ['Dispatch Manager', 'Fleet Operations Manager', 'Warehouse Lead', 'Planning Analyst', 'Procurement Manager', 'IT Manager'] },
    subjects: ['Lane planning for Q{q}', 'Peak season capacity', 'Dispatch forecasting walkthrough', 'Driver roster pilot', 'Cross-dock scheduling', 'Fuel surcharge reporting'],
  },
  manufacturing: {
    industry: 'Specialty Manufacturing',
    names: ['Kestrel Precision Works', 'Ashbourne Coatings', 'Veldt Composites', 'Orrin Valve & Fitting', 'Pinecrest Plastics',
      'Granitebay Fabrication', 'Halyard Textiles', 'Brindle Foundry', 'Quarry Lane Ceramics', 'Tidewell Packaging'],
    desc: (n) => `${n} is a make-to-order manufacturer running two to four production shifts.`,
    titles: { dm: ['VP Manufacturing', 'Plant Director', 'CEO', 'Head of Operations', 'CFO'],
      other: ['Production Scheduler', 'Shift Supervisor', 'Continuous Improvement Lead', 'Materials Planner', 'Quality Manager', 'ERP Administrator'] },
    subjects: ['Shift planning for line {n}', 'Capacity model review', 'Overtime forecast', 'Changeover scheduling', 'Pilot scope: one plant', 'Labour cost reporting'],
  },
  clinics: {
    industry: 'Healthcare Clinics',
    names: ['Maplestone Dental Group', 'Clearbrook Physio', 'Willowmere Family Health', 'Sunpath Veterinary Partners', 'Oakridge Eye Care',
      'Harbourview Dermatology', 'Juniper Pediatrics Network', 'Stillwater Orthodontics', 'Fairmont Hearing Centers', 'Cedarline Urgent Care'],
    desc: (n) => `${n} operates a growing network of outpatient clinics under one management team.`,
    titles: { dm: ['COO', 'VP Clinic Operations', 'Chief Executive Officer', 'Director of Practice Operations', 'CFO'],
      other: ['Regional Practice Manager', 'Scheduling Coordinator', 'Clinic Manager', 'HR Business Partner', 'Finance Manager', 'Operations Analyst'] },
    subjects: ['Provider scheduling across {n} sites', 'Front-desk staffing model', 'New clinic opening plan', 'Utilisation report review', 'Pilot with two clinics', 'Holiday cover planning'],
  },
  field: {
    industry: 'Field Services',
    names: ['Brightline HVAC', 'Moss & Gable Roofing', 'Torchlight Electrical', 'Pebblecreek Pool Services', 'Evergrid Solar Installers',
      'Lanternfield Pest Control', 'Ravenhill Plumbing', 'Summitview Elevator Service', 'Coldharbor Refrigeration', 'Wrenfield Landscaping'],
    desc: (n) => `${n} dispatches technician crews across a metro region for install and service work.`,
    titles: { dm: ['Owner', 'VP Service Operations', 'General Manager', 'Director of Field Operations', 'CFO'],
      other: ['Service Manager', 'Dispatch Lead', 'Crew Scheduler', 'Operations Coordinator', 'Install Manager', 'Office Manager'] },
    subjects: ['Technician routing for {n} crews', 'Seasonal demand forecast', 'Dispatch board demo', 'Callback rate review', 'Pilot: one branch', 'Overtime and on-call planning'],
  },
};
const CITIES = [
  ['Columbus', 'United States'], ['Tulsa', 'United States'], ['Raleigh', 'United States'], ['Spokane', 'United States'],
  ['Milwaukee', 'United States'], ['Sacramento', 'United States'], ['Savannah', 'United States'], ['Boise', 'United States'],
  ['Hamilton', 'Canada'], ['Winnipeg', 'Canada'], ['Halifax', 'Canada'], ['Leeds', 'United Kingdom'], ['Bristol', 'United Kingdom'],
];
const FUNDING = ['Bootstrapped', 'Family-owned', 'PE-backed', 'Series B', 'Series C', 'PE-backed'];
const REVENUE = ['$10M-$25M', '$25M-$50M', '$50M-$100M', '$100M-$250M'];

const FIRST = ['Adaeze', 'Bram', 'Calla', 'Dorian', 'Elsbeth', 'Fintan', 'Greer', 'Hollis', 'Ines', 'Jasper', 'Kalinda', 'Lorcan',
  'Mireille', 'Nico', 'Odile', 'Pell', 'Quinlan', 'Rosalind', 'Soren', 'Tamsin', 'Ulric', 'Vesna', 'Wilder', 'Xanthe', 'Yorick',
  'Zelda', 'Anouk', 'Benedikt', 'Cosima', 'Desmond', 'Eilidh', 'Faustine', 'Gideon', 'Henrike', 'Idris', 'Juno', 'Kasimir',
  'Leocadia', 'Magnus', 'Nerys', 'Orla', 'Piers', 'Ramona', 'Stellan', 'Thea', 'Ugo', 'Verity', 'Wynn'];
const LAST = ['Ashcombe', 'Brightwater', 'Calloway', 'Duxbridge', 'Ellery', 'Fairweather', 'Galloway', 'Hartigan', 'Ingleby',
  'Jessop', 'Kilbride', 'Lockridge', 'Merriweather', 'Northcott', 'Oakhurst', 'Pemberton', 'Quayle', 'Rookwood', 'Stanhope',
  'Thistlewood', 'Underhill', 'Vantongeren', 'Whitlock', 'Yardley', 'Zellweger', 'Abernathy', 'Blackwood', 'Castellane',
  'Delacroix-Hart', 'Everleigh', 'Fenwick', 'Greenhalgh', 'Holloway', 'Iverson', 'Kittredge', 'Larkin', 'Montague', 'Okonkwo-Reyes'];

// ── intel themes: each is a pattern hub in the Graph, with sentences that fill it ───────────
// {co} company, {tool} their current tool, {rival} a competitor, {n} a number.
const THEMES = [
  { cat: 'pain', label: 'Schedules rebuilt by hand every week', lines: [
    'Rebuilds next week\'s schedule by hand every Thursday in {tool}; it takes most of a day.',
    'The planner keeps the real schedule in {tool} and nobody else can read it.',
    'Every change request means re-keying the plan in two places.'] },
  { cat: 'pain', label: 'Overtime spend nobody can forecast', lines: [
    'Overtime ran {n}% over budget last quarter and finance only found out at month end.',
    'They cannot say what next month\'s overtime will be until the payroll run.',
    'Overtime is the line item the CFO asks about in every review.'] },
  { cat: 'pain', label: 'No single view across sites', lines: [
    'Each site reports utilisation differently, so the weekly roll-up is done in {tool}.',
    'Head office sees site numbers a week late and cannot compare them.'] },
  { cat: 'goal', label: 'Open new sites without adding planners', lines: [
    'Wants to open {n} new locations this year without hiring another planner.',
    'Growth plan assumes the same ops team can run twice the volume.'] },
  { cat: 'goal', label: 'Cut overtime before budget season', lines: [
    'Target is to bring overtime down to under {n}% of hours by the next budget cycle.',
    'Board asked for a labour-cost plan before the annual budget.'] },
  { cat: 'objection', label: 'Worried about rollout effort', lines: [
    'Concerned the rollout will pull supervisors off the floor during peak.',
    'Last software rollout took nine months; does not want a repeat.',
    'Asked how much of their own IT time an implementation needs.'] },
  { cat: 'objection', label: 'Price against a spreadsheet', lines: [
    'Pushed back that a spreadsheet is free and mostly works.',
    'Asked why the per-site price is higher than {rival}.'] },
  { cat: 'competitor', label: `Evaluating ${RIVALS[0]}`, lines: [
    `Had a demo from ${RIVALS[0]} last month; liked the mobile app, not the reporting.`,
    `${RIVALS[0]} quoted them a lower first-year price with a three-year term.`] },
  { cat: 'competitor', label: `Using ${RIVALS[1]} at one site`, lines: [
    `One site already runs ${RIVALS[1]}; the others never adopted it.`,
    `Said ${RIVALS[1]} handles shifts but not demand forecasting.`] },
  { cat: 'status_quo', label: 'Runs planning in spreadsheets', lines: [
    'Planning lives in a shared spreadsheet with {n} tabs, one per site.',
    'Uses {tool} for scheduling and exports to a spreadsheet for everything else.'] },
  { cat: 'buying_signal', label: 'Asked for a pilot proposal', lines: [
    'Asked us to send a pilot proposal for two sites with a start date.',
    'Wants the order form this week so they can start before peak.',
    'Confirmed they will sign once legal approves the data terms.'] },
  { cat: 'budget', label: 'Budget sits with operations', lines: [
    'Has roughly ${n}k a year set aside for operations tooling.',
    'Anything over $50k needs CFO sign-off; below that the COO can approve.'] },
  { cat: 'timeline', label: 'Decision before peak season', lines: [
    'Wants a decision before peak season starts in {month}.',
    'Planning to pick a vendor this quarter, tied to the budget review.'] },
  { cat: 'authority', label: 'COO is the economic buyer', lines: [
    'The COO signs; the VP Operations runs the evaluation and will champion it.',
    'Finance has a veto on anything multi-year.'] },
  { cat: 'preference', label: 'Prefers async updates over calls', lines: [
    'Prefers a short written update over another call.',
    'Asked that we send recordings rather than book live demos for the wider team.'] },
  { cat: 'discovery', label: 'Found us through a peer', lines: [
    'Heard about Fernpoint from a peer at another {industry} company.',
    'Found us through the operations roundtable newsletter.'] },
  { cat: 'relationship', label: 'Knows our customer at another account', lines: [
    'Worked with our champion at {peer} before; they still talk monthly.',
    'Former colleague of the ops lead at {peer}.'] },
  { cat: 'risk_signal', label: 'Pilot stalled after reorg', lines: [
    'Pilot paused while they restructure regional management.'] },
  { cat: 'expansion_signal', label: 'Wants more sites on the plan', lines: [
    'Asked what it would cost to add the remaining {n} sites.'] },
];
const MONTHS = ['March', 'May', 'September', 'November'];

// ── build ─────────────────────────────────────────────────────────────────────
const out = [];
const counts = {};
const emit = (table, cols, rows) => {
  if (!rows.length) return;
  counts[table] = (counts[table] || 0) + rows.length;
  for (let i = 0; i < rows.length; i += 200) {
    out.push(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES\n  ${rows.slice(i, i + 200).map(r => `(${r.join(', ')})`).join(',\n  ')};`);
  }
};

const companies = [];
const people = [];
let ci = 0;
for (const [vkey, v] of Object.entries(VERTICALS)) {
  for (const name of v.names) {
    const id = uid('company', name);
    const [city, country] = CITIES[ci++ % CITIES.length];
    // A spread of fit and activity so the list and the graph show every state.
    const icp = Math.min(98, Math.max(34, Math.round(int(40, 96) + (vkey === 'logistics' || vkey === 'clinics' ? 4 : 0))));
    const lastTouchDays = pick([1, 2, 3, 5, 8, 12, 18, 26, 34, 45, 60, 85, 110, 140]);
    companies.push({
      id, name, vkey, v, icp, city, country, lastTouchDays,
      domain: `${slug(name)}.example`,
      employees: pick([120, 180, 240, 320, 450, 600, 850, 1200, 1800]),
      sites: int(3, 28),
      founded: int(1978, 2016),
      funding: pick(FUNDING), revenue: pick(REVENUE),
      tools: shuffle(TOOLS[vkey]).slice(0, 3),
    });
  }
}
const usedNames = new Set();
for (const c of companies) {
  const n = c.icp >= 80 ? int(4, 6) : c.icp >= 60 ? int(3, 5) : int(2, 3);
  const titles = [pick(c.v.titles.dm), ...shuffle(c.v.titles.other)];
  for (let i = 0; i < n; i++) {
    let first, last, full;
    do { first = pick(FIRST); last = pick(LAST); full = `${first} ${last}`; } while (usedNames.has(full));
    usedNames.add(full);
    // About one account in eight has nobody senior on the thread (the graph's "no budget holder" flag).
    const title = i === 0 && c.icp < 55 && chance(0.6) ? titles[1] : titles[i];
    const dm = /founder|ceo|owner|chief|president|\bvp\b|vice president|head of|director|cfo|coo|general manager/i.test(title);
    people.push({
      id: uid('person', c.name, full), company: c, first, last, title, dm,
      email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `@${c.domain}`,
      icp: Math.max(20, Math.min(99, c.icp + (dm ? int(0, 6) : -int(4, 18)))),
      seniority: dm ? (/(ceo|coo|cfo|chief|owner)/i.test(title) ? 'c_suite' : 'vp_director') : (/manager|lead/i.test(title) ? 'manager' : 'individual_contributor'),
      department: /financ|cfo/i.test(title) ? 'Finance' : /it |erp|it manager/i.test(title) ? 'IT' : /hr /i.test(title) ? 'HR' : 'Operations',
    });
  }
}

// workspace, team, users
out.push(`-- Fictional demo workspace. Generated by scripts/seed-demo.mjs; do not edit by hand.
-- Every company, person, product and domain below is invented (domains use the reserved .example TLD).
--
-- Load after supabase/schema.sql:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/seed/demo.sql
-- Remove it again:                  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/demo-reset.sql
--
-- Every existing user in public.users is added to the demo workspace as an admin, so whoever signed
-- up on this install sees it (switch workspace if your own opens first). Timestamps are relative to
-- now(), so the data looks current whenever it is loaded.

SET client_min_messages = warning;

-- Never on a real install: it adds every user as admin of an invented workspace. Refuse when the
-- database has more than 5 users or 3 workspaces, unless the operator says so in the same session:
--   PGOPTIONS='-c nous.demo_seed_ok=on' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/seed/demo.sql
DO $$
BEGIN
  IF coalesce(current_setting('nous.demo_seed_ok', true), '') <> 'on'
     AND ((SELECT count(*) FROM public.users) > 5 OR (SELECT count(*) FROM public.workspaces) > 3) THEN
    RAISE EXCEPTION 'demo.sql refused on database %: % users, % workspaces. This looks like a real install; set nous.demo_seed_ok=on to override.',
      current_database(), (SELECT count(*) FROM public.users), (SELECT count(*) FROM public.workspaces);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = ${q(WS)}) THEN
    RAISE EXCEPTION 'The demo workspace is already loaded. Run supabase/seed/demo-reset.sql first.';
  END IF;
END $$;
`);

emit('teams', ['id', 'name', 'slug'], [[q(TEAM), q(SELLER.name), q('fernpoint-demo')]]);
out.push(`INSERT INTO auth.users (id, email) VALUES\n  ${REPS.map(r => `(${q(r.authId)}, ${q(r.email)})`).join(',\n  ')}\nON CONFLICT (id) DO NOTHING;`);
emit('users', ['id', 'email', 'name', 'team_id', 'supabase_user_id', 'onboarding_completed_at', 'account_setup_completed_at'],
  REPS.map(r => [q(r.userId), q(r.email), q(r.name), q(TEAM), q(r.authId), ago(12 * DAY), ago(12 * DAY)]));
emit('team_members', ['team_id', 'user_id', 'role'], REPS.map(r => [q(TEAM), q(r.userId), q(r.team)]));
emit('workspaces', ['id', 'team_id', 'name', 'slug', 'industry', 'business_type', 'website', 'icp_text', 'created_at',
  'onboarding_activated_at', 'onboarding_completed_at', 'history_backfilled_at', 'open_account_visibility', 'tour_completed_at'],
  [[q(WS), q(TEAM), q('Fernpoint (demo)'), q('fernpoint-demo'), q('software'), q('software'), q(SELLER.website),
    q('Operations-heavy companies with 100 to 2,000 staff across several sites, where schedules are still built by hand: freight and logistics, specialty manufacturing, multi-site clinics and field services.'),
    ago(12 * DAY), ago(12 * DAY), ago(11 * DAY), ago(11 * DAY), 'true', ago(11 * DAY)]]);
emit('workspace_members', ['workspace_id', 'user_id', 'role', 'job_role', 'onboarded_at'],
  REPS.map(r => [q(WS), q(r.userId), `${q(r.role)}::public.workspace_role`, q(r.key === 'owner' ? 'founder' : 'ae'), ago(11 * DAY)]));

// entities
const entityRows = [[q(WS_ENTITY), q(WS), q('workspace'), ago(12 * DAY)]];
for (const c of companies) entityRows.push([q(c.id), q(WS), q('company'), ago((c.lastTouchDays + int(20, 160)) * DAY)]);
for (const p of people) entityRows.push([q(p.id), q(WS), q('person'), ago((p.company.lastTouchDays + int(15, 150)) * DAY)]);

// identifiers
const identRows = [];
for (const c of companies) identRows.push([q(WS), q(c.id), q('domain'), q(c.domain)]);
for (const p of people) identRows.push([q(WS), q(p.id), q('email'), q(p.email)]);

// profile claims (scalar values, asserted from the CRM import)
const claimRows = [];
const fact = (entity, prop, value, daysAgo, conf = 0.95, cls = 'observed', extra = {}) => claimRows.push([
  q(uid('claim', entity, prop)), q(WS), q(entity), q(prop), j(value), String(conf), q(cls), q(extra.freshness || 'fresh'),
  extra.obs ? `ARRAY[${extra.obs.map(q).join(',')}]::uuid[]` : `'{}'::uuid[]`, String(extra.obs ? extra.obs.length : 1),
  ago(daysAgo * DAY), ago(daysAgo * DAY), ago(daysAgo * DAY)]);
for (const c of companies) {
  const d = Math.min(c.lastTouchDays + 3, 60);
  fact(c.id, 'name', c.name, d, 1);
  fact(c.id, 'industry', c.v.industry, d);
  fact(c.id, 'description', c.v.desc(c.name), d, 0.9);
  fact(c.id, 'employee_count', c.employees, d, 0.85);
  fact(c.id, 'location', `${c.city}, ${c.country}`, d, 0.9);
  fact(c.id, 'country', c.country, d, 0.9);
  fact(c.id, 'revenue_range', c.revenue, d, 0.7, 'inferred');
  fact(c.id, 'funding_stage', c.funding, d, 0.8);
  fact(c.id, 'founded_year', c.founded, d, 0.9);
  fact(c.id, 'tech_stack', c.tools, d, 0.8, 'inferred');
  fact(c.id, 'icp_score', c.icp, 2, 0.9, 'predicted');
  fact(c.id, 'icp_fit', c.icp >= 70, 2, 0.9, 'predicted');
  c.owner = REPS[1 + (companies.indexOf(c) % 2)];
  fact(c.id, 'owner_name', c.owner.name, 20, 1);
  fact(c.id, 'owner_email', c.owner.email, 20, 1);
}
for (const p of people) {
  const d = Math.min(p.company.lastTouchDays + 3, 60);
  fact(p.id, 'first_name', p.first, d, 1);
  fact(p.id, 'last_name', p.last, d, 1);
  fact(p.id, 'job_title', p.title, d, 0.95);
  fact(p.id, 'seniority', p.seniority, d, 0.8, 'inferred');
  fact(p.id, 'department', p.department, d, 0.8, 'inferred');
  fact(p.id, 'icp_score', p.icp, 2, 0.9, 'predicted');
}

// works_at
const relRows = [];
for (const p of people) relRows.push([q(uid('rel', p.id, 'works_at')), q(WS), q(p.id), q(p.company.id), q('works_at'), '0.98', ago(200 * DAY)]);

// interactions: every person gets a thread; recency follows the account's last touch
const obsRows = [];
const obsByPerson = new Map();
const KINDS = [
  { t: 'email_sent', src: 'gmail', out: true },
  { t: 'email_received', src: 'gmail', out: false },
  { t: 'meeting_scheduled', src: 'google_calendar', out: false },
  { t: 'meeting_held', src: 'google_calendar', out: false },
  { t: 'call_held', src: 'google_calendar', out: false },
  { t: 'linkedin_message', src: 'linkedin', out: true },
];
for (const p of people) {
  const c = p.company;
  const n = int(3, c.icp >= 75 ? 10 : 6);
  const list = [];
  for (let i = 0; i < n; i++) {
    // the newest touch sits at the account's last-touch day; older ones spread back across ~6 months
    const days = i === 0 ? c.lastTouchDays + rnd() * 0.8 : Math.min(178, c.lastTouchDays + rnd() * (178 - c.lastTouchDays));
    const k = i === 0 ? pick([KINDS[1], KINDS[3], KINDS[4]]) : i === 1 ? KINDS[3] : pick(KINDS);
    const subj = pick(c.v.subjects).replace('{q}', String(int(1, 4))).replace('{n}', String(int(2, 12)));
    const id = uid('obs', p.id, i);
    const rep = pick(REPS);
    const isEmail = k.t.startsWith('email');
    const isMeeting = k.t.startsWith('meeting') || k.t === 'call_held';
    const raw = isEmail
      ? { subject: subj, body: `${k.out ? `Hi ${p.first},` : `Hi ${rep.name.split(' ')[0]},`} following up on ${subj.toLowerCase()} for ${c.name}.`,
          from: k.out ? rep.email : p.email, to: k.out ? [p.email] : [rep.email], is_outbound: k.out }
      : isMeeting
        ? { title: `${subj} · ${c.name} / Fernpoint`, attendees: [rep.email, p.email], duration_minutes: pick([30, 45, 60]), is_outbound: false }
        : { body: `Thanks ${p.first}, good to connect. Happy to share how other ${c.v.industry.toLowerCase()} teams plan shifts.`, is_outbound: true };
    const summary = isMeeting ? `${k.t === 'call_held' ? 'Call' : 'Meeting'} with ${p.first} ${p.last} about ${subj.toLowerCase()}.`
      : isEmail ? `${k.out ? 'Sent' : 'Received'}: ${subj}` : `LinkedIn message to ${p.first} ${p.last}`;
    obsRows.push([q(id), q(WS), q(p.id), q('event'), q(`interaction.${k.t}`), j({ description: null, summary }), q(k.src), q('connector'),
      ago(days * DAY), q(`demo-${id}`), j(raw)]);
    list.push({ id, kind: k.t, src: k.src, days });
  }
  obsByPerson.set(p.id, list);
}
// a few meetings booked for next week (inbound, upcoming)
for (const c of companies.filter(x => x.lastTouchDays <= 12).slice(0, 6)) {
  const p = people.find(x => x.company === c);
  const id = uid('obs', p.id, 'upcoming');
  obsRows.push([q(id), q(WS), q(p.id), q('event'), q('interaction.meeting_scheduled'),
    j({ description: null, summary: `Booked: rollout planning with ${p.first} ${p.last}` }), q('google_calendar'), q('connector'),
    ahead(int(2, 9)), q(`demo-${id}`), j({ title: `Rollout planning · ${c.name} / Fernpoint`, attendees: [REPS[1].email, p.email], is_outbound: false })]);
}

// intel (note.*) claims, from the conversations; each theme becomes a pattern hub
const noteRows = [];
const themeMembers = THEMES.map(() => ({ entities: new Set(), claims: [] }));
const noteCount = {};
const peerOf = (c) => pick(companies.filter(x => x !== c && x.vkey === c.vkey && x.icp >= 75)) || pick(companies.filter(x => x !== c));
for (const c of companies) {
  const staff = people.filter(p => p.company === c);
  const k = c.icp >= 80 ? int(7, 10) : c.icp >= 60 ? int(4, 7) : int(2, 4);
  const themes = shuffle(THEMES.map((t, i) => i)).slice(0, k);
  for (const ti of themes) {
    const t = THEMES[ti];
    if (t.cat === 'buying_signal' && c.icp < 70) continue;
    if (t.cat === 'expansion_signal' && c.icp < 80) continue;
    const p = t.cat === 'authority' || t.cat === 'budget' ? (staff.find(s => s.dm) || staff[0]) : pick(staff);
    const touches = obsByPerson.get(p.id).filter(o => o.kind === 'meeting_held' || o.kind === 'call_held' || o.kind === 'email_received');
    const ob = touches.length ? pick(touches) : obsByPerson.get(p.id)[0];
    const content = pick(t.lines)
      .replace('{co}', c.name).replace('{tool}', c.tools[0]).replace('{rival}', pick(RIVALS))
      .replace('{n}', String(t.cat === 'budget' ? pick([40, 60, 75, 90, 120]) : t.cat === 'goal' ? int(3, 12) : int(12, 35)))
      .replace('{month}', pick(MONTHS)).replace('{industry}', c.v.industry.toLowerCase()).replace('{peer}', peerOf(c).name);
    // The account page shows every company-level note but only some categories from its people, so
    // most intel is filed on the company; the Graph rolls a person's notes up to their company anyway.
    const about = chance(0.6) ? 'company' : 'person';
    const entity = about === 'company' ? c.id : p.id;
    const id = uid('note', c.id, ti, p.id);
    const meta = {
      about, extraction_source: ob.src === 'gmail' ? 'gmail' : 'google_calendar', source_activity_id: ob.id,
      speaker: `${p.first} ${p.last}`, voiced_by_contact_id: p.id,
      ...(t.cat === 'objection' ? { status: chance(0.4) ? 'resolved' : 'open', hardness: pick(['soft', 'hard']) } : {}),
      ...(t.cat === 'authority' ? { role: 'economic_buyer' } : {}),
      ...(t.cat === 'competitor' ? { stance: pick(['evaluating', 'incumbent']), entity: t.label.split(' ').slice(-2).join(' ') } : {}),
      ...(t.cat === 'risk_signal' ? { severity: 'medium' } : {}),
      ...(t.cat === 'expansion_signal' ? { stance: 'interested', product: 'additional sites' } : {}),
    };
    noteRows.push([q(id), q(WS), q(entity), q(`note.${id}`),
      j({ category: t.cat, content, label: t.label.split(' ').slice(0, 4).join(' '), source: 'signal_extraction', metadata: meta }),
      '0.85', q('asserted'), q(ob.days > 60 ? 'aging' : 'fresh'), `ARRAY[${q(ob.id)}]::uuid[]`, '1',
      ago(ob.days * DAY), ago(ob.days * DAY - 30), ago(ob.days * DAY)]);
    themeMembers[ti].entities.add(about === 'company' ? c.id : p.id);
    themeMembers[ti].claims.push(id);
    noteCount[t.cat] = (noteCount[t.cat] || 0) + 1;
  }
}

// deals: most accounts above 60 have one; a few have two (an expansion)
const STAGES = [
  { stage: 'Discovery', status: 'open', p: 0.2 }, { stage: 'Demo', status: 'open', p: 0.35 },
  { stage: 'Proposal', status: 'open', p: 0.55 }, { stage: 'Negotiation', status: 'open', p: 0.75 },
  { stage: 'Closed Won', status: 'won', p: 1 }, { stage: 'Closed Lost', status: 'lost', p: 0 },
];
const deals = [];
for (const c of companies) {
  if (c.icp < 55 && !chance(0.25)) continue;
  const st = c.lastTouchDays > 90 ? pick([STAGES[5], STAGES[4], STAGES[0]])
    : c.icp >= 85 ? pick([STAGES[2], STAGES[3], STAGES[3], STAGES[4]])
    : pick([STAGES[0], STAGES[1], STAGES[1], STAGES[2], STAGES[5]]);
  const value = Math.round((c.sites * pick([2400, 3000, 3600]) + int(0, 12) * 1000) / 1000) * 1000;
  deals.push({ c, ...st, value, id: uid('deal', c.name, 1), name: `${c.name} · ${Math.min(c.sites, 6)}-site rollout`,
    closeIn: st.status === 'open' ? int(10, 120) : -int(5, 150), owner: pick(REPS.slice(1)) });
  if (st.status === 'won' && chance(0.5)) {
    deals.push({ c, ...STAGES[1], value: Math.round(value * 0.6 / 1000) * 1000, id: uid('deal', c.name, 2),
      name: `${c.name} · remaining sites`, closeIn: int(30, 150), owner: pick(REPS.slice(1)) });
  }
}
const dealRows = [];
for (const d of deals) {
  entityRows.push([q(d.id), q(WS), q('deal'), ago((d.c.lastTouchDays + int(20, 90)) * DAY)]);
  const close = d.closeIn >= 0 ? `to_jsonb(to_char(${ahead(d.closeIn)}, 'YYYY-MM-DD'))` : `to_jsonb(to_char(${ago(-d.closeIn * DAY)}, 'YYYY-MM-DD'))`;
  const dfact = (prop, valueSql) => dealRows.push([q(uid('claim', d.id, prop)), q(WS), q(d.id), q(prop), valueSql, '1', q('observed'),
    q('fresh'), `'{}'::uuid[]`, '1', ago(3 * DAY), ago(3 * DAY), ago(3 * DAY)]);
  dfact('name', j(d.name)); dfact('stage', j(d.stage)); dfact('status', j(d.status)); dfact('value', j(d.value));
  dfact('currency', j('USD')); dfact('close_date', close); dfact('owner_name', j(d.owner.name)); dfact('owner_email', j(d.owner.email));
  dfact('pipeline', j('Sales')); dfact('pipeline_id', j('sales')); dfact('probability', j(d.p));
  relRows.push([q(uid('rel', d.id, 'belongs_to')), q(WS), q(d.id), q(d.c.id), q('belongs_to'), '1', ago(90 * DAY)]);
  for (const p of people.filter(x => x.company === d.c).slice(0, 3)) {
    relRows.push([q(uid('rel', p.id, d.id)), q(WS), q(p.id), q(d.id), q('stakeholder_of'), '0.9', ago(80 * DAY)]);
  }
}
// which conversations were about which deal (drives a deal's last activity)
const odRows = [];
for (const d of deals) {
  for (const p of people.filter(x => x.company === d.c).slice(0, 3)) {
    for (const o of obsByPerson.get(p.id).filter(o => o.kind === 'meeting_held' || o.kind === 'call_held').slice(0, 2)) {
      odRows.push([q(WS), q(o.id), q(d.id), q('crm'), '1']);
    }
  }
}

// ICP predictions: the record header reads the newest icp_fit; the graph groups by fired_signals
const SIGNALS = { logistics: ['multi_site', 'manual_scheduling', 'hourly_workforce', 'industry_logistics'],
  manufacturing: ['multi_shift', 'manual_scheduling', 'overtime_pressure', 'industry_manufacturing'],
  clinics: ['multi_site', 'provider_scheduling', 'growth_new_sites', 'industry_clinics'],
  field: ['dispatch_heavy', 'manual_scheduling', 'seasonal_demand', 'industry_field_services'] };
const tierOf = (s) => s >= 85 ? 'tier_1' : s >= 70 ? 'tier_2' : s >= 50 ? 'tier_3' : 'not_icp';
const predRows = [];
const pred = (entity, score, vkey) => {
  const fired = SIGNALS[vkey].filter(() => chance(score / 110));
  predRows.push([q(uid('pred', entity)), q(WS), q(entity), q('icp_fit'),
    j({ score, fit: score >= 70, tier: tierOf(score), reason: score >= 85 ? 'Multi-site operation still scheduling by hand; strong match to closed-won accounts.' : score >= 70 ? 'Good operational fit; smaller footprint than our best customers.' : 'Partial fit: few sites or scheduling already handled.' }),
    '0.8', q('demo-icp-v1'), ago(2 * DAY), j(fired)]);
};
for (const c of companies) pred(c.id, c.icp, c.vkey);
for (const p of people.filter(x => x.dm)) pred(p.id, p.icp, p.company.vkey);

// who knows whom, and decision makers the title alone would miss
const edgeRows = [];
const shuffledPeople = shuffle(people);
for (let i = 0; i < 26; i++) {
  const a = shuffledPeople[i], b = shuffledPeople[(i * 7 + 11) % shuffledPeople.length];
  if (a.company === b.company) continue;
  edgeRows.push([q(WS), q('person'), q(a.id), q(`${a.first} ${a.last}`), q('KNOWS'), q('person'), q(b.id), q(`${b.first} ${b.last}`), '0.8', q('extraction')]);
}
for (const p of people.filter(x => !x.dm && /fleet operations manager|regional practice manager|service manager/i.test(x.title)).slice(0, 6)) {
  edgeRows.push([q(WS), q('person'), q(p.id), q(`${p.first} ${p.last}`), q('DECISION_MAKER_AT'), q('company'), q(p.company.id), q(p.company.name), '0.7', q('extraction')]);
}

// pattern hubs (the worker would compute these from claim embeddings; here they follow the themes)
const conceptRows = THEMES.map((t, i) => [q(uid('concept', i)), q(WS), q(t.cat), q(t.label),
  `ARRAY[${[...themeMembers[i].entities].map(q).join(',') || ''}]::uuid[]`, `ARRAY[${themeMembers[i].claims.map(q).join(',')}]::uuid[]`,
  String(themeMembers[i].entities.size), '1', ago(1 * DAY)]).filter((r, i) => themeMembers[i].claims.length > 0);

// The company's GTM profile: playbook facts on the workspace entity, which ICP scoring and the
// agent's context read. (The demo has no GTM brain: Brains are Cloud only, GET-839.)
const playbook = [
  ['Positioning', 'Fernpoint turns hand-built schedules into a plan the whole operation can see: demand forecast, shifts and overtime in one place, for companies running several sites.'],
  ['ICP', 'Operations-heavy companies with 100 to 2,000 staff over 3+ sites, still scheduling in spreadsheets, where overtime is a board-level number.'],
  ['Market', 'Four verticals so far: freight and logistics, specialty manufacturing, multi-site clinics, field services. Clinics and logistics close fastest.'],
  ['GTM Motion', 'Founder-led and AE-led outbound to VP Operations and COO, a two-site paid pilot, then expansion to the remaining sites.'],
  ['Pricing', 'Per site per month, annual contract; the pilot is two sites for 90 days, credited against year one.'],
  ['Competitors', `We meet ${RIVALS[0]} most often (cheaper, weaker reporting) and ${RIVALS[1]} as an incumbent at single sites.`],
];
for (const [cat, content] of playbook) {
  const id = uid('playbook', cat);
  noteRows.push([q(id), q(WS), q(WS_ENTITY), q(`note.${id}`), j({ category: cat, content, source: 'manual', metadata: { about: 'company' } }),
    '1', q('asserted'), q('fresh'), `'{}'::uuid[]`, '0', ago(9 * DAY), ago(9 * DAY), ago(9 * DAY)]);
}
// ── emit ──────────────────────────────────────────────────────────────────────
emit('entities', ['id', 'workspace_id', 'type', 'created_at'], entityRows);
emit('entity_identifiers', ['workspace_id', 'entity_id', 'kind', 'value'], identRows);
const CLAIM_COLS = ['id', 'workspace_id', 'entity_id', 'property', 'value', 'confidence', 'epistemic_class', 'freshness',
  'supporting_observation_ids', 'observation_count', 'last_observed_at', 'computed_at', 'valid_from'];
emit('claims', CLAIM_COLS, claimRows);
emit('claims', CLAIM_COLS, dealRows);
emit('relationships', ['id', 'workspace_id', 'from_entity_id', 'to_entity_id', 'type', 'confidence', 'valid_from'], relRows);
emit('observations', ['id', 'workspace_id', 'entity_id', 'kind', 'property', 'value', 'source', 'method', 'observed_at', 'external_id', 'raw'], obsRows);
emit('claims', CLAIM_COLS, noteRows);
emit('observation_deals', ['workspace_id', 'observation_id', 'deal_entity_id', 'source', 'confidence'], odRows);
emit('predictions', ['id', 'workspace_id', 'entity_id', 'kind', 'predicted_value', 'predicted_confidence', 'model_version', 'predicted_at', 'fired_signals'], predRows);
emit('workspace_graph_edges', ['workspace_id', 'subject_type', 'subject_id', 'subject_label', 'relationship', 'object_type', 'object_id', 'object_label', 'confidence', 'source'], edgeRows);
emit('graph_concepts', ['id', 'workspace_id', 'type', 'label', 'entity_ids', 'claim_ids', 'size', 'generation', 'computed_at'], conceptRows);

out.push(`
-- Whoever already signed up on this install gets the demo workspace too.
INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT ${q(WS)}, u.id, 'admin'::public.workspace_role
  FROM public.users u
 WHERE u.team_id <> ${q(TEAM)}
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- And to the demo team as an admin: Settings -> Members reads the team, so without this the
-- page answers 403 in the demo workspace. demo-reset.sql drops it with the team (cascade).
INSERT INTO public.team_members (team_id, user_id, role)
SELECT ${q(TEAM)}, u.id, 'admin'
  FROM public.users u
 WHERE u.team_id <> ${q(TEAM)}
ON CONFLICT (team_id, user_id) DO NOTHING;

-- Fill the flattened rows the Accounts list and the Graph read.
SELECT * FROM public.refresh_entity_list_rows(${q(WS)});
`);

counts['auth.users'] = REPS.length;
const summary = { companies: companies.length, people: people.length, deals: deals.length,
  interactions: obsRows.length, intel_claims: Object.values(noteCount).reduce((a, b) => a + b, 0), intel_by_category: noteCount, rows: counts };
out.splice(1, 0, `-- Contents: ${JSON.stringify(summary)}\n`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n\n') + '\n');
// The reset script carries the same ids, so it is generated alongside.
const RESET = path.join(path.dirname(OUT), 'demo-reset.sql');
fs.writeFileSync(RESET, `-- Removes the fictional demo workspace written by supabase/seed/demo.sql, and its demo team and users.
-- Generated by scripts/seed-demo.mjs. Touches nothing else: every row it deletes hangs off the demo
-- workspace or the demo team.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed/demo-reset.sql

BEGIN;

-- Observations are append-only by trigger (observations_immutable). The baseline ships it disabled,
-- as production has it; if it is enabled here, switch it off for this transaction only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'observations_immutable' AND tgenabled <> 'D') THEN
    EXECUTE 'ALTER TABLE public.observations DISABLE TRIGGER observations_immutable';
    PERFORM set_config('nous.demo_reenable_trigger', 'on', true);
  END IF;
END $$;

-- graph_concepts has no foreign key to workspaces, so it does not go with the cascade.
DELETE FROM public.graph_concepts WHERE workspace_id = ${q(WS)};
DELETE FROM public.workspaces WHERE id = ${q(WS)};
DELETE FROM public.users WHERE team_id = ${q(TEAM)};
DELETE FROM public.teams WHERE id = ${q(TEAM)};
DELETE FROM auth.users WHERE id IN (${REPS.map(r => q(r.authId)).join(', ')});

DO $$
BEGIN
  IF current_setting('nous.demo_reenable_trigger', true) = 'on' THEN
    EXECUTE 'ALTER TABLE public.observations ENABLE TRIGGER observations_immutable';
  END IF;
END $$;

COMMIT;
`);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(JSON.stringify(summary, null, 2));
