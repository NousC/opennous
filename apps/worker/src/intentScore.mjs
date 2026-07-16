// Intent score — Plan 2, Phase 1 (the "reach out NOW?" axis, separate from ICP fit).
//
// Fit says WHO (durable). Intent says WHEN (decays). Computes a 0-100 intent_score
// from the behavioural signals Nous already collects, with anti-over-prioritization
// baked in so no single channel (esp. a website visit) can fake readiness:
//   1. per-signal CAP        — each signal contributes at most its weight
//   2. SATURATION on repeats — 1-e^(-n/2): 1≈.39, 3≈.78, 20≈1.0 (no runaway)
//   3. DECAY by recency      — 0.5^(age/halfLife); a stale signal barely counts
//   4. CORROBORATION gate    — a lone signal caps at Warm(69); a lone website visit
//                              caps at Aware(49). Hot/Red-hot needs ≥2 distinct signals.
//   5. FIT overlay (play)    — Not-ICP + Hot is still ignored
//
// Two modes:
//   • preview (default)  — prints distribution + examples, writes NOTHING
//   • --write            — upserts intent_score + intent_band CLAIMS (epistemic
//                          'inferred', refreshable — NOT asserted) for entities
//                          scoring Aware+ (≥20). Cron calls runIntentScoring().
//
// Usage (from apps/worker, prod creds in env):
//   set -a; source /path/to/your/.env; set +a
//   node src/intentScore.mjs                  # preview default list
//   LIST_ID=<uuid> node src/intentScore.mjs   # preview a list
//   node src/intentScore.mjs --write          # WRITE claims, workspace-wide
//   LIST_ID=<uuid> node src/intentScore.mjs --write   # write, scoped to a list

import { getSupabaseClient } from '@nous/core';

const DAY = 86400000;
const STAKE_FLOOR = 20;   // only stake a claim once intent clears Dormant (Aware+)

// Signal catalog. weight = max contribution; halfLifeDays = recency decay.
// website_visit is wired but inert until the Phase-2 pixel writes those obs.
// The signal catalog — each row tagged by the 2×2 (see docs/intent-score.md):
// PERSON·INTENT (individual behaviour, NOT inherited) and COMPANY·INTENT (inherited
// by every person at the company). FIT signals (industry/size/exclusion) do NOT
// live here — they route to the ICP scorecard, not the intent score.
export const SIGNALS = {
  // ── person · intent — engaged with US (follow-up triggers) ──
  meeting_booked:    { weight: 35, halfLifeDays: 30 },
  replied:           { weight: 35, halfLifeDays: 30 },
  linkedin_engaged:  { weight: 25, halfLifeDays: 14 },
  // ── person · intent — in-market BEHAVIOUR (cold-outreach triggers) ──
  posted_pain:       { weight: 20, halfLifeDays: 21 },   // ← signal.intent from content-scan
  competitor_engaged:{ weight: 22, halfLifeDays: 14 },   // liked/commented a competitor (content-scan/monitor)
  creator_like:      { weight: 14, halfLifeDays: 14 },   // engaged a creator/influencer in-category (monitor)
  job_change:        { weight: 20, halfLifeDays: 45 },   // new role/company (linkedin-monitor, P2) — also re-scores FIT
  // ── company · intent — inherited by every person at the company ──
  hiring:            { weight: 18, halfLifeDays: 30 },
  momentum:          { weight: 12, halfLifeDays: 60 },   // funding / growth / expansion / news / launch
  website_visit:     { weight: 40, halfLifeDays: 7 },    // [Phase 4] needs a visitor pixel
};
const MEANINGFUL = 5;

const saturate = (n) => 1 - Math.exp(-n / 2);
const decay = (ageDays, halfLife) => Math.pow(0.5, ageDays / halfLife);

