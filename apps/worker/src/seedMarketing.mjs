// ─────────────────────────────────────────────────────────────────────────────
// Marketing Nous demo-workspace seeder.
//
// Builds a believable "Nous selling Nous" GTM workspace: 15 known companies,
// ~25 invented contacts, multi-channel activity arcs backdated over ~11 weeks,
// meeting transcripts, auto-mined Intel, a real ICP scorecard, and real scoring.
//
// Everything is scoped to the Marketing Nous workspace and nothing else is
// touched. Idempotent: a run wipes that workspace and rebuilds it.
//
//   node --env-file=../../../nous.env apps/worker/src/seedMarketing.mjs         (from repo root: node --env-file=nous.env apps/worker/src/seedMarketing.mjs)
//
// Flags: --keep  (skip the wipe)   --no-score (skip scoring pass)
// ─────────────────────────────────────────────────────────────────────────────

import './bootEnv.mjs';
import { randomUUID } from 'node:crypto';
import { getSupabaseClient, saveNote, listSignals, scoreAndStake } from '@nous/core';
import { COMPANIES, CONTACTS, SCORECARD } from './seedMarketingData.mjs';

const WS = '954d045f-c231-47b0-a5ab-d2b2ed329601'; // Marketing Nous — the ONLY workspace this script touches
const supabase = getSupabaseClient();
const args = process.argv.slice(2);
const DO_WIPE = !args.includes('--keep');
const DO_SCORE = !args.includes('--no-score');

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (d, hour = 10, min = 0) => {
  const t = new Date(NOW - d * DAY);
  t.setHours(hour, min, 0, 0);
  return t.toISOString();
};

// ── low-level writers ────────────────────────────────────────────────────────
async function newEntity(type) {
  const id = randomUUID();
  const { error } = await supabase.from('entities').insert({ id, workspace_id: WS, type, status: 'active' });
  if (error) throw new Error(`entity insert (${type}): ${error.message}`);
  return id;
}

async function setClaim(entityId, property, value, opts = {}) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('claims').insert({
    workspace_id: WS,
    entity_id: entityId,
    property,
    value,
    confidence: opts.confidence ?? 0.9,
    epistemic_class: opts.epistemic_class ?? 'asserted',
    freshness: 'fresh',
    valid_from: opts.validFrom ?? now,
    computed_at: now,
    observation_count: opts.observationCount ?? 1,
  });
  if (error) throw new Error(`claim ${property}: ${error.message}`);
}

async function addIdentifier(entityId, kind, value, firstSeen) {
  const { error } = await supabase.from('entity_identifiers').insert({
    workspace_id: WS, entity_id: entityId, kind, value,
    status: 'active', first_seen_at: firstSeen ?? iso(NOW), last_seen_at: iso(NOW),
  });
  if (error && error.code !== '23505') throw new Error(`identifier ${kind}: ${error.message}`);
}

async function worksAt(personId, companyId, since) {
  const { error } = await supabase.from('relationships').insert({
    id: randomUUID(), workspace_id: WS,
    from_entity_id: personId, to_entity_id: companyId, type: 'works_at',
    confidence: 0.95, valid_from: since ?? iso(NOW - 90 * DAY), computed_at: iso(NOW),
  });
  if (error) throw new Error(`works_at: ${error.message}`);
}

// One activity = one event observation. The message body / transcript rides in `raw`.
async function event(entityId, type, occurredAt, { summary, body, isOutbound = false, sentiment, source = 'linkedin', externalId } = {}) {
  const { error } = await supabase.from('observations').insert({
    workspace_id: WS, entity_id: entityId, kind: 'event',
    property: `interaction.${type}`,
    value: { description: null, summary: summary ?? null },
    source, method: 'connector',
    observed_at: occurredAt,
    external_id: externalId ?? null,
    raw: { body: body ?? summary ?? null, is_outbound: isOutbound, ...(sentiment ? { sentiment } : {}) },
  });
  if (error && error.code !== '23505') throw new Error(`event ${type}: ${error.message}`);
}

// Intel fact → note.* claim (the Intel tab). source 'signal_extraction' + a category.
async function intel(entityId, content, category, signalType = 'meeting_held', extractionSource = 'fireflies') {
  await saveNote(supabase, WS, {
    entityId, content, category, source: 'signal_extraction',
    metadata: { about: 'person', graph_layer: 'private', signal_type: signalType, extraction_source: extractionSource },
    confidence: 1,
  });
}

