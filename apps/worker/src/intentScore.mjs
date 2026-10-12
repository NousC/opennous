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

import { getSupabaseClient, normalizeStage } from '@nous/core';
import { isStrongBuyingSignal } from './buyingSignalStrength.mjs';

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

// A positive reply to our outreach is a qualitatively different thing from a
// website visit or a bare "replied": it's an explicit human "yes, I'm interested".
// Saturation would discount a single one to ~14 pts (Dormant) — wrong. Instead it
// sets a recency-decaying FLOOR: fresh → Hot (80), fading through Warm/Aware over a
// month, so "reach out now while it's warm" is exactly what the score says.
const POSITIVE_REPLY_FLOOR = 80;
const POSITIVE_REPLY_HL     = 30;

// A buying_signal claim (extracted from a call/reply) sets a recency-decaying FLOOR
// and corroborates on its own, like the positive-reply floor — so a deal actively
// closing reads Hot even when behavioural signals have decayed. Fed from note.* claims
// tagged category=buying_signal, tiered by strength (see buyingSignalStrength.mjs):
//   STRONG (agreed to sign/pay, verbal yes, accepted pricing) → Hot/Red-hot floor.
//   SOFT   (asked for a proposal/deck/pricing)                → Warm floor.
const BUYING_SIGNAL_FLOOR      = 88;   // strong
const BUYING_SIGNAL_SOFT_FLOOR = 58;   // soft
const BUYING_SIGNAL_HL         = 45;

const saturate = (n) => 1 - Math.exp(-n / 2);
const decay = (ageDays, halfLife) => Math.pow(0.5, ageDays / halfLife);