// counts: { class: [iso, ...] }. now = ms epoch (passed in so it's testable/stable).
export function scoreIntent(counts, now) {
  const ageDays = (iso) => Math.max(0, (now - new Date(iso).getTime()) / DAY);
  const contrib = {};
  for (const [cls, cfg] of Object.entries(SIGNALS)) {
    const events = counts[cls] || [];
    if (!events.length) continue;
    const weightedN = events.reduce((s, iso) => s + decay(ageDays(iso), cfg.halfLifeDays), 0);
    contrib[cls] = Math.min(cfg.weight, cfg.weight * saturate(weightedN));
  }
  const active = Object.keys(contrib).filter(c => contrib[c] >= MEANINGFUL);
  let score = Math.min(100, Object.values(contrib).reduce((a, b) => a + b, 0));
  if (active.length < 2) {
    const onlyWeb = active.length === 1 && active[0] === 'website_visit';
    score = Math.min(score, onlyWeb ? 49 : 69);   // corroboration gate
  }
  score = Math.round(score);
  const band = score >= 85 ? 'Red-hot' : score >= 70 ? 'Hot' : score >= 50 ? 'Warm'
            : score >= 20 ? 'Aware' : 'Dormant';
  return { score, band, active };
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Gather per-entity signal timestamps for a set of person entities (+ their
// companies' inherited signal.* claims). Returns Map<entityId, counts>.
async function gatherIntent(supabase, ws, persons, now) {
  // persons: [{ entity_id, domain }]
  const personIds = [...new Set(persons.map(p => p.entity_id).filter(Boolean))];
  const domains = [...new Set(persons.map(p => p.domain).filter(Boolean))];
  const counts = new Map();
  const bump = (eid, cls, iso) => {
    const m = counts.get(eid) || {};
    (m[cls] = m[cls] || []).push(iso);
    counts.set(eid, m);
  };

  // person behavioural observations (last 180d)
  for (const grp of chunk(personIds, 100)) {
    const obs = (await supabase.from('observations').select('entity_id,property,source,observed_at')
      .eq('workspace_id', ws).in('entity_id', grp)
      .gte('observed_at', new Date(now - 180 * DAY).toISOString())).data || [];
    for (const o of obs) {
      let cls = null;
      const P = o.property;
      if (P === 'interaction.meeting_scheduled' || P === 'interaction.meeting_held') cls = 'meeting_booked';
      else if (P === 'interaction.email_replied' || P === 'interaction.positive_reply'
            || P === 'interaction.reply' || P === 'interaction.linkedin_reply') cls = 'replied';
      else if (P === 'interaction.linkedin_message' || P === 'interaction.linkedin_connected'
            || P === 'interaction.linkedin_post_engagement') cls = 'linkedin_engaged';
      else if (P === 'interaction.competitor_engagement') cls = 'competitor_engaged';
      else if (P === 'interaction.creator_engagement') cls = 'creator_like';
      else if (P === 'interaction.job_change') cls = 'job_change';
      else if (P === 'interaction.website_visit') cls = 'website_visit';
      // (meeting_cancelled / enrichment_run / *_sent are deliberately NOT intent)
      if (cls) bump(o.entity_id, cls, o.observed_at);
    }
  }

  // person's OWN intent claim (signal.intent, written by content-scan from their
  // posts) → posted_pain. Distinct from the company signals inherited below.
  for (const grp of chunk(personIds, 100)) {
    const cl = (await supabase.from('claims').select('entity_id,value,last_observed_at,computed_at')
      .eq('workspace_id', ws).in('entity_id', grp).eq('property', 'signal.intent').is('invalid_at', null)).data || [];
    for (const c of cl) {
      const sc = (c.value && typeof c.value === 'object') ? c.value.score : null;
      if (sc != null && sc < 6) continue;
      bump(c.entity_id, 'posted_pain', c.last_observed_at || c.computed_at);
    }
  }

  // company signal.* claims, inherited by every person at that company
  if (domains.length) {
    const idRows = [];
    for (const grp of chunk(domains, 200)) {
      const r = (await supabase.from('entity_identifiers').select('entity_id,value')
        .eq('workspace_id', ws).eq('kind', 'domain').in('value', grp)).data || [];
      idRows.push(...r);
    }
    const dom2co = new Map(idRows.filter(r => r.value).map(r => [r.value.toLowerCase(), r.entity_id]));
    const coIds = [...new Set([...dom2co.values()])];
    const coSig = new Map();
    for (const grp of chunk(coIds, 100)) {
      const cls = (await supabase.from('claims').select('entity_id,property,value,last_observed_at,computed_at')
        .eq('workspace_id', ws).in('entity_id', grp).is('invalid_at', null)
        .in('property', ['signal.hiring', 'signal.momentum'])).data || [];
      for (const c of cls) {
        const sc = (c.value && typeof c.value === 'object') ? c.value.score : null;
        if (sc != null && sc < 6) continue;
        const key = c.property.split('.')[1];   // 'hiring' | 'momentum' (company·intent, inherited)
        const m = coSig.get(c.entity_id) || {};
        (m[key] = m[key] || []).push(c.last_observed_at || c.computed_at);
        coSig.set(c.entity_id, m);
      }
    }
    for (const p of persons) {
      const co = p.domain && dom2co.get(p.domain);
      const sig = co && coSig.get(co);
      if (sig) for (const [k, v] of Object.entries(sig)) for (const iso of v) bump(p.entity_id, k, iso);
    }
  }
  return counts;
}

async function upsertIntentClaim(supabase, ws, entityId, score, band, nowIso) {
  const base = {
    workspace_id: ws, entity_id: entityId, distribution: null, confidence: 0.8,
    epistemic_class: 'inferred', freshness: 'fresh', valid_from: nowIso, invalid_at: null,
    supporting_observation_ids: [], observation_count: 0, last_observed_at: nowIso, computed_at: nowIso,
  };
  await supabase.from('claims').upsert([
    { ...base, property: 'intent_score', value: score },
    { ...base, property: 'intent_band', value: band },
  ], { onConflict: 'workspace_id,entity_id,property' });
}

// Core: score a set of persons, optionally writing claims. Returns summary + rows.
export async function runIntentScoring(supabase, ws, { persons, write = false, now = Date.now() }) {
  const counts = await gatherIntent(supabase, ws, persons, now);
  const nowIso = new Date(now).toISOString();
  const bands = { 'Red-hot': 0, Hot: 0, Warm: 0, Aware: 0, Dormant: 0 };
  const rows = [];
  let staked = 0;
  for (const p of persons) {
    const r = scoreIntent(counts.get(p.entity_id) || {}, now);
    bands[r.band]++;
    rows.push({ ...p, ...r });
    if (write && r.score >= STAKE_FLOOR) {
      try { await upsertIntentClaim(supabase, ws, p.entity_id, r.score, r.band, nowIso); staked++; }
      catch (e) { /* best-effort */ }
    }
  }
  return { bands, rows, staked };
}

// Cron entry: every workspace that has recent engagement → score the engaged people.
export async function scoreIntentCron() {
  const supabase = getSupabaseClient();
  const now = Date.now();
  const since = new Date(now - 180 * DAY).toISOString();
  // candidate persons = entities with a recent behavioural interaction observation
  const seen = new Set(); const byWs = new Map();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('observations')
      .select('workspace_id,entity_id,property')
      .like('property', 'interaction.%').gte('observed_at', since).range(from, from + 999);
    if (!data?.length) break;
    for (const o of data) {
      const k = `${o.workspace_id}:${o.entity_id}`;
      if (seen.has(k)) continue; seen.add(k);
      (byWs.get(o.workspace_id) || byWs.set(o.workspace_id, []).get(o.workspace_id)).push(o.entity_id);
    }
    if (data.length < 1000) break;
  }
  let total = 0;
  for (const [ws, entityIds] of byWs) {
    // resolve each person's company domain for inherited company signals
    const persons = [];
    for (const grp of chunk(entityIds, 200)) {
      const dom = (await supabase.from('entity_identifiers').select('entity_id,value')
        .eq('workspace_id', ws).eq('kind', 'domain').in('entity_id', grp)).data || [];
      const m = new Map(dom.map(d => [d.entity_id, (d.value || '').toLowerCase()]));
      for (const id of grp) persons.push({ entity_id: id, domain: m.get(id) || null });
    }
    const { staked } = await runIntentScoring(supabase, ws, { persons, write: true, now });
    total += staked;
  }
  return { workspaces: byWs.size, staked: total };
}

// ── direct-run preview / write (guarded so importing for the cron doesn't run) ──
const isMain = process.argv[1] && process.argv[1].endsWith('intentScore.mjs');
if (isMain) {
  const WRITE = process.argv.includes('--write');
  const WS = process.env.WS_ID || '00000000-0000-0000-0000-000000000000';
  const LL = process.env.LIST_ID || '00000000-0000-0000-0000-000000000000';
  const supabase = getSupabaseClient();
  const now = Date.now();
  (async () => {
    console.log(`\n=== Intent score ${WRITE ? 'WRITE' : 'PREVIEW'} — ${new URL(process.env.SUPABASE_URL).host} ===`);
    console.log(`WS ${WS}  LIST ${LL}\n`);
    const leads = (await supabase.from('leads').select('contact_id,name,email,domain')
      .eq('workspace_id', WS).eq('lead_list_id', LL).limit(2000)).data || [];
    const persons = leads.filter(l => l.contact_id).map(l => ({
      entity_id: l.contact_id, name: l.name,
      domain: (l.domain || (l.email || '').split('@')[1] || '').toLowerCase() || null,
    }));
    const { bands, rows, staked } = await runIntentScoring(supabase, WS, { persons, write: WRITE, now });
    console.log('Band distribution across', rows.length, 'leads:');
    for (const b of ['Red-hot', 'Hot', 'Warm', 'Aware', 'Dormant']) console.log(`  ${b.padEnd(8)} ${bands[b] || 0}`);
    const top = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
    console.log('\nTop by intent:');
    for (const r of top) console.log(`  ${(r.name || '?').slice(0, 26).padEnd(26)} ${String(r.score).padStart(3)}/${r.band.padEnd(8)} [${r.active.join(', ')}]`);
    if (!top.length) console.log('  (no behavioural intent yet — expected on a cold list)');
    console.log(WRITE ? `\nWROTE ${staked} intent claims (Aware+).` : '\nPREVIEW only — nothing written.');
  })().catch(e => { console.error('FATAL:', e); process.exit(1); });
}