// Meeting transcript → note.* claim (source fireflies), what the meeting row links to.
async function transcriptNote(entityId, title, text, occurredAt) {
  await saveNote(supabase, WS, {
    entityId, content: text, category: 'general', source: 'fireflies',
    subject: title,
    metadata: { doc_type: 'transcript', meeting_title: title, occurred_at: occurredAt },
    confidence: 1,
  });
}

// ── scorecard ────────────────────────────────────────────────────────────────
async function buildScorecard() {
  const rows = SCORECARD.map((s) => ({
    id: randomUUID(), workspace_id: WS, key: s.key, label: s.label,
    weight: s.weight, rule: s.rule, active: true, coverage: 0,
  }));
  const { error } = await supabase.from('scorecard_signals').insert(rows);
  if (error) throw new Error(`scorecard: ${error.message}`);
  console.log(`  scorecard: ${rows.length} signals`);
}

// ── wipe (scoped to WS) ──────────────────────────────────────────────────────
async function wipe() {
  // Order matters only loosely (no cross-table FKs enforced on these), but we
  // clear children before entities for cleanliness. Everything filtered by WS.
  const ids = (await supabase.from('entities').select('id').eq('workspace_id', WS)).data?.map((r) => r.id) ?? [];
  for (const t of ['predictions', 'claims', 'observations', 'relationships', 'entity_identifiers', 'scorecard_signals', 'claim_jobs']) {
    const { error } = await supabase.from(t).delete().eq('workspace_id', WS);
    if (error && error.code !== '42P01') console.warn(`  wipe ${t}: ${error.message}`);
  }
  if (ids.length) await supabase.from('entities').delete().eq('workspace_id', WS);
  console.log(`  wiped ${ids.length} entities + children`);
}

// ── arc generation ───────────────────────────────────────────────────────────
// Depth templates → a backdated multi-channel touch sequence. `c.ctx` fills the
// message templates so every arc reads specifically without hand-writing each line.
const A = (d, type, opts) => ({ d, type, ...opts });

function arcTouches(c) {
  const x = c.ctx;
  const you = 'Bennet Glinder';
  const li = (d, body, isOutbound) => A(d, 'linkedin_message', { source: 'linkedin', body, summary: body, isOutbound });
  const em = (d, body, isOutbound, subject) => A(d, isOutbound ? 'email_sent' : 'email_received', { source: 'gmail', body, summary: subject ? `${subject} — ${body.slice(0, 90)}` : body, isOutbound });

  if (c.arc) return c.arc(c, { li, em, A }); // fully bespoke override

  const base = {
    deep: 82, mid: 54, shallow: 30, tof: 15,
  }[c.depth];

  const t = [];
  // 1. inbound signal — they engaged a post
  t.push(A(base, 'linkedin_post_engagement', { source: 'linkedin', summary: `Reacted to your post: "${x.postTheme}"`, body: `${c.first} reacted (APPRECIATION) to your post: "${x.postTheme}"`, isOutbound: false }));
  // 2. connect
  t.push(A(base - 3, 'linkedin_connected', { source: 'linkedin', summary: 'LinkedIn connection accepted', body: `${c.first} accepted your connection request`, isOutbound: false }));
  // 3. LinkedIn DM thread
  t.push(li(base - 4, `Hey ${c.first}, thanks for connecting. Saw you're deep in ${x.tool} at ${c.company} — I keep hearing the same thing about ${x.pain}. Curious how you're handling it.`, true));
  t.push(li(base - 3.6, `Yeah honestly ${x.pain} is a daily tax for us. ${x.voice}`, false));
  if (c.depth === 'deep' || c.depth === 'mid') {
    t.push(li(base - 2, `That's exactly the pattern. Would it be worth 20 mins to walk through how a couple of ${x.segment} teams are solving it? No pitch, just show you the setup.`, true));
    t.push(li(base - 1.6, `Sure, I'm down. Send me a time.`, false));
    // 4. inbound email reply confirming
    t.push(em(base - 8, `Works for me, ${x.emailVoice} Talk then.`, false, `Re: quick 20 on ${x.topic}`));
  }
  if (c.depth === 'shallow' || c.depth === 'tof') {
    t.push(li(base - 6, `Makes sense. We're not actively looking to change anything this quarter, but keep me posted on what you're building.`, false));
  }
  // recent light touch so the timeline reaches "today"
  if (c.depth === 'deep') t.push(li(2, `Appreciate the follow-ups. Reviewing internally this week and will come back to you.`, false));
  if (c.depth === 'mid') t.push(em(4, `Thanks for the recap. Circulating to the team, back to you shortly.`, false, `Re: ${x.topic}`));
  return t;
}