// counts: { class: [iso, ...] }. now = ms epoch (passed in so it's testable/stable).
// `positive_reply` is a special class (not in SIGNALS): it applies a floor rather
// than a saturated contribution, and it corroborates on its own.
export function scoreIntent(counts, now, opts = {}) {
  const ageDays = (iso) => Math.max(0, (now - new Date(iso).getTime()) / DAY);
  const contrib = {};
  for (const [cls, cfg] of Object.entries(SIGNALS)) {
    const events = counts[cls] || [];
    if (!events.length) continue;
    const weightedN = events.reduce((s, iso) => s + decay(ageDays(iso), cfg.halfLifeDays), 0);
    contrib[cls] = Math.min(cfg.weight, cfg.weight * saturate(weightedN));
  }
  const active = Object.keys(contrib).filter(c => contrib[c] >= MEANINGFUL);

  // Floors (recency-decayed, best of each class). A positive reply and a buying
  // signal each set a floor and each corroborate on their own. The buying-signal
  // floor is higher because "send me the agreement" outranks "yes, interested".
  let posFloor = 0;
  for (const iso of counts['positive_reply'] || []) {
    posFloor = Math.max(posFloor, POSITIVE_REPLY_FLOOR * decay(ageDays(iso), POSITIVE_REPLY_HL));
  }
  let buyFloor = 0;
  for (const iso of counts['buying_signal_strong'] || []) {
    buyFloor = Math.max(buyFloor, BUYING_SIGNAL_FLOOR * decay(ageDays(iso), BUYING_SIGNAL_HL));
  }
  for (const iso of counts['buying_signal_soft'] || []) {
    buyFloor = Math.max(buyFloor, BUYING_SIGNAL_SOFT_FLOOR * decay(ageDays(iso), BUYING_SIGNAL_HL));
  }
  const floor = Math.max(posFloor, buyFloor);
  const selfCorroborates = posFloor >= MEANINGFUL || buyFloor >= MEANINGFUL;

  let score = Math.min(100, Object.values(contrib).reduce((a, b) => a + b, 0));
  // Corroboration gate — a lone weak signal can't fake readiness. A fresh positive
  // reply or buying signal is its OWN corroboration (a person saying yes / asking to
  // buy), so it's exempt.
  if (!selfCorroborates && active.length < 2) {
    const onlyWeb = active.length === 1 && active[0] === 'website_visit';
    score = Math.min(score, onlyWeb ? 49 : 69);   // corroboration gate
  }
  score = Math.max(score, floor);   // a positive reply or buying signal floors intent
  score = Math.round(Math.min(100, score));

  // Client axis — a won account is out of the buying funnel, so "Aware/Warm/Hot"
  // (readiness to buy) is the wrong lens. For a client the same signals read as
  // health + expansion: a buying signal is an EXPANSION signal, steady engagement is
  // Active, and prolonged silence is At-risk.
  if (opts.isClient) {
    const expanding = (counts['buying_signal_strong']?.length || counts['buying_signal_soft']?.length || counts['positive_reply']?.length) > 0;
    // Health keys off whether they are still engaging at all, not a buying threshold:
    // any meaningful recent signal → Active; genuine silence → At-risk; a buying
    // (now expansion) signal → Expansion.
    const band = expanding ? 'Expansion' : active.length > 0 ? 'Active' : 'At-risk';
    return { score, band, active, mode: 'client' };
  }

  const band = score >= 85 ? 'Red-hot' : score >= 70 ? 'Hot' : score >= 50 ? 'Warm'
            : score >= 20 ? 'Aware' : 'Dormant';
  return { score, band, active, mode: 'buyer' };
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Gather per-entity signal timestamps for a set of person entities (+ their
// companies' inherited signal.* claims). Returns Map<entityId, counts>.
// Gather the timestamped signal events behind an intent score.
//
// EXPORTED and bounded at `now` so intent can be REPLAYED at any past date. The score is
// not stored historically — the claim is upserted on conflict, so each run overwrites the
// last and there is exactly one value per account, always today's. That is fine for "who
// should I call now" and useless for "do hot deals close faster", which needs to know what
// an account's intent WAS four weeks before it closed.
//
// The events themselves have always carried real dates, so the score is recoverable by
// replaying them with the clock moved back. Same trick as the funnel-ladder rebuild: no
// backfill, no writes, just a different read of data that is already correct.
//
// Two things to know about the bound:
//   • It filters on observed_at, i.e. "what was TRUE as of that date", not on ingested_at
//     ("what we KNEW then"). ingested_at is the honest answer for replaying a live forecast,
//     but backfilled history has every row ingested at import time, so it would collapse to
//     a single instant and tell us nothing. observed_at is the one that works on real data.
//   • A meeting booked for AFTER the as-of date is therefore excluded from that replay,
//     because a meeting observation carries the meeting's start time. That is the
//     conservative direction: a replayed score can understate, never invent momentum.
export async function gatherIntent(supabase, ws, persons, now, { lookbackDays = 180 } = {}) {
  // persons: [{ entity_id, domain }]
  // Upper bound for replay. Live scoring passes now = Date.now(), where this is a no-op.
  // `lookbackDays` widens the window for replay callers that re-score at several past
  // dates off one gather: the window anchors at `now`, so a training job scoring a row
  // 120 days before it must reach 180 days before THAT row, not before `now`.
  const asOfIso = new Date(now).toISOString();
  const personIds = [...new Set(persons.map(p => p.entity_id).filter(Boolean))];
  const domains = [...new Set(persons.map(p => p.domain).filter(Boolean))];
  const counts = new Map();
  const bump = (eid, cls, iso) => {
    const m = counts.get(eid) || {};
    (m[cls] = m[cls] || []).push(iso);
    counts.set(eid, m);
  };

  // Reply interactions across every channel (cold email + LinkedIn). email_received
  // is how Instantly/Smartlead/etc. replies land — it was missing here, so cold-email
  // replies never moved intent at all.
  const REPLY_PROPS = new Set([
    'interaction.email_received', 'interaction.email_reply', 'interaction.email_replied',
    'interaction.positive_reply', 'interaction.reply',
    'interaction.linkedin_reply', 'interaction.linkedin_replied',
  ]);

  // person behavioural observations (last 180d). `raw` carries the reply sentiment.
  for (const grp of chunk(personIds, 100)) {
    const obs = (await supabase.from('observations').select('entity_id,property,source,observed_at,raw')
      .eq('workspace_id', ws).in('entity_id', grp)
      .gte('observed_at', new Date(now - lookbackDays * DAY).toISOString())
      .lte('observed_at', asOfIso)).data || [];
    for (const o of obs) {
      const P = o.property;
      if (REPLY_PROPS.has(P)) {
        // Sentiment-aware. Only a genuine HUMAN reply is intent:
        //   • negative / unsubscribe / do_not_contact → NOT intent, skip entirely.
        //   • auto_reply / bounce → NOT a human reply (an out-of-office bot or a dead
        //     mailbox), so it must never count as engagement. This was the bug: an OOO
        //     was bumping `replied` (+35 weight) as if the person had answered.
        //   • positive / objection / neutral → a real reply → `replied`; positive ALSO
        //     fires `positive_reply` (the readiness floor). Missing sentiment → neutral.
        const sent = o.raw?.sentiment ?? null;
        const sig  = o.raw?.reply_signal ?? o.raw?.provider_signal ?? null;
        const isNegative = sent === 'negative' || sig === 'unsubscribe' || sig === 'do_not_contact';
        const isNonHuman = sig === 'auto_reply' || sig === 'bounce';
        if (isNegative || isNonHuman) continue;
        bump(o.entity_id, 'replied', o.observed_at);
        if (sent === 'positive') bump(o.entity_id, 'positive_reply', o.observed_at);
        continue;
      }
      let cls = null;
      if (P === 'interaction.meeting_scheduled' || P === 'interaction.meeting_held') cls = 'meeting_booked';
      // A provider "meeting booked" disposition (Instantly) is strong positive
      // intent but NOT a confirmed calendar meeting — score it as a positive reply,
      // not the top-tier meeting_booked class.
      else if (P === 'interaction.meeting_interest') cls = 'positive_reply';
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
      const at = c.last_observed_at || c.computed_at;
      // Replay bound. A claim holds only its CURRENT state, so this is an approximation:
      // evidence recorded after the as-of date is excluded, but a claim that has since been
      // retracted cannot be recovered. Replayed intent is therefore a close reconstruction,
      // not a byte-exact record of what the app displayed that day.
      if (at && at > asOfIso) continue;
      bump(c.entity_id, 'posted_pain', at);
    }
  }

  // buying_signal note claims (extracted from calls/replies) → the buying_signal floor,
  // tiered strong vs soft by content. This is the intent score reading what the
  // conversation actually revealed, not just event types.
  for (const grp of chunk(personIds, 100)) {
    const cl = (await supabase.from('claims').select('entity_id,last_observed_at,computed_at,value')
      .eq('workspace_id', ws).in('entity_id', grp).like('property', 'note.%')
      .eq('value->>category', 'buying_signal').is('invalid_at', null)).data || [];
    for (const c of cl) {
      const cls = isStrongBuyingSignal(c.value?.content) ? 'buying_signal_strong' : 'buying_signal_soft';
      const at = c.last_observed_at || c.computed_at;
      if (at && at > asOfIso) continue;   // replay bound — see the note above
      bump(c.entity_id, cls, at);
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

  // ── the durable history ──
  //
  // The claim above is the CURRENT value and is meant to be overwritten — that is what a
  // claim is. The history goes where history belongs in this substrate: an append-only
  // observation. Without it there is no record of what intent was on any past date, only
  // what it is now.
  //
  // Written ON CHANGE, not on every run. This cron fires every 6 hours across every engaged
  // entity, so a row per entity per run is ~1,460 rows per contact per year, almost all of
  // them saying "still Warm". Recording band changes instead gives a few dozen rows a year
  // and is also what a hazard model actually wants: the transitions, not the noise.
  //
  // Replay (replayIntentAt) covers the past and does not depend on this; the two are
  // complementary. This is the immutable audit trail and the cheap training set going
  // forward, and it survives an observation being retracted, which a replay cannot.
  await writeIntentBandChange(supabase, ws, entityId, score, band, nowIso);
}

/**
 * Append an `intent_band` observation when the band actually moves.
 *
 * Best-effort throughout: intent scoring must never fail because its history log did.
 */
async function writeIntentBandChange(supabase, ws, entityId, score, band, nowIso) {
  try {
    const { data: prev } = await supabase.from('observations')
      .select('value')
      .eq('workspace_id', ws).eq('entity_id', entityId).eq('property', 'intent_band')
      .order('observed_at', { ascending: false })
      .limit(1);
    const last = prev?.[0]?.value;
    const lastBand = last && typeof last === 'object' ? last.band : last;
    if (lastBand === band) return;   // nothing moved — no row

    await supabase.from('observations').insert({
      workspace_id: ws,
      entity_id: entityId,
      kind: 'state',
      property: 'intent_band',
      // Score rides along so the series carries the magnitude, not just the bucket.
      value: { band, score, from: lastBand ?? null },
      source: 'system',
      method: 'inference',
      observed_at: nowIso,
    });
  } catch { /* history is best-effort — never fail scoring over it */ }
}

/**
 * What an account's intent WAS on a given date.
 *
 * The forecast's timing half wants to know whether a deal was hot or cold at the moment it
 * was still open, not whether it is hot today. `asOf` moves the clock: signals decay from
 * that date, and anything that happened afterwards is excluded.
 *
 * Reads only — nothing is written. Safe to call for every (account, week) pair when building
 * a training set, though that is a batch job, not something to do inside a request.
 *
 * Returns [{ entity_id, score, band, active, mode }], one row per person.
 */
export async function replayIntentAt(supabase, ws, persons, asOfMs) {
  const counts = await gatherIntent(supabase, ws, persons, asOfMs);
  return persons.map(p => ({
    entity_id: p.entity_id,
    ...scoreIntent(counts.get(p.entity_id) || {}, asOfMs, { isClient: p.isClient === true }),
  }));
}

/**
 * An account's intent at each of several past dates — the shape a hazard model trains on.
 *
 * One gather per date rather than one per (person, date), so scanning a year of weekly
 * points for a whole workspace is 52 queries, not 52 x N.
 */
export async function replayIntentSeries(supabase, ws, persons, asOfMsList) {
  const out = [];
  for (const asOfMs of asOfMsList) {
    const rows = await replayIntentAt(supabase, ws, persons, asOfMs);
    for (const r of rows) out.push({ ...r, as_of: new Date(asOfMs).toISOString() });
  }
  return out;
}

// Core: score a set of persons, optionally writing claims. Returns summary + rows.
export async function runIntentScoring(supabase, ws, { persons, write = false, now = Date.now() }) {
  const counts = await gatherIntent(supabase, ws, persons, now);
  const nowIso = new Date(now).toISOString();

  // Which of these are clients? A client scores on the client axis, not the buying one.
  const clientSet = new Set();
  const personIds = persons.map(p => p.entity_id).filter(Boolean);
  for (const grp of chunk(personIds, 200)) {
    const st = (await supabase.from('claims').select('entity_id,value')
      .eq('workspace_id', ws).in('entity_id', grp).eq('property', 'pipeline_stage').is('invalid_at', null)).data || [];
    // The won stage is `closed_won` now; normalize so un-migrated `client` rows
    // still land on the client axis instead of being scored as open buyers.
    for (const s of st) if (normalizeStage(s.value) === 'closed_won') clientSet.add(s.entity_id);
  }

  const bands = {};
  const rows = [];
  let staked = 0;
  for (const p of persons) {
    const isClient = clientSet.has(p.entity_id);
    const r = scoreIntent(counts.get(p.entity_id) || {}, now, { isClient });
    bands[r.band] = (bands[r.band] || 0) + 1;
    rows.push({ ...p, ...r });
    // A client always gets its band written (so the record never shows a stale buying
    // band); a prospect only once it clears the stake floor.
    if (write && (isClient || r.score >= STAKE_FLOOR)) {
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