// ── build one contact ────────────────────────────────────────────────────────
async function buildContact(c, companyId, firstSeen) {
  const id = await newEntity('person');
  // identity + record claims
  await addIdentifier(id, 'email', c.email.toLowerCase(), firstSeen);
  if (c.linkedin) await addIdentifier(id, 'linkedin_url', c.linkedin, firstSeen);
  await setClaim(id, 'first_name', c.first, { confidence: 0.9 });
  await setClaim(id, 'last_name', c.last, { confidence: 0.9 });
  await setClaim(id, 'job_title', c.title, { confidence: 0.85 });
  await setClaim(id, 'seniority', c.seniority, { confidence: 0.8 });
  await setClaim(id, 'department', c.department, { confidence: 0.8 });
  await setClaim(id, 'company', c.company, { confidence: 0.85 });
  await setClaim(id, 'pipeline_stage', c.stage, { confidence: 0.9 });
  await setClaim(id, 'source', 'linkedin', { confidence: 0.7 });
  if (c.phone) await setClaim(id, 'phone', c.phone, { confidence: 0.7 });
  await setClaim(id, 'first_seen_at', firstSeen, { confidence: 0.7 });
  // per-contact engagement strength → a scoreable feature (0-10)
  await setClaim(id, 'signal.engagement', { score: c.engagement ?? 5 }, { confidence: 1 });
  if (c.dealStage) await setClaim(id, 'deal_stage', c.dealStage, { confidence: 0.7 });
  if (c.dealValue) await setClaim(id, 'deal_value', c.dealValue, { confidence: 0.7 });
  await worksAt(id, companyId, firstSeen);

  // activity arc
  const touches = arcTouches(c);
  for (const tch of touches) {
    await event(id, tch.type, daysAgo(tch.d, 9 + Math.floor(tch.d) % 8, (Math.floor(tch.d * 7)) % 60), {
      summary: tch.summary, body: tch.body, isOutbound: tch.isOutbound, source: tch.source,
      sentiment: tch.isOutbound === false && /interested|down|sure|works|let's|keen/i.test(tch.body || '') ? 'positive' : undefined,
      externalId: `seed_${id}_${tch.type}_${tch.d}`,
    });
  }

  // meetings: scheduled + held + transcript + intel
  for (const m of (c.meetings ?? [])) {
    await event(id, 'meeting_scheduled', daysAgo(m.d + 2, 11), { summary: `${m.title} scheduled`, body: `Zoom meeting scheduled: ${m.title}`, source: 'gmail', isOutbound: true, externalId: `seed_${id}_msched_${m.d}` });
    await event(id, 'meeting_held', daysAgo(m.d, 15, 0), { summary: m.summary, body: m.summary, source: 'fireflies', isOutbound: false, externalId: `seed_${id}_mheld_${m.d}` });
    if (m.transcript) await transcriptNote(id, m.title, m.transcript, daysAgo(m.d, 15));
  }

  // Intel facts (auto-mined equivalents)
  for (const f of (c.intel ?? [])) {
    await intel(id, f.text, f.category, f.signal ?? 'meeting_held', f.src ?? 'fireflies');
  }

  // memory summary for the Overview (heroes)
  if (c.summary) await setClaim(id, 'memory_summary', c.summary, { confidence: 0.25 });

  return { id, name: `${c.first} ${c.last}`, target: c.icp };
}

// ── build one company ────────────────────────────────────────────────────────
async function buildCompany(co) {
  const id = await newEntity('company');
  await addIdentifier(id, 'domain', co.domain);
  await setClaim(id, 'name', co.name, { confidence: 0.95 });
  await setClaim(id, 'industry', co.industry, { confidence: 0.8 });
  await setClaim(id, 'employee_count', co.employee_count, { confidence: 0.8 });
  if (co.location) await setClaim(id, 'location', co.location, { confidence: 0.7 });
  if (co.revenue_range) await setClaim(id, 'revenue_range', co.revenue_range, { confidence: 0.6 });
  if (co.tech_stack) await setClaim(id, 'tech_stack', co.tech_stack, { confidence: 0.7 });
  if (co.keywords) await setClaim(id, 'keywords', co.keywords, { confidence: 0.7 });
  if (co.description) await setClaim(id, 'description', co.description, { confidence: 0.7 });
  // company-level signals inherit to every person via works_at
  for (const [k, v] of Object.entries(co.signals ?? {})) {
    await setClaim(id, `signal.${k}`, { score: v }, { confidence: 1 });
  }
  return id;
}

// ── scoring pass ─────────────────────────────────────────────────────────────
async function scoreAll(contactIds) {
  const signals = await listSignals(supabase, WS);
  const active = signals.filter((s) => s.active);
  console.log(`  scoring with ${active.length} active signals…`);
  const out = [];
  for (const c of contactIds) {
    try {
      const r = await scoreAndStake(supabase, WS, c.id, signals);
      out.push({ name: c.name, target: c.target, score: r?.score ?? null, fired: r?.fired ?? 0 });
    } catch (e) {
      out.push({ name: c.name, target: c.target, score: `ERR ${e.message}` });
    }
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  console.log('\n  ICP scores (score | target | fired | name):');
  for (const r of out) console.log(`    ${String(r.score).padStart(4)} | ${String(r.target).padStart(6)} | ${String(r.fired).padStart(2)} | ${r.name}`);
  return out;
}

// Re-score only: rebuild the scorecard + restake predictions over existing
// contacts, without touching content. Fast iteration on weight calibration.
async function scoreOnly() {
  console.log(`\nRe-scoring Marketing Nous (${WS})`);
  await supabase.from('predictions').delete().eq('workspace_id', WS);
  await supabase.from('scorecard_signals').delete().eq('workspace_id', WS);
  await buildScorecard();
  const { data: ents } = await supabase.from('entities').select('id').eq('workspace_id', WS).eq('type', 'person').eq('status', 'active');
  const targets = new Map(CONTACTS.map((c) => [`${c.first} ${c.last}`, c.icp]));
  const contactIds = [];
  for (const e of (ents ?? [])) {
    const { data: fn } = await supabase.from('claims').select('value').eq('entity_id', e.id).eq('property', 'first_name').maybeSingle();
    const { data: ln } = await supabase.from('claims').select('value').eq('entity_id', e.id).eq('property', 'last_name').maybeSingle();
    const name = `${fn?.value ?? '?'} ${ln?.value ?? ''}`.trim();
    contactIds.push({ id: e.id, name, target: targets.get(name) ?? '—' });
  }
  await scoreAll(contactIds);
  console.log('\n✓ re-scored.\n');
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (args.includes('--score-only')) return scoreOnly();
  console.log(`\nSeeding Marketing Nous (${WS})`);
  if (DO_WIPE) { console.log('· wiping…'); await wipe(); }
  console.log('· scorecard…'); await buildScorecard();

  console.log('· companies…');
  const companyId = {};
  const companyName = {};
  for (const co of COMPANIES) { companyId[co.key] = await buildCompany(co); companyName[co.key] = co.name; }
  console.log(`  ${COMPANIES.length} companies`);

  console.log('· contacts + activity…');
  const contactIds = [];
  for (const c of CONTACTS) {
    const cid = companyId[c.companyKey];
    if (!cid) throw new Error(`unknown companyKey ${c.companyKey} for ${c.first} ${c.last}`);
    c.company = companyName[c.companyKey]; // resolve display + template name
    const firstSeen = daysAgo(({ deep: 84, mid: 56, shallow: 32, tof: 16 }[c.depth]) + 1);
    const built = await buildContact(c, cid, firstSeen);
    contactIds.push(built);
    process.stdout.write('.');
  }
  console.log(`\n  ${CONTACTS.length} contacts built`);

  if (DO_SCORE) { console.log('· scoring…'); await scoreAll(contactIds); }

  console.log('\n✓ done.\n');
  process.exit(0);
}

main().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
